// @ts-check
// THE SHEET — where the ground turns into millimetres.
//
// ⚠️ ONE PLACE CONVERTS, AND EVERYTHING ELSE STAYS IN MAP UNITS. Contours,
// photograph positions and symbol radii are all computed on the ground, in
// metres, and pass through `X()`/`Y()`/`L()` exactly once on the way to the
// DXF. The alternative — modules that each know the scale — is how a drawing
// ends up with its contours at 1:200 and its labels at 1:100, which looks
// almost right and is unusable.
//
// ⚠️ THE SHEET ORIGIN IS ITS LOWER LEFT, Y UP. Map northing already runs up, so
// no flip happens here; the only flip in the whole tool is in the contour
// tracer, where the raster's north-first row order is undone.

/** The scales a landscape drawing is actually printed at. */
export const SCALE_LADDER = [20, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];

/**
 * @typedef {object} Sheet
 * @property {number} scale        the denominator: 200 means 1:200
 * @property {number} mmPerUnit    sheet mm per map unit
 * @property {number} margin       mm
 * @property {number} width        mm, including margins
 * @property {number} height       mm
 * @property {number} drawW        mm, the terrain itself
 * @property {number} drawH        mm
 * @property {(X:number)=>number} X  map easting  → sheet mm
 * @property {(Y:number)=>number} Y  map northing → sheet mm
 * @property {(d:number)=>number} L  map length   → sheet mm
 * @property {(x:number)=>number} invX sheet mm → map easting
 * @property {(y:number)=>number} invY sheet mm → map northing
 * @property {(mm:number)=>number} invL sheet mm → map length
 */

/**
 * The sheet a raster makes at a given scale.
 *
 * @param {import("./dem.js").DEM} dem
 * @param {{scale?:number, margin?:number, unitsPerMetre?:number}} [o]
 *   `unitsPerMetre` is 1 for a raster in metres. A 1:200 drawing puts one metre
 *   of ground on five millimetres of sheet, and that is the only arithmetic
 *   here worth stating: mm = metres × 1000 / scale.
 * @returns {Sheet}
 */
export function sheetFor(dem, o = {}) {
  const scale = o.scale ?? 200;
  const margin = o.margin ?? 0;
  const upm = o.unitsPerMetre ?? 1;
  const mmPerUnit = (1000 / scale) / upm;
  const drawW = dem.ncols * dem.cell * mmPerUnit;
  const drawH = dem.nrows * dem.cell * mmPerUnit;
  const south = dem.originY - dem.nrows * dem.cell;
  return {
    scale, mmPerUnit, margin,
    width: drawW + margin * 2,
    height: drawH + margin * 2,
    drawW, drawH,
    X: (X) => margin + (X - dem.originX) * mmPerUnit,
    Y: (Y) => margin + (Y - south) * mmPerUnit,
    L: (d) => d * mmPerUnit,
    // ⚠️ THE INVERSE LIVES BESIDE THE FORWARD MAP, ON PURPOSE. The shapefile
    // writer has to put the drawing BACK on the ground, and a second copy of
    // this arithmetic somewhere else is a copy that drifts the first time a
    // margin or a scale is touched — the same reason `resolveSource()` is the
    // one resolver. The transform is a pure translate-and-scale with no
    // rotation and no skew, so the round trip is exact to floating point.
    invX: (x) => dem.originX + (x - margin) / mmPerUnit,
    invY: (y) => south + (y - margin) / mmPerUnit,
    invL: (mm) => mm / mmPerUnit,
  };
}

/**
 * The largest ladder scale whose drawing still fits a given bed.
 *
 * ⚠️ RETURNS A REAL SCALE, NOT A FITTED RATIO. "1:187.4" fits the sheet
 * perfectly and cannot be measured off, dimensioned against, or compared with
 * the drawing beside it. A model is a document; it gets a scale a ruler knows.
 * @param {import("./dem.js").DEM} dem
 * @param {number} bedW @param {number} bedH mm
 * @param {{margin?:number, unitsPerMetre?:number}} [o]
 * @returns {number|null} null when even the coarsest ladder scale overruns
 */
export function fitScale(dem, bedW, bedH, o = {}) {
  const margin = o.margin ?? 0;
  const upm = o.unitsPerMetre ?? 1;
  const w = dem.ncols * dem.cell, h = dem.nrows * dem.cell;
  for (const s of SCALE_LADDER) {
    const k = (1000 / s) / upm;
    if (w * k + margin * 2 <= bedW && h * k + margin * 2 <= bedH) return s;
  }
  return null;
}

/**
 * A scale bar, in sheet mm: a thin run, then a solid block.
 *
 * ⚠️ PORTED FROM DL-TerrainDiversity's figure sheet, proportions and all, so the
 * family draws one scale bar and not two. Its own note explains the design and
 * it holds here: the first half is a thin strip, the second half a solid block
 * on the same baseline, with a short riser marking zero. No ticks and no
 * intermediate numbers — THE THICKNESS CHANGE IS THE HALFWAY MARK, and with
 * lengths from the 1-2-5 series half is always a round number anyway.
 *
 * ⚠️ EVERYTHING IS RETURNED AS RINGS, NOT AS BLACK. Nothing in this tool is
 * filled by being declared filled — defect 7 — so the bar is three closed rings
 * and the caller fills them with the same geometry as everything else.
 *
 * ⚠️ IT CARRIES ITS OWN LABEL TEXT, and the label is UPPERCASE because that is
 * what will be drawn. The single-stroke face has one case — `textStrokes()` falls
 * back to the capital for any lowercase letter — so returning "10 m" would
 * describe something the plate cannot show. Kilometres appear above 1,000 m,
 * because "5000 M" on a site plan is a number to count zeros in.
 *
 * @param {Sheet} sheet
 * @param {{x?:number, y?:number, target?:number}} [o]
 * @returns {{paths:number[][], rings:number[][], metres:number, mm:number,
 *            thick:number, label:string}}
 */
export function scaleBar(sheet, o = {}) {
  const target = o.target ?? 50;
  const rawM = target / sheet.mmPerUnit;
  const mag = Math.pow(10, Math.floor(Math.log10(rawM)));
  const n = rawM / mag;
  const metres = (n <= 1.5 ? 1 : n <= 3.5 ? 2 : n <= 7.5 ? 5 : 10) * mag;
  const mm = metres * sheet.mmPerUnit;
  const x = o.x ?? sheet.margin, y = o.y ?? sheet.margin / 2;

  // The sibling's 6 and 2 at figure scale, as a ratio: the thin run is a third
  // of the block, and the riser is the block's height.
  const THICK = 1.8, THIN = THICK / 3, RISER = 0.45;
  const half = mm / 2;
  const box = (x0, y0, w, h) => [x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h];

  return {
    paths: [],
    rings: [
      box(x, y, RISER, THICK),                 // zero riser
      box(x, y, half, THIN),                   // thin first half
      box(x + half, y, mm - half, THICK),      // solid second half
    ],
    metres, mm, thick: THICK,
    label: metres >= 1000
      ? `${+(metres / 1000).toFixed(metres % 1000 ? 1 : 0)} KM`
      : `${metres} M`,
  };
}

/**
 * A north point: a tapered needle in a hairline ring.
 *
 * ⚠️ ALSO PORTED FROM THE SIBLING, and its reasoning is worth keeping whole:
 * the ring is drawn lighter than the needle so it sits behind it rather than
 * competing; the needle is a TAPERED lozenge — wide at the pivot, pointed at the
 * rim — because a constant-width bar reads as a tally mark and the taper is what
 * makes it read as an instrument; and the pivot is a small filled dot, which is
 * what stops the shape looking like it is falling out of the bottom of the
 * circle.
 *
 * ⚠️ UP THE SHEET IS NORTH BECAUSE NOTHING HERE ROTATES THE GROUND. If a future
 * version lets the plan be turned on the bed to nest better, this function must
 * take that angle — a north point that lies is worse than none.
 *
 * @param {{x:number, y:number, size?:number}} o `size` is the ring's RADIUS
 * @returns {{paths:number[][], rings:number[][], labelY:number, r:number}}
 */
export function northPoint(o) {
  const r = o.size ?? 5, x = o.x, y = o.y;
  const seg = 32;
  const circle = (cx, cy, rad) => {
    const p = [];
    for (let k = 0; k < seg; k++) {
      const a = (2 * Math.PI * k) / seg;
      p.push(cx + rad * Math.cos(a), cy + rad * Math.sin(a));
    }
    return p;
  };
  // The sibling's 19 px ring with its needle at 4.5 / 5.5 / 2.6 and a 1.6 pivot,
  // kept as ratios so the point is the same drawing at any plate size.
  const tip = y + r - r * 0.237;
  const tail = y - r * 0.289;
  const halfW = r * 0.137;
  return {
    paths: [circle(x, y, r)],                       // the ring: a hairline
    rings: [
      [x, tip, x + halfW, tail, x - halfW, tail],   // the tapered needle
      circle(x, y - r * 0.158, r * 0.084),          // the pivot dot
    ],
    labelY: y + r + r * 0.32,                       // where the N sits
    r,
  };
}
