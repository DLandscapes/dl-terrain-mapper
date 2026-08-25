// @ts-check
// CONTOURS AS CONTINUOUS POLYLINES — the fabricable form of a contour line.
//
// ⚠️ THIS MODULE EXISTS BECAUSE OF ONE HARD-WON FACT: A LASER MUST BE GIVEN
// PATHS, NOT SEGMENTS. An early contour prototype in this family emitted ~3,700
// short dashes for a single drawing where the same picture is 55 continuous
// paths. Both draw the same ink on screen. On a machine they are not the same
// thing at all: every dash is a separate pierce, a head acceleration and a
// deceleration, so the job takes many times longer, the head stutters audibly,
// and each restart leaves a witness mark on the material. The chaining pass at
// the bottom of this file IS the feature. Nothing here may return raw segments.
//
// ⚠️ THE MARCHING IS PER TRIANGLE, NOT PER QUAD — inherited from
// DL-TerrainDiversity's tracer, and kept for a reason that survives the move
// into two dimensions: A TRIANGLE HAS NO SADDLE AMBIGUITY. Marching squares
// must decide how to join four crossings when two opposite corners are high and
// two are low; the choice is a convention, different libraries choose
// differently on the same data, and the wrong choice welds two hills together
// or splits one. Three vertices admit exactly zero or two crossings, so there
// is no table to mistype and no convention to get wrong.
//
// ⚠️ CROSSINGS ARE KEYED BY THE GRID EDGE THEY LIE ON, NOT BY THEIR
// COORDINATES. This is what makes chaining exact. Two triangles sharing an edge
// each compute that edge's crossing point; keyed on the float pair, joining
// them means comparing floats with a tolerance, and the right tolerance depends
// on cell size, on the level, and on where in the world the tile sits. Keyed on
// the ordered pair of grid-point indices, the join is an integer equality that
// is always right. The interpolation is additionally forced into a canonical
// (lower index → higher index) order so the two triangles compute bit-identical
// coordinates, which keeps the emitted geometry watertight as well.

/**
 * The levels crossing an elevation range, as exact multiples of the interval.
 *
 * ⚠️ ANCHORED TO ZERO, NOT TO THE TILE'S OWN MINIMUM. Lines land on 77.0 and
 * 77.5 rather than on "the bottom of this raster plus half a metre", so two
 * neighbouring tiles of one site draw the same set and a re-clipped extent does
 * not move every line on the sheet.
 *
 * @param {number} zmin @param {number} zmax @param {number} interval
 * @param {number} [limit] refuse rather than return more levels than this
 * @returns {number[]} ascending
 */
export function contourLevels(zmin, zmax, interval, limit = 2000) {
  if (!(interval > 0) || !Number.isFinite(zmin) || !Number.isFinite(zmax)) return [];
  if (zmax < zmin) return [];
  const k0 = Math.ceil(zmin / interval), k1 = Math.floor(zmax / interval);
  if (k1 < k0) return [];
  // A guard, not a nicety: an interval below the raster's vertical resolution
  // asks for hundreds of thousands of levels, and the tool would appear to hang
  // while building line work too dense to read, let alone cut.
  if (k1 - k0 + 1 > limit) return [];
  const out = [];
  for (let k = k0; k <= k1; k++) out.push(k * interval);
  return out;
}

/**
 * A sensible interval from the 1-2-5 series.
 *
 * The same series the scale bar and the symbol legend use, because a contour
 * interval is read off a drawing and multiplied in the head: 0.25 m is a number
 * people can count in where 0.3 m is not.
 * @param {number} relief @param {number} [target] roughly how many lines
 */
export function niceInterval(relief, target = 12) {
  if (!(relief > 0)) return 1;
  const raw = relief / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1.5 ? 1 : n <= 3.5 ? 2 : n <= 7.5 ? 5 : 10) * mag;
}

/**
 * @typedef {object} Polyline
 * @property {Float64Array} pts   x,y interleaved, MAP units
 * @property {boolean} closed     first point is not repeated at the end
 * @property {number} level       the elevation this line stands for
 * @property {boolean} index      true when this level is an index contour
 */

/**
 * Trace one raster into continuous contour polylines.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {number} interval
 * @param {{levels?:number[], indexEvery?:number, minPoints?:number,
 *          minLength?:number}} [opts]
 *   `indexEvery` marks every nth level from zero as an index contour — from
 *   zero, so the heavy lines do not move when the extent changes. `minLength`
 *   drops paths shorter than this in MAP units, which removes the one- and
 *   two-segment scraps that survive around nodata edges and would each cost a
 *   pierce.
 * @returns {Polyline[]}
 */
export function traceContours(dem, interval, opts = {}) {
  // ⚠️ THE RASTER IS EXTENDED BY ONE CELL BEFORE TRACING, AND THE RESULT IS
  // CLIPPED BACK. Elevations live at cell CENTRES, so a tracer working on them
  // directly can never reach past the outermost centre — every drawing came out
  // inset by half a cell on all four sides. Alone that is invisible and
  // arguably correct. On a TILED SET it is not: Marc's 45 LAR3072 plates abut
  // exactly (A1 ends where B1 begins), so every seam in the assembled model
  // carried a 1 m strip of blank ground — half a cell from each neighbour —
  // which at 1:200 is 5 mm of empty paper at every join, on the object.
  //
  // The extension replicates the edge values outward. In that ring the value is
  // constant along the normal and varies only along the edge, so an iso-line
  // entering it runs straight out to the boundary — which is the honest
  // continuation: it states "this contour reaches the edge here" and invents no
  // shape. Clipping to the declared extent then trims the outer half of the
  // ring away. NaN replicates as NaN, so nodata still invents nothing.
  const src = opts.edge === "centres" ? dem : padByOneCell(dem);
  const clip = src !== dem
    ? { x0: dem.originX, x1: dem.originX + dem.ncols * dem.cell,
        y0: dem.originY - dem.nrows * dem.cell, y1: dem.originY }
    : null;
  return traceRaw(src, interval, opts, clip);
}

/** One ring of replicated edge cells, so the traced field covers the extent. */
function padByOneCell(dem) {
  const { nrows, ncols, cell, z } = dem;
  const R = nrows + 2, C = ncols + 2;
  const out = new Float32Array(R * C);
  for (let r = 0; r < R; r++) {
    const sr = Math.min(nrows - 1, Math.max(0, r - 1));
    for (let c = 0; c < C; c++) {
      const sc = Math.min(ncols - 1, Math.max(0, c - 1));
      out[r * C + c] = z[sr * ncols + sc];
    }
  }
  return {
    nrows: R, ncols: C, cell, z: out,
    originX: dem.originX - cell, originY: dem.originY + cell,
    crs: dem.crs, name: dem.name,
  };
}

/**
 * Everything of a path inside an axis-aligned rectangle. Liang–Barsky.
 *
 * Exported because the compiler needs the same operation in SHEET space: with
 * several rasters on one drawing, a layer covering more ground than the primary
 * has to be trimmed at the sheet edge. One clipper, two coordinate systems.
 */
export function clipToRect(pts, closed, r) {
  const n = pts.length / 2;
  if (n < 2) return [];
  const inside = (x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  // Whole-path fast path: the common case by far, and it preserves closedness.
  let allIn = true;
  for (let i = 0; i < n && allIn; i++) if (!inside(pts[i * 2], pts[i * 2 + 1])) allIn = false;
  if (allIn) return [{ pts, closed }];

  const seq = [];
  const N = closed ? n + 1 : n;
  for (let i = 0; i < N; i++) seq.push(i % n);

  const out = [];
  let cur = null;
  const push = (x, y) => { (cur ??= []).push(x, y); };
  const flush = () => { if (cur && cur.length >= 4) out.push({ pts: Float64Array.from(cur), closed: false }); cur = null; };

  for (let k = 0; k < seq.length - 1; k++) {
    const a = seq[k], b = seq[k + 1];
    let ax = pts[a * 2], ay = pts[a * 2 + 1];
    let bx = pts[b * 2], by = pts[b * 2 + 1];
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    const test = (p, q) => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
      return true;
    };
    const ok = test(-dx, ax - r.x0) && test(dx, r.x1 - ax)
            && test(-dy, ay - r.y0) && test(dy, r.y1 - ay);
    if (!ok) { flush(); continue; }
    const p0 = [ax + dx * t0, ay + dy * t0];
    const p1 = [ax + dx * t1, ay + dy * t1];
    if (!cur) push(p0[0], p0[1]);
    push(p1[0], p1[1]);
    if (t1 < 1) flush();                      // leaves the rectangle here
  }
  flush();
  return out;
}

/** @param {{x0:number,x1:number,y0:number,y1:number}|null} clip */
function traceRaw(dem, interval, opts, clip) {
  const { nrows, ncols, cell, z, originX, originY } = dem;
  if (nrows < 2 || ncols < 2) return [];

  let levels = opts.levels;
  if (!levels) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < z.length; i++) {
      const v = z[i];
      if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    levels = contourLevels(lo, hi, interval);
  }
  if (!levels.length) return [];

  const indexEvery = Math.max(0, Math.round(opts.indexEvery ?? 0));
  const minPoints = Math.max(2, Math.round(opts.minPoints ?? 2));
  const minLength = opts.minLength ?? 0;

  const out = [];
  for (const level of levels) {
    // ⚠️ THE LEVEL IS NUDGED OFF THE DATA, NOT THE DATA OFF THE LEVEL. Ground
    // sitting exactly at a round elevation is common — a flat pad, a water
    // surface, a filled plateau — and a vertex exactly ON the level produces
    // degenerate zero-length crossings and, worse, disagreeing answers in the
    // two triangles that share it. Offsetting the level by a fraction far below
    // the raster's own precision makes every comparison strict, costs 0.0001 mm
    // on the sheet, and gives a plateau at exactly 77.0 m the correct answer:
    // the line runs round the edge of the pad, not through the middle of it.
    const L = level + (Math.abs(level) + 1) * 1e-9;
    const segs = marchLevel(dem, L);
    if (!segs.count) continue;
    const isIndex = indexEvery > 0 &&
      Math.abs(Math.round(level / interval)) % indexEvery === 0;
    for (const chain of chainSegments(segs, ncols, cell, originX, originY)) {
      // ⚠️ CLIP FIRST, THEN FILTER BY LENGTH. A path that is mostly outside the
      // extent can be long before the clip and a scrap after it; testing the
      // unclipped length would keep exactly the fragments the filter exists to
      // remove, and only at the edges — where they are least wanted.
      const pieces = clip ? clipToRect(chain.pts, chain.closed, clip)
                          : [{ pts: chain.pts, closed: chain.closed }];
      for (const piece of pieces) {
        const n = piece.pts.length / 2;
        if (n < minPoints) continue;
        if (minLength > 0 && pathLength(piece.pts, piece.closed) < minLength) continue;
        out.push({ pts: piece.pts, closed: piece.closed, level, index: isIndex });
      }
    }
  }
  return out;
}

/** Total run of a path in map units. @param {Float64Array} p @param {boolean} closed */
export function pathLength(p, closed) {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  if (closed && p.length >= 4) s += Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]);
  return s;
}

/**
 * Marching, per triangle, over the whole grid at one level.
 *
 * Returns parallel arrays rather than objects: one level of a 1024² raster can
 * produce tens of thousands of crossings, and an object per segment is an
 * allocation per segment on a path the user waits for.
 *
 * @param {import("./dem.js").DEM} dem @param {number} L the nudged level
 */
function marchLevel(dem, L) {
  const { nrows, ncols, z } = dem;
  // Grow-on-demand parallel arrays. The grid's perimeter is a fair first guess
  // for a single level and doubles at most a few times.
  let cap = Math.max(256, (nrows + ncols) * 2);
  let ka = new Float64Array(cap), kb = new Float64Array(cap);
  let ax = new Float64Array(cap), ay = new Float64Array(cap);
  let bx = new Float64Array(cap), by = new Float64Array(cap);
  let n = 0;
  const grow = () => {
    cap *= 2;
    const g = (a) => { const t = new Float64Array(cap); t.set(a); return t; };
    ka = g(ka); kb = g(kb); ax = g(ax); ay = g(ay); bx = g(bx); by = g(by);
  };

  const N = nrows * ncols;
  // Crossing coordinates are produced in the tracer's own frame — x east in
  // cells, y SOUTH in cells from the north edge — and converted to map units
  // once, in the chaining pass, so this hot loop stays in small numbers.

  /** Crossing on the edge between grid points i and j, canonically ordered. */
  const cross = (i, j) => {
    const lo = i < j ? i : j, hi = i < j ? j : i;
    const zl = z[lo], zh = z[hi];
    const t = (L - zl) / (zh - zl);
    const lr = (lo / ncols) | 0, lc = lo - lr * ncols;
    const hr = (hi / ncols) | 0, hc = hi - hr * ncols;
    return {
      k: lo * N + hi,
      x: lc + t * (hc - lc) + 0.5,
      y: lr + t * (hr - lr) + 0.5,
    };
  };

  /** One CCW triangle, by grid-point index. */
  const tri = (i0, i1, i2) => {
    const z0 = z[i0], z1 = z[i1], z2 = z[i2];
    if (!Number.isFinite(z0) || !Number.isFinite(z1) || !Number.isFinite(z2)) return;
    const a0 = z0 > L, a1 = z1 > L, a2 = z2 > L;
    const above = (a0 ? 1 : 0) + (a1 ? 1 : 0) + (a2 ? 1 : 0);
    if (above === 0 || above === 3) return;
    // ⚠️ ORIENTATION IS PART OF THE OUTPUT, NOT A SIDE EFFECT. Every segment is
    // emitted with the HIGH ground on its left. Two things depend on it: the
    // chaining below can then treat each crossing as the end of exactly one
    // path and the start of exactly one other, which makes the walk a lookup
    // instead of a search; and closed rings come out consistently wound, so a
    // downstream reader can tell a summit ring from a basin ring without
    // sampling the raster again.
    const v = [i0, i1, i2];
    let p, q;
    if (above === 1) {                       // one vertex high: k → k+1, k → k−1
      const k = a0 ? 0 : a1 ? 1 : 2;
      p = cross(v[k], v[(k + 1) % 3]);
      q = cross(v[k], v[(k + 2) % 3]);
    } else {                                 // one vertex low: k → k−1, k → k+1
      const k = !a0 ? 0 : !a1 ? 1 : 2;
      p = cross(v[k], v[(k + 2) % 3]);
      q = cross(v[k], v[(k + 1) % 3]);
    }
    if (p.k === q.k) return;                 // degenerate; unreachable post-nudge
    if (n >= cap) grow();
    ka[n] = p.k; kb[n] = q.k;
    ax[n] = p.x; ay[n] = p.y; bx[n] = q.x; by[n] = q.y;
    n++;
  };

  for (let r = 0; r < nrows - 1; r++) {
    for (let c = 0; c < ncols - 1; c++) {
      const a = r * ncols + c, b = a + 1, d = a + ncols, e = d + 1;
      // Cheap rejection first: a cell whose four corners sit on one side of the
      // level cannot contain it, and on a real raster that is nearly every cell
      // for nearly every level. NaN fails both comparisons, so a nodata cell
      // falls through to `tri`, which is where it is properly refused.
      const za = z[a], zb = z[b], zd = z[d], ze = z[e];
      const lo = Math.min(za, zb, zd, ze), hi = Math.max(za, zb, zd, ze);
      if (lo > L || hi < L) continue;
      // Split on the ANTI-diagonal b–d, the same split DL-TerrainDiversity's
      // surface uses, so a model built there and a drawing built here cannot
      // disagree about where a line runs.
      tri(a, d, b);
      tri(b, d, e);
    }
  }
  return { count: n, ka, kb, ax, ay, bx, by };
}

/**
 * Segments into continuous paths. THE point of this module.
 *
 * Because every segment runs high-on-left, an interior crossing is the B end of
 * exactly one segment and the A end of exactly one other. Chains are therefore
 * walked by lookup: from a segment, its B key names the next segment's A key.
 * A crossing that is only ever a B end sits on the raster's border or against
 * nodata, and is where an open path ends.
 *
 * ⚠️ OPEN PATHS ARE WALKED FIRST, CLOSED RINGS SECOND, AND THE ORDER MATTERS.
 * Seeding inside an open path yields two half-paths — two pierces where the
 * material needs one, and a join in the middle of a line where the eye finds it.
 */
function chainSegments(segs, ncols, cell, originX, originY) {
  const { count, ka, kb, ax, ay, bx, by } = segs;
  /** @type {Map<number, number>} crossing key → index of the segment STARTING there */
  const startAt = new Map();
  /** @type {Set<number>} every key that is some segment's END */
  const isEnd = new Set();
  for (let i = 0; i < count; i++) { startAt.set(ka[i], i); isEnd.add(kb[i]); }

  const used = new Uint8Array(count);
  const out = [];
  // Cell units → map units. Row 0 is the north edge, so y runs south and the
  // northing decreases: this is the single place that flip happens.
  const MX = (x) => originX + x * cell;
  const MY = (y) => originY - y * cell;

  /** @param {number} seed @param {boolean} closed */
  const walk = (seed, closed) => {
    const xs = [], ys = [];
    let i = seed;
    xs.push(ax[i]); ys.push(ay[i]);
    for (;;) {
      used[i] = 1;
      xs.push(bx[i]); ys.push(by[i]);
      const nx = startAt.get(kb[i]);
      if (nx === undefined || used[nx]) break;
      i = nx;
    }
    if (closed && xs.length > 1) { xs.pop(); ys.pop(); }   // ring: no repeated point
    const pts = new Float64Array(xs.length * 2);
    for (let j = 0; j < xs.length; j++) {
      pts[j * 2] = MX(xs[j]);
      pts[j * 2 + 1] = MY(ys[j]);
    }
    out.push({ pts, closed });
  };

  for (let i = 0; i < count; i++) if (!used[i] && !isEnd.has(ka[i])) walk(i, false);
  for (let i = 0; i < count; i++) if (!used[i]) walk(i, true);
  return out;
}
