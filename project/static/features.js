// @ts-check
// FEATURES — shapefiles drawn, not just used as a boundary.
//
// A survey of trees is POINTS, a path is a LINE, a planting bed is a POLYGON.
// This module turns each into laser strokes with the same styling vocabulary
// DL-TerrainSlicer offers, so a drawing hatched in one tool and then the other
// comes out the same.
//
// ⚠️ THE THREE GEOMETRY KINDS GET GENUINELY DIFFERENT STYLING, not one set of
// controls with parts greyed out. A polygon has an inside, so it takes a FILL
// pattern and an optional outline. A line has neither, so it takes a LINETYPE.
// A point has no extent at all, so it takes a RADIUS first — the symbol is
// invented, and how big it is, is the decision.
//
// ⚠️ EVERYTHING HERE IS ALREADY IN SHEET MILLIMETRES. The compiler converts
// from map units before calling in, the same way it does for every other
// translation, so nothing in this file knows about rasters or scales.

import { fillRegion } from "./patterns.js";
import { strokeBand, bandFill } from "./stroke-band.js";
import { dashPath } from "./linestyle.js";

/**
 * Linetype run-lengths in mm, multiplied by the layer's scale.
 *
 * ⚠️ THESE ARE THE SLICER'S NUMBERS, NOT THIS TOOL'S `LINE_STYLES`. The two
 * tables disagree, and the Slicer's are the ones MEASURED ON MATERIAL: its
 * source records that a dot is 0.4 mm because "0.1 mm burns were invisible on
 * cardboard AND in the preview". `linestyle.js` here uses 0.25 mm for a dot,
 * which is below that measured floor.
 *
 * ⚠️ SO THIS TABLE IS DELIBERATELY SEPARATE AND MUST NOT BE MERGED INTO
 * `LINE_STYLES` without a decision: merging would silently restyle every
 * existing contour drawing. It is on the list of floors the material coupon
 * settles — see the session record.
 */
export const FEATURE_LINETYPES = {
  solid: { label: "Solid", pattern: null },
  dashed: { label: "Dashed", pattern: [3.0, 1.5] },
  dotted: { label: "Dotted", pattern: [0.4, 1.1] },
  dashdot: { label: "Dash-dot", pattern: [3.0, 1.1, 0.4, 1.1] },
  dashdotdot: { label: "Dash-dot-dot", pattern: [3.0, 1.1, 0.4, 1.1, 0.4, 1.1] },
};

export const LINETYPE_ORDER = ["solid", "dashed", "dotted", "dashdot", "dashdotdot"];

/** The Slicer's own defaults, per geometry kind. */
export const FEATURE_DEFAULTS = {
  polygon: { pattern: "lines", spacingMM: 2.0, rotationDeg: 45, outline: true,
    linetype: "solid", linetypeScale: 1, pass: "DLF-02_score_medium",
    // ⚠️ DENSITY, NOT SPACING, IS WHAT A READER SEES. A HIGH value must give a
    // TIGHTER fill, so the mapping is inverted on purpose: hi -> minMM.
    densityBy: { field: null, lo: 0, hi: 0, minMM: 0.8, maxMM: 5 },
    // Engrave only: the outline drawn as a band of this width. See widthOf().
    widthMM: 0, widthBy: { field: null, lo: 0, hi: 0, minMM: 0.3, maxMM: 3 } },
  line: { linetype: "dashed", linetypeScale: 1, pass: "DLF-02_score_medium",
    pattern: "solid", spacingMM: 0.3, rotationDeg: 0,
    densityBy: { field: null, lo: 0, hi: 0, minMM: 0.3, maxMM: 3 },
    widthMM: 0, widthBy: { field: null, lo: 0, hi: 0, minMM: 0.3, maxMM: 4 } },
  point: { radiusMM: 2.0, linetype: "solid", linetypeScale: 1,
    pattern: "none", spacingMM: 1.0, pass: "DLF-02_score_medium",
    symbol: "circle",
    // Data-driven overrides. `field: null` means "use the fixed value above" —
    // the whole feature is opt-in and a layer with no .dbf behaves exactly as
    // it did before attributes existed.
    sizeBy: { field: null, lo: 0, hi: 0, minMM: 1.2, maxMM: 5, mode: "area" },
    rotateBy: { field: null, lo: 0, hi: 0, mode: "degrees", offsetDeg: 0 } },
};

/** The pass a width is meaningful on. Everywhere else, weight IS the pass. */
export const ENGRAVE_PASS = "DLF-00_engrave";

/**
 * Does this style draw wide bands rather than lines?
 *
 * ⚠️ ONLY ON THE ENGRAVE PASS, AND ONLY THERE ON PURPOSE. A score or a cut is a
 * path the head follows once; its weight is the power and speed configured for
 * that pass, and a "width" on it would be a number the machine has nowhere to
 * put. Engrave is the one raster operation — the head sweeps a field — so a
 * width there is a real, makeable thing.
 */
export const widthOf = (st) =>
  (st.pass === ENGRAVE_PASS && st.widthMM > 0) ? st.widthMM : 0;

/** A circle as a closed polyline. Points become symbols; symbols are drawn. */
function circlePath(cx, cy, r, segments = 24) {
  const p = new Float64Array(segments * 2);
  for (let k = 0; k < segments; k++) {
    const a = (2 * Math.PI * k) / segments;
    p[k * 2] = cx + r * Math.cos(a);
    p[k * 2 + 1] = cy + r * Math.sin(a);
  }
  return p;
}

/**
 * The point symbols. Each returns flat polylines for a symbol of radius `r`
 * centred at (cx,cy) and turned by `rot` radians.
 *
 * ⚠️ ROTATION IS BUILT IN, NOT BOLTED ON, because for several of these it is
 * the whole point: an arrow or a triangle carries a DIRECTION, and a direction
 * that cannot be driven by an attribute is decoration. A circle ignores it, as
 * it must — turning a circle is a null operation and pretending otherwise would
 * invite someone to map aspect onto one and see nothing.
 */
export const POINT_SYMBOLS = {
  circle: { label: "Circle", directional: false },
  square: { label: "Square", directional: true },
  triangle: { label: "Triangle", directional: true },
  diamond: { label: "Diamond", directional: true },
  cross: { label: "Cross", directional: true },
  star: { label: "Star", directional: true },
  arrow: { label: "Arrow", directional: true },
};
export const SYMBOL_ORDER = Object.keys(POINT_SYMBOLS);

/** @param {string} kind @param {number} cx @param {number} cy @param {number} r
 *  @param {number} rot radians @returns {number[][]} */
export function symbolPaths(kind, cx, cy, r, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (dx, dy) => [cx + dx * c - dy * s, cy + dx * s + dy * c];
  const poly = (pts, close = true) => {
    const out = [];
    for (const [dx, dy] of pts) out.push(...P(dx, dy));
    if (close) out.push(...P(pts[0][0], pts[0][1]));
    return out;
  };
  switch (kind) {
    case "square": {
      // ⚠️ INSCRIBED IN THE RADIUS, like every other symbol here. Built with
      // half-side r, its CORNERS sit at r*sqrt(2) — so a square read 41% larger
      // than a circle of the same nominal radius, and switching symbol type
      // silently resized a whole layer. Every symbol now has its extreme
      // vertices at exactly r, which is what makes "size by an attribute"
      // comparable across shapes.
      const h = r / Math.SQRT2;
      return [poly([[-h, -h], [h, -h], [h, h], [-h, h]])];
    }
    case "triangle": {
      // Point-up at rot 0, so a bearing of 0 reads as north.
      const a = [];
      for (let k = 0; k < 3; k++) {
        const th = Math.PI / 2 + (2 * Math.PI * k) / 3;
        a.push([r * Math.cos(th), r * Math.sin(th)]);
      }
      return [poly(a)];
    }
    case "diamond":
      return [poly([[0, r], [r, 0], [0, -r], [-r, 0]])];
    case "cross":
      return [poly([[-r, 0], [r, 0]], false), poly([[0, -r], [0, r]], false)];
    case "star": {
      const a = [];
      for (let k = 0; k < 10; k++) {
        const th = Math.PI / 2 + (Math.PI * k) / 5;
        const rr = k % 2 ? r * 0.42 : r;
        a.push([rr * Math.cos(th), rr * Math.sin(th)]);
      }
      return [poly(a)];
    }
    case "arrow":
      // A shaft with an open head — reads as a direction at small sizes, which
      // a filled triangle does not.
      return [
        poly([[0, -r], [0, r]], false),
        poly([[-r * 0.45, r * 0.45], [0, r], [r * 0.45, r * 0.45]], false),
      ];
    default: {
      const a = [];
      const n = 24;
      for (let k = 0; k < n; k++) {
        const th = (2 * Math.PI * k) / n;
        a.push([r * Math.cos(th), r * Math.sin(th)]);
      }
      return [poly(a)];
    }
  }
}

/**
 * Map an attribute value onto a size.
 *
 * ⚠️ AREA-PROPORTIONAL BY DEFAULT (Marc, 2026-08-26), and this is a real
 * cartographic decision rather than a preference. A circle of twice the radius
 * covers FOUR times the paper, and a reader judges quantity by the ink they
 * see — so scaling the radius linearly with the value makes every large value
 * look several times larger than it is. Interpolating the AREA and taking the
 * root keeps the ink honest.
 *
 * ⚠️ THE MAPPING IS RANGE-BASED, NOT ZERO-ANCHORED. `lo` maps to the smallest
 * symbol and `hi` to the largest, which is what makes a range of tree girths
 * legible. For TRUE proportionality — where a value of zero is a symbol of
 * nothing — set `lo` to 0 deliberately.
 *
 * @param {number} v @param {number} lo @param {number} hi
 * @param {number} outLo @param {number} outHi
 * @param {"area"|"linear"} mode
 */
export function scaleValue(v, lo, hi, outLo, outHi, mode = "area") {
  const span = hi - lo;
  let t = span > 0 ? (v - lo) / span : 1;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  if (mode === "linear") return outLo + (outHi - outLo) * t;
  // area ∝ t, so radius ∝ sqrt of the interpolated area
  return Math.sqrt(outLo * outLo + t * (outHi * outHi - outLo * outLo));
}

/**
 * An attribute value as an angle, in radians.
 *
 * ⚠️ TWO MODES, BECAUSE "DIRECTION" MEANS TWO THINGS. A field that already
 * holds degrees — an aspect, a bearing — must be used AS IS, or north stops
 * being north. Any other field has no angular meaning at all, so its range is
 * spread over a full turn and the result is a pattern, not a direction. Getting
 * these the wrong way round silently rotates a compass.
 *
 * ⚠️ AND COMPASS DEGREES ARE NOT MATHS RADIANS: a bearing runs CLOCKWISE FROM
 * NORTH, the opposite sense from the anticlockwise-from-east convention the
 * symbol geometry uses. The conversion is here, once.
 */
export function angleValue(v, lo, hi, mode = "degrees", offsetDeg = 0) {
  let deg;
  if (mode === "degrees") deg = v;
  else {
    const span = hi - lo;
    let t = span > 0 ? (v - lo) / span : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    deg = t * 360;
  }
  return -((deg + offsetDeg) * Math.PI) / 180;
}

const scaled = (pattern, k) =>
  (!pattern || !pattern.length ? null : pattern.map((v) => v * (k > 0 ? k : 1)));

/** Is (x,y) inside this one ring? Even-odd crossings, the standard test. */
function inRing(x, y, p) {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1];
    const xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Group a flat ring list into FEATURES: each outer with the holes inside it.
 *
 * ⚠️ A SHAPEFILE HAS NO FEATURE BOUNDARIES IN ITS RING LIST. Outers and holes
 * arrive in one sequence and only the winding says which is which, so a layer of
 * five beds with three courtyards is eight rings and nothing states that hole 6
 * belongs to bed 2. Containment is what recovers it, and it has to be recovered
 * before anything can be styled PER FEATURE.
 *
 * ⚠️ A HOLE INSIDE NO OUTER IS KEPT, NOT DISCARDED. Winding is a convention that
 * files break; an unmatched "hole" is far more likely to be an outer ring wound
 * the other way than a genuine orphan, and dropping it would silently lose a
 * whole polygon.
 *
 * @param {{pts:Float64Array, hole:boolean}[]} rings
 * @returns {{rings:{pts:Float64Array,hole:boolean}[], outerIndex:number}[]}
 */
function groupRings(rings) {
  const groups = [];
  const owner = new Map();
  rings.forEach((r, i) => {
    if (r.hole) return;
    owner.set(i, groups.length);
    groups.push({ rings: [r], outerIndex: i });
  });
  if (!groups.length) {
    // Every ring called itself a hole. Treat them as separate features rather
    // than as one region with no outside.
    return rings.map((r, i) => ({ rings: [r], outerIndex: i }));
  }
  rings.forEach((r, i) => {
    if (!r.hole) return;
    const x = r.pts[0], y = r.pts[1];
    // ⚠️ THE SMALLEST CONTAINING OUTER WINS. Nested islands — a lake with an
    // island with a pond — put a hole inside more than one outer, and the
    // innermost is the one it belongs to.
    let best = -1, bestArea = Infinity;
    for (const g of groups) {
      const o = g.rings[0].pts;
      if (!inRing(x, y, o)) continue;
      let a = 0;
      for (let k = 0, n = o.length / 2; k < n; k++) {
        const j2 = (k + 1) % n;
        a += o[k * 2] * o[j2 * 2 + 1] - o[j2 * 2] * o[k * 2 + 1];
      }
      a = Math.abs(a) / 2;
      if (a < bestArea) { bestArea = a; best = groups.indexOf(g); }
    }
    if (best >= 0) groups[best].rings.push(r);
    else groups.push({ rings: [r], outerIndex: i });
  });
  return groups;
}

/**
 * Draw one feature layer.
 *
 * @param {{kind:"point"|"line"|"polygon",
 *          points?:{x:number,y:number}[],
 *          rings?:import("./clip.js").Ring[],
 *          style?:object, name?:string}} spec  geometry in SHEET MM
 * @param {{minLength?:number, tracer?:any, sheet?:{width:number,height:number}}} [o]
 * @returns {{paths:{pts:Float64Array, layer:string, closed:boolean}[],
 *            report:object, warnings:string[]}}
 */
export function buildFeature(spec, o = {}) {
  const kind = spec.kind === "point" ? "point" : spec.kind === "line" ? "line" : "polygon";
  const st = { ...FEATURE_DEFAULTS[kind], ...(spec.style || {}) };
  const minLen = o.minLength ?? 0.3;
  const paths = [];
  const warnings = [];
  const name = spec.name || "features";
  const add = (pts, closed = false) => {
    if (pts && pts.length >= 4) paths.push({ pts: Float64Array.from(pts), layer: st.pass, closed });
  };
  // ⚠️ A FEATURE OFF THE SHEET IS NOT DRAWN, and is counted. The commonest
  // cause is a shapefile in a different CRS, which otherwise shows up as an
  // empty layer with no explanation.
  const sh = o.sheet;
  const onSheet = (x, y) => !sh || (x >= 0 && y >= 0 && x <= sh.width && y <= sh.height);

  let drawn = 0, dropped = 0, fillStrokes = 0, capped = false, unmeasured = 0;

  // ⚠️ ONE PLACE THAT READS AN ATTRIBUTE, USED BY EVERY BRANCH. Each binding
  // that grew separately — size, rotation, density — read its row a slightly
  // different way, and one of them read row 0 for the whole layer. A single
  // resolver is how that stops being possible again.
  const allRows = spec.rows || [];
  /**
   * @param {object} by the binding: {field, lo, hi} plus the two output bounds
   * @param {number} i which feature
   * @param {number} fixed the value when nothing is bound
   */
  const driven = (by, i, fixed, lo, hi, mode = "linear") => {
    if (!by || !by.field) return fixed;
    const row = allRows[i];
    const v = row ? row[by.field] : null;
    if (!Number.isFinite(v)) { unmeasured++; return fixed; }
    return scaleValue(v, by.lo, by.hi, lo, hi, mode);
  };
  /** The band width for feature `i`, or 0 when this style draws lines. */
  const bandWidth = (i) => {
    const base = widthOf(st);
    if (!base) return 0;
    const wBy = st.widthBy || {};
    return Math.max(0, driven(wBy, i, base, wBy.minMM ?? base, wBy.maxMM ?? base));
  };
  /**
   * Which attribute row a grouped feature's OUTER RING arrived on.
   *
   * ⚠️ `outerIndex` IS A POSITION IN THE LIST HANDED TO groupRings(), which is
   * not the position the file delivered — degenerate rings are dropped first.
   * `srcIndex` is stamped on before any of that, so it is the only index that
   * still means "row i of the .dbf".
   */
  const srcOf = (g) => {
    const o = g.rings[0];
    return o && o.srcIndex !== undefined ? o.srcIndex : g.outerIndex;
  };
  /** The fill spacing for feature `i`. Density is INVERTED: high value, tight fill. */
  const fillSpacing = (i) => {
    const d = st.densityBy || {};
    return driven(d, i, st.spacingMM, d.maxMM ?? st.spacingMM, d.minMM ?? st.spacingMM);
  };

  if (kind === "point") {
    const rFixed = st.radiusMM > 0 ? st.radiusMM : 2;
    const pat = scaled(FEATURE_LINETYPES[st.linetype]?.pattern, st.linetypeScale);
    const rows = spec.rows || [];
    const sizeBy = st.sizeBy || {}, rotBy = st.rotateBy || {};
    const pts = spec.points || [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!onSheet(p.x, p.y)) { dropped++; continue; }
      // ⚠️ A MISSING ATTRIBUTE FALLS BACK TO THE FIXED SIZE, IT DOES NOT DRAW
      // NOTHING. A blank girth in one row of a survey must not silently delete
      // that tree from the drawing — it is still a tree, it is just unmeasured,
      // and it is counted so the reader knows.
      let r = rFixed;
      if (sizeBy.field) {
        const v = rows[i] ? rows[i][sizeBy.field] : null;
        if (Number.isFinite(v)) {
          r = scaleValue(v, sizeBy.lo, sizeBy.hi, sizeBy.minMM, sizeBy.maxMM,
            sizeBy.mode || "area");
        } else unmeasured++;
      }
      let rot = 0;
      if (rotBy.field) {
        const v = rows[i] ? rows[i][rotBy.field] : null;
        if (Number.isFinite(v)) {
          rot = angleValue(v, rotBy.lo, rotBy.hi, rotBy.mode || "degrees",
            rotBy.offsetDeg || 0);
        }
      }
      const shape = st.symbol || "circle";
      const ring = shape === "circle"
        ? circlePath(p.x, p.y, r)
        : Float64Array.from(symbolPaths(shape, p.x, p.y, r, rot)[0]);
      // A multi-stroke symbol (cross, arrow) has more than one path.
      if (shape !== "circle") {
        const parts = symbolPaths(shape, p.x, p.y, r, rot);
        for (let k = 1; k < parts.length; k++) add(parts[k], false);
      }
      if (pat) {
        // ⚠️ CLOSED, so the ring's pattern is stretched to close evenly —
        // `dashPath` already refuses to leave a runt at the seam, which at
        // this radius would be a dwell.
        for (const piece of dashPath(ring, true, pat)) add(piece, false);
      } else {
        add(ring, true);
      }
      // A point can carry a fill too — a tree symbol with stipple inside.
      if (st.pattern && st.pattern !== "none") {
        const rings = [{ pts: ring, hole: false }];
        const f = fillRegion(rings, { pattern: st.pattern, spacing: st.spacingMM,
          rotationDeg: 0, minLength: minLen, tracer: o.tracer });
        capped = capped || f.capped;
        for (const s of f.strokes) { add(s, false); fillStrokes++; }
      }
      drawn++;
    }
  } else if (kind === "line") {
    const pat = scaled(FEATURE_LINETYPES[st.linetype]?.pattern, st.linetypeScale);
    // ⚠️ THE ATTRIBUTE ROW IS FOUND BY THE GEOMETRY'S OWN INDEX, NEVER BY A
    // COUNT OF WHAT HAS BEEN DRAWN. Rows are paired to rings BY ORDER, and the
    // loop above this one skips a ring whose every point falls off the sheet —
    // so counting drawn features shifts every row after the first drop, and a
    // survey with one line off the edge silently draws the rest at their
    // neighbour's width. This is the same fault as defect 1, one branch along.
    const geoms = spec.rings || [];
    for (let gi = 0; gi < geoms.length; gi++) {
      const pts = geoms[gi].pts;
      let any = false;
      for (let i = 0; i < pts.length; i += 2) if (onSheet(pts[i], pts[i + 1])) { any = true; break; }
      if (!any) { dropped++; continue; }
      // ⚠️ OPEN, ALWAYS. A polyline shapefile carries paths, not rings; closing
      // one would draw a line from the end of a stream back to its source.
      const w = bandWidth(gi);
      if (w > 0) {
        // ⚠️ A WIDE ENGRAVED LINE IS AN AREA, AND IS DRAWN AS ONE. The band's
        // own outline goes down, then the band is filled — so the DXF, the SVG,
        // the preview and the PNG all carry the same thing. See stroke-band.js
        // for why a width that lived in a stroke attribute would not.
        const band = strokeBand(pts, w, false);
        for (const r of band) add(r.pts, true);
        // ⚠️ FILLED BY OFFSETTING THE PATH, NOT BY SCANLINES. A scanline fill
        // steps across whatever extent the band has in its direction — the whole
        // length for a straight run, the whole bbox for a curve — so it hits the
        // row cap and stripes. Offsets are parallel to the path by construction
        // at any curvature. Measured on a ring band: 782 scanline strokes at 79%
        // coverage, against 5 offset lines at 100%.
        for (const q of bandFill(pts, w, fillSpacing(gi), false)) {
          add(q, false); fillStrokes++;
        }
      } else if (pat) {
        for (const piece of dashPath(pts, false, pat)) add(piece, false);
      } else add(pts, false);
      drawn++;
    }
  } else {
    // ⚠️ THE FILTER RE-INDEXES THE RINGS, AND THE ROWS DO NOT MOVE WITH IT. A
    // degenerate ring — two points, a collapsed sliver — is dropped here, and
    // every ring after it then sits one place earlier than its own attribute
    // row. So each survivor carries the index it arrived with, and every
    // attribute is read through that rather than through its position in the
    // filtered list.
    const rings = [];
    (spec.rings || []).forEach((r, i) => {
      if (r.pts && r.pts.length >= 6) rings.push({ ...r, srcIndex: i });
    });
    if (rings.length) {
      const outers = rings.filter((r) => !r.hole);
      let any = false;
      for (const r of rings) {
        for (let i = 0; i < r.pts.length; i += 2) {
          if (onSheet(r.pts[i], r.pts[i + 1])) { any = true; break; }
        }
        if (any) break;
      }
      if (!any) dropped = outers.length || 1;
      else {
        if (st.outline !== false) {
          const pat = scaled(FEATURE_LINETYPES[st.linetype]?.pattern, st.linetypeScale);
          const groupsForW = groupRings(rings);
          for (const g of groupsForW) {
            const w = bandWidth(srcOf(g));
            for (const r of g.rings) {
              if (w > 0) {
                // ⚠️ THE OUTLINE ITSELF BECOMES AN AREA on the engrave pass, an
                // annulus around the ring, filled. Same reason as a wide line:
                // a width that lived in a stroke attribute would be in the
                // preview, the SVG and the PNG, and absent from the DXF.
                const band = strokeBand(r.pts, w, true);
                for (const b of band) add(b.pts, true);
                // ⚠️ A RING RUNS EVERY DIRECTION, so no scanline angle follows
                // it — and `echo`, which does follow a boundary, rasterises at a
                // cell sized from the whole polygon and cannot resolve a band
                // 0.6 mm wide at all (measured: 0% coverage). Offsetting the ring
                // itself is exact.
                for (const q of bandFill(r.pts, w, fillSpacing(srcOf(g)), true)) {
                  add(q, false); fillStrokes++;
                }
              } else if (pat) {
                for (const piece of dashPath(r.pts, true, pat)) add(piece, false);
              } else add(r.pts, true);
            }
          }
        }
        if (st.pattern && st.pattern !== "none") {
          // ⚠️ ONE FILL PER FEATURE, NOT ONE PER LAYER. This used to fill every
          // ring in the layer as a single region and take the spacing from
          // `rows[0]` — so "density by an attribute" read the FIRST polygon's
          // value and gave every other polygon the same hatch. It looked like it
          // worked: the field picker filled, the range filled from the real
          // data, and a bed at 5% cover came out exactly as dense as one at 95%.
          // Measured on two squares at COVER 5 and COVER 95: nine fill strokes
          // each.
          //
          // ⚠️ AND STILL NOT RING BY RING, which is the reason it was written
          // that way. A hole has to be filled WITH its outer or the hatch runs
          // straight across it — a pond inside a planting bed comes out planted.
          // So the rings are grouped into features first: each outer with the
          // holes that fall inside it, filled together, at its OWN value.
          const groups = groupRings(rings);
          for (const g of groups) {
            // ⚠️ THE ROW OF THE OUTER RING, because rows are paired to rings by
            // ORDER and a feature is named by its outer. A hole carries the same
            // feature's attributes; taking a hole's row would work by accident
            // and break the moment a multipart polygon appeared.
            const spacing = fillSpacing(srcOf(g));
            const f = fillRegion(g.rings, { pattern: st.pattern, spacing,
              rotationDeg: st.rotationDeg, minLength: minLen, tracer: o.tracer });
            capped = capped || f.capped;
            for (const s of f.strokes) { add(s, false); fillStrokes++; }
          }
        }
        drawn = outers.length || rings.length;
      }
    }
  }

  if (capped) {
    warnings.push(`${name}: the fill spacing was too fine for the area and has been `
      + `coarsened to stay drawable — ask for fewer rows, or a smaller region.`);
  }
  // ⚠️ AN UNMEASURED FEATURE IS NAMED, NOT HIDDEN. It is drawn at the fixed
  // size, which is the honest fallback — but a reader comparing symbol sizes
  // must know that some of them are not measurements.
  if (unmeasured) {
    warnings.push(`${name}: ${unmeasured} feature${unmeasured === 1 ? " has" : "s have"} no `
      + `value in the sizing field, so ${unmeasured === 1 ? "it is" : "they are"} drawn at the `
      + `fixed size. They are NOT comparable with the scaled symbols around them.`);
  }
  if (dropped) {
    warnings.push(`${name}: ${dropped} feature${dropped === 1 ? "" : "s"} fell outside the `
      + `sheet and ${dropped === 1 ? "was" : "were"} not drawn. Almost always a shapefile in `
      + `a different coordinate system than the raster.`);
  }
  // ⚠️ THE STROKE COUNT PRECEDES THE FILE, like every other count in this tool.
  if (fillStrokes > 4000) {
    warnings.push(`${name}: the fill is ${fillStrokes} separate strokes — every one is a `
      + `head move. Wider spacing, or a simpler pattern, brings it down.`);
  }
  return {
    paths,
    warnings,
    report: {
      name, kind, drawn, dropped, unmeasured,
      pass: st.pass,
      style: kind === "polygon"
        ? `${st.pattern === "none" ? "outline only" : st.pattern} at ${st.spacingMM} mm, `
          + `${st.rotationDeg}°${st.outline === false ? ", no outline" : ""}`
        : kind === "line"
          ? `${st.linetype}${st.linetypeScale !== 1 ? ` ×${st.linetypeScale}` : ""}`
          : `r ${st.radiusMM} mm, ${st.linetype}`
            + `${st.pattern && st.pattern !== "none" ? `, ${st.pattern} inside` : ""}`,
      fillStrokes,
      paths: paths.length,
    },
  };
}
