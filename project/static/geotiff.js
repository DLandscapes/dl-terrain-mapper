// @ts-check
// GEOTIFF IN — elevation rasters and orthophotos, read in the browser.
//
// ⚠️ NOTHING IS UPLOADED, EVER, AND THAT IS ARCHITECTURE RATHER THAN POLICY.
// This tool has no server: `launcher.py` serves static files and receives
// nothing back. A raster dropped on the window is read here, in the page, and
// the only thing that ever leaves is a DXF the user asks for and saves. The
// same property is what lets field photographs be handled at all — see exif.js
// — and it is inherited from DL-TerrainDiversity, where it was a deliberate
// answer to the licence conditions on Norwegian aerial imagery.
//
// ⚠️ ONE TAG WALK, TWO VIEWS. The elevation reader wants one band widened into
// Float32 measurements; the ortho reader wants three or four 8-bit channels
// kept interleaved. Those are different outputs from the SAME directory walk,
// and this file does the walk once. The sibling project keeps two readers on
// the argument that its elevation path is load-bearing and not worth the risk
// of a generic one — a fair call there, made before it had a test suite for the
// reader. Here the reader is covered by tests, so the duplication would cost
// more than it saves.
//
// ⚠️ NODATA BECOMES NaN AT THIS BOUNDARY AND NOWHERE ELSE. GDAL_NODATA, the
// −9999 convention and float sentinels near −3.4e38 all mean the same thing and
// all get the same answer, so that no module downstream ever has to know which
// convention this particular file used.

import { decompressBlock, unpredict, unpredictFloat } from "./decompress.js";

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

const T = {
  WIDTH: 256, LENGTH: 257, BITS: 258, COMPRESSION: 259, PHOTOMETRIC: 262,
  STRIP_OFFSETS: 273, SAMPLES: 277, ROWS_PER_STRIP: 278, STRIP_COUNTS: 279,
  PLANAR: 284, PREDICTOR: 317, SAMPLE_FORMAT: 339,
  TILE_WIDTH: 322, TILE_LENGTH: 323, TILE_OFFSETS: 324, TILE_COUNTS: 325,
  PIXEL_SCALE: 33550, TIEPOINT: 33922, TRANSFORM: 34264,
  GEO_KEYS: 34735, GDAL_NODATA: 42113,
};

/**
 * The image file directory, as a map of tag → values.
 * @param {ArrayBuffer} buf
 */
function readIFD(buf) {
  const dv = new DataView(buf);
  const bom = dv.getUint16(0, false);
  const le = bom === 0x4949;
  if (!le && bom !== 0x4d4d) throw new Error("not a TIFF (no byte-order mark)");
  const magic = dv.getUint16(2, le);
  // ⚠️ BIGTIFF IS REFUSED BY NAME. It shares the byte-order mark, so a reader
  // that only checks that mark walks a BigTIFF's 8-byte offsets as 4-byte ones
  // and returns a plausible-looking raster of noise. Version 43 is BigTIFF.
  if (magic === 43) throw new Error("BigTIFF is not supported — export as a classic TIFF");
  if (magic !== 42) throw new Error("not a TIFF (bad version)");

  const ifd = dv.getUint32(4, le);
  const n = dv.getUint16(ifd, le);
  /** @type {Map<number, number[]>} */
  const tags = new Map();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const count = dv.getUint32(e + 4, le);
    const size = TYPE_SIZE[type] || 0;
    if (!size) continue;
    const total = size * count;
    const at = total <= 4 ? e + 8 : dv.getUint32(e + 8, le);
    const vals = [];
    for (let k = 0; k < count; k++) {
      const p = at + k * size;
      if (p + size > buf.byteLength) break;
      switch (type) {
        case 1: case 7: vals.push(dv.getUint8(p)); break;
        case 2: vals.push(dv.getUint8(p)); break;                       // ASCII
        case 3: vals.push(dv.getUint16(p, le)); break;
        case 4: vals.push(dv.getUint32(p, le)); break;
        case 5: vals.push(dv.getUint32(p, le) / (dv.getUint32(p + 4, le) || 1)); break;
        case 6: vals.push(dv.getInt8(p)); break;
        case 8: vals.push(dv.getInt16(p, le)); break;
        case 9: vals.push(dv.getInt32(p, le)); break;
        case 10: vals.push(dv.getInt32(p, le) / (dv.getInt32(p + 4, le) || 1)); break;
        case 11: vals.push(dv.getFloat32(p, le)); break;
        case 12: vals.push(dv.getFloat64(p, le)); break;
      }
    }
    tags.set(tag, vals);
  }
  return { dv, le, tags };
}

/** Georeferencing: cell size and the north-west corner. */
function geoFrom(tags, width, height) {
  const scale = tags.get(T.PIXEL_SCALE);
  const tie = tags.get(T.TIEPOINT);
  const mat = tags.get(T.TRANSFORM);
  if (scale && tie && scale.length >= 2 && tie.length >= 6) {
    // ⚠️ NON-SQUARE PIXELS ARE REFUSED, NOT AVERAGED. Every measurement in this
    // family — slope, contour spacing, symbol radius — assumes one cell size.
    // Averaging an anisotropic raster produces a drawing that is quietly wrong
    // in one direction, which is the hardest kind of wrong to notice.
    const sx = Math.abs(scale[0]), sy = Math.abs(scale[1]);
    if (sx > 0 && sy > 0 && Math.abs(sx - sy) / Math.max(sx, sy) > 1e-6) {
      throw new Error(`non-square pixels (${sx} × ${sy}) — resample before loading`);
    }
    return { cell: sx, originX: tie[3], originY: tie[4] };
  }
  if (mat && mat.length >= 16) {
    if (Math.abs(mat[1]) > 1e-9 || Math.abs(mat[4]) > 1e-9) {
      throw new Error("rotated raster — north-up only");
    }
    return { cell: Math.abs(mat[0]), originX: mat[3], originY: mat[7] };
  }
  // ⚠️ AN UNGEOREFERENCED RASTER STILL LOADS, at one unit per cell and its
  // corner at zero. Refusing it would block the commonest teaching case — a
  // plain heightfield exported from anywhere — and the drawing is still correct
  // relative to itself. What the tool must never do is claim a CRS it does not
  // have, so `crs` stays undefined and the report says so.
  return { cell: 1, originX: 0, originY: height, ungeoreferenced: true };
}

/**
 * EPSG from the GeoKey directory, when there is one.
 *
 * ⚠️ THE PROJECTED KEY WINS OVER THE GEOGRAPHIC ONE, ALWAYS. A projected
 * GeoTIFF normally carries BOTH: 3072 ProjectedCSTypeGeoKey naming the grid the
 * coordinates are actually in, and 2048 GeographicTypeGeoKey naming the datum
 * that grid is built on. Ørndalen's 4 m tile is the case that caught this —
 * it stores 2048 = 4258 (ETRS89, a geographic CRS in DEGREES) beside eastings
 * of 654350, and taking the first key found labels a UTM raster as lat/lon.
 * Nothing downstream reprojects on that label today, so the damage would be a
 * wrong line in the report rather than displaced geometry — but the photograph
 * path DOES reproject, and it reads this field.
 */
function crsFrom(tags) {
  const k = tags.get(T.GEO_KEYS);
  if (!k || k.length < 4) return undefined;
  const n = k[3];
  /** @param {number} want */
  const find = (want) => {
    for (let i = 0; i < n; i++) {
      const key = k[4 + i * 4], loc = k[5 + i * 4], val = k[7 + i * 4];
      if (key === want && loc === 0 && val && val !== 32767) return `EPSG:${val}`;
    }
    return undefined;
  };
  return find(3072) || find(2048);
}

/** Every strip or tile, as one flat byte range list. */
function blocks(tags) {
  const tw = tags.get(T.TILE_WIDTH), tl = tags.get(T.TILE_LENGTH);
  if (tw && tl) {
    return {
      tiled: true, tileW: tw[0], tileH: tl[0],
      offsets: tags.get(T.TILE_OFFSETS) || [], counts: tags.get(T.TILE_COUNTS) || [],
    };
  }
  const rps = tags.get(T.ROWS_PER_STRIP);
  return {
    tiled: false, rowsPerStrip: rps ? rps[0] : Infinity,
    offsets: tags.get(T.STRIP_OFFSETS) || [], counts: tags.get(T.STRIP_COUNTS) || [],
  };
}

/** One sample out of a block, by format. */
function readerFor(dv, le, bits, format) {
  const bytes = bits / 8;
  if (format === 3) {
    if (bits === 32) return { bytes, get: (p) => dv.getFloat32(p, le) };
    if (bits === 64) return { bytes, get: (p) => dv.getFloat64(p, le) };
  } else if (format === 2) {
    if (bits === 8) return { bytes, get: (p) => dv.getInt8(p) };
    if (bits === 16) return { bytes, get: (p) => dv.getInt16(p, le) };
    if (bits === 32) return { bytes, get: (p) => dv.getInt32(p, le) };
  } else {
    if (bits === 8) return { bytes, get: (p) => dv.getUint8(p) };
    if (bits === 16) return { bytes, get: (p) => dv.getUint16(p, le) };
    if (bits === 32) return { bytes, get: (p) => dv.getUint32(p, le) };
  }
  throw new Error(`unsupported sample: ${bits}-bit format ${format}`);
}

/**
 * Read a TIFF into interleaved samples plus its georeferencing.
 *
 * @param {ArrayBuffer} buf
 * @returns {{width:number, height:number, samples:number, data:Float64Array,
 *            cell:number, originX:number, originY:number, crs?:string,
 *            nodata?:number, ungeoreferenced?:boolean}}
 */
export function readTIFF(buf) {
  const { dv, le, tags } = readIFD(buf);
  const comp = (tags.get(T.COMPRESSION) || [1])[0];
  const width = (tags.get(T.WIDTH) || [0])[0];
  const height = (tags.get(T.LENGTH) || [0])[0];
  if (!width || !height) throw new Error("TIFF has no size");
  const spp = (tags.get(T.SAMPLES) || [1])[0];
  const bitsArr = tags.get(T.BITS) || [8];
  const bits = bitsArr[0];
  if (bitsArr.some((b) => b !== bits)) throw new Error("mixed sample widths are not supported");
  const fmtArr = tags.get(T.SAMPLE_FORMAT) || [1];
  const format = fmtArr[0];
  // ⚠️ PLANAR CONFIGURATION IS MEANINGLESS FOR A SINGLE BAND, and refusing on
  // it cost this reader seven of the project's own elevation rasters — every
  // Ørndalen difference model, each one band of Float32 with the tag set to 2.
  // "Band-separate" describes how MULTIPLE bands are laid out; with one band
  // there is nothing to separate and the two layouts are byte-identical. Only
  // a genuinely multi-band planar file has to be refused.
  const planar = (tags.get(T.PLANAR) || [1])[0];
  if (planar !== 1 && spp > 1) {
    throw new Error(`planar (band-separate) ${spp}-band TIFFs are not supported `
      + `— re-export interleaved (INTERLEAVE=PIXEL)`);
  }
  const predictor = (tags.get(T.PREDICTOR) || [1])[0];
  if (predictor !== 1 && predictor !== 2 && predictor !== 3) {
    throw new Error(`predictor ${predictor} is not a TIFF predictor this reader knows `
      + `(1 none, 2 horizontal, 3 floating point)`);
  }
  if (predictor === 3 && format !== 3) {
    // The float predictor is only defined for floating-point samples; applied
    // to integers it would reassemble byte planes that were never separated.
    throw new Error("predictor 3 is the floating-point predictor but this raster is "
      + `sample format ${format}, not float`);
  }
  // ⚠️ ONE NAME FOR "UNDO WHATEVER THE PREDICTOR DID", chosen once here. The
  // two algorithms take the same arguments and differ entirely inside, and the
  // call sites below must not have to know which is which — that is exactly
  // where a tiled raster ends up de-predicted one way and a striped one the
  // other.
  const undoPredictor = predictor === 3 ? unpredictFloat : predictor === 2 ? unpredict : null;

  const bytes = bits >> 3;
  // Validated once, up front: an unsupported bit depth should be refused before
  // any decompression work, not thrown from inside the first block.
  readerFor(dv, le, bits, format);
  const b = blocks(tags);
  const out = new Float64Array(width * height * spp);
  out.fill(NaN);
  const whole = new Uint8Array(buf);

  // ⚠️ EVERY BLOCK IS DECOMPRESSED INTO ITS OWN BUFFER AND READ FROM THERE.
  // The uncompressed path used to index straight into the file, which is fast
  // and impossible to extend: a Deflate strip has no fixed relationship between
  // its position in the file and the pixel it holds. Routing both cases through
  // the same block reader costs one copy per strip and means compressed and
  // uncompressed rasters cannot drift apart in behaviour — the commonest way a
  // reader ends up correct on the format nobody uses.
  /** @param {number} idx @param {number} expected */
  const block = (idx, expected) => {
    const off = b.offsets[idx];
    if (off === undefined) return null;
    const count = b.counts[idx] ?? expected;
    const raw = whole.subarray(off, Math.min(off + count, whole.length));
    let data;
    try { data = decompressBlock(comp, raw, expected); }
    catch (e) { throw new Error(`${e.message} (block ${idx})`); }
    return data;
  };
  /** A sample out of a decompressed block. */
  const sampler = (data) => {
    const dvb = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return readerFor(dvb, le, bits, format).get;
  };

  if (b.tiled) {
    const across = Math.ceil(width / b.tileW);
    const down = Math.ceil(height / b.tileH);
    const expected = b.tileW * b.tileH * spp * bytes;
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        const data = block(ty * across + tx, expected);
        if (!data) continue;
        // ⚠️ A TILE'S PREDICTOR RUNS OVER THE TILE'S OWN WIDTH, not the
        // image's. Tiles are padded to their full width even at the right edge,
        // and differencing was applied across that padding.
        if (undoPredictor) undoPredictor(data, b.tileW, spp, bits, b.tileH, le);
        const get = sampler(data);
        for (let r = 0; r < b.tileH; r++) {
          const y = ty * b.tileH + r;
          if (y >= height) break;
          for (let c = 0; c < b.tileW; c++) {
            const x = tx * b.tileW + c;
            if (x >= width) continue;
            const src = (r * b.tileW + c) * spp * bytes;
            for (let s = 0; s < spp; s++) {
              const p = src + s * bytes;
              if (p + bytes <= data.length) out[(y * width + x) * spp + s] = get(p);
            }
          }
        }
      }
    }
  } else {
    const rps = Math.min(b.rowsPerStrip, height);
    const nStrips = Math.ceil(height / rps);
    for (let sIdx = 0; sIdx < nStrips; sIdx++) {
      const y0 = sIdx * rps;
      const rows = Math.min(rps, height - y0);
      const data = block(sIdx, rows * width * spp * bytes);
      if (!data) continue;
      if (undoPredictor) undoPredictor(data, width, spp, bits, rows, le);
      const get = sampler(data);
      for (let r = 0; r < rows; r++) {
        const rowStart = r * width * spp * bytes;
        for (let x = 0; x < width; x++) {
          for (let s = 0; s < spp; s++) {
            const p = rowStart + (x * spp + s) * bytes;
            if (p + bytes <= data.length) out[((y0 + r) * width + x) * spp + s] = get(p);
          }
        }
      }
    }
  }

  const nd = tags.get(T.GDAL_NODATA);
  let nodata;
  if (nd && nd.length) {
    const txt = nd.map((c) => String.fromCharCode(c)).join("").replace(/\0+$/, "").trim();
    const v = Number(txt);
    if (Number.isFinite(v)) nodata = v;
  }
  return {
    width, height, samples: spp, data: out,
    ...geoFrom(tags, width, height),
    crs: crsFrom(tags), nodata,
  };
}

/**
 * A TIFF as an elevation DEM.
 *
 * @param {ArrayBuffer} buf @param {{name?:string, band?:number}} [o]
 * @returns {import("./dem.js").DEM}
 */
export function readElevation(buf, o = {}) {
  const t = readTIFF(buf);
  const band = Math.min(o.band ?? 0, t.samples - 1);
  const z = new Float32Array(t.width * t.height);
  const nd = t.nodata;
  for (let i = 0; i < z.length; i++) {
    const v = t.data[i * t.samples + band];
    z[i] = isNoData(v, nd) ? NaN : v;
  }
  return {
    nrows: t.height, ncols: t.width, cell: t.cell,
    originX: t.originX, originY: t.originY,
    z, crs: t.crs, name: o.name,
  };
}

/**
 * Every sentinel that means "no measurement here".
 *
 * ⚠️ THE FLOAT SENTINELS ARE MATCHED BY MAGNITUDE, NOT BY EQUALITY. −3.4e38 is
 * written by different producers with different last digits and compared as a
 * float it is a coin toss; anything beyond ±1e30 is not an elevation on this
 * planet, so the magnitude test is both safer and more honest.
 */
function isNoData(v, nd) {
  if (!Number.isFinite(v)) return true;
  if (nd !== undefined && v === nd) return true;
  if (Math.abs(v) > 1e30) return true;
  return v === -9999 || v === -32768 || v === -32767;
}

/**
 * A TIFF as an RGB image plus its georeferencing — the ortho path.
 *
 * ⚠️ READ THE LICENCE NOTE IN halftone.js BEFORE EXPORTING ANYTHING MADE FROM
 * THIS. Aerial imagery in this family is frequently licensed for education and
 * research only, with redistribution forbidden, and a halftone is a derivative
 * that carries the pixels. The provenance flag travels with the image from here.
 *
 * @param {ArrayBuffer} buf @param {{name?:string}} [o]
 * @returns {{width:number, height:number, rgb:Uint8ClampedArray, cell:number,
 *            originX:number, originY:number, crs?:string, name?:string}}
 */
export function readOrtho(buf, o = {}) {
  const t = readTIFF(buf);
  if (t.samples < 3) throw new Error(`orthophoto needs 3 or 4 bands, this has ${t.samples}`);
  const rgb = new Uint8ClampedArray(t.width * t.height * 3);
  // 16-bit imagery is common from photogrammetry and must be brought down to
  // the 0..255 the halftone works in; the shift is chosen from the data's own
  // range rather than assumed, because a 12-bit sensor in a 16-bit container
  // would otherwise come out almost black.
  let hi = 0;
  for (let i = 0; i < t.data.length; i++) if (t.data[i] > hi) hi = t.data[i];
  const k = hi > 255 ? 255 / hi : 1;
  for (let i = 0, n = t.width * t.height; i < n; i++) {
    for (let s = 0; s < 3; s++) rgb[i * 3 + s] = t.data[i * t.samples + s] * k;
  }
  return {
    width: t.width, height: t.height, rgb,
    cell: t.cell, originX: t.originX, originY: t.originY, crs: t.crs, name: o.name,
  };
}
