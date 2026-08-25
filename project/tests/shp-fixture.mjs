// A shapefile built byte by byte, so the reader is tested against a known answer.
//
// ⚠️ WRITTEN FROM THE SPECIFICATION, NOT FROM THE READER. The ESRI Shapefile
// Technical Description (July 1998) is the source for both, independently. A
// decoder checked only against its own encoder proves that the two share a
// misunderstanding — and the misunderstanding this format invites is the mixed
// endianness, which a matched pair would hide perfectly.

/**
 * A polygon shapefile.
 *
 * @param {number[][][]} shapes each shape is a list of rings, each ring a flat
 *   [x,y,x,y,…] with NO repeated closing point (this adds it, as the format
 *   requires)
 * @param {{type?:number, badCode?:boolean}} [o] `type` overrides the shape
 *   type, for testing the refusals
 * @returns {ArrayBuffer}
 */
export function makeSHP(shapes, o = {}) {
  const type = o.type ?? 5;
  const recs = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

  for (const rings of shapes) {
    let np = 0;
    for (const r of rings) np += r.length / 2 + 1;      // +1 for the closing point
    // content: type(4) box(32) numParts(4) numPoints(4) parts(4n) points(16np)
    const len = 4 + 32 + 4 + 4 + rings.length * 4 + np * 16;
    const b = new ArrayBuffer(len);
    const dv = new DataView(b);
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        sx0 = Math.min(sx0, r[i]); sx1 = Math.max(sx1, r[i]);
        sy0 = Math.min(sy0, r[i + 1]); sy1 = Math.max(sy1, r[i + 1]);
      }
    }
    x0 = Math.min(x0, sx0); x1 = Math.max(x1, sx1);
    y0 = Math.min(y0, sy0); y1 = Math.max(y1, sy1);

    dv.setInt32(0, type, true);                          // LITTLE
    dv.setFloat64(4, sx0, true); dv.setFloat64(12, sy0, true);
    dv.setFloat64(20, sx1, true); dv.setFloat64(28, sy1, true);
    dv.setInt32(36, rings.length, true);
    dv.setInt32(40, np, true);
    let at = 44, start = 0;
    for (const r of rings) {
      dv.setInt32(at, start, true);
      at += 4;
      start += r.length / 2 + 1;
    }
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        dv.setFloat64(at, r[i], true);
        dv.setFloat64(at + 8, r[i + 1], true);
        at += 16;
      }
      dv.setFloat64(at, r[0], true);                     // the closing repeat
      dv.setFloat64(at + 8, r[1], true);
      at += 16;
    }
    recs.push(new Uint8Array(b));
  }

  const body = recs.reduce((a, r) => a + 8 + r.length, 0);
  const total = 100 + body;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);

  dv.setInt32(0, o.badCode ? 1234 : 9994, false);        // BIG
  dv.setInt32(24, total / 2, false);                     // BIG, in 16-bit words
  dv.setInt32(28, 1000, true);                           // LITTLE
  dv.setInt32(32, type, true);                           // LITTLE
  dv.setFloat64(36, x0, true); dv.setFloat64(44, y0, true);
  dv.setFloat64(52, x1, true); dv.setFloat64(60, y1, true);

  let at = 100;
  recs.forEach((r, i) => {
    dv.setInt32(at, i + 1, false);                       // BIG record number
    dv.setInt32(at + 4, r.length / 2, false);            // BIG content length
    u8.set(r, at + 8);
    at += 8 + r.length;
  });
  return out;
}

/** A clockwise (outer) rectangle, in the format's own winding. */
export const rectCW = (x0, y0, x1, y1) => [x0, y0, x0, y1, x1, y1, x1, y0];
/** A counter-clockwise (hole) rectangle. */
export const rectCCW = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
