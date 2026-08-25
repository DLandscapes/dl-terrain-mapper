// Quick bench for the tracer, run with: node tests/check-contours.mjs
// The real suite is tests/selftest.mjs; this one exists to show the dash count.
import { makeDEM, stats } from "../static/dem.js";
import { traceContours, pathLength, niceInterval } from "../static/contours.js";

const R = 64;
// A cone: every level must come out as ONE closed ring, which is the strongest
// possible statement that chaining works.
const cone = makeDEM(129, 129, 1, (c, r) => {
  const dx = c - 64, dy = r - 64;
  return 40 - Math.hypot(dx, dy) * 0.5;
}, { originX: 500000, originY: 7600000, crs: "EPSG:25833" });

const s = stats(cone);
console.log(`cone: ${cone.nrows}x${cone.ncols}  z ${s.min.toFixed(2)}..${s.max.toFixed(2)}`);

const lines = traceContours(cone, 2, { indexEvery: 5 });
const closed = lines.filter((l) => l.closed).length;
const pts = lines.reduce((a, l) => a + l.pts.length / 2, 0);
const segs = lines.reduce((a, l) => a + l.pts.length / 2 - (l.closed ? 0 : 1), 0);
console.log(`  paths ${lines.length}  (closed ${closed})  points ${pts}  segments ${segs}`);
console.log(`  ⇒ ${(segs / lines.length).toFixed(0)} segments per pierce`
  + `  — as raw dashes this would be ${segs} pierces`);

// Per level, how many paths? A cone must give exactly one.
const byLevel = new Map();
for (const l of lines) byLevel.set(l.level, (byLevel.get(l.level) || 0) + 1);
const bad = [...byLevel].filter(([, n]) => n !== 1);
console.log(`  levels ${byLevel.size}, levels with more than one path: ${bad.length}`);

// A saddle: the classic ambiguous case, which per-triangle marching cannot
// resolve wrongly because it never has to resolve it.
const saddle = makeDEM(65, 65, 1, (c, r) => {
  const x = (c - 32) / 16, y = (r - 32) / 16;
  return (x * x - y * y) * 5;
});
const sl = traceContours(saddle, 1);
console.log(`saddle: paths ${sl.length}, open ${sl.filter((l) => !l.closed).length}`);

// Nodata must produce no invented geometry.
const holed = makeDEM(65, 65, 1, (c, r) => {
  const dx = c - 32, dy = r - 32;
  if (Math.hypot(dx, dy) < 8) return NaN;
  return 20 - Math.hypot(dx, dy) * 0.25;
});
const hl = traceContours(holed, 1);
const finite = hl.every((l) => [...l.pts].every(Number.isFinite));
console.log(`nodata: paths ${hl.length}, all coordinates finite: ${finite}`);

// Orientation: high ground on the left means a summit ring is CCW in map space.
const ring = lines.find((l) => l.closed && l.level === 20);
if (ring) {
  let a2 = 0;
  const p = ring.pts, n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a2 += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  console.log(`orientation: summit ring at 20 m is ${a2 > 0 ? "CCW (high on left) ✓" : "CW ✗"}`
    + `, length ${pathLength(ring.pts, true).toFixed(1)} m`
    + ` (a true circle would be ${(2 * Math.PI * 40).toFixed(1)} m)`);
}
console.log(`niceInterval(${s.relief.toFixed(1)} m) = ${niceInterval(s.relief)} m`);
