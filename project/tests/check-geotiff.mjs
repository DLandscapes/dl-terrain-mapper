// node tests/check-geotiff.mjs — the reader against real rasters.
// ⚠️ READ-ONLY. These files belong to other projects with their own sessions;
// this test opens them and writes nothing anywhere near them.
import { readFileSync, existsSync } from "node:fs";
import { readTIFF, readElevation, readOrtho } from "../static/geotiff.js";
import { stats } from "../static/dem.js";
import { traceContours, niceInterval } from "../static/contours.js";

const D = "D:/Claude Code Projects/VID Poster ECLAS/data/";
const targets = [
  ["elevation", D + "orndalen/orndalen_2024_4m.tif"],
  ["elevation", D + "orndalen/orndalen_fill_025m.tif"],
  ["elevation", D + "test.tif"],
  ["ortho", D + "ortho 64x64.tif"],
  ["ortho", D + "ortho 256x256.tif"],
];

const buf = (p) => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

for (const [kind, path] of targets) {
  const label = path.split("/").pop();
  if (!existsSync(path)) { console.log(`SKIP  ${label} (not present)`); continue; }
  try {
    const t = readTIFF(buf(path));
    const geo = t.ungeoreferenced ? "no georeferencing" : `${t.cell} u/cell @ ${t.originX}, ${t.originY}`;
    console.log(`\n${label}`);
    console.log(`  ${t.width}×${t.height}, ${t.samples} band(s), ${t.crs || "no CRS tag"}, ${geo}`
      + (t.nodata !== undefined ? `, nodata ${t.nodata}` : ""));
    if (kind === "elevation") {
      const dem = readElevation(buf(path), { name: label });
      const s = stats(dem);
      const pct = ((s.measured / s.total) * 100).toFixed(1);
      console.log(`  z ${s.min.toFixed(2)}..${s.max.toFixed(2)} m, relief ${s.relief.toFixed(2)} m,`
        + ` ${pct}% of cells measured`);
      const iv = niceInterval(s.relief, 12);
      const t0 = Date.now();
      const lines = traceContours(dem, iv, { indexEvery: 5, minLength: dem.cell });
      const pts = lines.reduce((a, l) => a + l.pts.length / 2, 0);
      const segs = pts - lines.filter((l) => !l.closed).length;
      console.log(`  contours @ ${iv} m: ${lines.length} continuous paths, ${pts} points`
        + ` — ${segs} segments would have been ${segs} pierces unchained`);
      console.log(`  traced in ${Date.now() - t0} ms`);
    } else {
      const o = readOrtho(buf(path), { name: label });
      let r = 0, g = 0, b = 0;
      const n = o.width * o.height;
      for (let i = 0; i < n; i++) { r += o.rgb[i * 3]; g += o.rgb[i * 3 + 1]; b += o.rgb[i * 3 + 2]; }
      console.log(`  mean RGB ${(r / n).toFixed(0)}, ${(g / n).toFixed(0)}, ${(b / n).toFixed(0)}`);
    }
  } catch (e) {
    console.log(`\n${label}\n  REFUSED: ${e.message}`);
  }
}
