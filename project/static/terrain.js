// @ts-check
// TERRAIN INDICES — the derived surfaces this tool will compute for itself.
//
// ⚠️ THIS MODULE DELIBERATELY CROSSES A LINE THE PROJECT DREW. `symbols.js`
// said slope was "the only terrain analysis this tool computes, and it should
// stay that way", naming wetness and ruggedness as belonging to
// DL-TerrainDiversity, the analysis engine of the family. Marc asked for them
// here on 2026-08-25, for a class that cannot round-trip through another tool
// mid-exercise. That is a good enough reason, and the boundary moves — but it
// moves with its cost written down rather than quietly.
//
// ⚠️ THE COST IS THAT TWO DL TOOLS CAN NOW DISAGREE ABOUT ONE SITE. Every
// function here states the exact definition it implements, so a disagreement
// can be diagnosed instead of argued about. Where a published index has more
// than one accepted form, the choice is named in the code AND surfaced to the
// user, because "the wetness index" is not one number.
//
// ⚠️ AND THE TWO NEW ONES ARE NOT THE SAME KIND OF THING AS SLOPE. Slope and
// ruggedness read a 3x3 window: every implementation agrees, and a tile can be
// computed on its own. The wetness index needs FLOW ROUTING across the whole
// surface — where water arrives from is a global question — so:
//   · it must be computed on the WHOLE model, never per tile. A tile's TWI is
//     wrong at every edge, because the water that would have arrived from
//     outside the tile is missing. Compute over everything, then clip.
//   · its value depends on the flow algorithm, and D8, D-infinity and the
//     several multiple-flow variants give materially different answers on the
//     same ground. SAGA's default is not QGIS's default is not this one.

import { stats } from "./dem.js";

/**
 * Terrain Ruggedness Index — Riley, DeGloria & Elliot (1999).
 *
 * The square root of the summed squared differences between a cell and its
 * eight neighbours. In the same units as the elevations, so on a 1 m DTM a TRI
 * of 2 means the neighbourhood varies by roughly a couple of metres.
 *
 * ⚠️ RILEY'S FORM, NOT THE MEAN-ABSOLUTE ONE. Several tools publish a "TRI"
 * that is the mean absolute difference instead — a smaller number on the same
 * ground, by a factor that is not constant. The name alone does not tell you
 * which you have; this one is stated.
 *
 * ⚠️ NaN ANYWHERE IN THE WINDOW GIVES NaN, never a partial sum over the
 * neighbours that happen to exist. A partial sum is systematically smaller and
 * would draw a calm edge around every hole in the survey.
 *
 * @param {import("./dem.js").DEM} dem
 * @returns {Float32Array} degrees-free, elevation units
 */
export function ruggedness(dem) {
  const { nrows, ncols, z } = dem;
  const out = new Float32Array(nrows * ncols).fill(NaN);
  for (let r = 1; r < nrows - 1; r++) {
    for (let c = 1; c < ncols - 1; c++) {
      const i = r * ncols + c;
      const v = z[i];
      if (!Number.isFinite(v)) continue;
      let sum = 0, ok = true;
      for (let dr = -1; dr <= 1 && ok; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const n = z[(r + dr) * ncols + (c + dc)];
          if (!Number.isFinite(n)) { ok = false; break; }
          const d = n - v;
          sum += d * d;
        }
      }
      if (ok) out[i] = Math.sqrt(sum);
    }
  }
  return out;
}

/**
 * Roughness as GDAL defines it: the RANGE of the 3x3 window, max minus min.
 *
 * Offered beside TRI because the two are routinely called by each other's name
 * and they are not the same number. This one is the blunter and the easier to
 * explain — "how much height is there within a metre or two of here".
 *
 * @param {import("./dem.js").DEM} dem
 * @returns {Float32Array}
 */
export function roughness(dem) {
  const { nrows, ncols, z } = dem;
  const out = new Float32Array(nrows * ncols).fill(NaN);
  for (let r = 1; r < nrows - 1; r++) {
    for (let c = 1; c < ncols - 1; c++) {
      let lo = Infinity, hi = -Infinity, ok = true;
      for (let dr = -1; dr <= 1 && ok; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const n = z[(r + dr) * ncols + (c + dc)];
          if (!Number.isFinite(n)) { ok = false; break; }
          if (n < lo) lo = n;
          if (n > hi) hi = n;
        }
      }
      if (ok) out[r * ncols + c] = hi - lo;
    }
  }
  return out;
}

/**
 * Fill the depressions, so water has somewhere to go.
 *
 * Priority-flood (Barnes, Lehman & Mulla 2014): start from every edge and every
 * cell beside nodata, always expand from the lowest cell reached so far, and
 * raise each new cell to at least the level it was reached at.
 *
 * ⚠️ WITHOUT THIS, FLOW ACCUMULATION STOPS AT EVERY PIT. A real DTM is full of
 * one-cell hollows — survey noise, a boulder, a culvert the laser scanner could
 * not see through — and each one swallows the water arriving at it. The wetness
 * index then shows dry ground exactly where a hollow is, which is the opposite
 * of the truth.
 *
 * ⚠️ FILLED ELEVATIONS ARE USED FOR ROUTING ONLY. The slope in the TWI comes
 * from the ORIGINAL surface, because a filled pit has zero slope by
 * construction and would return an infinite wetness for a hole in the data.
 *
 * @param {import("./dem.js").DEM} dem
 * @returns {Float32Array} filled elevations, NaN preserved
 */
export function fillDepressions(dem) {
  const { nrows, ncols, z } = dem;
  const n = nrows * ncols;
  const filled = new Float32Array(n).fill(NaN);
  const done = new Uint8Array(n);
  // A binary heap of [elevation, index]; small and dependency-free.
  const heapV = [], heapI = [];
  const push = (v, i) => {
    heapV.push(v); heapI.push(i);
    let k = heapV.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapV[p] <= heapV[k]) break;
      [heapV[p], heapV[k]] = [heapV[k], heapV[p]];
      [heapI[p], heapI[k]] = [heapI[k], heapI[p]];
      k = p;
    }
  };
  const pop = () => {
    const topV = heapV[0], topI = heapI[0];
    const lastV = heapV.pop(), lastI = heapI.pop();
    if (heapV.length) {
      heapV[0] = lastV; heapI[0] = lastI;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r2 = l + 1;
        let m = k;
        if (l < heapV.length && heapV[l] < heapV[m]) m = l;
        if (r2 < heapV.length && heapV[r2] < heapV[m]) m = r2;
        if (m === k) break;
        [heapV[m], heapV[k]] = [heapV[k], heapV[m]];
        [heapI[m], heapI[k]] = [heapI[k], heapI[m]];
        k = m;
      }
    }
    return [topV, topI];
  };

  // Seeds: the raster's rim, and every measured cell touching nodata — water
  // leaves the model at both.
  const seed = (i) => {
    if (done[i] || !Number.isFinite(z[i])) return;
    done[i] = 1; filled[i] = z[i]; push(z[i], i);
  };
  for (let c = 0; c < ncols; c++) { seed(c); seed((nrows - 1) * ncols + c); }
  for (let r = 0; r < nrows; r++) { seed(r * ncols); seed(r * ncols + ncols - 1); }
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const i = r * ncols + c;
      if (!Number.isFinite(z[i]) || done[i]) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= nrows || cc >= ncols) continue;
          if (!Number.isFinite(z[rr * ncols + cc])) { seed(i); break; }
        }
      }
    }
  }

  while (heapV.length) {
    const [v, i] = pop();
    const r = (i / ncols) | 0, c = i % ncols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= nrows || cc >= ncols) continue;
        const j = rr * ncols + cc;
        if (done[j] || !Number.isFinite(z[j])) continue;
        done[j] = 1;
        filled[j] = Math.max(z[j], v);
        push(filled[j], j);
      }
    }
  }
  return filled;
}

/**
 * Upslope contributing area, by multiple flow direction.
 *
 * ⚠️ MULTIPLE FLOW, NOT D8, AND THE CHOICE IS VISIBLE IN THE DRAWING. D8 sends
 * all of a cell's water to its single steepest neighbour, which on a hillside
 * produces one-cell-wide threads of enormous accumulation between strips of
 * nothing. As a wetness map that is a picture of an algorithm, not of a slope.
 * Freeman's (1991) multiple-flow rule divides the water among every downslope
 * neighbour in proportion to `slope^p`, giving the diffuse hillside drainage
 * that a landscape architect is actually looking at. p = 1.1 is Freeman's own.
 *
 * ⚠️ PROCESSED HIGHEST FIRST, so a cell's own inflow is complete before it
 * passes anything on. That ordering is the whole algorithm.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {Float32Array} filled routing surface from `fillDepressions`
 * @param {{p?:number}} [o]
 * @returns {Float32Array} area in square map units
 */
export function flowAccumulation(dem, filled, o = {}) {
  const { nrows, ncols, cell } = dem;
  const n = nrows * ncols;
  const p = o.p ?? 1.1;
  const area = new Float32Array(n);
  const cellArea = cell * cell;
  for (let i = 0; i < n; i++) area[i] = Number.isFinite(filled[i]) ? cellArea : NaN;

  const order = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(filled[i])) order.push(i);
  order.sort((a, b) => filled[b] - filled[a]);

  // The contour width each direction drains across (Quinn et al. 1991): half a
  // cell for the cardinals, and the diagonal's share is smaller.
  const DIRS = [
    [-1, 0, 1, 0.5], [1, 0, 1, 0.5], [0, -1, 1, 0.5], [0, 1, 1, 0.5],
    [-1, -1, Math.SQRT2, 0.354], [-1, 1, Math.SQRT2, 0.354],
    [1, -1, Math.SQRT2, 0.354], [1, 1, Math.SQRT2, 0.354],
  ];
  const w = new Float64Array(8);
  for (const i of order) {
    const r = (i / ncols) | 0, c = i % ncols;
    const zi = filled[i];
    let tot = 0;
    for (let d = 0; d < 8; d++) {
      w[d] = 0;
      const rr = r + DIRS[d][0], cc = c + DIRS[d][1];
      if (rr < 0 || cc < 0 || rr >= nrows || cc >= ncols) continue;
      const j = rr * ncols + cc;
      const zj = filled[j];
      if (!Number.isFinite(zj) || zj >= zi) continue;
      const grad = (zi - zj) / (DIRS[d][2] * cell);
      w[d] = Math.pow(grad, p) * DIRS[d][3];
      tot += w[d];
    }
    if (tot <= 0) continue;                       // a sink or the model's edge
    const share = area[i] / tot;
    for (let d = 0; d < 8; d++) {
      if (w[d] <= 0) continue;
      const j = (r + DIRS[d][0]) * ncols + (c + DIRS[d][1]);
      area[j] += share * w[d];
    }
  }
  return area;
}

/**
 * Topographic Wetness Index — ln(a / tan β).
 *
 * `a` is the specific catchment area: upslope area per unit contour width.
 * `β` is the local slope of the ORIGINAL surface. High where a lot of ground
 * drains into somewhere flat — valley bottoms, hollows, the toe of a slope.
 *
 * ⚠️ THIS NUMBER IS NOT COMPARABLE WITH ANOTHER TOOL'S TWI UNLESS THAT TOOL
 * USED THE SAME FLOW ALGORITHM. It is a genuinely useful ordering of the
 * ground — wetter here than there — and a poor absolute quantity. Say which
 * algorithm produced it whenever a value is quoted; this one is
 * multiple-flow, Freeman p = 1.1, over a priority-flood filled surface.
 *
 * ⚠️ THE SLOPE IS FLOORED, NOT THE INDEX. tan β goes to zero on flat ground and
 * the logarithm to infinity; clamping β to a small minimum keeps the value
 * finite and, more importantly, keeps the flat ground at the TOP of the range
 * where it belongs, instead of at an infinity that would flatten every other
 * value in the drawing against the bottom of the scale.
 *
 * ⚠️ COMPUTE IT ON THE WHOLE MODEL, THEN CLIP. A tile's own TWI is wrong at
 * every edge: the water arriving from outside the tile is simply missing.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {{minSlope?:number, p?:number}} [o] `minSlope` as tan β, default 0.001
 * @returns {Float32Array}
 */
export function wetnessIndex(dem, o = {}) {
  const { nrows, ncols, cell, z } = dem;
  const n = nrows * ncols;
  const filled = fillDepressions(dem);
  const area = flowAccumulation(dem, filled, { p: o.p });
  const minSlope = o.minSlope ?? 0.001;
  const out = new Float32Array(n).fill(NaN);
  for (let r = 1; r < nrows - 1; r++) {
    for (let c = 1; c < ncols - 1; c++) {
      const i = r * ncols + c;
      if (!Number.isFinite(area[i])) continue;
      // Horn's gradient on the ORIGINAL surface — see fillDepressions.
      let ok = true;
      const w = [];
      for (let dr = -1; dr <= 1 && ok; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const v = z[(r + dr) * ncols + (c + dc)];
          if (!Number.isFinite(v)) { ok = false; break; }
          w.push(v);
        }
      }
      if (!ok) continue;
      const [a, b, cc2, d, , f, g, h, i2] = w;
      const dzdx = ((cc2 + 2 * f + i2) - (a + 2 * d + g)) / (8 * cell);
      const dzdy = ((g + 2 * h + i2) - (a + 2 * b + cc2)) / (8 * cell);
      const tanB = Math.max(Math.hypot(dzdx, dzdy), minSlope);
      const specific = area[i] / cell;            // area per unit contour width
      out[i] = Math.log(specific / tanB);
    }
  }
  return out;
}

/**
 * A one-line description of what a derived surface actually is, for the report
 * and the readout. ⚠️ An index drawn without its definition is a picture.
 * @param {string} kind
 */
export function indexNote(kind) {
  switch (kind) {
    case "slope": return "slope in degrees, Horn's method";
    case "tri": return "Terrain Ruggedness Index (Riley 1999), elevation units";
    case "roughness": return "roughness: the 3x3 range, max minus min, elevation units";
    case "twi": return "Topographic Wetness Index, ln(a/tan B) — multiple-flow "
      + "(Freeman p=1.1) over a priority-flood filled surface. Not comparable with "
      + "another tool's TWI unless it used the same flow algorithm";
    default: return kind;
  }
}
