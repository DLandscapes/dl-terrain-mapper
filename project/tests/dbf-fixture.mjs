// A dBASE III+ table built byte by byte.
//
// ⚠️ WRITTEN FROM THE FORMAT, NOT FROM THE READER. Same rule as the TIFF and
// shapefile fixtures: a decoder checked against its own encoder proves only that
// the two share a misunderstanding — and this format invites one, because the
// header length and the record length are BOTH stored and must agree with the
// field descriptors, so a reader can pass by trusting the wrong one.

/**
 * @param {{name:string, type:string, length:number, decimals?:number}[]} fields
 * @param {object[]} rows
 * @param {{deleted?:number[], version?:number, lieAboutCount?:number}} [o]
 *   `deleted` marks row indices with 0x2A; `lieAboutCount` overstates the record
 *   count, to test the truncation path.
 * @returns {ArrayBuffer}
 */
export function makeDBF(fields, rows, o = {}) {
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((a, f) => a + f.length, 0);
  const total = headerLen + rows.length * recordLen + 1;   // +1 for the 0x1A EOF
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  u8[0] = o.version ?? 0x03;
  u8[1] = 126; u8[2] = 8; u8[3] = 26;                      // YY MM DD
  dv.setInt32(4, o.lieAboutCount ?? rows.length, true);
  dv.setInt16(8, headerLen, true);
  dv.setInt16(10, recordLen, true);

  const put = (at, s, len) => {
    for (let i = 0; i < len; i++) u8[at + i] = i < s.length ? s.charCodeAt(i) & 0xff : 0;
  };

  fields.forEach((f, i) => {
    const at = 32 + i * 32;
    put(at, f.name.slice(0, 10), 11);
    u8[at + 11] = f.type.charCodeAt(0);
    u8[at + 16] = f.length;
    u8[at + 17] = f.decimals ?? 0;
  });
  u8[32 + fields.length * 32] = 0x0d;                      // the terminator

  let at = headerLen;
  rows.forEach((row, r) => {
    u8[at] = (o.deleted || []).includes(r) ? 0x2a : 0x20;
    let off = at + 1;
    for (const f of fields) {
      let s = row[f.name];
      if (s === undefined || s === null) s = "";
      else if (f.type === "L") s = s ? "T" : "F";
      else if (f.type === "N" || f.type === "F") {
        s = Number(s).toFixed(f.decimals ?? 0);
        // ⚠️ NUMERICS ARE RIGHT-JUSTIFIED IN dBASE, and a reader that only
        // trims one side would come back with a NaN on every row.
        s = String(s).padStart(f.length, " ");
      } else s = String(s);
      put(off, String(s).slice(0, f.length), f.length);
      off += f.length;
    }
    at += recordLen;
  });
  u8[total - 1] = 0x1a;
  return buf;
}
