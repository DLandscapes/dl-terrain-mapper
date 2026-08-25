// @ts-check
// THE THREE COMPRESSIONS A GEOTIFF ACTUALLY ARRIVES IN.
//
// ⚠️ THIS FILE EXISTS BECAUSE "RE-EXPORT UNCOMPRESSED" IS NOT AN ACCEPTABLE
// ANSWER. The reader used to refuse anything compressed and tell the user to
// run gdal_translate. Almost every GeoTIFF in the world is Deflate or LZW —
// QGIS writes Deflate by default, Kartverket ships LZW — so the tool refused
// nearly every real file anyone would drop on it, and the workaround demanded
// a command-line GDAL install that the browser-only promise was supposed to
// avoid. A raster that cannot be opened is a tool that cannot be used.
//
// ⚠️ SYNCHRONOUS AND DEPENDENCY-FREE, DELIBERATELY. The browser has
// DecompressionStream, which would do Deflate in three lines — and it is
// async, which would turn readTIFF and every caller above it into a promise
// chain, and it does not help with LZW or PackBits at all. Hand-written
// inflate is about 120 lines, runs in Node for the test suite exactly as it
// runs in the page, and keeps the whole read path a plain function call.
//
// ⚠️ THE PREDICTOR IS PART OF THE DECOMPRESSION, NOT AN EXTRA. Deflate and LZW
// are nearly always written with horizontal differencing (predictor 2), because
// it is what makes them compress a raster at all. Decompressing without undoing
// it yields a picture that is plausible at the left edge and drifts into noise
// across every row — data that looks like data. Anything that inflates a strip
// must call `unpredict` on it.

// ── DEFLATE ────────────────────────────────────────────────────────────────
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43,
  51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257,
  385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman table: how many codes of each length, and the symbols. */
function huffman(lengths, n) {
  const counts = new Int32Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offs = new Int32Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Int32Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

/** Bit reader, LSB first — Deflate's order. */
function bitReader(src) {
  let pos = 0, bit = 0, val = 0;
  return {
    bits(need) {
      while (bit < need) {
        val |= (pos < src.length ? src[pos++] : 0) << bit;
        bit += 8;
      }
      const out = val & ((1 << need) - 1);
      val >>>= need; bit -= need;
      return out;
    },
    align() { val = 0; bit = 0; },
    byte() { return pos < src.length ? src[pos++] : 0; },
    get pos() { return pos; },
    set pos(p) { pos = p; },
  };
}

function decodeSymbol(br, tree) {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len < 16; len++) {
    code |= br.bits(1);
    const count = tree.counts[len];
    if (code - first < count) return tree.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("bad Huffman code");
}

let FIXED_LIT = null, FIXED_DIST = null;
function fixedTrees() {
  if (FIXED_LIT) return;
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  FIXED_LIT = huffman(l, 288);
  const d = new Uint8Array(30).fill(5);
  FIXED_DIST = huffman(d, 30);
}

/**
 * Raw DEFLATE, or a zlib stream (the two-byte header is detected and skipped).
 *
 * @param {Uint8Array} src
 * @param {number} expected uncompressed byte count, known from the TIFF tags
 * @returns {Uint8Array}
 */
export function inflate(src, expected) {
  let start = 0;
  // ⚠️ TIFF WRITES *ZLIB*, NOT RAW DEFLATE, whatever the tag is called. The
  // two-byte header (CMF/FLG, 0x78 then a check byte making the pair divisible
  // by 31) must be skipped or the first block header is read out of a length
  // field and the whole stream decodes to nothing. Detected rather than
  // assumed, because a few writers do emit raw.
  if (src.length > 2 && (src[0] & 0x0f) === 8 && ((src[0] << 8 | src[1]) % 31) === 0) start = 2;
  const br = bitReader(src.subarray(start));
  const out = new Uint8Array(expected);
  let o = 0;
  for (;;) {
    const final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {                                   // stored
      br.align();
      const len = br.byte() | (br.byte() << 8);
      br.byte(); br.byte();                             // ~len, unchecked
      for (let i = 0; i < len; i++) { if (o < expected) out[o++] = br.byte(); else br.byte(); }
    } else if (type === 1 || type === 2) {
      let lit, dist;
      if (type === 1) { fixedTrees(); lit = FIXED_LIT; dist = FIXED_DIST; }
      else {
        const hlit = br.bits(5) + 257, hdist = br.bits(5) + 1, hclen = br.bits(4) + 4;
        const clen = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = br.bits(3);
        const ctree = huffman(clen, 19);
        const lengths = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = decodeSymbol(br, ctree);
          if (sym < 16) lengths[i++] = sym;
          else if (sym === 16) { const p = lengths[i - 1], n = 3 + br.bits(2); for (let k = 0; k < n; k++) lengths[i++] = p; }
          else if (sym === 17) { const n = 3 + br.bits(3); for (let k = 0; k < n; k++) lengths[i++] = 0; }
          else { const n = 11 + br.bits(7); for (let k = 0; k < n; k++) lengths[i++] = 0; }
        }
        lit = huffman(lengths.subarray(0, hlit), hlit);
        dist = huffman(lengths.subarray(hlit), hdist);
      }
      for (;;) {
        const sym = decodeSymbol(br, lit);
        if (sym === 256) break;
        if (sym < 256) { if (o < expected) out[o++] = sym; }
        else {
          const li = sym - 257;
          if (li >= LEN_BASE.length) throw new Error("bad length code");
          const length = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
          const ds = decodeSymbol(br, dist);
          const distance = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]);
          for (let i = 0; i < length; i++) { if (o < expected) { out[o] = out[o - distance]; o++; } }
        }
      }
    } else throw new Error("bad Deflate block type");
    if (final) break;
    if (o >= expected) break;
  }
  return out;
}

// ── LZW, the TIFF variant ──────────────────────────────────────────────────
/**
 * ⚠️ TIFF LZW IS MSB-FIRST AND USES "EARLY CHANGE". Two details, both of which
 * produce a decoder that works on the first few hundred bytes and then turns to
 * noise. The bits pack from the top of the byte, the opposite of Deflate; and
 * the code width grows one code EARLIER than the obvious reading of the
 * algorithm — at 511, 1023 and 2047 rather than 512, 1024 and 2048. The early
 * change is what almost every real TIFF writer does and what the TIFF 6 spec
 * describes; getting it wrong desynchronises the stream exactly when the
 * dictionary fills.
 *
 * @param {Uint8Array} src @param {number} expected @returns {Uint8Array}
 */
export function lzwDecode(src, expected) {
  const CLEAR = 256, EOI = 257;
  const out = new Uint8Array(expected);
  let o = 0;
  /** @type {(Uint8Array|null)[]} */
  let table = [];
  let next = 258, width = 9;
  const reset = () => {
    table = new Array(4096);
    for (let i = 0; i < 256; i++) table[i] = Uint8Array.of(i);
    next = 258; width = 9;
  };
  reset();

  let bitPos = 0;
  const totalBits = src.length * 8;
  const read = () => {
    if (bitPos + width > totalBits) return EOI;
    let v = 0;
    for (let i = 0; i < width; i++) {
      const b = bitPos + i;
      v = (v << 1) | ((src[b >> 3] >> (7 - (b & 7))) & 1);
    }
    bitPos += width;
    return v;
  };

  let prev = null;
  for (;;) {
    const code = read();
    if (code === EOI) break;
    if (code === CLEAR) { reset(); prev = null; continue; }
    let entry;
    if (table[code]) entry = table[code];
    else if (prev) { entry = new Uint8Array(prev.length + 1); entry.set(prev); entry[prev.length] = prev[0]; }
    else throw new Error("LZW: code before any dictionary entry");
    if (o + entry.length > expected) {
      for (let i = 0; i < entry.length && o < expected; i++) out[o++] = entry[i];
      break;
    }
    out.set(entry, o); o += entry.length;
    if (prev && next < 4096) {
      const e = new Uint8Array(prev.length + 1);
      e.set(prev); e[prev.length] = entry[0];
      table[next++] = e;
    }
    prev = entry;
    // early change: widen one code before the table would overflow
    if (next + 1 >= (1 << width) && width < 12) width++;
    if (o >= expected) break;
  }
  return out;
}

// ── PackBits ───────────────────────────────────────────────────────────────
/** Apple's run-length scheme; the cheapest thing a TIFF is ever written with. */
export function packbits(src, expected) {
  const out = new Uint8Array(expected);
  let i = 0, o = 0;
  while (i < src.length && o < expected) {
    const n = (src[i++] << 24) >> 24;               // signed byte
    if (n >= 0) { for (let k = 0; k <= n && o < expected; k++) out[o++] = src[i++]; }
    else if (n !== -128) { const b = src[i++]; for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = b; }
  }
  return out;
}

// ── the predictor ──────────────────────────────────────────────────────────
/**
 * Undo horizontal differencing, in place.
 *
 * ⚠️ THE STRIDE IS THE SAMPLE, NOT THE BYTE. For 16- and 32-bit data the
 * difference was taken between whole samples, so undoing it byte-wise produces
 * a raster that is subtly, smoothly wrong — the worst kind, because it still
 * looks like terrain.
 *
 * @param {Uint8Array} buf @param {number} width pixels per row
 * @param {number} spp samples per pixel @param {number} bits bits per sample
 * @param {number} rows @param {boolean} little byte order
 */
export function unpredict(buf, width, spp, bits, rows, little) {
  const bytes = bits >> 3;
  const rowBytes = width * spp * bytes;
  if (bits === 8) {
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes;
      for (let i = spp; i < width * spp; i++) buf[base + i] = (buf[base + i] + buf[base + i - spp]) & 0xff;
    }
    return buf;
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let r = 0; r < rows; r++) {
    const base = r * rowBytes;
    for (let i = spp; i < width * spp; i++) {
      const at = base + i * bytes, prevAt = at - spp * bytes;
      if (at + bytes > buf.length) break;
      if (bits === 16) dv.setUint16(at, (dv.getUint16(at, little) + dv.getUint16(prevAt, little)) & 0xffff, little);
      else if (bits === 32) dv.setUint32(at, (dv.getUint32(at, little) + dv.getUint32(prevAt, little)) >>> 0, little);
    }
  }
  return buf;
}

/**
 * Undo the FLOATING-POINT predictor (TIFF predictor 3), in place.
 *
 * ⚠️ THIS IS NOT HORIZONTAL DIFFERENCING WITH FLOATS IN IT. It is a different
 * algorithm in two stages, and GDAL writes it by default for Float32 elevation
 * — `PREDICTOR=3` is the recommended setting for DEMs, so refusing it refuses
 * the commonest way a modern terrain raster is exported.
 *
 *   1 · The row's BYTES were separated into planes: every sample's most
 *       significant byte first, then every second byte, and so on. Floats in a
 *       smooth surface share exponents, so the high-byte plane becomes long
 *       runs of one value and Deflate can do something with it. Nothing about
 *       stage 1 is numeric.
 *   2 · Those bytes were then differenced along the row.
 *
 * So undoing it is: accumulate the bytes, THEN reassemble the words. Doing it
 * in the other order, or treating it as `unpredict` with a bigger stride,
 * yields floats that are finite, smooth and completely wrong — a terrain that
 * looks like terrain.
 *
 * ⚠️ PLANE 0 HOLDS THE MOST SIGNIFICANT BYTE, whatever the file's byte order.
 * On a little-endian TIFF that byte therefore lands LAST in each reassembled
 * word, which is the reversal in the inner loop below.
 *
 * @param {Uint8Array} buf @param {number} width pixels per row
 * @param {number} spp samples per pixel @param {number} bits bits per sample
 * @param {number} rows @param {boolean} little the FILE's byte order
 */
export function unpredictFloat(buf, width, spp, bits, rows, little) {
  const bps = bits >> 3;
  const rowBytes = width * spp * bps;
  const words = width * spp;
  const tmp = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const base = r * rowBytes;
    if (base + rowBytes > buf.length) break;
    // 1 · accumulate along the row, one sample's worth of bytes at a stride
    for (let i = spp; i < rowBytes; i++) {
      buf[base + i] = (buf[base + i] + buf[base + i - spp]) & 0xff;
    }
    // 2 · gather the byte planes back into words
    tmp.set(buf.subarray(base, base + rowBytes));
    for (let w = 0; w < words; w++) {
      for (let b = 0; b < bps; b++) {
        const to = base + w * bps + (little ? bps - b - 1 : b);
        buf[to] = tmp[b * words + w];
      }
    }
  }
  return buf;
}

/**
 * One compressed block, whatever it is compressed with.
 * @param {number} compression TIFF tag 259
 * @param {Uint8Array} src @param {number} expected
 */
export function decompressBlock(compression, src, expected) {
  switch (compression) {
    case 1: return src;
    case 5: return lzwDecode(src, expected);
    case 8: case 32946: return inflate(src, expected);
    case 32773: return packbits(src, expected);
    default: {
      const known = { 2: "CCITT Group 3", 3: "CCITT T.4", 4: "CCITT T.6", 6: "old JPEG", 7: "JPEG",
        34712: "JPEG 2000", 50000: "Zstd", 34925: "LZMA", 50001: "WebP" };
      throw new Error(`${known[compression] || `compression ${compression}`} is not supported — `
        + `re-export as Deflate, LZW, PackBits or uncompressed`);
    }
  }
}

/** Whether this build can open a given compression at all. */
export const SUPPORTED_COMPRESSION = [1, 5, 8, 32773, 32946];
