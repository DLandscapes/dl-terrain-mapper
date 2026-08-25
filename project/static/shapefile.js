// @ts-check
// SHAPEFILE — just enough of it to read a boundary.
//
// A student's tile boundary arrives as a `.shp`, because that is what QGIS
// exports when you draw a rectangle and save it. This reads the geometry and
// nothing else: no `.dbf` attributes, no `.shx` index (it is redundant — the
// records are self-describing and can be walked), no editing, no writing.
//
// ⚠️ THE FORMAT MIXES ENDIANNESS INSIDE ONE FILE, and that is the whole trap.
// The file header's length and the record headers are BIG-endian; every shape
// field — type, bounding box, part offsets, coordinates — is LITTLE-endian.
// Reading it all one way gives either a nonsense record count or coordinates
// around 1e-300, both of which look like a corrupt file rather than like a
// wrong reader. The ESRI Shapefile Technical Description (July 1998) is
// explicit about this and it is the only reason the code below is fussy.
//
// ⚠️ A RING'S DIRECTION IS ITS MEANING. In this format an OUTER ring is
// clockwise and a HOLE is counter-clockwise — the opposite of the convention
// regions.js uses internally, and the opposite of most other GIS formats. A
// polygon with an island in a lake is three rings and the winding is the only
// thing that says which is which, so it is measured here and kept.
//
// ⚠️ NOTHING HERE IS UPLOADED. Same rule as every other reader in this tool:
// the bytes come from the user's own disk into this tab and stay there.

/** The shape types this reader accepts, and what they are called. */
const TYPES = {
  0: "null",
  1: "point", 3: "polyline", 5: "polygon", 8: "multipoint",
  11: "pointZ", 13: "polylineZ", 15: "polygonZ", 18: "multipointZ",
  21: "pointM", 23: "polylineM", 25: "polygonM", 28: "multipointM",
};

/** Types whose records carry parts + points in the layout we can walk. */
const AREAL = new Set([3, 5, 13, 15, 23, 25]);

/**
 * Signed area of a ring, ×2. Positive is counter-clockwise in a y-up frame.
 * @param {Float64Array} p x,y interleaved
 */
export function signedArea2(p) {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a;
}

/**
 * Read the rings out of a shapefile.
 *
 * @param {ArrayBuffer} buf the `.shp` file
 * @param {{name?:string}} [o]
 * @returns {{rings:{pts:Float64Array, hole:boolean}[], type:string,
 *            bbox:{x0:number,y0:number,x1:number,y1:number}, shapes:number,
 *            notes:string[]}}
 */
export function readShapefile(buf, o = {}) {
  const dv = new DataView(buf);
  if (buf.byteLength < 100) {
    throw new Error(`${o.name || "the file"} is only ${buf.byteLength} bytes — `
      + `a shapefile header alone is 100. This is not a .shp file.`);
  }
  // ⚠️ BIG-endian, and it is the only reliable way to tell a .shp from the
  // .dbf or .shx sitting beside it with the same name.
  const code = dv.getInt32(0, false);
  if (code !== 9994) {
    throw new Error(`${o.name || "the file"} does not start with a shapefile's `
      + `signature. If you picked the .dbf or .shx by mistake, choose the .shp — `
      + `it is the one holding the geometry.`);
  }
  const fileWords = dv.getInt32(24, false);          // 16-bit words, big-endian
  const version = dv.getInt32(28, true);
  const shapeType = dv.getInt32(32, true);
  const notes = [];
  if (version !== 1000) notes.push(`unexpected shapefile version ${version} — read anyway`);

  const label = TYPES[shapeType] || `type ${shapeType}`;
  if (!AREAL.has(shapeType)) {
    throw new Error(`this shapefile holds ${label} shapes. A clip boundary has to be `
      + `a POLYGON (or a closed polyline) — points and multipoints enclose nothing.`);
  }
  if (shapeType === 3 || shapeType === 13 || shapeType === 23) {
    notes.push(`the shapes are polylines, not polygons — each one is treated as a `
      + `closed ring, which is right for a boundary drawn as a line and wrong for `
      + `an open line`);
  }

  const bbox = { x0: dv.getFloat64(36, true), y0: dv.getFloat64(44, true),
                 x1: dv.getFloat64(52, true), y1: dv.getFloat64(60, true) };

  const rings = [];
  let shapes = 0;
  // The header says the file length in 16-bit words; trust the buffer if the
  // header disagrees, because a truncated download is commoner than a lying
  // header and reading past the end throws a less useful error.
  const end = Math.min(buf.byteLength, fileWords * 2 > 100 ? fileWords * 2 : buf.byteLength);
  let at = 100;
  while (at + 8 <= end) {
    const contentWords = dv.getInt32(at + 4, false);   // big-endian
    const contentBytes = contentWords * 2;
    const body = at + 8;
    if (contentBytes <= 0 || body + contentBytes > end) break;
    const st = dv.getInt32(body, true);
    if (st === 0) { at = body + contentBytes; continue; }   // a null shape
    if (AREAL.has(st)) {
      const numParts = dv.getInt32(body + 36, true);
      const numPoints = dv.getInt32(body + 40, true);
      if (numParts > 0 && numPoints > 0) {
        const partsAt = body + 44;
        const ptsAt = partsAt + numParts * 4;
        if (ptsAt + numPoints * 16 <= end) {
          const starts = [];
          for (let i = 0; i < numParts; i++) starts.push(dv.getInt32(partsAt + i * 4, true));
          starts.push(numPoints);
          for (let i = 0; i < numParts; i++) {
            const a = starts[i], b = starts[i + 1];
            const n = b - a;
            if (n < 3) continue;                     // fewer than 3 encloses nothing
            // ⚠️ THE REPEATED CLOSING POINT IS DROPPED. Shapefiles repeat the
            // first vertex at the end; every ring in this tool is implicitly
            // closed and a duplicated vertex would be a zero-length segment —
            // a dwell if it ever reached a cut pass.
            const fx = dv.getFloat64(ptsAt + a * 16, true);
            const fy = dv.getFloat64(ptsAt + a * 16 + 8, true);
            const lx = dv.getFloat64(ptsAt + (b - 1) * 16, true);
            const ly = dv.getFloat64(ptsAt + (b - 1) * 16 + 8, true);
            const drop = (fx === lx && fy === ly) ? 1 : 0;
            const count = n - drop;
            if (count < 3) continue;
            const pts = new Float64Array(count * 2);
            for (let k = 0; k < count; k++) {
              pts[k * 2] = dv.getFloat64(ptsAt + (a + k) * 16, true);
              pts[k * 2 + 1] = dv.getFloat64(ptsAt + (a + k) * 16 + 8, true);
            }
            // ⚠️ CLOCKWISE IS AN OUTER RING IN THIS FORMAT. Signed area is
            // positive for counter-clockwise, so a hole is the positive one.
            rings.push({ pts, hole: signedArea2(pts) > 0 });
          }
        }
      }
      shapes++;
    }
    at = body + contentBytes;
  }

  if (!rings.length) {
    throw new Error(`no usable rings were found in ${o.name || "the file"} — `
      + `it parsed as ${label} but every shape was empty or had fewer than three points.`);
  }
  // A single ring wound as a hole is almost certainly a boundary digitised
  // anticlockwise rather than a genuine hole with nothing around it.
  if (rings.length === 1 && rings[0].hole) {
    rings[0].hole = false;
    notes.push(`the only ring is wound counter-clockwise, which in this format means `
      + `a hole; taken as the outer boundary instead`);
  }
  return { rings, type: label, bbox, shapes, notes };
}
