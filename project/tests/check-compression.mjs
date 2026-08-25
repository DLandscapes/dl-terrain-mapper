// node tests/check-compression.mjs
// The decompressors, against Node's own zlib and against a TIFF built here.
import zlib from "node:zlib";
import { inflate, lzwDecode, packbits, unpredict } from "../static/decompress.js";
import { readTIFF, readElevation } from "../static/geotiff.js";
import { makeTIFF, tiffLZWEncode } from "./tiff-fixture.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}${d ? " — " + d : ""}`); } };

console.log("── inflate, round-tripped against node:zlib ──");
{
  const cases = {
    "empty": new Uint8Array(0),
    "one byte": Uint8Array.of(42),
    "all zeros 64k": new Uint8Array(65536),
    "repetitive": new Uint8Array(40000).map((_, i) => (i % 7) * 30),
    "random 100k": (() => { const a = new Uint8Array(100000); for (let i = 0; i < a.length; i++) a[i] = (i * 2654435761) & 0xff; return a; })(),
    "text-like": new TextEncoder().encode("terrain ".repeat(5000)),
  };
  for (const [name, src] of Object.entries(cases)) {
    for (const [how, fn] of [["zlib", zlib.deflateSync], ["raw", zlib.deflateRawSync]]) {
      const packed = new Uint8Array(fn(Buffer.from(src)));
      let got;
      try { got = inflate(packed, src.length); }
      catch (e) { ok(`${name} / ${how}`, false, e.message); continue; }
      let same = got.length === src.length;
      if (same) for (let i = 0; i < src.length; i++) if (got[i] !== src[i]) { same = false; break; }
      ok(`${name} / ${how}`, same);
    }
  }
  // Levels matter: level 0 emits STORED blocks, which is a separate code path.
  for (const level of [0, 1, 6, 9]) {
    const src = new Uint8Array(30000).map((_, i) => (i * 31) & 0xff);
    const got = inflate(new Uint8Array(zlib.deflateSync(Buffer.from(src), { level })), src.length);
    ok(`level ${level}`, Buffer.compare(Buffer.from(got), Buffer.from(src)) === 0);
  }
}

console.log("── LZW, round-tripped against an encoder written here ──");
{
  for (const [name, src] of Object.entries({
    "short": new TextEncoder().encode("WED WE WEE WEB WET"),
    "repetitive 20k": new Uint8Array(20000).map((_, i) => (i % 5) * 50),
    "forces a table reset": new Uint8Array(200000).map((_, i) => (i * 7919) & 0xff),
  })) {
    const packed = tiffLZWEncode(src);
    const got = lzwDecode(packed, src.length);
    let same = got.length === src.length;
    if (same) for (let i = 0; i < src.length; i++) if (got[i] !== src[i]) { same = false; break; }
    ok(`LZW ${name}`, same);
  }
}

console.log("── PackBits ──");
{
  // The worked example from the TIFF 6 specification.
  const packed = Uint8Array.of(0xfe, 0xaa, 0x02, 0x80, 0x00, 0x2a, 0xfd, 0xaa, 0x03,
    0x80, 0x00, 0x2a, 0x22, 0xf7, 0xaa);
  const want = Uint8Array.of(0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0xaa, 0xaa, 0xaa, 0xaa,
    0x80, 0x00, 0x2a, 0x22, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa);
  const got = packbits(packed, want.length);
  ok("the TIFF 6 spec's own example", Buffer.compare(Buffer.from(got), Buffer.from(want)) === 0);
}

console.log("── the predictor ──");
{
  const rows = 3, width = 4, spp = 1;
  const orig = Uint8Array.of(10, 20, 30, 40, 5, 5, 5, 5, 200, 210, 220, 230);
  const diffed = new Uint8Array(orig);
  for (let r = 0; r < rows; r++) for (let i = width - 1; i >= 1; i--) {
    diffed[r * width + i] = (orig[r * width + i] - orig[r * width + i - 1]) & 0xff;
  }
  ok("8-bit differencing undoes exactly",
    Buffer.compare(Buffer.from(unpredict(diffed, width, spp, 8, rows, true)), Buffer.from(orig)) === 0);

  const o16 = new Uint16Array([1000, 1100, 1250, 900]);
  const b16 = new Uint8Array(o16.buffer.slice(0));
  const d16 = new DataView(b16.buffer);
  for (let i = 3; i >= 1; i--) d16.setUint16(i * 2, (o16[i] - o16[i - 1]) & 0xffff, true);
  unpredict(b16, 4, 1, 16, 1, true);
  const r16 = new Uint16Array(b16.buffer);
  ok("16-bit differencing steps by SAMPLE, not by byte",
    [...r16].join(",") === [...o16].join(","), [...r16].join(","));
}

console.log("── a whole compressed GeoTIFF ──");
{
  const W = 61, H = 47;                       // deliberately not a round number
  const z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    z[r * W + c] = 70 + 8 * Math.sin(c / 9) * Math.cos(r / 7) + c * 0.05;
  }
  const base = makeTIFF(z, W, H, { compression: 1 });
  const plain = readElevation(base, { name: "plain" });

  const variants = [
    ["Deflate", { compression: 8 }],
    ["Deflate + predictor 2", { compression: 8, predictor: 2 }],
    ["LZW", { compression: 5 }],
    ["LZW + predictor 2", { compression: 5, predictor: 2 }],
    ["PackBits", { compression: 32773 }],
    ["Deflate, one row per strip", { compression: 8, rowsPerStrip: 1 }],
    ["Deflate, tiled 16x16", { compression: 8, tile: 16 }],
    ["Deflate + predictor 3 (float)", { compression: 8, predictor: 3 }],
    ["LZW + predictor 3 (float)", { compression: 5, predictor: 3 }],
    ["uncompressed + predictor 3", { compression: 1, predictor: 3 }],
    ["tiled + Deflate + predictor 3", { compression: 8, predictor: 3, tile: 16 }],
    ["predictor 3, one row per strip", { compression: 8, predictor: 3, rowsPerStrip: 1 }],
    ["LZW, tiled 16x16 + predictor", { compression: 5, predictor: 2, tile: 16 }],
    ["uncompressed, tiled 16x16", { compression: 1, tile: 16 }],
  ];
  for (const [name, opts] of variants) {
    let got;
    try { got = readElevation(makeTIFF(z, W, H, opts), { name }); }
    catch (e) { ok(name, false, e.message); continue; }
    let worst = 0;
    for (let i = 0; i < z.length; i++) worst = Math.max(worst, Math.abs(got.z[i] - plain.z[i]));
    ok(name, got.ncols === W && got.nrows === H && worst < 1e-6, `worst difference ${worst}`);
  }

  // An unsupported compression must still refuse, and say what to do.
  let refused = "";
  try { readTIFF(makeTIFF(z, W, H, { compression: 7 })); } catch (e) { refused = e.message; }
  ok("JPEG-in-TIFF is refused with advice", /not supported/.test(refused) && /re-export/.test(refused), refused);
}

console.log(`\n${fail ? `FAILED ${fail} of ${pass + fail}` : `PASSED ${pass}/${pass}`}`);
if (fail) process.exitCode = 1;
