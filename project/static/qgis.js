// @ts-check
// A QGIS STYLE, TRANSLATED INTO LASER OPERATIONS.
//
// This is the workflow the concept document called the strongest one available:
// a student styles the contours in QGIS, where they already know the controls,
// saves the style, and hands it over. It is worth being precise about what that
// can and cannot mean.
//
// ⚠️ THIS IS A TRANSLATION, NOT A LOAD, AND THE TWO VOCABULARIES DO NOT MATCH.
// A QGIS style describes INK: this colour, this many millimetres wide, dashed
// like so. This tool's symbology describes MACHINE OPERATIONS: which pass, at
// whatever power and speed that pass is configured to. Some of it carries over
// exactly — a dash pattern is a dash pattern. Some of it cannot: line width in
// QGIS is how wide the ink is, and here the weight of a line is a property of
// the pass, not of the geometry. So every import returns a DECISION LOG, and
// anything that could not be carried across is said out loud rather than
// dropped quietly.
//
// ⚠️⚠️ COLOUR IS THE DANGEROUS ONE. In QGIS red means "draw this red". In the
// DLF scheme red is DLF-05_cut_outer — the pass that CUTS THROUGH THE
// MATERIAL, last. A style that renders contours in red, mapped naively by
// nearest colour, would turn every contour into a cut line and reduce the model
// to a heap of rings. So cut passes are NOT candidates unless the caller asks
// for them, and when the true nearest colour was a cut pass the log says so and
// names the score pass it used instead. This is the one place in the tool where
// being clever would destroy someone's material.

import { DLF_LAYERS } from "./dxf.js";
import { parseXML, find, findAll, readProps } from "./xml.js";
import { LINE_STYLES } from "./linestyle.js";

/** The passes that cut through. Never chosen by a colour match on their own. */
export const CUT_PASSES = ["DLF-04_cut_inner", "DLF-05_cut_outer"];

/** QGIS's own line-style names, and the nearest thing this tool draws. */
const STYLE_MAP = {
  solid: "solid",
  dash: "dashed",
  dot: "dotted",
  "dash dot": "dash_dot",
  "dash dot dot": "dash_dot_dot",
  no: null,                     // "no pen" — the layer is not drawn at all
};

const PT_TO_MM = 25.4 / 72;

/** "35,35,35,255,rgb:0.13,..." or "#1f78b4" → [r,g,b,a]. */
function parseColour(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s[0] === "#") {
    const h = s.slice(1);
    const w = h.length >= 6 ? 2 : 1;
    const at = (k) => parseInt(h.slice(k * w, k * w + w).padEnd(2, h[k * w] || "0"), 16);
    return [at(0), at(1), at(2), 255];
  }
  // ⚠️ ONLY THE LEADING INTEGERS. QGIS 3.30+ appends a second, float
  // representation to the same attribute — "35,35,35,255,rgb:0.137,0.137,…" —
  // and splitting on commas without stopping gives nonsense for alpha.
  const parts = s.split(",");
  const nums = [];
  for (const p of parts) {
    const t = p.trim();
    if (!/^-?\d+(\.\d+)?$/.test(t)) break;
    nums.push(Number(t));
  }
  if (nums.length < 3) return null;
  return [nums[0], nums[1], nums[2], nums.length > 3 ? nums[3] : 255];
}

/** Millimetres, from a value and QGIS's unit name. */
function toMM(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  switch ((unit || "MM").trim()) {
    case "MM": case "RenderMetersInMapUnits": return v;
    case "Point": return v * PT_TO_MM;
    case "Pixel": return v * 25.4 / 96;
    case "Inch": return v * 25.4;
    // MapUnit depends on the layer's CRS and the current scale; it cannot be
    // resolved from the style file alone, so it is refused rather than guessed.
    default: return null;
  }
}

/**
 * @typedef {object} QGISLine
 * @property {number[]|null} colour  [r,g,b,a]
 * @property {number|null} widthMM
 * @property {string|null} qgisStyle the QGIS name, e.g. "dash"
 * @property {number[]|null} customDash millimetres, when the style is custom
 * @property {string} [label] the class this symbol belongs to, if any
 */

/**
 * @typedef {object} QGISStyle
 * @property {"QML"|"SLD"} format
 * @property {string} version
 * @property {string} renderer
 * @property {string|null} attribute the field a categorised style splits on
 * @property {QGISLine[]} lines
 * @property {{enabled:boolean, sizeMM:number|null, field:string|null}} labels
 * @property {string[]} notes what was seen but not carried
 */

/**
 * Read a .qml or .sld into one shape.
 * @param {string} text @returns {QGISStyle}
 */
export function readQGISStyle(text) {
  const root = parseXML(text);
  if (!root || !root.name) throw new Error("not an XML document");
  const isSLD = root.name === "StyledLayerDescriptor" || !!find(root, "LineSymbolizer");
  return isSLD ? readSLD(root) : readQML(root);
}

function readQML(root) {
  if (root.name !== "qgis") {
    throw new Error(`expected a QGIS style file — the root element is <${root.name}>`);
  }
  const notes = [];
  const renderer = find(root, "renderer-v2");
  const rType = renderer?.attrs.type || "unknown";
  const attribute = renderer?.attrs.attr || null;

  // Labels for each symbol, when the renderer has classes.
  /** @type {Record<string,string>} */
  const symbolLabels = {};
  for (const c of findAll(root, "category")) {
    if (c.attrs.symbol !== undefined) symbolLabels[c.attrs.symbol] = c.attrs.label || c.attrs.value || "";
  }
  for (const r of findAll(root, "range")) {
    if (r.attrs.symbol !== undefined) {
      symbolLabels[r.attrs.symbol] = r.attrs.label || `${r.attrs.lower}–${r.attrs.upper}`;
    }
  }

  /** @type {QGISLine[]} */
  const lines = [];
  for (const sym of findAll(root, "symbol")) {
    if (sym.attrs.type && sym.attrs.type !== "line") {
      notes.push(`symbol "${sym.attrs.name}" is a ${sym.attrs.type} symbol, not a line — skipped`);
      continue;
    }
    for (const layer of findAll(sym, "layer")) {
      const cls = layer.attrs.class || "";
      if (cls && cls !== "SimpleLine") {
        // MarkerLine, HashLine, ArrowLine and friends are real symbology and
        // genuinely cannot become a contour's own line style.
        notes.push(`"${cls}" symbol layer cannot be translated — only SimpleLine carries across`);
        continue;
      }
      const p = readProps(layer);
      const useCustom = p.use_custom_dash === "1";
      let customDash = null;
      if (useCustom && p.customdash) {
        const unit = p.customdash_unit || "MM";
        const vals = p.customdash.split(";").map((v) => toMM(v, unit)).filter((v) => v !== null && v > 0);
        if (vals.length >= 2) customDash = vals;
        else notes.push(`a custom dash pattern "${p.customdash}" could not be read in ${unit}`);
      }
      lines.push({
        colour: parseColour(p.line_color),
        widthMM: toMM(p.line_width, p.line_width_unit),
        qgisStyle: p.line_style || "solid",
        customDash,
        label: symbolLabels[sym.attrs.name] || undefined,
      });
      if (p.offset && Number(p.offset) !== 0) {
        notes.push(`the symbol is offset by ${p.offset} — offsets are not applied`);
      }
    }
  }

  // Labels
  const labelsEnabled = root.attrs.labelsEnabled === "1" || !!find(root, "labeling");
  const ts = find(root, "text-style");
  const sizeMM = ts ? toMM(ts.attrs.fontSize, ts.attrs.fontSizeUnit || "Point") : null;
  const field = ts?.attrs.fieldName || null;
  if (ts && ts.attrs.fontFamily) {
    notes.push(`the label font "${ts.attrs.fontFamily}" is replaced by the tool's `
      + `single-stroke font — an outline font engraves as its outline, not its skeleton`);
  }
  if (find(root, "rules")) {
    notes.push("rule-based rendering was found; only the symbols it contains were read, "
      + "not the rules that choose between them");
  }

  return {
    format: "QML", version: root.attrs.version || "",
    renderer: rType, attribute, lines,
    labels: { enabled: labelsEnabled, sizeMM, field },
    notes,
  };
}

function readSLD(root) {
  const notes = [];
  /** @type {QGISLine[]} */
  const lines = [];
  for (const sym of findAll(root, "LineSymbolizer")) {
    const stroke = find(sym, "Stroke");
    if (!stroke) continue;
    /** @type {Record<string,string>} */
    const p = {};
    for (const sp of [...findAll(stroke, "SvgParameter"), ...findAll(stroke, "CssParameter")]) {
      if (sp.attrs.name) p[sp.attrs.name] = sp.text;
    }
    let customDash = null;
    if (p["stroke-dasharray"]) {
      const vals = p["stroke-dasharray"].trim().split(/[\s,]+/).map(Number).filter((v) => v > 0);
      if (vals.length >= 2) customDash = vals;
    }
    lines.push({
      colour: parseColour(p.stroke),
      widthMM: p["stroke-width"] ? Number(p["stroke-width"]) : null,
      qgisStyle: customDash ? "custom" : "solid",
      customDash,
    });
  }
  const ts = find(root, "TextSymbolizer");
  let sizeMM = null;
  if (ts) {
    for (const sp of [...findAll(ts, "SvgParameter"), ...findAll(ts, "CssParameter")]) {
      if (sp.attrs.name === "font-size") sizeMM = toMM(sp.text, "Point");
    }
    notes.push("an SLD states label size in points; it has been converted to millimetres");
  }
  return {
    format: "SLD", version: root.attrs.version || "",
    renderer: "sld", attribute: null, lines,
    labels: { enabled: !!ts, sizeMM, field: null },
    notes,
  };
}

// ── translation ────────────────────────────────────────────────────────────

/** Squared distance in RGB. Crude, and honest about being crude. */
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * The pass whose declared colour is nearest, and what that cost.
 *
 * @param {number[]} rgb
 * @param {{allowCut?:boolean}} [o]
 * @returns {{pass:string, exact:boolean, distance:number, blockedCut:string|null}}
 */
export function nearestPass(rgb, o = {}) {
  const candidates = DLF_LAYERS.filter(([name]) => o.allowCut || !CUT_PASSES.includes(name));
  let best = candidates[0], bestD = Infinity;
  for (const c of candidates) {
    const d = dist2(rgb, c[2]);
    if (d < bestD) { bestD = d; best = c; }
  }
  // Was the true nearest a cut pass we refused to consider?
  let blockedCut = null;
  if (!o.allowCut) {
    let all = DLF_LAYERS[0], allD = Infinity;
    for (const c of DLF_LAYERS) { const d = dist2(rgb, c[2]); if (d < allD) { allD = d; all = c; } }
    if (CUT_PASSES.includes(all[0])) blockedCut = all[0];
  }
  return { pass: best[0], exact: bestD === 0, distance: Math.sqrt(bestD), blockedCut };
}

/**
 * Turn a style into a patch for one layer's contour settings.
 *
 * @param {QGISStyle} style
 * @param {{symbolIndex?:number, allowCut?:boolean, applyLabels?:boolean}} [o]
 * @returns {{patch:object, decisions:string[], warnings:string[], used:QGISLine|null}}
 */
export function translateToContours(style, o = {}) {
  const decisions = [];
  const warnings = [];
  /** @type {any} */
  const patch = {};
  const idx = o.symbolIndex ?? 0;
  const line = style.lines[idx] || null;

  if (!style.lines.length) {
    // ⚠️ THE SPECIFIC REASON MUST SURVIVE THE EARLY RETURN. "No line symbol was
    // found" is true and useless; "a MarkerLine cannot be translated" tells the
    // user what to change in QGIS. The notes were appended at the end of this
    // function, so the one path that most needed them threw them away.
    for (const n of style.notes) warnings.push(n);
    warnings.push(style.notes.length
      ? "so there was no plain line symbol left to apply"
      : "no line symbol was found in this style — nothing to apply");
    return { patch, decisions, warnings, used: null };
  }
  if (style.lines.length > 1) {
    decisions.push(`the style holds ${style.lines.length} line symbols`
      + (style.attribute ? ` (a ${style.renderer} on "${style.attribute}")` : "")
      + `; symbol ${idx + 1}${line.label ? ` — "${line.label}"` : ""} was applied. `
      + `This tool draws two contour classes, intermediate and index, so a style with `
      + `many classes cannot map straight across.`);
  }

  // ── the dash pattern, which carries across exactly ──────────────────────
  if (line.customDash && line.customDash.length >= 2) {
    patch.style = "custom";
    patch.customDash = line.customDash;
    patch.indexStyle = "custom";
    patch.indexCustomDash = line.customDash;
    decisions.push(`custom dash ${line.customDash.map((v) => +v.toFixed(2)).join(" / ")} mm `
      + `taken exactly as QGIS states it`);
  } else {
    const mapped = STYLE_MAP[(line.qgisStyle || "solid").toLowerCase()];
    if (mapped === null) {
      patch.enabled = false;
      warnings.push(`the style sets "no pen" — the layer would draw nothing, so contours were `
        + `switched off for it`);
    } else if (mapped) {
      patch.style = mapped;
      patch.indexStyle = mapped;
      decisions.push(`line style "${line.qgisStyle}" → ${LINE_STYLES[mapped].label}`);
    } else {
      patch.style = "solid";
      patch.indexStyle = "solid";
      warnings.push(`line style "${line.qgisStyle}" is not one this tool draws — solid was used`);
    }
  }

  // ── the colour, which does not ──────────────────────────────────────────
  if (line.colour) {
    const m = nearestPass(line.colour, { allowCut: o.allowCut });
    patch.pass = m.pass;
    patch.indexPass = m.pass;
    const rgb = `rgb(${line.colour.slice(0, 3).join(", ")})`;
    if (m.exact) {
      decisions.push(`colour ${rgb} is exactly ${m.pass}`);
    } else {
      decisions.push(`colour ${rgb} → nearest pass ${m.pass} (off by ${m.distance.toFixed(0)} of 441)`);
    }
    if (m.blockedCut) {
      // ⚠️ THE WHOLE POINT OF THIS MODULE'S CAUTION, IN ONE LINE.
      warnings.push(`the nearest pass by colour was ${m.blockedCut}, which CUTS THROUGH the `
        + `material — a red contour in QGIS means "draw it red", not "cut here". ${m.pass} was `
        + `used instead. Choose the cut pass by hand if you really want the line cut.`);
    }
    if (line.colour[3] !== undefined && line.colour[3] < 255) {
      warnings.push(`the symbol is ${Math.round(line.colour[3] / 255 * 100)}% opaque — a laser `
        + `has no opacity, so the line is cut at the pass's full power`);
    }
  }

  // ── width, which is a pass property here ────────────────────────────────
  if (line.widthMM) {
    decisions.push(`line width ${line.widthMM.toFixed(2)} mm is noted but not applied — on a `
      + `laser the weight of a line is the power and speed of its pass, not the geometry`);
  }

  // ── labels ──────────────────────────────────────────────────────────────
  if (o.applyLabels !== false && style.labels.enabled) {
    patch.labels = true;
    if (style.labels.sizeMM && style.labels.sizeMM > 0.5) {
      patch.labelSize = +style.labels.sizeMM.toFixed(2);
      decisions.push(`labels on, ${patch.labelSize} mm cap height`
        + (style.labels.field ? ` from "${style.labels.field}"` : ""));
    } else {
      decisions.push("labels on");
    }
  } else if (o.applyLabels !== false && style.lines.length) {
    patch.labels = false;
    decisions.push("the style has no labelling, so contour labels were switched off");
  }

  for (const n of style.notes) warnings.push(n);
  return { patch, decisions, warnings, used: line };
}
