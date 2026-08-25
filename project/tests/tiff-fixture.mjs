// A GeoTIFF built byte by byte, in any compression the reader claims to open.
//
// ⚠️ THE POINT IS TO TEST THE COMPRESSED PATH AGAINST A KNOWN ANSWER. Real
// files test that the reader copes with the wild, which matters — but when a
// compressed raster comes back looking like plausible terrain there is no way
// to tell correct from subtly-wrong. Writing the elevations here means the
// decoded array can be compared against the array that went in, exactly.
import zlib from "node:zlib";

/**
 * TIFF's LZW, MSB-first with early change — the mirror of `lzwDecode`.
 *
 * ⚠️ WRITTEN HERE RATHER THAN IMPORTED because a decoder tested against its own
 * encoder proves only that they share a misunderstanding. This one follows the
 * TIFF 6 specification's pseudocode directly, and the decoder was written from
 * the same text independently; a common error would have to be made twice, in
 * opposite directions, to pass.
 * @param {Uint8Array} src @returns {Uint8Array}
 */
export function tiffLZWEncode(src) {
  const out = [];
  let bitBuf = 0, bitCount = 0;
  const emit = (code, width) => {
    bitBuf = (bitBuf << width) | code;
    bitCount += width;
    while (bitCount >= 8) { out.push((bitBuf >> (bitCount - 8)) & 0xff); bitCount -= 8; }
  };
  /** @type {Map<string, number>} */
  let table = new Map();
  let next = 258, width = 9;
  const reset = () => {
    table = new Map();
    for (let i = 0; i < 256; i++) table.set(String.fromCharCode(i), i);
    next = 258; width = 9;
  };
  reset();
  emit(256, width);                                   // ClearCode first
  let omega = "";
  for (let i = 0; i < src.length; i++) {
    const k = String.fromCharCode(src[i]);
    const cat = omega + k;
    if (table.has(cat)) { omega = cat; continue; }
    emit(table.get(omega), width);
    table.set(cat, next++);
    // early change: widen one code before the table would overflow
    if (next + 1 > (1 << width) && width < 12) width++;
    if (next >= 4094) { emit(256, width); reset(); }
    omega = k;
  }
  if (omega) emit(table.get(omega), width);
  emit(257, width);                                    // EndOfInformation
  if (bitCount > 0) out.push((bitBuf << (8 - bitCount)) & 0xff);
  return Uint8Array.from(out);
}

/** PackBits, the simple correct form: literal runs only, plus true repeats. */
function packbitsEncode(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && src[i + run] === src[i] && run < 128) run++;
    if (run >= 2) { out.push(257 - run, src[i]); i += run; }
    else {
      let lit = 1;
      while (i + lit < src.length && lit < 128 &&
             !(i + lit + 1 < src.length && src[i + lit] === src[i + lit + 1])) lit++;
      out.push(lit - 1);
      for (let k = 0; k < lit; k++) out.push(src[i + k]);
      i += lit;
    }
  }
  return Uint8Array.from(out);
}

/**
 * The FLOATING-POINT predictor (3), encoding side — written from the TIFF
 * specification's description rather than by inverting the decoder, so a
 * shared misunderstanding cannot pass the round-trip.
 *
 * Separate each sample's bytes into planes, most significant plane first, then
 * difference the resulting byte sequence along the row.
 */
function predictFloat32(buf, width, rows) {
  const bps = 4, words = width;
  const rowBytes = width * bps;
  const tmp = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const base = r * rowBytes;
    // 1 · scatter into byte planes (little-endian file: byte 3 is the MSB)
    for (let w = 0; w < words; w++) {
      for (let b = 0; b < bps; b++) tmp[b * words + w] = buf[base + w * bps + (bps - b - 1)];
    }
    // 2 · difference along the row, backwards so each step sees the original
    for (let i = rowBytes - 1; i >= 1; i--) tmp[i] = (tmp[i] - tmp[i - 1]) & 0xff;
    buf.set(tmp, base);
  }
  return buf;
}

/** Horizontal differencing over 32-bit samples, little-endian. */
function predict32(buf, width, rows) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let r = 0; r < rows; r++) {
    const base = r * width * 4;
    for (let i = width - 1; i >= 1; i--) {
      const at = base + i * 4;
      dv.setUint32(at, (dv.getUint32(at, true) - dv.getUint32(at - 4, true)) >>> 0, true);
    }
  }
  return buf;
}

const compress = (how, bytes) => {
  if (how === 1) return bytes;
  if (how === 8 || how === 32946) return new Uint8Array(zlib.deflateSync(Buffer.from(bytes)));
  if (how === 5) return tiffLZWEncode(bytes);
  if (how === 32773) return packbitsEncode(bytes);
  return bytes;                                        // e.g. 7, to test refusal
};

/**
 * A single-band Float32 GeoTIFF.
 *
 * @param {Float32Array} z @param {number} width @param {number} height
 * @param {{compression?:number, predictor?:number, rowsPerStrip?:number,
 *          tile?:number, cell?:number, originX?:number, originY?:number,
 *          epsg?:number}} [o]
 * @returns {ArrayBuffer}
 */
export function makeTIFF(z, width, height, o = {}) {
  const comp = o.compression ?? 1;
  const predictor = o.predictor ?? 1;
  const cell = o.cell ?? 1;
  const originX = o.originX ?? 500000, originY = o.originY ?? 7600000;
  const epsg = o.epsg ?? 25833;

  /** @type {Uint8Array[]} */
  const chunks = [];
  let tags;

  if (o.tile) {
    const t = o.tile;
    const across = Math.ceil(width / t), down = Math.ceil(height / t);
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        // ⚠️ TILES ARE PADDED TO THEIR FULL SIZE, always — that is the format,
        // and it is why the reader must run the predictor over the TILE width.
        const buf = new Uint8Array(t * t * 4);
        const dv = new DataView(buf.buffer);
        for (let r = 0; r < t; r++) {
          for (let c = 0; c < t; c++) {
            const y = ty * t + r, x = tx * t + c;
            const v = (y < height && x < width) ? z[y * width + x] : 0;
            dv.setFloat32((r * t + c) * 4, v, true);
          }
        }
        if (predictor === 2) predict32(buf, t, t);
        else if (predictor === 3) predictFloat32(buf, t, t);
        chunks.push(compress(comp, buf));
      }
    }
    tags = { tiled: true, tileW: t, tileH: t };
  } else {
    const rps = o.rowsPerStrip ?? height;
    for (let y0 = 0; y0 < height; y0 += rps) {
      const rows = Math.min(rps, height - y0);
      const buf = new Uint8Array(rows * width * 4);
      const dv = new DataView(buf.buffer);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < width; c++) dv.setFloat32((r * width + c) * 4, z[(y0 + r) * width + c], true);
      }
      if (predictor === 2) predict32(buf, width, rows);
      else if (predictor === 3) predictFloat32(buf, width, rows);
      chunks.push(compress(comp, buf));
    }
    tags = { tiled: false, rowsPerStrip: rps };
  }

  // ── assemble ────────────────────────────────────────────────────────────
  const entries = [];
  const add = (tag, type, values) => entries.push({ tag, type, values });
  add(256, 3, [width]);
  add(257, 3, [height]);
  add(258, 3, [32]);
  add(259, 3, [comp]);
  add(262, 3, [1]);
  add(277, 3, [1]);
  add(284, 3, [1]);
  if (predictor !== 1) add(317, 3, [predictor]);
  add(339, 3, [3]);                                    // IEEE float
  if (tags.tiled) {
    add(322, 3, [tags.tileW]); add(323, 3, [tags.tileH]);
    add(324, 4, chunks.map(() => 0));                  // offsets, patched below
    add(325, 4, chunks.map((c) => c.length));
  } else {
    add(273, 4, chunks.map(() => 0));
    add(278, 3, [tags.rowsPerStrip]);
    add(279, 4, chunks.map((c) => c.length));
  }
  add(33550, 12, [cell, cell, 0]);
  add(33922, 12, [0, 0, 0, originX, originY, 0]);
  add(34735, 3, [1, 1, 0, 1, 3072, 0, 1, epsg]);
  entries.sort((a, b) => a.tag - b.tag);

  const SZ = { 3: 2, 4: 4, 12: 8 };
  const n = entries.length;
  const ifdAt = 8;
  const ifdLen = 2 + n * 12 + 4;
  let dataAt = ifdAt + ifdLen;
  const overflow = [];
  const layout = entries.map((e) => {
    const size = SZ[e.type] * e.values.length;
    const rec = { ...e, inline: size <= 4, at: 0 };
    if (!rec.inline) { rec.at = dataAt; dataAt += size; overflow.push(rec); }
    return rec;
  });
  // Blocks go after every tag's overflow area.
  const offsets = [];
  let blockAt = dataAt;
  for (const c of chunks) { offsets.push(blockAt); blockAt += c.length; }
  const total = blockAt;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdAt, true);
  dv.setUint16(ifdAt, n, true);

  const offsetTag = tags.tiled ? 324 : 273;
  layout.forEach((e, i) => {
    if (e.tag === offsetTag) e.values = offsets;
    const at = ifdAt + 2 + i * 12;
    dv.setUint16(at, e.tag, true);
    dv.setUint16(at + 2, e.type, true);
    dv.setUint32(at + 4, e.values.length, true);
    const write = (base) => e.values.forEach((v, k) => {
      if (e.type === 3) dv.setUint16(base + k * 2, v, true);
      else if (e.type === 4) dv.setUint32(base + k * 4, v, true);
      else dv.setFloat64(base + k * 8, v, true);
    });
    if (e.inline) write(at + 8);
    else { dv.setUint32(at + 8, e.at, true); write(e.at); }
  });
  dv.setUint32(ifdAt + 2 + n * 12, 0, true);
  chunks.forEach((c, i) => out.set(c, offsets[i]));
  return out.buffer;
}
