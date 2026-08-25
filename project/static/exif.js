// @ts-check
// WHAT A PHOTOGRAPH ALREADY KNOWS — read out of the file, in the browser.
//
// A site photograph carries where the camera stood and which way it looked, and
// almost every workflow throws both away. Reading them turns the picture into a
// map feature; the rest of this tool then turns that feature into a mark a laser
// can make.
//
// ⚠️ GDPR, AND IT IS ARCHITECTURAL HERE TOO. Photographs are the one input to
// this tool that routinely carry personal data — faces, plates, a person's
// movements on a date. They are parsed IN THE PAGE and never uploaded, because
// there is nothing to upload to. That covers transmission. It does not cover
// what is done afterwards, and the standing rules still apply: a photograph
// showing an identifiable person is not annotated, exported, or published, and
// any picture with children in it needs an explicit decision before it goes
// anywhere at all. Nothing in this file may grow a network call.
//
// ⚠️ A PHOTOGRAPH WITH NO FIX IS KEPT, NOT DROPPED. QGIS's own "Import
// geotagged photos" writes a second table listing every file that had no GPS,
// and that behaviour is inherited deliberately: the failures are the useful
// part. Silently importing eleven of fourteen photographs is how three
// observations disappear without anyone noticing they are gone.

/**
 * @typedef {object} PhotoMeta
 * @property {string} name        the file name
 * @property {number} [lat]       degrees, EPSG:4326 — undefined when unfixed
 * @property {number} [lon]
 * @property {number} [alt]       metres above sea level, sign already applied
 * @property {number} [direction] degrees, where the CAMERA LOOKED, not travel
 * @property {"T"|"M"} [dirRef]   true or magnetic north
 * @property {string} [taken]     ISO-ish, as the camera wrote it
 * @property {string} [make]
 * @property {string} [model]
 * @property {number} [orientation] EXIF orientation, 1..8
 * @property {string} [problem]   why there is no position
 */

const LE = true, BE = false;

/** Find the Exif APP1 payload inside a JPEG. @param {DataView} dv */
function findExif(dv) {
  if (dv.byteLength < 4 || dv.getUint16(0, BE) !== 0xffd8) return -1;   // not a JPEG
  let p = 2;
  while (p + 4 <= dv.byteLength) {
    if (dv.getUint8(p) !== 0xff) { p++; continue; }                     // resync
    const marker = dv.getUint8(p + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return -1;                  // image data: done
    const len = dv.getUint16(p + 2, BE);
    if (marker === 0xe1 && p + 10 <= dv.byteLength) {
      let tag = "";
      for (let i = 0; i < 4; i++) tag += String.fromCharCode(dv.getUint8(p + 4 + i));
      if (tag === "Exif") return p + 10;                                // start of TIFF header
    }
    p += 2 + len;
  }
  return -1;
}

/** Read one IFD into a tag map. Offsets are relative to the TIFF header. */
function readIFD(dv, tiff, at, le) {
  /** @type {Map<number, {type:number, count:number, at:number}>} */
  const tags = new Map();
  if (at + 2 > dv.byteLength) return tags;
  const n = dv.getUint16(at, le);
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  for (let i = 0; i < n; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > dv.byteLength) break;
    const tag = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const count = dv.getUint32(e + 4, le);
    const size = SIZE[type] || 0;
    if (!size) continue;
    const total = size * count;
    const off = total <= 4 ? e + 8 : tiff + dv.getUint32(e + 8, le);
    tags.set(tag, { type, count, at: off });
  }
  return tags;
}

/**
 * A tag's values.
 *
 * ⚠️ THE BOUNDS GUARD MUST USE THE TYPE'S OWN STRIDE. An earlier version
 * checked `at + i * 8 + 8` for every type, which is right for a RATIONAL and
 * eight times too pessimistic for an ASCII string — so any text tag whose data
 * sat within eight bytes of the end of the Exif block was silently cut short.
 * The symptom was a camera model reading "FieldPh" and a timestamp reading
 * "202": plausible-looking, never an error, and wrong.
 */
function values(dv, entry, le) {
  if (!entry) return [];
  const { type, count, at } = entry;
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  const stride = SIZE[type] || 1;
  const out = [];
  for (let i = 0; i < count; i++) {
    if (at < 0 || at + (i + 1) * stride > dv.byteLength) break;
    switch (type) {
      case 1: case 7: out.push(dv.getUint8(at + i)); break;
      case 2: out.push(dv.getUint8(at + i)); break;
      case 3: out.push(dv.getUint16(at + i * 2, le)); break;
      case 4: out.push(dv.getUint32(at + i * 4, le)); break;
      case 5: {
        const n = dv.getUint32(at + i * 8, le), d = dv.getUint32(at + i * 8 + 4, le);
        out.push(d ? n / d : 0); break;
      }
      case 9: out.push(dv.getInt32(at + i * 4, le)); break;
      case 10: {
        const n = dv.getInt32(at + i * 8, le), d = dv.getInt32(at + i * 8 + 4, le);
        out.push(d ? n / d : 0); break;
      }
      default: out.push(0);
    }
  }
  return out;
}

/** An ASCII tag as a string. */
function str(dv, entry, le) {
  const v = values(dv, entry, le);
  return v.map((c) => String.fromCharCode(c)).join("").replace(/\0.*$/, "").trim();
}

/**
 * Degrees-minutes-seconds to decimal degrees, with the hemisphere applied.
 *
 * ⚠️ THE REFERENCE IS NOT OPTIONAL AND ITS ABSENCE IS AN ERROR, NOT A DEFAULT.
 * "S" and "W" are the whole difference between Tromsø and the Southern Ocean,
 * and a file that records 69° 39' without saying which side of the equator has
 * not told us where it is. Assuming north is right nine times in ten and
 * catastrophic the tenth.
 */
function dms(parts, ref) {
  if (!parts || parts.length < 3) return undefined;
  if (ref !== "N" && ref !== "S" && ref !== "E" && ref !== "W") return undefined;
  const d = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return (ref === "S" || ref === "W") ? -d : d;
}

/**
 * Read one photograph's metadata.
 *
 * @param {ArrayBuffer} buf @param {string} name
 * @returns {PhotoMeta}
 */
export function readPhotoMeta(buf, name) {
  const dv = new DataView(buf);
  /** @type {PhotoMeta} */
  const out = { name };
  const tiff = findExif(dv);
  if (tiff < 0) { out.problem = "no Exif block (not a JPEG, or metadata stripped)"; return out; }
  const bom = dv.getUint16(tiff, BE);
  const le = bom === 0x4949;
  if (!le && bom !== 0x4d4d) { out.problem = "damaged Exif header"; return out; }
  const ifd0 = tiff + dv.getUint32(tiff + 4, le);
  const t0 = readIFD(dv, tiff, ifd0, le);

  out.make = str(dv, t0.get(0x010f), le) || undefined;
  out.model = str(dv, t0.get(0x0110), le) || undefined;
  const orient = values(dv, t0.get(0x0112), le);
  if (orient.length) out.orientation = orient[0];

  const exifPtr = values(dv, t0.get(0x8769), le)[0];
  if (exifPtr) {
    const te = readIFD(dv, tiff, tiff + exifPtr, le);
    out.taken = str(dv, te.get(0x9003), le) || str(dv, te.get(0x9004), le) || undefined;
  }
  if (!out.taken) out.taken = str(dv, t0.get(0x0132), le) || undefined;

  const gpsPtr = values(dv, t0.get(0x8825), le)[0];
  if (!gpsPtr) { out.problem = "no GPS block — the camera was not recording position"; return out; }
  const g = readIFD(dv, tiff, tiff + gpsPtr, le);

  const lat = dms(values(dv, g.get(2), le), str(dv, g.get(1), le));
  const lon = dms(values(dv, g.get(4), le), str(dv, g.get(3), le));
  if (lat === undefined || lon === undefined) {
    out.problem = "GPS block present but empty — no fix at the moment of exposure";
    return out;
  }
  // ⚠️ 0, 0 IS REFUSED. Null Island is what a camera writes when it has a GPS
  // block, no fix, and firmware that fills the field with zeros rather than
  // omitting it. Accepting it drops a photograph in the Gulf of Guinea and
  // stretches the drawing's extent across the planet.
  if (Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9) {
    out.problem = "position reads 0°, 0° — a placeholder, not a fix";
    return out;
  }
  out.lat = lat; out.lon = lon;

  const altV = values(dv, g.get(6), le);
  if (altV.length) {
    const belowSea = (values(dv, g.get(5), le)[0] || 0) === 1;
    out.alt = belowSea ? -altV[0] : altV[0];
  }
  const dirV = values(dv, g.get(17), le);
  if (dirV.length) {
    out.direction = ((dirV[0] % 360) + 360) % 360;
    const dr = str(dv, g.get(16), le);
    out.dirRef = dr === "M" ? "M" : "T";
  }
  if (!out.taken) {
    const ds = str(dv, g.get(29), le);
    if (ds) out.taken = ds.replace(/:/g, "-");
  }
  return out;
}

/**
 * Read a set of files, keeping the failures.
 *
 * @param {{name:string, buffer:ArrayBuffer}[]} files
 * @returns {{located:PhotoMeta[], unlocated:PhotoMeta[]}}
 */
export function readPhotoSet(files) {
  const located = [], unlocated = [];
  for (const f of files) {
    let m;
    try { m = readPhotoMeta(f.buffer, f.name); }
    catch (e) { m = { name: f.name, problem: `unreadable: ${e.message}` }; }
    (m.lat !== undefined ? located : unlocated).push(m);
  }
  // Stable, human order — the order a field day happened in, when the camera
  // recorded it, and by name when it did not.
  located.sort((a, b) => (a.taken || "").localeCompare(b.taken || "") || a.name.localeCompare(b.name));
  unlocated.sort((a, b) => a.name.localeCompare(b.name));
  return { located, unlocated };
}
