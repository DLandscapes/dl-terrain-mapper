// node tests/check-sheet.mjs — contours → sheet → labels → DXF, end to end.
import { makeDEM, stats } from "../static/dem.js";
import { traceContours, niceInterval } from "../static/contours.js";
import { sheetFor, fitScale, scaleBar, northPoint } from "../static/sheet.js";
import { toSheet, labelContours } from "../static/labels.js";
import { DXF } from "../static/dxf.js";
import { measure, textStrokes, formatLevel } from "../static/stroke-font.js";

const dem = makeDEM(201, 201, 1, (c, r) => {
  const dx = (c - 100) / 40, dy = (r - 100) / 40;
  return 60 + 18 * Math.exp(-(dx * dx + dy * dy))
    + 6 * Math.sin(c / 23) * Math.cos(r / 19);
}, { originX: 500000, originY: 7600000, crs: "EPSG:25833", name: "synthetic" });

const s = stats(dem);
const interval = niceInterval(s.relief, 14);
console.log(`DEM 201x201 @1 m   z ${s.min.toFixed(1)}..${s.max.toFixed(1)}   interval ${interval} m`);

const scale = fitScale(dem, 600, 300, { margin: 10 });
const sheet = sheetFor(dem, { scale, margin: 10 });
console.log(`fitted scale 1:${scale}  →  sheet ${sheet.width.toFixed(1)} × ${sheet.height.toFixed(1)} mm`
  + `  (${sheet.mmPerUnit.toFixed(2)} mm per ground metre)`);

const lines = traceContours(dem, interval, { indexEvery: 5, minLength: 2 });
const inMM = lines.map((l) => toSheet(l, sheet));
console.log(`traced ${lines.length} paths, ${lines.reduce((a, l) => a + l.pts.length / 2, 0)} points`);

const { lines: labelled, labels, placed, skipped } = labelContours(inMM, {
  interval, every: 5, size: 2.2, spacing: 55,
});
console.log(`labels: ${placed} placed, ${skipped} sites rejected as too curved or too short`);
console.log(`lines after gap-cutting: ${labelled.length} (was ${inMM.length})`);

// The gap must actually be a gap: no contour point may fall inside a label box.
const probe = labelContours(inMM.slice(), { interval, every: 5, size: 2.2, spacing: 55 });
let inside = 0;
for (const st of probe.labels) {
  const cx = st[0], cy = st[1];
  for (const l of probe.lines) {
    for (let i = 0; i < l.pts.length; i += 2) {
      if (Math.abs(l.pts[i] - cx) < 0.4 && Math.abs(l.pts[i + 1] - cy) < 0.4) inside++;
    }
  }
}
console.log(`contour points landing on a label stroke start: ${inside} (want 0)`);

const dxf = new DXF();
dxf.rect(0, 0, sheet.width, sheet.height, "DLF-99_sheet");
for (const l of labelled) {
  dxf.polyline(l.pts, l.index ? "DLF-03_score_strong" : "DLF-02_score_medium", { closed: l.closed });
}
dxf.paths(labels, "DLF-01_score_light");
const bar = scaleBar(sheet, { x: 12, y: 4, target: 40 });
dxf.paths(bar.paths, "DLF-01_score_light");
dxf.paths(textStrokes(`${bar.metres} m   1:${scale}`, { x: 12, y: 6.5, size: 2.4, tracking: 6 }),
  "DLF-01_score_light");
dxf.paths(northPoint({ x: sheet.width - 12, y: 4, size: 8 }), "DLF-01_score_light");

const text = dxf.toString();
console.log(`DXF: ${dxf.counts.polyline} polylines, ${dxf.counts.vertices} vertices,`
  + ` ${dxf.counts.circle} circles, ${(text.length / 1024).toFixed(0)} kB`);

// Structural checks the laser front-end will also make.
const checks = [
  ["starts with SECTION", text.startsWith("0\r\nSECTION\r\n")],
  ["ends with EOF", text.endsWith("0\r\nEOF\r\n")],
  ["declares AC1009", text.includes("$ACADVER\r\n1\r\nAC1009")],
  ["millimetres", text.includes("$INSUNITS\r\n70\r\n4")],
  ["CONTINUOUS linetype defined", text.includes("LTYPE\r\n2\r\nCONTINUOUS")],
  ["all seven DLF layers", ["DLF-00_engrave", "DLF-01_score_light", "DLF-02_score_medium",
    "DLF-03_score_strong", "DLF-04_cut_inner", "DLF-05_cut_outer", "DLF-99_sheet"]
    .every((n) => text.includes(`\r\n2\r\n${n}\r\n`))],
  ["pure ASCII", !/[^\x00-\x7F]/.test(text)],
  ["no exponent notation", !/\d[eE][-+]?\d/.test(text)],
  ["POLYLINE/SEQEND balanced",
    (text.match(/\r\nPOLYLINE\r\n/g) || []).length === (text.match(/\r\nSEQEND\r\n/g) || []).length],
];
for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);

console.log(`formatLevel: ${formatLevel(77.5, 0.25)} / ${formatLevel(77.5, 5)}`
  + `   measure("77.5") = ${measure("77.5", { size: 2.2, tracking: 6 }).width.toFixed(2)} mm wide`);
console.log(`\nall checks passed: ${checks.every(([, ok]) => ok)}`);
