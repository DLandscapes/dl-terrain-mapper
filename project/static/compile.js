// @ts-check
// THE COMPILER — features and a symbology in, one fabricable drawing out.
//
// This is the abstraction the whole tool is a test of. DL-TerrainSlicer's core
// object is a contour band that becomes a solid layer. This tool's core object
// is a FEATURE PLUS A SYMBOL THAT MAPS TO A LASER OPERATION, and everything
// else — the readers, the tracer, the font, the DXF writer — is service to that
// one idea. If the idea is right, a new feature type is a new `emit` block and
// nothing else moves.
//
// ⚠️ ONE GEOMETRY, TWO OUTPUTS. The preview and the DXF are rendered from the
// SAME Drawing, and neither is allowed to build its own. A preview that draws
// what it thinks the machine will do is a preview that eventually lies, and the
// lie is discovered on material. Everything the user sees on screen is the
// literal content of the file, coloured by pass.
//
// ⚠️ EVERY PATH THAT LEAVES CARRIES A LAYER, AND THE LAYER IS THE OPERATION.
// "Engraved", "scored", "cut" are not adjectives here — they are DLF pass
// layers with power and speed set at the machine. The symbology's job is to
// choose them; nothing downstream may guess.

import { traceContours, niceInterval, clipToRect } from "./contours.js";
import { sheetFor, scaleBar, northPoint } from "./sheet.js";
import { toSheet, labelContours } from "./labels.js";
import { textStrokes, measure, setLettering } from "./stroke-font.js";
import { stats } from "./dem.js";
import { markGeometry, uncertaintyMM } from "./photos.js";
import { vectorHalftone, tripleHalftone, assertExportable, CHANNELS } from "./halftone.js";
import { symbolLegend, symbolField, signedSymbolField, strideFor, hatchCircle } from "./symbols.js";
import { applyStyle, LINE_STYLES, styleLabel } from "./linestyle.js";
import { hachureLines } from "./hachures.js";
import { traceRegions, clipRingToRect } from "./regions.js";
import { hatchField } from "./hatch.js";
import { SOLID_MM, BURN_MM } from "./patterns.js";
import { strokeBand, bandFill } from "./stroke-band.js";
import { cutSections } from "./sections.js";
import { clipDrawing, ringsBBox, pointInRings } from "./clip.js";
import { buildFeature } from "./features.js";
import { DXF } from "./dxf.js";

/** The default symbology — every value the compiler needs, in one place. */
export const DEFAULTS = {
  // ⚠️ MARGIN 0 BY DEFAULT. The sheet outline is then cut exactly on the
  // raster's own extent, which is what a TILED SET needs: Marc's plates abut,
  // so any margin at all becomes a band of blank card between neighbours in the
  // assembled model. A margin is still available and is the right choice for a
  // single presentation sheet — it is just no longer the assumption.
  sheet: { scale: 200, margin: 0, frame: true, scaleBar: true, north: true, title: "",
    lettering: "regular" },
  // ⚠️ ONE OF THESE PER RASTER, NOT ONE PER DRAWING. A sheet routinely carries
  // more than one surface — a DTM under a DSM, or the same ground in two years —
  // and each needs its own interval, its own line style and its own laser pass,
  // or the reader cannot tell which line is which. `DEFAULTS.contours` is the
  // template a newly loaded raster is given.
  contours: {
    enabled: true, interval: 0, indexEvery: 5, minLength: 1.5,
    labels: true, labelEvery: 5, labelIndexOnly: false, labelSize: 2.2,
    labelSpacing: 55, orientation: "horizontal", suffix: "",
    datum: "absolute", datumValue: 0,
    // ⚠️ COLOUR IS NOT DECORATION HERE — IT IS THE MACHINE OPERATION. Choosing
    // "green" for a layer means choosing pass 2, score medium, at whatever power
    // and speed that pass is set to. The picker shows colours because that is
    // how the passes are identified at the machine, not because it is a palette.
    style: "solid", indexStyle: "solid",
    pass: "DLF-02_score_medium", indexPass: "DLF-03_score_strong",
    labelPass: "DLF-01_score_light",
  },
  photos: {
    enabled: true, mark: "circle", size: 3, numbers: true, numberSize: 2.2,
    bearing: true, halo: false, haloMetres: 7,
  },
  halftone: {
    enabled: false, mode: "vector", across: 90, channel: "darkness",
    channels: ["greenness", "brightness", "saturation"],
  },
  legend: true,
};

/** Layer choices, gathered so the mapping is visible in one screenful. */
export const OPERATIONS = {
  contourIntermediate: "DLF-02_score_medium",
  contourIndex: "DLF-03_score_strong",
  contourLabel: "DLF-01_score_light",
  photoMark: "DLF-04_cut_inner",
  photoNumber: "DLF-01_score_light",
  photoBearing: "DLF-02_score_medium",
  photoHalo: "DLF-00_engrave",
  halftone: "DLF-00_engrave",
  halftoneB: "DLF-02_score_medium",
  halftoneC: "DLF-03_score_strong",
  // ⚠️ FURNITURE ENGRAVES, IT DOES NOT SCORE (Marc). A scale bar and a
  // north point are things to READ, not cuts and not score lines that happen
  // to be legible — and engrave is the pass where a filled cell is a filled
  // cell. It also stops the furniture being mistaken for part of the drawing
  // at the machine: it is on a different operation from every line of terrain.
  furniture: "DLF-00_engrave",
  sheetFrame: "DLF-05_cut_outer",
  sheetBounds: "DLF-99_sheet",
};

/**
 * @typedef {object} Drawing
 * @property {{pts:Float64Array|number[], layer:string, closed:boolean}[]} paths
 * @property {{cx:number, cy:number, r:number, layer:string}[]} circles
 * @property {import("./sheet.js").Sheet} sheet
 * @property {object} report
 * @property {string[]} warnings
 */

/**
 * Engraved lettering: each single stroke drawn as the band it covers, filled.
 *
 * ⚠️ THE SINGLE-STROKE FONT IS A SKELETON, NOT A TYPEFACE. It exists because a
 * laser SCORES text as a path, and at a hairline that is all a letter can be.
 * On the engrave pass the head sweeps a field instead, so a letter can have
 * weight — and weight is the whole difference between something that reads as
 * drawn and something that reads as plotted.
 *
 * ⚠️ IT IS STILL NOT THE BRAND FACE. Quattrocento Sans ships with this tool as a
 * .ttf for the interface, and putting its real outlines on a plate needs a
 * TrueType glyph parser — glyf, the quadratic curves, cmap, hmtx. This gives the
 * skeleton weight; it does not give it Quattrocento's shapes.
 */
function addLettering(add, strokes, layer, size) {
  const w = textWeight(size);
  for (const st of strokes) {
    // ⚠️ BELOW THE MERGE DISTANCE THERE IS NOTHING TO BAND, AND THE PLAIN STROKE
    // IS DRAWN INSTEAD. A band narrower than one burn is one burn, so banding it
    // would add an outline half a burn outside the skeleton on each side and
    // DOUBLE the weight the caller asked for. Measured before this test existed:
    // a 2 mm footer asked for 0.30 mm and inked at 0.60 — 30% of cap height,
    // which closes the counters of an 8 and an 0. See textWeight().
    if (w <= 0) { add(st, layer); continue; }
    // ⚠️ A TIGHT MITRE LIMIT: letter apexes bevel rather than spike past the
    // cap line. See strokeBand's miterLimit.
    const band = strokeBand(st, w, false, 1.15);
    if (!band.length) { add(st, layer); continue; }
    for (const r of band) add(r.pts, layer, true);
    for (const q of bandFill(st, w, SOLID_MM, false)) add(q, layer);
  }
}

/**
 * The weight a letterform gets at a given size.
 *
 * ⚠️ PROPORTIONAL, NOT A SETTING. A stroke weight is a fraction of cap height in
 * every typeface ever drawn; fixing it in millimetres would make a 2 mm footer
 * look bold beside a 6 mm title set from the same table. 12% is about a regular
 * weight — Quattrocento Sans, the brand face, sits near it — and it keeps the
 * counters of an 8 and an R open at 2 mm, which a heavier stroke closes.
 *
 * ⚠️ AND THE ANSWER IS THE WEIGHT *ABOVE* THE BURN, NOT THE WEIGHT. A stroke on
 * the engrave pass is already SOLID_MM of ink wide — the head sweeps a spot, not
 * a mathematical line — so the skeleton by itself inks at 0.3 mm and a band is
 * only worth building for whatever is asked for BEYOND that. Returning the full
 * 12% and banding it added the burn on top of itself: 0.38 mm asked for on a
 * 3.2 mm title, 0.68 mm inked, a black weight where a regular was specified.
 *
 * ⚠️ SO AT PLATE SIZES THIS RETURNS ZERO, AND THAT IS THE HONEST FINDING. 12% of
 * cap height only clears a 0.3 mm burn above 2.5 mm caps, and every piece of
 * furniture lettering on a sheet — a 1.6 mm N, a 1.8 mm legend, a 2 mm footer, a
 * 3.2 mm title — is at or under it. **The burn width IS the weight at this size,
 * and giving the skeleton weight cannot change how the lettering reads.** What
 * would is the real face: Quattrocento Sans's own outlines, which needs the
 * TrueType glyph parser. This function is what proves that, rather than asserting
 * it.
 */
const textWeight = (size) => {
  const extra = size * 0.12 - SOLID_MM;
  // ⚠️ AND A BAND NARROWER THAN ONE BURN IS NOT A BAND. At 3.2 mm the extra came
  // to 0.084 mm — a quarter of a burn — and building an outline plus a fill for
  // it put a second burn round the first for a weight the material cannot hold.
  // Weight becomes expressible at 5 mm caps; below that the skeleton is it.
  return extra >= SOLID_MM ? extra : 0;
};

/**
 * How far the INK of a letter reaches beyond its geometry, each side.
 *
 * ⚠️ EXPORTED BECAUSE THE MARGIN TEST HAS TO MEASURE THE SAME THING THE READER
 * DOES. A furniture path is a centreline; what sits on the material is that
 * centreline plus half a burn, plus half the band when there is one. A test that
 * measured the geometry passed while the ink was 0.15 mm nearer the edge than
 * asked, and failed when the ink was finally right.
 */
export const letterInkHalf = (size) => (textWeight(size) + SOLID_MM) / 2;

/**
 * Fill a small closed ring solid, for the furniture's black parts.
 *
 * ⚠️ SMALL AND CONVEX, WHICH IS WHY THIS IS NOT `fillRegion`. A scale-bar cell
 * and half an arrowhead are a few millimetres across; the general fill rotates
 * the region, builds a family, clips it and caps the row count, all of which is
 * machinery these two shapes do not need. Scanlines straight across the ring's
 * own bounding box, clipped by crossings, is exact for a convex shape and is the
 * whole of it.
 *
 * ⚠️ AT SOLID_MM, THE MERGE DISTANCE — one of the coupon's owed numbers. Too
 * wide and a filled cell comes off the machine as stripes.
 */
function solidFill(ring) {
  const out = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    if (ring[i] < x0) x0 = ring[i]; if (ring[i] > x1) x1 = ring[i];
    if (ring[i + 1] < y0) y0 = ring[i + 1]; if (ring[i + 1] > y1) y1 = ring[i + 1];
  }
  const n = ring.length / 2;
  // ⚠️ THE ROWS ARE DISTRIBUTED BETWEEN THE INSETS, NOT STEPPED FROM ONE EDGE.
  // Stepping at SOLID_MM from the bottom leaves whatever the height is not a
  // multiple of hanging off the top, and the ink then overshoots by that much —
  // measured 0.045 mm on a 1.8 mm block, which is nothing until it is a scale
  // bar. Fitting `n` rows between `BURN_MM/2` inside each edge puts the OUTER
  // rows exactly on the boundary once they are stroked, and closes the spacing a
  // little rather than opening it: tighter than the merge distance still merges,
  // wider does not.
  const inset = BURN_MM / 2;
  const span = (y1 - inset) - (y0 + inset);
  const rows = span > 0 ? Math.ceil(span / SOLID_MM) + 1 : 1;
  const step = rows > 1 ? span / (rows - 1) : 0;
  for (let k = 0; k < rows; k++) {
    const y = rows > 1 ? y0 + inset + k * step : (y0 + y1) / 2;
    const xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = ring[i * 2 + 1], yj = ring[j * 2 + 1];
      if ((yi > y) !== (yj > y)) {
        const xi = ring[i * 2], xj = ring[j * 2];
        xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let t = 0; t + 1 < xs.length; t += 2) {
      // ⚠️ INSET BY HALF A BURN AT EACH END TOO, BECAUSE A STROKE HAS WIDTH. A
      // round-ended stroke run to the ring's own edge puts half a burn PAST it —
      // which on a SCALE BAR, the one thing on the sheet a reader measures
      // against, is a bar longer than the number printed beside it.
      const a = xs[t] + inset, b = xs[t + 1] - inset;
      if (b - a > 1e-9) out.push([a, y, b, y]);
      // A span narrower than one burn is already covered by the burn itself —
      // the taper at the point of the north needle. Drawing a zero-length stroke
      // there would be a dwell, and a dwell is a hole.
      else if (xs[t + 1] - xs[t] > 0.05) {
        const mid = (xs[t] + xs[t + 1]) / 2;
        out.push([mid, y, mid + 1e-6, y]);
      }
    }
  }
  return out;
}

/**
 * Compile a drawing.
 *
 * @param {{dem:import("./dem.js").DEM,
 *          photos?:import("./photos.js").PhotoPoint[],
 *          image?:import("./halftone.js").ImageSource|null,
 *          sym?:object, forExport?:boolean}} input
 * @returns {Drawing}
 */
export function compile(input) {
  const sym = merge(DEFAULTS, input.sym || {});
  // ⚠️ ONE RASTER AND MANY ARE THE SAME CALL. `{dem}` is normalised into a
  // single-layer list here, so every caller and every existing test keeps
  // working and the body below only ever has one shape to handle.
  const layers = input.layers && input.layers.length
    ? input.layers
    : [{ dem: input.dem, name: input.dem?.name, contours: sym.contours }];
  const dem = layers[0].dem;
  if (!dem) throw new Error("compile needs at least one raster");
  // ⚠️ THE LETTERING IS SET BEFORE THE FIRST GLYPH AND HOLDS FOR THE WHOLE
  // COMPILE — labels, region numbers, furniture, all of it, one voice. Every
  // style is an affine dress on the same single-stroke skeleton; see
  // stroke-font.js for why a real second typeface is not on offer.
  setLettering(sym.sheet.lettering);
  const warnings = [];
  const paths = [];
  const circles = [];
  // ⚠️ EVERY ENTITY CAN NAME ITS SHEET — the physical piece of material it is
  // cut from. Undefined means "surface", the base board, so nothing that
  // existed before two-material drawings has to change. The writers filter on
  // it; one Drawing, several files, one per sheet of material on the bed.
  // ⚠️ `kind` IS THE TRANSLATION THAT MADE THIS PATH, and it exists because the
  // pass cannot stand in for it. Two translations routinely share a pass — a
  // contour and a section datum are both score-light — so on the way OUT to a
  // shapefile, "which of the eight made this line?" has no answer unless it is
  // recorded here at the moment it is drawn. Same argument as `furniture`: a
  // tag says what a thing IS, a layer only says what the machine does to it.
  // Undefined is honest for anything that never declared one.
  const add = (pts, layer, closed = false, sheet, kind) => {
    if (pts && pts.length >= 4) paths.push({ pts, layer, closed, sheet, kind });
  };
  // ⚠️ SHEET FURNITURE IS TAGGED, NOT INFERRED FROM ITS PASS. The clip stage
  // exempts furniture — a scale bar cut in half is no longer a scale bar — and
  // the obvious way to spot it, "anything on the light-score pass", is WRONG:
  // that pass is also the default for hatching, hachures, labels and section
  // lines. Inferring it exempted an entire 16,000-mark hatch from the clip and
  // the drawing came back barely changed. A tag says what a thing IS; a layer
  // only says what the machine does to it.
  const addFurniture = (pts, layer, closed = false) => {
    if (pts && pts.length >= 4) paths.push({ pts, layer, closed, furniture: true });
  };

  const sheet = sheetFor(dem, { scale: sym.sheet.scale, margin: sym.sheet.margin });
  const s = stats(dem);

  // ── is there a usable clip boundary? decided HERE, before anything is drawn ─
  // ⚠️ THE FRAME DEPENDS ON THIS ANSWER, so it cannot wait until the clip is
  // applied at the end. Skipping the rectangular outline merely because a
  // boundary was SUPPLIED — then refusing that boundary for not overlapping —
  // leaves the plate with NO OUTER CUT AT ALL: a drawing that engraves
  // perfectly and never comes free of the sheet. Found by a test that asserted
  // a refused clip changes nothing, which it then did not.
  let clipRings = null;
  let clipOffTarget = false;
  if (input.clip && input.clip.rings && input.clip.rings.length) {
    const mm = input.clip.rings.map((r) => {
      const p = r.pts;
      const q = new Float64Array(p.length);
      for (let i = 0; i < p.length; i += 2) {
        q[i] = sheet.X(p[i]);
        q[i + 1] = sheet.Y(p[i + 1]);
      }
      return { pts: q, hole: !!r.hole };
    });
    const bb = ringsBBox(mm);
    clipOffTarget = bb.x1 < 0 || bb.x0 > sheet.width || bb.y1 < 0 || bb.y0 > sheet.height;
    if (!clipOffTarget) clipRings = mm;
  }
  const interval = sym.contours.interval > 0
    ? sym.contours.interval
    : niceInterval(s.relief, 14);

  // ── the halftone goes down FIRST ─────────────────────────────────────────
  // ⚠️ ORDER IN THE FILE IS ORDER AT THE MACHINE for front-ends that do not
  // sort by layer, and an engraved field under line work is the right sequence:
  // engrave the ground, then score the lines over it, then cut. Reversed, the
  // engraver's smoke and debris settle across finished score lines.
  let halftoneReport = null;
  if (sym.halftone.enabled && input.image) {
    if (input.forExport) assertExportable(input.image);
    const img = input.image;
    // The image is placed in MAP units, so it lands where the terrain says
    // rather than where the pixels happen to start.
    const put = (sy) => {
      for (const t of sy) {
        const r = sheet.L(t.r);
        if (r > 0.05) circles.push({ cx: sheet.X(t.x), cy: sheet.Y(t.y), r, layer: OPERATIONS.halftone, kind: "halftone" });
      }
    };
    if (sym.halftone.mode === "triple") {
      const t = tripleHalftone(img, { across: sym.halftone.across, channels: sym.halftone.channels });
      const passes = [OPERATIONS.halftone, OPERATIONS.halftoneB, OPERATIONS.halftoneC];
      t.layers.forEach((L, i) => {
        for (const q of L.symbols) {
          const r = sheet.L(q.r);
          if (r > 0.05) circles.push({ cx: sheet.X(q.x), cy: sheet.Y(q.y), r, layer: passes[i], kind: "halftone" });
        }
        if (!L.recommended) {
          warnings.push(`Halftone channel "${L.label}" is a raw sensor band — it engraves `
            + `correctly but a reader cannot recover a landscape quantity from its radius.`);
        }
      });
      halftoneReport = { mode: "triple", marks: t.budget.marks, verdict: t.budget.verdict,
        channels: t.layers.map((L) => L.label) };
      if (!t.budget.ok) warnings.push(`Halftone: ${t.budget.marks} marks — ${t.budget.verdict}.`);
    } else {
      const t = vectorHalftone(img, { across: sym.halftone.across, channel: sym.halftone.channel });
      put(t.symbols);
      const def = CHANNELS[t.channel];
      halftoneReport = { mode: "vector", marks: t.symbols.length, verdict: t.budget.verdict,
        channels: [def ? def.label : t.channel] };
      if (!t.budget.ok) warnings.push(`Halftone: ${t.symbols.length} marks — ${t.budget.verdict}.`);
      if (def && !def.good) {
        warnings.push(`Halftone channel "${def.label}" is a raw sensor band — prefer a derived channel.`);
      }
    }
    if (input.image.licence === "restricted") {
      warnings.push(`The image is licence-restricted: it can be previewed, and export is blocked.`);
    }
  }

  // ── contours, once per raster ────────────────────────────────────────────
  // ⚠️ EVERY LAYER IS DRAWN IN THE SAME MAP FRAME AND CLIPPED TO THE SHEET.
  // The sheet is defined by the FIRST raster — the primary — and the others
  // land wherever their own georeferencing puts them. That is the honest
  // behaviour: a 2 x 2 km context tile dropped beside a 54 m plate does not
  // resize the plate, it simply runs off the edge and is trimmed. Sizing the
  // sheet to the union instead would silently turn a plate into a wall map.
  const contourReports = [];
  for (const layer of layers) {
    const c = { ...DEFAULTS.contours, ...(layer.contours || {}) };
    if (!c.enabled) continue;
    const ls = stats(layer.dem);
    const iv = c.interval > 0 ? c.interval : niceInterval(ls.relief, 14);
    const datumShift = c.datum === "local" ? (c.datumValue || ls.min) : 0;
    const traced = traceContours(layer.dem, iv, {
      indexEvery: c.indexEvery,
      minLength: c.minLength / sheet.mmPerUnit,
    });
    let inMM = traced.map((l) => toSheet(l, sheet));
    // The label reads the datum, the geometry does not move.
    if (datumShift) inMM = inMM.map((l) => ({ ...l, level: l.level - datumShift }));
    let labels = [];
    let placed = 0;
    if (c.labels) {
      const r = labelContours(inMM, {
        interval: iv, every: c.labelEvery, indexOnly: c.labelIndexOnly,
        size: c.labelSize, spacing: c.labelSpacing,
        orientation: c.orientation, suffix: c.suffix,
      });
      inMM = r.lines; labels = r.labels; placed = r.placed;
    }
    // ⚠️ DASH AFTER LABELLING, NEVER BEFORE. The labeller cuts a gap in a line
    // and heals closed rings across their seam; handed a line already broken
    // into 200 dashes it would place a label in a gap that is not there and
    // reason about closedness that no longer exists.
    const emit = (want, style, pass) => {
      const picked = inMM.filter((l) => l.index === want);
      if (!picked.length) return { after: 0, before: 0, verdict: "continuous", shortest: 0 };
      const r = applyStyle(picked, style);
      for (const piece of r.paths) {
        for (const part of clipToSheet(piece, false, sheet)) add(part.pts, pass, false, undefined, "contours");
      }
      return r;
    };
    const mid = emit(false, c.style, c.pass);
    const idx = emit(true, c.indexStyle, c.indexPass);

    // ── hachures: strokes down the fall line, hung off these contours ──────
    // ⚠️ HUNG OFF THE CONTOURS THAT WERE ACTUALLY TRACED, in MAP units, before
    // the sheet transform — so the fall line is sampled in the frame the DEM
    // lives in and no scale factor can creep into a gradient.
    let hachureReport = null;
    if (c.hachures && c.hachures.enabled) {
      const hc = c.hachures;
      const pick = hc.indexOnly ? traced.filter((l) => l.index) : traced;
      const h = hachureLines(layer.dem, pick, {
        spacing: (hc.spacingMM ?? 3) / sheet.mmPerUnit,
        maxLength: (hc.maxMM ?? 2.5) / sheet.mmPerUnit,
        minLength: (hc.minMM ?? 0.9) / sheet.mmPerUnit,
        fixed: !!hc.fixed,
        uphill: !!hc.uphill,
        minSlope: hc.minSlope > 0 ? Math.tan((hc.minSlope * Math.PI) / 180) : 0,
      });
      let drawn = 0;
      for (const t of h.ticks) {
        const mm = Float64Array.of(sheet.X(t[0]), sheet.Y(t[1]), sheet.X(t[2]), sheet.Y(t[3]));
        for (const part of clipToSheet(mm, false, sheet)) { add(part.pts, hc.pass || c.pass, false, undefined, "hachures"); drawn++; }
      }
      hachureReport = { drawn, skipped: h.skipped,
        spacingMM: hc.spacingMM ?? 3, minMM: hc.minMM ?? 0.9, maxMM: hc.maxMM ?? 2.5,
        fixed: !!hc.fixed, uphill: !!hc.uphill, indexOnly: !!hc.indexOnly,
        pass: hc.pass || c.pass,
        loDeg: +((Math.atan(h.loSlope) * 180) / Math.PI).toFixed(1),
        hiDeg: +((Math.atan(h.hiSlope) * 180) / Math.PI).toFixed(1) };
      // ⚠️ EVERY TICK IS A SEPARATE HEAD MOVE. A hachured drawing is the
      // densest thing this tool can emit, and the count must precede the file.
      if (drawn > 6000) {
        warnings.push(`${layer.name || "raster"}: ${drawn} hachures is a very heavy job — `
          + `every tick is a separate head move. Wider spacing, or index contours only.`);
      }
      if (!drawn) {
        warnings.push(`${layer.name || "raster"}: no hachures were drawn — the ground may be `
          + `flatter than the minimum slope, or the contours too short to carry a tick.`);
      }
      if (hc.uphill) {
        warnings.push(`${layer.name || "raster"}: hachures are pointing UPHILL. That is the `
          + `opposite of the convention — a reader will see hollows where there are hills.`);
      }
    }
    for (const st of labels) {
      for (const part of clipToSheet(st, false, sheet)) add(part.pts, c.labelPass, false, undefined, "contour-labels");
    }

    contourReports.push({
      name: layer.name || layer.dem.name || "raster",
      interval: iv, levels: new Set(traced.map((l) => l.level)).size,
      paths: traced.length, points: traced.reduce((a, l) => a + l.pts.length / 2, 0),
      labels: placed,
      datum: datumShift ? `local, ${datumShift.toFixed(2)} m subtracted` : "absolute",
      style: styleLabel(c.style),
      indexStyle: styleLabel(c.indexStyle),
      pass: c.pass, indexPass: c.indexPass,
      hachures: hachureReport,
      drawn: mid.after + idx.after,
      verdict: mid.verdict === "continuous" && idx.verdict === "continuous"
        ? "continuous" : (mid.after + idx.after > 6000 ? "very heavy" : mid.verdict),
    });
    if (!traced.length) {
      warnings.push(`${layer.name || "raster"}: no contours at ${fmt(iv)} m — check the `
        + `interval against the relief.`);
    }
    // ⚠️ THE DASH COUNT IS STATED BEFORE THE FILE IS WRITTEN, NOT AFTER.
    const dashed = mid.after + idx.after;
    if ((c.style !== "solid" || c.indexStyle !== "solid") && dashed > 1500) {
      warnings.push(`${layer.name || "raster"}: a dashed style turned ${traced.length} `
        + `continuous paths into ${dashed} separate marks — ${mid.verdict}.`);
    }
  }
  const contourReport = contourReports.length === 1 ? contourReports[0] : null;

  // ── photographs ──────────────────────────────────────────────────────────
  let photoReport = null;
  const photos = (input.photos || []).filter((p) => p.include);
  if (sym.photos.enabled && photos.length) {
    const halo = sym.photos.halo ? uncertaintyMM(sheet, sym.photos.haloMetres) : 0;
    for (const p of photos) {
      const cx = sheet.X(p.X), cy = sheet.Y(p.Y);
      const g = markGeometry(cx, cy, {
        mark: sym.photos.mark, size: sym.photos.size,
        bearing: sym.photos.bearing && p.meta.direction !== undefined ? p.meta.direction : undefined,
        halo: halo || undefined,
      });
      for (const q of g.paths) add(q, OPERATIONS.photoMark, false, undefined, "photos");
      for (const c of g.circles) {
        circles.push({ cx: c.cx, cy: c.cy, r: c.r,
          layer: halo && Math.abs(c.r - halo) < 1e-9 ? OPERATIONS.photoHalo : OPERATIONS.photoMark, kind: "photos" });
      }
      if (sym.photos.numbers) {
        const off = sym.photos.size * 0.75 + sym.photos.numberSize * 0.4;
        for (const st of textStrokes(String(p.n), {
          x: cx + off, y: cy + off, size: sym.photos.numberSize,
          anchor: "start", baseline: "middle", tracking: 6,
        })) add(st, OPERATIONS.photoNumber, false, undefined, "photos");
      }
    }
    const corrected = photos.filter((p) => p.dx || p.dy).length;
    photoReport = {
      drawn: photos.length, corrected,
      uncertaintyMM: +uncertaintyMM(sheet, sym.photos.haloMetres).toFixed(1),
      withBearing: photos.filter((p) => p.meta.direction !== undefined).length,
    };
    if (corrected < photos.length) {
      warnings.push(`${photos.length - corrected} photograph${photos.length - corrected === 1 ? "" : "s"} `
        + `still sit at the raw GPS position — at 1:${sym.sheet.scale} the fix is worth about `
        + `±${photoReport.uncertaintyMM} mm on this sheet, so check them against the terrain.`);
    }
  }

  // ── regions: one threshold, a second material ────────────────────────────
  // Marc's framing, verbatim: "the second material's outline should come from
  // one threshold — patches that are higher in a certain value than other
  // patches — these values could be the disturbance values." Two constructions,
  // from DESIGN-two-materials.md:
  //
  //   window  — the region is CUT OUT of the surface sheet. A void; the backing
  //             shows through. The honest form of removed ground.
  //   overlay — the region is cut from a SECOND sheet of material and glued on,
  //             standing proud by its thickness. The honest form of added
  //             ground, or of anything that stands above it (an nDSM).
  //
  // ⚠️ THE PIECE CARRIES ITS OWN NUMBER. Each region's mean value is engraved at
  // its deepest cell. On an overlay that lands on the glued piece; on a window
  // it lands on the OFFCUT — deliberately, because the offcut of a cut region
  // is the removed earth, and a dropped piece that says how deep it was is
  // worth keeping. A shape without a quantity is a picture.
  const regionReports = [];
  for (const spec of (input.regions || [])) {
    if (!spec || !spec.dem || !(spec.threshold > 0 || spec.threshold < 0 || spec.threshold === 0)) continue;
    const mode = spec.mode === "window" ? "window" : "overlay";
    const pass = spec.pass || OPERATIONS.photoMark;          // cut inner
    const matSheet = mode === "overlay" ? (spec.sheet || "material") : undefined;
    const t = traceRegions(spec.dem, spec.threshold, { minAreaM2: spec.minAreaM2 ?? 0 });
    const sheetRect = { x0: 0, y0: 0, x1: sheet.width, y1: sheet.height };
    let drawn = 0;
    for (const ring of t.rings) {
      // map units → sheet mm, then clipped CLOSED to the sheet — a region from
      // a raster larger than the primary must not send cuts off the material.
      const mm = new Float64Array(ring.pts.length);
      for (let i = 0; i < ring.pts.length; i += 2) {
        mm[i] = sheet.X(ring.pts[i]);
        mm[i + 1] = sheet.Y(ring.pts[i + 1]);
      }
      const clipped = clipRingToRect(mm, sheetRect);
      if (!clipped) continue;
      if (mode === "overlay") {
        add(clipped, pass, true, matSheet, "regions");
        // ⚠️ THE PLACEMENT GUIDE IS A SCORE ON THE SURFACE, NOT A CUT. The same
        // outline, light, so the piece has a drawn home to be glued into. The
        // pieces are cut at the SAME coordinates they land at, so one pair of
        // registration pins lays the material sheet over the surface and every
        // piece is already above its place.
        if (spec.guide !== false) add(clipped, OPERATIONS.contourLabel, true, undefined, "regions");
      } else {
        add(clipped, pass, true, undefined, "regions");
      }
      drawn++;
    }
    if (spec.labels !== false) {
      const size = spec.labelSize || 2.2;
      for (const g of t.regions) {
        const v = Math.abs(g.mean);
        const text = v >= 10 ? v.toFixed(0) : v.toFixed(1);
        for (const st of textStrokes(text, {
          x: sheet.X(g.labelX), y: sheet.Y(g.labelY), size,
          anchor: "middle", baseline: "middle", tracking: 6,
        })) {
          for (const part of clipToSheet(st, false, sheet)) {
            add(part.pts, OPERATIONS.contourLabel, false, matSheet, "regions");
          }
        }
      }
    }
    regionReports.push({
      name: spec.name || spec.dem.name || "regions",
      mode, threshold: spec.threshold, pass,
      sheet: matSheet || "surface",
      count: t.regions.length, rings: drawn,
      totalAreaM2: +t.totalAreaM2.toFixed(1),
      mean: t.regions.length
        ? +(t.regions.reduce((a, g) => a + g.mean * g.cells, 0)
            / t.regions.reduce((a, g) => a + g.cells, 0)).toFixed(2)
        : 0,
    });
    if (!t.regions.length) {
      warnings.push(`${spec.name || "regions"}: nothing exceeds ${fmt(spec.threshold)} — `
        + `no region to cut. Check the threshold against the values.`);
    }
    if (mode === "window" && t.regions.length) {
      warnings.push(`${spec.name || "regions"}: ${drawn} window ring${drawn === 1 ? "" : "s"} `
        + `CUT THROUGH the surface sheet. Line work inside them leaves with the offcut, and `
        + `each offcut carries its depth — it is the removed earth, worth keeping.`);
    }
  }

  // ── the circle grid: change drawn as a grading plan ──────────────────────
  // Marc's ask, 2026-08-24, near-verbatim: "a grid of circles where the max
  // and min value of the radius can be controlled with a multiplier of the
  // normalised values … differentiated if they were + or −, fill or cut —
  // make visible the changes over the years, like a grading plan."
  //
  // ⚠️ THE SIGN IS THE PASS, AND THE PASS IS THE FORM. Everywhere this tool
  // draws a circle, the engrave pass is a FILLED dot and a score pass is an
  // OPEN ring — preview, SVG and machine agree because that rule lives in the
  // writers, not here. So fill-against-cut needs no new geometry at all:
  // added ground lands on the engrave pass as a solid mark, removed ground on
  // a score pass as a ring, and both are read against one scale because the
  // normalisation runs over |value| once (see signedSymbolField).
  const symbolReports = [];
  for (const spec of (input.symbols || [])) {
    if (!spec || !spec.dem) continue;
    const sd = spec.dem;
    const frame = { nrows: sd.nrows, ncols: sd.ncols, cell: sd.cell,
      originX: sd.originX, originY: sd.originY };
    const stride = Math.max(1, Math.round(spec.stride
      || strideFor(sd.nrows, sd.ncols, spec.across || 40)));
    const minF = spec.minFraction ?? 0.12;
    const maxF = spec.maxFraction ?? 0.9;
    const passPlus = spec.passPlus || OPERATIONS.halftone;              // engrave — filled
    const passMinus = spec.passMinus || OPERATIONS.contourIntermediate; // score — a ring
    // ⚠️ A CIRCLE IS ON THE SHEET OR IT IS NOT DRAWN. A polyline crossing the
    // edge is clipped to the part that fits; a circle entity cannot be — an
    // arc of a value-circle would read as a smaller value. One that would
    // cross the sheet edge is dropped whole, and the report counts the drops.
    // ⚠️ THE FILL IS GEOMETRY, NOT A PASS SETTING (Marc, 2026-08-25). Ground
    // that was ADDED reads as a hatched symbol and ground that was EXCAVATED as
    // a bare ring, and both are drawn that way in the file rather than left to
    // the machine's engrave pass to fill or not. See hatchCircle: "filled" used
    // to be true only on screen.
    const styleOf = (v, dflt) => (["hatched", "outline", "engraved"].includes(v) ? v : dflt);
    const stylePlus = styleOf(spec.stylePlus, "hatched");
    const styleMinus = styleOf(spec.styleMinus, "outline");
    const hatchMM = spec.hatchMM > 0 ? spec.hatchMM : 0.6;
    let dropped = 0, chords = 0;
    const putC = (sy, layer, style) => {
      let n2 = 0;
      for (const q of sy) {
        const cx = sheet.X(q.x), cy = sheet.Y(q.y), r = sheet.L(q.r);
        if (r <= 0.05) continue;
        if (cx - r < 0 || cx + r > sheet.width || cy - r < 0 || cy + r > sheet.height) {
          dropped++; continue;
        }
        circles.push({ cx, cy, r, layer, kind: "symbols" });
        if (style === "hatched") {
          // ⚠️ 0.3 mm minimum chord — the same runt floor the hatch field keeps,
          // and the same guess, waiting on the same coupon.
          for (const c of hatchCircle(cx, cy, r, hatchMM,
            { angleDeg: spec.hatchAngle ?? 45, minLength: 0.3 })) {
            add(c, layer, false, undefined, "symbols");
            chords++;
          }
        }
        n2++;
      }
      return n2;
    };
    let plusN = 0, minusN = 0, lo = 0, hi = 0;
    if (spec.signed !== false) {
      const f = signedSymbolField(sd.z, frame,
        { stride, minFraction: minF, maxFraction: maxF, minAbs: spec.minAbs || 0 });
      plusN = putC(f.plus, passPlus, stylePlus);
      minusN = putC(f.minus, passMinus, styleMinus);
      hi = f.hi;
    } else {
      // Unsigned: one set on the fill pass, the plain lo..hi mapping.
      const st2 = stats(sd);
      lo = st2.min; hi = st2.max;
      plusN = putC(symbolField(sd.z, frame,
        { stride, minFraction: minF, maxFraction: maxF }), passPlus, stylePlus);
    }
    const count = plusN + minusN;
    const fullMM = sheet.L((stride * sd.cell * maxF) / 2);
    const signed = spec.signed !== false;

    // The legend — reference circles at round values, top of the furniture
    // zone at the right, drawn on the FILL pass so they read exactly as the
    // field does. Skipped rather than squeezed when the sheet has no room.
    if (sym.legend && spec.legend !== false && count && hi > lo) {
      const leg = symbolLegend(lo, hi, { stride, cell: sd.cell,
        minFraction: minF, maxFraction: maxF, count: 3 }).filter((e) => e.v !== 0);
      const margin = sym.sheet.margin;
      const rMax = Math.max(...leg.map((e) => sheet.L(e.r)), 0);
      const gap = 6;
      const wAll = leg.reduce((a, e) => a + 2 * sheet.L(e.r) + gap, 0);
      let lx = sheet.width - Math.max(margin, 4) - 12 - wAll;
      const ly = Math.max(margin * 0.25, 3) + rMax;
      if (lx > 4 && ly + rMax < sheet.height) {
        for (const e of leg) {
          const r2 = sheet.L(e.r);
          lx += r2;
          circles.push({ cx: lx, cy: ly, r: r2, layer: passPlus, kind: "symbols" });
          const v2 = Math.abs(e.v);
          for (const st of textStrokes(String(v2 >= 10 ? v2.toFixed(0) : +v2.toFixed(2)), {
            x: lx, y: ly + rMax + 2.6, size: 1.8,
            anchor: "middle", baseline: "middle", tracking: 6,
          })) addFurniture(st, OPERATIONS.furniture);
          lx += r2 + gap;
        }
      }
    }

    symbolReports.push({
      name: spec.name || sd.name || "circle grid",
      signed, count, plus: plusN, minus: minusN, dropped,
      stylePlus, styleMinus: signed ? styleMinus : null, chords, hatchMM,
      hi: +hi.toFixed(2), lo: +lo.toFixed(2),
      spacingM: +(stride * sd.cell).toFixed(2),
      largestMM: +(2 * fullMM).toFixed(1),                     // diameters — the
      smallestMM: +(2 * fullMM * minF).toFixed(1),             // coupon reads Ø
      passPlus, passMinus: signed ? passMinus : null,
    });
    if (!count) {
      warnings.push(`${spec.name || "circle grid"}: no circles — every value is zero, `
        + `unmeasured, or under the ${fmt(spec.minAbs || 0)} dead zone.`);
    }
    // ⚠️ WHAT MUST DIFFER IS WHAT SURVIVES ONTO MATERIAL. The pass alone is a
    // colour on screen and a power setting at the machine; it is not a mark.
    // Two signs on one pass are perfectly readable when one is hatched and the
    // other is a bare ring, and perfectly UNreadable when they are not — so the
    // warning fires on the conjunction, never on the pass alone.
    if (signed && count && passPlus === passMinus && stylePlus === styleMinus) {
      warnings.push(`${spec.name || "circle grid"}: fill and cut share BOTH the same pass and `
        + `the same symbol style — nothing on the material will tell the two directions of `
        + `change apart. Hatch one of them, or move one to another pass.`);
    }
    const cutPass = (p) => p === "DLF-04_cut_inner" || p === "DLF-05_cut_outer";
    if ((plusN && cutPass(passPlus)) || (minusN && cutPass(passMinus))) {
      warnings.push(`${spec.name || "circle grid"}: circles on a CUT pass cut discs out of `
        + `the sheet — ${count} of them. Deliberate perforation is legitimate; anything else `
        + `wants a score or engrave pass.`);
    }
    if (count > 4000) {
      warnings.push(`${spec.name || "circle grid"}: ${count} circles is a heavy job — `
        + `fewer circles across, or a dead zone, brings it down.`);
    }
    // ⚠️ A HATCHED SYMBOL IS MANY MARKS, NOT ONE. The chords are stated
    // separately from the circles because they dominate the job: a field of
    // 1,200 hatched symbols is thousands of extra head moves, and the count has
    // to precede the file like every other count in this tool.
    // ⚠️ WARN WHEN IT IS HEAVY, NOT WHENEVER IT HAPPENS. This used to fire for
    // ANY hatched circle grid, which made it a statement rather than a warning —
    // and a warning that can never not fire trains a reader to ignore the panel
    // that also carries the ones that matter. The stroke count is in the cutting
    // report either way; the warning is for when the count is a problem.
    if (chords > 2000) {
      warnings.push(`${spec.name || "circle grid"}: the hatched symbols add ${chords} fill `
        + `lines at ${fmt(hatchMM)} mm — a hatched circle is many marks, not one. `
        + `Wider fill spacing, or an outline style, brings it down.`);
    }
  }

  // ── hatching: the value as line density ──────────────────────────────────
  // The third translation (Marc, 2026-08-24): contours put the value in a
  // line's POSITION, the circle grid puts it in a symbol's SIZE, a hatch puts
  // it in the DENSITY of ink along parallel scanlines — solid where strong,
  // breaking into dashes as it weakens, bare paper where there is nothing.
  // The natural read for a surface with no meaningful contour: slope, a
  // wetness index, a probability.
  const hatchReports = [];
  for (const spec of (input.hatches || [])) {
    if (!spec || !spec.dem) continue;
    const hd = spec.dem;
    const pass = spec.pass || OPERATIONS.contourLabel;         // score light
    const spacingMM = spec.spacingMM > 0 ? spec.spacingMM : 2;
    const f = hatchField(hd, {
      spacing: spacingMM / sheet.mmPerUnit,
      angleDeg: spec.angleDeg ?? 45,
      invert: !!spec.invert,
      floor: spec.floor,
      // ⚠️ 0.3 mm ON THE SHEET is the runt floor until the coupon says better —
      // the same failure class as the dash-ring runt: a shorter mark is a
      // near-stationary burn.
      minMark: 0.3 / sheet.mmPerUnit,
    });
    let drawn = 0;
    for (const p of f.paths) {
      const mm = Float64Array.of(sheet.X(p[0]), sheet.Y(p[1]), sheet.X(p[2]), sheet.Y(p[3]));
      for (const part of clipToSheet(mm, false, sheet)) { add(part.pts, pass, false, undefined, "hatch"); drawn++; }
    }
    hatchReports.push({
      name: spec.name || hd.name || "hatch",
      marks: drawn, lines: f.lines, spacingMM,
      angle: spec.angleDeg ?? 45, invert: !!spec.invert,
      lo: +f.lo.toFixed(2), hi: +f.hi.toFixed(2), pass,
    });
    if (!drawn) {
      warnings.push(`${spec.name || "hatch"}: no marks — every value is unmeasured, under `
        + `the floor, or the density rounds below the 0.3 mm minimum mark.`);
    }
    if (pass === "DLF-04_cut_inner" || pass === "DLF-05_cut_outer") {
      warnings.push(`${spec.name || "hatch"}: hatching on a CUT pass cuts ${drawn} slits `
        + `through the sheet. Deliberate screening is legitimate; tone wants a score or `
        + `engrave pass.`);
    }
    if (drawn > 6000) {
      warnings.push(`${spec.name || "hatch"}: ${drawn} separate marks is a very heavy job — `
        + `every dash is a pierce. Wider spacing, or a floor, brings it down.`);
    }
  }

  // ── features: shapefiles drawn as points, lines and areas ────────────────
  // ⚠️ CONVERTED HERE, DRAWN THERE. The map-unit -> sheet-mm transform is this
  // file's job and nowhere else's (see sheet.js), so features.js receives
  // millimetres and never learns what a raster is.
  const featureReports = [];
  for (const spec of (input.features || [])) {
    if (!spec) continue;
    const toMM = (x, y) => [sheet.X(x), sheet.Y(y)];
    const mmRings = (spec.rings || []).map((r) => {
      const q = new Float64Array(r.pts.length);
      for (let i = 0; i < r.pts.length; i += 2) {
        const [X, Y] = toMM(r.pts[i], r.pts[i + 1]);
        q[i] = X; q[i + 1] = Y;
      }
      return { pts: q, hole: !!r.hole };
    });
    const mmPoints = (spec.points || []).map((p) => {
      const [X, Y] = toMM(p.x, p.y);
      return { x: X, y: Y };
    });
    const f = buildFeature(
      { kind: spec.kind, rings: mmRings, points: mmPoints, rows: spec.rows,
        style: spec.style, name: spec.name },
      { sheet, tracer: { traceContours }, minLength: 0.3 });
    for (const p of f.paths) {
      // Clipped to the sheet like every other translation - a feature from a
      // shapefile covering more ground than the plate must not send strokes
      // off the material.
      for (const part of clipToSheet(p.pts, p.closed, sheet)) {
        add(part.pts, p.layer, part.closed === true && p.closed, undefined, "features");
      }
    }
    for (const w of f.warnings) warnings.push(w);
    featureReports.push(f.report);
  }

  // ── sections: the ground cut open ────────────────────────────────────────
  // Marc, 2026-08-24: "three sections always running horizontally through the
  // centre of the plate." Three cuts at 0.25 / 0.50 / 0.75 put one exactly on
  // the centre line; the profile is engraved along the cut it was taken from,
  // because a zero margin leaves nowhere to stack it (see sections.js).
  const sectionReports = [];
  for (const spec of (input.sections || [])) {
    if (!spec || !spec.dem) continue;
    const sdem = spec.dem;
    const pass = spec.pass || OPERATIONS.contourIndex;
    const linePass = spec.linePass || OPERATIONS.contourLabel;
    const heightMM = spec.heightMM > 0 ? spec.heightMM : 12;
    const cut = cutSections(sdem, {
      count: spec.count ?? 3,
      axis: spec.axis === "vertical" ? "vertical" : "horizontal",
      datum: spec.datum === "shared" ? "shared" : "own",
      heightUnits: heightMM / sheet.mmPerUnit,
    });
    let drawn = 0, gaps = 0;
    for (const S of cut.sections) {
      // The cut line itself — light, so the profile reads above it and the
      // line stays a datum rather than competing with the ground.
      const ln = Float64Array.of(sheet.X(S.line[0]), sheet.Y(S.line[1]),
                                 sheet.X(S.line[2]), sheet.Y(S.line[3]));
      for (const part of clipToSheet(ln, false, sheet)) add(part.pts, linePass, false, undefined, "sections");
      for (const p of S.profile) {
        const mm = new Float64Array(p.length);
        for (let i = 0; i < p.length; i += 2) {
          mm[i] = sheet.X(p[i]);
          mm[i + 1] = sheet.Y(p[i + 1]);
        }
        for (const part of clipToSheet(mm, false, sheet)) { add(part.pts, pass, false, undefined, "sections"); drawn++; }
      }
      gaps += S.gaps;
      // ⚠️ THE END TICKS NAME THE CUT, A–A′, and they are the reason a section
      // is readable at all: a line across a plan with no name is not a section,
      // it is a scratch. The prime is set as a full stop after the letter —
      // the font has no prime glyph and inventing one as a bare stroke would
      // be a pierce with no travel.
      if (spec.labels !== false) {
        const size = spec.labelSize || 2.4;
        const ends = [[S.line[0], S.line[1], "start"], [S.line[2], S.line[3], "end"]];
        for (const [mx, my, which] of ends) {
          const x0 = sheet.X(mx), y0 = sheet.Y(my);
          const inset = which === "start" ? size * 0.7 : -size * 0.7;
          for (const st of textStrokes(which === "start" ? S.label : S.label + ".", {
            x: x0 + inset, y: y0 + size * 0.9, size,
            anchor: which === "start" ? "start" : "end",
            baseline: "middle", tracking: 6,
          })) {
            for (const part of clipToSheet(st, false, sheet)) add(part.pts, linePass, false, undefined, "sections");
          }
        }
      }
    }
    const exag = cut.sections.length
      ? +(cut.sections.reduce((a, S) => a + S.exaggeration, 0) / cut.sections.length).toFixed(1)
      : 0;
    sectionReports.push({
      name: spec.name || sdem.name || "sections",
      count: cut.sections.length, axis: spec.axis === "vertical" ? "vertical" : "horizontal",
      heightMM, exaggeration: exag, datum: cut.shared ? "shared" : "own",
      paths: drawn, gaps, pass, linePass,
      labels: cut.sections.map((S) => S.label).join(", "),
    });
    // ⚠️ THE EXAGGERATION IS STATED, ALWAYS, AND IN THE RIGHT DIRECTION. A
    // section that does not say how much it stretches the vertical misreports
    // every slope on it. ⚠️ AND A FACTOR BELOW 1 IS NOT AN EXAGGERATION — it
    // is a COMPRESSION, and calling it the other thing would be the drawing
    // lying about which way it distorts. The height that fits a plate at
    // 1:1000 routinely lands under 1, so this is the common case, not an edge.
    if (cut.sections.length) {
      const datumNote = cut.shared
        ? ", on one shared datum so the cuts compare"
        : ", each on its own datum";
      warnings.push(exag >= 1
        ? `${spec.name || "sections"}: ${cut.sections.length} profiles at ${heightMM} mm — `
          + `the vertical is EXAGGERATED about ×${exag}${datumNote}. State it on the drawing.`
        : `${spec.name || "sections"}: ${cut.sections.length} profiles at ${heightMM} mm — the `
          + `vertical is COMPRESSED to about ×${exag}, so every slope reads SHALLOWER than it `
          + `is${datumNote}. Give the profiles more height to exaggerate instead, and state `
          + `the factor on the drawing either way.`);
    }
    // ⚠️ A PROFILE THAT REACHES THE NEXT CUT LINE IS TWO DRAWINGS ON TOP OF
    // EACH OTHER, and on material there is no way to tell whose peak is whose.
    // The gap between adjacent cuts is known here, so say it before the file
    // is written rather than after the plate is engraved.
    if (cut.sections.length > 1) {
      const gapMM = sheet.L(Math.abs(
        (cut.sections[1].atFraction - cut.sections[0].atFraction))
        * (spec.axis === "vertical" ? sdem.ncols : sdem.nrows) * sdem.cell);
      if (heightMM > gapMM) {
        warnings.push(`${spec.name || "sections"}: a ${heightMM} mm profile is taller than the `
          + `${gapMM.toFixed(1)} mm between neighbouring cuts — they will overlap and no reader `
          + `will tell which peak belongs to which line. Fewer cuts, or less height.`);
      }
    }
    if (gaps) {
      warnings.push(`${spec.name || "sections"}: ${gaps} break${gaps === 1 ? "" : "s"} where the `
        + `cut crosses unmeasured ground — the profile stops rather than bridging it.`);
    }
    if (!cut.sections.length) {
      warnings.push(`${spec.name || "sections"}: nothing to cut — the raster holds no `
        + `measured values along these lines.`);
    }
  }

  // ── registration, the moment there is more than one sheet ────────────────
  // ⚠️ TWO SHEETS THAT DO NOT ALIGN ARE TWO SHEETS. Two Ø 2.5 mm holes are cut
  // through EVERY sheet at identical coordinates, for dowel pins. The pair is
  // DELIBERATELY ASYMMETRIC — (6,6) and (W−6, H−10), not opposite corners — so
  // the sheets cannot be pinned together rotated 180° and look plausible.
  const sheetNames = new Set([...paths, ...circles].map((e) => e.sheet || "surface"));
  if (sheetNames.size > 1) {
    const marks = [[6, 6], [sheet.width - 6, sheet.height - 10]];
    for (const name of sheetNames) {
      for (const [mx, my] of marks) {
        circles.push({ cx: mx, cy: my, r: 1.25, layer: OPERATIONS.photoMark,
          sheet: name === "surface" ? undefined : name, kind: "registration" });
      }
    }
    warnings.push(`This drawing spans ${sheetNames.size} sheets of material. Two Ø 2.5 mm `
      + `registration holes are cut through every sheet — pin them with dowels before gluing. `
      + `The pair is asymmetric on purpose: rotated 180°, the holes will not line up.`);
    // Every material sheet gets the same outer outline as the surface, so the
    // boards match, the registration holes sit identically on each, and the
    // stack can also be squared by its edges.
    for (const name of sheetNames) {
      if (name === "surface") continue;
      add([0, 0, sheet.width, 0, sheet.width, sheet.height, 0, sheet.height],
        sym.sheet.frame ? OPERATIONS.sheetFrame : OPERATIONS.sheetBounds, true, name, "frame");
    }
  }

  // ── sheet furniture ──────────────────────────────────────────────────────
  // ⚠️ THE FURNITURE HAS ITS OWN FLOOR, NOT JUST A FRACTION OF THE MARGIN.
  // Every piece used to be positioned as `margin × something`, which is fine
  // until the margin is zero — and then the scale bar, the north point and the
  // footer all collapse onto y = 0, on top of each other and on top of the cut
  // line. The floors below leave a 12 mm sheet placing everything exactly where
  // it did before, and give a 0 mm sheet somewhere to put them.
  const M = sym.sheet.margin;
  // ⚠️ THE FURNITURE FOLLOWS THE CLIP BOUNDARY, NOT THE SHEET (Marc,
  // 2026-08-25). With a tile clipped out of one corner, a scale bar pinned to
  // the sheet's own corner is not merely far away from the drawing — it is
  // OUTSIDE THE OUTER CUT. The boundary is the cut, so anything beyond it is
  // engraved on the offcut: burn time spent on scrap, and a plate that reaches
  // the bench with no scale on it. The furniture is exempt from the clip
  // (a scale bar cut in half is not a scale bar), which is exactly why it has
  // to be PLACED correctly instead of trimmed into place.
  const fbox = clipRings
    ? ringsBBox(clipRings)
    : { x0: 0, y0: 0, x1: sheet.width, y1: sheet.height };
  // ⚠️ AND INSIDE THE BOUNDARY, NOT MERELY INSIDE ITS BOUNDING BOX. A tile
  // boundary is an arbitrary polygon; the corner of its bbox is routinely
  // outside the shape itself — the drawing Marc sent has exactly that geometry.
  // Each piece is tested where it will actually sit and dropped if it misses.
  const fits = (x, y) => !clipRings || pointInRings(x, y, clipRings);
  const fx = fbox.x0 + Math.max(M, 4);             // left edge of the furniture
  const fBar = fbox.y0 + Math.max(M * 0.42, 4);
  // ⚠️ NOT A CONSTANT ANY MORE: the bar's end labels sit between the bar and the
  // footer, so when they are drawn the footer has to move up out of their way.
  // Raised below, from `fBar` and NOT from the bar's placed y — the footer is
  // positioned as `barAt.y + (fText - fBar)`, so this has to stay the nominal
  // offset or a bar that `seek()` moved would drag its caption twice as far.
  let fText = fbox.y0 + Math.max(M * 0.62, 7.4);
  // The end labels: the halftone legend's size.
  //
  // ⚠️ THE TWO GAPS ARE NOT EQUAL, AND THAT IS THE WHOLE POINT. The sibling's bar
  // stands alone, so it can afford an airy gap under its labels; ours has the
  // footer line above it as well. Set both gaps the same and the labels sit
  // exactly between the two, belonging to neither — three evenly spaced rows of
  // text where there should be ONE object with a caption above it. The labels
  // hug the bar; the footer keeps its distance.
  const BAR_LABEL = 1.8, BAR_GAP = 0.6, FOOT_GAP = 1.8;
  const fNorth = fbox.y0 + Math.max(M * 0.25, 3);
  const furnitureDropped = [];

  // ⚠️ ONE CANDIDATE POSITION IS NOT ENOUGH — SEEK INWARD FROM THE CORNER.
  // A tile boundary is an arbitrary polygon and the corner of its bounding box
  // is routinely outside the shape. Tested on a ragged five-sided boundary of
  // Marc's, placing at the corner alone dropped the scale bar, the north point
  // AND the footer, on a tile with plenty of room a few millimetres in. The
  // search steps toward the middle until the whole piece is inside, so a piece
  // is only ever abandoned when the shape genuinely has nowhere to put it.
  const SEEK = [0, 0.04, 0.09, 0.15, 0.22, 0.3, 0.4, 0.5];
  const fw = fbox.x1 - fbox.x0, fh = fbox.y1 - fbox.y0;
  /**
   * @param {number} bx @param {number} by the corner to start from
   * @param {number} sx @param {number} sy which way is "inward", ±1
   * @param {(x:number,y:number)=>boolean} test every point the piece occupies
   */
  const seek = (bx, by, sx, sy, test) => {
    if (!clipRings) return test(bx, by) ? { x: bx, y: by } : null;
    for (const dy of SEEK) {
      for (const dx of SEEK) {
        const x = bx + sx * dx * fw, y = by + sy * dy * fh;
        if (test(x, y)) return { x, y };
      }
    }
    return null;
  };
  // ⚠️ THE TITLE'S GAP FROM THE TOP EQUALS ITS GAP FROM THE LEFT (Marc,
  // 2026-08-24). The baseline sits one cap height below that gap, so the INK —
  // the part the eye measures — starts exactly `fx` from both edges. The old
  // floor of 5 mm from the baseline left the cap 1.8 mm from the top edge next
  // to a 4 mm left gap, and the corner looked pinched.
  const TITLE_SIZE = 3.2;
  // ⚠️ THE GAP IS MEASURED TO THE INK, NOT TO THE BASELINE (Marc, 2026-08-24:
  // the title's gap from the top edge equals its gap from the left). Ink reaches
  // half its width above the cap line, and its width is the band plus the burn
  // the band is drawn with — SOLID_MM is there even when the band is not, which
  // is the case at every size furniture is set in.
  const fTitle = fx + TITLE_SIZE + (textWeight(TITLE_SIZE) + SOLID_MM) / 2;
  // ⚠️ WITH A CLIP BOUNDARY THE RECTANGULAR FRAME IS NOT DRAWN. The tile's own
  // outline becomes the outer cut, added after clipping — a plate cannot have
  // two outer cuts, and the rectangle would slice straight through the shape
  // the boundary exists to define.
  if (!clipRings) {
    add([0, 0, sheet.width, 0, sheet.width, sheet.height, 0, sheet.height],
      sym.sheet.frame ? OPERATIONS.sheetFrame : OPERATIONS.sheetBounds, true, undefined, "frame");
  }
  const foot = [];
  // A horizontal run of ink fits when both ends and the middle are inside — a
  // boundary edge can cut across the span without touching either end.
  const spanFits = (x, y, w) => fits(x, y) && fits(x + w, y) && fits(x + w / 2, y);
  let barAt = null;
  if (sym.sheet.scaleBar) {
    const bar = scaleBar(sheet, { x: fx, y: fBar, target: 45 });
    barAt = seek(fx, fBar, 1, 1, (x, y) => spanFits(x, y, bar.mm));
    if (barAt) {
      const placed = scaleBar(sheet, { x: barAt.x, y: barAt.y, target: 45 });
      for (const p of placed.paths) addFurniture(p, OPERATIONS.furniture);
      // ⚠️ THE FILLED CELLS ARE FILLED WITH GEOMETRY. A closed ring on the
      // engrave pass is an outline until something puts strokes inside it —
      // defect 7 — so each cell is filled like any other area.
      //
      // ⚠️ AND THE FILL IS ALL THERE IS: THE OUTLINE IS NOT DRAWN. Everywhere
      // else in the tool an outline plus a fill is right, because the outline
      // is what keeps an engraved edge crisp. Not here. A stroke on the engrave
      // pass burns SOLID_MM wide centred on its path, so an outline run round
      // the ring puts half a burn OUTSIDE the geometry — and this bar is the one
      // object on the sheet whose dimensions are its content. A 45 mm bar came
      // out 45.3, and the thin half came out 0.9 mm against a 1.8 mm block
      // instead of 0.6, so the 1:3 thickness step that IS the halfway mark read
      // as 1:2. The inset rows fill the rectangle exactly; nothing else is
      // needed and anything else is a lie about a measurement.
      for (const ring of placed.rings) {
        for (const q of solidFill(ring)) addFurniture(q, OPERATIONS.furniture);
      }
      // ⚠️ "0" AT ONE END AND THE LENGTH AT THE OTHER, which is how the sibling's
      // bar is labelled and how an architectural scale bar is read: you count
      // ALONG it from a stated zero. Flush to the bar's own ends, so both labels
      // sit inside the span that was already fitted — nothing new to place.
      //
      // ⚠️ AND THE LENGTH THEN COMES OUT OF THE FOOTER. It used to read
      // "10 M  1:200" two millimetres above the bar; with the bar stating its
      // own length that is the same number printed twice, close enough to read
      // as two different measurements. The footer keeps the RATIO, which the bar
      // cannot show.
      const zero = "0";
      const w0 = measure(zero, { size: BAR_LABEL }).width;
      const wL = measure(placed.label, { size: BAR_LABEL }).width;
      // ⚠️ UNLESS THEY WOULD MEET IN THE MIDDLE. A short bar with a long label —
      // "1000 M" under a 12 mm run — has nowhere to put them, and two labels
      // colliding over their own bar is worse than a caption. Then the length
      // goes back to the footer, where it always fitted.
      const labelled = w0 + wL + BAR_LABEL * 2 <= placed.mm;
      if (labelled) {
        const ly = barAt.y + placed.thick + BAR_GAP;
        addLettering(addFurniture,
          textStrokes(zero, { x: barAt.x, y: ly, size: BAR_LABEL, anchor: "start" }),
          OPERATIONS.furniture, BAR_LABEL);
        addLettering(addFurniture,
          textStrokes(placed.label,
            { x: barAt.x + placed.mm, y: ly, size: BAR_LABEL, anchor: "end" }),
          OPERATIONS.furniture, BAR_LABEL);
        fText = Math.max(fText, fBar + placed.thick + BAR_GAP + BAR_LABEL + FOOT_GAP);
      }
      foot.push(labelled ? `1:${sym.sheet.scale}`
        : `${bar.metres} M  1:${sym.sheet.scale}`);
    } else furnitureDropped.push("the scale bar");
  }
  if (sym.sheet.north) {
    const at = seek(fbox.x1 - Math.max(M, 4), fNorth, -1, 1,
      (x, y) => fits(x - 1.6, y) && fits(x + 1.6, y) && fits(x, y + 7));
    if (at) {
      const np = northPoint({ x: at.x, y: at.y + 3.5, size: 3.5 });
      // The ring is a hairline; the needle and its pivot are filled.
      for (const p of np.paths) addFurniture(p, OPERATIONS.furniture, true);
      for (const ring of np.rings) {
        addFurniture(ring, OPERATIONS.furniture, true);
        for (const q of solidFill(ring)) addFurniture(q, OPERATIONS.furniture);
      }
      // ⚠️ THE N SITS ABOVE THE RING, where a compass card carries it — not
      // inside, where the needle is already using the space.
      addLettering(addFurniture,
        textStrokes("N", { x: at.x, y: np.labelY, size: 1.6, anchor: "middle" }),
        OPERATIONS.furniture, 1.6);
    } else furnitureDropped.push("the north point");
  }
  if (contourReport) foot.push(`CONTOURS ${fmt(interval)} M`);
  if (foot.length) {
    const text = foot.join("   ");
    const w = measure(text, { size: 2, tracking: 8 }).width;
    // ⚠️ THE FOOTER RIDES ABOVE THE BAR IT DESCRIBES. Placed independently the
    // two drift apart, and a "50 M 1:200" caption three centimetres from its
    // own bar is a caption for nothing.
    const from = barAt ? { x: barAt.x, y: barAt.y + (fText - fBar) } : { x: fx, y: fText };
    const at = spanFits(from.x, from.y, w) ? from
      : seek(from.x, from.y, 1, 1, (x, y) => spanFits(x, y, w));
    if (at) {
      addLettering(addFurniture,
        textStrokes(text, { x: at.x, y: at.y, size: 2, tracking: 8 }),
        OPERATIONS.furniture, 2);
    } else furnitureDropped.push("the footer");
  }
  if (sym.sheet.title) {
    const t = String(sym.sheet.title).toUpperCase();
    const w = measure(t, { size: TITLE_SIZE, tracking: 10 }).width;
    const at = seek(fx, fbox.y1 - fTitle, 1, -1, (x, y) => spanFits(x, y, w));
    if (at) {
      addLettering(addFurniture,
        textStrokes(t, { x: at.x, y: at.y, size: TITLE_SIZE, tracking: 10 }),
        OPERATIONS.furniture, TITLE_SIZE);
    } else furnitureDropped.push("the title");
  }

  // ── the legend ───────────────────────────────────────────────────────────
  if (sym.legend && sym.halftone.enabled && halftoneReport) {
    const label = String(halftoneReport.channels[0]).toUpperCase().slice(0, 18);
    const lw = measure(label, { size: 1.8, tracking: 6 }).width;
    const at = seek(fbox.x1 - Math.max(M, 4) - lw, fbox.y0 + Math.max(M * 0.7, 4.5), -1, 1,
      (x, y) => spanFits(x, y, lw));
    if (at) {
      addLettering(addFurniture, textStrokes(label, { x: at.x, y: at.y, size: 1.8,
        tracking: 6, anchor: "start" }), OPERATIONS.furniture, 1.8);
    } else furnitureDropped.push("the halftone legend");
  }

  // ⚠️ SAID PLAINLY RATHER THAN LEFT TO BE DISCOVERED ON MATERIAL. With no
  // margin there is nowhere outside the drawing for the furniture to go, so it
  // is engraved over the terrain. That is a legitimate choice for a plate that
  // will be assembled with others — but it is the user's to make knowingly.
  if (M < 4 && (sym.sheet.scaleBar || sym.sheet.north || sym.sheet.title)) {
    warnings.push(`With a ${fmt(M)} mm margin the scale bar, north point and title are `
      + `engraved over the drawing — there is no margin for them to sit in. Switch them off `
      + `for a plate meant to be assembled, or give the sheet a few millimetres.`);
  }
  if (clipRings) {
    warnings.push(`The scale bar, north point and title are placed inside the clip boundary, `
      + `not at the sheet's corners — beyond the boundary is the offcut, and furniture there `
      + `would be engraved on material that gets cut away.`);
    // ⚠️ A PIECE THAT COULD NOT BE PLACED IS NAMED. Silently dropping it would
    // send a plate to the bench with no scale on it and nothing to say why.
    if (furnitureDropped.length) {
      warnings.push(`${furnitureDropped.join(", ")} could not be placed inside the boundary `
        + `and ${furnitureDropped.length === 1 ? "was" : "were"} left off — the shape has no `
        + `room at that corner. Switch ${furnitureDropped.length === 1 ? "it" : "them"} off `
        + `deliberately, or give the tile a boundary with a straighter edge to sit against.`);
    }
  }

  // ── the clip: cut the tile out of the finished drawing ───────────────────
  // ⚠️ THE LAST STAGE, DELIBERATELY. Everything above was computed over the
  // whole model in one coordinate frame, so no pattern can disagree with
  // itself across a seam; the boundary is a line drawn through a field that
  // already existed. Clipping FIRST and generating after would put every
  // anchoring question back — see the note at the top of clip.js.
  //
  // ⚠️ AND IT HAPPENS INSIDE compile(), NOT AT EXPORT. The preview reads this
  // same Drawing, so a clipped drawing previews clipped. A clip applied on the
  // way out of the writers would make the preview a picture of a file that
  // does not exist, which is the one thing this tool is built not to do.
  let clipReport = null;
  let outPaths = paths, outCircles = circles;
  if (clipOffTarget) {
    // ⚠️ REFUSED, NOT APPLIED. A boundary that misses the drawing clips
    // everything away, and an empty DXF at the machine looks like the tool
    // broke rather than like the wrong file was picked. The rectangular frame
    // was drawn above precisely because this case was decided in advance.
    warnings.push(`${input.clip.name || "the clip boundary"} does not overlap the `
      + `drawing at all — it was IGNORED, and the sheet keeps its own outline. Check it `
      + `is in the same coordinate system as the raster (this drawing is `
      + `${dem.crs || "in the raster's own CRS"}).`);
    clipReport = { name: input.clip.name || "boundary", applied: false,
      reason: "no overlap with the drawing" };
  } else if (clipRings) {
    // The furniture belongs to the plate, not to the ground, so it survives
    // the clip — a scale bar cut in half is no longer a scale bar.
    const r = clipDrawing({ paths, circles }, clipRings,
      { keep: (e) => e.furniture === true });
    outPaths = r.paths;
    outCircles = r.circles;
    const survived = outPaths.length + outCircles.length;
    // ⚠️ THE BOUNDARY IS ALWAYS THE OUTER CUT — it is not the sheet frame and
    // it does not follow the frame's checkbox. Those are two different things
    // and conflating them was a real defect: with the frame off, the tile
    // outline was written to DLF-99_sheet, the layer that is assigned to NO
    // PASS. The plate then engraved perfectly and never came out of the sheet,
    // and nothing on screen said why, because DLF-99 is drawn on screen like
    // any other line. The frame's checkbox governs the RECTANGLE of the sheet;
    // once a tile is clipped, its boundary IS the shape of the part.
    for (const ring of clipRings) {
      if (ring.hole) continue;
      outPaths.push({ pts: ring.pts, layer: OPERATIONS.sheetFrame,
        closed: true, kind: "clip-boundary" });
    }
    clipReport = { name: input.clip.name || "boundary", applied: true,
      rings: clipRings.length, holes: clipRings.filter((q) => q.hole).length,
      droppedPaths: r.droppedPaths, clippedPaths: r.clippedPaths,
      droppedCircles: r.droppedCircles,
      keptPaths: outPaths.length, keptCircles: outCircles.length };
    warnings.push(`Clipped to ${input.clip.name || "the boundary"}: `
      + `${r.droppedPaths} paths fell outside and ${r.clippedPaths} were cut at it; `
      + `${r.droppedCircles} circles were dropped WHOLE, because a clipped circle is `
      + `an arc and an arc reads as a smaller value. The boundary is now the outer cut.`);
    // ⚠️ COUNTED BEFORE THE OUTLINE IS ADDED. Counting after would always find
    // at least one path — the boundary itself — and the drawing would look
    // populated while holding nothing but its own outline.
    if (!survived) {
      warnings.push(`⚠ NOTHING SURVIVED THE CLIP — the file would hold only the boundary `
        + `outline. Check it is over the terrain and in the same CRS.`);
    }
  }
  const paths2 = outPaths, circles2 = outCircles;

  return {
    paths: paths2, circles: circles2, sheet, warnings,
    report: {
      raster: {
        name: dem.name, size: `${dem.ncols} × ${dem.nrows}`, cell: dem.cell,
        crs: dem.crs || "not stated by the file",
        z: Number.isFinite(s.min) ? `${s.min.toFixed(2)} … ${s.max.toFixed(2)}` : "no data",
        measured: s.total ? `${((s.measured / s.total) * 100).toFixed(1)}%` : "0%",
      },
      sheet: {
        scale: `1:${sym.sheet.scale}`,
        size: `${sheet.width.toFixed(1)} × ${sheet.height.toFixed(1)} mm`,
        ground: `${fmt(dem.ncols * dem.cell)} × ${fmt(dem.nrows * dem.cell)} m`,
      },
      contours: contourReport,
      contourLayers: contourReports,
      photos: photoReport,
      halftone: halftoneReport,
      regions: regionReports,
      symbols: symbolReports,
      hatches: hatchReports,
      sections: sectionReports,
      features: featureReports,
      clip: clipReport,
      sheets: [...sheetNames],
      totals: { paths: paths2.length, circles: circles2.length,
        vertices: paths2.reduce((a, p) => a + p.pts.length / 2, 0) },
    },
  };
}

/**
 * Everything of a path that falls on the sheet.
 *
 * ⚠️ NEEDED ONLY BECAUSE LAYERS MAY DISAGREE ABOUT EXTENT. The primary raster
 * defines the sheet; a second one covering more ground would otherwise send
 * line work off the material, where the machine would either refuse the job or
 * — worse on some front-ends — silently translate everything to fit.
 */
function clipToSheet(pts, closed, sheet) {
  const r = { x0: 0, y0: 0, x1: sheet.width, y1: sheet.height };
  let inside = true;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < r.x0 || pts[i] > r.x1 || pts[i + 1] < r.y0 || pts[i + 1] > r.y1) { inside = false; break; }
  }
  if (inside) return [{ pts, closed }];
  return clipToRect(pts, closed, r);
}

/** The sheets a drawing spans, surface first. One DXF is written per sheet. */
export function sheetsIn(drawing) {
  const names = new Set([...drawing.paths, ...drawing.circles].map((e) => e.sheet || "surface"));
  return ["surface", ...[...names].filter((n) => n !== "surface").sort()]
    .filter((n) => names.has(n));
}

/**
 * A compiled drawing as a DXF. The ONLY writer; the preview reads the same object.
 *
 * ⚠️ `sheet` filters to ONE piece of material. A two-material drawing is one
 * Drawing and several files, and an entity is on exactly one of them — the
 * alternative, one file with material told apart by layer, would put two
 * different boards' cuts into one job.
 */
export function toDXF(drawing, o = {}) {
  const want = o.sheet;
  const on = (e) => want === undefined || (e.sheet || "surface") === want;
  const d = new DXF();
  for (const p of drawing.paths) if (on(p)) d.polyline(p.pts, p.layer, { closed: p.closed });
  for (const c of drawing.circles) if (on(c)) d.circle(c.cx, c.cy, c.r, c.layer);
  return d;
}

/** A plain-text cutting report, in the family's house format. */
export function reportText(drawing, extra = {}) {
  const r = drawing.report;
  const L = [
    "DL-TerrainMapper — cutting report",
    extra.date ? `date: ${extra.date}` : "",
    "",
    `raster: ${r.raster.name || "(unnamed)"}  ${r.raster.size} cells @ ${r.raster.cell} units`,
    `        ${r.raster.crs}, z ${r.raster.z}, ${r.raster.measured} of cells measured`,
    `sheet:  ${r.sheet.size} at ${r.sheet.scale}, covering ${r.sheet.ground}`,
    "",
  ];
  for (const c of (r.contourLayers || [])) {
    L.push(`raster "${c.name}": ${c.paths} continuous paths over ${c.levels} levels`
      + ` at ${fmt(c.interval)} m, ${c.points} points`);
    L.push(`          ${c.style === c.indexStyle ? c.style : c.style + " / " + c.indexStyle} on `
      + `${c.pass}${c.indexPass !== c.pass ? " and " + c.indexPass : ""}`);
    // ⚠️ STATED IN THE FILE THE OPERATOR READS AT THE MACHINE, not only on
    // screen. A dashed layer is many separate head moves and the time estimate
    // will not resemble a solid one.
    L.push(`          drawn as ${c.drawn} ${c.verdict === "continuous" ? "continuous paths" : "separate marks — " + c.verdict}`);
    L.push(`          datum ${c.datum}, ${c.labels} labels engraved`);
    if (c.modulation) {
      L.push(`          MODULATED by "${c.modulation.name}": ${c.modulation.period} mm period, `
        + `ink ${c.modulation.minInk}–${c.modulation.maxInk}% over ${c.modulation.lo} … `
        + `${c.modulation.hi}${c.modulation.invert ? " (inverted)" : ""}`);
    }
    if (c.hachures) {
      L.push(`          HACHURES: ${c.hachures.drawn} ticks every ${c.hachures.spacingMM} mm, `
        + `${c.hachures.fixed ? `all ${c.hachures.maxMM} mm`
          : `${c.hachures.minMM}–${c.hachures.maxMM} mm over ${c.hachures.loDeg}–${c.hachures.hiDeg}°`}`
        + `${c.hachures.indexOnly ? ", index contours only" : ""}`);
      L.push(`          ${c.hachures.drawn} separate head moves on ${c.hachures.pass}`
        + `${c.hachures.uphill ? " — ⚠ POINTING UPHILL" : " — pointing downhill"}`);
    }
  }
  if (r.photos) {
    L.push(`photographs: ${r.photos.drawn} drawn, ${r.photos.corrected} moved by hand,`
      + ` ${r.photos.withBearing} carrying a bearing`);
    L.push(`          GPS uncertainty at this scale: about ±${r.photos.uncertaintyMM} mm on the sheet`);
  }
  if (r.halftone) {
    L.push(`halftone: ${r.halftone.mode}, ${r.halftone.marks} marks — ${r.halftone.verdict}`);
    L.push(`          ${r.halftone.channels.join(", ")}`);
  }
  for (const g of (r.regions || [])) {
    L.push(`regions "${g.name}": ${g.count} patch${g.count === 1 ? "" : "es"} above `
      + `${fmt(g.threshold)}, ${g.totalAreaM2} m² in all, mean ${g.mean}`);
    L.push(`          ${g.mode === "window"
      ? "cut as WINDOWS through the surface sheet — the voids are the removed ground"
      : `cut from sheet "${g.sheet}" and glued on — the pieces are the added ground`}`
      + ` (${g.pass})`);
  }
  for (const g of (r.features || [])) {
    L.push(`features "${g.name}": ${g.drawn} ${g.kind}${g.drawn === 1 ? "" : "s"} on ${g.pass}`
      + `${g.dropped ? `, ${g.dropped} off the sheet` : ""}`);
    L.push(`          ${g.style}`
      + `${g.fillStrokes ? ` — ${g.fillStrokes} fill strokes` : ""}`);
  }
  for (const g of (r.symbols || [])) {
    L.push(`circle grid "${g.name}": ${g.count} circles at ${g.spacingM} m spacing, `
      + `Ø ${g.smallestMM}–${g.largestMM} mm`);
    const styleWord = (s) => (s === "hatched" ? "hatched" : s === "outline" ? "outline only"
      : "solid engrave");
    L.push(g.signed
      ? `          fill (+) ${g.plus} ${styleWord(g.stylePlus)} on ${g.passPlus}; `
        + `cut (−) ${g.minus} ${styleWord(g.styleMinus)} on ${g.passMinus}; full scale ±${g.hi}`
      : `          ${g.plus} ${styleWord(g.stylePlus)} on ${g.passPlus}, values ${g.lo} … ${g.hi}`);
    if (g.chords) {
      L.push(`          plus ${g.chords} fill lines at ${g.hatchMM} mm — a hatched circle is `
        + `many marks, not one`);
    }
    if (g.dropped) {
      L.push(`          ${g.dropped} dropped whole at the sheet edge — a clipped circle `
        + `would read as a smaller value`);
    }
  }
  for (const g of (r.hatches || [])) {
    L.push(`hatch "${g.name}": ${g.marks} marks on ${g.lines} lines, ${g.spacingMM} mm `
      + `spacing at ${g.angle}°, values ${g.lo} … ${g.hi}${g.invert ? " (ink on the low values)" : ""}`);
    L.push(`          on ${g.pass} — every dash is a pierce; the count above is the job`);
  }
  for (const g of (r.sections || [])) {
    L.push(`sections "${g.name}": ${g.count} ${g.axis} cuts (${g.labels}), `
      + `${g.paths} profile paths at ${g.heightMM} mm`);
    L.push(`          ⚠ VERTICAL ${g.exaggeration >= 1 ? "EXAGGERATION" : "COMPRESSION"} `
      + `ABOUT ×${g.exaggeration}, `
      + `${g.datum === "shared" ? "one shared datum" : "each on its own datum"}`
      + ` — state it on the drawing`);
    L.push(`          profiles on ${g.pass}, cut lines and letters on ${g.linePass}`);
  }
  if (r.clip) {
    L.push(r.clip.applied
      ? `clipped to "${r.clip.name}": ${r.clip.rings} ring${r.clip.rings === 1 ? "" : "s"}`
        + `${r.clip.holes ? ` (${r.clip.holes} of them holes)` : ""}, `
        + `${r.clip.droppedPaths} paths dropped, ${r.clip.clippedPaths} cut at the boundary, `
        + `${r.clip.droppedCircles} circles dropped whole`
      : `⚠ CLIP NOT APPLIED — "${r.clip.name}": ${r.clip.reason}`);
    if (r.clip.applied) {
      L.push(`          the boundary IS the outer cut; the rectangular frame is not drawn`);
    }
  }
  if (r.sheets && r.sheets.length > 1) {
    L.push("", `⚠ THIS DRAWING SPANS ${r.sheets.length} SHEETS OF MATERIAL: `
      + r.sheets.map((s2) => (s2 === "surface" ? "surface (the base board)" : `"${s2}"`)).join(", "));
    L.push(`  One DXF per sheet. Pin the registration holes with dowels before gluing;`);
    L.push(`  the pair is asymmetric, so a 180° mistake will not line up.`);
  }
  L.push("", `totals: ${r.totals.paths} paths, ${r.totals.circles} circles,`
    + ` ${r.totals.vertices} vertices`, "",
    "laser passes (per DXF layer, cut outlines LAST):",
    "  0  DLF-00_engrave       black    engraved fields and halftone",
    "  1  DLF-01_score_light   blue     labels, numbers, sheet furniture",
    "  2  DLF-02_score_medium  green    intermediate contours, bearings",
    "  3  DLF-03_score_strong  cyan     index contours",
    "  4  DLF-04_cut_inner     magenta  photograph marks",
    "  5  DLF-05_cut_outer     red      sheet outline — run last",
    "  (DLF-99_sheet is a boundary only — do not cut)",
    "",
    "⚠ the layer scheme matches DL-TerrainSlicer, so an existing laser",
    "  pass configuration can be reused without being rebuilt.");
  if (drawing.warnings.length) {
    L.push("", "notes:");
    for (const w of drawing.warnings) L.push(`  · ${w}`);
  }
  return L.filter((x) => x !== "").join("\n") + "\n";
}

/** Shallow-merge one level deep, so callers can override a single field. */
function merge(base, over) {
  const out = {};
  for (const k of Object.keys(base)) {
    out[k] = (base[k] && typeof base[k] === "object" && !Array.isArray(base[k]))
      ? { ...base[k], ...(over[k] || {}) }
      : (over[k] !== undefined ? over[k] : base[k]);
  }
  for (const k of Object.keys(over)) if (!(k in out)) out[k] = over[k];
  return out;
}

const fmt = (v) => (Number.isFinite(v) ? String(+v.toFixed(3)) : "—");
