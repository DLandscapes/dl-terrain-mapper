// node tests/check-compile.mjs — the vertical slice, on real data.
// ⚠️ READ-ONLY on every path outside this project. Only ../../output/ is written.
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { readElevation, readOrtho } from "../static/geotiff.js";
import { readPhotoSet } from "../static/exif.js";
import { placePhotos, correct } from "../static/photos.js";
import { compile, toDXF, reportText } from "../static/compile.js";

const buf = (p) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const D = "D:/Claude Code Projects/VID Poster ECLAS/";

// ── 1 · terrain ────────────────────────────────────────────────────────────
const demPath = D + "data/test.tif";
const dem = readElevation(buf(demPath), { name: "test.tif" });
console.log(`terrain: ${dem.ncols}×${dem.nrows} @ ${dem.cell} m, ${dem.crs}`);

// ── 2 · photographs ────────────────────────────────────────────────────────
// ⚠️ METADATA ONLY. The pictures themselves are neither shown nor written
// anywhere by this test; the GDPR rule in exif.js governs the rest.
const scratch = D + ".claude-scratch";
let photoFiles = [];
if (existsSync(scratch)) {
  photoFiles = readdirSync(scratch).filter((f) => /\.jpe?g$/i.test(f))
    .map((f) => ({ name: f, buffer: buf(`${scratch}/${f}`) }));
}
const { located, unlocated } = readPhotoSet(photoFiles);
console.log(`photographs: ${photoFiles.length} read — ${located.length} with a fix,`
  + ` ${unlocated.length} without`);
for (const m of located.slice(0, 4)) {
  console.log(`  ${m.name}  ${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}`
    + (m.alt !== undefined ? `  ${m.alt.toFixed(0)} m` : "")
    + (m.direction !== undefined ? `  looking ${m.direction.toFixed(0)}°${m.dirRef}` : "  no bearing")
    + (m.taken ? `  ${m.taken}` : ""));
}
for (const m of unlocated.slice(0, 3)) console.log(`  ${m.name} — ${m.problem}`);

const placed = placePhotos(located, dem);
console.log(`placed into zone ${placed.zone}${placed.guessedZone ? " (guessed)" : " (from the raster CRS)"}`
  + `: ${placed.points.length} points, ${placed.outside} outside the raster`);

// If none land on this raster, synthesise a few so the slice still runs end to
// end — the point of the test is the compiler, not the photo library.
let points = placed.points.filter((p) => p.inside);
if (!points.length) {
  console.log("  none fall on this tile — using synthetic points to exercise the slice");
  points = [0, 1, 2, 3, 4].map((i) => ({
    meta: { name: `synthetic-${i + 1}.jpg`, direction: i * 63 },
    n: i + 1,
    X: dem.originX + dem.ncols * dem.cell * (0.2 + 0.15 * i),
    Y: dem.originY - dem.nrows * dem.cell * (0.25 + 0.12 * i),
    rawX: 0, rawY: 0, dx: 0, dy: 0, inside: true, include: true,
  }));
  points.forEach((p) => { p.rawX = p.X; p.rawY = p.Y; });
}
correct(points[0], 3.5, -2.0);   // one hand correction, as the field requires

// ── 3 · ortho ──────────────────────────────────────────────────────────────
const orthoPath = D + "data/ortho 256x256.tif";
let image = null;
if (existsSync(orthoPath)) {
  const o = readOrtho(buf(orthoPath), { name: "ortho 256x256.tif" });
  image = { ...o, licence: "restricted", note: "Norge i bilder — education and research only" };
  console.log(`ortho: ${o.width}×${o.height} @ ${o.cell} m — marked RESTRICTED`);
}

// ── 4 · compile ────────────────────────────────────────────────────────────
const sym = {
  sheet: { scale: 500, margin: 12, title: "Ørndalen — test tile" },
  contours: { interval: 2, indexEvery: 5, labelEvery: 5, labelSize: 2.2 },
  photos: { mark: "circle", size: 3, bearing: true, halo: true },
};
const drawing = compile({ dem, photos: points, image, sym });
console.log(`\ncompiled: ${drawing.report.totals.paths} paths,`
  + ` ${drawing.report.totals.circles} circles,`
  + ` ${drawing.report.totals.vertices} vertices`);
for (const w of drawing.warnings) console.log(`  warning: ${w}`);

// ── 5 · the licence guard must actually bite ───────────────────────────────
let blocked = "NOT BLOCKED — BUG";
try {
  compile({ dem, photos: points, image, sym: { ...sym, halftone: { enabled: true, across: 60 } }, forExport: true });
} catch (e) { blocked = e.message.slice(0, 72) + "…"; }
console.log(`\nrestricted image, forExport: ${blocked}`);

// The same image previews fine — restricted means "not written", not "not seen".
const prev = compile({ dem, photos: points, image, sym: { ...sym, halftone: { enabled: true, across: 60 } } });
console.log(`restricted image, preview:   ${prev.report.halftone.marks} marks drawn on screen`);

// An image of our own exports.
if (image) {
  const mine = { ...image, licence: "own", name: "my-drone-flight.tif" };
  const ok = compile({ dem, photos: points, image: mine, forExport: true,
    sym: { ...sym, halftone: { enabled: true, mode: "triple", across: 34 } } });
  console.log(`own image, triple halftone:  ${ok.report.halftone.marks} marks,`
    + ` ${ok.report.halftone.channels.join(" / ")}`);
}

// ── 6 · write the slice ────────────────────────────────────────────────────
const outDir = "D:/Claude Code Projects/DL-TerrainMapper/output";
mkdirSync(outDir, { recursive: true });
const dxf = toDXF(drawing);
const text = dxf.toString();
writeFileSync(`${outDir}/slice-test.dxf`, text, "latin1");
writeFileSync(`${outDir}/slice-test-report.txt`, reportText(drawing, { date: "2026-08-23" }), "utf8");
console.log(`\nwrote output/slice-test.dxf  (${(text.length / 1024).toFixed(0)} kB,`
  + ` ${dxf.counts.polyline} polylines, ${dxf.counts.circle} circles)`);

const checks = [
  ["ASCII only", !/[^\x00-\x7F]/.test(text)],
  ["no exponents", !/\d[eE][-+]?\d/.test(text)],
  ["ends with EOF", text.endsWith("0\r\nEOF\r\n")],
  ["POLYLINE/SEQEND balanced",
    (text.match(/\r\nPOLYLINE\r\n/g) || []).length === (text.match(/\r\nSEQEND\r\n/g) || []).length],
  ["licence guard bites", blocked !== "NOT BLOCKED — BUG"],
];
console.log("");
for (const [n, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`);
console.log(`\nall passed: ${checks.every(([, o]) => o)}`);
