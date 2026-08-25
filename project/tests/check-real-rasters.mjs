// node tests/check-real-rasters.mjs — every TIFF on the machine we can find.
// ⚠️ READ-ONLY on every path outside this project.
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readTIFF, readElevation } from "../static/geotiff.js";
import { stats } from "../static/dem.js";
import { traceContours, niceInterval } from "../static/contours.js";

const ROOTS = [
  "D:/Claude Code Projects/DLC H26/data",
  "D:/Claude Code Projects/VID Poster ECLAS/data",
];
const COMP = { 1: "none", 5: "LZW", 7: "JPEG", 8: "Deflate", 32773: "PackBits", 32946: "Deflate" };

function walk(dir, out = [], depth = 0) {
  if (depth > 4 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (/\.tiff?$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = [];
for (const r of ROOTS) walk(r, files);
// One per distinct name, so eight copies of one backup do not dominate.
const seen = new Set();
const unique = files.filter((f) => { const b = f.split(/[\\/]/).pop(); if (seen.has(b)) return false; seen.add(b); return true; });

console.log(`${files.length} TIFFs found, ${unique.length} distinct names\n`);
let opened = 0, refused = 0;
const byComp = new Map();

for (const f of unique) {
  const name = f.split(/[\\/]/).pop();
  const b = readFileSync(f);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const mb = (statSync(f).size / 1048576).toFixed(1);
  try {
    const t0 = Date.now();
    const t = readTIFF(buf);
    const dv = new DataView(buf);
    const le = dv.getUint16(0, false) === 0x4949;
    // re-read the compression tag for the report
    let comp = 1;
    const ifd = dv.getUint32(4, le), n = dv.getUint16(ifd, le);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (dv.getUint16(e, le) === 259) comp = dv.getUint16(e + 8, le);
    }
    const label = COMP[comp] || `code ${comp}`;
    byComp.set(label, (byComp.get(label) || 0) + 1);
    let extra = "";
    if (t.samples === 1) {
      const dem = readElevation(buf, { name });
      const s = stats(dem);
      const iv = niceInterval(s.relief, 12);
      const lines = traceContours(dem, iv, { indexEvery: 5, minLength: dem.cell });
      extra = `z ${s.min.toFixed(1)}..${s.max.toFixed(1)}, ${lines.length} paths @ ${iv} m`;
    } else extra = `${t.samples} bands`;
    console.log(`  OK      ${name.padEnd(34)} ${mb.padStart(6)} MB  ${t.width}x${t.height}`
      + `  ${label.padEnd(9)} ${t.crs || "no CRS"}  ${extra}  ${Date.now() - t0} ms`);
    opened++;
  } catch (e) {
    console.log(`  REFUSED ${name.padEnd(34)} ${mb.padStart(6)} MB  ${e.message}`);
    refused++;
  }
}
console.log(`\nopened ${opened}, refused ${refused}`);
console.log("compressions met: " + [...byComp].map(([k, v]) => `${k} x${v}`).join(", "));
