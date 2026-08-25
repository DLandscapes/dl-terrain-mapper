// @ts-check
// PROPORTIONAL SYMBOLS — a field read as SIZE instead of as tone.
//
// A colour ramp shows a field and hides a value: nobody looks at a shade of
// blue and says "that is 0.6". A circle whose diameter is the value is the
// opposite trade — it gives up the smooth surface and can be measured against a
// legend, one symbol at a time. On a laser that trade is not optional. The
// machine draws marks; it has no tone.
//
// ⚠️ THIS IS MARC'S HADSELØYA TECHNIQUE (digital-landscapes.com, 2017),
// GENERALISED. The sampling rules below are ported from DL-TerrainDiversity's
// symbols.js, where the same technique already carries the depth of cut and
// fill on the grading plan. Two implementations of one idea drift apart, so the
// RULES are copied deliberately and stated here rather than re-derived: sampled
// at a stride and never one per cell, anchored from the centre, NaN gets no
// circle, diameter linear in the value. What is new here is that several
// attributes may coexist, each keeping its own FILL-AND-STROKE IDENTITY — which
// on a laser means its own pass layer.
//
// ⚠️ SIZE IS THE DATUM, AND THE SECOND VARIABLE MUST BE REAL. Giving one
// quantity both a diameter and an identity encodes it twice and invites a
// reader to hunt for a distinction that is not there. Open-versus-filled is
// reserved for something a circle cannot say by size: a SIGN (cut against
// fill), or a genuinely different measurement.

/**
 * @typedef {object} Symbol
 * @property {number} x   map units
 * @property {number} y
 * @property {number} r   map units
 * @property {number} v   the value it stands for
 */

/**
 * A stride giving roughly `target` symbols across the wider side.
 *
 * ⚠️ CHOSEN FROM THE GRID, NOT FIXED. What a reader can take in is the number
 * of SYMBOLS, not the number of cells between them, and the same stride that
 * reads well on a 256² patch is unreadable on a 2048² tile.
 * @param {number} nrows @param {number} ncols @param {number} [target]
 */
export function strideFor(nrows, ncols, target = 40) {
  return Math.max(1, Math.round(Math.max(nrows, ncols) / Math.max(4, target)));
}

/**
 * Where symbols go and how big each one is.
 *
 * @param {Float32Array|Float64Array|Int32Array} grid one value per cell, NaN = no answer
 * @param {{nrows:number, ncols:number, cell:number, originX:number, originY:number}} frame
 * @param {{lo?:number, hi?:number, stride?:number, minFraction?:number,
 *          threshold?:number, maxFraction?:number, invert?:boolean}} [opts]
 * @returns {Symbol[]}
 */
export function symbolField(grid, frame, opts = {}) {
  const out = [];
  const { nrows, ncols, cell, originX, originY } = frame;
  if (!grid || grid.length !== nrows * ncols) return out;
  const stride = Math.max(1, Math.round(opts.stride ?? 1));
  const threshold = opts.threshold ?? 0;
  const minF = opts.minFraction ?? 0.08;
  const maxF = opts.maxFraction ?? 1;

  let lo = opts.lo, hi = opts.hi;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  const span = hi - lo;
  // The full-size circle spans the sample spacing, so neighbouring maxima just
  // touch at maxFraction 1 — the density the eye reads as "solid".
  const full = (stride * cell * maxF) / 2;
  // ⚠️ THE SAMPLE GRID IS ANCHORED TO THE WORLD, NOT TO THIS RASTER.
  //
  // It used to start from the raster's own centre, so the pattern would not
  // slide when the stride changed — pleasant while dragging a slider, and
  // wrong for the thing this tool is actually for. It made the grid a property
  // of the TILE instead of the GROUND: two plates that abut exactly sampled on
  // different phases, and at the seam their nearest rows of circles landed 1 m
  // apart where the spacing was 3 m — a doubled row down the join, on plates
  // meant to be indistinguishable from one surface.
  //
  // Anchored to the world, a cell is sampled when its GLOBAL index — its
  // position on the ground, not its position in this file — is a multiple of
  // the stride. Any tile of a model then samples exactly where the whole model
  // would, and the hatch (which was fixed first, for the same reason) and the
  // circle grid agree with each other as well.
  //
  // ⚠️ Math.round is safe across tiles of one grid: two rasters on the same
  // grid share the same fractional offset, so they round the same way. Rasters
  // that do NOT share a grid were never going to tile anyway.
  const r0 = ((Math.round(originY / cell) % stride) + stride) % stride;
  const c0 = ((-Math.round(originX / cell) % stride) + stride) % stride;
  const northY = originY;

  for (let r = r0; r < nrows; r += stride) {
    for (let c = c0; c < ncols; c += stride) {
      const v = grid[r * ncols + c];
      if (!Number.isFinite(v)) continue;                 // no answer, no circle
      let t = span > 0 ? (v - lo) / span : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (opts.invert) t = 1 - t;
      if (t < threshold) continue;
      out.push({
        x: originX + (c + 0.5) * cell,
        y: northY - (r + 0.5) * cell,
        r: full * (minF + (1 - minF) * t),
        v,
      });
    }
  }
  return out;
}

/**
 * The signed field — one grid, two sets of circles, one scale.
 *
 * The grading-plan read: a change raster (2006 − 2024, say) sampled on the
 * grid, each sample a circle whose size is the magnitude of the change and
 * whose FORM is its direction. Fill and cut are told apart by pass, and the
 * pass is the form everywhere this tool draws a circle: the engrave pass is a
 * filled dot, any score pass is an open ring — solid marks are added ground,
 * rings are removed ground, with no new geometry invented for the distinction.
 *
 * ⚠️ CUT AND FILL SHARE ONE NORMALISATION, over |value| from 0 to the largest
 * magnitude either side reaches. A +2 m circle and a −2 m circle MUST be the
 * same size, or the drawing quietly claims the two directions of movement were
 * measured on different scales. This is why the split is not two independent
 * calls on the caller's side.
 *
 * ⚠️ THE SPLIT MASKS, IT DOES NOT REIMPLEMENT. Placement, centre anchoring,
 * radius mapping all come from `symbolField`, called twice on sign-masked
 * copies of the grid with the shared 0..hi domain pinned — two code paths for
 * one sampling rule would drift, and the drift would be a field of circles
 * that no longer line up between fill and cut.
 *
 * Zero is not a sign: a cell that measured exactly 0 moved in no direction and
 * gets no circle. `minAbs` (in value units) widens that dead zone so noise
 * does not become a carpet of minimum-size marks.
 *
 * @param {Float32Array|Float64Array|Int32Array} grid signed values, NaN = no answer
 * @param {{nrows:number, ncols:number, cell:number, originX:number, originY:number}} frame
 * @param {{stride?:number, minFraction?:number, maxFraction?:number,
 *          minAbs?:number, hi?:number}} [opts] `hi` pins the full-scale
 *   magnitude (for a fixed scale across drawings); default is the data's own
 * @returns {{plus:Symbol[], minus:Symbol[], hi:number}} `minus` keeps its
 *   negative `v`; radii in map units, same as symbolField
 */
export function signedSymbolField(grid, frame, opts = {}) {
  const n = frame.nrows * frame.ncols;
  const plusG = new Float32Array(n).fill(NaN);
  const minusG = new Float32Array(n).fill(NaN);
  let hi = 0;
  if (grid && grid.length === n) {
    for (let i = 0; i < n; i++) {
      const v = grid[i];
      if (!Number.isFinite(v) || v === 0) continue;
      const a = Math.abs(v);
      if (a > hi) hi = a;
      if (v > 0) plusG[i] = a; else minusG[i] = a;
    }
  }
  if (Number.isFinite(opts.hi) && opts.hi > 0) hi = opts.hi;
  if (!(hi > 0)) return { plus: [], minus: [], hi: 0 };
  const shared = {
    stride: opts.stride, minFraction: opts.minFraction, maxFraction: opts.maxFraction,
    lo: 0, hi,
    // symbolField's threshold is on the NORMALISED value, so the dead zone in
    // value units is translated here, once, against the shared scale.
    threshold: (opts.minAbs ?? 0) / hi,
  };
  const plus = symbolField(plusG, frame, shared);
  const minus = symbolField(minusG, frame, shared)
    .map((s) => ({ ...s, v: -s.v }));                 // the sign survives
  return { plus, minus, hi };
}

/**
 * The legend's reference circles.
 *
 * ⚠️ ROUND VALUES, NOT ROUND RADII. Equally spaced circles are easy to draw and
 * useless to read off, because the numbers beside them are then arbitrary.
 * These are 1-2-5 values inside the domain and their radii follow — the way
 * round that lets someone hold the legend against the drawing.
 * @param {number} lo @param {number} hi
 * @param {{stride?:number, cell?:number, minFraction?:number,
 *          maxFraction?:number, count?:number}} [opts]
 * @returns {{v:number, r:number}[]}
 */
export function symbolLegend(lo, hi, opts = {}) {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const stride = Math.max(1, Math.round(opts.stride ?? 1));
  const cell = opts.cell ?? 1;
  const minF = opts.minFraction ?? 0.08;
  const maxF = opts.maxFraction ?? 1;
  const full = (stride * cell * maxF) / 2;
  const want = Math.max(2, opts.count ?? 3);
  const raw = span / (want - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n <= 1.5 ? 1 : n <= 3.5 ? 2 : n <= 7.5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) {
    const t = (v - lo) / span;
    out.push({ v: +v.toFixed(10), r: full * (minF + (1 - minF) * t) });
  }
  return out;
}

/**
 * Slope, in degrees, by the Horn method — the derivative most likely to be
 * asked for first, and the one every GIS agrees on.
 *
 * ⚠️ THIS IS THE ONLY TERRAIN ANALYSIS THIS TOOL COMPUTES, AND IT SHOULD STAY
 * THAT WAY. DL-TerrainDiversity is the analysis engine of the family; wetness,
 * ruggedness, geodiversity and the rest belong there, and a second
 * implementation here would drift from it. Slope is carried only because a
 * symbol sheet with nothing to put on it cannot be tested. Anything richer
 * should arrive as a raster exported from that tool and be read by geotiff.js.
 * @param {import("./dem.js").DEM} dem
 * @returns {Float32Array} degrees, NaN where the 3×3 window is incomplete
 */
export function slopeDegrees(dem) {
  const { nrows, ncols, cell, z } = dem;
  const out = new Float32Array(nrows * ncols).fill(NaN);
  for (let r = 1; r < nrows - 1; r++) {
    for (let c = 1; c < ncols - 1; c++) {
      let ok = true;
      const w = [];
      for (let dr = -1; dr <= 1 && ok; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const v = z[(r + dr) * ncols + (c + dc)];
          if (!Number.isFinite(v)) { ok = false; break; }
          w.push(v);
        }
      }
      if (!ok) continue;                                  // NaN is not zero
      const [a, b, cc, d, , f, g, h, i] = w;
      const dzdx = ((cc + 2 * f + i) - (a + 2 * d + g)) / (8 * cell);
      const dzdy = ((g + 2 * h + i) - (a + 2 * b + cc)) / (8 * cell);
      out[r * ncols + c] = Math.atan(Math.hypot(dzdx, dzdy)) * (180 / Math.PI);
    }
  }
  return out;
}
