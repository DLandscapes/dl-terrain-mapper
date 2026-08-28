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
import { buildTestSheet, testSheetProcedure } from "./testsheet.js";
import { toSVG } from "./svg.js";
import { PASS_COLOURS, PASS_LABELS, passColour } from "./dxf.js";
import { niceInterval } from "./contours.js";
import { slopeDegrees } from "./symbols.js";
import { readShapefile, readPRJ } from "./shapefile.js";
import { readGML } from "./gml.js";
import { drawingToShapefiles, zipStore } from "./shp-write.js";
import { rasterPlan, paintEngraving, cutLinesOnly } from "./raster.js";
import { readDBF, assertPairs, fieldRange } from "./dbf.js";
import { FILL_PATTERNS, PATTERN_ORDER, BURN_MM } from "./patterns.js";
import { FEATURE_DEFAULTS, FEATURE_LINETYPES, LINETYPE_ORDER,
  POINT_SYMBOLS, SYMBOL_ORDER } from "./features.js";
import { ruggedness, roughness, wetnessIndex, indexNote } from "./terrain.js";

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
  // ⚠️ Which imported layer is serving as the tile boundary, by ID. Null when
  // the boundary was dropped straight onto the clip strip, or when there is none.
  // ⚠️ WHAT THE INSPECTOR IS LOOKING AT. The right-hand window is the property
  // sheet for the SELECTED OBJECT, and the tool holds two kinds — raster layers
  // and feature layers — in two lists. One selection spans both: clicking in
  // either list moves it, so the inspector always has exactly one subject and
  // the two lists cannot both look selected at once.
  selKind: "raster",
  clipFromFeature: null,
  // Drawn shapefile layers - points, lines and areas, each with its own style.
  /** @type {any[]} */ features: [],
  activeFeature: 0,
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

// ── interface density, and remembering it ───────────────────────────────────
// ⚠️ EVERY READ AND WRITE IS WRAPPED. `localStorage` throws outright in a
// private window, when site data is blocked, and from a `file://` page — and
// this tool is one people are told to run locally. A preference that cannot be
// saved must cost nothing; the tool opens at its defaults and works.
const REMEMBER = {
  /** @param {string} k @param {string|null} fallback */
  get(k, fallback = null) {
    try { const v = localStorage.getItem("dltm." + k); return v === null ? fallback : v; }
    catch { return fallback; }
  },
  /** @param {string} k @param {string} v */
  set(k, v) { try { localStorage.setItem("dltm." + k, v); } catch { /* not offered */ } },
};

/**
 * Hide the explanatory prose once it has been read.
 *
 * ⚠️ THE TOOL DOES NOT GET QUIETER, ONLY LESS TALKATIVE. Only `.why` and
 * `.fine` go — see the stylesheet for why `.note` and `.meta` must not.
 * @param {boolean} terse
 */
function setTerse(terse) {
  document.body.classList.toggle("terse", terse);
  const b = $("explainToggle");
  b.setAttribute("aria-pressed", String(terse));
  b.title = terse ? "Show the explanations" : "Hide the explanations";
  REMEMBER.set("terse", terse ? "1" : "0");
  setTimeout(syncGrip, 0);
}
$("explainToggle").addEventListener("click", () =>
  setTerse(!document.body.classList.contains("terse")));
// ⚠️ HIDDEN BY DEFAULT (Marc). The prose earns its place the first time and
// is furniture every time after; 48 paragraphs across the two windows is most
// of their height. The `?` in the viewport strip brings it back, and the
// choice is remembered — unlike the folds, which always start closed, because
// this changes how much a panel SAYS rather than what it contains.
setTerse(REMEMBER.get("terse", "1") === "1");

// ⚠️ THE PANELS OPEN THE WAY THEY WERE LEFT — which is the honest way to give a
// familiar user a compact interface without taking the front door away from a
// new one. A first visit gets the defaults in the markup, where every fold that
// accepts a file is open; after that the tool remembers. Marc asked three times
// in one session where to load something, and this keeps that fix intact for
// the person it was for.
// ⚠️ EVERY FOLD STARTS CLOSED, EVERY TIME. This used to remember what you
// left open, which sounds kinder and is not: it means the page you arrive at
// depends on what you did days ago, so "all menus collapsed" was true on a
// machine that had never run the tool and false on Marc's. A tool that opens
// the same way every time can be reasoned about; one that opens differently per
// browser cannot. Discoverability is not what the memory was protecting any
// more — a file dropped ANYWHERE loads and opens the fold it landed in.
for (const d of document.querySelectorAll("details.panel, details.sub")) d.open = false;



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
  // ⚠️ ONE CONTROL, BOTH WINDOWS (Marc). They are two halves of one
  // interface — the lists you compose from and the sheet for whatever is
  // selected — and wanting the ground clear means wanting both out of the way.
  // Two separate fold buttons meant two clicks to see the drawing and a state
  // where half the chrome was still over it.
  $("sidebar").classList.toggle("min", folded);
  $("readout").classList.toggle("min", folded);
  $("menu-min").hidden = folded;
  $("menu-chip").hidden = !folded;
  syncGrip();
  resize();
}

/**
 * ⚠️ THE INSPECTOR IS NOT SHOWN WHEN THERE IS NOTHING TO INSPECT. With no
 * raster and no feature loaded it is a full-height property sheet for an object
 * that does not exist, standing over the one message a new arrival needs. It
 * has no fold button of its own any more, so this is what keeps it out of the
 * way — and it comes back on its own the moment something is loaded.
 */
function syncWindows() {
  const nothing = !state.layers.length && !state.features.length
    && !state.image && !state.photos.length;
  $("readout").classList.toggle("empty", nothing);
}
// ⚠️ SUB-FOLDS TOO, NOT JUST PANELS. Opening a sub-section changes the
// panel's height exactly as opening a panel does, and the width grip is kept
// against the panel's edge by script. This listener used to be attached inside
// the runtime folder; losing it with that code would have left the grip
// floating away from the panel on every sub-fold.
for (const d of document.querySelectorAll("details.panel, details.sub")) {
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
  "hhPass", "xPass", "xLinePass", "kPass", "ftPass"];
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

// ── folding the sub-sections ────────────────────────────────────────
// ⚠️ THE FOLDS ARE IN THE MARKUP NOW, NOT BUILT HERE. A `foldSubsections()`
// used to walk each panel at load and wrap every `<div class="subhead">` into a
// `details.sub` — which worked, and was invisible to anyone reading index.html,
// so the grammar looked unused and got implemented a second time in the HTML.
// Two implementations of one thing, one of them dead.
//
// The markup version is the one kept, for the sibling tool's own reason: folds
// that exist in the source can be read, diffed and reordered without running
// anything. `details.sub` + `summary.subhead` + `.sub-body`, indented under a
// hairline spine so a fold reads as INSIDE its panel rather than as the next
// panel — one window family across the tools, not two. The styling is in
// style.css and is unchanged.
//
// Nothing sets a section open any more: they all start closed, every time. See
// the rule near the top of this file.


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


/**
 * Show the property sheet for whatever is selected, and name it.
 *
 * ⚠️ THE WINDOW MUST NAME ITS SUBJECT. A panel of controls that does not say
 * what it is editing is a panel you distrust — and now that it serves two kinds
 * of object, the title is the only thing distinguishing "the contour interval of
 * this raster" from "the fill pattern of this shapefile".
 *
 * ⚠️ EXACTLY ONE BLOCK IS VISIBLE. Feature styling used to live in the left
 * menu, so styling controls appeared on BOTH sides of the screen, divided by
 * which kind of object they belonged to — a distinction nobody can see from the
 * outside, and Marc's own reason for asking. Left is what you load and compose;
 * right is what the selected thing IS.
 */
function syncInspector() {
  const kind = state.selKind;
  const f = kind === "feature" ? activeFeature() : null;
  const L = activeLayer();
  // ⚠️ ONE BLOCK PER KIND OF LAYER, AND ONLY EVER ONE VISIBLE. Every control a
  // layer cannot use is ABSENT, not greyed — the same rule the feature panel
  // already kept for a fill pattern on a line. It is also what makes the window
  // short: a raster's contour settings and an orthophoto's halftone settings
  // were never both relevant, they were only ever both on screen.
  const blocks = {
    raster: "propRaster", feature: "featStyle",
    image: "propImage", photos: "propPhotos",
  };
  const showing = (kind === "feature" && !f) ? "raster" : kind;
  for (const [k, id] of Object.entries(blocks)) {
    const el = $(id);
    if (el) el.hidden = k !== showing;
  }
  const t = $("propTitle");
  if (!t) return;
  if (showing === "feature" && f) {
    t.textContent = f.name;
    t.title = `${f.name} — ${counted(f.count, f.kind)}`;
  } else if (showing === "image" && state.image) {
    t.textContent = state.image.name || "Orthophoto";
    t.title = `${state.image.name || "orthophoto"} — engraved as halftone marks`;
  } else if (showing === "photos") {
    t.textContent = "Photographs";
    t.title = `${state.photos.length} photograph${state.photos.length === 1 ? "" : "s"}`;
  } else if (L) {
    t.textContent = L.name;
    t.title = `${L.name} — layer ${state.active + 1} of ${state.layers.length}`
      + `${state.active === 0 ? ", the primary (it defines the sheet)" : ""}`;
  } else {
    t.textContent = "Properties";
    t.title = "";
  }
}


/**
 * One icon per kind of layer, in the sidebar's own drawing convention.
 *
 * ⚠️ ONE FAMILY, NOT SIX FOUND CHARACTERS. The rows used to carry a NUMBER for
 * a raster and then ▣ ╱ ● ⌾ ◉ for everything else — a digit, three geometric
 * shapes, an APL glyph and a fisheye, drawn by whichever font happened to have
 * them. They differed in weight, in size and in vertical alignment, so a column
 * of them read as noise rather than as a key. These are all 24×24, all stroked
 * at one weight, all built from two or three marks so they survive at 12 px.
 *
 * ⚠️ THE RASTER'S ORDER MOVED TO THE DETAIL COLUMN. It used to be the swatch's
 * contents, which is why rasters could not have an icon at all. The order is
 * still load-bearing — layer 1 is the primary and defines the sheet — so it is
 * still shown, just where a number belongs rather than where a symbol does.
 */
const LAYER_ICON = {
  // nested contours — the ground itself
  raster: '<path d="M2 17c4-7 7-10 10-10s6 3 10 10"/><path d="M7 19c2-3.5 3.5-5 5-5s3 1.5 5 5"/>',
  // a framed picture with a horizon
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/>',
  // a camera
  photos: '<rect x="2" y="7" width="20" height="12" rx="2"/><circle cx="12" cy="13" r="3.2"/>'
    + '<path d="M9 7l1.4-2h3.2L15 7"/>',
  // a closed, irregular shape — an area has an inside
  polygon: '<path d="M4 8l7-4 9 5-2 9-10 2z"/>',
  // a polyline — a line has no inside
  line: '<polyline points="3 17 9 9 14 14 21 5"/>',
  // a mark with a ring, which is what the tool actually draws for a point
  point: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>',
};

/** @param {keyof LAYER_ICON} kind */
const layerIcon = (kind) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${LAYER_ICON[kind] || LAYER_ICON.point}</svg>`;

/**
 * EVERY LAYER, IN ONE FLAT LIST.
 *
 * ⚠️ ONE LIST, NOT SIX. Grouping by kind meant six headings over what is usually
 * one or two layers each, so the panel was mostly labels for empty groups. A row
 * says what it is; the reader does not need the tool to sort them into bins
 * first. The list IS the set of selectable things, which is what makes "select a
 * layer and the inspector becomes its property sheet" a rule with no exceptions.
 *
 * ⚠️ RASTERS COME FIRST AND STAY FIRST. Their order is load-bearing — layer 1 is
 * the PRIMARY and defines the sheet — so they are the only rows that drag.
 * Everything below them is drawn in an order the compiler fixes, not one a list
 * can express, so letting those rows be reordered would be a lie the drawing
 * then contradicts.
 */
function paintLayers() {
  const host = $("layers");
  if (!host) return;
  host.innerHTML = "";
  setTimeout(syncGrip, 0);           // the list changes the panel's height

  const row = (o) => {
    const el = document.createElement("div");
    el.className = "pitem" + (o.selected ? " sel" : "") + (o.off ? " off" : "");
    el.title = o.title;
    el.innerHTML = (o.handle ? '<span class="drag" aria-hidden="true">⠿</span>' : "")
      + `<span class="n" style="background:${o.colour}">${o.mark}</span>`
      + `<span class="grow">${esc(o.name)}</span>`
      + `<span class="val">${esc(o.detail)}</span>`;
    el.addEventListener("click", o.onSelect);
    if (o.onRemove) {
      const x = document.createElement("button");
      x.className = "link"; x.textContent = "remove"; x.style.fontSize = ".66rem";
      x.addEventListener("click", (e) => { e.stopPropagation(); o.onRemove(); });
      el.appendChild(x);
    }
    host.appendChild(el);
    return el;
  };

  // ── elevation rasters ─────────────────────────────────────────────────────
  state.layers.forEach((L, i) => {
    const c = L.contours;
    // ⚠️ THE SWATCH IS THE PASS COLOUR — the machine operation, not a legend
    // colour chosen for the screen. See PASS_COLOURS in dxf.js.
    // ⚠️ styleLabel(), never LINE_STYLES[...].label: a style with no entry in
    // the table gives `undefined.label`, a throw one line before recompile().
    const el = row({
      selected: i === state.active && state.selKind === "raster",
      off: !L.on, handle: true, colour: passColour(c.pass), mark: layerIcon('raster'),
      name: L.name,
      detail: `${i + 1} · ${i === 0 ? "primary · " : ""}${styleLabel(c.style)}`,
      // ⚠️ THE FULL NAME GOES FIRST. Rows truncate with an ellipsis, and site
      // rasters are named LAR3072_A1_plate_A1_DTM_1m — every distinguishing
      // character is at the END, so every truncated row looks identical.
      title: `${L.name}\n${L.dem.ncols}×${L.dem.nrows} at ${L.dem.cell} m`
        + `${L.dem.crs ? ", " + L.dem.crs : ""}\n`
        + `${styleLabel(c.style)} on ${c.pass}\n`
        + (i === 0 ? "The primary raster defines the sheet." : "An elevation raster."),
      onSelect: () => {
        state.active = i; state.selKind = "raster";
        syncLayer(); paintLayers();
      },
      onRemove: () => {
        state.layers.splice(i, 1);
        state.active = Math.max(0, Math.min(state.active, state.layers.length - 1));
        state.dem = state.layers[0]?.dem || null;
        // ⚠️ REMOVING THE PRIMARY RESIZES THE SHEET, so the view must refit or
        // the drawing jumps out of frame with no explanation.
        state.view.ready = false;
        syncLayer(); paintLayers(); syncWindows(); recompile();
      },
    });
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      dragFrom = i; el.classList.add("dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
      } catch { /* older engines */ }
    });
    el.addEventListener("dragend", () => { dragFrom = -1; clearDropMarks(); paintLayers(); });
    el.addEventListener("dragover", (e) => {
      if (dragFrom < 0 || dragFrom === i) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      clearDropMarks();
      el.classList.add(e.clientY < r.top + r.height / 2 ? "over-above" : "over-below");
    });
    el.addEventListener("dragleave", () => el.classList.remove("over-above", "over-below"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dragFrom < 0 || dragFrom === i) return;
      const r = el.getBoundingClientRect();
      moveLayer(dragFrom, e.clientY < r.top + r.height / 2 ? i : i + 1);
    });
  });

  // ── the orthophoto ────────────────────────────────────────────────────────
  if (state.image) {
    row({
      selected: state.selKind === "image", colour: passColour("DLF-00_engrave"),
      mark: layerIcon('image'), name: state.image.name || "orthophoto", detail: "halftone",
      title: `${state.image.name || "orthophoto"}\nEngraved as halftone marks.`,
      onSelect: () => { state.selKind = "image"; syncInspector(); paintLayers(); },
    });
  }

  // ── the photographs, as ONE layer ─────────────────────────────────────────
  // ⚠️ One mark shape and one size for the whole set, so a row each would read
  // as a multi-selection of things that cannot be selected apart. `plist` still
  // lists them individually, inside this layer's own properties.
  if (state.photos.length) {
    const n = state.photos.length;
    row({
      selected: state.selKind === "photos", colour: passColour("DLF-01_score_light"),
      mark: layerIcon('photos'), name: "Photographs", detail: String(n),
      title: `${n} photograph${n === 1 ? "" : "s"}, drawn with one mark and one size.`,
      onSelect: () => { state.selKind = "photos"; syncInspector(); paintLayers(); },
    });
  }

  // ── feature layers ────────────────────────────────────────────────────────

  state.features.forEach((f, i) => {
    row({
      selected: i === state.activeFeature && state.selKind === "feature",
      colour: passColour(f.style.pass), mark: layerIcon(f.kind),
      name: f.name, detail: counted(f.count, f.kind),
      title: `${f.name}\n${counted(f.count, f.kind)}`
        + (f.id === state.clipFromFeature
          ? "\nThe tile boundary — its outline is the outer cut, so it is not drawn as a layer."
          : ""),
      onSelect: () => {
        state.activeFeature = i; state.selKind = "feature";
        syncFeature(); paintLayers();
      },
      onRemove: () => {
        // ⚠️ A CLIP POINTING AT A DELETED LAYER WOULD CLIP TO GEOMETRY NOBODY
        // CAN SEE.
        if (f.id === state.clipFromFeature) {
          state.clipFromFeature = null; state.clip = null; state.clipOn = false;
          $("clipOn").checked = false;
          $("clipInfo").textContent = "The boundary layer was removed — the whole model is drawn.";
        }
        state.features.splice(i, 1);
        state.activeFeature = Math.max(0, Math.min(state.activeFeature, state.features.length - 1));
        if (!state.features.length && state.selKind === "feature") state.selKind = "raster";
        syncFeature(); paintLayers(); refreshClipSources(); syncWindows(); recompile();
      },
    });
  });

  const info = $("featInfo");
  if (info && !host.children.length) info.textContent = "Nothing loaded — drop a file anywhere.";
}

// The three painters are one now; these keep every call site working.
function paintFeatureList() { paintLayers(); }
function paintOtherLayers() { paintLayers(); }

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
  syncInspector();
  if (!L) return;
  const c = L.contours;
  $("cOn").checked = c.enabled;
  $("cInt").value = String(c.interval || 1);
  $("cIdx").value = String(c.indexEvery);
  $("lOn").checked = c.labels;
  $("lEvery").value = String(c.labelEvery);
  $("lSize").value = String(c.labelSize);
  $("lSpace").value = String(c.labelSpacing);
  $("lOrient").value = c.orientation;
  $("cDatum").value = c.datum;
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
  $("gStylePlus").value = g.stylePlus;
  $("gStyleMinus").value = g.styleMinus;
  $("gHatchMM").value = String(g.hatchMM);
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
/** What each derived surface is called in a picker and in a layer's name. */
const INDEX_LABEL = {
  slope: "slope (degrees)",
  tri: "ruggedness — TRI (Riley)",
  roughness: "roughness (3×3 range)",
  twi: "wetness index — TWI",
};

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
  // ⚠️ FOUR DERIVED SURFACES, AND EACH NAMES ITS DEFINITION IN THE READOUT.
  // "The wetness index" is not one number — see terrain.js. Anything richer
  // than these still arrives as its own raster from DL-TerrainDiversity.
  for (const k of ["slope", "tri", "roughness", "twi"]) add(k, INDEX_LABEL[k]);
  state.layers.forEach((q, qi) => {
    if (q === L) return;
    add(String(q.id), `difference to ${qi + 1} · ${q.name}`);
  });
  sel.value = cfg.source;
  if (sel.value !== cfg.source) { cfg.source = "self"; sel.value = "self"; }
  // ⚠️ THE DEFINITION TRAVELS WITH THE CHOICE. "Ruggedness" and "the wetness
  // index" are each several different published numbers; a drawing that does
  // not say which one it used is a picture rather than a measurement.
  sel.title = INDEX_LABEL[cfg.source] ? indexNote(cfg.source) : "";
}

/**
 * The note a derived source owes the reader, shown under its own block.
 * ⚠️ TWI EARNS AN EXTRA SENTENCE because it is the one index here that is not
 * a local calculation: it routes water across the whole surface, so a tile
 * computed on its own is wrong at every edge.
 * @param {string} source @param {HTMLElement|null} note @param {boolean} active
 */
function noteSource(source, note, active, ms) {
  if (!note || !active || !INDEX_LABEL[source]) return;
  let t = indexNote(source);
  if (source === "twi") {
    t += ". Compute it on the WHOLE model and clip afterwards — a tile on its own "
      + "is missing the water that would arrive from outside it.";
  }
  if (ms >= 300) {
    t += ` Took ${(ms / 1000).toFixed(1)} s to compute, and is kept until this raster `
      + `changes — the wait does not repeat.`;
  }
  note.textContent = t;
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
  // ⚠️ THE DERIVED SURFACES ARE CACHED PER LAYER. The wetness index fills every
  // depression and routes flow across the whole raster; recomputing it on each
  // keystroke of an unrelated slider would make the tool feel broken. The cache
  // is keyed by the index name and thrown away whenever the layer's raster is
  // replaced, which is the only thing that can change the answer.
  const derived = (kind, fn) => {
    L.derived = L.derived || {};
    L.derivedMs = L.derivedMs || {};
    if (!L.derived[kind]) {
      // ⚠️ TIMED, AND THE TIME IS SHOWN IF IT WAS LONG ENOUGH TO NOTICE. The
      // wetness index fills every depression and routes flow across the whole
      // raster: measured at 80 ms on the demonstration site, 0.7 s at a
      // million cells and 2.7 s at four million — and it runs on the page's
      // one thread, so the tool STOPS for that long. An unexplained freeze
      // reads as a crash; a stated one reads as work.
      const t0 = performance.now();
      L.derived[kind] = fn(L.dem);
      L.derivedMs[kind] = Math.round(performance.now() - t0);
    }
    return { dem: { ...L.dem, z: L.derived[kind], name: `${L.name} ${kind}` },
      label: `${L.name} ${INDEX_LABEL[kind] || kind}`,
      ms: L.derivedMs[kind] };
  };
  if (source === "slope") return derived("slope", slopeDegrees);
  if (source === "tri") return derived("tri", ruggedness);
  if (source === "roughness") return derived("roughness", roughness);
  if (source === "twi") return derived("twi", (d) => wetnessIndex(d));
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
    noteSource(g.source, note, L === activeLayer(), r.ms);
    out.push({ dem: r.dem, name: `${r.label} · circles`,
      signed: g.signed, across: g.across,
      minFraction: g.min / 100, maxFraction: g.max / 100,
      minAbs: g.minAbs, passPlus: g.passPlus, passMinus: g.passMinus,
      stylePlus: g.stylePlus, styleMinus: g.styleMinus,
      hatchMM: g.hatchMM, hatchAngle: g.hatchAngle });
  }
  return out;
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
    noteSource(h.source, note, L === activeLayer(), r.ms);
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
  c.interval = +$("cInt").value || 1;
  c.indexEvery = +$("cIdx").value;
  c.labels = $("lOn").checked;
  c.labelEvery = +$("lEvery").value;
  c.labelSize = +$("lSize").value;
  c.labelSpacing = +$("lSpace").value;
  c.orientation = $("lOrient").value;
  c.datum = $("cDatum").value;
  c.style = $("cStyle").value;
  c.indexStyle = $("cIdxStyle").value;
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
    g.stylePlus = $("gStylePlus").value;
    g.styleMinus = $("gStyleMinus").value;
    g.hatchMM = Math.min(5, Math.max(0.2, +$("gHatchMM").value || 0.6));
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
/**
 * EVERYTHING the compiler is given, built in ONE place.
 *
 * ⚠️ THIS FUNCTION EXISTS BECAUSE BUG 17 CAME BACK. That bug was `expDXF`
 * compiling `dem: state.dem` — the primary raster only — while the preview used
 * the layer list, so every multi-raster DXF silently held one surface. It was
 * fixed once. Then the export handlers went on hand-building their own input
 * object, and each new translation added to `recompile` had to be remembered in
 * two more places. It was not: the circle grid, the hatching, the sections AND
 * the clip boundary were all missing from every exported file, so a clipped
 * drawing previewed clipped and exported whole, with no red boundary on it.
 *
 * ⚠️ THE ONE-DRAWING RULE IS NOT A CONVENTION, IT IS THIS FUNCTION. The preview
 * and the writers must be handed the SAME input; the only permitted difference
 * is `forExport`, which is where the licence guard bites. Anything that needs
 * to reach the file goes here and reaches every route by construction.
 */
function compileInput(forExport) {
  return {
    layers: state.layers.filter((L) => L.on),
    photos: state.photos,
    regions: buildRegions(),
    symbols: buildSymbols(),
    hatches: buildHatches(),
    sections: buildSections(),
    features: buildFeatures(),
    clip: state.clipOn ? state.clip : null,
    image: state.image,
    sym: state.sym,
    forExport: !!forExport,
  };
}

let pending = 0;
function recompile() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = 0;
    gather();
    if (!state.layers.some((L) => L.on)) { state.drawing = null; render(); badges(); return; }
    try {
      state.drawing = compile(compileInput(false));
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
    // ⚠️ IN THE RECOMPILE CYCLE, NOT ON THE LOADERS. Rasters arrive by four
    // routes — the strip, the window-wide drop, the demo builder and a reorder —
    // and hooking each one is how the inspector ends up staying hidden after
    // exactly one of them. Everything that changes what is loaded recompiles.
    syncWindows();
    paintOtherLayers();
    // The sheet's size decides the image's size, and the sheet changes with the
    // scale, the margin and which raster is primary.
    rasterNote();
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
    // ⚠️ THE ENGRAVE PASS IS DRAWN AT THE WIDTH IT BURNS, NOT AS A HAIRLINE.
    // Every solid in this tool is strokes at `SOLID_MM`, the distance at which
    // burns merge — so a hairline preview shows a scale bar, a north needle and
    // a letter as STRIPES, and shows them getting further apart the closer you
    // look. That is the preview lying about the material, which is the one thing
    // this tool is built not to do. Drawn at the width a burn IS, the strokes
    // overlap on screen exactly as they will on the bed.
    //
    // ⚠️ AND IT IS A FLOOR, NOT A REPLACEMENT. Zoomed out, 0.3 mm is a fraction
    // of a pixel; below 0.85 px a line stops being visible at all, so the
    // hairline is kept as the minimum. Only the engrave pass gets this: a score
    // or a cut IS a path the head follows once, and drawing it wide would claim
    // a width the machine has nowhere to put.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = layer === "DLF-00_engrave"
      ? Math.max(0.85, BURN_MM * state.view.k)
      : layer === "DLF-05_cut_outer" ? 1.4 : layer === "DLF-03_score_strong" ? 1.2 : 0.85;
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
  // ⚠️ HANDED BACK SO THE WINDOW-WIDE DROP CAN CALL THE SAME FUNCTION. A second
  // copy of "what to do with a GeoTIFF" is a second thing to remember when a
  // loader changes — the same argument as compileInput(), one rung down.
  return handler;
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
    // ⚠️ THE SIGN IS A DIFFERENCE IN GEOMETRY, NOT ONLY IN PASS. Added ground
    // is a HATCHED symbol, excavated ground a bare RING — drawn that way in the
    // file, so the distinction survives a machine whose engrave pass does not
    // rasterise closed paths. On material there is no colour to fall back on.
    stylePlus: "hatched", styleMinus: "outline", hatchMM: 0.6, hatchAngle: 45,
    passPlus: "DLF-02_score_medium", passMinus: "DLF-02_score_medium" };
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

function defaultSect() {
  return { enabled: false, count: 3, axis: "horizontal", heightMM: 12,
    datum: "own", labels: true,
    pass: "DLF-03_score_strong", linePass: "DLF-01_score_light" };
}

function addLayer(dem, name) {
  const k = state.layers.length;
  const c = JSON.parse(JSON.stringify(DEFAULTS.contours));
  // ⚠️ SEEDED ONCE, THEN NEVER TOUCHED AGAIN. The "interval from the relief"
  // checkbox is gone, but the arithmetic that made it worth having is not: one
  // fixed interval cannot serve a 4 m fill patch and a 900 m hillside. At 1 m
  // the patch gives four lines and the hillside gives NINE HUNDRED levels,
  // which `contourLevels` refuses outright above 2,000 — an empty drawing with
  // no obvious cause. So a new raster arrives on a 1-2-5 interval that lands
  // about fourteen lines, and from then on the number in the box is the only
  // thing that decides: typed over, never overwritten.
  c.interval = niceInterval(stats(dem).relief, 14);
  c.style = NEXT_STYLE[k % NEXT_STYLE.length];
  c.indexStyle = c.style;
  c.pass = NEXT_PASS[k % NEXT_PASS.length];
  c.indexPass = k === 0 ? "DLF-03_score_strong" : c.pass;
  if (k > 0) c.labels = false;      // one set of numbers on a sheet, not three
  state.layers.push({ id: state.nextId++, dem, name, on: true, contours: c, mat: defaultMat() });
  state.active = state.layers.length - 1;
  state.selKind = "raster";
  if (k === 0) { state.dem = dem; state.view.ready = false; }
  return state.layers[state.active];
}

const addRasters = wireDrop("dropDEM", "fileDEM", async (files) => {
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
// ── shapefile features ──────────────────────────────────────────────────────
// ⚠️ FEATURES ARE A LIST, LIKE THE RASTERS, AND FOR THE SAME REASON: a site
// carries several of them at once — a path, a bed, a tree survey — and each
// needs its own styling and its own laser pass, or nobody can tell one from
// another on the plate. The controls edit the SELECTED layer and the list says
// which that is, the same grammar the raster list already uses.
const FEATURE_KIND_LABEL = { point: "points", line: "lines", polygon: "areas" };
const FEATURE_KIND_ONE = { point: "point", line: "line", polygon: "area" };
/** "1 area", "3 areas" — a count and its noun agree, or the tool looks careless. */
const counted = (n, kind) => `${n} ${n === 1 ? FEATURE_KIND_ONE[kind] : FEATURE_KIND_LABEL[kind]}`;

/** Fill the pattern pickers once, grouped exactly as the Slicer groups them. */
function fillSymbolPicker() {
  const sel = $("ftSymbol");
  if (!sel) return;
  sel.innerHTML = "";
  for (const key of SYMBOL_ORDER) {
    const o = document.createElement("option");
    o.value = key;
    // ⚠️ THE PICKER SAYS WHICH SYMBOLS CAN CARRY A DIRECTION, because "turn by
    // an attribute" silently does nothing on a circle and a reader would blame
    // the data rather than the shape.
    o.textContent = POINT_SYMBOLS[key].label
      + (POINT_SYMBOLS[key].directional ? "" : "  (no direction)");
    sel.appendChild(o);
  }
}

function fillPatternPickers() {
  const groups = {};
  for (const key of PATTERN_ORDER) {
    const [g, label] = FILL_PATTERNS[key];
    (groups[g] = groups[g] || []).push([key, label]);
  }
  for (const [id, withNone] of [["ftPattern", true], ["ftPointFill", true]]) {
    const sel = $(id);
    if (!sel) continue;
    sel.innerHTML = "";
    if (withNone) {
      const o = document.createElement("option");
      o.value = "none";
      o.textContent = id === "ftPattern" ? "None — outline only" : "Nothing";
      sel.appendChild(o);
    }
    for (const [g, items] of Object.entries(groups)) {
      const grp = document.createElement("optgroup");
      grp.label = g;
      for (const [key, label] of items) {
        const o = document.createElement("option");
        o.value = key; o.textContent = label;
        grp.appendChild(o);
      }
      sel.appendChild(grp);
    }
  }
  const lt = $("ftLinetype");
  if (lt) {
    lt.innerHTML = "";
    for (const key of LINETYPE_ORDER) {
      const o = document.createElement("option");
      o.value = key; o.textContent = FEATURE_LINETYPES[key].label;
      lt.appendChild(o);
    }
  }
}

const activeFeature = () => state.features[state.activeFeature] || null;

/**
 * Fill one attribute picker from the layer's numeric columns.
 *
 * ⚠️ ONLY NUMERIC COLUMNS THAT ACTUALLY HOLD NUMBERS. A species name cannot
 * size a circle, and a numeric column of all nulls is a picker entry that
 * produces an empty drawing — `readDBF` filters both out. If there is no .dbf
 * the list is empty and says so, rather than looking broken.
 */
function fillAttrPicker(id, f, current) {
  const sel = $(id);
  if (!sel) return;
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = !f || !f.rows ? "— no .dbf loaded —"
    : (f.numericFields || []).length ? "— fixed, not by a value —"
    : "— no numeric columns —";
  sel.appendChild(none);
  for (const name of (f && f.numericFields) || []) {
    const o = document.createElement("option");
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  }
  sel.value = current || "";
  if (sel.value !== (current || "")) sel.value = "";
}

/** Suggest the field's own range, so the controls open on something usable. */
function suggestRange(f, field, loId, hiId) {
  if (!f || !f.rows || !field) return;
  const r = fieldRange(f.rows, field);
  if (r.n) { $(loId).value = String(+r.lo.toFixed(3)); $(hiId).value = String(+r.hi.toFixed(3)); }
}


// ── data-defined overrides ──────────────────────────────────────────────────
/** The bindings, and which style key each one drives. */
const BINDINGS = [
  { id: "ftDens", key: "densityBy" },
  { id: "ftSize", key: "sizeBy" },
  { id: "ftRot", key: "rotateBy" },
  { id: "ftWidth", key: "widthBy" },
];

/**
 * Show a binding's state: the tick, the picker, and the range it reveals.
 *
 * ⚠️ THE CHECKBOX IS THE TRUTH, AND THE FIELD FOLLOWS IT. Unticking clears the
 * field rather than merely hiding it — a binding that is invisible but still
 * driving the drawing is the same class of fault as a fold that hides a
 * switched-on halftone. Re-ticking offers the picker again, empty.
 */
function syncBinding(b, f) {
  const on = $(b.id + "On"), sel = $(b.id + "Field"), range = $(b.id + "Range");
  if (!on || !sel) return;
  const bound = on.checked && !!sel.value;
  sel.disabled = !on.checked;
  if (range) range.hidden = !bound;
  const row = on.closest(".bindrow");
  if (row) row.classList.toggle("bound", bound);
  // ⚠️ A LAYER WITH NO .dbf CAN BIND NOTHING, and the control says so rather
  // than offering an empty list that looks broken.
  if (!f || !f.numericFields || !f.numericFields.length) {
    on.disabled = true;
    on.checked = false;
    sel.disabled = true;
    if (range) range.hidden = true;
    if (row) row.classList.remove("bound");
  } else on.disabled = false;
}

for (const b of BINDINGS) {
  const on = $(b.id + "On"), sel = $(b.id + "Field");
  if (!on || !sel) continue;
  on.addEventListener("change", () => {
    if (!on.checked) sel.value = "";
    syncBinding(b, activeFeature());
    gatherFeature(); paintLayers(); recompile();
  });
  sel.addEventListener("input", () => {
    // Picking a field for the first time fills the range from the data itself.
    const f = activeFeature();
    if (f && sel.value) suggestRange(f, sel.value, b.id + "Lo", b.id + "Hi");
    syncBinding(b, f);
    gatherFeature(); paintLayers(); recompile();
  });
}

/**
 * ⚠️ THE CONTROLS A PASS CANNOT USE ARE ABSENT, NOT GREYED. A width on a score
 * pass is a number the machine has nowhere to put; a greyed one invites "why
 * not?", an absent one says the honest thing. Same rule a fill pattern already
 * follows on a line.
 */
function syncPassControls(f) {
  const box = $("ftEngraveOnly");
  if (!box) return;
  const engrave = !!f && f.style.pass === "DLF-00_engrave";
  box.hidden = !engrave || f.kind === "point";
}

/** Push the selected feature layer's style into the controls. */
function syncFeature() {
  const f = activeFeature();
  const box = $("featStyle");
  if (!box) return;
  syncInspector();
  if (!f) { paintSwatches(); return; }
  const st = f.style;
  // ⚠️ THE CONTROLS A GEOMETRY CANNOT USE ARE HIDDEN, NOT DISABLED. A greyed
  // "fill pattern" on a line layer invites the question "why not?"; an absent
  // one says the honest thing, which is that a line has no inside.
  $("ftAreaOnly").hidden = f.kind !== "polygon";
  $("ftPointOnly").hidden = f.kind !== "point";
  $("ftPass").value = st.pass;
  if (f.kind === "polygon") {
    $("ftPattern").value = st.pattern;
    $("ftSpacing").value = String(st.spacingMM);
    $("ftRotation").value = String(st.rotationDeg);
    $("ftOutline").checked = st.outline !== false;
  }
  if (f.kind === "point") {
    $("ftSymbol").value = st.symbol || "circle";
    $("ftRadius").value = String(st.radiusMM);
    $("ftPointFill").value = st.pattern;
    $("ftPointSpacing").value = String(st.spacingMM);
    const sb = st.sizeBy || (st.sizeBy = { ...FEATURE_DEFAULTS.point.sizeBy });
    fillAttrPicker("ftSizeField", f, sb.field);
    $("ftSizeLo").value = String(sb.lo); $("ftSizeHi").value = String(sb.hi);
    $("ftSizeMin").value = String(sb.minMM); $("ftSizeMax").value = String(sb.maxMM);
    $("ftSizeMode").value = sb.mode || "area";
    const rb = st.rotateBy || (st.rotateBy = { ...FEATURE_DEFAULTS.point.rotateBy });
    fillAttrPicker("ftRotField", f, rb.field);
    $("ftRotMode").value = rb.mode || "degrees";
    $("ftRotOffset").value = String(rb.offsetDeg || 0);
  }
  // Density drives a polygon's fill AND a wide line's band fill, so it is not
  // polygon-only any more — and this block is the ONLY one that fills those
  // controls. It replaced a polygon-only copy of itself that ran first and set
  // the same four boxes to the same four values.
  if (f.kind !== "point") {
    const db = st.densityBy || (st.densityBy = { ...FEATURE_DEFAULTS[f.kind].densityBy });
    fillAttrPicker("ftDensField", f, db.field);
    $("ftDensLo").value = String(db.lo); $("ftDensHi").value = String(db.hi);
    $("ftDensMin").value = String(db.minMM); $("ftDensMax").value = String(db.maxMM);
    const wb = st.widthBy || (st.widthBy = { ...FEATURE_DEFAULTS[f.kind].widthBy });
    $("ftWidth").value = String(st.widthMM ?? 0);
    fillAttrPicker("ftWidthField", f, wb.field);
    $("ftWidthLo").value = String(wb.lo); $("ftWidthHi").value = String(wb.hi);
    $("ftWidthMin").value = String(wb.minMM); $("ftWidthMax").value = String(wb.maxMM);
  }
  $("ftLinetype").value = st.linetype;
  $("ftScale").value = String(st.linetypeScale);
  // The tick follows the stored field, so a saved binding comes back ticked.
  for (const b of BINDINGS) {
    const on = $(b.id + "On"), sel = $(b.id + "Field");
    if (on && sel) on.checked = !!(st[b.key] && st[b.key].field);
    syncBinding(b, f);
  }
  syncPassControls(f);
  paintSwatches();
}

/** Read the controls back into the selected feature layer. */
function gatherFeature() {
  const f = activeFeature();
  if (!f) return;
  const st = f.style;
  st.pass = $("ftPass").value;
  st.linetype = $("ftLinetype").value;
  st.linetypeScale = Math.min(10, Math.max(0.2, +$("ftScale").value || 1));
  if (f.kind === "polygon") {
    st.pattern = $("ftPattern").value;
    st.spacingMM = Math.min(20, Math.max(0.3, +$("ftSpacing").value || 2));
    st.rotationDeg = +$("ftRotation").value || 0;
    st.outline = $("ftOutline").checked;
  }
  if (f.kind !== "point") {
    // ⚠️ WIDTH IS READ WHATEVER THE PASS IS, and ignored by the drawing unless
    // the pass is engrave. Clearing it on a pass change would lose the value the
    // moment someone looked at a score pass and came back.
    st.widthMM = Math.max(0, +$("ftWidth").value || 0);
    const wb = st.widthBy || (st.widthBy = { ...FEATURE_DEFAULTS[f.kind].widthBy });
    const prevW = wb.field;
    wb.field = $("ftWidthOn").checked ? ($("ftWidthField").value || null) : null;
    if (wb.field && wb.field !== prevW) suggestRange(f, wb.field, "ftWidthLo", "ftWidthHi");
    wb.lo = +$("ftWidthLo").value || 0;
    wb.hi = +$("ftWidthHi").value || 0;
    wb.minMM = Math.max(0.1, +$("ftWidthMin").value || 0.3);
    wb.maxMM = Math.max(wb.minMM, +$("ftWidthMax").value || 4);
    const db = st.densityBy || (st.densityBy = { ...FEATURE_DEFAULTS[f.kind].densityBy });
    const prevD = db.field;
    db.field = $("ftDensOn").checked ? ($("ftDensField").value || null) : null;
    if (db.field && db.field !== prevD) suggestRange(f, db.field, "ftDensLo", "ftDensHi");
    db.lo = +$("ftDensLo").value || 0;
    db.hi = +$("ftDensHi").value || 0;
    db.minMM = Math.max(0.1, +$("ftDensMin").value || 0.8);
    db.maxMM = Math.max(db.minMM, +$("ftDensMax").value || 5);
  }
  if (f.kind === "point") {
    st.symbol = $("ftSymbol").value;
    st.radiusMM = Math.min(30, Math.max(0.3, +$("ftRadius").value || 2));
    st.pattern = $("ftPointFill").value;
    st.spacingMM = Math.min(10, Math.max(0.2, +$("ftPointSpacing").value || 1));
    const sb = st.sizeBy;
    const prev = sb.field;
    sb.field = $("ftSizeField").value || null;
    // Choosing a field for the first time fills the range from the data, so the
    // controls never open on 0..0 — which would draw every symbol the same size
    // and look like the feature does not work.
    if (sb.field && sb.field !== prev) suggestRange(f, sb.field, "ftSizeLo", "ftSizeHi");
    sb.lo = +$("ftSizeLo").value || 0;
    sb.hi = +$("ftSizeHi").value || 0;
    sb.minMM = Math.max(0.2, +$("ftSizeMin").value || 1.2);
    sb.maxMM = Math.max(sb.minMM, +$("ftSizeMax").value || 5);
    sb.mode = $("ftSizeMode").value;
    const rb = st.rotateBy;
    const prevR = rb.field;
    rb.field = $("ftRotField").value || null;
    if (rb.field && rb.field !== prevR) {
      const r = f.rows ? fieldRange(f.rows, rb.field) : null;
      if (r && r.n) { rb.lo = r.lo; rb.hi = r.hi; }
    }
    rb.mode = $("ftRotMode").value;
    rb.offsetDeg = +$("ftRotOffset").value || 0;
  }
  if (f.kind === "polygon") {
    const db = st.densityBy;
    const prev = db.field;
    db.field = $("ftDensField").value || null;
    if (db.field && db.field !== prev) suggestRange(f, db.field, "ftDensLo", "ftDensHi");
    db.lo = +$("ftDensLo").value || 0;
    db.hi = +$("ftDensHi").value || 0;
    db.minMM = Math.max(0.3, +$("ftDensMin").value || 0.8);
    db.maxMM = Math.max(db.minMM, +$("ftDensMax").value || 5);
  }
}

/** The feature specs the compiler takes. Geometry stays in MAP units here. */
function buildFeatures() {
  // ⚠️ THE LAYER SERVING AS THE TILE BOUNDARY IS NOT ALSO DRAWN. Its outline
  // becomes the outer cut in the clip stage, so drawing it as a feature too
  // would put two coincident lines on the plate — and if its own style is on a
  // cut pass, that is the head cutting the same line twice.
  return state.features
    .filter((f) => f.id !== state.clipFromFeature)
    .map((f) => ({
      kind: f.kind, name: f.name, rings: f.rings, points: f.points,
      rows: f.rows, style: f.style,
    }));
}

/**
 * Offer every imported polygon layer as a possible tile boundary.
 *
 * ⚠️ REBUILT WHENEVER THE LIST CHANGES, and the current choice is preserved by
 * ID rather than by index — layers can be removed from the middle, and an index
 * would silently re-point the clip at a different polygon.
 */
function refreshClipSources() {
  const sel = $("clipFrom");
  if (!sel) return;
  const current = state.clipFromFeature;
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = ""; none.textContent = "— none, the whole model is drawn —";
  sel.appendChild(none);
  for (const f of state.features) {
    if (f.kind !== "polygon") continue;
    const o = document.createElement("option");
    o.value = String(f.id);
    o.textContent = `${f.name} — ${counted(f.count, f.kind)}`;
    sel.appendChild(o);
  }
  if (state.clip && !state.clipFromFeature) {
    const o = document.createElement("option");
    o.value = "dropped"; o.textContent = `${state.clip.name} (dropped here)`;
    sel.appendChild(o);
    sel.value = "dropped";
  } else {
    sel.value = current == null ? "" : String(current);
    if (sel.value !== (current == null ? "" : String(current))) sel.value = "";
  }
}

$("clipFrom").addEventListener("change", () => {
  const v = $("clipFrom").value;
  if (v === "" ) {
    state.clipFromFeature = null; state.clip = null; state.clipOn = false;
    $("clipOn").checked = false;
    $("clipInfo").textContent = "No boundary loaded — the whole model is drawn.";
  } else if (v !== "dropped") {
    const f = state.features.find((q) => String(q.id) === v);
    if (f) {
      state.clipFromFeature = f.id;
      // ⚠️ THE RINGS ARE SHARED, NOT COPIED, and nothing downstream writes to
      // them — the clip reads rings and the feature drawer reads rings. A copy
      // here would double the memory of every boundary for no property gained.
      state.clip = { rings: f.rings, name: f.name };
      state.clipOn = true;
      $("clipOn").checked = true;
      $("clipInfo").innerHTML = `<b>${esc(f.name)}</b> — ${counted(f.count, f.kind)}, `
        + `${f.rings.length} ring${f.rings.length === 1 ? "" : "s"}. Its outline becomes the `
        + `<b>outer cut</b>, and it is no longer drawn as a feature layer.`;
    }
  }
  state.view.ready = false;
  recompile();
});

/**
 * Load shapefiles into a feature layer list.
 *
 * ⚠️ THE ZONE SUGGESTS A KIND; THE FILE DECIDES IT. Each strip is labelled with
 * the geometry it expects, which is what makes the three of them worth having —
 * but a file dropped on the wrong strip is still filed correctly, under its own
 * heading, and told so. Refusing it would be pedantry: the tool can see what the
 * geometry is, so it should use that rather than make the reader try again.
 * @param {string} expected the kind the strip advertises
 * @param {{reveal?:boolean}} [opts] `reveal` when the drop came from a panel
 *   OTHER than the one holding the lists, so the result has to be shown
 */
async function loadFeatureFiles(files, expected, opts = {}) {
  const info = $("featInfo");
  const added = [], notes = [];
  // ⚠️ THE .dbf IS PAIRED BY BASENAME, and it is where every attribute lives.
  // `.shp` holds shapes and nothing else, so a user who drops only the .shp gets
  // geometry with no values to style by — which works, and silently offers an
  // empty attribute picker. Dropping both together is the whole point.
  const byStem = new Map();
  for (const f of files) {
    const stem = f.name.replace(/\.[^.]+$/, "").toLowerCase();
    const ext = (f.name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, {});
    byStem.get(stem)[ext] = f;
  }
  const stems = [...byStem.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  for (const stem of stems) {
    const pair = byStem.get(stem);

    // ⚠️ GML ARRIVES AS ONE FILE AND CAN BECOME SEVERAL LAYERS. It carries its
    // own CRS and its own attributes, so nothing has to be dropped beside it —
    // and unlike a shapefile it may hold points, lines and areas together, which
    // become separate layers here because a fill pattern means nothing on a
    // point and a radius means nothing on an area.
    const gmlFile = pair.gml || pair.xml;
    if (gmlFile && !pair.shp) {
      try {
        const g = readGML(await gmlFile.text(), { name: gmlFile.name });
        for (const n of g.notes) notes.push(`${gmlFile.name}: ${n}`);
        if (!g.layers.length) {
          notes.push(`${gmlFile.name}: no geometry this reader could follow — `
            + `${g.features} feature${g.features === 1 ? "" : "s"} were looked at.`);
          continue;
        }
        // Same CRS check the .prj gets: named, never used to move anything.
        if (g.crs && state.dem?.crs && g.crs !== state.dem.crs) {
          notes.push(`${gmlFile.name} declares ${g.crs}, but the raster is ${state.dem.crs}. `
            + `Reproject it in QGIS — nothing here is moved for you.`);
        }
        for (const L of g.layers) {
          const style = JSON.parse(JSON.stringify(FEATURE_DEFAULTS[L.kind]));
          style.pass = NEXT_PASS[state.features.length % NEXT_PASS.length];
          const label = g.layers.length > 1
            ? `${gmlFile.name.replace(/\.[^.]+$/, "")} (${FEATURE_KIND_LABEL[L.kind]})`
            : gmlFile.name.replace(/\.[^.]+$/, "");
          state.features.push({
            id: state.nextId++, name: label, kind: L.kind,
            rings: L.rings, points: L.points, rows: L.rows,
            numericFields: L.numeric, fieldNames: L.fields,
            count: L.count, style,
          });
          added.push(state.features[state.features.length - 1]);
          if (!L.rows) {
            notes.push(`${label}: no attributes were paired, so there is nothing to style by.`);
          }
        }
        if (expected && g.layers.length === 1 && g.layers[0].kind !== expected) {
          notes.push(`${gmlFile.name} holds ${FEATURE_KIND_LABEL[g.layers[0].kind]}, not `
            + `${FEATURE_KIND_LABEL[expected]} — filed where it belongs.`);
        }
      } catch (e) { notes.push(`${gmlFile.name}: ${e.message}`); }
      continue;
    }

    const file = pair.shp;
    if (!file) {
      notes.push(`${stem}: no .shp or .gml among the files dropped — a shapefile is several `
        + `files sharing a name, and only .shp holds the geometry`);
      continue;
    }
    try {
      const r = readShapefile(await file.arrayBuffer(), { name: file.name });
      // Attributes, if the .dbf came too.
      let rows = null, numericFields = [], fieldNames = [];
      if (pair.dbf) {
        try {
          const t = readDBF(await pair.dbf.arrayBuffer(), { name: pair.dbf.name });
          const shapes = r.kind === "point" ? r.points.length : r.rings.length;
          assertPairs(t.rows, shapes, file.name);
          rows = t.rows;
          numericFields = t.numeric;
          fieldNames = t.fields.map((f) => f.name);
          if (t.deleted) {
            notes.push(`${pair.dbf.name}: ${t.deleted} record${t.deleted === 1 ? " was" : "s were"} `
              + `marked deleted and skipped`);
          }
          for (const n of t.notes) notes.push(`${pair.dbf.name}: ${n}`);
        } catch (e) { notes.push(e.message); }
      } else {
        notes.push(`${file.name}: no .dbf was dropped with it, so there are no attributes to `
          + `style by. Drop the .shp and .dbf together to size or turn symbols by a value. `
          + `(.shx is not needed — this reader walks the records in order.)`);
      }
      // ⚠️ THE .prj IS READ AS A LABEL, AND NOTHING IS REPROJECTED. Knowing both
      // names turns the tool's vaguest failure — "does not overlap the raster,
      // almost always a different CRS" — into a sentence that names the two
      // codes and can be acted on. ⚠️ It is only ever a HINT: a .prj describes
      // the file it came with, and a file can be mislabelled, so a mismatch is
      // reported and never used to move anything.
      if (pair.prj) {
        try {
          const pr = readPRJ(await pair.prj.text());
          const said = pr.epsg || pr.name;
          if (said && state.dem?.crs && pr.epsg && pr.epsg !== state.dem.crs) {
            notes.push(`${pair.prj.name} says this layer is ${pr.epsg}`
              + `${pr.name ? ` (${pr.name})` : ""}, but the raster is ${state.dem.crs}. `
              + `Reproject the layer to ${state.dem.crs} in QGIS — nothing here is moved for you.`);
          } else if (said && !state.dem?.crs) {
            notes.push(`${pair.prj.name} says this layer is ${said}. The raster carries no `
              + `CRS, so the two cannot be checked against each other.`);
          }
        } catch { /* a .prj that will not parse tells us nothing; the overlap test still runs */ }
      }
      const style = JSON.parse(JSON.stringify(FEATURE_DEFAULTS[r.kind]));
      style.pass = NEXT_PASS[state.features.length % NEXT_PASS.length];
      state.features.push({
        id: state.nextId++, name: file.name.replace(/\.[^.]+$/, ""), kind: r.kind,
        rings: r.rings, points: r.points, rows, numericFields, fieldNames,
        count: r.kind === "point" ? r.points.length : r.rings.length,
        style,
      });
      added.push(state.features[state.features.length - 1]);
      if (expected && r.kind !== expected) {
        notes.push(`${file.name} holds ${FEATURE_KIND_LABEL[r.kind]}, not `
          + `${FEATURE_KIND_LABEL[expected]} — filed under ${FEATURE_KIND_LABEL[r.kind]}, `
          + `where it belongs.`);
      }
      for (const n of r.notes) notes.push(`${file.name}: ${n}`);
    } catch (e) { notes.push(`${file.name}: ${e.message}`); }
  }
  // ⚠️ WHAT YOU JUST LOADED IS WHAT THE INSPECTOR SHOWS. Loading a layer and
  // then having to find it to style it is the round trip this whole rearrangement
  // exists to remove.
  if (added.length) {
    state.activeFeature = state.features.indexOf(added[added.length - 1]);
    state.selKind = "feature";
  }
  const parts = added.map((f) => `<b>${esc(f.name)}</b> — ${counted(f.count, f.kind)}.`);
  // ⚠️ A CRS MISMATCH IS THE FAILURE THAT LOOKS LIKE A BROKEN TOOL.
  if (state.dem && added.length) {
    const d = state.dem;
    const x1 = d.originX + d.ncols * d.cell, y0 = d.originY - d.nrows * d.cell;
    for (const f of added) {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      const eat = (x, y) => {
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
        by0 = Math.min(by0, y); by1 = Math.max(by1, y);
      };
      for (const p of f.points) eat(p.x, p.y);
      for (const r of f.rings) for (let i = 0; i < r.pts.length; i += 2) eat(r.pts[i], r.pts[i + 1]);
      if (Number.isFinite(bx0)
        && (bx1 < d.originX || bx0 > x1 || by1 < y0 || by0 > d.originY)) {
        parts.push(`<span style="color:#a8541c">⚠️ ${esc(f.name)} does not overlap the raster `
          + `— almost always a different CRS. Reproject it to `
          + `${esc(d.crs || "the raster's CRS")} in QGIS.</span>`);
      }
    }
  }
  for (const m of notes) parts.push(`<span style="color:#a8541c">${esc(m)}</span>`);
  info.innerHTML = parts.join("<br>") || "None loaded.";
  // ⚠️ BOTH REPORTS SAY THE SAME THING. A warning — a missing .dbf, a CRS that
  // does not overlap — is the whole reason to read the line, and it must not be
  // legible only in the panel the reader is not looking at.
  const impInfo = $("impFeatInfo");
  if (impInfo) impInfo.innerHTML = info.innerHTML;
  syncFeature(); paintFeatureList(); refreshClipSources(); syncWindows(); recompile();
  if (opts.reveal && added.length) {
    const k = added[added.length - 1].kind;
    openTo("featList" + k[0].toUpperCase() + k.slice(1));
  }
}

for (const kind of ["polygon", "line", "point"]) {
  const cap = kind[0].toUpperCase() + kind.slice(1);
  // ⚠️ ONE STRIP PER GEOMETRY, IN IMPORT, AND NOWHERE ELSE. There used to be a
  // second set beside each list in Layers — two ways to do one thing, in two
  // sections, which is the confusion the Layers rearrangement exists to end.
  // Import loads, Layers lists what is loaded, the inspector changes it.
  wireDrop("dropImpFeat" + cap, "fileImpFeat" + cap,
    (files) => loadFeatureFiles(files, kind, { reveal: true }));
}

$("ftRemove").addEventListener("click", () => {
  const gone = activeFeature();
  if (!gone) return;
  // ⚠️ A CLIP POINTING AT A DELETED LAYER WOULD CLIP TO GEOMETRY NOBODY CAN SEE.
  if (gone.id === state.clipFromFeature) {
    state.clipFromFeature = null; state.clip = null; state.clipOn = false;
    $("clipOn").checked = false;
    $("clipInfo").textContent = "The boundary layer was removed — the whole model is drawn.";
  }
  state.features.splice(state.activeFeature, 1);
  state.activeFeature = Math.max(0, Math.min(state.activeFeature, state.features.length - 1));
  // ⚠️ WITH NO FEATURE LEFT THERE IS NOTHING FOR THE INSPECTOR TO SHOW, so it
  // falls back to the raster rather than sitting empty over a loaded drawing.
  if (!state.features.length) state.selKind = "raster";
  syncFeature(); paintFeatureList(); refreshClipSources(); syncWindows(); recompile();
});
for (const id of ["ftPass", "ftPattern", "ftSpacing", "ftRotation", "ftOutline",
  "ftWidth", "ftWidthLo", "ftWidthHi", "ftWidthMin", "ftWidthMax",
  "ftRadius", "ftPointFill", "ftPointSpacing", "ftLinetype", "ftScale",
  "ftSymbol", "ftSizeField", "ftSizeLo", "ftSizeHi", "ftSizeMin", "ftSizeMax",
  "ftSizeMode", "ftRotField", "ftRotMode", "ftRotOffset",
  "ftDensField", "ftDensLo", "ftDensHi", "ftDensMin", "ftDensMax"]) {
  const el = $(id);
  if (el) {
    el.addEventListener("input", () => {
      gatherFeature();
      // ⚠️ CHANGING THE PASS CHANGES WHICH CONTROLS EXIST. Width and tone are
      // engrave-only, so the panel has to answer the moment the pass moves —
      // otherwise a width sits on screen doing nothing on a score pass.
      if (id === "ftPass") syncPassControls(activeFeature());
      // A field choice rewrites the range boxes, so the panel has to catch up.
      if (/Field$/.test(id)) syncFeature();
      paintFeatureList();
      recompile();
    });
  }
}

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
    // ⚠️ THE REFUSAL LIVES HERE, NOT IN THE READER. The reader now serves two
    // callers — this boundary, and drawn features — and only this one requires
    // an area. Points enclose nothing, so a clip built from them would remove
    // the entire drawing.
    if (r.kind === "point") {
      throw new Error(`${shp.name} holds ${r.type} shapes. A clip boundary has to enclose `
        + `an area — points cannot. Load it under Features instead, where points are drawn `
        + `as symbols.`);
    }
    if (r.kind === "line") {
      r.notes.push(`these are polylines, not polygons — each is treated as a CLOSED ring, `
        + `which is right for a boundary drawn as a line and wrong for an open one`);
    }
    state.clip = { rings: r.rings, name: shp.name.replace(/\.[^.]+$/, "") };
    state.clipOn = true;
    state.clipFromFeature = null;          // a dropped boundary is not a drawn layer
    $("clipOn").checked = true;
    refreshClipSources();
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
    state.clip = null; state.clipOn = false; state.clipFromFeature = null;
    $("clipOn").checked = false;
    refreshClipSources();
    info.innerHTML = `<span style="color:#a8541c">${esc(e.message)}</span>`;
  }
  recompile();
});
// ⚠️ THE SIGNPOST OPENS THE SECTION AND SCROLLS TO THE ZONE, rather than just
// naming it. The clip belongs at the END of the workflow — it is the last thing
// that happens to a drawing — but "load a file" is something a reader looks for
// in Import, and Export is closed by default. Marc asked where it was, which is
// the whole argument for this button existing.
/**
 * Open a control, and EVERY fold above it, then land the eye on it.
 *
 * ⚠️ `closest("details")` WAS NOT ENOUGH, and the button built on it did
 * nothing at all. The drop strips sit inside a `details.sub` inside a
 * `details.panel`; `closest` returns the SUB-fold, which is already open, so
 * `open = true` was a no-op and the panel stayed shut. Measured: clicking "Go
 * to the tile boundary in Export" left Export=false and scrolled to an element
 * 1,139 px outside the menu. Every ancestor has to be opened, not the first.
 *
 * @param {string} id the element to reveal
 */
function openTo(id) {
  const el = $(id);
  if (!el) return;
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    if (n.tagName === "DETAILS") n.open = true;
  }
  el.scrollIntoView({ block: "center" });
  // A brief mark, so the eye lands on the right thing in a long panel. Uses the
  // existing dragover style rather than inventing a second highlight.
  el.classList.add("dragover");
  setTimeout(() => el.classList.remove("dragover"), 1200);
}

$("gotoClip").addEventListener("click", () => openTo("dropClip"));
$("gotoFeatures").addEventListener("click", () => {
  // The polygon strip is the top of the three lists, so opening there shows all
  // of them; if a layer is already selected its own list is the better landing.
  const f = activeFeature();
  openTo(f ? "featList" + f.kind[0].toUpperCase() + f.kind.slice(1) : "featListPolygon");
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
  state.clip = null; state.clipOn = false; state.clipFromFeature = null;
  refreshClipSources();
  $("clipOn").checked = false;
  $("clipInfo").textContent = "No boundary loaded — the whole model is drawn.";
  state.view.ready = false;
  recompile();
});

const addPhotos = wireDrop("dropPhotos", "filePhotos", async (files) => {
  if (!files.length || !state.dem) {
    $("photoInfo").textContent = state.dem ? "No files." : "Load the raster first — it decides the grid.";
    return;
  }
  const bufs = [];
  for (const f of files) bufs.push({ name: f.name, buffer: await f.arrayBuffer() });
  const { located, unlocated } = readPhotoSet(bufs);
  const placed = placePhotos(located, state.dem);
  state.photos = placed.points;
  if (state.photos.length) state.selKind = "photos";
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
const addOrthophoto = wireDrop("dropImage", "fileImage", async (files) => {
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
    state.selKind = "image";
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
    $("expResult").textContent = "";
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
    // ⚠️ THE SAME INPUT AS THE PREVIEW, differing only in `forExport` — which is
    // where the licence guard bites. See compileInput: hand-building this object
    // here is what made exports drop the circle grid, the hatching, the sections
    // and the clip.
    const d = compile(compileInput(true));
    const sheets = sheetsIn(d);
    for (const sh of sheets) {
      const suffix = sheets.length > 1 ? `-${sh}` : "";
      save(`${stem()}${suffix}.dxf`, toDXF(d, { sheet: sh }).toString(), "application/dxf");
    }
    if (sheets.length > 1) {
      $("expResult").innerHTML = `<b>${sheets.length} sheets of material</b> — one DXF each: `
        + sheets.map((sh) => esc(`${stem()}-${sh}.dxf`)).join(", ")
        + `. Pin the registration holes before gluing.`;
    }
  } catch (e) {
    $("expResult").innerHTML = `<span style="color:#a8541c">${esc(e.message)}</span>`;
  }
});
// ⚠️ THE TEST SHEET IS NOT COMPILED FROM A RASTER, so it bypasses `compile` and
// builds its own Drawing — but it goes through the SAME dxf writer, the same
// stroke font and the same dash engine. A sheet drawn by separate code would
// measure the sheet rather than the tool.
$("expSVG").addEventListener("click", () => {
  if (!state.drawing) return;
  try {
    // ⚠️ THE SAME INPUT AS THE PREVIEW, like the DXF path — the licence guard
    // must bite on every route out, and every translation must reach every
    // route. See compileInput.
    const d = compile(compileInput(true));
    const sheets = sheetsIn(d);
    for (const sh of sheets) {
      const suffix = sheets.length > 1 ? `-${sh}` : "";
      save(`${stem()}${suffix}.svg`,
        toSVG(d, { title: `${stem()}${suffix}`, sheet: sheets.length > 1 ? sh : undefined }),
        "image/svg+xml");
    }
  } catch (e) {
    $("expResult").innerHTML = `<span style="color:#a8541c">${esc(e.message)}</span>`;
  }
});

/** Describe the image the current settings would make, before making it. */
function rasterNote() {
  const el = $("rasSize");
  const btns = [$("expPNG"), $("expJPG")];
  if (!el) return null;
  // ⚠️ A BUTTON THAT CANNOT WORK MUST NOT LOOK LIKE IT CAN. Marc clicked Save
  // with an oversized sheet and nothing happened: the refusal was printed above
  // the button while the result line is below it, so the one place he was
  // looking said nothing at all. A dead control that still invites a click is
  // worse than an absent one.
  if (!state.drawing) {
    el.textContent = "Load a raster first.";
    for (const b of btns) if (b) b.disabled = true;
    return null;
  }
  const plan = rasterPlan(state.drawing.sheet, {
    dpi: +$("rasDPI").value, strokeMM: +$("rasStroke").value || 0.25,
  });
  const px = `${plan.wPx} × ${plan.hPx} px`;
  const mm = `${Math.round(state.drawing.sheet.width)} × ${Math.round(state.drawing.sheet.height)} mm`;
  el.innerHTML = plan.ok
    ? `<b>${px}</b> — ${mm} at ${plan.dpi} dpi, ${plan.megapixels.toFixed(1)} Mpx.`
      + (plan.widened
        ? `<br><span style="color:#a8541c">Lines widened to ${plan.strokeMM.toFixed(3)} mm: `
          + `below that they are under 1.5 px at this resolution and would engrave faint.</span>`
        : "")
    : `<span style="color:#a8541c">${esc(plan.refusal)}</span>`;
  for (const b of btns) if (b) b.disabled = !plan.ok;
  return plan;
}
for (const id of ["rasDPI", "rasStroke"]) {
  const el = $(id);
  if (el) el.addEventListener("input", rasterNote);
}

/**
 * Encode a canvas, and report failure instead of swallowing it.
 *
 * ⚠️ `toBlob` IS ASYNCHRONOUS AND CAN HAND BACK NULL. On a large canvas a
 * browser may simply decline to encode — no throw, no message, just null. The
 * first version of this called `if (b) save(...)` inside the callback and wrote
 * its "saved" line immediately afterwards, so a failed encode produced a
 * success message and no file. That is the worst shape a bug can take: the tool
 * says it did something it did not do.
 *
 * @param {HTMLCanvasElement} cv @param {string} mime @param {number} quality
 * @returns {Promise<Blob|null>}
 */
function encodeCanvas(cv, mime, quality) {
  return new Promise((resolve) => {
    try { cv.toBlob((b) => resolve(b), mime, quality); }
    catch { resolve(null); }
  });
}

/**
 * Write the drawing as one engraved image, plus the cut lines beside it.
 * @param {"png"|"jpeg"} fmt
 */
async function saveEngraving(fmt) {
  if (!state.dem) return;
  const out = $("expResult");
  try {
    // ⚠️ THE SAME INPUT AS THE PREVIEW. A fourth way out of the tool is a fourth
    // chance to draw something else; it gets the same builder as the other three.
    const d = compile(compileInput(true));
    const plan = rasterPlan(d.sheet, {
      dpi: +$("rasDPI").value, strokeMM: +$("rasStroke").value || 0.25,
    });
    if (!plan.ok) {
      out.innerHTML = `<span style="color:#a8541c">${esc(plan.refusal)}</span>`;
      return;
    }
    // ⚠️ JPEG HAS NO ALPHA. Asking for a transparent JPEG silently gives a black
    // background in some encoders and white in others, so the request is refused
    // here rather than guessed at.
    const transparent = fmt === "png" && $("rasAlpha").checked;
    const mime = fmt === "jpeg" ? "image/jpeg" : "image/png";
    const ext = fmt === "jpeg" ? "jpg" : "png";

    out.innerHTML = `Drawing ${plan.wPx} × ${plan.hPx} px…`;
    const sheets = sheetsIn(d);
    const written = [];
    const failed = [];
    const notes = [];

    for (const sh of sheets) {
      const only = sheets.length > 1 ? sh : undefined;
      const suffix = sheets.length > 1 ? `-${sh}` : "";
      const cv2 = document.createElement("canvas");
      cv2.width = plan.wPx; cv2.height = plan.hPx;
      const c2 = cv2.getContext("2d");
      if (!c2) throw new Error("this browser would not give a 2D canvas to draw the image on");
      paintEngraving(c2, d, plan, { sheet: only, transparent });

      const imgName = `${stem()}${suffix}-engrave-${plan.dpi}dpi.${ext}`;
      // ⚠️ JPEG AT FULL QUALITY, and it is still the wrong file to engrave from:
      // its ringing lands around every line, and here a grey pixel is a power
      // setting, so the artefact is a wobble in the burn rather than a soft edge.
      const blob = await encodeCanvas(cv2, mime, 0.95);
      if (blob) { save(imgName, blob, mime); written.push(imgName); }
      else failed.push(imgName);

      // ⚠️ THE CUT LINES GO OUT AS VECTORS BESIDE IT, ON THE SAME SHEET. The
      // image cannot cut; this is the file that does, and because it is the same
      // Drawing on the same sheet the two align on the bed without moving the
      // material.
      if ($("rasCut").checked) {
        const cut = cutLinesOnly(d, { sheet: only });
        if (cut.paths.length || cut.circles.length) {
          const cutName = `${stem()}${suffix}-cut.svg`;
          save(cutName, toSVG(cut, { title: `${stem()}${suffix} — cut lines`, sheet: only }),
            "image/svg+xml");
          written.push(cutName);
        } else {
          notes.push("no cut passes in this drawing, so no cut SVG was written — everything "
            + "here engraves");
        }
      }
    }

    if (failed.length) {
      notes.push(`the browser would not encode ${failed.join(", ")} at ${plan.wPx} × `
        + `${plan.hPx} px — it declined without an error, which it does when an image is too `
        + `large to hold twice over. A lower resolution will go through.`);
    }
    out.innerHTML = (written.length
      ? `<b>${esc(written.join(", "))}</b><br>${plan.wPx} × ${plan.hPx} px at ${plan.dpi} dpi`
        + (sheets.length > 1 ? `, one set per material sheet` : "") + `.`
        + `<br><span style="color:#a8541c">The image cuts nothing — the outer cut is a dark `
        + `line in it. Cut from the SVG.</span>`
      : `<span style="color:#a8541c">Nothing was written.</span>`)
      + (transparent
        ? `<br><span style="color:#a8541c">⚠️ Transparent background: some laser software `
          + `composites alpha onto BLACK and would engrave the whole plate. Do not send this `
          + `one to the bed.</span>` : "")
      + (fmt === "jpeg"
        ? `<br><span style="color:#a8541c">JPEG is lossy — engrave from the PNG.</span>` : "")
      + (plan.widened
        ? `<br><span style="color:#a8541c">Lines widened to ${plan.strokeMM.toFixed(3)} mm to `
          + `survive rasterising at ${plan.dpi} dpi.</span>` : "")
      + notes.map((n) => `<br><span style="color:#a8541c">${esc(n)}</span>`).join("");
  } catch (e) {
    out.innerHTML = `<span style="color:#a8541c">${esc(e.message)}</span>`;
  }
}

$("expPNG").addEventListener("click", () => saveEngraving("png"));
$("expJPG").addEventListener("click", () => saveEngraving("jpeg"));

// ── the whole window is the front door ──────────────────────────────────────
/**
 * Route files dropped anywhere on the page to the target that wants them.
 *
 * ⚠️ THIS IS WHAT LETS EVERY PANEL START SHUT. The old rule was "every fold
 * that accepts a file opens by default", and it existed because Marc asked
 * three times in one session where to load something. Closing the panels
 * without this would put the only way into the tool inside a fold nobody has
 * opened, in front of a canvas that says "drop an elevation raster to begin"
 * and then ignores the drop.
 *
 * ⚠️ EVERY ROUTING DECISION IS REPORTED. The tool is guessing from a file
 * extension — a GeoTIFF is terrain far more often than it is an orthophoto, but
 * it can be either — and a guess made silently is a guess nobody can correct.
 * The panel it chose is opened, so the answer is on screen next to the file.
 */
const DROP_ROUTES = [
  { test: /\.tiff?$/i, target: "terrain", label: "terrain raster" },
  { test: /\.(shp|dbf|shx|cpg|prj|gml)$/i, target: "features", label: "feature layer" },
  { test: /\.jpe?g$/i, target: "photos", label: "photograph" },
  { test: /\.png$/i, target: "image", label: "orthophoto" },
];

/**
 * ⚠️ `.xml` IS AMBIGUOUS AND IS DECIDED BY LOOKING INSIDE. GML, SLD and QML all
 * ship as .xml, and routing on the extension alone would file a boundary as a
 * line style. Reading the first few hundred characters is cheap and it is the
 * only honest way to tell them apart.
 */
async function routeOfXML(file) {
  try {
    const head = (await file.slice(0, 2048).text()).toLowerCase();
    if (/gml|featurecollection|featuremember/.test(head)) return "features";
  } catch { /* unreadable head; fall through */ }
  return null;
}

(() => {
  const vp = document.getElementById("viewport") || document.body;
  let depth = 0;
  const mark = (on) => document.body.classList.toggle("dropping", on);

  vp.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  vp.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    depth++; mark(true);
  });
  vp.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; mark(false); } });

  vp.addEventListener("drop", async (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    // ⚠️ A DROP ONTO A LABELLED ZONE IS THAT ZONE'S, NOT THIS HANDLER'S. The
    // strips stop the event themselves; this only sees what fell on the ground.
    if (e.defaultPrevented) return;
    e.preventDefault();
    depth = 0; mark(false);
    // ⚠️ A DROP WHILE THE WINDOWS ARE FOLDED HAS TO BRING THEM BACK, or the
    // file loads into chrome nobody can see and the tool looks like it ignored it.
    foldMenu(false);

    /** @type {Record<string, File[]>} */
    const bins = {};
    const unknown = [];
    for (const f of files) {
      let target = DROP_ROUTES.find((r) => r.test.test(f.name))?.target;
      if (!target && /\.xml$/i.test(f.name)) target = await routeOfXML(f);
      if (!target) { unknown.push(f.name); continue; }
      (bins[target] ||= []).push(f);
    }

    const said = [];
    if (bins.terrain) { said.push(`${bins.terrain.length} to Terrain`); await addRasters(bins.terrain); }
    if (bins.features) {
      said.push(`${bins.features.length} to Vector features`);
      await loadFeatureFiles(bins.features, null, { reveal: true });
    }
    if (bins.photos) { said.push(`${bins.photos.length} to Photographs`); await addPhotos(bins.photos); }
    if (bins.image) { said.push(`1 to Orthophoto`); await addOrthophoto(bins.image); }

    if (unknown.length) {
      said.push(`<span style="color:#a8541c">not recognised: ${esc(unknown.join(", "))} — this `
        + `tool takes .tif, .shp, .gml, .jpg and .png</span>`);
    }
    const note = $("dropReport");
    if (note) note.innerHTML = said.length ? `Dropped: ${said.join(" · ")}.` : "";
  });
})();

// ⚠️ THE WAY BACK TO QGIS. The finished line work goes out on the ground, in
// the raster's own coordinates, where it can be opened beside the data it was
// made from and checked against it.
$("expSHP").addEventListener("click", () => {
  if (!state.dem) return;
  try {
    // ⚠️ THE SAME INPUT AS THE PREVIEW, like every other route out. This export
    // was written after the circle grid, the hatching, the sections and the clip
    // — exactly the four that a hand-built input silently dropped last time. See
    // compileInput.
    const d = compile(compileInput(true));
    const out = drawingToShapefiles(d, { stem: stem(), crs: state.dem.crs });
    if (!out.files.length) {
      $("expResult").innerHTML = `<span style="color:#a8541c">Nothing to write — the drawing `
        + `is empty.</span>`;
      return;
    }
    save(`${stem()}-qgis.zip`, zipStore(out.files), "application/zip");
    const b = out.bbox;
    $("expResult").innerHTML = `<b>${esc(stem())}-qgis.zip</b> — ${out.lines} line`
      + `${out.lines === 1 ? "" : "s"}`
      + (out.points ? ` and ${out.points} point${out.points === 1 ? "" : "s"}` : "")
      + `, ${out.files.length} files. `
      + (out.prj ? `Georeferenced <b>${esc(out.crs)}</b> — drop the zip straight onto QGIS.`
        : `No .prj written.`)
      + (b ? `<br>Extent ${b[0].toFixed(1)}, ${b[1].toFixed(1)} → ${b[2].toFixed(1)}, `
        + `${b[3].toFixed(1)}.` : "")
      + out.notes.map((n) => `<br><span style="color:#a8541c">${esc(n)}</span>`).join("");
  } catch (e) {
    $("expResult").innerHTML = `<span style="color:#a8541c">${esc(e.message)}</span>`;
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
  $("expResult").innerHTML = `<b>Material test sheet</b> — ${d.sheet.width} × ${d.sheet.height} mm, `
    + `${d.report.totals.paths} paths. Three files saved: the DXF, an SVG of the same sheet, and the `
    + `procedure to keep with the coupon.` + d.warnings.map((w) => `<br><span style="color:#a8541c">${esc(w)}</span>`).join("");
});

$("expReport").addEventListener("click", () => {
  if (!state.drawing) return;
  save(`${stem()}-report.txt`,
    reportText(state.drawing, { date: new Date().toISOString().slice(0, 10) }), "text/plain");
});

// ── go ──────────────────────────────────────────────────────────────────────
// ⚠️ AFTER every handler above has been attached, and after the pass pickers
// have been given their colour chips — the folds MOVE those nodes, so anything
// that reaches for them by id must have run first.
fillSymbolPicker();
fillPatternPickers();
syncFeature();
paintFeatureList();


resize();
syncLayer();
paintLayers();
syncWindows();

gather();
paintList();
