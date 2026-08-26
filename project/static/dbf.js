// @ts-check
// DBF — the attribute table that travels beside a shapefile.
//
// ⚠️ THE GEOMETRY AND THE ATTRIBUTES ARE TWO SEPARATE FILES, and that is the
// whole reason this exists. `.shp` holds shapes and nothing else; every value a
// GIS user actually cares about — a tree's species and girth, a bed's planting
// density, a slope's aspect — lives in a `.dbf` next to it, paired by RECORD
// ORDER and by nothing else. There is no key, no id, no join column: record 7 in
// the .shp is described by record 7 in the .dbf. That is fragile and it is the
// format, so the pairing is asserted rather than assumed.
//
// dBASE III+, which is what every GIS writes. Enough of it to read a table:
// field descriptors, typed values, deleted-record flags. No writing, no memo
// files, no indexes.
//
// ⚠️ NOTHING IS UPLOADED. Same rule as every other reader here.

/**
 * @typedef {object} DBFField
 * @property {string} name
 * @property {string} type   C character · N numeric · F float · D date · L logical
 * @property {number} length
 * @property {number} decimals
 */

/**
 * Read a .dbf attribute table.
 *
 * @param {ArrayBuffer} buf
 * @param {{name?:string}} [o]
 * @returns {{fields:DBFField[], rows:object[], deleted:number, notes:string[],
 *            numeric:string[]}}
 */
export function readDBF(buf, o = {}) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const who = o.name || "the table";
  if (buf.byteLength < 33) {
    throw new Error(`${who} is only ${buf.byteLength} bytes — a dBASE header alone is 32.`);
  }
  const version = u8[0];
  const nRecords = dv.getInt32(4, true);
  const headerLen = dv.getInt16(8, true);
  const recordLen = dv.getInt16(10, true);
  const notes = [];
  // ⚠️ THE VERSION BYTE IS NOT A VERSION NUMBER, it is a bit field: the low
  // nibble is the format and the high bits say whether a memo file exists.
  // Testing it for equality against 3 rejects perfectly ordinary tables that
  // QGIS writes.
  if ((version & 0x07) !== 3) {
    notes.push(`unusual dBASE version byte 0x${version.toString(16)} — read anyway`);
  }
  if (headerLen < 33 || recordLen < 1) {
    throw new Error(`${who} has an impossible header (header ${headerLen} bytes, `
      + `record ${recordLen} bytes) — it is probably not a .dbf.`);
  }

  /** @type {DBFField[]} */
  const fields = [];
  for (let at = 32; at < headerLen - 1; at += 32) {
    if (u8[at] === 0x0d || u8[at] === 0x00) break;        // the terminator
    let name = "";
    for (let i = 0; i < 11 && u8[at + i]; i++) name += String.fromCharCode(u8[at + i]);
    fields.push({
      name: name.trim(),
      type: String.fromCharCode(u8[at + 11]),
      length: u8[at + 16],
      decimals: u8[at + 17],
    });
  }
  if (!fields.length) throw new Error(`${who} declares no fields.`);

  // ⚠️ LATIN-1, DELIBERATELY, AND SAID OUT LOUD. The byte at 29 is a "language
  // driver" code that in practice is 0 on most GIS output, so the encoding is
  // genuinely unknown. Latin-1 never throws and never mangles ASCII, which is
  // what field names and most values are; a Norwegian å in a species name may
  // come back wrong, and that is visible and fixable rather than silent.
  const dec = (start, len) => {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(u8[start + i]);
    return s;
  };

  const rows = [];
  let deleted = 0;
  let at = headerLen;
  for (let r = 0; r < nRecords; r++) {
    if (at + recordLen > buf.byteLength) {
      notes.push(`the table claims ${nRecords} records but the file ends after ${r} — `
        + `read what was there`);
      break;
    }
    const flag = u8[at];
    // 0x2A marks a record deleted in place. It is still in the file, and a
    // reader that hands it back invents features the user deleted.
    if (flag === 0x2a) { deleted++; at += recordLen; continue; }
    const row = {};
    let off = at + 1;
    for (const f of fields) {
      const raw = dec(off, f.length);
      off += f.length;
      row[f.name] = parseField(raw, f.type);
    }
    rows.push(row);
    at += recordLen;
  }

  // Which fields can actually drive a size or an angle? Only the numeric ones,
  // and only if they hold numbers in practice — a numeric column of all nulls
  // is a picker entry that produces an empty drawing.
  const numeric = fields
    .filter((f) => "NFOIB".includes(f.type))
    .filter((f) => rows.some((row) => Number.isFinite(row[f.name])))
    .map((f) => f.name);

  return { fields, rows, deleted, notes, numeric };
}

/** One field value, typed. Blank is null, never 0 — see below. */
function parseField(raw, type) {
  // ⚠️ NUL-STRIPPED BEFORE TRIMMING. dBASE pads a short string with 0x00 to the
  // field's declared width, and JavaScript's trim() removes whitespace but NOT
  // NUL — so a six-letter species name in a twelve-wide field came back six NULs
  // long. It compares unequal to the name it looks like, sorts oddly, and
  // engraves as a row of boxes in any label made from it.
  //
  // ⚠️ AND THE ESCAPE IS WRITTEN AS AN ESCAPE, NEVER A LITERAL NUL BYTE IN THE SOURCE.
  // An earlier fix embedded the real character here. It worked perfectly and it
  // made this file binary to `grep`, invisible in an editor, and unreviewable.
  //
  // ⚠️ NOT A BLANKET SPACE-STRIP EITHER: trim() takes the padding off the ends
  // and leaves the middle alone, so "Pinus sylvestris" survives intact.
  const s = raw.replace(/\u0000+/g, "").trim();
  switch (type) {
    case "N": case "F": case "O": case "I": case "B": {
      if (!s) return null;
      const v = Number(s);
      return Number.isFinite(v) ? v : null;
    }
    case "L": {
      if (/^[YyTt]$/.test(s)) return true;
      if (/^[NnFf]$/.test(s)) return false;
      return null;
    }
    case "D": {
      // YYYYMMDD, kept as a string: turning it into a Date invents a timezone.
      return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null;
    }
    default:
      return s;
  }
}

/**
 * Pair an attribute table with a geometry count.
 *
 * ⚠️ THE ONLY THING JOINING THEM IS ORDER, so a mismatch is not a detail to
 * paper over — it means the attributes belong to different shapes than the ones
 * being drawn, and every symbol would be sized by the wrong tree. Refused, with
 * both counts named.
 *
 * @param {object[]} rows @param {number} shapes @param {string} who
 */
export function assertPairs(rows, shapes, who = "the shapefile") {
  if (rows.length !== shapes) {
    throw new Error(`${who}: the attribute table has ${rows.length} rows but the geometry `
      + `has ${shapes} shapes. They are paired by ORDER and nothing else, so a mismatch `
      + `means the values belong to different features — the attributes were not used.`);
  }
}

/**
 * The finite range of one numeric attribute, and how many rows actually carry it.
 * @param {object[]} rows @param {string} field
 */
export function fieldRange(rows, field) {
  let lo = Infinity, hi = -Infinity, n = 0;
  for (const r of rows) {
    const v = r[field];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    n++;
  }
  return n ? { lo, hi, n, missing: rows.length - n } : { lo: 0, hi: 0, n: 0, missing: rows.length };
}
