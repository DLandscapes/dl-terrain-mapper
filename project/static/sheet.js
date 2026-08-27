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
 * A scale bar, as stroke paths, in sheet mm.
 *
 * The bar is a round number of ground metres from the 1-2-5 series, because the
 * point of it is to be counted along rather than measured.
 * @param {Sheet} sheet
 * @param {{x?:number, y?:number, target?:number}} [o] `target` mm, the wanted length
 * @returns {{paths:number[][], metres:number, mm:number}}
 */
export function scaleBar(sheet, o = {}) {
  const target = o.target ?? 50;
  const rawM = target / sheet.mmPerUnit;
  const mag = Math.pow(10, Math.floor(Math.log10(rawM)));
  const n = rawM / mag;
  const metres = (n <= 1.5 ? 1 : n <= 3.5 ? 2 : n <= 7.5 ? 5 : 10) * mag;
  const mm = metres * sheet.mmPerUnit;
  const x = o.x ?? sheet.margin, y = o.y ?? sheet.margin / 2;
  const t = 1.6;
  const paths = [
    [x, y, x + mm, y],
    [x, y - t, x, y + t],
    [x + mm, y - t, x + mm, y + t],
    [x + mm / 2, y - t, x + mm / 2, y + t],
  ];
  return { paths, metres, mm };
}

/**
 * A north point: a line with an open arrow head, pointing up the sheet.
 *
 * ⚠️ UP THE SHEET IS NORTH BECAUSE NOTHING HERE ROTATES THE GROUND. If a future
 * version lets the plan be turned on the bed to nest better, this function must
 * take that angle — a north point that lies is worse than none.
 * @param {{x:number, y:number, size?:number}} o
 * @returns {number[][]}
 */
export function northPoint(o) {
  const s = o.size ?? 10, x = o.x, y = o.y;
  return [
    [x, y, x, y + s],
    [x - s * 0.22, y + s * 0.7, x, y + s, x + s * 0.22, y + s * 0.7],
  ];
}
