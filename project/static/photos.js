// @ts-check
// PHOTOGRAPHS AS MAP FEATURES, AND THEN AS MARKS ON A MATERIAL.
//
// ⚠️ PHONE GPS IS 5 TO 10 METRES, AND AT MODEL SCALE THAT IS BIGGER THAN THE
// SYMBOL. At 1:200 a 7 m error is 35 mm on the sheet — several times the width
// of the mark it places, so a photograph "at" a boulder can be engraved on the
// far side of the stream. This is not a defect to be smoothed over, it is the
// accuracy of the instrument, and the tool's job is to (a) say so, (b) draw it
// at scale so the size of the doubt is visible, and (c) make MOVING A POINT BY
// HAND against the terrain a first-class action rather than an escape hatch.
// `uncertaintyMM` and `offset` below are that commitment in code.
//
// ⚠️ THE BEARING IS WHERE THE CAMERA LOOKED, AND IT IS THE HALF NOBODY KEEPS.
// GPSImgDirection is recorded by most phones and discarded by almost every
// workflow. A point says "something was seen here"; a point with a bearing says
// "this was the view", which is the thing a site photograph is actually FOR.
// Drawn as a short tick, it costs one more line on the bed and turns a scatter
// of dots into a record of where the photographer was standing and facing.
//
// ⚠️ NO PHOTOGRAPH IS DRAWN THAT THE USER HAS NOT SEEN. `include` defaults to
// true only after the picture has been shown in the browser; the GDPR rule in
// exif.js is not enforceable by software, so the interface is built so that
// exporting an unreviewed set is not the easy path.

import { toUTM, zoneFromEPSG, zoneFor } from "./utm.js";
import { toGrid, sampleBilinear } from "./dem.js";

/**
 * @typedef {object} PhotoPoint
 * @property {import("./exif.js").PhotoMeta} meta
 * @property {number} n          the number engraved beside the mark, from 1
 * @property {number} X          easting in the raster's grid, correction applied
 * @property {number} Y          northing, likewise
 * @property {number} rawX       where the camera said, before correction
 * @property {number} rawY
 * @property {number} dx         the hand correction, map units
 * @property {number} dy
 * @property {boolean} inside    does it land on the raster at all
 * @property {number} [ground]   the terrain's own elevation there
 * @property {boolean} include   drawn on the sheet
 */

/**
 * Put a set of photographs into the raster's grid.
 *
 * @param {import("./exif.js").PhotoMeta[]} metas
 * @param {import("./dem.js").DEM} dem
 * @param {{zone?:number, south?:boolean}} [o]
 * @returns {{points:PhotoPoint[], zone:number, outside:number, guessedZone:boolean}}
 */
export function placePhotos(metas, dem, o = {}) {
  const fromCRS = zoneFromEPSG(dem.crs);
  let zone = o.zone ?? fromCRS?.zone;
  const south = o.south ?? fromCRS?.south ?? false;
  let guessedZone = false;
  if (!zone) {
    // The raster did not say. Fall back to the photographs' own longitude —
    // announced, because it is a guess about the TERRAIN made from the CAMERA.
    const withFix = metas.filter((m) => m.lon !== undefined);
    zone = withFix.length ? zoneFor(withFix[0].lon) : 33;
    guessedZone = true;
  }
  const points = [];
  let outside = 0, n = 0;
  for (const meta of metas) {
    if (meta.lat === undefined || meta.lon === undefined) continue;
    const { x, y } = toUTM(meta.lat, meta.lon, zone, south);
    const g = toGrid(dem, x, y);
    const inside = g.gx >= 0 && g.gy >= 0 && g.gx <= dem.ncols && g.gy <= dem.nrows;
    if (!inside) outside++;
    const ground = sampleBilinear(dem, g.gx, g.gy);
    points.push({
      meta, n: ++n, X: x, Y: y, rawX: x, rawY: y, dx: 0, dy: 0,
      inside, ground: Number.isFinite(ground) ? ground : undefined,
      include: inside,
    });
  }
  return { points, zone, outside, guessedZone };
}

/** Move a point by hand; the original stays, so the correction is inspectable. */
export function correct(pt, dx, dy) {
  pt.dx = dx; pt.dy = dy;
  pt.X = pt.rawX + dx; pt.Y = pt.rawY + dy;
  return pt;
}

/**
 * How big the GPS's own doubt is, on this sheet.
 * @param {import("./sheet.js").Sheet} sheet @param {number} [metres]
 */
export const uncertaintyMM = (sheet, metres = 7) => sheet.L(metres);

/** The marks a photograph can be. */
export const MARKS = ["circle", "square", "triangle", "cross", "diamond"];

/**
 * One mark, as sheet-space paths and circles.
 *
 * Returned split by kind because a CIRCLE is a real DXF entity — eight lines in
 * the file, a true arc on the bed — and polygonising it would be neither.
 *
 * @param {number} cx @param {number} cy sheet mm
 * @param {{mark?:string, size?:number, bearing?:number, bearingLength?:number,
 *          halo?:number}} [o]
 *   `bearing` is degrees clockwise from north, as EXIF records it; the sheet's
 *   y runs north, so it is turned into a screen angle here and only here.
 * @returns {{paths:number[][], circles:{cx:number,cy:number,r:number}[]}}
 */
export function markGeometry(cx, cy, o = {}) {
  const s = (o.size ?? 3) / 2;
  const mark = o.mark ?? "circle";
  const paths = [], circles = [];
  if (mark === "circle") circles.push({ cx, cy, r: s });
  else if (mark === "square") paths.push([cx - s, cy - s, cx + s, cy - s, cx + s, cy + s, cx - s, cy + s, cx - s, cy - s]);
  else if (mark === "diamond") paths.push([cx, cy - s, cx + s, cy, cx, cy + s, cx - s, cy, cx, cy - s]);
  else if (mark === "triangle") {
    const h = s * 1.15;
    paths.push([cx, cy + h, cx + s, cy - h * 0.6, cx - s, cy - h * 0.6, cx, cy + h]);
  } else if (mark === "cross") {
    paths.push([cx - s, cy, cx + s, cy], [cx, cy - s, cx, cy + s]);
  }
  if (o.bearing !== undefined && Number.isFinite(o.bearing)) {
    // North is up the sheet, bearings run clockwise from north.
    const a = ((90 - o.bearing) * Math.PI) / 180;
    const len = o.bearingLength ?? s * 3;
    paths.push([cx + Math.cos(a) * s, cy + Math.sin(a) * s,
                cx + Math.cos(a) * len, cy + Math.sin(a) * len]);
  }
  if (o.halo && o.halo > s) circles.push({ cx, cy, r: o.halo });
  return { paths, circles };
}
