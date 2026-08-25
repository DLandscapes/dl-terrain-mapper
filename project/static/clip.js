// @ts-check
// CLIPPING TO A BOUNDARY — the last thing that happens to a drawing.
//
// Marc's framing, 2026-08-25: load the whole model, generate all the
// translations over it, and only then cut out the tile a student is
// responsible for. That order is the right one and it is worth saying why.
//
// ⚠️ EVERY PATTERN IN THIS TOOL IS ANCHORED TO THE GROUND, NOT TO THE SHEET —
// hatch scanlines, dash phases, symbol grids. Computed on the whole model and
// cut afterwards, two neighbouring tiles cannot disagree, because there was
// only ever ONE field and the seam is a line drawn through it. Computed
// per-tile they can only be made to agree by keeping every anchor in world
// coordinates and never making an arithmetic slip. The first way is correct by
// construction; the second is correct by vigilance.
//
// ⚠️ SUTHERLAND–HODGMAN IS NOT ENOUGH HERE. regions.js clips rings against a
// RECTANGLE, where that algorithm is exact. A tile boundary is an arbitrary
// polygon and may be concave — an L-shaped plot, a boundary following a
// stream — and Sutherland–Hodgman quietly produces degenerate bridges across
// concavities. So line work is clipped by finding every crossing along the
// path and keeping the spans whose midpoint is inside, which is exact for any
// polygon, convex or not, holes and all.
//
// ⚠️ A CIRCLE IS KEPT WHOLE OR DROPPED WHOLE. Same rule the sheet edge already
// keeps: a clipped circle is an arc, and an arc reads as a smaller value. A
// grading plan whose edge symbols understate their own quantity is worse than
// one that stops.

/**
 * @typedef {{pts:Float64Array, hole:boolean}} Ring
 */

/**
 * Is a point inside a set of rings? Even-odd across every ring, so holes
 * subtract without needing to know which outer ring they belong to.
 *
 * ⚠️ THE RAY IS CAST IN +X AND THE HALF-OPEN TEST `(yi > y) !== (yj > y)` IS
 * DELIBERATE: it counts a vertex exactly once when the ray passes through it,
 * which is the difference between a correct answer and a point that flickers
 * inside/outside along a horizontal boundary — and a tile boundary drawn in
 * QGIS is full of exactly horizontal edges.
 *
 * @param {number} x @param {number} y @param {Ring[]} rings
 */
export function pointInRings(x, y, rings) {
  let inside = false;
  for (const r of rings) {
    const p = r.pts;
    const n = p.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = p[i * 2], yi = p[i * 2 + 1];
      const xj = p[j * 2], yj = p[j * 2 + 1];
      if ((yi > y) !== (yj > y)
        && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The bounding box of a set of rings. @param {Ring[]} rings */
export function ringsBBox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) {
    const p = r.pts;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * Everything of a polyline that falls inside the rings.
 *
 * @param {Float64Array|number[]} pts x,y interleaved
 * @param {boolean} closed
 * @param {Ring[]} rings
 * @returns {Float64Array[]} the surviving spans, each open
 */
export function clipPathToRings(pts, closed, rings) {
  const n = pts.length / 2;
  if (n < 2) return [];
  /** @type {number[][]} */
  const out = [];
  /** @type {number[]} */
  let cur = [];
  const flush = () => {
    if (cur.length >= 4) out.push(cur);
    cur = [];
  };

  const N = closed ? n : n - 1;
  for (let k = 0; k < N; k++) {
    const a = k, b = (k + 1) % n;
    const ax = pts[a * 2], ay = pts[a * 2 + 1];
    const bx = pts[b * 2], by = pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    if (dx === 0 && dy === 0) continue;

    // Every crossing of this segment with every ring edge, as a parameter 0..1.
    /** @type {number[]} */
    const cuts = [0, 1];
    for (const r of rings) {
      const p = r.pts;
      const m = p.length / 2;
      for (let i = 0, j = m - 1; i < m; j = i++) {
        const cx = p[j * 2], cy = p[j * 2 + 1];
        const ex = p[i * 2], ey = p[i * 2 + 1];
        const rx = ex - cx, ry = ey - cy;
        const den = dx * ry - dy * rx;
        if (den === 0) continue;                     // parallel: no single crossing
        const t = ((cx - ax) * ry - (cy - ay) * rx) / den;
        const u = ((cx - ax) * dy - (cy - ay) * dx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
      }
    }
    cuts.sort((p2, q) => p2 - q);

    // ⚠️ EACH SPAN IS TESTED AT ITS MIDPOINT, never at an endpoint. An endpoint
    // sits exactly ON the boundary whenever it came from a crossing, and a
    // point-in-polygon test there is a coin toss.
    for (let i = 0; i < cuts.length - 1; i++) {
      const t0 = cuts[i], t1 = cuts[i + 1];
      if (t1 - t0 < 1e-12) continue;
      const mt = (t0 + t1) / 2;
      if (!pointInRings(ax + dx * mt, ay + dy * mt, rings)) { flush(); continue; }
      const sx = ax + dx * t0, sy = ay + dy * t0;
      const ex2 = ax + dx * t1, ey2 = ay + dy * t1;
      if (!cur.length) cur.push(sx, sy);
      cur.push(ex2, ey2);
    }
  }
  flush();
  return out.map((p) => Float64Array.from(p));
}

/**
 * Clip a whole compiled drawing to a boundary, in SHEET millimetres.
 *
 * ⚠️ THIS MUTATES NOTHING — it returns new arrays, because the caller still
 * holds the unclipped drawing and the preview must be able to show either.
 *
 * @param {{paths:any[], circles:any[]}} drawing
 * @param {Ring[]} rings in sheet mm
 * @param {{keep?:(e:any)=>boolean}} [o] a predicate for entities exempt from
 *   the clip — the sheet furniture, which belongs to the plate rather than to
 *   the ground.
 *   ⚠️ A PREDICATE ON THE ENTITY, NEVER A SET OF LAYERS. Layers say what the
 *   machine does, not what a thing IS: the light-score pass carries the scale
 *   bar AND the default hatching, hachures, labels and section lines. Exempting
 *   by layer let a 16,000-mark hatch straight through a clip untouched, and the
 *   drawing came back looking barely cut.
 * @returns {{paths:any[], circles:any[], droppedPaths:number,
 *            droppedCircles:number, clippedPaths:number}}
 */
export function clipDrawing(drawing, rings, o = {}) {
  const keep = o.keep || (() => false);
  const paths = [];
  const circles = [];
  let droppedPaths = 0, droppedCircles = 0, clippedPaths = 0;

  for (const p of drawing.paths) {
    if (keep(p)) { paths.push(p); continue; }
    const pieces = clipPathToRings(p.pts, p.closed, rings);
    if (!pieces.length) { droppedPaths++; continue; }
    // ⚠️ A CLIPPED CLOSED RING COMES BACK OPEN, and it must be marked open.
    // Left flagged closed, the DXF writer would join its two loose ends across
    // the boundary — a cut straight through the tile.
    //
    // ⚠️ A RING THAT SURVIVED WHOLE COMES BACK ONE VERTEX LONGER, because the
    // walk closes it explicitly where the input left the closure implicit.
    // Comparing raw lengths therefore called every untouched ring "clipped"
    // and stripped its closed flag — which is the same broken-open cut, just
    // arrived at from the other side.
    // ⚠️ THE VERTEX COUNT ALONE DOES NOT PROVE A PATH WAS UNTOUCHED. A
    // two-point line crossing the region comes back as two points as well —
    // different ones. Counting only, a hatch mark clipped at the boundary was
    // declared whole and pushed back with its ORIGINAL, unclipped coordinates,
    // so ink ran straight out of the tile. The start point has to match too.
    const expect = p.closed ? p.pts.length + 2 : p.pts.length;
    const whole = pieces.length === 1 && pieces[0].length === expect
      && pieces[0][0] === p.pts[0] && pieces[0][1] === p.pts[1]
      && (p.closed
        || (pieces[0][expect - 2] === p.pts[expect - 2]
          && pieces[0][expect - 1] === p.pts[expect - 1]));
    if (whole) { paths.push(p); continue; }              // untouched, flag and all
    clippedPaths++;
    for (const q of pieces) paths.push({ ...p, pts: q, closed: false });
  }

  for (const c of drawing.circles) {
    if (keep(c)) { circles.push(c); continue; }
    // Whole or not at all: the centre inside is not enough, the rim must be too.
    if (!pointInRings(c.cx, c.cy, rings)) { droppedCircles++; continue; }
    const r = c.r;
    let ok = true;
    for (let a = 0; a < 8; a++) {
      const th = (a / 8) * Math.PI * 2;
      if (!pointInRings(c.cx + r * Math.cos(th), c.cy + r * Math.sin(th), rings)) { ok = false; break; }
    }
    if (!ok) { droppedCircles++; continue; }
    circles.push(c);
  }

  return { paths, circles, droppedPaths, droppedCircles, clippedPaths };
}
