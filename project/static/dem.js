// @ts-check
// THE DEM — one elevation grid, in map units, with its corner in the world.
//
// Every module downstream of the reader speaks this shape and nothing else, so
// there is exactly one place that knows how a raster is laid out.
//
// ⚠️ ROW 0 IS THE NORTH EDGE. That is the TIFF convention and it is kept rather
// than flipped on load, because the tie point a GeoTIFF carries names the upper
// left corner and flipping the array would make `originY` a lie. Everything
// that needs a y-up coordinate converts at the point of use with `northing()`,
// which is one visible line instead of an invisible transpose.
//
// ⚠️ NODATA IS NaN, ALWAYS, AND ONLY NaN. Readers translate whatever sentinel
// the file used (-9999, -3.4e38, a GDAL_NODATA tag) into NaN at the boundary.
// Downstream code then has ONE test — `Number.isFinite` — instead of a magic
// number that differs per dataset, and a cell with no answer can never be
// mistaken for a cell that measured very low. Same rule DL-TerrainDiversity's
// analysis grids keep, for the same reason.

/**
 * @typedef {object} DEM
 * @property {number} nrows
 * @property {number} ncols
 * @property {number} cell      ground size of one cell, map units (normally m)
 * @property {number} originX   easting of the WEST edge of column 0
 * @property {number} originY   northing of the NORTH edge of row 0
 * @property {Float32Array} z   nrows*ncols, row-major, row 0 = north, NaN = no data
 * @property {string} [crs]     e.g. "EPSG:25833", when the file said so
 * @property {string} [name]    the file it came from, for the report
 */

/**
 * Northing of a row centre. Row 0 is the north edge, so northing decreases.
 * @param {DEM} dem @param {number} r
 */
export const northing = (dem, r) => dem.originY - (r + 0.5) * dem.cell;

/**
 * Easting of a column centre.
 * @param {DEM} dem @param {number} c
 */
export const easting = (dem, c) => dem.originX + (c + 0.5) * dem.cell;

/** Ground width and height in map units. @param {DEM} dem */
export const extent = (dem) => ({ w: dem.ncols * dem.cell, h: dem.nrows * dem.cell });

/**
 * Map coordinate to fractional grid position, y measured DOWN from the north
 * edge — the frame the contour tracer and the samplers both work in.
 * @param {DEM} dem @param {number} X easting @param {number} Y northing
 * @returns {{gx:number, gy:number}} in cell units from the NW corner
 */
export function toGrid(dem, X, Y) {
  return { gx: (X - dem.originX) / dem.cell, gy: (dem.originY - Y) / dem.cell };
}

/**
 * Grid position back to map coordinates. Inverse of `toGrid`.
 * @param {DEM} dem @param {number} gx @param {number} gy
 */
export function toMap(dem, gx, gy) {
  return { X: dem.originX + gx * dem.cell, Y: dem.originY - gy * dem.cell };
}

/**
 * Min, max and the count of cells that actually hold a measurement.
 *
 * ⚠️ RETURNS NaN FOR AN EMPTY GRID rather than ±Infinity. Infinity survives
 * arithmetic and turns up later as a plausible-looking contour interval; NaN
 * fails the first `Number.isFinite` it meets, which is where the caller should
 * have been checking anyway.
 * @param {DEM} dem
 */
export function stats(dem) {
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let i = 0; i < dem.z.length; i++) {
    const v = dem.z[i];
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; n++; }
  }
  if (!n) return { min: NaN, max: NaN, relief: NaN, measured: 0, total: dem.z.length };
  return { min: lo, max: hi, relief: hi - lo, measured: n, total: dem.z.length };
}

/**
 * Bilinear sample at a fractional grid position.
 *
 * ⚠️ ANY NaN CORNER POISONS THE SAMPLE. Substituting a neighbour's value where
 * a corner has no data would invent ground along every nodata edge, and the
 * invention would be invisible — a smooth surface right where the data stops.
 * A sample that cannot be taken honestly returns NaN.
 * @param {DEM} dem @param {number} gx @param {number} gy
 */
export function sampleBilinear(dem, gx, gy) {
  const { ncols, nrows, z } = dem;
  const x = gx - 0.5, y = gy - 0.5;              // cell CENTRES carry the values
  const c0 = Math.floor(x), r0 = Math.floor(y);
  const fx = x - c0, fy = y - r0;
  const c1 = c0 + 1, r1 = r0 + 1;
  if (c0 < 0 || r0 < 0 || c1 >= ncols || r1 >= nrows) return NaN;
  const a = z[r0 * ncols + c0], b = z[r0 * ncols + c1];
  const d = z[r1 * ncols + c0], e = z[r1 * ncols + c1];
  if (!Number.isFinite(a) || !Number.isFinite(b) ||
      !Number.isFinite(d) || !Number.isFinite(e)) return NaN;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
}

/**
 * A DEM with every cell finite, for tests and for the demo tile.
 * @param {number} nrows @param {number} ncols @param {number} cell
 * @param {(c:number,r:number)=>number} fn
 * @param {{originX?:number, originY?:number, crs?:string, name?:string}} [o]
 * @returns {DEM}
 */
export function makeDEM(nrows, ncols, cell, fn, o = {}) {
  const z = new Float32Array(nrows * ncols);
  for (let r = 0; r < nrows; r++)
    for (let c = 0; c < ncols; c++) z[r * ncols + c] = fn(c, r);
  return {
    nrows, ncols, cell, z,
    originX: o.originX ?? 0,
    originY: o.originY ?? nrows * cell,
    crs: o.crs, name: o.name,
  };
}
