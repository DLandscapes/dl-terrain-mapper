// @ts-check
// HATCHING — a field read as LINE DENSITY instead of as size or as tone.
//
// The third translation of a raster into laser marks, beside contours (the
// value as position) and the circle grid (the value as symbol size): parallel
// scanlines whose INK DENSITY follows the value. Where the field is strong the
// line runs solid; where it weakens the line breaks into shorter and shorter
// dashes; where it is nothing, the paper is left alone. The classic use is a
// derived surface with no meaningful contour — slope, a wetness index — where
// tone is what a reader wants and a laser has no tone to give except marks.
//
// ⚠️ THE DASH COUNT IS THE COST, AND MERGING IS NOT AN OPTIMISATION. Rule 1 of
// this project exists because ~3,700 dashes once stood in for 55 continuous
// paths — every dash is a pierce, a head stop and a witness mark. So a run of
// full-density steps is emitted as ONE path, not as step-sized pieces, and a
// dash that would come out shorter than `minMark` is not emitted at all (a
// sub-kerf dash is a stationary burn, the same failure the dash-ring runt fix
// guards in linestyle.js). The mark count is reported BEFORE any file is
// written, like every other count in this tool.
//
// ⚠️ SCANLINES ARE ANCHORED AT THE RASTER'S CENTRE, the same rule symbolField
// keeps: changing the spacing must change the density, never slide the whole
// field sideways — a slide reads as the data having moved.
//
// ⚠️ NaN IS NOT ZERO. An unmeasured cell gets no ink, which on a hatch field
// looks identical to "measured, weak" only until the legend is read — so the
// caller is told how many samples were unmeasured and can say so.

/**
 * Hatch a raster: parallel lines in map units, dashed by the value.
 *
 * @param {import("./dem.js").DEM} dem  any single-band grid — elevation,
 *   slope, wetness; the values need not be heights
 * @param {{spacing?:number, step?:number, angleDeg?:number, minMark?:number,
 *          lo?:number, hi?:number, invert?:boolean, floor?:number}} [opts]
 *   `spacing` line-to-line distance in MAP units; `step` the sampling length
 *   along each line (defaults to `spacing`, a square cadence); `floor` a value
 *   below which nothing is drawn at all (value units); `invert` puts the ink
 *   on the LOW values instead. `lo`/`hi` pin the density scale; default is the
 *   data's own range.
 * @returns {{paths:Float64Array[], marks:number, lines:number,
 *            lo:number, hi:number, unmeasured:number}}
 *   paths in map units, x,y interleaved — every one open, none shorter than
 *   `minMark`
 */
export function hatchField(dem, opts = {}) {
  const { nrows, ncols, cell, originX, originY, z } = dem;
  const spacing = opts.spacing > 0 ? opts.spacing : cell * 4;
  const step = opts.step > 0 ? opts.step : spacing;
  const ang = ((opts.angleDeg ?? 45) * Math.PI) / 180;
  const minMark = opts.minMark ?? 0;
  const floor = Number.isFinite(opts.floor) ? opts.floor : -Infinity;

  let lo = opts.lo, hi = opts.hi;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < z.length; i++) {
      const v = z[i];
      if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!Number.isFinite(lo)) return { paths: [], marks: 0, lines: 0, lo: 0, hi: 0, unmeasured: z.length };
  }
  const span = hi - lo;

  // The raster's extent, and a line frame rotated by the hatch angle: `u` runs
  // along a line, `n` steps from line to line.
  const x0 = originX, x1 = originX + ncols * cell;
  const y1 = originY, y0 = originY - nrows * cell;
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const nx = -uy, ny = ux;
  let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const s = px * nx + py * ny, t = px * ux + py * uy;
    if (s < sMin) sMin = s; if (s > sMax) sMax = s;
    if (t < tMin) tMin = t; if (t > tMax) tMax = t;
  }
  const sMid = ((x0 + x1) / 2) * nx + ((y0 + y1) / 2) * ny;

  // Nearest-cell sampling, by containment. Bilinear would invent intermediate
  // values across a NaN edge or a class boundary; a hatch is a field of marks,
  // and the honest mark is the cell's own value.
  let unmeasured = 0;
  const sample = (px, py) => {
    const c = Math.floor((px - originX) / cell), r = Math.floor((originY - py) / cell);
    if (c < 0 || r < 0 || c >= ncols || r >= nrows) return NaN;
    return z[r * ncols + c];
  };

  /** @type {Float64Array[]} */
  const paths = [];
  const emit = (s, a, b) => {
    if (b - a < minMark) return;
    paths.push(Float64Array.of(s * nx + a * ux, s * ny + a * uy,
                               s * nx + b * ux, s * ny + b * uy));
  };

  let lines = 0;
  const k0 = Math.ceil((sMin - sMid) / spacing), k1 = Math.floor((sMax - sMid) / spacing);
  for (let k = k0; k <= k1; k++) {
    const s = sMid + k * spacing;
    lines++;
    let runStart = NaN;                     // a run of full-density steps
    const flush = (end) => {
      if (Number.isFinite(runStart)) emit(s, runStart, end);
      runStart = NaN;
    };
    for (let t = tMin; t < tMax; t += step) {
      const mid = t + step / 2;
      const v = sample(s * nx + mid * ux, s * ny + mid * uy);
      if (!Number.isFinite(v)) {
        unmeasured++;
        flush(t); continue;
      }
      if (v < floor) { flush(t); continue; }
      let d = span > 0 ? (v - lo) / span : 1;
      d = d < 0 ? 0 : d > 1 ? 1 : d;
      if (opts.invert) d = 1 - d;
      if (d >= 0.98) {
        // Full density: extend the run — one path, one pierce, however long.
        if (!Number.isFinite(runStart)) runStart = t;
        continue;
      }
      flush(t);
      const len = d * step;
      if (len > 0) emit(s, mid - len / 2, mid + len / 2);
    }
    flush(tMax);
  }
  return { paths, marks: paths.length, lines, lo, hi, unmeasured };
}
