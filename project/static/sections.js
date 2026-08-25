// @ts-check
// SECTIONS — the ground cut open and drawn as a profile.
//
// The fourth translation of a raster into laser marks. Contours put the value
// in a line's POSITION, the circle grid in a symbol's SIZE, hatching in the
// DENSITY of ink; a section abandons the plan entirely and plots the value
// against DISTANCE ALONG A CUT. It is the drawing that answers "how steep is
// it, really" — the question a plan of contours is worst at.
//
// ⚠️ THE PROFILE RIDES ON ITS OWN CUT LINE, IN PLACE. It is not stacked in a
// margin, for a reason that is structural rather than aesthetic: this tool's
// sheet is defined by the primary raster and a margin of ZERO is the default,
// because Marc's plates abut. There is no reserved space to stack profiles in,
// and inventing some would resize the sheet — which would silently turn a
// plate that must tile with its neighbours into one that no longer does. So
// the section is engraved across the plan it belongs to, at the exact line it
// was taken along. A hybrid plan-and-profile drawing is an old and honest
// landscape convention, and here it is also the only one that fabricates.
//
// ⚠️ VERTICAL EXAGGERATION IS SET IN MILLIMETRES AND REPORTED AS A FACTOR.
// The caller says how tall the profile may stand on the sheet, which is the
// constraint that actually exists (it must not collide with its neighbour or
// run off the material), and this module computes what exaggeration that came
// to and hands it back to be stated on the drawing. A section whose
// exaggeration is not stated is a section that lies about the slope, and every
// reader of a landscape section knows to look for the number.
//
// ⚠️ NODATA BREAKS THE PROFILE, IT DOES NOT BRIDGE IT. A profile drawn across
// an unmeasured gap invents ground, smoothly and invisibly, exactly where the
// survey stopped. Each run of measured samples leaves as its own path.

import { sampleBilinear, toGrid } from "./dem.js";

/**
 * @typedef {object} Section
 * @property {string} label      "A", "B", … the tick at each end reads A–A′
 * @property {number} atFraction 0..1 across the raster, 0.5 = the centre
 * @property {number[]} line     x0,y0,x1,y1 — the cut, in MAP units
 * @property {Float64Array[]} profile  paths in MAP units, already offset onto
 *   the cut line and vertically exaggerated; one path per measured run
 * @property {number} min        the lowest value on this cut
 * @property {number} max        the highest
 * @property {number} exaggeration  the true vertical exaggeration, ×
 * @property {number} gaps       runs of nodata this profile was broken by
 */

/**
 * Cut a raster with evenly spaced parallel sections.
 *
 * ⚠️ THE SPACING PUTS ONE CUT EXACTLY THROUGH THE CENTRE WHEN THE COUNT IS
 * ODD — fractions are i/(n+1), so three sections land on 0.25, 0.50, 0.75.
 * Marc asked for "three sections running horizontally through the centre of
 * the plate", and the middle one being the centre line rather than merely near
 * it is the difference between a drawing you can trust and one you cannot.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {{count?:number, axis?:"horizontal"|"vertical", heightUnits?:number,
 *          datum?:"own"|"shared", samples?:number, sharedMin?:number,
 *          sharedMax?:number}} [opts]
 *   `heightUnits` how tall a profile may stand, in MAP units (the compiler
 *   converts millimetres). `datum` "own" scales each section to its own
 *   relief — best for reading one cut; "shared" scales them all together, so
 *   the three can be compared with each other.
 * @returns {{sections:Section[], exaggeration:number, shared:boolean}}
 */
export function cutSections(dem, opts = {}) {
  const count = Math.max(1, Math.min(24, Math.round(opts.count ?? 3)));
  const axis = opts.axis === "vertical" ? "vertical" : "horizontal";
  const heightUnits = opts.heightUnits > 0 ? opts.heightUnits : dem.cell * 8;
  const shared = opts.datum === "shared";
  const groundW = dem.ncols * dem.cell, groundH = dem.nrows * dem.cell;
  const south = dem.originY - groundH;
  // One sample per cell along the cut: finer invents detail the raster has
  // not got, coarser throws away ground the survey paid for.
  const along = axis === "horizontal" ? groundW : groundH;
  const n = Math.max(2, Math.round(opts.samples ?? along / dem.cell));
  // The outermost positions bilinear will still interpolate at (see the note
  // at the sample call). One millionth of a cell inside the last cell centre.
  const ncolsEdge = Math.max(0.5, dem.ncols - 0.5 - 1e-6);
  const nrowsEdge = Math.max(0.5, dem.nrows - 0.5 - 1e-6);

  // Pass one: sample every cut, so a shared datum can be found before any
  // geometry is built.
  const raw = [];
  let gMin = Infinity, gMax = -Infinity;
  for (let i = 1; i <= count; i++) {
    const f = i / (count + 1);
    const vals = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const t = n === 1 ? 0.5 : j / (n - 1);
      const X = axis === "horizontal" ? dem.originX + t * groundW
                                      : dem.originX + f * groundW;
      const Y = axis === "horizontal" ? south + (1 - f) * groundH
                                      : south + (1 - t) * groundH;
      // ⚠️ CLAMPED IN GRID SPACE, JUST INSIDE THE LAST CELL CENTRE. A profile
      // runs from edge to edge of the raster, and both ends land exactly where
      // `sampleBilinear` refuses to interpolate — the boundary has no fourth
      // corner. Deliberately strict, and right: substituting a neighbour there
      // would invent ground. But a section must not lose its ends over it, so
      // the sample is pulled a hair inside the outermost cell centres, where
      // the interpolation is honest and the value is that cell's to within
      // a millionth of a cell.
      const g = toGrid(dem, X, Y);
      const v = sampleBilinear(dem,
        clamp(g.gx, 0.5, ncolsEdge), clamp(g.gy, 0.5, nrowsEdge));
      vals[j] = v;
      if (Number.isFinite(v)) { if (v < gMin) gMin = v; if (v > gMax) gMax = v; }
    }
    raw.push({ f, vals });
  }
  if (!Number.isFinite(gMin)) return { sections: [], exaggeration: 0, shared };

  // Pass two: geometry. The scale is values → map units across the profile's
  // allowed height; the exaggeration is that scale, since one map unit
  // horizontally is one map unit on the ground by definition.
  const sections = [];
  let reported = 0;
  for (let i = 0; i < raw.length; i++) {
    const { f, vals } = raw[i];
    let lo = Infinity, hi = -Infinity, gaps = 0;
    for (const v of vals) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = 0; hi = 0; }
    const dLo = shared ? gMin : lo, dHi = shared ? gMax : hi;
    const relief = dHi - dLo;
    // ⚠️ A FLAT CUT GETS A FLAT LINE, NOT AN INFINITE ONE. Dividing by a zero
    // relief would send the whole profile to infinity and take the DXF with it.
    const k = relief > 0 ? heightUnits / relief : 0;
    if (k > reported) reported = k;

    const baseY = axis === "horizontal" ? south + (1 - f) * groundH : 0;
    const baseX = axis === "vertical" ? dem.originX + f * groundW : 0;
    /** @type {Float64Array[]} */
    const profile = [];
    /** @type {number[]} */
    let run = [];
    const flush = () => {
      if (run.length >= 4) profile.push(Float64Array.from(run));
      else if (run.length) gaps++;                 // a lone sample is not a line
      run = [];
    };
    let wasGap = false;
    for (let j = 0; j < n; j++) {
      const v = vals[j];
      if (!Number.isFinite(v)) { if (!wasGap && run.length) { flush(); gaps++; } wasGap = true; continue; }
      wasGap = false;
      const t = n === 1 ? 0.5 : j / (n - 1);
      const rise = (v - dLo) * k;
      if (axis === "horizontal") {
        run.push(dem.originX + t * groundW, baseY + rise);
      } else {
        // A vertical cut plots its rise EASTWARD, so the profile leans off its
        // own line the same way a horizontal one leans north.
        run.push(baseX + rise, south + (1 - t) * groundH);
      }
    }
    flush();

    sections.push({
      label: String.fromCharCode(65 + (i % 26)),
      atFraction: f,
      line: axis === "horizontal"
        ? [dem.originX, baseY, dem.originX + groundW, baseY]
        : [baseX, south, baseX, south + groundH],
      profile, min: lo, max: hi,
      exaggeration: k, gaps,
    });
  }
  return { sections, exaggeration: reported, shared };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
