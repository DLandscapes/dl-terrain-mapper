// @ts-check
// REGIONS — one threshold, closed rings, a second material.
//
// This is the engine behind DESIGN-two-materials.md, in Marc's own framing:
// "the second material's outline should come from ONE threshold — patches that
// are higher in a certain value than other patches — these values could be the
// disturbance values." A region here is exactly that: everywhere a raster
// exceeds one value. The raster can be a surface (nDSM > 2 m = canopy), or a
// difference between two epochs (|now − was| > tolerance = disturbed ground).
//
// ⚠️ EVERY RING THIS MODULE RETURNS IS CLOSED, AND THAT IS THE WHOLE REASON IT
// EXISTS SEPARATELY FROM contours.js. The contour tracer is honest about the
// raster's edge: a line that meets it stays OPEN, because the ground continues
// and the drawing should say so. A region that will be CUT FROM MATERIAL cannot
// be open — an open cut path frees nothing and scraps the sheet. So the grid is
// padded with a ring of below-threshold cells before tracing (every boundary
// then lies between two cells and closes), and the closed rings are clipped
// back to the raster's extent with a polygon clipper that KEEPS them closed,
// closing along the sheet edge where the region genuinely reaches it.
//
// ⚠️ WINDING IS THE HOLE TEST, AND IT IS FREE. The tracer emits high ground on
// the left, so an outer boundary comes back counter-clockwise and a clearing
// inside a wood comes back clockwise. No point-in-polygon pass, no nesting
// tree — the thing that is normally a day of fiddly topology falls out of a
// decision the tracer made on day one.
//
// ⚠️ NaN IS OUTSIDE THE REGION, not inside and not an error. A cell with no
// measurement cannot honestly be claimed to exceed the threshold, and material
// must never be cut on the strength of a value that was never measured.

import { traceContours, pathLength } from "./contours.js";

/**
 * The difference of two aligned rasters: a − b, cell for cell.
 *
 * ⚠️ ALIGNMENT IS CHECKED, NOT ASSUMED. Subtracting two grids that merely look
 * similar — same size, different origin — produces a plausible disturbance
 * field that is actually the terrain differentiated against a shifted copy of
 * itself: every slope becomes false cut on one side and false fill on the
 * other. The check is strict because the failure is invisible.
 *
 * @param {import("./dem.js").DEM} a  the later / upper surface
 * @param {import("./dem.js").DEM} b  the earlier / lower surface
 * @param {{name?:string, abs?:boolean}} [o]  `abs` for |a − b|, the
 *   disturbance magnitude, when the sign is not wanted
 * @returns {import("./dem.js").DEM}
 */
export function differenceDEM(a, b, o = {}) {
  if (a.ncols !== b.ncols || a.nrows !== b.nrows) {
    throw new Error(`the rasters are different sizes (${a.ncols}×${a.nrows} vs `
      + `${b.ncols}×${b.nrows}) — resample one onto the other's grid first`);
  }
  if (Math.abs(a.cell - b.cell) > 1e-9
    || Math.abs(a.originX - b.originX) > a.cell * 0.01
    || Math.abs(a.originY - b.originY) > a.cell * 0.01) {
    throw new Error(`the rasters are not on the same grid (cell ${a.cell} vs ${b.cell}, `
      + `origins ${a.originX},${a.originY} vs ${b.originX},${b.originY}) — a difference `
      + `of misaligned grids is slope in disguise, not disturbance`);
  }
  const z = new Float32Array(a.z.length);
  for (let i = 0; i < z.length; i++) {
    const va = a.z[i], vb = b.z[i];
    const d = va - vb;
    z[i] = Number.isFinite(d) ? (o.abs ? Math.abs(d) : d) : NaN;
  }
  return { ...a, z, name: o.name || `${a.name || "a"} − ${b.name || "b"}` };
}

/**
 * Clip a CLOSED ring to an axis-aligned rectangle, keeping it closed.
 *
 * Sutherland–Hodgman against the four half-planes. Winding is preserved, holes
 * clip the same way as outers, and a ring crossing the boundary comes back
 * closed along it — which for a cut region meeting the sheet edge is the right
 * geometry: the void opens onto the edge, and the cut along the edge merely
 * retraces the sheet outline.
 *
 * ⚠️ ONE KNOWN LIMIT, STATED RATHER THAN HIDDEN: a ring that leaves the
 * rectangle and re-enters it (two lobes joined outside) comes back as ONE ring
 * with a zero-width bridge along the boundary, not as two rings. The laser cuts
 * the bridge along the sheet edge, where the outer cut runs anyway, so the
 * pieces separate correctly — but anyone counting rings should know.
 *
 * @param {Float64Array|number[]} pts x,y interleaved, closed (no repeat)
 * @param {{x0:number,y0:number,x1:number,y1:number}} r
 * @returns {Float64Array|null} the clipped ring, or null if nothing remains
 */
export function clipRingToRect(pts, r) {
  /** @type {number[]} */
  let poly = Array.from(pts);
  // inside tests and segment–boundary intersections for the four half-planes
  const passes = [
    { in: (x, y) => x >= r.x0, at: (ax, ay, bx, by) => { const t = (r.x0 - ax) / (bx - ax); return [r.x0, ay + (by - ay) * t]; } },
    { in: (x, y) => x <= r.x1, at: (ax, ay, bx, by) => { const t = (r.x1 - ax) / (bx - ax); return [r.x1, ay + (by - ay) * t]; } },
    { in: (x, y) => y >= r.y0, at: (ax, ay, bx, by) => { const t = (r.y0 - ay) / (by - ay); return [ax + (bx - ax) * t, r.y0]; } },
    { in: (x, y) => y <= r.y1, at: (ax, ay, bx, by) => { const t = (r.y1 - ay) / (by - ay); return [ax + (bx - ax) * t, r.y1]; } },
  ];
  for (const pass of passes) {
    const n = poly.length / 2;
    if (n < 3) return null;
    /** @type {number[]} */
    const out = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = poly[i * 2], ay = poly[i * 2 + 1];
      const bx = poly[j * 2], by = poly[j * 2 + 1];
      const aIn = pass.in(ax, ay), bIn = pass.in(bx, by);
      if (aIn) out.push(ax, ay);
      if (aIn !== bIn) { const q = pass.at(ax, ay, bx, by); out.push(q[0], q[1]); }
    }
    poly = out;
  }
  return poly.length >= 6 ? Float64Array.from(poly) : null;
}

/** Twice the signed area of a closed ring. Positive = counter-clockwise. */
export function ringArea2(pts) {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return a;
}

/**
 * @typedef {object} Region
 * @property {number} n        1-based, for the engraved label
 * @property {number} cells
 * @property {number} areaM2
 * @property {number} mean     mean value over the region's cells
 * @property {number} max
 * @property {number} labelX   MAP units — the region's deepest cell, which is
 * @property {number} labelY   guaranteed to lie inside it (a centroid is not)
 */

/**
 * Everywhere the raster exceeds one threshold, as closed rings plus the
 * statistics a label needs.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {number} threshold
 * @param {{minAreaM2?:number}} [opts]  drop regions (and their rings) smaller
 *   than this — slivers of one or two cells cut confetti, not meaning
 * @returns {{rings:{pts:Float64Array, hole:boolean, areaM2:number}[],
 *            regions:Region[], totalAreaM2:number}}
 */
export function traceRegions(dem, threshold, opts = {}) {
  const { nrows, ncols, cell, z, originX, originY } = dem;
  const minAreaM2 = opts.minAreaM2 ?? 0;
  const minCells = Math.max(1, Math.round(minAreaM2 / (cell * cell)));

  // ── 1 · pad with a below-threshold ring so every boundary closes ─────────
  // ⚠️ THE PAD VALUE IS DERIVED FROM THE THRESHOLD, NOT A MAGIC −9999. A pad of
  // −9999 fails the moment somebody thresholds a raster whose honest values go
  // lower (a large cut in a difference grid). One unit below the threshold is
  // below it for every raster, by construction. NaN cells get the same value:
  // no measurement, no region.
  const R = nrows + 2, C = ncols + 2;
  const pad = threshold - Math.max(1, Math.abs(threshold) * 0.5);
  const zz = new Float32Array(R * C).fill(pad);
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const v = z[r * ncols + c];
      if (Number.isFinite(v)) zz[(r + 1) * C + (c + 1)] = v;
    }
  }
  const padded = {
    nrows: R, ncols: C, cell, z: zz,
    originX: originX - cell, originY: originY + cell,
  };

  // ── 2 · the boundary is a contour at the threshold ───────────────────────
  // edge:"centres" because the padding has already done the extension's job;
  // extending the padded grid again would only move the pad ring outward.
  const traced = traceContours(padded, 1, { levels: [threshold], edge: "centres" });

  // ── 3 · clip back to the true extent, keeping rings closed ───────────────
  const rect = { x0: originX, y0: originY - nrows * cell, x1: originX + ncols * cell, y1: originY };
  const sliver = (cell * cell) / 2;
  /** @type {{pts:Float64Array, hole:boolean, areaM2:number}[]} */
  const rings = [];
  for (const t of traced) {
    if (!t.closed) continue;                     // cannot happen post-pad; belt and braces
    const clipped = clipRingToRect(t.pts, rect);
    if (!clipped) continue;
    const a2 = ringArea2(clipped);
    if (Math.abs(a2) / 2 < sliver) continue;
    rings.push({ pts: clipped, hole: a2 < 0, areaM2: a2 / 2 });
  }

  // ── 4 · per-region statistics, by connected components on the mask ───────
  // The rings say WHERE to cut; the components say WHAT each piece means. They
  // are computed independently and never matched to each other — a label goes
  // at its region's deepest cell, which is inside the region by definition,
  // and the rings land around it on their own.
  const seen = new Uint8Array(nrows * ncols);
  /** @type {Region[]} */
  const regions = [];
  const stack = new Int32Array(nrows * ncols);
  for (let start = 0; start < seen.length; start++) {
    if (seen[start]) continue;
    const v0 = z[start];
    if (!Number.isFinite(v0) || v0 <= threshold) { seen[start] = 1; continue; }
    // flood fill, 4-connected — diagonal-only contact is two pieces of
    // material, so 8-connectivity would merge regions the laser separates
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let cells = 0, sum = 0, max = -Infinity, maxAt = start;
    while (top > 0) {
      const i = stack[--top];
      const v = z[i];
      cells++; sum += v;
      if (v > max) { max = v; maxAt = i; }
      const r = (i / ncols) | 0, c = i - r * ncols;
      if (c > 0) visit(i - 1);
      if (c < ncols - 1) visit(i + 1);
      if (r > 0) visit(i - ncols);
      if (r < nrows - 1) visit(i + ncols);
    }
    if (cells >= minCells) {
      const mr = (maxAt / ncols) | 0, mc = maxAt - mr * ncols;
      regions.push({
        n: regions.length + 1,
        cells,
        areaM2: cells * cell * cell,
        mean: sum / cells,
        max,
        labelX: originX + (mc + 0.5) * cell,
        labelY: originY - (mr + 0.5) * cell,
      });
    }
    // eslint-disable-next-line no-inner-declarations
    function visit(j) {
      if (seen[j]) return;
      seen[j] = 1;
      const vj = z[j];
      if (Number.isFinite(vj) && vj > threshold) stack[top++] = j;
    }
  }

  // ── 5 · the sliver filter applies to rings AND regions together ──────────
  // A region below the floor keeps neither its rings nor its label. Rings are
  // matched to dropped regions by area only when everything is unambiguous —
  // otherwise small rings are dropped by their own area, which is the same
  // floor expressed in geometry.
  const minRingArea = minCells * cell * cell;
  const kept = minAreaM2 > 0
    ? rings.filter((r) => r.hole || Math.abs(r.areaM2) >= minRingArea * 0.5)
    : rings;

  return {
    rings: kept,
    regions,
    totalAreaM2: regions.reduce((a, r) => a + r.areaM2, 0),
  };
}
