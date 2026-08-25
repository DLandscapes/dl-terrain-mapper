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
    linetype: "solid", linetypeScale: 1, pass: "DLF-02_score_medium" },
  line: { linetype: "dashed", linetypeScale: 1, pass: "DLF-02_score_medium" },
  point: { radiusMM: 2.0, linetype: "solid", linetypeScale: 1,
    pattern: "none", spacingMM: 1.0, pass: "DLF-02_score_medium" },
};

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

const scaled = (pattern, k) =>
  (!pattern || !pattern.length ? null : pattern.map((v) => v * (k > 0 ? k : 1)));

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

  let drawn = 0, dropped = 0, fillStrokes = 0, capped = false;

  if (kind === "point") {
    const r = st.radiusMM > 0 ? st.radiusMM : 2;
    const pat = scaled(FEATURE_LINETYPES[st.linetype]?.pattern, st.linetypeScale);
    for (const p of (spec.points || [])) {
      if (!onSheet(p.x, p.y)) { dropped++; continue; }
      const ring = circlePath(p.x, p.y, r);
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
    for (const ring of (spec.rings || [])) {
      const pts = ring.pts;
      let any = false;
      for (let i = 0; i < pts.length; i += 2) if (onSheet(pts[i], pts[i + 1])) { any = true; break; }
      if (!any) { dropped++; continue; }
      // ⚠️ OPEN, ALWAYS. A polyline shapefile carries paths, not rings; closing
      // one would draw a line from the end of a stream back to its source.
      if (pat) for (const piece of dashPath(pts, false, pat)) add(piece, false);
      else add(pts, false);
      drawn++;
    }
  } else {
    const rings = (spec.rings || []).filter((r) => r.pts && r.pts.length >= 6);
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
          for (const r of rings) {
            if (pat) for (const piece of dashPath(r.pts, true, pat)) add(piece, false);
            else add(r.pts, true);
          }
        }
        if (st.pattern && st.pattern !== "none") {
          // ⚠️ FILLED AS ONE REGION, holes included, not ring by ring. Filling
          // each ring separately would hatch straight across a hole — a pond
          // inside a planting bed would come out planted.
          const f = fillRegion(rings, { pattern: st.pattern, spacing: st.spacingMM,
            rotationDeg: st.rotationDeg, minLength: minLen, tracer: o.tracer });
          capped = capped || f.capped;
          for (const s of f.strokes) { add(s, false); fillStrokes++; }
        }
        drawn = outers.length || rings.length;
      }
    }
  }

  if (capped) {
    warnings.push(`${name}: the fill spacing was too fine for the area and has been `
      + `coarsened to stay drawable — ask for fewer rows, or a smaller region.`);
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
      name, kind, drawn, dropped,
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
