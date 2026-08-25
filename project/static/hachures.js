// @ts-check
// HACHURES — short strokes down the slope, hung off the contours.
//
// The oldest answer to the question this whole tool asks. Before hypsometric
// tint and before the shaded relief, a cartographer showed terrain with strokes
// running down the fall line, drawn heavier and closer where the ground was
// steeper (Lehmann, 1799; the Swiss manner after him). It is a technique built
// for an engraving tool that had no tone — which is exactly the machine this
// tool compiles for. A laser cannot shade. It can make a mark, and a mark
// beside another mark.
//
// It is also, unchanged, a working convention of the modern grading plan: the
// ticked line down an embankment or a cut face. So a hachured contour is not a
// historical pastiche here, it is the notation a landscape architect already
// draws by hand.
//
// ⚠️ DOWNHILL IS TAKEN FROM THE GROUND, NOT FROM THE WINDING. The tracer does
// order its rings consistently, and the side of the line the high ground lies
// on could in principle be read off that — but it would be an invisible
// coupling between two modules, and a hachure pointing the wrong way turns a
// hill into a hollow with no other symptom. So the gradient is sampled from the
// DEM at every station. It costs four bilinear samples per tick and it is
// right by construction, at the seam of two tiles as much as in the middle.
//
// ⚠️ THE SAME SAMPLE GIVES DIRECTION AND STEEPNESS, so a tick's length can
// carry the slope it stands on without a second pass over the raster.
//
// ⚠️ A TICK IS A MARK, NOT A PIERCE. Every stroke is a real two-point path with
// real length; nothing here may emit a zero-length stroke, for the reason
// stated in stroke-font.js and linestyle.js — the head would dwell and burn.

import { sampleBilinear, toGrid } from "./dem.js";

/**
 * The downhill unit vector and the slope at a map position.
 *
 * Central differences one cell apart, in MAP units, so the answer is in the
 * same frame the contours are in. NaN anywhere in the stencil means no answer —
 * never a substituted neighbour, which would invent a fall line exactly where
 * the survey stopped.
 *
 * @param {import("./dem.js").DEM} dem @param {number} X @param {number} Y
 * @returns {{dx:number, dy:number, slope:number}|null} `slope` is rise/run
 */
export function fallLine(dem, X, Y) {
  const h = dem.cell;
  const g = (x, y) => {
    const q = toGrid(dem, x, y);
    return sampleBilinear(dem, q.gx, q.gy);
  };
  const e = g(X + h, Y), w = g(X - h, Y), n = g(X, Y + h), s = g(X, Y - h);
  if (!Number.isFinite(e) || !Number.isFinite(w)
    || !Number.isFinite(n) || !Number.isFinite(s)) return null;
  // The gradient points UPHILL; a hachure runs the other way.
  const gx = (e - w) / (2 * h), gy = (n - s) / (2 * h);
  const mag = Math.hypot(gx, gy);
  if (!(mag > 0)) return null;                    // dead flat has no fall line
  return { dx: -gx / mag, dy: -gy / mag, slope: mag };
}

/**
 * Hang hachures off a set of contour polylines.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {{pts:Float64Array|number[], closed:boolean, index?:boolean}[]} lines
 *   contours in MAP units, as the tracer produced them
 * @param {{spacing?:number, minLength?:number, maxLength?:number,
 *          loSlope?:number, hiSlope?:number, uphill?:boolean,
 *          fixed?:boolean, minSlope?:number}} [opts]
 *   `spacing`, `minLength`, `maxLength` in MAP units — the compiler converts
 *   from sheet millimetres. `loSlope`/`hiSlope` pin the steepness that maps to
 *   the shortest and longest tick (rise/run); default is the range actually
 *   met. `fixed` gives every tick `maxLength` regardless of slope, which is the
 *   grading-plan convention. `minSlope` leaves ground flatter than this bare.
 * @returns {{ticks:Float64Array[], drawn:number, skipped:number,
 *            loSlope:number, hiSlope:number}}
 */
export function hachureLines(dem, lines, opts = {}) {
  const spacing = opts.spacing > 0 ? opts.spacing : dem.cell * 2;
  const maxLength = opts.maxLength > 0 ? opts.maxLength : dem.cell * 2;
  const minLength = Math.min(opts.minLength ?? maxLength * 0.35, maxLength);
  const minSlope = opts.minSlope ?? 0;
  const fixed = !!opts.fixed;

  // Pass one: every station and its fall line, so the steepness range is known
  // before any tick is sized. ⚠️ SIZING AGAINST THE RANGE ACTUALLY MET, not
  // against an assumed 0..45°, or a gentle site draws every tick at minimum
  // and says nothing.
  const stations = [];
  let skipped = 0;
  let lo = Infinity, hi = -Infinity;
  for (const line of lines) {
    const pts = line.pts;
    const n = pts.length / 2;
    if (n < 2) continue;
    const N = line.closed ? n + 1 : n;
    // ⚠️ WALKED BY ARC LENGTH, like the dash pattern, and for the same reason:
    // a contour's vertices are as dense as the terrain is rough, so one tick
    // per vertex would crowd the broken ground and starve the smooth.
    let carry = spacing / 2;                      // half a step in, not on the end
    for (let k = 0; k < N - 1; k++) {
      const a = k % n, b = (k + 1) % n;
      const ax = pts[a * 2], ay = pts[a * 2 + 1];
      const bx = pts[b * 2], by = pts[b * 2 + 1];
      const segLen = Math.hypot(bx - ax, by - ay);
      if (!(segLen > 0)) continue;
      let travelled = carry;
      while (travelled < segLen) {
        const t = travelled / segLen;
        const X = ax + (bx - ax) * t, Y = ay + (by - ay) * t;
        const f = fallLine(dem, X, Y);
        if (!f) skipped++;
        else if (f.slope < minSlope) skipped++;
        else {
          stations.push({ X, Y, f });
          if (f.slope < lo) lo = f.slope;
          if (f.slope > hi) hi = f.slope;
        }
        travelled += spacing;
      }
      carry = travelled - segLen;
    }
  }
  if (!stations.length) return { ticks: [], drawn: 0, skipped, loSlope: 0, hiSlope: 0 };

  const pinLo = Number.isFinite(opts.loSlope) ? opts.loSlope : lo;
  const pinHi = Number.isFinite(opts.hiSlope) ? opts.hiSlope : hi;
  const span = pinHi - pinLo;

  const ticks = [];
  for (const st of stations) {
    let len = maxLength;
    if (!fixed) {
      let t = span > 0 ? (st.f.slope - pinLo) / span : 1;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      len = minLength + (maxLength - minLength) * t;
    }
    if (!(len > 0)) { skipped++; continue; }
    const dx = opts.uphill ? -st.f.dx : st.f.dx;
    const dy = opts.uphill ? -st.f.dy : st.f.dy;
    ticks.push(Float64Array.of(st.X, st.Y, st.X + dx * len, st.Y + dy * len));
  }
  return { ticks, drawn: ticks.length, skipped, loSlope: pinLo, hiSlope: pinHi };
}
