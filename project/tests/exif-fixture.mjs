// A JPEG carrying a known Exif GPS block, built byte by byte.
//
// ⚠️ THIS EXISTS SO THE PHOTOGRAPH PATH IS TESTED AGAINST A KNOWN ANSWER. Real
// site photographs are the wrong fixture for a parser: when they come back with
// no position it is genuinely ambiguous whether the camera never recorded one
// or the reader failed, and "no photographs had GPS" is exactly what a broken
// reader also reports. A file whose coordinates we chose ourselves removes the
// ambiguity. The image body is a bare SOI/EOI — the parser walks markers and
// never decodes pixels, so there is nothing to draw.

const enc = (s) => [...s].map((c) => c.charCodeAt(0));

/** One IFD plus its overflow area. Offsets are relative to the TIFF header. */
function buildIFD(entries, base, nextIFD = 0) {
  const n = entries.length;
  const tableLen = 2 + n * 12 + 4;
  const table = new Uint8Array(tableLen);
  const dv = new DataView(table.buffer);
  const overflow = [];
  let dataAt = base + tableLen;
  dv.setUint16(0, n, true);
  entries.forEach((e, i) => {
    const off = 2 + i * 12;
    dv.setUint16(off, e.tag, true);
    dv.setUint16(off + 2, e.type, true);
    const bytes = [];
    for (const v of e.values) {
      if (e.type === 1 || e.type === 2) bytes.push(v & 0xff);
      else if (e.type === 4) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); bytes.push(...b); }
      else if (e.type === 5) {
        const b = new Uint8Array(8); const d = new DataView(b.buffer);
        d.setUint32(0, v[0], true); d.setUint32(4, v[1], true); bytes.push(...b);
      }
    }
    // ⚠️ COUNT IS IN VALUES, NOT IN BYTES. Writing the byte length here makes a
    // one-element LONG look like a four-element array, which pushes it over the
    // four-byte inline limit — so every reader then treats the pointer's own
    // bytes as an offset and follows it into the middle of the file. The
    // symptom is a GPS block that is present and empty.
    dv.setUint32(off + 4, e.values.length, true);
    if (bytes.length <= 4) {
      for (let k = 0; k < bytes.length; k++) table[off + 8 + k] = bytes[k];
    } else {
      dv.setUint32(off + 8, dataAt, true);
      overflow.push(...bytes);
      dataAt += bytes.length;
    }
  });
  dv.setUint32(2 + n * 12, nextIFD, true);
  return { bytes: [...table, ...overflow] };
}

/** Decimal degrees to the three rationals Exif wants. */
const toDMS = (deg) => {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = Math.round((a - d - m / 60) * 3600 * 10000);
  return [[d, 1], [m, 1], [s, 10000]];
};

/**
 * @param {{lat?:number, lon?:number, alt?:number, direction?:number,
 *          taken?:string, make?:string, model?:string, noGPS?:boolean,
 *          nullIsland?:boolean, missingRef?:boolean}} o
 * @returns {ArrayBuffer}
 */
export function makeExifJPEG(o = {}) {
  const lat = o.nullIsland ? 0 : (o.lat ?? 69.6501);
  const lon = o.nullIsland ? 0 : (o.lon ?? 18.9553);
  const taken = o.taken ?? "2026:06:11 10:42:07";
  const make = o.make ?? "DL", model = o.model ?? "FieldPhone 1";

  // Laid out in a fixed order so every offset is known before anything is written.
  const HDR = 8;
  const ifd0Entries = [
    { tag: 0x010f, type: 2, values: [...enc(make), 0] },
    { tag: 0x0110, type: 2, values: [...enc(model), 0] },
    { tag: 0x8769, type: 4, values: [0] },              // patched below
    ...(o.noGPS ? [] : [{ tag: 0x8825, type: 4, values: [0] }]),
  ];
  let probe = buildIFD(ifd0Entries, HDR);
  const exifAt = HDR + probe.bytes.length;
  const exifEntries = [{ tag: 0x9003, type: 2, values: [...enc(taken), 0] }];
  const exifIFD = buildIFD(exifEntries, exifAt);
  const gpsAt = exifAt + exifIFD.bytes.length;

  const [dd, mm, ss] = toDMS(lat);
  const [dd2, mm2, ss2] = toDMS(lon);
  const gpsEntries = [
    ...(o.missingRef ? [] : [{ tag: 1, type: 2, values: [...enc(lat >= 0 ? "N" : "S"), 0] }]),
    { tag: 2, type: 5, values: [dd, mm, ss] },
    { tag: 3, type: 2, values: [...enc(lon >= 0 ? "E" : "W"), 0] },
    { tag: 4, type: 5, values: [dd2, mm2, ss2] },
    { tag: 5, type: 1, values: [0] },
    { tag: 6, type: 5, values: [[Math.round((o.alt ?? 143.2) * 100), 100]] },
    ...(o.direction === undefined ? [] : [
      { tag: 16, type: 2, values: [...enc("T"), 0] },
      { tag: 17, type: 5, values: [[Math.round(o.direction * 100), 100]] },
    ]),
  ];
  const gpsIFD = o.noGPS ? { bytes: [] } : buildIFD(gpsEntries, gpsAt);

  // Rebuild IFD0 with the real pointers now that both are placed.
  ifd0Entries[2].values = [exifAt];
  if (!o.noGPS) ifd0Entries[3].values = [gpsAt];
  const ifd0 = buildIFD(ifd0Entries, HDR);
  if (ifd0.bytes.length !== probe.bytes.length) throw new Error("IFD0 changed size — offsets invalid");

  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,     // "II", 42, IFD0 at 8
    ...ifd0.bytes, ...exifIFD.bytes, ...gpsIFD.bytes,
  ];
  const app1 = [...enc("Exif"), 0, 0, ...tiff];
  const len = app1.length + 2;
  const jpeg = [
    0xff, 0xd8,                                          // SOI
    0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...app1,  // APP1
    0xff, 0xd9,                                          // EOI
  ];
  return new Uint8Array(jpeg).buffer;
}
