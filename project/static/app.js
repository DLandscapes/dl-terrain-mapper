// @ts-check
// THE PAGE — controls on the left, readings on the right, the ground between.
//
// ⚠️ THE PREVIEW DRAWS THE COMPILED DRAWING AND NOTHING ELSE. Every path and
// circle on screen is an entity that will be in the file, coloured by its pass.
// This module is forbidden from inventing geometry for display: the moment the
// preview draws something the compiler did not produce, it has started lying,
// and the lie is found on material. The only marks that are NOT in the file are
// the interaction handles — the selection ring and the correction leader — and
// they are drawn in the interface accent, never in a pass colour, so the two
// can never be confused.
//
// ⚠️ NOTHING IS UPLOADED. There is no fetch in this file and there must not be
// one. Photographs in particular are read from the user's own disk into memory
// and shown from an object URL; see the GDPR note in exif.js.

import { readElevation, readOrtho } from "./geotiff.js";
import { makeDEM, stats } from "./dem.js";
import { readPhotoSet } from "./exif.js";
import { placePhotos, correct } from "./photos.js";
import { compile, toDXF, reportText, DEFAULTS, sheetsIn } from "./compile.js";
import { differenceDEM } from "./regions.js";
import { fitScale, SCALE_LADDER } from "./sheet.js";
import { CHANNELS } from "./halftone.js";
import { LINE_STYLES, STYLE_ORDER, styleLabel } from "./linestyle.js";
import { readQGISStyle, translateToContours } from "./qgis.js";
import { buildTestSheet, testSheetProcedure } from "./testsheet.js";
import { toSVG } from "./svg.js";
import { PASS_COLOURS, PASS_LABELS, passColour } from "./dxf.js";
import { niceInterval } from "./contours.js";
import { slopeDegrees } from "./symbols.js";
import { readShapefile } from "./shapefile.js";

const $ = (id) => /** @type {any} */ (document.getElementById(id));
// ⚠️ THE PREVIEW READS THE DXF'S OWN COLOURS. It used to keep a private table,
// tuned darker for a white screen, which meant the green on screen was not the
// green in the file. See PASS_COLOURS in dxf.js.
const PASS = PASS_COLOURS;

const state = {
  // ⚠️ RASTERS ARE A LIST, AND THE FIRST ONE IS THE PRIMARY. It defines the
  // sheet; the others are drawn in the same map frame and trimmed at its edge.
  // `dem` is kept as a live alias for the primary so the photograph path, the
  // demo builder and the readout did not all have to change at once.
  /** @type {{id:number, dem:any, name:string, on:boolean, contours:any}[]} */ layers: [],
  active: 0,
  nextId: 1,
  /** @type {import("./dem.js").DEM|null} */ dem: null,
  /** @type {import("./photos.js").PhotoPoint[]} */ photos: [],
  /** @type {Map<string,string>} */ thumbs: new Map(),
  /** @type {any} */ image: null,
  // The tile boundary: rings in MAP units, applied as the compiler's last
  // stage. Held separately from `clipOn` so it can be switched off and back on
  // without reloading the file.
  /** @type {any} */ clip: null,
  clipOn: false,
  /** @type {any} */ drawing: null,
  unlocated: [],
  selected: -1,
  view: { x: 0, y: 0, k: 1, ready: false },
  sym: JSON.parse(JSON.stringify(DEFAULTS)),
};

// ── sections ────────────────────────────────────────────────────────────────
// ⚠️ NO RAIL, AND NO SCRIPT TO OPEN A SECTION. The sections are native
// <details>, so folding works with JavaScript disabled and needs no state of
// its own. The only thing this file adds is the BADGE — what is live inside a
// section that is currently closed. A folded panel must never hide active
// state: a halftone quietly set to 3,000 marks is a surprise at the machine,
// not a tidy interface. Same rule DL-TerrainDiversity keeps for its armed
// brushes.
function badges() {
  const s = state.sym;
  const set = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  const n = state.layers.length;
  set("b-import", n ? `${n} raster${n === 1 ? "" : "s"}`
    + (state.photos.length ? ` · ${state.photos.length} photos` : "") : "");
  set("b-mark", s.photos.enabled && state.photos.length ? `${state.photos.filter((p) => p.include).length} drawn` : "");
  set("b-engrave", s.halftone.enabled && state.drawing?.report?.halftone
    ? `${state.drawing.report.halftone.marks} marks` : "");
  set("b-compose", `1:${s.sheet.scale}`);
  set("b-export", state.drawing ? `${state.drawing.report.totals.paths} paths` : "");
}
const fmtNum = (v) => (Number.isFinite(v) ? String(+(+v).toFixed(3)) : "—");

/** Set once the grip exists; the panel drag and the fold both move it. */
let syncGrip = () => {};

$("readoutMin").addEventListener("click", () => {
  const r = $("readout");
  r.classList.toggle("min");
  $("readoutMin").textContent = r.classList.contains("min") ? "+" : "–";
});

// ── the menu window: fold, and drag by its header ───────────────────────────
// ⚠️ FOLD AND UNFOLD HAPPEN UNDER THE SAME PIXEL. The chip is placed on the
// rect the fold button occupied, so the control that hides the menu and the
// control that brings it back are one place in two states. They are the same
// size for the same reason: a wider chip would land its own edge under a
// cursor that has not moved.
//
// ⚠️ THE FOLD BUTTON SITS ON THE VIEWPORT, NOT IN THE HEADER, so it does not
// travel when the window is dragged. A control that hides the menu must not be
// somewhere the menu has been moved to.
function foldMenu(folded) {
  $("sidebar").classList.toggle("min", folded);
  $("menu-min").hidden = folded;
  $("menu-chip").hidden = !folded;
  syncGrip();
  resize();
}
for (const d of document.querySelectorAll("details.panel")) {
  d.addEventListener("toggle", () => setTimeout(syncGrip, 0));
}
$("menu-min").addEventListener("click", () => foldMenu(true));
$("menu-chip").addEventListener("click", () => foldMenu(false));

(() => {
  const panel = $("sidebar");
  const head = panel.querySelector("header");
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    panel.classList.add("dragging");
    // ⚠️ CAPTURE IS AN OPTIMISATION, NOT THE MECHANISM. It throws when the id
    // names no active pointer — a synthesised event, a pointer already released
    // — and an uncaught throw here would abort the handler halfway and, worse,
    // fill the console so a real error has somewhere to hide. The drag works
    // without it because the move and up handlers sit on the same element.
    try { head.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    // ⚠️ CLAMPED SO THE HEADER CAN ALWAYS BE GRABBED AGAIN. A window dropped
    // past the edge of the screen is a window with no handle left, and the only
    // way back would be a reload — which discards the raster the user loaded.
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const x = Math.max(4 - w + 60, Math.min(window.innerWidth - 60, e.clientX - drag.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 34, e.clientY - drag.dy));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.maxHeight = `${Math.max(120, window.innerHeight - y - 12)}px`;
    syncGrip();
    void h;
  });
  const end = () => { drag = null; panel.classList.remove("dragging"); };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
})();

// ── window widths ───────────────────────────────────────────────────────────
// ⚠️ WIDENING COSTS NOTHING HERE, and that is the point of these being windows
// rather than columns. Both float over the ground, so the canvas does not change
// size and nothing recompiles — the drawing simply continues underneath.
// Site rasters are named things like LAR3072_A1_plate_A1_DTM_1m, where every
// distinguishing character is at the END, so a fixed width makes every row in a
// plate set look identical.
/** @type {(()=>void)[]} */
const gripSyncs = [];
syncGrip = () => { for (const f of gripSyncs) f(); };

/**
 * A drag handle on one edge of a floating window.
 *
 * @param {string} panelId
 * @param {"right"|"left"} edge which side the handle sits on; dragging away
 *   from the window's anchor widens it
 * @param {number} defaultWidth
 */
function makeGrip(panelId, edge, defaultWidth) {
  const panel = $(panelId);
  const grip = document.createElement("div");
  grip.id = `${panelId}-grip`;
  grip.className = "wgrip";
  grip.title = "Drag to resize · double-click to reset";
  $("viewport").appendChild(grip);

  const sync = () => {
    if (panel.classList.contains("min") || panel.hidden) { grip.hidden = true; return; }
    grip.hidden = false;
    const r = panel.getBoundingClientRect();
    grip.style.left = `${(edge === "right" ? r.right : r.left) - 4}px`;
    grip.style.top = `${r.top}px`;
    grip.style.height = `${r.height}px`;
  };
  // ⚠️ THE OBSERVER IS A CONVENIENCE, NOT THE MECHANISM — the same rule the
  // canvas sizing learned the hard way. ResizeObserver is delivered during the
  // rendering steps and fires ZERO times in a tab the browser is not painting,
  // which left the handle at a stale height whenever a panel grew in the
  // background. paintLayers, the recompile cycle and every <details> toggle call
  // syncGrip too, and all of those are timer-driven.
  new ResizeObserver(sync).observe(panel);
  window.addEventListener("resize", sync);
  gripSyncs.push(sync);

  let from = null;
  const move = (e) => {
    if (!from) return;
    // ⚠️ CLAMPED AT BOTH ENDS. Too narrow and the controls wrap into
    // unreadability; too wide and the drawing has nowhere left to be.
    const max = Math.max(300, Math.min(760, window.innerWidth - 340));
    const delta = edge === "right" ? (e.clientX - from.x) : (from.x - e.clientX);
    const w = Math.max(240, Math.min(max, from.w + delta));
    panel.style.width = `${w}px`;
    if (edge === "right") panel.style.minWidth = `${w}px`;
    syncGrip();
  };
  const stop = () => {
    if (!from) return;
    from = null;
    grip.classList.remove("on");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
  };
  grip.addEventListener("pointerdown", (e) => {
    from = { x: e.clientX, w: panel.offsetWidth };
    grip.classList.add("on");
    // ⚠️ MOVE AND UP GO ON THE WINDOW, not the handle: the handle moves under
    // the cursor as the panel widens, and a pointer that outruns it would drop
    // the drag halfway.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    try { grip.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    e.preventDefault();
  });
  // ⚠️ DOUBLE-CLICK RESTORES THE DEFAULT. A window that can only be widened by
  // hand needs a way back that is not "reload and lose the raster".
  grip.addEventListener("dblclick", () => {
    panel.style.width = `${defaultWidth}px`;
    if (edge === "right") panel.style.minWidth = `${defaultWidth}px`;
    syncGrip();
  });
  sync();
}
makeGrip("sidebar", "right", 306);
makeGrip("readout", "left", 300);

// ── the scale ladder and the channel menus ──────────────────────────────────
for (const s of SCALE_LADDER) {
  const o = document.createElement("option");
  o.value = String(s); o.textContent = String(s);
  if (s === 200) o.selected = true;
  $("sScale").appendChild(o);
}
const CHAN_ORDER = ["darkness", "luminance", "greenness", "brightness", "saturation", "red", "green", "blue"];
for (const id of ["hChan", "hC1", "hC2", "hC3"]) {
  for (const key of CHAN_ORDER) {
    const c = CHANNELS[key];
    const o = document.createElement("option");
    o.value = key;
    o.textContent = c.good ? c.label : `${c.label}  (not recommended)`;
    $(id).appendChild(o);
  }
}
$("hChan").value = "darkness";
$("hC1").value = "greenness"; $("hC2").value = "brightness"; $("hC3").value = "saturation";

for (const id of ["cStyle", "cIdxStyle"]) {
  for (const key of STYLE_ORDER) {
    const o = document.createElement("option");
    o.value = key; o.textContent = LINE_STYLES[key].label;
    $(id).appendChild(o);
  }
}
const PASS_PICKERS = ["cPass", "cIdxPass", "cLabelPass", "mPass", "gPassPlus", "gPassMinus",
  "hhPass", "xPass", "xLinePass", "kPass"];
for (const id of PASS_PICKERS) {
  for (const [name, label] of Object.entries(PASS_LABELS)) {
    const o = document.createElement("option");
    o.value = name; o.textContent = label;
    $(id).appendChild(o);
  }
}

// ── the pass pickers wear their colour ──────────────────────────────────────
// ⚠️ THE CHIP IS THE PASS'S DECLARED COLOUR, WHICH IS THE MACHINE OPERATION.
// It is not a legend colour picked to look right on a screen — see PASS_COLOURS
// in dxf.js, and the note beside `.passfield` in the page. The wrapper is built
// here rather than written into the markup so that any pass picker added later
// gets one without anybody remembering to.
for (const id of PASS_PICKERS) {
  const sel = $(id);
  if (!sel || sel.parentElement.classList.contains("passfield")) continue;
  const wrap = document.createElement("span");
  wrap.className = "passfield";
  sel.parentNode.insertBefore(wrap, sel);
  const chip = document.createElement("i");
  chip.className = "swatch";
  wrap.appendChild(chip);
  wrap.appendChild(sel);
}

/** Repaint every pass chip from its select's current value. */
function paintSwatches() {
  for (const id of PASS_PICKERS) {
    const sel = $(id);
    const chip = sel && sel.parentElement.querySelector(".swatch");
    if (!chip) continue;
    chip.style.background = passColour(sel.value);
    chip.title = sel.value;
  }
}

// ── the raster list ─────────────────────────────────────────────────────────
/** The settings the properties window is currently editing. */
const activeLayer = () => state.layers[state.active] || null;

let dragFrom = -1;
const clearDropMarks = () => {
  for (const e of document.querySelectorAll(".pitem"))
    e.classList.remove("over-above", "over-below", "dragging");
};

/**
 * Move a raster in the list.
 *
 * ⚠️ MOVING ANYTHING INTO OR OUT OF FIRST PLACE CHANGES THE SHEET, because the
 * primary defines it. The view must refit or the drawing jumps out of frame
 * with no explanation — the same reason a scale change refits.
 */
function moveLayer(from, to) {
  if (from < 0 || from >= state.layers.length) return;
  if (to > from) to--;
  if (to === from) return;
  const wasPrimary = state.layers[0];
  const [moved] = state.layers.splice(from, 1);
  state.layers.splice(Math.max(0, Math.min(state.layers.length, to)), 0, moved);
  state.active = state.layers.indexOf(moved);
  state.dem = state.layers[0].dem;
  if (state.layers[0] !== wasPrimary) state.view.ready = false;
  clearDropMarks();
  syncLayer(); paintLayers(); recompile();
}

function paintLayers() {
  const host = $("layerList");
  host.innerHTML = "";
  // The list changes the panel's height, so the grip must follow it.
  setTimeout(syncGrip, 0);
  if (!state.layers.length) return;
  state.layers.forEach((L, i) => {
    const el = document.createElement("div");
    el.className = "pitem" + (i === state.active ? " sel" : "") + (L.on ? "" : " off");
    const c = L.contours;
    // ⚠️ THE SWATCH IS THE PASS COLOUR, WHICH IS THE MACHINE OPERATION. It is
    // not a legend colour chosen for the screen — see PASS_COLOURS in dxf.js.
    // ⚠️ styleLabel, NOT LINE_STYLES[...].label. A style imported from QGIS is
    // "custom" and has no entry in the table, so the direct lookup was
    // `undefined.label` — a throw that aborted the whole import handler one line
    // before it reached recompile(). The symptom was baffling: the controls
    // showed the imported style, the log listed every decision, and the drawing
    // silently stayed as it was.
    el.innerHTML = `<span class="drag" aria-hidden="true">\u283f</span>
      <span class="n" style="background:${passColour(c.pass)}">${i + 1}</span>
      <span class="grow">${esc(L.name)}</span>
      <span class="val">${i === 0 ? "primary · " : ""}${esc(styleLabel(c.style, c.customDash))}</span>`;
    // ⚠️ THE FULL NAME GOES FIRST IN THE TOOLTIP. The row truncates with an
    // ellipsis, and a title that explained what clicking does — which is what
    // this used to say — is the one thing the user can already guess. Site
    // rasters are named things like LAR3072_A1_plate_A1_DTM_1m, where every
    // distinguishing character is at the END and every truncated row therefore
    // looks identical to its neighbour.
    el.title = `${L.name}
${L.dem.ncols}×${L.dem.nrows} at ${L.dem.cell} m`
      + `${L.dem.crs ? ", " + L.dem.crs : ""}
`
      + `${styleLabel(c.style, c.customDash)} on ${c.pass}
`
      + (i === 0 ? "The primary raster defines the sheet. Click to edit its contours."
                 : "Click to edit this raster's contours.");
    el.addEventListener("click", () => { state.active = i; syncLayer(); paintLayers(); });

    // ⚠️ THE ORDER IS LOAD-BEARING: layer 1 is the PRIMARY and defines the
    // sheet. Dragging a raster to the top therefore resizes the drawing, which
    // is exactly why someone would do it — a 2 x 2 km context tile can be made
    // primary to get a context sheet, or demoted to sit inside a plate.
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      dragFrom = i;
      el.classList.add("dragging");
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); } catch { /* older engines */ }
    });
    el.addEventListener("dragend", () => { dragFrom = -1; clearDropMarks(); paintLayers(); });
    el.addEventListener("dragover", (e) => {
      if (dragFrom < 0 || dragFrom === i) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      clearDropMarks();
      el.classList.add(above ? "over-above" : "over-below");
    });
    el.addEventListener("dragleave", () => el.classList.remove("over-above", "over-below"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dragFrom < 0 || dragFrom === i) return;
      const r = el.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      moveLayer(dragFrom, above ? i : i + 1);
    });
    const x = document.createElement("button");
    x.className = "link"; x.textContent = "remove"; x.style.fontSize = ".66rem";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      state.layers.splice(i, 1);
      state.active = Math.max(0, Math.min(state.active, state.layers.length - 1));
      state.dem = state.layers[0]?.dem || null;
      // ⚠️ REMOVING THE PRIMARY RESIZES THE SHEET, so the view must refit or the
      // drawing jumps out of frame with no explanation.
      state.view.ready = false;
      syncLayer(); paintLayers(); recompile();
    });
    el.appendChild(x);
    host.appendChild(el);
  });
}

/** Push the active layer's settings into the Contour controls. */
function syncLayer() {
  const L = activeLayer();
  const sel = $("cLayer");
  sel.innerHTML = "";
  state.layers.forEach((q, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = `${i + 1} · ${q.name}${i === 0 ? "  (primary)" : ""}`;
    sel.appendChild(o);
  });
  sel.value = String(state.active);
  // The window's own title says which object it is a property sheet for; a
  // panel of controls that does not name its subject is a panel you distrust.
  const t = $("propTitle");
  if (t) {
    t.textContent = L ? L.name : "Properties";
    t.title = L ? `${L.name} — layer ${state.active + 1} of ${state.layers.length}`
      + `${state.active === 0 ? ", the primary (it defines the sheet)" : ""}` : "";
  }
  if (!L) return;
  const c = L.contours;
  $("cOn").checked = c.enabled;
  $("cAuto").checked = c.auto;
  $("cInt").value = String(c.interval || 1);
  $("cIdx").value = String(c.indexEvery);
  $("lOn").checked = c.labels;
  $("lEvery").value = String(c.labelEvery);
  $("lSize").value = String(c.labelSize);
  $("lSpace").value = String(c.labelSpacing);
  $("lOrient").value = c.orientation;
  $("cDatum").value = c.datum;
  // ⚠️ "Custom" IS ONLY OFFERED WHEN SOMETHING SUPPLIED ONE. A picker entry that
  // cannot be chosen from nothing is a dead control; it appears when a QGIS
  // style brings a pattern with it, and carries that pattern's own label.
  for (const [id, key, pat] of [["cStyle", "style", c.customDash],
                                ["cIdxStyle", "indexStyle", c.indexCustomDash]]) {
    const el = $(id);
    let opt = [...el.options].find((o) => o.value === "custom");
    if (c[key] === "custom") {
      if (!opt) { opt = document.createElement("option"); opt.value = "custom"; el.appendChild(opt); }
      opt.textContent = styleLabel("custom", pat);
    } else if (opt) el.removeChild(opt);
  }
  $("cStyle").value = c.style;
  $("cIdxStyle").value = c.indexStyle;
  $("cPass").value = c.pass;
  $("cIdxPass").value = c.indexPass;
  $("cLabelPass").value = c.labelPass;
  // ── hachures, hung off this layer's own contours ──
  const k = c.hachures || (c.hachures = defaultHachures());
  $("kOn").checked = k.enabled;
  $("kSpacing").value = String(k.spacingMM);
  $("kMin").value = String(k.minMM);
  $("kMax").value = String(k.maxMM);
  $("kFixed").checked = k.fixed;
  $("kIndexOnly").checked = k.indexOnly;
  $("kMinSlope").value = String(k.minSlope);
  $("kPass").value = k.pass;
  // ── contour modulation ──
  const md = c.modulateCfg || (c.modulateCfg = defaultModulate());
  fillSourcePicker("dSource", L, md);
  $("dOn").checked = md.enabled;
  $("dPeriod").value = String(md.period);
  $("dMinInk").value = String(md.minInk);
  $("dMaxInk").value = String(md.maxInk);
  $("dInvert").checked = md.invert;
  // ── the second material ──
  const m = L.mat || (L.mat = defaultMat());
  const src = $("mSource");
  src.innerHTML = "";
  const oSelf = document.createElement("option");
  oSelf.value = "self";
  oSelf.textContent = "this layer's own values";
  src.appendChild(oSelf);
  // ⚠️ THE DIFFERENCE IS OFFERED AGAINST EVERY OTHER LOADED LAYER, BY IDENTITY
  // NOT BY POSITION — reordering the list must not silently change which two
  // epochs a disturbance is computed between.
  state.layers.forEach((q, qi) => {
    if (q === L) return;
    const o = document.createElement("option");
    o.value = String(q.id);
    o.textContent = `difference to ${qi + 1} · ${q.name}`;
    src.appendChild(o);
  });
  src.value = m.source;
  if (src.value !== m.source) { m.source = "self"; src.value = "self"; }
  $("mOn").checked = m.enabled;
  $("mAbs").checked = m.abs;
  $("mThresh").value = String(m.threshold);
  $("mMode").value = m.mode;
  $("mPass").value = m.pass;
  $("mMinArea").value = String(m.minArea);
  $("mLabels").checked = m.labels;
  // ── the circle grid ──
  // Same source rule as the second material: the difference is offered against
  // every OTHER loaded layer, by identity, so reordering cannot silently change
  // which two epochs the circles compare.
  const g = L.grad || (L.grad = defaultGrad());
  fillSourcePicker("gSource", L, g);
  $("gOn").checked = g.enabled;
  $("gSigned").checked = g.signed;
  $("gAcross").value = String(g.across);
  $("gMax").value = String(g.max);
  $("gMin").value = String(g.min);
  $("gMinAbs").value = String(g.minAbs);
  $("gPassPlus").value = g.passPlus;
  $("gPassMinus").value = g.passMinus;
  // ── hatching ──
  const h = L.hatch || (L.hatch = defaultHatch());
  fillSourcePicker("hhSource", L, h);
  $("hhOn").checked = h.enabled;
  $("hhSpacing").value = String(h.spacingMM);
  $("hhAngle").value = String(h.angleDeg);
  $("hhInvert").checked = h.invert;
  $("hhFloor").value = String(h.floor);
  $("hhPass").value = h.pass;
  // ── sections ──
  const x = L.sect || (L.sect = defaultSect());
  $("xOn").checked = x.enabled;
  $("xCount").value = String(x.count);
  $("xAxis").value = x.axis;
  $("xHeight").value = String(x.heightMM);
  $("xDatum").value = x.datum;
  $("xLabels").checked = x.labels;
  $("xPass").value = x.pass;
  $("xLinePass").value = x.linePass;
  paintSwatches();
}

/**
 * Fill one "which values?" picker: own values, slope, or a difference.
 *
 * ⚠️ DIFFERENCES ARE OFFERED BY IDENTITY, NEVER BY POSITION. Reordering the
 * raster list must not silently change which two epochs a translation
 * compares — the list order is load-bearing for the SHEET, and it would be a
 * quiet disaster if it were load-bearing for the arithmetic too.
 * @param {string} id @param {any} L the layer @param {{source:string}} cfg
 */
function fillSourcePicker(id, L, cfg) {
  const sel = $(id);
  if (!sel) return;
  sel.innerHTML = "";
  const add = (value, text) => {
    const o = document.createElement("option");
    o.value = value; o.textContent = text;
    sel.appendChild(o);
  };
  add("self", "this layer's own values");
  // Slope is the one derived attribute on offer — the single analysis this
  // tool computes (see symbols.js); anything richer arrives as its own raster.
  add("slope", "slope of this layer (degrees)");
  state.layers.forEach((q, qi) => {
    if (q === L) return;
    add(String(q.id), `difference to ${qi + 1} · ${q.name}`);
  });
  sel.value = cfg.source;
  if (sel.value !== cfg.source) { cfg.source = "self"; sel.value = "self"; }
}

/**
 * The region specs the compiler takes, built from every visible layer whose
 * second material is switched on.
 *
 * ⚠️ A MISALIGNED DIFFERENCE IS REPORTED IN THE PANEL, NOT SWALLOWED. The
 * failure it guards against — subtracting two grids that merely look similar —
 * produces slope dressed up as disturbance, so the refusal has to be seen.
 */
function buildRegions() {
  const note = $("mNote");
  if (note) note.textContent = "";
  const out = [];
  for (const L of state.layers.filter((q) => q.on)) {
    const m = L.mat;
    if (!m || !m.enabled || !Number.isFinite(m.threshold)) continue;
    let dem = L.dem;
    let name = `${L.name} > ${m.threshold}`;
    if (m.source !== "self") {
      const other = state.layers.find((q) => String(q.id) === String(m.source));
      if (!other) continue;
      try {
        dem = differenceDEM(L.dem, other.dem, { abs: m.abs });
        name = `${m.abs ? "|" : ""}${L.name} − ${other.name}${m.abs ? "|" : ""} > ${m.threshold}`;
      } catch (e) {
        if (note && L === activeLayer()) note.textContent = e.message;
        continue;
      }
    } else if (m.abs) {
      const z = new Float32Array(L.dem.z.length);
      for (let i = 0; i < z.length; i++) {
        const v = L.dem.z[i];
        z[i] = Number.isFinite(v) ? Math.abs(v) : NaN;
      }
      dem = { ...L.dem, z };
    }
    out.push({ dem, name, threshold: m.threshold, mode: m.mode, pass: m.pass,
      minAreaM2: m.minArea, labels: m.labels, labelSize: L.contours.labelSize });
  }
  return out;
}
/**
 * The circle-grid specs the compiler takes — the grading-plan read, one per
 * visible layer that switched it on. Difference sources keep their SIGN here
 * (unlike the second material's |value| default): the sign is the whole point,
 * it is what tells cut from fill.
 */
/**
 * The grid a translation actually reads, and what to call it.
 *
 * ⚠️ ONE RESOLVER FOR EVERY TRANSLATION. Contours, circles and hatching all
 * offer the same three sources — the layer's own values, its slope, or its
 * difference to another layer BY IDENTITY — and three copies of this would
 * drift apart at the first change. `throw`s carry the reason to the caller's
 * own note line, because a refused difference must be SEEN: subtracting two
 * grids that merely look alike is slope in disguise.
 *
 * @param {any} L the layer @param {string} source "self" | "slope" | a layer id
 * @returns {{dem:any, label:string}}
 */
function resolveSource(L, source) {
  if (source === "slope") {
    return { dem: { ...L.dem, z: slopeDegrees(L.dem), name: `${L.name} slope` },
      label: `${L.name} slope` };
  }
  if (source !== "self") {
    const other = state.layers.find((q) => String(q.id) === String(source));
    if (!other) throw new Error("that layer is no longer loaded");
    return { dem: differenceDEM(L.dem, other.dem, {}),
      label: `${L.name} − ${other.name}` };
  }
  return { dem: L.dem, label: L.name };
}

function buildSymbols() {
  const note = $("gNote");
  if (note) note.textContent = "";
  const out = [];
  for (const L of state.layers.filter((q) => q.on)) {
    const g = L.grad;
    if (!g || !g.enabled) continue;
    let r;
    try { r = resolveSource(L, g.source); } catch (e) {
      if (note && L === activeLayer()) note.textContent = e.message;
      continue;
    }
    out.push({ dem: r.dem, name: `${r.label} · circles`,
      signed: g.signed, across: g.across,
      minFraction: g.min / 100, maxFraction: g.max / 100,
      minAbs: g.minAbs, passPlus: g.passPlus, passMinus: g.passMinus });
  }
  return out;
}

/**
 * Turn every layer's modulation SETTINGS into an actual raster for the compiler.
 *
 * ⚠️ THE COMPILER NEVER REACHES BACK INTO THE PAGE. It takes rasters, not
 * references to layers, so the reference has to be resolved on this side — and
 * for EVERY layer, not only the one whose controls are on screen. Resolving
 * just the active one leaves a background layer holding a raster that may
 * since have been removed or reordered, and it would go on drawing from it.
 */
function resolveModulation() {
  const note = $("dNote");
  if (note) note.textContent = "";
  for (const L of state.layers) {
    const c = L.contours;
    const md = c.modulateCfg;
    c.modulate = null;
    if (!md || !md.enabled) continue;
    try {
      const r = resolveSource(L, md.source);
      c.modulate = { dem: r.dem, name: r.label, period: md.period,
        minInk: md.minInk, maxInk: md.maxInk, invert: md.invert };
    } catch (e) {
      if (note && L === activeLayer()) note.textContent = e.message;
    }
  }
}

/** The hatch specs — the value as line density, one per layer that asked. */
function buildHatches() {
  const note = $("hhNote");
  if (note) note.textContent = "";
  const out = [];
  for (const L of state.layers.filter((q) => q.on)) {
    const h = L.hatch;
    if (!h || !h.enabled) continue;
    let r;
    try { r = resolveSource(L, h.source); } catch (e) {
      if (note && L === activeLayer()) note.textContent = e.message;
      continue;
    }
    out.push({ dem: r.dem, name: `${r.label} · hatch`,
      spacingMM: h.spacingMM, angleDeg: h.angleDeg,
      invert: h.invert, floor: h.floor, pass: h.pass });
  }
  return out;
}

/**
 * The section specs — the ground cut open, one set per layer that asked.
 *
 * ⚠️ SECTIONS ALWAYS CUT THE LAYER'S OWN ELEVATIONS. A profile of a slope
 * raster or of a difference would be a chart, not a section: the whole meaning
 * of the drawing is "this is the shape of the ground along this line", and
 * plotting degrees or metres-of-change along it would look identical and mean
 * something else entirely.
 */
function buildSections() {
  const out = [];
  for (const L of state.layers.filter((q) => q.on)) {
    const x = L.sect;
    if (!x || !x.enabled) continue;
    out.push({ dem: L.dem, name: `${L.name} · sections`,
      count: x.count, axis: x.axis, heightMM: x.heightMM, datum: x.datum,
      labels: x.labels, labelSize: Math.max(2.2, L.contours.labelSize),
      pass: x.pass, linePass: x.linePass });
  }
  return out;
}
$("cLayer").addEventListener("change", () => {
  state.active = +$("cLayer").value || 0;
  syncLayer(); paintLayers();
});

// ── reading the controls ────────────────────────────────────────────────────
function gather() {
  const s = state.sym;
  s.sheet.scale = +$("sScale").value;
  s.sheet.margin = +$("sMargin").value;
  s.sheet.title = $("sTitle").value;
  s.sheet.lettering = $("sLetter").value;
  s.sheet.frame = $("sFrame").checked;
  s.sheet.scaleBar = $("sBar").checked;
  s.sheet.north = $("sNorth").checked;

  // ⚠️ THE CONTOUR CONTROLS EDIT ONE LAYER, NOT THE DRAWING. Which one is
  // named at the top of the panel and shown selected in the raster list, because
  // a set of controls that silently applies to something other than what you
  // last clicked is worse than no controls at all.
  const L = activeLayer();
  const c = L ? L.contours : s.contours;
  c.enabled = $("cOn").checked;
  c.auto = $("cAuto").checked;
  $("cInt").disabled = c.auto;
  if (c.auto && L) {
    const st = stats(L.dem);
    const iv = niceInterval(st.relief, 14);
    $("cInt").value = String(iv);
    c.interval = iv;
  } else {
    c.interval = +$("cInt").value || 1;
  }
  c.indexEvery = +$("cIdx").value;
  c.labels = $("lOn").checked;
  c.labelEvery = +$("lEvery").value;
  c.labelSize = +$("lSize").value;
  c.labelSpacing = +$("lSpace").value;
  c.orientation = $("lOrient").value;
  c.datum = $("cDatum").value;
  // Choosing a named style discards the imported pattern; choosing "custom"
  // keeps whatever brought it.
  const prevStyle = c.style, prevIdx = c.indexStyle;
  c.style = $("cStyle").value;
  c.indexStyle = $("cIdxStyle").value;
  if (prevStyle === "custom" && c.style !== "custom") c.customDash = null;
  if (prevIdx === "custom" && c.indexStyle !== "custom") c.indexCustomDash = null;
  c.pass = $("cPass").value;
  c.indexPass = $("cIdxPass").value;
  c.labelPass = $("cLabelPass").value;
  const k = c.hachures || (c.hachures = defaultHachures());
  k.enabled = $("kOn").checked;
  k.spacingMM = Math.min(40, Math.max(0.5, +$("kSpacing").value || 3));
  k.minMM = Math.max(0.2, +$("kMin").value || 0.9);
  k.maxMM = Math.max(k.minMM, +$("kMax").value || 2.5);
  k.fixed = $("kFixed").checked;
  k.indexOnly = $("kIndexOnly").checked;
  k.minSlope = Math.max(0, +$("kMinSlope").value || 0);
  k.pass = $("kPass").value;
  const md = c.modulateCfg || (c.modulateCfg = defaultModulate());
  md.enabled = $("dOn").checked;
  md.source = $("dSource").value;
  md.period = Math.min(30, Math.max(0.5, +$("dPeriod").value || 2));
  md.minInk = Math.min(100, Math.max(0, +$("dMinInk").value || 0));
  md.maxInk = Math.min(100, Math.max(md.minInk, +$("dMaxInk").value || 100));
  md.invert = $("dInvert").checked;
  resolveModulation();
  s.contours = c;
  if (L) {
    const m = L.mat || (L.mat = defaultMat());
    m.enabled = $("mOn").checked;
    m.source = $("mSource").value;
    m.abs = $("mAbs").checked;
    m.threshold = +$("mThresh").value;
    m.mode = $("mMode").value;
    m.pass = $("mPass").value;
    m.minArea = +$("mMinArea").value || 0;
    m.labels = $("mLabels").checked;
    const g = L.grad || (L.grad = defaultGrad());
    g.enabled = $("gOn").checked;
    g.source = $("gSource").value;
    g.signed = $("gSigned").checked;
    g.across = Math.min(200, Math.max(4, +$("gAcross").value || 40));
    g.max = Math.min(100, Math.max(5, +$("gMax").value || 90));
    g.min = Math.min(90, Math.max(0, +$("gMin").value || 0));
    g.minAbs = Math.max(0, +$("gMinAbs").value || 0);
    g.passPlus = $("gPassPlus").value;
    g.passMinus = $("gPassMinus").value;
    const h = L.hatch || (L.hatch = defaultHatch());
    h.enabled = $("hhOn").checked;
    h.source = $("hhSource").value;
    h.spacingMM = Math.min(20, Math.max(0.4, +$("hhSpacing").value || 2));
    h.angleDeg = +$("hhAngle").value || 0;
    h.invert = $("hhInvert").checked;
    h.floor = +$("hhFloor").value || 0;
    h.pass = $("hhPass").value;
    const x = L.sect || (L.sect = defaultSect());
    x.enabled = $("xOn").checked;
    x.count = Math.min(9, Math.max(1, +$("xCount").value || 3));
    x.axis = $("xAxis").value;
    x.heightMM = Math.min(120, Math.max(2, +$("xHeight").value || 12));
    x.datum = $("xDatum").value;
    x.labels = $("xLabels").checked;
    x.pass = $("xPass").value;
    x.linePass = $("xLinePass").value;
  }

  s.photos.enabled = $("pOn").checked;
  s.photos.mark = $("pMark").value;
  s.photos.size = +$("pSize").value;
  s.photos.numbers = $("pNum").checked;
  s.photos.bearing = $("pBear").checked;
  s.photos.halo = $("pHalo").checked;

  s.halftone.enabled = $("hOn").checked;
  s.halftone.mode = $("hMode").value;
  s.halftone.across = +$("hAcross").value;
  s.halftone.channel = $("hChan").value;
  s.halftone.channels = [$("hC1").value, $("hC2").value, $("hC3").value];

  $("cIntV").textContent = c.interval > 0 ? `${fmtNum(c.interval)} m` : "—";
  $("cIdxV").textContent = c.indexEvery ? `${ord(c.indexEvery)}` : "none";
  $("lEveryV").textContent = ord(c.labelEvery);
  $("lSizeV").textContent = `${c.labelSize.toFixed(1)} mm`;
  $("lSpaceV").textContent = `${c.labelSpacing} mm`;
  $("pSizeV").textContent = `${s.photos.size} mm`;
  $("sMarginV").textContent = `${s.sheet.margin} mm`;
  $("hAcrossV").textContent = String(s.halftone.across);
  paintSwatches();
  // The shared theme styles the [hidden] ATTRIBUTE, not a .hidden class —
  // using the property keeps this file honest against style.css.
  $("rowChan").hidden = s.halftone.mode === "triple";
  $("hChanHint").hidden = s.halftone.mode === "triple";
  $("rowTriple").hidden = s.halftone.mode !== "triple";
  const cd = CHANNELS[s.halftone.channel];
  $("hChanHint").textContent = cd ? cd.hint : "";
}
const ord = (n) => n === 1 ? "every line" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;

// ── recompile ───────────────────────────────────────────────────────────────
// ⚠️ COALESCED ON A TIMER, NOT ON AN ANIMATION FRAME, AND THE REASON IS
// SUBSTANTIVE. requestAnimationFrame does not fire in a tab the browser is not
// painting — a background tab, a minimised window, a pane that is not
// compositing — and this callback does not merely repaint, it COMPILES THE
// DRAWING. Gated on a frame, dropping a raster into a background tab produced
// nothing at all: no geometry, no readout, no error, and the file the user then
// exported would have been empty. A timeout always fires, coalesces exactly as
// well (one pending compile at a time, which is the property that matters), and
// leaves the tool drivable without a visible window — which is also what makes
// it testable.
let pending = 0;
function recompile() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = 0;
    gather();
    if (!state.layers.some((L) => L.on)) { state.drawing = null; render(); badges(); return; }
    try {
      state.drawing = compile({
        layers: state.layers.filter((L) => L.on),
        photos: state.photos, regions: buildRegions(), symbols: buildSymbols(),
        hatches: buildHatches(), sections: buildSections(),
        clip: state.clipOn ? state.clip : null,
        image: state.image, sym: state.sym,
      });
    } catch (e) {
      state.drawing = null;
      $("readBody").innerHTML = `<div class="note warn">${esc(e.message)}</div>`;
      return;
    }
    if (!state.view.ready) fitView();
    render();
    readout();
    badges();
    paintLayers();
    syncGrip();
  });
}
for (const el of document.querySelectorAll("input,select")) {
  el.addEventListener("input", recompile);
  el.addEventListener("change", recompile);
}
// ⚠️ CHANGING THE SCALE REFITS THE VIEW; NOTHING ELSE DOES. A change of scale
// resizes the sheet by a whole multiple — 1:200 to 1:1000 is a drawing a fifth
// the size — so holding the previous zoom leaves it as a small mark in one
// corner and reads as the tool having broken. Every other control leaves the
// view alone, because a user who has zoomed in on a detail is entitled to stay
// there while they tune the labels.
$("sScale").addEventListener("change", () => { state.view.ready = false; recompile(); });
$("sMargin").addEventListener("change", () => { state.view.ready = false; recompile(); });

// ── the drawing ─────────────────────────────────────────────────────────────
const cv = /** @type {HTMLCanvasElement} */ ($("canvas"));
const ctx = /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d"));

/**
 * ⚠️ THE CANVAS SIZES ITSELF FROM AN OBSERVER, NOT FROM window.resize, AND THE
 * DIFFERENCE IS NOT ACADEMIC. Three things change this element's size without
 * the window changing at all: the panels folding, the browser pane being hidden
 * at load and shown afterwards, and a first paint that lands before layout has
 * settled. On the `window.resize` version the canvas measured 0 at load, was
 * clamped to a 1 × 1 backing store, and never recovered — the drawing simply
 * never appeared, with no error anywhere to say why. An observer on the element
 * answers all three, because it watches the thing that actually matters.
 */
function resize() {
  const r = cv.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return;      // not laid out yet; the observer will call back
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (cv.width !== w || cv.height !== h) {
    cv.width = w; cv.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.drawing && !state.view.ready) fitView();
  render();
}
// ⚠️ THE OBSERVER IS HELD IN A VARIABLE, NOT LEFT ANONYMOUS. An unreferenced
// ResizeObserver is a live object only for as long as the engine says it is,
// and this one is the sole thing standing between the tool and a blank window.
// It is cheap insurance against a class of bug that presents as "the drawing
// never appeared" with nothing in the console.
const sizeWatch = new ResizeObserver(resize);
sizeWatch.observe(cv);
window.addEventListener("resize", resize);
// ⚠️ AND IT IS NOT TRUSTED ALONE. A module script runs before first layout, so
// the call at the bottom of this file measures zero and correctly declines to
// act; everything then depends on the observer's first callback arriving. When
// it does not — a pane that is not compositing, a tab restored in the
// background — the canvas keeps its 300 × 150 default and the tool looks
// broken. Two frames and the load event cost nothing and close that window.
setTimeout(resize, 0);
window.addEventListener("load", resize);

/**
 * ⚠️ FITTING A DRAWING INTO A CANVAS OF NO SIZE PRODUCES A ZOOM OF ZERO, AND
 * THE DAMAGE IS THAT IT LOOKS LIKE IT WORKED. An earlier version computed
 * k = 0 whenever the element had not been laid out — a background tab, a pane
 * not yet shown — and then set `ready`, which is the flag that says "the user
 * has a view, do not move it". Every subsequent frame drew the whole sheet
 * collapsed onto one point: a blank window, a populated readout, and no error
 * anywhere. Refusing to fit an unlaid-out canvas leaves `ready` false, so the
 * next resize with a real size fits properly.
 */
function fitView() {
  const d = state.drawing;
  if (!d) return;
  const r = cv.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return;
  const k = Math.min(r.width / (d.sheet.width + 40), r.height / (d.sheet.height + 40));
  if (!(k > 0) || !Number.isFinite(k)) return;
  state.view.k = k;
  state.view.x = (r.width - d.sheet.width * k) / 2;
  state.view.y = (r.height + d.sheet.height * k) / 2;
  state.view.ready = true;
}
const SX = (x) => state.view.x + x * state.view.k;
const SY = (y) => state.view.y - y * state.view.k;

function render() {
  const r = cv.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  const d = state.drawing;
  $("empty").hidden = !!d;
  if (!d) return;

  // the material
  ctx.fillStyle = "#faf8f4";
  ctx.fillRect(SX(0), SY(d.sheet.height), d.sheet.width * state.view.k, d.sheet.height * state.view.k);
  ctx.strokeStyle = "rgba(0,0,0,.10)";
  ctx.lineWidth = 1;
  ctx.strokeRect(SX(0), SY(d.sheet.height), d.sheet.width * state.view.k, d.sheet.height * state.view.k);

  // ⚠️ ONE PASS PER COLOUR, IN FILE ORDER. Grouping by layer lets the browser
  // keep one stroke style for thousands of paths, and it also puts the drawing
  // on screen in the sequence the machine will run it.
  const byLayer = new Map();
  for (const p of d.paths) { if (!byLayer.has(p.layer)) byLayer.set(p.layer, { paths: [], circles: [] }); byLayer.get(p.layer).paths.push(p); }
  for (const c of d.circles) { if (!byLayer.has(c.layer)) byLayer.set(c.layer, { paths: [], circles: [] }); byLayer.get(c.layer).circles.push(c); }

  for (const [layer, g] of byLayer) {
    ctx.strokeStyle = PASS[layer] || "#000";
    ctx.lineWidth = layer === "DLF-05_cut_outer" ? 1.4 : layer === "DLF-03_score_strong" ? 1.2 : 0.85;
    ctx.globalAlpha = layer === "DLF-99_sheet" ? 0.5 : 1;
    ctx.beginPath();
    for (const p of g.paths) {
      const pts = p.pts;
      if (pts.length < 4) continue;
      ctx.moveTo(SX(pts[0]), SY(pts[1]));
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(SX(pts[i]), SY(pts[i + 1]));
      if (p.closed) ctx.closePath();
    }
    ctx.stroke();
    if (g.circles.length) {
      ctx.beginPath();
      for (const c of g.circles) {
        const rr = c.r * state.view.k;
        if (rr < 0.25) continue;
        ctx.moveTo(SX(c.cx) + rr, SY(c.cy));
        ctx.arc(SX(c.cx), SY(c.cy), rr, 0, Math.PI * 2);
      }
      // The engrave pass is a filled field on the bed, so it is shown filled.
      if (layer === "DLF-00_engrave") { ctx.fillStyle = "#000"; ctx.fill(); }
      else ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ── interaction handles — NEVER a pass colour, never in the file ─────────
  if (state.selected >= 0 && state.photos[state.selected]) {
    const p = state.photos[state.selected];
    const x = SX(d.sheet.X(p.X)), y = SY(d.sheet.Y(p.Y));
    ctx.strokeStyle = "#0f7d86"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke();
    if (p.dx || p.dy) {
      const rx = SX(d.sheet.X(p.rawX)), ry = SY(d.sheet.Y(p.rawY));
      ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(x, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(rx, ry, 3, 0, Math.PI * 2); ctx.stroke();
    }
  }

  let run = 0;
  for (const p of d.paths) {
    for (let i = 2; i < p.pts.length; i += 2) run += Math.hypot(p.pts[i] - p.pts[i - 2], p.pts[i + 1] - p.pts[i - 1]);
  }
  for (const c of d.circles) run += 2 * Math.PI * c.r;
  $("hudPaths").textContent = String(d.paths.length);
  $("hudMarks").textContent = String(d.circles.length);
  $("hudRun").textContent = (run / 1000).toFixed(1);
}

// ── pan, zoom, and correcting a point by hand ───────────────────────────────
let drag = null;
cv.addEventListener("pointerdown", (e) => {
  const d = state.drawing;
  if (!d) return;
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const hit = pickPhoto(mx, my);
  if (hit >= 0) {
    state.selected = hit;
    paintList();
    drag = { mode: "point", i: hit, mx, my,
      X: state.photos[hit].X, Y: state.photos[hit].Y };
  } else {
    drag = { mode: "pan", mx, my, vx: state.view.x, vy: state.view.y };
  }
  try { cv.setPointerCapture(e.pointerId); } catch { /* see the note in the menu drag */ }
});
cv.addEventListener("pointermove", (e) => {
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  if (!drag) {
    cv.style.cursor = pickPhoto(mx, my) >= 0 ? "grab" : "crosshair";
    return;
  }
  if (drag.mode === "pan") {
    state.view.x = drag.vx + (mx - drag.mx);
    state.view.y = drag.vy + (my - drag.my);
    render();
  } else {
    const d = state.drawing;
    const p = state.photos[drag.i];
    // Screen millimetres back into map units — the sheet knows the scale.
    const dmm = { x: (mx - drag.mx) / state.view.k, y: -(my - drag.my) / state.view.k };
    const du = { x: dmm.x / d.sheet.mmPerUnit, y: dmm.y / d.sheet.mmPerUnit };
    correct(p, p.dx + (drag.X + du.x - p.X), p.dy + (drag.Y + du.y - p.Y));
    drag.X = p.X; drag.Y = p.Y; drag.mx = mx; drag.my = my;
    recompile();
    paintList();
  }
});
cv.addEventListener("pointerup", () => { drag = null; });
cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  zoomAt(mx, my, Math.exp(-e.deltaY * 0.0016));
}, { passive: false });

function zoomAt(mx, my, f) {
  const k0 = state.view.k;
  const k1 = Math.max(0.05, Math.min(200, k0 * f));
  state.view.x = mx - (mx - state.view.x) * (k1 / k0);
  state.view.y = my - (my - state.view.y) * (k1 / k0);
  state.view.k = k1;
  render();
}
$("zIn").addEventListener("click", () => { const r = cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.3); });
$("zOut").addEventListener("click", () => { const r = cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.3); });
$("zFit").addEventListener("click", () => { fitView(); render(); });

function pickPhoto(mx, my) {
  const d = state.drawing;
  if (!d || !state.sym.photos.enabled) return -1;
  for (let i = 0; i < state.photos.length; i++) {
    const p = state.photos[i];
    if (!p.include) continue;
    const x = SX(d.sheet.X(p.X)), y = SY(d.sheet.Y(p.Y));
    if (Math.hypot(mx - x, my - y) < 11) return i;
  }
  return -1;
}

// ── the photograph list, and the picture itself ─────────────────────────────
function paintList() {
  const host = $("plist");
  host.innerHTML = "";
  if (!state.photos.length && !state.unlocated.length) {
    host.innerHTML = `<p class="meta">No photographs loaded.</p>`;
    return;
  }
  state.photos.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "pitem" + (i === state.selected ? " sel" : "") + (p.include ? "" : " off");
    const moved = (p.dx || p.dy) ? `moved ${Math.hypot(p.dx, p.dy).toFixed(1)} m` : "raw fix";
    const bear = p.meta.direction !== undefined ? `${p.meta.direction.toFixed(0)}°` : "no bearing";
    el.innerHTML = `<span class="n">${p.n}</span>
      <span class="grow">${esc(p.meta.name)}</span>
      <span class="val">${p.include ? esc(moved) : "off the tile"} · ${esc(bear)}</span>`;
    el.title = `${p.meta.name}
`
      + [p.include ? moved : "off the tile",
         p.meta.direction !== undefined ? `looking ${p.meta.direction.toFixed(0)}°` : "no bearing",
         p.meta.taken || null,
         p.ground !== undefined ? `ground ${p.ground.toFixed(1)} m` : null,
        ].filter(Boolean).join(" · ");
    el.addEventListener("click", () => {
      state.selected = i; paintList(); render(); showPhoto(p);
    });
    host.appendChild(el);
  });
  if (state.unlocated.length) {
    const h = document.createElement("p");
    h.className = "meta";
    h.style.marginTop = "6px";
    h.innerHTML = `<b>${state.unlocated.length} without a position</b> — kept, not dropped:<br>`
      + state.unlocated.slice(0, 8).map((m) => `${esc(m.name)} — ${esc(m.problem || "")}`).join("<br>");
    host.appendChild(h);
  }
}
function showPhoto(p) {
  const url = state.thumbs.get(p.meta.name);
  if (!url) return;
  $("lbImg").src = url;
  const m = p.meta;
  $("lbCap").innerHTML = `<b>${esc(m.name)}</b><br><em>`
    + [m.taken, m.lat !== undefined ? `${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}` : "",
       m.direction !== undefined ? `looking ${m.direction.toFixed(0)}°` : "",
       p.ground !== undefined ? `ground ${p.ground.toFixed(1)} m` : "",
       (p.dx || p.dy) ? `moved ${Math.hypot(p.dx, p.dy).toFixed(1)} m by hand` : "at the raw GPS fix",
      ].filter(Boolean).map(esc).join("  ·  ") + `</em>`;
  $("lightbox").classList.add("on");
}
$("lightbox").addEventListener("click", () => $("lightbox").classList.remove("on"));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("lightbox").classList.remove("on"); });

// ── the readout ─────────────────────────────────────────────────────────────
function readout() {
  const d = state.drawing;
  if (!d) return;
  const r = d.report;
  const figs = [
    ["scale", r.sheet.scale], ["sheet", r.sheet.size],
    ["ground", r.sheet.ground], ["cell", `${r.raster.cell} m`],
    ["paths", String(r.totals.paths)], ["marks", String(r.totals.circles)],
    ["vertices", String(r.totals.vertices)],
    ["contours", r.contours ? `${r.contours.interval} m` : "off"],
  ];
  $("figs").innerHTML = figs.map(([a, b]) =>
    `<div class="fig"><span>${esc(a)}</span><b>${esc(String(b))}</b></div>`).join("");

  const L = [];
  for (const w of d.warnings) L.push(`<div class="note warn">${esc(w)}</div>`);
  if (!d.warnings.length) L.push(`<div class="note good">Nothing to flag. Every path is continuous
    and every layer is a declared laser pass.</div>`);
  L.push(`<div class="grp"><h3>Raster</h3>
    ${row("file", r.raster.name || "—")}${row("size", r.raster.size)}
    ${row("CRS", r.raster.crs)}${row("elevation", r.raster.z)}
    ${row("measured", r.raster.measured)}</div>`);
  for (const c of (r.contourLayers || [])) {
    L.push(`<div class="grp"><h3>${esc(c.name)}</h3>
      ${row("interval", c.interval + " m")}${row("continuous paths", c.paths)}
      ${row("drawn as", c.drawn + (c.verdict === "continuous" ? " paths" : " marks"))}
      ${row("style", c.style + (c.indexStyle !== c.style ? " / " + c.indexStyle : ""))}
      ${row("pass", c.pass.replace(/^DLF-/, ""))}
      ${row("labels engraved", c.labels)}${row("datum", c.datum)}</div>`);
  }
  if (r.photos) L.push(`<div class="grp"><h3>Photographs</h3>
    ${row("drawn", r.photos.drawn)}${row("moved by hand", r.photos.corrected)}
    ${row("with a bearing", r.photos.withBearing)}
    ${row("GPS doubt on the sheet", "±" + r.photos.uncertaintyMM + " mm")}</div>`);
  if (r.halftone) L.push(`<div class="grp"><h3>Halftone</h3>
    ${row("mode", r.halftone.mode)}${row("marks", r.halftone.marks)}
    ${row("verdict", r.halftone.verdict)}${row("values", r.halftone.channels.join(", "))}</div>`);
  for (const g of (r.regions || [])) {
    L.push(`<div class="grp"><h3>${esc(g.name)}</h3>
      ${row("patches", g.count)}${row("area", g.totalAreaM2 + " m²")}
      ${row("mean value", g.mean)}${row("construction", g.mode)}
      ${row("cut from", g.sheet)}</div>`);
  }
  for (const g of (r.symbols || [])) {
    L.push(`<div class="grp"><h3>${esc(g.name)}</h3>
      ${row("circles", g.signed ? `${g.count} — ${g.plus} fill · ${g.minus} cut` : g.count)}
      ${row("grid spacing", g.spacingM + " m")}
      ${row("diameters", g.smallestMM + "–" + g.largestMM + " mm")}
      ${row("full scale", g.signed ? "±" + g.hi : g.lo + " … " + g.hi)}
      ${g.dropped ? row("dropped at the edge", g.dropped) : ""}</div>`);
  }
  for (const g of (r.hatches || [])) {
    L.push(`<div class="grp"><h3>${esc(g.name)}</h3>
      ${row("marks", g.marks)}${row("lines", g.lines)}
      ${row("spacing", g.spacingMM + " mm at " + g.angle + "°")}
      ${row("values", g.lo + " … " + g.hi + (g.invert ? " (inverted)" : ""))}</div>`);
  }
  if (r.clip) {
    L.push(`<div class="grp"><h3>Clipped to ${esc(r.clip.name)}</h3>
      ${r.clip.applied
        ? row("rings", r.clip.rings + (r.clip.holes ? ` (${r.clip.holes} holes)` : ""))
          + row("paths dropped", r.clip.droppedPaths)
          + row("paths cut at the edge", r.clip.clippedPaths)
          + row("circles dropped whole", r.clip.droppedCircles)
        : row("not applied", r.clip.reason)}</div>`);
  }
  for (const g of (r.sections || [])) {
    L.push(`<div class="grp"><h3>${esc(g.name)}</h3>
      ${row("cuts", g.count + " " + g.axis + " — " + g.labels)}
      ${row("height", g.heightMM + " mm")}
      ${row("exaggeration", "×" + g.exaggeration)}
      ${row("datum", g.datum === "shared" ? "shared, the cuts compare" : "own, each cut fills")}
      ${g.gaps ? row("breaks at nodata", g.gaps) : ""}</div>`);
  }
  $("readBody").innerHTML = L.join("");

  if (r.photos) $("gpsMM").textContent = `±${r.photos.uncertaintyMM} mm`;
  if (r.halftone) {
    const b = $("hBudget");
    b.textContent = `${r.halftone.marks} marks — ${r.halftone.verdict}`;
    b.className = "note " + (/comfortable/.test(r.halftone.verdict) ? "good" : "warn");
  } else {
    $("hBudget").textContent = state.image ? "Switch it on to see the mark count."
      : "No image loaded.";
    $("hBudget").className = "note";
  }
  $("expInfo").textContent = `${r.totals.paths} paths and ${r.totals.circles} circles`
    + ` across ${new Set([...d.paths.map((p) => p.layer), ...d.circles.map((c) => c.layer)]).size} passes.`;
}
const row = (a, b) => `<div class="fig"><span>${esc(a)}</span><b>${esc(String(b))}</b></div>`;
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

// ── loading ─────────────────────────────────────────────────────────────────
function wireDrop(zone, input, handler) {
  $(zone).addEventListener("click", () => $(input).click());
  $(input).addEventListener("change", (e) => { handler([...e.target.files]); e.target.value = ""; });
  const z = $(zone);
  z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("dragover"); });
  z.addEventListener("dragleave", () => z.classList.remove("dragover"));
  z.addEventListener("drop", (e) => {
    e.preventDefault(); z.classList.remove("dragover");
    handler([...e.dataTransfer.files]);
  });
}
/**
 * A new raster becomes a LAYER, appended.
 *
 * ⚠️ EACH ONE ARRIVES ON A DIFFERENT PASS, cycling green → blue → cyan →
 * magenta, and every layer after the first arrives DASHED. Two surfaces drawn
 * identically are two surfaces nobody can tell apart, and the commonest reason
 * to load a second raster — a DSM over a DTM, this year over last — is exactly
 * the case where telling them apart is the whole point. The defaults are a
 * starting position, not a decision: both are controls.
 */
const NEXT_PASS = ["DLF-02_score_medium", "DLF-01_score_light",
  "DLF-03_score_strong", "DLF-04_cut_inner"];
const NEXT_STYLE = ["solid", "dashed", "fine_dashed", "dash_dot"];

/** The second-material template a new layer starts with. Off, but ready. */
function defaultMat() {
  return { enabled: false, source: "self", abs: true, threshold: 1,
    mode: "overlay", pass: "DLF-04_cut_inner", minArea: 4, labels: true };
}

/**
 * The circle-grid template — the grading-plan read, off until asked for.
 * `max` is the largest circle as % of the grid spacing; `min` is the smallest
 * as % of the largest. Fill (+) defaults to the engrave pass because an
 * engraved circle is a FILLED dot; cut (−) to a score pass because a scored
 * circle is an open ring — the sign is readable as form, not just colour.
 */
function defaultGrad() {
  return { enabled: false, source: "self", signed: true, across: 40,
    max: 90, min: 12, minAbs: 0,
    passPlus: "DLF-00_engrave", passMinus: "DLF-02_score_medium" };
}

/**
 * The hatch template — the value as line density, off until asked for.
 * Light score by default: hatching is a TONE, and a tone that competes with
 * the contours for weight stops being a background.
 */
function defaultHatch() {
  return { enabled: false, source: "slope", spacingMM: 2, angleDeg: 45,
    invert: false, floor: 0, pass: "DLF-01_score_light" };
}

/**
 * The section template — three horizontal cuts, the middle one exactly on the
 * plate's centre line. Off until asked for, but three is the default the
 * moment it is switched on, because one section is an anecdote and three is a
 * reading of the landform.
 */
/**
 * The hachure template — strokes down the fall line, off until asked for.
 *
 * Length varies with steepness by default, which is Lehmann's rule and reads
 * as terrain; `fixed` gives every tick the same length, which is the grading
 * plan's ticked embankment. Both are conventions a landscape architect draws.
 */
function defaultHachures() {
  return { enabled: false, spacingMM: 3, minMM: 0.9, maxMM: 2.5,
    fixed: false, indexOnly: false, uphill: false, minSlope: 0,
    pass: "DLF-01_score_light" };
}

/** The contour-modulation template — a second quantity carried by the dash. */
function defaultModulate() {
  return { enabled: false, source: "slope", period: 2,
    minInk: 5, maxInk: 100, invert: false };
}

function defaultSect() {
  return { enabled: false, count: 3, axis: "horizontal", heightMM: 12,
    datum: "own", labels: true,
    pass: "DLF-03_score_strong", linePass: "DLF-01_score_light" };
}

function addLayer(dem, name) {
  const k = state.layers.length;
  const c = JSON.parse(JSON.stringify(DEFAULTS.contours));
  c.auto = true;
  c.interval = 0;
  c.style = NEXT_STYLE[k % NEXT_STYLE.length];
  c.indexStyle = c.style;
  c.pass = NEXT_PASS[k % NEXT_PASS.length];
  c.indexPass = k === 0 ? "DLF-03_score_strong" : c.pass;
  if (k > 0) c.labels = false;      // one set of numbers on a sheet, not three
  state.layers.push({ id: state.nextId++, dem, name, on: true, contours: c, mat: defaultMat() });
  state.active = state.layers.length - 1;
  if (k === 0) { state.dem = dem; state.view.ready = false; }
  return state.layers[state.active];
}

wireDrop("dropDEM", "fileDEM", async (files) => {
  if (!files.length) return;
  // ⚠️ A BATCH LOADS IN NAME ORDER, NOT SELECTION ORDER. The first raster of an
  // empty list becomes the PRIMARY and defines the sheet, and a FileList's
  // order is whatever the OS dialog felt like — ctrl-clicking a plate set must
  // not make the sheet depend on which tile was clicked last. Numeric-aware,
  // so plate_2 sorts before plate_10.
  files = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const added = [], failed = [];
  for (const f of files) {
    try {
      const dem = readElevation(await f.arrayBuffer(), { name: f.name });
      // ⚠️ A SECOND RASTER THAT DOES NOT OVERLAP THE FIRST IS ALMOST CERTAINLY A
      // MISTAKE, and it is invisible: its contours simply are not on the sheet.
      if (state.layers.length) {
        const p = state.layers[0].dem;
        const ax0 = p.originX, ax1 = p.originX + p.ncols * p.cell;
        const ay1 = p.originY, ay0 = p.originY - p.nrows * p.cell;
        const bx0 = dem.originX, bx1 = dem.originX + dem.ncols * dem.cell;
        const by1 = dem.originY, by0 = dem.originY - dem.nrows * dem.cell;
        if (bx1 <= ax0 || bx0 >= ax1 || by1 <= ay0 || by0 >= ay1) {
          failed.push(`${f.name}: does not overlap the primary raster — nothing of it `
            + `would land on the sheet`);
          continue;
        }
      }
      added.push(addLayer(dem, f.name.replace(/\.[^.]+$/, "")));
    } catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  const parts = [];
  for (const L of added) {
    const st = stats(L.dem);
    parts.push(`<b>${esc(L.name)}</b> — ${L.dem.ncols}×${L.dem.nrows} at ${L.dem.cell} m, `
      + `${esc(L.dem.crs || "no CRS stated")}, ${st.min.toFixed(1)}–${st.max.toFixed(1)} m.`);
  }
  for (const f of failed) parts.push(`<span style="color:#a8541c">${esc(f)}</span>`);
  $("demInfo").innerHTML = parts.join("<br>") || "No raster loaded.";
  syncLayer(); paintLayers(); recompile();
});
// ── the tile boundary ───────────────────────────────────────────────────────
// ⚠️ THE WHOLE MODEL IS COMPILED FIRST AND CUT AFTERWARDS. That order is what
// makes tiles seamless: every pattern is anchored to the ground, so a boundary
// is a line drawn through one continuous field rather than two fields that
// have to be persuaded to agree. See the note at the top of clip.js.
wireDrop("dropClip", "fileClip", async (files) => {
  const info = $("clipInfo");
  const shp = files.find((f) => /\.shp$/i.test(f.name)) || files[0];
  if (!shp) return;
  // ⚠️ SAID PLAINLY, because picking the wrong sibling file is the commonest
  // mistake: a shapefile is three or more files and only .shp holds geometry.
  if (!/\.shp$/i.test(shp.name)) {
    info.innerHTML = `<span style="color:#a8541c">${esc(shp.name)} is not a .shp. `
      + `A shapefile is several files sharing a name — pick the <b>.shp</b>, the one `
      + `with the geometry in it.</span>`;
    return;
  }
  try {
    const r = readShapefile(await shp.arrayBuffer(), { name: shp.name });
    state.clip = { rings: r.rings, name: shp.name.replace(/\.[^.]+$/, "") };
    state.clipOn = true;
    $("clipOn").checked = true;
    const holes = r.rings.filter((q) => q.hole).length;
    const parts = [`<b>${esc(state.clip.name)}</b> — ${r.shapes} ${esc(r.type)} shape`
      + `${r.shapes === 1 ? "" : "s"}, ${r.rings.length} ring${r.rings.length === 1 ? "" : "s"}`
      + `${holes ? `, ${holes} of them holes` : ""}.`,
      `Bounds ${r.bbox.x0.toFixed(0)}–${r.bbox.x1.toFixed(0)} E, `
      + `${r.bbox.y0.toFixed(0)}–${r.bbox.y1.toFixed(0)} N.`];
    for (const n of r.notes) parts.push(`<span style="color:#a8541c">${esc(n)}</span>`);
    // ⚠️ A CRS MISMATCH IS THE FAILURE THAT LOOKS LIKE A BROKEN TOOL — the
    // boundary lands in the North Sea, everything clips away, and the export is
    // empty with no obvious cause. Say it here, before the compile does.
    if (state.dem) {
      const d = state.dem;
      const dx1 = d.originX + d.ncols * d.cell, dy0 = d.originY - d.nrows * d.cell;
      if (r.bbox.x1 < d.originX || r.bbox.x0 > dx1 || r.bbox.y1 < dy0 || r.bbox.y0 > d.originY) {
        parts.push(`<span style="color:#a8541c">⚠️ This boundary does not overlap the `
          + `raster (${d.originX.toFixed(0)}–${dx1.toFixed(0)} E, ${dy0.toFixed(0)}–`
          + `${d.originY.toFixed(0)} N). Almost always a different CRS — reproject the `
          + `boundary to ${esc(d.crs || "the raster's CRS")} in QGIS.</span>`);
      }
    }
    info.innerHTML = parts.join("<br>");
  } catch (e) {
    state.clip = null; state.clipOn = false; $("clipOn").checked = false;
    info.innerHTML = `<span style="color:#a8541c">${esc(e.message)}</span>`;
  }
  recompile();
});
// ⚠️ THE SIGNPOST OPENS THE SECTION AND SCROLLS TO THE ZONE, rather than just
// naming it. The clip belongs at the END of the workflow — it is the last thing
// that happens to a drawing — but "load a file" is something a reader looks for
// in Import, and Export is closed by default. Marc asked where it was, which is
// the whole argument for this button existing.
$("gotoClip").addEventListener("click", () => {
  const dz = $("dropClip");
  const det = dz.closest("details");
  if (det) det.open = true;
  dz.scrollIntoView({ block: "center" });
  // A brief mark, so the eye lands on the right thing in a long panel. Uses the
  // existing dragover style rather than inventing a second highlight.
  dz.classList.add("dragover");
  setTimeout(() => dz.classList.remove("dragover"), 1200);
});
$("clipOn").addEventListener("change", () => {
  state.clipOn = $("clipOn").checked && !!state.clip;
  if ($("clipOn").checked && !state.clip) {
    $("clipInfo").textContent = "Load a boundary first.";
    $("clipOn").checked = false;
  }
  state.view.ready = false;
  recompile();
});
$("clipClear").addEventListener("click", () => {
  state.clip = null; state.clipOn = false;
  $("clipOn").checked = false;
  $("clipInfo").textContent = "No boundary loaded — the whole model is drawn.";
  state.view.ready = false;
  recompile();
});

wireDrop("dropPhotos", "filePhotos", async (files) => {
  if (!files.length || !state.dem) {
    $("photoInfo").textContent = state.dem ? "No files." : "Load the raster first — it decides the grid.";
    return;
  }
  const bufs = [];
  for (const f of files) bufs.push({ name: f.name, buffer: await f.arrayBuffer() });
  const { located, unlocated } = readPhotoSet(bufs);
  const placed = placePhotos(located, state.dem);
  state.photos = placed.points;
  state.unlocated = unlocated;
  for (const f of files) {
    if (state.thumbs.has(f.name)) URL.revokeObjectURL(state.thumbs.get(f.name));
    state.thumbs.set(f.name, URL.createObjectURL(f));
  }
  $("photoInfo").innerHTML = `<b>${located.length}</b> with a fix, <b>${unlocated.length}</b> without.
    ${placed.outside ? `<b>${placed.outside}</b> fall outside this raster and are switched off.` : ""}
    Zone ${placed.zone}${placed.guessedZone ? " (guessed — the raster states no CRS)" : " from the raster"}.`;
  paintList();
  recompile();
});
wireDrop("dropImage", "fileImage", async (files) => {
  const f = files[0];
  if (!f || !state.dem) { $("imageInfo").textContent = "Load the raster first."; return; }
  try {
    let img;
    if (/\.tiff?$/i.test(f.name)) {
      img = readOrtho(await f.arrayBuffer(), { name: f.name });
    } else {
      // ⚠️ A PLAIN PNG OR JPEG CARRIES NO GEOREFERENCING, so it is stretched over
      // the raster's own extent and the interface says so. Guessing a position
      // for it would be an invented coordinate, which is the one thing this tool
      // must never produce.
      const bmp = await createImageBitmap(f);
      const oc = new OffscreenCanvas(bmp.width, bmp.height);
      const c2 = oc.getContext("2d");
      c2.drawImage(bmp, 0, 0);
      const px = c2.getImageData(0, 0, bmp.width, bmp.height).data;
      const rgb = new Uint8ClampedArray(bmp.width * bmp.height * 3);
      for (let i = 0, n = bmp.width * bmp.height; i < n; i++) {
        rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2];
      }
      img = { width: bmp.width, height: bmp.height, rgb, name: f.name,
        cell: (state.dem.ncols * state.dem.cell) / bmp.width,
        originX: state.dem.originX, originY: state.dem.originY };
    }
    state.image = { ...img, licence: $("licence").value };
    $("hOn").checked = true;
    $("imageInfo").innerHTML = `<b>${esc(f.name)}</b> — ${img.width}×${img.height}
      at ${(+img.cell.toFixed(3))} m/px.
      ${/\.tiff?$/i.test(f.name) ? "" : "<br>No georeferencing in this format: stretched over the raster's extent."}`;
    recompile();
  } catch (e) { $("imageInfo").innerHTML = `<span style="color:#a8541c">${esc(e.message)}</span>`; }
});
$("licence").addEventListener("change", () => {
  if (state.image) state.image.licence = $("licence").value;
  recompile();
});

// ── a QGIS style, translated ────────────────────────────────────────────────
// ⚠️ THE DECISION LOG IS SHOWN, NOT SWALLOWED. A foreign style cannot map
// cleanly onto laser passes — see the head of qgis.js — so the user is told what
// was carried across, what was approximated, and what was refused. An import
// that silently "worked" is how a contour ends up on the cut pass.
wireDrop("dropStyle", "fileStyle", async (files) => {
  const f = files[0];
  const log = $("qLog");
  if (!f) return;
  const L = activeLayer();
  if (!L) { log.innerHTML = `<div class="note warn">Load a raster first — a style is applied to a layer.</div>`; return; }
  try {
    const text = await f.text();
    const style = readQGISStyle(text);
    const r = translateToContours(style, { allowCut: $("qCut").checked });
    Object.assign(L.contours, r.patch);
    const bits = [`<div class="note good"><b>${esc(f.name)}</b> — ${style.format}`
      + `${style.version ? " " + esc(style.version) : ""}, ${style.renderer}, applied to `
      + `<b>${esc(L.name)}</b>.</div>`];
    for (const d of r.decisions) bits.push(`<div class="note">${esc(d)}</div>`);
    for (const w of r.warnings) bits.push(`<div class="note warn">${esc(w)}</div>`);
    log.innerHTML = bits.join("");
    syncLayer(); paintLayers(); recompile();
  } catch (e) {
    log.innerHTML = `<div class="note warn">${esc(f.name)}: ${esc(e.message)}</div>`;
  }
});

function replaceAll() {
  state.photos = []; state.unlocated = []; state.selected = -1;
  paintList(); recompile();
}

// ⚠️ FIT PICKS A LADDER SCALE, IT DOES NOT FIT THE SHEET. The bed size is the
// constraint, not the target: the drawing gets the largest scale from the
// ladder that still fits inside it, so the result is 1:200 or 1:500 and never
// 1:187.4. A model is a document and it gets a scale a ruler knows.
$("sFit").addEventListener("click", () => {
  if (!state.dem) return;
  const w = +$("sBedW").value, h = +$("sBedH").value;
  const found = fitScale(state.dem, w, h, { margin: +$("sMargin").value });
  if (found) {
    $("sScale").value = String(found);
    state.view.ready = false;                       // the sheet just changed size
    recompile();
  } else {
    // Saying nothing here would look like the button was broken.
    $("expInfo").textContent = "";
    $("sTitle").placeholder = `nothing on the ladder fits ${w} × ${h} mm — try a larger bed`;
  }
});

// ── the demonstration site ──────────────────────────────────────────────────
$("demoBtn").addEventListener("click", () => {
  // A landform with a summit, a hollow and a bench, so every part of the tool
  // has something honest to draw. Built here rather than shipped as a file, so
  // the demonstration cannot go stale against the readers.
  state.layers = []; state.active = 0;
  const demoDEM = makeDEM(280, 360, 0.5, (c, r) => {
    const x = c / 360, y = r / 280;
    let z = 62
      + 11 * Math.exp(-(((x - 0.34) ** 2) / 0.02 + ((y - 0.42) ** 2) / 0.03))
      - 5.5 * Math.exp(-(((x - 0.71) ** 2) / 0.012 + ((y - 0.66) ** 2) / 0.018))
      + 4.2 * x + 1.7 * Math.sin(x * 13) * Math.cos(y * 9) * 0.6;
    if (x > 0.52 && x < 0.62 && y > 0.15 && y < 0.9) z = Math.min(z, 64.4);   // a bench
    return z;
  }, { originX: 654000, originY: 7738140, crs: "EPSG:25833", name: "demonstration site" });
  addLayer(demoDEM, "demonstration site");
  state.view.ready = false;
  const st = stats(state.dem);
  $("demInfo").innerHTML = `<b>demonstration site</b> — 360×280 at 0.5 m, EPSG:25833,
    ${st.min.toFixed(1)}–${st.max.toFixed(1)} m. A summit, a hollow and a cut bench.`;
  // A short field walk, placed on the ground rather than at invented coordinates.
  state.photos = [0.22, 0.35, 0.48, 0.62, 0.75].map((f, i) => {
    const X = state.dem.originX + state.dem.ncols * state.dem.cell * f;
    const Y = state.dem.originY - state.dem.nrows * state.dem.cell * (0.3 + 0.4 * Math.sin(f * 4));
    return { meta: { name: `walk-${i + 1}.jpg`, direction: (i * 67) % 360,
        taken: `2026:06:1${i} 1${i}:05:00` },
      n: i + 1, X, Y, rawX: X, rawY: Y, dx: 0, dy: 0, inside: true, include: true };
  });
  state.unlocated = [];
  $("photoInfo").innerHTML = `<b>5</b> synthetic observations, already on the ground.`;
  paintList();
  syncLayer(); paintLayers();
  recompile();
});

// ── export ──────────────────────────────────────────────────────────────────
function save(name, text, mime) {
  const b = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const stem = () => (state.dem?.name || "terrainmapper").replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-");
$("expDXF").addEventListener("click", () => {
  if (!state.dem) return;
  try {
    // ⚠️ RECOMPILED WITH forExport, WHICH IS WHERE THE LICENCE GUARD BITES.
    // The preview path deliberately does not set it, so a restricted image can
    // be looked at and cannot be written.
    const d = compile({ layers: state.layers.filter((L) => L.on), photos: state.photos, regions: buildRegions(), image: state.image,
      sym: state.sym, forExport: true });
    const sheets = sheetsIn(d);
    for (const sh of sheets) {
      const suffix = sheets.length > 1 ? `-${sh}` : "";
      save(`${stem()}${suffix}.dxf`, toDXF(d, { sheet: sh }).toString(), "application/dxf");
    }
    if (sheets.length > 1) {
      $("expInfo").innerHTML = `<b>${sheets.length} sheets of material</b> — one DXF each: `
        + sheets.map((sh) => esc(`${stem()}-${sh}.dxf`)).join(", ")
        + `. Pin the registration holes before gluing.`;
    }
  } catch (e) {
    $("expInfo").innerHTML = `<span style="color:#a8541c">${esc(e.message)}</span>`;
  }
});
// ⚠️ THE TEST SHEET IS NOT COMPILED FROM A RASTER, so it bypasses `compile` and
// builds its own Drawing — but it goes through the SAME dxf writer, the same
// stroke font and the same dash engine. A sheet drawn by separate code would
// measure the sheet rather than the tool.
$("expSVG").addEventListener("click", () => {
  if (!state.drawing) return;
  try {
    // ⚠️ RECOMPILED WITH forExport, like the DXF path — the licence guard must
    // bite on every route out, not only the one somebody remembered.
    const d = compile({ layers: state.layers.filter((L) => L.on), photos: state.photos, regions: buildRegions(),
      image: state.image, sym: state.sym, forExport: true });
    const sheets = sheetsIn(d);
    for (const sh of sheets) {
      const suffix = sheets.length > 1 ? `-${sh}` : "";
      save(`${stem()}${suffix}.svg`,
        toSVG(d, { title: `${stem()}${suffix}`, sheet: sheets.length > 1 ? sh : undefined }),
        "image/svg+xml");
    }
  } catch (e) {
    $("expInfo").innerHTML = `<span style="color:#a8541c">${esc(e.message)}</span>`;
  }
});

$("expTest").addEventListener("click", () => {
  const d = buildTestSheet({
    material: $("tsMaterial").value.trim() || undefined,
    date: new Date().toISOString().slice(0, 10),
    cutTest: $("tsCut").checked,
  });
  save("SP500-material-test.dxf", toDXF(d).toString(), "application/dxf");
  save("SP500-material-test.svg", toSVG(d, { title: "SP500 material test" }), "image/svg+xml");
  save("SP500-material-test-procedure.txt", testSheetProcedure(d), "text/plain");
  $("expInfo").innerHTML = `<b>Material test sheet</b> — ${d.sheet.width} × ${d.sheet.height} mm, `
    + `${d.report.totals.paths} paths. Three files saved: the DXF, an SVG of the same sheet, and the `
    + `procedure to keep with the coupon.` + d.warnings.map((w) => `<br><span style="color:#a8541c">${esc(w)}</span>`).join("");
});

$("expReport").addEventListener("click", () => {
  if (!state.drawing) return;
  save(`${stem()}-report.txt`,
    reportText(state.drawing, { date: new Date().toISOString().slice(0, 10) }), "text/plain");
});

// ── go ──────────────────────────────────────────────────────────────────────
resize();
syncLayer();
paintLayers();
gather();
paintList();
