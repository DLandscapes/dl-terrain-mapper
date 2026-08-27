// @ts-check
// THE DRAWING, PUT BACK ON THE GROUND — a shapefile writer.
//
// The compiled drawing, written out as shapefiles in the raster's OWN
// coordinates, so the line work a student cut can be opened beside the data it
// came from and checked against it.
//
// ⚠️ WRITTEN FROM THE ESRI SHAPEFILE TECHNICAL DESCRIPTION (July 1998) AND THE
// dBASE III+ FORMAT, NOT FROM THIS PROJECT'S READERS. Same discipline the test
// fixtures were held to, and for the same reason: an encoder written by reading
// its own decoder proves only that the two share a misunderstanding. The trap
// this format sets is the MIXED ENDIANNESS — the file header's length field and
// every record header are BIG-endian, while the shape data inside them is
// LITTLE-endian, in the same file, sometimes in adjacent words.
//
// ⚠️ THE ROUND TRIP IS EXACT, AND THAT IS A PROPERTY OF THE SHEET, NOT OF THIS
// FILE. `sheetFor()` maps world → sheet mm with a pure translate and scale: no
// rotation, no skew. So `invX`/`invY` recover the original eastings and
// northings to floating point, and this writer does no geometry of its own. The
// inverse lives beside the forward map in `sheet.js` precisely so that no second
// copy of that arithmetic can drift away from it.
//
// ⚠️ A CIRCLE LEAVES AS A POINT CARRYING ITS RADIUS, NOT AS A POLYGON. The
// circle grid encodes a VALUE as a size; frozen into a polygon that value is
// gone and all that is left is a small ring nobody can re-scale. As a point with
// `r_m` and `diam_m` on it, QGIS can render it proportionally again — which is
// the same drawing, still carrying its meaning.
//
// ⚠️ CLOSED LINE WORK STAYS A POLYLINE. A contour that closes is still a
// contour; promoting it to a polygon would fill it, break its length and imply
// an area the survey never claimed. Areas that really are areas are identifiable
// by their `kind`, so the decision is left to the reader in QGIS rather than
// guessed here.

/** ESRI shape types. Only the two this tool needs. */
export const SHP_POINT = 1;
export const SHP_POLYLINE = 3;

/* ── little helpers over a DataView ──────────────────────────────────────── */

class Buf {
  /** @param {number} n */
  constructor(n) {
    this.u8 = new Uint8Array(n);
    this.dv = new DataView(this.u8.buffer);
    this.at = 0;
  }
  /** @param {number} v */ be32(v) { this.dv.setInt32(this.at, v, false); this.at += 4; return this; }
  /** @param {number} v */ le32(v) { this.dv.setInt32(this.at, v, true); this.at += 4; return this; }
  /** @param {number} v */ f64(v) { this.dv.setFloat64(this.at, v, true); this.at += 8; return this; }
  /** @param {number} n */ skip(n) { this.at += n; return this; }
}

/**
 * The 100-byte header both .shp and .shx carry, identically except for length.
 *
 * ⚠️ THE LENGTH IS IN 16-BIT WORDS, NOT BYTES, and it is BIG-endian while the
 * version and type four bytes later are little-endian. Writing bytes here gives
 * a file every reader believes is twice as long as it is, which surfaces as a
 * truncated last record rather than as an error.
 */
function header(buf, words, type, bbox) {
  buf.be32(9994).skip(20).be32(words).le32(1000).le32(type);
  buf.f64(bbox[0]).f64(bbox[1]).f64(bbox[2]).f64(bbox[3]);
  buf.f64(0).f64(0).f64(0).f64(0);          // Z and M ranges: this tool is 2D
  return buf;
}

/**
 * Write a .shp and its .shx together.
 *
 * ⚠️ THEY ARE WRITTEN IN ONE PASS BECAUSE THE INDEX IS NOT OPTIONAL. QGIS will
 * open a .shp without a .shx by rebuilding it, but plenty of readers simply
 * refuse, and a set that works in one tool and not the next is worse than one
 * that fails everywhere. The offsets it stores are the ones being emitted here,
 * so they cannot disagree.
 *
 * @param {{pts:Float64Array|number[]}[]} recs polylines, world units, x,y interleaved
 * @param {number} type SHP_POINT or SHP_POLYLINE
 * @returns {{shp:Uint8Array, shx:Uint8Array, bbox:number[]}}
 */
export function writeSHP(recs, type) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of recs) {
    const p = r.pts;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
    }
  }
  // An empty set still needs a legal, finite box.
  if (!Number.isFinite(x0)) { x0 = y0 = x1 = y1 = 0; }
  const bbox = [x0, y0, x1, y1];

  // content length per record, in WORDS (16-bit), excluding the 8-byte header
  const contentWords = (r) => type === SHP_POINT
    ? 10                                            // type(4) + X(8) + Y(8) = 20 B
    : (4 + 32 + 4 + 4 + 4 + r.pts.length * 8) / 2;  // + one part, one ring

  let shpBytes = 100, shxBytes = 100;
  for (const r of recs) { shpBytes += 8 + contentWords(r) * 2; shxBytes += 8; }

  const shp = new Buf(shpBytes);
  const shx = new Buf(shxBytes);
  header(shp, shpBytes / 2, type, bbox);
  header(shx, shxBytes / 2, type, bbox);

  let offsetWords = 50;                             // the header is 50 words
  recs.forEach((r, i) => {
    const cw = contentWords(r);
    shx.be32(offsetWords).be32(cw);
    shp.be32(i + 1).be32(cw);                       // ⚠️ record numbers are 1-BASED
    if (type === SHP_POINT) {
      shp.le32(type).f64(r.pts[0]).f64(r.pts[1]);
    } else {
      const p = r.pts;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let j = 0; j < p.length; j += 2) {
        if (p[j] < bx0) bx0 = p[j]; if (p[j] > bx1) bx1 = p[j];
        if (p[j + 1] < by0) by0 = p[j + 1]; if (p[j + 1] > by1) by1 = p[j + 1];
      }
      shp.le32(type).f64(bx0).f64(by0).f64(bx1).f64(by1);
      shp.le32(1).le32(p.length / 2).le32(0);       // one part, starting at index 0
      for (let j = 0; j < p.length; j += 2) shp.f64(p[j]).f64(p[j + 1]);
    }
    offsetWords += 4 + cw;
  });
  return { shp: shp.u8, shx: shx.u8, bbox };
}

/**
 * A dBASE III+ table.
 *
 * ⚠️ THE HEADER LENGTH AND THE RECORD LENGTH ARE BOTH STORED AND MUST AGREE
 * WITH THE FIELD DESCRIPTORS. A reader that trusts the wrong one still opens a
 * file that is internally inconsistent, so both are computed here from the same
 * field list rather than written by hand.
 *
 * ⚠️ NUMERICS ARE RIGHT-JUSTIFIED AND TEXT IS SPACE-PADDED, both because that
 * is what the format says and because a null-padded numeric comes back NaN from
 * readers that trim only one side.
 *
 * @param {{name:string, type:string, length:number, decimals?:number}[]} fields
 * @param {Record<string,any>[]} rows
 * @param {{date?:number[]}} [o] `date` as [yy, mm, dd]; supplied so a test can
 *   compare two runs byte for byte
 * @returns {Uint8Array}
 */
export function writeDBF(fields, rows, o = {}) {
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((a, f) => a + f.length, 0);
  const total = headerLen + rows.length * recordLen + 1;   // +1 for the 0x1A EOF
  const u8 = new Uint8Array(total);
  const dv = new DataView(u8.buffer);
  const put = (at, s, len, pad = 0x20) => {
    for (let i = 0; i < len; i++) u8[at + i] = i < s.length ? s.charCodeAt(i) & 0xff : pad;
  };

  const d = o.date || [126, 8, 26];
  u8[0] = 0x03; u8[1] = d[0]; u8[2] = d[1]; u8[3] = d[2];
  dv.setInt32(4, rows.length, true);
  dv.setInt16(8, headerLen, true);
  dv.setInt16(10, recordLen, true);

  fields.forEach((f, i) => {
    const at = 32 + i * 32;
    // ⚠️ TEN CHARACTERS, NOT ELEVEN. The field is 11 bytes but the eleventh MUST
    // be the terminating null, so a name using all 11 is a name with no
    // terminator and the next byte — the type code — is read as part of it.
    put(at, f.name.slice(0, 10).toUpperCase(), 11, 0);
    u8[at + 11] = f.type.charCodeAt(0);
    u8[at + 16] = f.length;
    u8[at + 17] = f.decimals ?? 0;
  });
  u8[32 + fields.length * 32] = 0x0d;                      // field terminator

  let at = headerLen;
  for (const row of rows) {
    u8[at] = 0x20;                                         // not deleted
    let off = at + 1;
    for (const f of fields) {
      let v = row[f.name];
      let s;
      if (v === undefined || v === null) s = f.type === "N" ? "" : "";
      else if (f.type === "L") s = v ? "T" : "F";
      else if (f.type === "N") s = Number(v).toFixed(f.decimals ?? 0);
      else s = String(v);
      if (f.type === "N") s = s.padStart(f.length, " ");
      put(off, s.slice(0, f.length), f.length);
      off += f.length;
    }
    at += recordLen;
  }
  u8[total - 1] = 0x1a;
  return u8;
}

/* ── the .prj ────────────────────────────────────────────────────────────── */

const GRS80 = 'SPHEROID["GRS 1980",6378137,298.257222101]';
const WGS84S = 'SPHEROID["WGS 84",6378137,298.257223563]';

/**
 * A UTM PROJCS, which is entirely formulaic once the zone is known.
 *
 * ⚠️ IT NAMES ITS OWN EPSG CODE AT THE END. Without a trailing AUTHORITY a
 * reader has to identify the CRS by matching every projection parameter, which
 * works until one of them is written to a different number of decimal places —
 * and then QGIS offers "unknown CRS" over a file whose code we knew exactly.
 * The AUTHORITY belongs LAST, outside the datum's and the spheroid's own.
 */
function utmWKT(name, datum, spheroid, zone, south, code) {
  return `PROJCS["${name}",GEOGCS["${datum}",DATUM["${datum}",${spheroid}],`
    + `PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],`
    + `PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],`
    + `PARAMETER["central_meridian",${zone * 6 - 183}],PARAMETER["scale_factor",0.9996],`
    + `PARAMETER["false_easting",500000],PARAMETER["false_northing",${south ? 10000000 : 0}],`
    + `UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH],`
    + `AUTHORITY["EPSG","${code}"]]`;
}

/**
 * WKT for the CRS the raster declared, or null when we cannot state it exactly.
 *
 * ⚠️ NULL IS A RESULT, NOT A FAILURE. Guessing a datum would put the drawing in
 * the wrong place on someone else's map while looking perfectly confident; the
 * whole reader is built on the rule that the tool never claims a CRS it does not
 * have. With no .prj, QGIS asks once, and the asking is the honest outcome.
 *
 * @param {string|undefined} crs e.g. "EPSG:25833"
 * @returns {string|null}
 */
export function prjFor(crs) {
  const m = /^EPSG:(\d+)$/i.exec(String(crs || "").trim());
  if (!m) return null;
  const code = +m[1];
  if (code >= 25828 && code <= 25838) {
    const z = code - 25800;
    return utmWKT(`ETRS89 / UTM zone ${z}N`, "ETRS89", GRS80, z, false, code);
  }
  if (code >= 32601 && code <= 32660) {
    const z = code - 32600;
    return utmWKT(`WGS 84 / UTM zone ${z}N`, "WGS 84", WGS84S, z, false, code);
  }
  if (code >= 32701 && code <= 32760) {
    const z = code - 32700;
    return utmWKT(`WGS 84 / UTM zone ${z}S`, "WGS 84", WGS84S, z, true, code);
  }
  if (code === 4326) {
    return `GEOGCS["WGS 84",DATUM["WGS_1984",${WGS84S}],PRIMEM["Greenwich",0],`
      + `UNIT["degree",0.0174532925199433],AXIS["Latitude",NORTH],AXIS["Longitude",EAST],AUTHORITY["EPSG","4326"]]`;
  }
  return null;
}

/* ── a store-only ZIP, so one download is one layer set ──────────────────── */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** @param {Uint8Array} b */
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Pack files into a ZIP with NO compression.
 *
 * ⚠️ STORE-ONLY, DELIBERATELY. The guarantee this whole tool rests on is that it
 * has no dependencies and nothing to upload to; pulling in a deflate
 * implementation to save a few hundred kilobytes would trade that for nothing a
 * user asked for. A stored ZIP is a valid ZIP, QGIS opens it directly as a
 * layer, and the format is small enough to be read here in full.
 *
 * @param {{name:string, data:Uint8Array}[]} files
 * @returns {Uint8Array}
 */
export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new Buf(30);
    lh.le32(0x04034b50);
    lh.dv.setUint16(lh.at, 20, true); lh.at += 2;      // version needed
    lh.dv.setUint16(lh.at, 0, true); lh.at += 2;       // flags
    lh.dv.setUint16(lh.at, 0, true); lh.at += 2;       // method 0 = stored
    lh.dv.setUint16(lh.at, 0, true); lh.at += 2;       // time
    lh.dv.setUint16(lh.at, 0x21, true); lh.at += 2;    // date: 1980-01-01
    lh.dv.setUint32(lh.at, crc, true); lh.at += 4;
    lh.dv.setUint32(lh.at, f.data.length, true); lh.at += 4;
    lh.dv.setUint32(lh.at, f.data.length, true); lh.at += 4;
    lh.dv.setUint16(lh.at, name.length, true); lh.at += 2;
    lh.dv.setUint16(lh.at, 0, true); lh.at += 2;       // extra length
    parts.push(lh.u8, name, f.data);

    const cd = new Buf(46);
    cd.le32(0x02014b50);
    cd.dv.setUint16(cd.at, 20, true); cd.at += 2;      // version made by
    cd.dv.setUint16(cd.at, 20, true); cd.at += 2;      // version needed
    cd.dv.setUint16(cd.at, 0, true); cd.at += 2;
    cd.dv.setUint16(cd.at, 0, true); cd.at += 2;
    cd.dv.setUint16(cd.at, 0, true); cd.at += 2;
    cd.dv.setUint16(cd.at, 0x21, true); cd.at += 2;
    cd.dv.setUint32(cd.at, crc, true); cd.at += 4;
    cd.dv.setUint32(cd.at, f.data.length, true); cd.at += 4;
    cd.dv.setUint32(cd.at, f.data.length, true); cd.at += 4;
    cd.dv.setUint16(cd.at, name.length, true); cd.at += 2;
    cd.dv.setUint16(cd.at, 0, true); cd.at += 2;       // extra
    cd.dv.setUint16(cd.at, 0, true); cd.at += 2;       // comment
    cd.dv.setUint16(cd.at, 0, true); cd.at += 2;       // disk
    cd.dv.setUint16(cd.at, 0, true); cd.at += 2;       // internal attrs
    cd.dv.setUint32(cd.at, 0, true); cd.at += 4;       // external attrs
    cd.dv.setUint32(cd.at, offset, true); cd.at += 4;
    central.push(cd.u8, name);

    offset += lh.u8.length + name.length + f.data.length;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new Buf(22);
  end.le32(0x06054b50);
  end.dv.setUint16(end.at, 0, true); end.at += 2;
  end.dv.setUint16(end.at, 0, true); end.at += 2;
  end.dv.setUint16(end.at, files.length, true); end.at += 2;
  end.dv.setUint16(end.at, files.length, true); end.at += 2;
  end.dv.setUint32(end.at, cdSize, true); end.at += 4;
  end.dv.setUint32(end.at, offset, true); end.at += 4;
  end.dv.setUint16(end.at, 0, true); end.at += 2;

  const all = [...parts, ...central, end.u8];
  const size = all.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

/* ── the drawing → a layer set ───────────────────────────────────────────── */

/** Plane length of a polyline in world units. */
function runLength(p) {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
}

const LINE_FIELDS = [
  { name: "pass", type: "C", length: 20 },
  { name: "kind", type: "C", length: 16 },
  { name: "sheet", type: "C", length: 12 },
  { name: "closed", type: "L", length: 1 },
  { name: "len_m", type: "N", length: 14, decimals: 3 },
  { name: "n_pts", type: "N", length: 8 },
];
const POINT_FIELDS = [
  { name: "pass", type: "C", length: 20 },
  { name: "kind", type: "C", length: 16 },
  { name: "sheet", type: "C", length: 12 },
  { name: "r_mm", type: "N", length: 12, decimals: 4 },
  { name: "r_m", type: "N", length: 14, decimals: 4 },
  { name: "diam_m", type: "N", length: 14, decimals: 4 },
];

/**
 * Turn a compiled Drawing into a set of shapefiles in the raster's own CRS.
 *
 * ⚠️ NOTHING IS SILENTLY DROPPED. Furniture, the frame and the registration
 * marks are plate artefacts rather than survey content, but they are written
 * with their own `kind` rather than filtered out here — a reader who wants only
 * the ground filters on one attribute, and a reader who wondered where the scale
 * bar went is not left guessing.
 *
 * @param {import("./compile.js").Drawing} d
 * @param {{stem?:string, crs?:string, date?:number[]}} [o]
 * @returns {{files:{name:string,data:Uint8Array}[], lines:number, points:number,
 *            crs:string|null, prj:boolean, bbox:number[]|null, notes:string[]}}
 */
export function drawingToShapefiles(d, o = {}) {
  const stem = (o.stem || "terrainmapper").replace(/[^\w-]+/g, "-");
  const sheet = d.sheet;
  const notes = [];
  if (!sheet || typeof sheet.invX !== "function") {
    throw new Error("this drawing has no sheet transform, so it cannot be put back on the ground");
  }

  const lineRecs = [], lineRows = [];
  for (const p of d.paths) {
    const src = p.pts;
    const n = src.length / 2;
    // ⚠️ A CLOSED RING IS CLOSED EXPLICITLY HERE. In the Drawing "closed" is a
    // flag and the first point is NOT repeated; a shapefile has no such flag, so
    // the ring must come back to its start or it reads as an open line that
    // happens to end nearby.
    const closed = !!p.closed;
    const out = new Float64Array((n + (closed ? 1 : 0)) * 2);
    for (let i = 0; i < n; i++) {
      out[i * 2] = sheet.invX(src[i * 2]);
      out[i * 2 + 1] = sheet.invY(src[i * 2 + 1]);
    }
    if (closed) { out[n * 2] = out[0]; out[n * 2 + 1] = out[1]; }
    if (out.length < 4) continue;
    lineRecs.push({ pts: out });
    lineRows.push({
      pass: p.layer || "", kind: p.kind || (p.furniture ? "furniture" : ""),
      sheet: p.sheet || "surface", closed,
      len_m: runLength(out), n_pts: out.length / 2,
    });
  }

  const ptRecs = [], ptRows = [];
  for (const c of d.circles || []) {
    ptRecs.push({ pts: Float64Array.of(sheet.invX(c.cx), sheet.invY(c.cy)) });
    const rWorld = sheet.invL(c.r);
    ptRows.push({
      pass: c.layer || "", kind: c.kind || "", sheet: c.sheet || "surface",
      r_mm: c.r, r_m: rWorld, diam_m: rWorld * 2,
    });
  }

  const files = [];
  let bbox = null;
  if (lineRecs.length) {
    const w = writeSHP(lineRecs, SHP_POLYLINE);
    bbox = w.bbox;
    files.push({ name: `${stem}-lines.shp`, data: w.shp });
    files.push({ name: `${stem}-lines.shx`, data: w.shx });
    files.push({ name: `${stem}-lines.dbf`, data: writeDBF(LINE_FIELDS, lineRows, o) });
  } else {
    notes.push("no line work in this drawing, so no line layer was written");
  }
  if (ptRecs.length) {
    const w = writeSHP(ptRecs, SHP_POINT);
    if (!bbox) bbox = w.bbox;
    files.push({ name: `${stem}-points.shp`, data: w.shp });
    files.push({ name: `${stem}-points.shx`, data: w.shx });
    files.push({ name: `${stem}-points.dbf`, data: writeDBF(POINT_FIELDS, ptRows, o) });
  }

  const wkt = prjFor(o.crs);
  if (wkt) {
    const bytes = new TextEncoder().encode(wkt);
    if (lineRecs.length) files.push({ name: `${stem}-lines.prj`, data: bytes });
    if (ptRecs.length) files.push({ name: `${stem}-points.prj`, data: bytes });
  } else {
    notes.push(o.crs
      ? `the raster declares ${o.crs}, which this tool cannot write as WKT — no .prj was `
        + `written, so QGIS will ask for the CRS once. Setting it there is correct; the `
        + `coordinates themselves are already right.`
      : "the raster carries no CRS, so no .prj was written and the coordinates are in "
        + "whatever units the file used. QGIS will ask.");
  }
  return { files, lines: lineRecs.length, points: ptRecs.length,
    crs: o.crs || null, prj: !!wkt, bbox, notes };
}
