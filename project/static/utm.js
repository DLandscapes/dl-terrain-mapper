// @ts-check
// LATITUDE AND LONGITUDE INTO THE RASTER'S OWN GRID.
//
// ⚠️ THIS EXISTS BECAUSE PHOTOGRAPHS ARRIVE IN DEGREES AND TERRAIN ARRIVES IN
// METRES, AND NOTHING ELSE IN THE TOOL CROSSES THAT LINE. A camera writes
// EPSG:4326 into every file; QGIS's own "Import geotagged photos" returns the
// same, which is why its output has to be reprojected before it can be joined
// to anything. Skipping the step does not fail loudly — it places every
// photograph a few hundred kilometres away, or at the equator, and the numbers
// still look like numbers.
//
// ⚠️ THE ZONE IS TAKEN FROM THE RASTER, NOT FROM THE PHOTOGRAPH. Deriving the
// zone from each photograph's own longitude looks more general and is a trap: a
// site straddling a zone boundary would put half its photographs in one grid
// and half in another, both correct, 500 km apart on the sheet. The terrain
// defines the frame; a photograph outside the raster's zone gets a large
// easting, which is the true answer and a visible one.
//
// ⚠️ ETRS89 AND WGS84 ARE TREATED AS ONE HERE, AND THE ERROR IS STATED RATHER
// THAN HIDDEN. They were identical in 1989; the Eurasian plate has carried
// ETRS89 about 0.7 m from WGS84 since. That is real, it is systematic, and it
// is an order of magnitude smaller than the 5–10 m a phone's GPS gives you —
// which is the error that actually decides where these points land. Applying a
// plate-motion correction to a phone fix would be false precision. If survey-
// grade positions ever arrive, this is the assumption to revisit first.

const A = 6378137.0;                 // GRS80 / WGS84 semi-major axis, identical
const F = 1 / 298.257222101;         // GRS80 flattening (WGS84 differs by ~0.1 mm)
const K0 = 0.9996;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);

/** The UTM zone a longitude falls in. @param {number} lon */
export const zoneFor = (lon) => Math.floor(((((lon + 180) % 360) + 360) % 360) / 6) + 1;

/**
 * The zone a projected EPSG code names, when it names one.
 *
 * 258xx is ETRS89 / UTM zone xx, 326xx is WGS84 / UTM north, 327xx is south,
 * 250xx and 231xx are the older Norwegian ED50 and NGO variants and are NOT
 * treated as UTM here — their datum shift is tens of metres and pretending
 * otherwise would be the exact false precision this file refuses elsewhere.
 * @param {string|undefined} crs
 * @returns {{zone:number, south:boolean}|null}
 */
export function zoneFromEPSG(crs) {
  if (!crs) return null;
  const m = /^EPSG:(\d+)$/i.exec(crs.trim());
  if (!m) return null;
  const code = Number(m[1]);
  if (code >= 25828 && code <= 25838) return { zone: code - 25800, south: false };
  if (code >= 32601 && code <= 32660) return { zone: code - 32600, south: false };
  if (code >= 32701 && code <= 32760) return { zone: code - 32700, south: true };
  return null;
}

/**
 * Geographic to UTM. The standard Transverse Mercator forward series, good to a
 * few millimetres across a zone — far inside any error that matters here.
 *
 * @param {number} lat degrees @param {number} lon degrees
 * @param {number} zone @param {boolean} [south]
 * @returns {{x:number, y:number}} easting, northing
 */
export function toUTM(lat, lon, zone, south = false) {
  const lon0 = zone * 6 - 183;
  const p = (lat * Math.PI) / 180;
  const dl = (((lon - lon0 + 540) % 360) - 180) * (Math.PI / 180);
  const sin = Math.sin(p), cos = Math.cos(p), tan = Math.tan(p);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T2 = tan * tan, C = EP2 * cos * cos, Aa = cos * dl;
  const M = A * (
    (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256) * p
    - ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * p)
    + ((15 * E2 * E2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * p)
    - ((35 * E2 ** 3) / 3072) * Math.sin(6 * p));
  const x = K0 * N * (Aa + ((1 - T2 + C) * Aa ** 3) / 6
    + ((5 - 18 * T2 + T2 * T2 + 72 * C - 58 * EP2) * Aa ** 5) / 120) + 500000;
  let y = K0 * (M + N * tan * ((Aa * Aa) / 2
    + ((5 - T2 + 9 * C + 4 * C * C) * Aa ** 4) / 24
    + ((61 - 58 * T2 + T2 * T2 + 600 * C - 330 * EP2) * Aa ** 6) / 720));
  if (south) y += 10000000;
  return { x, y };
}

/**
 * UTM back to geographic — for reporting a hand-corrected point as a coordinate
 * somebody can type into a phone.
 * @param {number} x @param {number} y @param {number} zone @param {boolean} [south]
 * @returns {{lat:number, lon:number}}
 */
export function fromUTM(x, y, zone, south = false) {
  const lon0 = zone * 6 - 183;
  const E = x - 500000;
  const Nn = south ? y - 10000000 : y;
  const M = Nn / K0;
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const p1 = mu
    + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
    + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(p1), cos = Math.cos(p1), tan = Math.tan(p1);
  const C1 = EP2 * cos * cos, T1 = tan * tan;
  const N1 = A / Math.sqrt(1 - E2 * sin * sin);
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * sin * sin, 1.5);
  const D = E / (N1 * K0);
  const lat = p1 - ((N1 * tan) / R1) * ((D * D) / 2
    - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6
    + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / cos;
  return { lat: (lat * 180) / Math.PI, lon: lon0 + (lon * 180) / Math.PI };
}
