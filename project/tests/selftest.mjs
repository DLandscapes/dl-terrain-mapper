// @ts-check
// THE SUITE. node tests/selftest.mjs
//
// ⚠️ EVERY CHECK ASSERTS A PROPERTY THE MACHINE DEPENDS ON, not the shape of
// the code. The style is inherited from the DLC H26 generators: a check earns
// its place by describing something that, if it broke, would be discovered on
// material. Checks that would only restate the implementation are not written.

import { makeDEM, stats, sampleBilinear, toGrid, toMap } from "../static/dem.js";
import { traceContours, contourLevels, niceInterval, pathLength } from "../static/contours.js";
import { textStrokes, measure, formatLevel, hasGlyph, setLettering, LETTERINGS } from "../static/stroke-font.js";
import { DXF, DLF_LAYERS, num } from "../static/dxf.js";
import { sheetFor, fitScale, scaleBar, SCALE_LADDER } from "../static/sheet.js";
import { BURN_MM } from "../static/patterns.js";
import { toSheet, labelContours } from "../static/labels.js";
import { toUTM, fromUTM, zoneFor, zoneFromEPSG } from "../static/utm.js";
import { readPhotoMeta, readPhotoSet } from "../static/exif.js";
import { placePhotos, correct, markGeometry } from "../static/photos.js";
import { symbolField, symbolLegend, signedSymbolField, strideFor, slopeDegrees, hatchCircle } from "../static/symbols.js";
import { vectorHalftone, tripleHalftone, budget, assertExportable, CHANNELS } from "../static/halftone.js";
import { compile, toDXF, reportText, sheetsIn, letterInkHalf } from "../static/compile.js";
import { inflate, lzwDecode, packbits, unpredict, unpredictFloat } from "../static/decompress.js";
import { readTIFF, readElevation } from "../static/geotiff.js";
import { makeExifJPEG } from "./exif-fixture.mjs";
import { makeTIFF, tiffLZWEncode } from "./tiff-fixture.mjs";
import { dashPath, applyStyle, LINE_STYLES, STYLE_ORDER, styleLabel } from "../static/linestyle.js";
import { PASS_COLOURS, passColour } from "../static/dxf.js";
import { parseXML, readProps } from "../static/xml.js";
import { buildTestSheet, testSheetProcedure, TYPE_LADDER, DOT_LADDER } from "../static/testsheet.js";
import { toSVG } from "../static/svg.js";
import { traceRegions, differenceDEM } from "../static/regions.js";
import { hatchField } from "../static/hatch.js";
import { ruggedness, roughness, fillDepressions, flowAccumulation, wetnessIndex,
  indexNote } from "../static/terrain.js";
import { hachureLines, fallLine } from "../static/hachures.js";
import { cutSections } from "../static/sections.js";
import { readShapefile, signedArea2, readPRJ } from "../static/shapefile.js";
import { rasterPlan, cutLinesOnly, ENGRAVE_GREY, DPI_LADDER } from "../static/raster.js";
import { readGML, parseSRS } from "../static/gml.js";
import { fillRegion, FILL_PATTERNS, cellRandom } from "../static/patterns.js";
import { strokeBand, bandArea, bandFill } from "../static/stroke-band.js";
import { buildFeature, FEATURE_LINETYPES, scaleValue, angleValue, symbolPaths,
  SYMBOL_ORDER } from "../static/features.js";
import { readDBF, assertPairs, fieldRange } from "../static/dbf.js";
import { makeDBF } from "./dbf-fixture.mjs";
import { clipPathToRings, pointInRings, clipDrawing, ringsBBox } from "../static/clip.js";
import { makeSHP, rectCW, rectCCW } from "./shp-fixture.mjs";
import { writeSHP, writeDBF, prjFor, zipStore, drawingToShapefiles,
  SHP_POINT, SHP_POLYLINE } from "../static/shp-write.js";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const F = [];
/** @param {string} name @param {boolean} ok @param {string} [detail] */
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; }
  else { fail++; F.push(`${name}${detail ? "  — " + detail : ""}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const group = (n) => console.log(`\n── ${n} ${"─".repeat(Math.max(0, 60 - n.length))}`);
const RE_POLYLINE = new RegExp(String.fromCharCode(13, 10) + "POLYLINE" + String.fromCharCode(13, 10), "g");
const RE_SEQEND = new RegExp(String.fromCharCode(13, 10) + "SEQEND" + String.fromCharCode(13, 10), "g");
// ⚠️ WRITTEN AS ESCAPES, NOT AS RAW BYTES. This used to hold a literal
// NUL and DEL inside the character class, which is legal JavaScript and made git
// treat the entire suite as a BINARY FILE — so no diff of it has ever been
// readable, in this commit or any before it. Identical behaviour, visible history.
const RE_NON_ASCII = /[^\x00-\x7F]/;

// ── dem ──────────────────────────────────────────────────────────────────────
group("dem");
{
  const d = makeDEM(10, 20, 2, (c, r) => (c === 5 && r === 5 ? NaN : c + r));
  const s = stats(d);
  ok("stats counts only measured cells", s.measured === 199 && s.total === 200);
  ok("stats reports the real range", s.min === 0 && s.max === 28);
  ok("empty grid gives NaN, not Infinity", Number.isNaN(stats(makeDEM(2, 2, 1, () => NaN)).min));
  ok("bilinear sample is poisoned by a NaN corner", Number.isNaN(sampleBilinear(d, 5.5, 5.5)));
  ok("bilinear sample works away from the hole", near(sampleBilinear(d, 2.5, 2.5), 4, 1e-9));
  ok("grid and map round-trip", (() => {
    const g = toGrid(d, 12, 14); const m = toMap(d, g.gx, g.gy);
    return near(m.X, 12, 1e-9) && near(m.Y, 14, 1e-9);
  })());
  ok("row 0 is the north edge", d.originY === 20);
}

// ── contours ─────────────────────────────────────────────────────────────────
group("contours");
{
  const cone = makeDEM(129, 129, 1, (c, r) => 40 - Math.hypot(c - 64, r - 64) * 0.5,
    { originX: 500000, originY: 7600000 });
  const lines = traceContours(cone, 2, { indexEvery: 5 });

  // THE property this tool exists for.
  const pts = lines.reduce((a, l) => a + l.pts.length / 2, 0);
  ok("chaining: thousands of segments become tens of paths", lines.length < 60 && pts > 8000,
    `${lines.length} paths, ${pts} points`);

  // A cone's interior levels must each be exactly ONE closed ring.
  const interior = new Map();
  for (const l of lines) if (l.level >= 10) interior.set(l.level, (interior.get(l.level) || 0) + 1);
  ok("a cone gives one ring per interior level", [...interior.values()].every((n) => n === 1),
    `${[...interior.values()].filter((n) => n !== 1).length} levels split`);
  ok("interior rings are closed", lines.filter((l) => l.level >= 10).every((l) => l.closed));

  // Geometry, against the closed form.
  const r20 = lines.find((l) => l.closed && l.level === 20);
  ok("ring length matches the true circle", r20 && near(pathLength(r20.pts, true), 2 * Math.PI * 40, 0.5),
    r20 ? pathLength(r20.pts, true).toFixed(2) : "missing");
  const area2 = (p) => { let a = 0; const n = p.length / 2;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n;
      a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; } return a; };
  ok("summit rings wind CCW (high ground on the left)", r20 && area2(r20.pts) > 0);

  // Nodata invents nothing.
  const holed = makeDEM(65, 65, 1, (c, r) =>
    (Math.hypot(c - 32, r - 32) < 8 ? NaN : 20 - Math.hypot(c - 32, r - 32) * 0.25));
  const hl = traceContours(holed, 1);
  ok("nodata produces only finite coordinates", hl.every((l) => l.pts.every(Number.isFinite)));
  ok("nodata leaves a hole rather than bridging it",
    hl.every((l) => { for (let i = 0; i < l.pts.length; i += 2)
      if (Math.hypot(l.pts[i] - 32.5, 32.5 - l.pts[i + 1]) < 6.5) return false; return true; }));

  // A plateau exactly on a level: the line runs round the pad, not through it.
  const pad = makeDEM(41, 41, 1, (c, r) => (Math.abs(c - 20) < 8 && Math.abs(r - 20) < 8 ? 10 : 6));
  const pl = traceContours(pad, 1, { levels: [10] });
  ok("a plateau exactly at a level does not fill with lines", pl.length === 0,
    `${pl.length} paths at the plateau's own height`);

  ok("levels are anchored to zero", contourLevels(77.3, 82.1, 2).join(",") === "78,80,82");
  ok("an absurd interval is refused, not attempted", contourLevels(0, 1000, 1e-6).length === 0);
  ok("niceInterval uses the 1-2-5 series", [1, 2, 5, 10, 0.5, 0.25]
    .includes(niceInterval(45)) && niceInterval(45) === 5);
  ok("an empty raster traces to nothing", traceContours(makeDEM(1, 1, 1, () => 5), 1).length === 0);

  // ⚠️ CONTOURS MUST REACH THE RASTER'S DECLARED EDGE. Values live at cell
  // centres, so the naive tracer stops half a cell short on every side. Alone
  // that is invisible; on a TILED SET it puts a blank strip at every seam —
  // Marc's 45 LAR3072 plates abut exactly, so each join lost 1 m of ground,
  // 5 mm of paper at 1:200, on the assembled object.
  const tile = makeDEM(40, 40, 2, (c, r) => 50 + c * 0.7 + r * 0.4,
    { originX: 654000, originY: 7738080 });
  const ext = { x0: 654000, x1: 654000 + 40 * 2, y0: 7738080 - 40 * 2, y1: 7738080 };
  const bbox = (lines) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const l of lines) for (let i = 0; i < l.pts.length; i += 2) {
      x0 = Math.min(x0, l.pts[i]); x1 = Math.max(x1, l.pts[i]);
      y0 = Math.min(y0, l.pts[i + 1]); y1 = Math.max(y1, l.pts[i + 1]);
    }
    return { x0, x1, y0, y1 };
  };
  const bE = bbox(traceContours(tile, 5));
  ok("contours reach the declared extent on every side",
    near(bE.x0, ext.x0, 1e-6) && near(bE.x1, ext.x1, 1e-6)
    && near(bE.y0, ext.y0, 1e-6) && near(bE.y1, ext.y1, 1e-6),
    `${bE.x0 - ext.x0} / ${ext.x1 - bE.x1}`);
  ok("and nothing escapes it", traceContours(tile, 5).every((l) => {
    for (let i = 0; i < l.pts.length; i += 2) {
      if (l.pts[i] < ext.x0 - 1e-9 || l.pts[i] > ext.x1 + 1e-9) return false;
      if (l.pts[i + 1] < ext.y0 - 1e-9 || l.pts[i + 1] > ext.y1 + 1e-9) return false;
    }
    return true; }));
  const bC = bbox(traceContours(tile, 5, { edge: "centres" }));
  ok("edge:centres keeps the strict half-cell inset, for anyone who wants it",
    near(bC.x0 - ext.x0, tile.cell / 2, 1e-6) && near(ext.x1 - bC.x1, tile.cell / 2, 1e-6));

  // ⚠️ THE EXTENSION MUST NOT MOVE INTERIOR GEOMETRY. It adds a ring outside
  // the data; if it perturbed the inside, every drawing this tool has ever made
  // would be a little wrong in a way nothing else would catch.
  const inner = traceContours(cone, 2, { indexEvery: 5 });
  const innerRing = inner.find((l) => l.closed && l.level === 20);
  ok("edge extension leaves interior contours untouched",
    innerRing && near(pathLength(innerRing.pts, true), 2 * Math.PI * 40, 0.5),
    innerRing ? pathLength(innerRing.pts, true).toFixed(3) : "missing");
  ok("a nodata hole is still not bridged after extension",
    traceContours(holed, 1).every((l) => {
      for (let i = 0; i < l.pts.length; i += 2)
        if (Math.hypot(l.pts[i] - 32.5, 32.5 - l.pts[i + 1]) < 6.5) return false;
      return true; }));
}

// ── stroke font ──────────────────────────────────────────────────────────────
group("stroke font");
{
  ok("digits and a decimal point all exist", [..."0123456789.-"].every(hasGlyph));
  ok("the alphabet exists", [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].every(hasGlyph));
  const st = textStrokes("77.5", { size: 4 });
  ok("text becomes stroke paths", st.length > 0 && st.every((p) => p.length >= 4));
  ok("no stroke is a single point (a pierce with no travel)", st.every((p) => p.length >= 4));
  const m = measure("77.5", { size: 4 });
  ok("measure returns real ink bounds", m.width > 0 && near(m.height, 4, 0.4));
  ok("the full stop is a closed path, not a dot", (() => {
    const dot = textStrokes(".", { size: 4 })[0];
    return dot && dot.length >= 8;
  })());
  ok("cap height is honoured", near(measure("8", { size: 10 }).height, 10, 0.2));
  ok("the interval decides the decimals", formatLevel(77.5, 5) === "78"
    && formatLevel(77.5, 0.25) === "77.5" && formatLevel(77, 0.1) === "77.0");
  const rot = textStrokes("1", { size: 4, angle: Math.PI / 2, x: 10, y: 10 });
  ok("rotation pivots about the anchor", rot.every((p) => {
    for (let i = 0; i < p.length; i += 2) if (Math.hypot(p[i] - 10, p[i + 1] - 10) > 12) return false;
    return true; }));
  ok("anchor middle centres the text", (() => {
    const a = textStrokes("77", { size: 4, x: 0, anchor: "middle" });
    let lo = Infinity, hi = -Infinity;
    for (const p of a) for (let i = 0; i < p.length; i += 2) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
    return near((lo + hi) / 2, 0, 0.3); })());

  // ── lettering styles: one skeleton, affine dresses, never a second face ──
  const inkWidth = (t2, o2) => {
    let lo = Infinity, hi = -Infinity;
    for (const p of textStrokes(t2, o2)) {
      for (let i = 0; i < p.length; i += 2) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
    }
    return hi - lo;
  };
  const wReg = inkWidth("HELLO 88", { size: 4 });
  const mReg = measure("HELLO 88", { size: 4 });
  setLettering("condensed");
  const wCon = inkWidth("HELLO 88", { size: 4 });
  const mCon = measure("HELLO 88", { size: 4 });
  setLettering("wide");
  const wWide = inkWidth("HELLO 88", { size: 4 });
  setLettering("slanted");
  const slantTop = textStrokes("I", { size: 10 });
  setLettering("regular");
  const wBack = inkWidth("HELLO 88", { size: 4 });
  ok("condensed is narrower and wide is wider than regular",
    wCon < wReg * 0.92 && wWide > wReg * 1.1);
  ok("measure scales with the style, so gap-cutting stays honest",
    near(mCon.width, mReg.width * LETTERINGS.condensed.sx, 1e-6));
  ok("slanted leans: the cap of an I sits right of its foot", (() => {
    let footX = 0, capX = 0;
    for (const p of slantTop) {
      for (let i = 0; i < p.length; i += 2) {
        if (near(p[i + 1], 0, 0.01)) footX = p[i];
        if (near(p[i + 1], 10, 0.01)) capX = p[i];
      }
    }
    return capX > footX + 1; })());
  ok("cap height is untouched by every style", (() => {
    for (const s2 of ["condensed", "wide", "slanted"]) {
      setLettering(s2);
      if (!near(measure("8", { size: 10 }).height, 10, 0.2)) { setLettering("regular"); return false; }
    }
    setLettering("regular"); return true; })());
  ok("setLettering('regular') restores the default exactly", near(wBack, wReg, 1e-9));
  ok("an unknown style falls back to regular rather than throwing", (() => {
    setLettering("gothic");
    const w2 = inkWidth("HELLO 88", { size: 4 });
    setLettering("regular");
    return near(w2, wReg, 1e-9); })());

  // The compiler threads the choice: same drawing, condensed letters narrower
  // furniture text — and the module is set fresh by EVERY compile, so one
  // drawing's choice cannot leak into the next.
  const demT = makeDEM(30, 30, 1, (c, r) => 50 + c * 0.2 + r * 0.1, { name: "t" });
  const furnW = (lettering) => {
    const d2 = compile({ dem: demT, sym: { contours: { enabled: false },
      sheet: { title: "ABCDEFG", lettering } } });
    let lo = Infinity, hi = -Infinity, top = -Infinity;
    for (const p of d2.paths) {
      // ⚠️ FILTERED ON THE TAG, NOT ON THE PASS. What this measures is the
      // furniture's lettering; which pass furniture goes on is a separate
      // decision that has already changed once (score light -> engrave), and a
      // test that pins it makes that decision look like a regression.
      if (p.furniture !== true) continue;
      for (let i = 0; i < p.pts.length; i += 2) {
        if (p.pts[i + 1] > d2.sheet.height * 0.7) {          // the title zone
          lo = Math.min(lo, p.pts[i]); hi = Math.max(hi, p.pts[i]);
          top = Math.max(top, p.pts[i + 1]);
        }
      }
    }
    return { w: hi - lo, top, sheetH: d2.sheet.height };
  };
  const fr = furnW("regular"), fc = furnW("condensed");
  ok("compile letters the title in the chosen style", fc.w < fr.w * 0.92);
  // ⚠️ Marc, 2026-08-24: the engraved title's gap from the top edge equals its
  // gap from the left edge — the ink tops out exactly `fx` (4 mm at margin 0)
  // below the sheet edge, not 1.8 mm as before.
  // ⚠️ MEASURED TO THE INK, WHICH IS NOT THE GEOMETRY. A furniture path is a
  // centreline and what lands on the material is that centreline plus half a
  // burn — so this reads the top of the drawn letter, adds the ink the engrave
  // pass puts around it, and asks where the MARK ends. Measuring the geometry
  // passed at 4.000 while the ink stood at 3.850.
  ok("the title's gap from the top equals the furniture gap from the left",
    near(fr.sheetH - fr.top - letterInkHalf(3.2), 4, 0.05));

  // ⚠️ A LETTER SMALLER THAN THE BURN CANNOT BE GIVEN WEIGHT, AND MUST NOT BE
  // BANDED AS IF IT COULD. A stroke on the engrave pass already inks BURN_MM
  // wide, so banding a skeleton at the full 12% of cap height adds the burn on
  // top of the band: a 2 mm footer asked for 0.30 mm and inked at 0.60 — 30% of
  // cap height, which closes the counters of an 8 and an 0 and is what made the
  // furniture read as a blob rather than as text. Below the merge distance the
  // plain stroke IS the letter, and the ink is the weight.
  //
  // ⚠️ AND EVERY FURNITURE SIZE IS BELOW IT. 12% clears a 0.3 mm burn only above
  // 2.5 mm caps; the N is 1.6, the legend 1.8, the footer 2, the title 3.2. That
  // is the finding, not a bug: giving the SKELETON weight cannot change how the
  // lettering reads at plate sizes. The real face needs its real outlines.
  ok("furniture lettering is not banded at sizes where the burn is the weight",
    letterInkHalf(1.6) === letterInkHalf(3.2)
    && [1.6, 1.8, 2, 3.2].every((z) => letterInkHalf(z) * 2 <= 0.3001),
    [1.6, 1.8, 2, 3.2].map((z) => `${z}->${(letterInkHalf(z) * 2).toFixed(3)}`).join(" "));
  ok("above that size a letter does get a band, so the rule is a floor not a cap",
    letterInkHalf(8) * 2 > 0.9 && letterInkHalf(4.9) * 2 <= 0.3001,
    `4.9 mm -> ${(letterInkHalf(4.9) * 2).toFixed(3)}, 8 mm -> ${(letterInkHalf(8) * 2).toFixed(3)}`);
}

// ── dxf ──────────────────────────────────────────────────────────────────────
group("dxf");
{
  ok("num never emits an exponent", !/[eE]/.test(num(1e-9)) && !/[eE]/.test(num(1.2e21)));
  ok("num trims trailing zeros", num(12.5) === "12.5" && num(3) === "3");
  ok("num turns negative zero into zero", num(-0) === "0");
  const d = new DXF();
  d.polyline([0, 0, 10, 0, 10, 10], "DLF-02_score_medium", { closed: true });
  d.circle(5, 5, 2, "DLF-00_engrave");
  d.polyline([1, 1], "DLF-02_score_medium");                  // one point: must be dropped
  const t = d.toString();
  ok("a one-point path is refused", d.counts.polyline === 1);
  ok("ASCII only", !/[^\x00-\x7F]/.test(t));
  ok("no exponent notation anywhere", !/\d[eE][-+]?\d/.test(t));
  ok("CRLF line endings", t.includes("\r\n") && !/[^\r]\n/.test(t));
  ok("POLYLINE and SEQEND are balanced",
    (t.match(/\r\nPOLYLINE\r\n/g) || []).length === (t.match(/\r\nSEQEND\r\n/g) || []).length);
  ok("the linetype table is present", t.includes("LTYPE\r\n2\r\nCONTINUOUS"));
  ok("all six DLF pass layers plus the sheet layer are declared",
    DLF_LAYERS.every(([n]) => t.includes(`\r\n2\r\n${n}\r\n`)) && t.includes("DLF-99_sheet"));
  ok("the layer names match DL-TerrainSlicer exactly",
    DLF_LAYERS.map(([n]) => n).join("|") ===
    "DLF-00_engrave|DLF-01_score_light|DLF-02_score_medium|DLF-03_score_strong|DLF-04_cut_inner|DLF-05_cut_outer");
  ok("the ACI colours match too",
    DLF_LAYERS.map(([, a]) => a).join(",") === "7,5,3,4,6,1");
  ok("extents are recorded", t.includes("$EXTMAX"));
  ok("a circle is a CIRCLE, not a polygon", (t.match(/\r\nCIRCLE\r\n/g) || []).length === 1);
}

// ── sheet ────────────────────────────────────────────────────────────────────
group("sheet");
{
  const dem = makeDEM(100, 200, 1, () => 0, { originX: 1000, originY: 1100 });
  const s = sheetFor(dem, { scale: 200, margin: 10 });
  ok("1:200 puts one ground metre on five millimetres", near(s.mmPerUnit, 5, 1e-9));
  ok("the drawing is the ground times the scale", near(s.drawW, 1000, 1e-6) && near(s.drawH, 500, 1e-6));
  ok("margins are added on both sides", near(s.width, 1020, 1e-6));
  ok("the sheet origin is its lower left", near(s.X(1000), 10, 1e-9) && near(s.Y(1000), 10, 1e-9));
  ok("north is up: a higher northing is a higher y", s.Y(1100) > s.Y(1000));
  const fitted = fitScale(dem, 600, 400, { margin: 10 });
  ok("fitScale returns a scale from the ladder", SCALE_LADDER.includes(fitted));
  ok("the fitted drawing actually fits", (() => {
    const f = sheetFor(dem, { scale: fitted, margin: 10 });
    return f.width <= 600 && f.height <= 400; })());
  ok("a bed too small for any ladder scale returns null", fitScale(dem, 5, 5) === null);
  const bar = scaleBar(s, { target: 50 });
  ok("the scale bar is a round number of metres", [1, 2, 5, 10, 20, 25, 50, 100].includes(bar.metres));

  // ⚠️ THE BAR IS THE ONE OBJECT ON THE SHEET WHOSE DIMENSIONS ARE ITS CONTENT,
  // AND IT IS DRAWN IN INK THAT HAS WIDTH. Every solid here is strokes SOLID_MM
  // apart burning BURN_MM wide, so a run of them reaches half a burn past its
  // own centreline in every direction. Ringing each cell with an outline as well
  // put that overshoot on the OUTSIDE of the geometry: a 45 mm bar inked 45.3,
  // and the thin half inked 0.9 mm against a 1.8 mm block instead of 0.6 — the
  // 1:3 step that IS the halfway mark read as 1:2. What is checked is the INK.
  ok("the inked scale bar is the length and the thickness it declares", (() => {
    const d2 = compile({ dem, sym: { contours: { enabled: false },
      sheet: { scaleBar: true, north: false, frame: false, title: "" } } });
    const f = d2.paths.filter((p) => p.furniture === true);
    if (!f.length) return false;
    // ⚠️ THE BAR, NOT THE FOOTER. The footer line sits a few millimetres above
    // it on the same tag, so the window is taken from the bar's OWN baseline —
    // the lowest furniture on the sheet — and is only as tall as a block.
    let base = Infinity;
    for (const p of f) for (let i = 1; i < p.pts.length; i += 2) base = Math.min(base, p.pts[i]);
    const lid = base + 2.5;
    let x0 = Infinity, x1 = -Infinity, y0 = base, y1 = -Infinity, thinTop = -Infinity;
    for (const p of f) {
      for (let i = 0; i < p.pts.length; i += 2) {
        const x = p.pts[i], y = p.pts[i + 1];
        if (y > lid) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    if (!Number.isFinite(x0)) return false;
    const placed = scaleBar(d2.sheet, { x: x0 + BURN_MM / 2, y: y0 + BURN_MM / 2, target: 45 });
    // Rows sit half a burn inside the ends, so the ink spans exactly the declared
    // length and the declared thickness.
    const inkLen = x1 - x0 + BURN_MM, inkThick = y1 - y0 + BURN_MM;
    // ⚠️ THE THIN HALF IS MEASURED BY THE ROWS THAT CROSS IT, NOT BY VERTICES
    // INSIDE IT. Each row is a two-point stroke spanning the whole half, so its
    // endpoints sit at the ends and nothing lands in the middle third.
    for (const p of f) {
      if (p.pts.length !== 4 || p.pts[1] > lid) continue;
      const mid = (p.pts[0] + p.pts[2]) / 2;
      // Past the zero riser, which is as tall as the block and as narrow as a
      // tenth of a millimetre of bar.
      if (mid > x0 + placed.mm * 0.05 && mid < x0 + placed.mm * 0.4) {
        thinTop = Math.max(thinTop, p.pts[1]);
      }
    }
    const inkThin = thinTop - y0 + BURN_MM;
    return Math.abs(inkLen - placed.mm) < 0.05
      && Math.abs(inkThick - placed.thick) < 0.05
      && Math.abs(inkThin - placed.thick / 3) < 0.06; })(),
    "length, block thickness and the 1:3 thin half, measured on the ink");
}

// ── labels ───────────────────────────────────────────────────────────────────
group("labels");
{
  const dem = makeDEM(161, 161, 1, (c, r) => 60 + 20 * Math.exp(-((c - 80) ** 2 + (r - 80) ** 2) / 2000),
    { originX: 0, originY: 161 });
  const sheet = sheetFor(dem, { scale: 500, margin: 10 });
  const traced = traceContours(dem, 2, { indexEvery: 5 });
  const inMM = traced.map((l) => toSheet(l, sheet));
  const before = inMM.reduce((a, l) => a + l.pts.length / 2, 0);
  const r = labelContours(inMM, { interval: 2, every: 1, size: 2.2, spacing: 30 });
  ok("labels are placed", r.placed > 0, `${r.placed}`);
  ok("labelling adds paths, because each gap splits a line", r.lines.length >= inMM.length);
  ok("labelling removes points, because each gap cuts some out",
    r.lines.reduce((a, l) => a + l.pts.length / 2, 0) < before + r.placed * 4);

  // THE property: no contour ink inside a label's box.
  const boxes = [];
  for (const st of r.labels) {
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (let i = 0; i < st.length; i += 2) {
      lo = [Math.min(lo[0], st[i]), Math.min(lo[1], st[i + 1])];
      hi = [Math.max(hi[0], st[i]), Math.max(hi[1], st[i + 1])];
    }
    boxes.push([lo, hi]);
  }
  let intrusions = 0;
  for (const l of r.lines) for (let i = 0; i < l.pts.length; i += 2) {
    for (const [lo, hi] of boxes) {
      if (l.pts[i] > lo[0] && l.pts[i] < hi[0] && l.pts[i + 1] > lo[1] && l.pts[i + 1] < hi[1]) intrusions++;
    }
  }
  ok("no contour vertex lands inside a label's ink box", intrusions === 0, `${intrusions} intrusions`);

  const short = labelContours([{ pts: new Float64Array([0, 0, 3, 0]), closed: false, level: 10, index: false }],
    { interval: 2, every: 1, size: 2.2 });
  ok("a line too short to hold a label is left whole, not shrunk",
    short.placed === 0 && short.lines.length === 1 && short.lines[0].pts.length === 4);

  const unlabelled = labelContours(inMM, { interval: 2, every: 5, size: 2.2, spacing: 30 });
  ok("only the chosen levels are labelled",
    unlabelled.placed > 0 && unlabelled.placed < r.placed);
}

// ── utm ──────────────────────────────────────────────────────────────────────
group("utm");
{
  const t = toUTM(69.6501, 18.9553, 33);
  ok("Tromsø lands in zone 33 where it should",
    near(t.x, 654000, 12000) && near(t.y, 7730000, 12000), `${t.x.toFixed(0)}, ${t.y.toFixed(0)}`);
  const back = fromUTM(t.x, t.y, 33);
  ok("projection round-trips to millimetres",
    near(back.lat, 69.6501, 1e-7) && near(back.lon, 18.9553, 1e-7));
  ok("the central meridian sits at 500000",
    near(toUTM(0, 15, 33).x, 500000, 1e-6));
  ok("the southern hemisphere gets its false northing",
    toUTM(-30, 15, 33, true).y > 6000000);
  // ⚠️ 18.95°E IS GEOGRAPHICALLY ZONE 34 — zone 33 ends at 18°E. Norway uses
  // EPSG:25833 for the whole mainland anyway, stretching zone 33 well past its
  // natural limit, which is exactly why the tool takes the zone from the RASTER
  // and not from the photograph's own longitude. This check pins the honest
  // geographic answer so nobody "fixes" it into the Norwegian convention.
  ok("zoneFor gives the true geographic zone", zoneFor(18.95) === 34 && zoneFor(-74) === 18);
  ok("zoneFor is right at a boundary", zoneFor(12.0) === 33 && zoneFor(17.99) === 33);
  ok("ETRS89 UTM codes are recognised", zoneFromEPSG("EPSG:25833").zone === 33);
  ok("WGS84 UTM codes are recognised", zoneFromEPSG("EPSG:32633").zone === 33);
  ok("southern WGS84 codes are recognised",
    zoneFromEPSG("EPSG:32733").zone === 33 && zoneFromEPSG("EPSG:32733").south === true);
  ok("a geographic CRS is not mistaken for a grid", zoneFromEPSG("EPSG:4326") === null);
  ok("ED50 is refused rather than treated as UTM", zoneFromEPSG("EPSG:23033") === null);
}

// ── exif ─────────────────────────────────────────────────────────────────────
group("exif");
{
  const m = readPhotoMeta(makeExifJPEG({ lat: 69.6501, lon: 18.9553, alt: 143.2, direction: 217.5 }), "a.jpg");
  ok("latitude survives the DMS round-trip", near(m.lat, 69.6501, 1e-5), String(m.lat));
  ok("longitude survives the DMS round-trip", near(m.lon, 18.9553, 1e-5), String(m.lon));
  ok("altitude is read", near(m.alt, 143.2, 0.01));
  ok("the bearing is read, with its reference", near(m.direction, 217.5, 0.01) && m.dirRef === "T");
  ok("the timestamp is read", m.taken === "2026:06:11 10:42:07");
  ok("make and model are read", m.make === "DL" && m.model === "FieldPhone 1");

  const south = readPhotoMeta(makeExifJPEG({ lat: -33.9, lon: -18.4 }), "s.jpg");
  ok("southern and western hemispheres get their sign",
    near(south.lat, -33.9, 1e-4) && near(south.lon, -18.4, 1e-4), `${south.lat}, ${south.lon}`);

  const none = readPhotoMeta(makeExifJPEG({ noGPS: true }), "n.jpg");
  ok("a photo with no GPS block is reported, not dropped",
    none.lat === undefined && !!none.problem);
  ok("a photo with no GPS still yields its timestamp", none.taken === "2026:06:11 10:42:07");

  const nul = readPhotoMeta(makeExifJPEG({ nullIsland: true }), "z.jpg");
  ok("0°, 0° is refused as a placeholder", nul.lat === undefined && /placeholder/.test(nul.problem));

  const noref = readPhotoMeta(makeExifJPEG({ missingRef: true }), "r.jpg");
  ok("a missing hemisphere reference is an error, not an assumption", noref.lat === undefined);

  ok("a non-JPEG is refused politely",
    !!readPhotoMeta(new Uint8Array([1, 2, 3, 4]).buffer, "x.bin").problem);

  const set = readPhotoSet([
    { name: "b.jpg", buffer: makeExifJPEG({ taken: "2026:06:11 12:00:00" }) },
    { name: "a.jpg", buffer: makeExifJPEG({ taken: "2026:06:11 09:00:00" }) },
    { name: "c.jpg", buffer: makeExifJPEG({ noGPS: true }) },
  ]);
  ok("a set is split into located and unlocated",
    set.located.length === 2 && set.unlocated.length === 1);
  ok("located photographs come back in the order the day happened",
    set.located[0].name === "a.jpg");
}

// ── photographs on the map ───────────────────────────────────────────────────
group("photographs on the map");
{
  const dem = makeDEM(200, 200, 1, () => 50, { originX: 654000, originY: 7738200, crs: "EPSG:25833" });
  const metas = [
    readPhotoMeta(makeExifJPEG({ lat: 69.7276, lon: 18.7515, direction: 90 }), "in.jpg"),
    readPhotoMeta(makeExifJPEG({ lat: 60.0, lon: 5.0 }), "far.jpg"),
  ];
  const p = placePhotos(metas, dem);
  ok("the zone comes from the raster, not the photograph", p.zone === 33 && !p.guessedZone);
  ok("a photograph far outside the tile is flagged, not silently placed",
    p.points.some((q) => !q.inside) && p.outside >= 1);
  ok("an outside photograph is excluded from the drawing by default",
    p.points.filter((q) => !q.inside).every((q) => !q.include));
  const q = p.points[0];
  const bx = q.X, by = q.Y;
  correct(q, 5, -3);
  ok("a hand correction moves the point", near(q.X, bx + 5, 1e-9) && near(q.Y, by - 3, 1e-9));
  ok("the raw position is kept, so the correction stays inspectable",
    near(q.rawX, bx, 1e-9) && q.dx === 5);
  ok("an ungeoreferenced raster makes the zone a stated guess",
    placePhotos(metas, makeDEM(10, 10, 1, () => 0)).guessedZone === true);

  const g = markGeometry(50, 50, { mark: "circle", size: 4, bearing: 90 });
  ok("a circular mark is a true circle plus a bearing tick",
    g.circles.length === 1 && g.paths.length === 1);
  ok("a bearing of 90° points east", (() => {
    const p2 = g.paths[0];
    return p2[2] > p2[0] + 1 && near(p2[3], p2[1], 1e-6); })());
  ok("a bearing of 0° points north (up the sheet)", (() => {
    const n = markGeometry(0, 0, { size: 4, bearing: 0 }).paths[0];
    return n[3] > n[1] + 1 && near(n[2], n[0], 1e-6); })());
  ok("every mark shape produces geometry",
    ["circle", "square", "triangle", "cross", "diamond"]
      .every((mk) => { const r = markGeometry(0, 0, { mark: mk, size: 3 });
        return r.paths.length + r.circles.length > 0; }));
}

// ── symbols and halftone ─────────────────────────────────────────────────────
group("symbols and halftone");
{
  const frame = { nrows: 20, ncols: 20, cell: 1, originX: 0, originY: 20 };
  const grid = new Float32Array(400);
  for (let i = 0; i < 400; i++) grid[i] = i % 400 / 399;
  grid[10] = NaN;
  const sy = symbolField(grid, frame, { lo: 0, hi: 1, stride: 1 });
  ok("a cell with no answer gets no circle", sy.length === 399);
  ok("radius is linear in the value", (() => {
    const a = sy.find((s) => near(s.v, 0, 0.01)), b = sy.find((s) => near(s.v, 1, 0.01));
    return a && b && b.r > a.r * 5; })());
  ok("the largest circle just fills its sample spacing",
    Math.max(...sy.map((s) => s.r)) <= frame.cell / 2 + 1e-9);
  ok("stride is chosen from the grid", strideFor(2048, 2048, 40) > strideFor(256, 256, 40));
  // ⚠️ THE SAMPLE GRID BELONGS TO THE GROUND, NOT TO THE TILE. Measured before
  // the fix: two plates abutting exactly at northing 63 sampled on phases 0.5
  // and 2.5 of a 3 m stride, so their nearest rows of circles landed 1 m apart
  // where the spacing was 3 m — a doubled row down the join. Same defect the
  // hatch had, same remedy.
  const symFrame = (d) => ({ nrows: d.nrows, ncols: d.ncols, cell: d.cell,
    originX: d.originX, originY: d.originY });
  const symPhases = (dems, opts, axis, step) => {
    const vals = [];
    for (const d of dems) {
      for (const s of symbolField(d.z, symFrame(d), opts)) vals.push(axis === "y" ? s.y : s.x);
    }
    return new Set(vals.map((v) => +((((v % step) + step) % step)).toFixed(4)));
  };
  ok("abutting tiles of unequal size sample on one world ladder", (() => {
    const mk = (oy, h) => makeDEM(h, 40, 1, () => 60, { originX: 0, originY: oy });
    return symPhases([mk(100, 37), mk(63, 25)], { stride: 3 }, "y", 3).size === 1; })());
  ok("the same holds side by side, and on a real non-round UTM origin", (() => {
    const mk = (ox, w) => makeDEM(30, w, 1, () => 60, { originX: ox, originY: 30 });
    if (symPhases([mk(0, 23), mk(23, 31)], { stride: 3 }, "x", 3).size !== 1) return false;
    const utm = (ox) => makeDEM(40, 60, 0.5, () => 60,
      { originX: ox, originY: 7738140.75 });
    return symPhases([utm(654000.25), utm(654030.25)], { stride: 4 }, "x", 2).size === 1; })());
  ok("a tile samples exactly where the whole model would", (() => {
    const mk = (ox, w) => makeDEM(30, w, 1, () => 60, { originX: ox, originY: 30 });
    const xs = (d) => [...new Set(symbolField(d.z, symFrame(d), { stride: 3 })
      .map((s) => +s.x.toFixed(4)))].sort((a, b) => a - b);
    const inside = xs(mk(0, 90)).filter((v) => v > 30 && v < 60);
    return JSON.stringify(inside) === JSON.stringify(xs(mk(30, 30))); })());
  ok("the signed field inherits the world anchor from symbolField", (() => {
    const mk = (oy, h) => makeDEM(h, 40, 1, (c) => (c % 2 ? 2 : -2), { originX: 0, originY: oy });
    const ys = [];
    for (const d of [mk(100, 37), mk(63, 25)]) {
      const r2 = signedSymbolField(d.z, symFrame(d), { stride: 3 });
      for (const s of [...r2.plus, ...r2.minus]) ys.push(s.y);
    }
    return new Set(ys.map((v) => +(((v % 3) + 3) % 3).toFixed(4))).size === 1; })());
  const leg = symbolLegend(0, 8, { cell: 1, stride: 4 });
  ok("the legend uses round values, not round radii", (() => {
    if (leg.length < 2) return false;
    const step = leg[1].v - leg[0].v;
    const mag = Math.pow(10, Math.round(Math.log10(step)));
    return [1, 2, 2.5, 5, 10].some((k) => near(step, k * mag, 1e-9) || near(step, k * mag / 10, 1e-9));
  })(), `step ${leg.length > 1 ? leg[1].v - leg[0].v : "n/a"}`);
  ok("legend radii rise with the values", leg.every((e, i) => i === 0 || e.r > leg[i - 1].r));

  const dem = makeDEM(30, 30, 1, (c) => c * 0.5);
  const sl = slopeDegrees(dem);
  ok("a constant 1-in-2 ramp reads as 26.57°", near(sl[15 * 30 + 15], 26.565, 0.01));
  ok("slope is NaN at the border, where the window is incomplete", Number.isNaN(sl[0]));

  const img = { width: 64, height: 64, cell: 1, originX: 0, originY: 64, licence: "own",
    rgb: new Uint8ClampedArray(64 * 64 * 3) };
  for (let i = 0; i < 64 * 64; i++) {
    img.rgb[i * 3] = (i % 64) * 4; img.rgb[i * 3 + 1] = 128; img.rgb[i * 3 + 2] = 60;
  }
  const h = vectorHalftone(img, { across: 16, channel: "luminance" });
  ok("a halftone produces one circle per sample", h.symbols.length > 200 && h.symbols.length <= 256);
  ok("the budget counts the marks honestly", budget(180).marks === 32400 && !budget(180).ok);
  ok("a comfortable density is reported as such", budget(30).ok);
  const tri = tripleHalftone(img, { across: 12 });
  ok("a triple halftone is three coexisting layers", tri.layers.length === 3);
  ok("the triple's mark count is tripled in the budget",
    tri.budget.marks === 3 * tri.layers[0].symbols.length);
  ok("nested maxima keep the three circles distinguishable", (() => {
    const m = tri.layers.map((L) => Math.max(...L.symbols.map((s) => s.r)));
    return m[0] > m[1] && m[1] > m[2]; })());
  ok("derived channels are recommended and raw bands are not",
    CHANNELS.greenness.good && CHANNELS.luminance.good && !CHANNELS.red.good);

  let bit = false;
  try { assertExportable({ ...img, licence: "restricted", name: "nib.tif" }); } catch { bit = true; }
  ok("a restricted image cannot be exported", bit);
  let unk = false;
  try { assertExportable({ ...img, licence: "unknown" }); } catch { unk = true; }
  ok("an unmarked image cannot be exported either", unk);
  ok("an image of our own exports fine", (() => {
    try { assertExportable({ ...img, licence: "own" }); return true; } catch { return false; } })());
}

// ── the circle grid — a grading plan ─────────────────────────────────────────
// Change between two epochs drawn as circles: size is the magnitude, the sign
// picks the pass, and the pass is the form — a filled engraved dot is fill, an
// open scored ring is cut. These guard the properties a reader measures the
// drawing by: one scale for both directions, a dead zone in value units, and
// no circle clipped into a smaller-looking value at the sheet edge.
group("the circle grid — a grading plan");
{
  const frame = { nrows: 20, ncols: 20, cell: 2, originX: 0, originY: 40 };
  const grid = new Float32Array(400);
  // Left half fill (+), right half cut (−); magnitude grows southward 0 … 4.
  for (let r = 0; r < 20; r++) {
    for (let c = 0; c < 20; c++) grid[r * 20 + c] = (c < 10 ? 1 : -1) * (r * 4 / 19);
  }
  grid[5] = NaN;                                        // row 0, an unmeasured cell
  const f = signedSymbolField(grid, frame, { stride: 2, minFraction: 0.1, maxFraction: 1 });
  ok("the split is by sign alone", f.plus.every((s) => s.v > 0) && f.minus.every((s) => s.v < 0));
  ok("zero is not a sign — a cell that moved in no direction gets no circle",
    f.plus.length === 45 && f.minus.length === 45);      // row 0 is all zeros
  ok("the minus side keeps its negative value", f.minus.some((s) => s.v < -3));
  ok("full scale is the largest magnitude in the DATA, sampled or not",
    near(f.hi, 4, 1e-4));                                // row 19 holds it, and
                                                         // stride 2 never lands there
  ok("one normalisation: equal magnitudes are equal circles, whichever way the ground went",
    (() => {
      for (const p of f.plus) {
        const m = f.minus.find((q) => near(Math.abs(q.v), p.v, 1e-6));
        if (m) return near(m.r, p.r, 1e-9);
      }
      return false;
    })());
  const f2 = signedSymbolField(grid, frame, { stride: 2, minAbs: 2 });
  ok("the dead zone is in value units, not a fraction",
    f2.plus.length === 25 && f2.minus.length === 25);    // rows 10..18 only
  const f3 = signedSymbolField(grid, frame, { stride: 2, minFraction: 0, maxFraction: 1, hi: 2 * f.hi });
  ok("a pinned full scale rescales the whole field", (() => {
    const a = Math.max(...f.plus.map((s) => s.r));
    const b = Math.max(...f3.plus.map((s) => s.r));
    return near(b, a / 2, a * 0.15); })());
  ok("an all-NaN grid yields an empty field, not a throw", (() => {
    const g0 = new Float32Array(400).fill(NaN);
    const r0 = signedSymbolField(g0, frame, { stride: 2 });
    return r0.plus.length === 0 && r0.minus.length === 0 && r0.hi === 0; })());

  // Through the compiler: the sign lands on its pass, and everything stays on
  // the sheet.
  const dem = makeDEM(21, 21, 1, (c, r) => (c - 10) * 0.3, { name: "diff" });
  const spec = { dem, name: "test grid", signed: true, across: 10,
    minFraction: 0.1, maxFraction: 0.9,
    passPlus: "DLF-00_engrave", passMinus: "DLF-02_score_medium" };
  const noC = { contours: { enabled: false }, legend: false };
  const d = compile({ dem, sym: noC, symbols: [spec] });
  const on = (layer) => d.circles.filter((q) => q.layer === layer);
  const rep = d.report.symbols[0];
  ok("fill circles land on the engrave pass, cut circles on the score pass",
    on("DLF-00_engrave").length > 0 && on("DLF-02_score_medium").length > 0);
  ok("the report counts what was drawn",
    rep.plus === on("DLF-00_engrave").length && rep.minus === on("DLF-02_score_medium").length
    && rep.count === rep.plus + rep.minus);
  ok("every circle sits wholly on the sheet", d.circles.every((q) =>
    q.cx - q.r >= -1e-9 && q.cx + q.r <= d.sheet.width + 1e-9
    && q.cy - q.r >= -1e-9 && q.cy + q.r <= d.sheet.height + 1e-9));
  ok("no circle exceeds the declared largest diameter", d.circles.every((q) =>
    2 * q.r <= rep.largestMM + 0.05));
  ok("the cutting report names the grid and both passes", (() => {
    const t = reportText(d);
    return t.includes("circle grid") && t.includes("DLF-00_engrave")
      && t.includes("DLF-02_score_medium"); })());

  // ⚠️ The warning fires on the CONJUNCTION — same pass AND same symbol — because
  // the pass alone is a colour on screen and a power setting at the machine, not
  // a mark. One pass reads fine when one sign is hatched and the other is a ring.
  const dSame = compile({ dem, sym: noC, symbols: [{ ...spec,
    passMinus: "DLF-00_engrave", stylePlus: "outline", styleMinus: "outline" }] });
  ok("same pass AND same symbol is warned about — nothing would tell them apart",
    dSame.warnings.some((w) => /tell the two directions of change apart/.test(w)));
  const dCut = compile({ dem, sym: noC,
    symbols: [{ ...spec, passPlus: "DLF-04_cut_inner" }] });
  ok("circles on a cut pass are warned about — they cut discs out",
    dCut.warnings.some((w) => /CUT pass/.test(w)));
  const dU = compile({ dem, sym: noC, symbols: [{ ...spec, signed: false }] });
  ok("unsigned mode draws one set on the fill pass only",
    dU.circles.some((q) => q.layer === "DLF-00_engrave")
    && !dU.circles.some((q) => q.layer === "DLF-02_score_medium"));

  // A grid larger than the primary: circles beyond the sheet are dropped WHOLE
  // and counted — an arc of a value-circle would read as a smaller value.
  const big = makeDEM(60, 60, 1, () => 1, { name: "big" });
  const dBig = compile({ dem, sym: noC, symbols: [{ ...spec, dem: big, name: "big grid" }] });
  ok("circles that would cross the sheet edge are dropped whole and counted",
    dBig.report.symbols[0].dropped > 0 && dBig.report.symbols[0].count > 0
    && dBig.circles.every((q) =>
      q.cx - q.r >= -1e-9 && q.cx + q.r <= dBig.sheet.width + 1e-9
      && q.cy - q.r >= -1e-9 && q.cy + q.r <= dBig.sheet.height + 1e-9));

  // The legend: reference circles at round values, on the sheet, on the fill
  // pass, each with an engraved figure beneath it.
  const dL = compile({ dem, sym: { contours: { enabled: false } }, symbols: [spec] });
  ok("the legend adds circles beyond the field and stays on the sheet",
    dL.circles.length > d.circles.length && dL.circles.every((q) =>
      q.cx - q.r >= -1e-9 && q.cx + q.r <= dL.sheet.width + 1e-9
      && q.cy - q.r >= -1e-9 && q.cy + q.r <= dL.sheet.height + 1e-9));
  // ── cut and fill told apart by GEOMETRY, not by a pass setting ──────────
  // ⚠️ "Filled" used to be true only on screen: a circle on the engrave pass is
  // drawn solid by the preview and the SVG, but the DXF carries a CIRCLE — an
  // outline. Whether it comes out solid is a property of somebody's JobControl
  // setup. On a machine configured differently, cut and fill both arrive as
  // rings and the grading plan says nothing at all.
  ok("a hatched circle is filled with real chords", (() => {
    const c = hatchCircle(0, 0, 5, 1, { angleDeg: 0 });
    if (c.length < 5) return false;
    // Every chord lies inside the circle and is horizontal at angle 0.
    return c.every((p) => near(p[1], p[3], 1e-9)
      && Math.hypot(p[0], p[1]) <= 5 + 1e-9 && Math.hypot(p[2], p[3]) <= 5 + 1e-9); })());
  ok("the chords are centred, so the smallest symbol still gets its diameter", (() => {
    // A circle barely wider than one spacing must still carry a line.
    const c = hatchCircle(0, 0, 0.6, 1, { angleDeg: 0 });
    if (c.length !== 1) return false;
    return near(c[0][1], 0, 1e-9) && near(c[0][2] - c[0][0], 1.2, 1e-9); })());
  ok("the longest chord is the diameter and the rim ones are shorter", (() => {
    const c = hatchCircle(0, 0, 5, 1, { angleDeg: 0 });
    const lens = c.map((p) => Math.hypot(p[2] - p[0], p[3] - p[1]));
    return near(Math.max(...lens), 10, 1e-9) && Math.min(...lens) < Math.max(...lens); })());
  ok("a chord shorter than the minimum mark is never emitted — it is a dwell", (() => {
    const c = hatchCircle(0, 0, 5, 0.5, { angleDeg: 0, minLength: 4 });
    return c.every((p) => Math.hypot(p[2] - p[0], p[3] - p[1]) >= 4 - 1e-9); })());
  ok("the hatch angle turns the chords", (() => {
    const c = hatchCircle(0, 0, 5, 1, { angleDeg: 90 });
    return c.every((p) => near(p[0], p[2], 1e-9)); })());
  ok("a zero radius or zero spacing hatches to nothing rather than looping",
    hatchCircle(0, 0, 0, 1).length === 0 && hatchCircle(0, 0, 5, 0).length === 0);

  const gdem = makeDEM(21, 21, 1, (c) => (c - 10) * 0.5, { name: "cutfill" });
  const gsym = { contours: { enabled: false }, legend: false };
  ok("fill is hatched and cut is a bare ring, by default", (() => {
    const d = compile({ dem: gdem, sym: gsym, symbols: [{ dem: gdem, name: "g",
      signed: true, across: 8, passPlus: "DLF-02_score_medium",
      passMinus: "DLF-03_score_strong" }] });
    const r = d.report.symbols[0];
    if (r.stylePlus !== "hatched" || r.styleMinus !== "outline") return false;
    // The chords land on the FILL pass and nowhere else.
    const onPlus = d.paths.filter((p) => p.layer === "DLF-02_score_medium").length;
    const onMinus = d.paths.filter((p) => p.layer === "DLF-03_score_strong").length;
    return r.chords > 0 && onPlus >= r.chords && onMinus === 0; })());
  ok("every fill chord sits inside a circle of the same field", (() => {
    const d = compile({ dem: gdem, sym: gsym, symbols: [{ dem: gdem, name: "g",
      signed: true, across: 8, passPlus: "DLF-02_score_medium",
      passMinus: "DLF-03_score_strong" }] });
    const discs = d.circles.filter((c) => c.layer === "DLF-02_score_medium");
    return d.paths.filter((p) => p.layer === "DLF-02_score_medium").every((p) =>
      discs.some((c) => Math.hypot(p.pts[0] - c.cx, p.pts[1] - c.cy) <= c.r + 1e-6
        && Math.hypot(p.pts[2] - c.cx, p.pts[3] - c.cy) <= c.r + 1e-6)); })());
  ok("choosing outline for both leaves no chords at all", (() => {
    const d = compile({ dem: gdem, sym: gsym, symbols: [{ dem: gdem, name: "g", signed: true,
      across: 8, stylePlus: "outline", styleMinus: "outline",
      passPlus: "DLF-02_score_medium", passMinus: "DLF-03_score_strong" }] });
    return d.report.symbols[0].chords === 0; })());
  // ⚠️ THE COUNT ALWAYS REACHES THE READER; THE WARNING IS FOR WHEN IT IS A
  // PROBLEM. A warning that fires for every hatched grid can never not fire,
  // and trains a reader to ignore the panel that carries the ones that matter.
  ok("the fill-line count is always in the cutting report", (() => {
    const d = compile({ dem: gdem, sym: gsym, symbols: [{ dem: gdem, name: "g",
      signed: true, across: 8 }] });
    return d.report.symbols[0].chords > 0 && /fill lines at .* mm/.test(reportText(d)); })());
  ok("a light hatched grid raises no warning at all", (() => {
    const d = compile({ dem: gdem, sym: gsym, symbols: [{ dem: gdem, name: "g",
      signed: true, across: 6, hatchMM: 2.5 }] });
    return d.report.symbols[0].chords > 0
      && !d.warnings.some((w) => /fill lines at/.test(w)); })());
  ok("a heavy one does warn", (() => {
    const big = makeDEM(120, 120, 1, (c) => (c - 60) * 0.5, { name: "big" });
    const d = compile({ dem: big, sym: gsym, symbols: [{ dem: big, name: "g",
      signed: true, across: 40, hatchMM: 0.35 }] });
    return d.report.symbols[0].chords > 2000
      && d.warnings.some((w) => /fill lines at/.test(w)); })());
  // ⚠️ THE PASS IS A COLOUR ON SCREEN AND A POWER SETTING AT THE MACHINE — it
  // is not a mark. Two signs on one pass read fine when one is hatched.
  ok("one pass for both signs is fine when the symbols differ", (() => {
    const d = compile({ dem: gdem, sym: gsym, symbols: [{ dem: gdem, name: "g", signed: true,
      across: 8, passPlus: "DLF-02_score_medium", passMinus: "DLF-02_score_medium" }] });
    return !d.warnings.some((w) => /tell the two directions of change apart/.test(w)); })());
  ok("same pass AND same symbol is warned about — nothing would tell them apart", (() => {
    const d = compile({ dem: gdem, sym: gsym, symbols: [{ dem: gdem, name: "g", signed: true,
      across: 8, stylePlus: "outline", styleMinus: "outline",
      passPlus: "DLF-02_score_medium", passMinus: "DLF-02_score_medium" }] });
    return d.warnings.some((w) => /tell the two directions of change apart/.test(w)); })());
  // ⚠️ THE FILL IS ADDED GEOMETRY, NOT A CHANGE OF SYMBOL SIZE. If hatching
  // moved a radius even slightly, a hatched fill circle and an outlined cut
  // circle of the same magnitude would no longer measure the same against the
  // legend, and the one scale the grading plan depends on would be gone.
  ok("hatching adds chords and leaves every radius exactly as it was", (() => {
    const base = { dem: gdem, name: "g", signed: true, across: 8,
      passPlus: "DLF-02_score_medium", passMinus: "DLF-03_score_strong" };
    const plain = compile({ dem: gdem, sym: gsym,
      symbols: [{ ...base, stylePlus: "outline", styleMinus: "outline" }] });
    const hatched = compile({ dem: gdem, sym: gsym, symbols: [base] });
    const key = (d) => d.circles.map((c) =>
      `${c.cx.toFixed(6)},${c.cy.toFixed(6)},${c.r.toFixed(6)},${c.layer}`).join("|");
    return key(plain) === key(hatched) && hatched.report.symbols[0].chords > 0
      && plain.report.symbols[0].chords === 0; })());

  ok("an empty field is said plainly", (() => {
    const z = makeDEM(21, 21, 1, () => 0, { name: "flat" });
    const d0 = compile({ dem, sym: noC, symbols: [{ ...spec, dem: z, name: "flat grid" }] });
    return d0.warnings.some((w) => /no circles/.test(w)); })());
}

// ── terrain indices — ruggedness, roughness, wetness ─────────────────────────
// ⚠️ EACH ONE ASSERTS ITS PUBLISHED DEFINITION ON GROUND WHOSE ANSWER IS KNOWN
// BY HAND. "Ruggedness" and "the wetness index" are each several different
// numbers in the wild, and the only defence against drifting from
// DL-TerrainDiversity — which computes its own — is to pin the arithmetic.
group("terrain indices — ruggedness, roughness, wetness");
{
  ok("flat ground is perfectly unrugged", (() => {
    const flat = makeDEM(20, 20, 1, () => 50);
    const t = ruggedness(flat), g = roughness(flat);
    return near(t[10 * 20 + 10], 0, 1e-9) && near(g[10 * 20 + 10], 0, 1e-9); })());
  // A 1-in-1 plane: each of the 8 neighbours differs by -1, 0 or +1 in x.
  // Riley's TRI is sqrt(sum of squares) = sqrt(3*1 + 2*0 + 3*1) = sqrt(6).
  ok("TRI is Riley's root-sum-of-squares, not the mean absolute difference", (() => {
    const ramp = makeDEM(20, 20, 1, (c) => c);
    const t = ruggedness(ramp)[10 * 20 + 10];
    return near(t, Math.sqrt(6), 1e-6); })());
  ok("roughness is the 3x3 range — a different number on the same ground", (() => {
    const ramp = makeDEM(20, 20, 1, (c) => c);
    const g = roughness(ramp)[10 * 20 + 10];
    return near(g, 2, 1e-9) && !near(g, Math.sqrt(6), 1e-6); })());
  ok("ruggedness rises with the relief", (() => {
    const gentle = ruggedness(makeDEM(20, 20, 1, (c) => c * 0.1))[10 * 20 + 10];
    const steep = ruggedness(makeDEM(20, 20, 1, (c) => c * 5))[10 * 20 + 10];
    return steep > gentle * 10; })());
  ok("both are NaN at the border, where the window is incomplete", (() => {
    const ramp = makeDEM(20, 20, 1, (c) => c);
    return Number.isNaN(ruggedness(ramp)[0]) && Number.isNaN(roughness(ramp)[0]); })());
  // ⚠️ A PARTIAL SUM OVER THE NEIGHBOURS THAT HAPPEN TO EXIST would be
  // systematically smaller, drawing a calm edge around every hole in the survey.
  ok("nodata anywhere in the window gives NaN, never a partial sum", (() => {
    const holed = makeDEM(20, 20, 1, (c, r) => (c === 11 && r === 11 ? NaN : c));
    return Number.isNaN(ruggedness(holed)[10 * 20 + 10])
      && Number.isNaN(roughness(holed)[10 * 20 + 10]); })());

  // ── depressions ──
  // ⚠️ WITHOUT FILLING, FLOW ACCUMULATION STOPS AT EVERY PIT, and the wetness
  // index shows DRY ground exactly where a hollow is — the opposite of true.
  const pitted = makeDEM(21, 21, 1, (c, r) => {
    if (c === 10 && r === 10) return 40;            // a one-cell pit
    return 50 + c * 0.1;
  });
  ok("a one-cell pit is filled to its lowest outlet", (() => {
    const f = fillDepressions(pitted);
    const at = f[10 * 21 + 10];
    // Raised out of the hole, and no higher than the rim around it.
    return at > 45 && at <= 51.1 + 1e-6; })());
  ok("filling never lowers the ground", (() => {
    const f = fillDepressions(pitted);
    for (let i = 0; i < f.length; i++) {
      if (Number.isFinite(pitted.z[i]) && f[i] < pitted.z[i] - 1e-6) return false;
    }
    return true; })());
  ok("ground with no pits comes back unchanged", (() => {
    const ramp = makeDEM(20, 20, 1, (c) => 50 + c);
    const f = fillDepressions(ramp);
    for (let i = 0; i < f.length; i++) if (!near(f[i], ramp.z[i], 1e-6)) return false;
    return true; })());
  ok("nodata is preserved through the fill, not flooded over", (() => {
    const holed = makeDEM(20, 20, 1, (c, r) => (r === 5 ? NaN : 50 + c));
    const f = fillDepressions(holed);
    return Number.isNaN(f[5 * 20 + 10]) && Number.isFinite(f[6 * 20 + 10]); })());

  // ── flow ──
  const slope1 = makeDEM(30, 30, 1, (c, r) => 100 - r);          // drains south
  ok("every cell starts with its own area and gains from upslope", (() => {
    const f = fillDepressions(slope1);
    const a = flowAccumulation(slope1, f);
    // Row 1 has only itself; a row far down has many rows above it.
    return a[1 * 30 + 15] < a[25 * 30 + 15] / 5; })());
  ok("accumulation grows monotonically down a uniform slope", (() => {
    const f = fillDepressions(slope1);
    const a = flowAccumulation(slope1, f);
    for (let r = 3; r < 26; r++) {
      if (!(a[r * 30 + 15] >= a[(r - 1) * 30 + 15] - 1e-6)) return false;
    }
    return true; })());
  // ⚠️ MULTIPLE FLOW, NOT D8. D8 puts everything in one-cell threads with
  // nothing beside them — a picture of an algorithm, not of a hillside.
  ok("flow spreads across a hillside instead of forming one-cell threads", (() => {
    const f = fillDepressions(slope1);
    const a = flowAccumulation(slope1, f);
    const row = [];
    for (let c = 5; c < 25; c++) row.push(a[20 * 30 + c]);
    // On a uniform planar slope every column should carry a similar load.
    return Math.max(...row) < Math.min(...row) * 3; })());

  // ── TWI ──
  ok("the wetness index is finite everywhere it is defined", (() => {
    const w = wetnessIndex(slope1);
    for (let r = 1; r < 29; r++) {
      for (let c = 1; c < 29; c++) {
        const v = w[r * 30 + c];
        if (!Number.isFinite(v)) return false;
      }
    }
    return true; })());
  // ⚠️ THE SLOPE IS FLOORED, NOT THE INDEX — flat ground must land at the TOP
  // of the range, not at an infinity that flattens every other value against
  // the bottom of the scale.
  ok("dead flat ground is the wettest, and still a finite number", (() => {
    // A slope that runs into a flat bench at the bottom.
    const bench = makeDEM(40, 30, 1, (c, r) => (r < 25 ? 100 - r : 75));
    const w = wetnessIndex(bench);
    const onSlope = w[10 * 30 + 15], onBench = w[32 * 30 + 15];
    return Number.isFinite(onBench) && onBench > onSlope; })());
  ok("a hollow is wetter than the shoulder above it", (() => {
    // A valley running north-south down the middle.
    const valley = makeDEM(40, 40, 1, (c, r) => 100 - r * 0.5 + Math.abs(c - 20) * 0.3);
    const w = wetnessIndex(valley);
    return w[30 * 40 + 20] > w[30 * 40 + 6]; })());
  ok("steeper ground is drier than gentler ground with the same catchment", (() => {
    const gentle = wetnessIndex(makeDEM(30, 30, 1, (c, r) => 100 - r * 0.2));
    const steep = wetnessIndex(makeDEM(30, 30, 1, (c, r) => 100 - r * 5));
    return gentle[20 * 30 + 15] > steep[20 * 30 + 15]; })());
  ok("a pit does not read as dry — the fill happened first", (() => {
    const w = wetnessIndex(pitted);
    return Number.isFinite(w[10 * 21 + 10]); })());

  // ⚠️ AN INDEX DRAWN WITHOUT ITS DEFINITION IS A PICTURE.
  ok("every index states its definition, and TWI states its flow algorithm",
    /Riley/.test(indexNote("tri")) && /range/.test(indexNote("roughness"))
    && /Horn/.test(indexNote("slope"))
    && /Freeman/.test(indexNote("twi")) && /not comparable/i.test(indexNote("twi")));

  // Through the compiler: an index is just a raster, so every translation works.
  const dIdx = compile({ dem: slope1, sym: { contours: { enabled: false }, legend: false },
    symbols: [{ dem: { ...slope1, z: ruggedness(slope1) }, name: "tri", signed: false,
      across: 8 }] });
  ok("a derived surface drives the circle grid like any other raster",
    dIdx.report.symbols[0].count > 0);
}

// ── hatching — the value as line density ─────────────────────────────────────
// ⚠️ THE DASH COUNT IS THE JOB. Rule 1 of this project was written because
// ~3,700 dashes once stood in for 55 continuous paths; a hatch is a dash
// factory by construction, so these checks guard the merging of full-density
// runs and the refusal of sub-kerf runts above everything else.
group("hatching — the value as line density");
{
  const ramp = makeDEM(40, 40, 1, (c) => c / 39, { name: "ramp" });
  const h = hatchField(ramp, { spacing: 4, step: 2, angleDeg: 0, minMark: 0 });
  ok("a hatch produces marks and knows its own range",
    h.marks > 0 && near(h.lo, 0, 1e-6) && near(h.hi, 1, 1e-6));
  ok("the lines are parallel and evenly spaced", (() => {
    const ys = [...new Set(h.paths.map((p) => +p[1].toFixed(6)))].sort((a, b) => a - b);
    if (ys.length < 3) return false;
    const d0 = ys[1] - ys[0];
    return ys.every((y, i) => i === 0 || near(y - ys[i - 1], d0, 1e-6)); })());
  ok("ink follows the value: the strong end carries more than the weak end", (() => {
    let lowInk = 0, highInk = 0;
    for (const p of h.paths) {
      const len = Math.hypot(p[2] - p[0], p[3] - p[1]);
      const midX = (p[0] + p[2]) / 2;
      if (midX < 20) lowInk += len; else highInk += len;
    }
    return highInk > lowInk * 2; })());
  ok("a full-density run leaves as ONE path, not as step-sized pieces", (() => {
    const solid = makeDEM(40, 40, 1, () => 1, { name: "solid" });
    const s = hatchField(solid, { spacing: 4, step: 2, angleDeg: 0, minMark: 0 });
    // 40 m of ground at step 2 would be 20 pieces per line if unmerged. A
    // scanline that falls exactly on the raster's edge samples nothing and
    // rightly emits nothing, so marks may be fewer than lines — never more.
    return s.marks > 0 && s.marks <= s.lines
      && s.paths.every((p) => Math.hypot(p[2] - p[0], p[3] - p[1]) > 30);
  })());
  ok("a runt shorter than the minimum mark is never emitted", (() => {
    const r = hatchField(ramp, { spacing: 4, step: 2, angleDeg: 0, minMark: 0.5 });
    return r.paths.every((p) => Math.hypot(p[2] - p[0], p[3] - p[1]) >= 0.5 - 1e-9); })());
  ok("nodata gets no ink and is counted, not drawn as weak", (() => {
    const holed = makeDEM(40, 40, 1, (c, r2) => (c > 15 && c < 25 ? NaN : 1), { name: "holed" });
    const g2 = hatchField(holed, { spacing: 4, step: 2, angleDeg: 0, minMark: 0 });
    if (!g2.unmeasured) return false;
    // No mark may sit inside the hole.
    return g2.paths.every((p) => !((p[0] > 16 && p[0] < 24) || (p[2] > 16 && p[2] < 24)));
  })());
  ok("inverting puts the ink on the low values instead", (() => {
    const inv = hatchField(ramp, { spacing: 4, step: 2, angleDeg: 0, minMark: 0, invert: true });
    let lowInk = 0, highInk = 0;
    for (const p of inv.paths) {
      const len = Math.hypot(p[2] - p[0], p[3] - p[1]);
      if ((p[0] + p[2]) / 2 < 20) lowInk += len; else highInk += len;
    }
    return lowInk > highInk * 2; })());
  ok("a floor leaves the weak ground bare", (() => {
    const f = hatchField(ramp, { spacing: 4, step: 2, angleDeg: 0, minMark: 0, floor: 0.5 });
    return f.paths.every((p) => (p[0] + p[2]) / 2 > 17); })());
  ok("the angle turns the lines", (() => {
    const a = hatchField(ramp, { spacing: 4, step: 2, angleDeg: 90, minMark: 0 });
    return a.paths.every((p) => near(p[0], p[2], 1e-6)); })());
  // ⚠️ THE HATCH MUST REACH THE DECLARED EDGE. Marc's plates abut, so ink that
  // stops short leaves a white band down every seam of the assembled model.
  // Measured before the fix: 0.76 m short on a 40 m tile — about 4 mm of blank
  // paper at 1:200, at every edge. Same failure class as the half-cell contour
  // inset, and it gets the same remedy: sample by edge replication, clip back.
  ok("a solid field hatches right up to all four edges", (() => {
    const solid = makeDEM(40, 40, 1, () => 60, { originX: 0, originY: 40 });
    for (const ang of [0, 45, 90, 30]) {
      const s = hatchField(solid, { spacing: 2, step: 2, angleDeg: ang, minMark: 0 });
      let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (const p of s.paths) {
        for (let i = 0; i < p.length; i += 2) {
          lo[0] = Math.min(lo[0], p[i]); hi[0] = Math.max(hi[0], p[i]);
          lo[1] = Math.min(lo[1], p[i + 1]); hi[1] = Math.max(hi[1], p[i + 1]);
        }
      }
      if (!near(lo[0], 0, 0.01) || !near(hi[0], 40, 0.01)) return false;
      if (!near(lo[1], 0, 0.01) || !near(hi[1], 40, 0.01)) return false;
    }
    return true; })());
  ok("no ink is ever drawn outside the raster's own extent", (() => {
    const solid = makeDEM(30, 30, 1, () => 60, { originX: 500, originY: 730 });
    const s = hatchField(solid, { spacing: 2, step: 2, angleDeg: 37, minMark: 0 });
    return s.paths.every((p) => {
      for (let i = 0; i < p.length; i += 2) {
        if (p[i] < 500 - 1e-6 || p[i] > 530 + 1e-6) return false;
        if (p[i + 1] < 700 - 1e-6 || p[i + 1] > 730 + 1e-6) return false;
      }
      return true; }); })());
  // ⚠️ THE PHASE BELONGS TO THE GROUND, NOT TO THE TILE. Two plates that abut
  // exactly must hatch on ONE ladder, or the seam shows a doubled line on one
  // side and a widened gap on the other. Measured before the fix: offsets 2.5
  // and 0.5 of a 3 m spacing, from a 37-row tile above a 25-row tile.
  ok("abutting tiles of unequal size hatch on one world ladder", (() => {
    const mk = (oy, h) => makeDEM(h, 40, 1, () => 60, { originX: 0, originY: oy });
    const opt2 = { spacing: 3, step: 3, angleDeg: 0, minMark: 0 };
    const ys = (r2) => [...new Set(r2.paths.map((p) => +p[1].toFixed(4)))];
    const both = [...ys(hatchField(mk(100, 37), opt2)), ...ys(hatchField(mk(63, 25), opt2))];
    const phases = new Set(both.map((v) => +(((v % 3) + 3) % 3).toFixed(4)));
    return phases.size === 1; })());
  ok("a tile hatches exactly as the whole model does over the same ground", (() => {
    const mk = (ox, w) => makeDEM(30, w, 1, () => 60, { originX: ox, originY: 30 });
    const opt2 = { spacing: 3, step: 3, angleDeg: 0, minMark: 0 };
    const ys = (r2) => [...new Set(r2.paths.map((p) => +p[1].toFixed(4)))].sort((a2, b2) => a2 - b2);
    return JSON.stringify(ys(hatchField(mk(0, 90), opt2)))
        === JSON.stringify(ys(hatchField(mk(30, 30), opt2))); })());
  ok("an all-NaN raster hatches to nothing rather than throwing", (() => {
    const none = makeDEM(20, 20, 1, () => NaN, { name: "none" });
    const n2 = hatchField(none, { spacing: 4 });
    return n2.marks === 0 && n2.paths.length === 0; })());

  // Through the compiler.
  const dH = compile({ dem: ramp, sym: { contours: { enabled: false }, legend: false },
    hatches: [{ dem: ramp, name: "slope hatch", spacingMM: 3, angleDeg: 0,
      pass: "DLF-01_score_light" }] });
  const hr = dH.report.hatches[0];
  ok("the compiler places a hatch on its pass and counts it",
    hr.marks > 0 && dH.paths.filter((p) => p.layer === "DLF-01_score_light").length >= hr.marks);
  ok("every hatch mark lands on the sheet", dH.paths.every((p) => {
    for (let i = 0; i < p.pts.length; i += 2) {
      if (p.pts[i] < -1e-9 || p.pts[i] > dH.sheet.width + 1e-9) return false;
      if (p.pts[i + 1] < -1e-9 || p.pts[i + 1] > dH.sheet.height + 1e-9) return false;
    }
    return true; }));
  ok("the cutting report states the hatch as a mark count",
    /hatch "slope hatch": \d+ marks/.test(reportText(dH)));
  const dHC = compile({ dem: ramp, sym: { contours: { enabled: false }, legend: false },
    hatches: [{ dem: ramp, name: "cut hatch", spacingMM: 3, pass: "DLF-04_cut_inner" }] });
  ok("hatching on a cut pass is warned about — it cuts slits",
    dHC.warnings.some((w) => /CUT pass/.test(w)));
}

// ── hachures — strokes down the fall line ────────────────────────────────────
// ⚠️ THE DIRECTION IS THE WHOLE THING. A hachure pointing uphill turns a hill
// into a hollow and there is no other symptom on the drawing, so the first
// checks here are all about which way the tick points on ground whose shape
// the test itself decides.
group("hachures — strokes down the fall line");
{
  // Ground rising to the EAST: z grows with the column, so downhill is WEST.
  const east = makeDEM(40, 40, 1, (c) => 50 + c * 0.5, { name: "rising east" });
  const f = fallLine(east, east.originX + 20, east.originY - 20);
  ok("the fall line points downhill, away from the rising ground",
    f && near(f.dx, -1, 1e-6) && near(f.dy, 0, 1e-6));
  ok("the fall line reports the true gradient", f && near(f.slope, 0.5, 1e-6));
  ok("dead flat has no fall line at all", (() => {
    const flat = makeDEM(20, 20, 1, () => 50, { name: "flat" });
    return fallLine(flat, flat.originX + 10, flat.originY - 10) === null; })());
  ok("nodata in the stencil gives no answer rather than an invented one", (() => {
    const holed = makeDEM(20, 20, 1, (c, r) => (c === 10 ? NaN : 50 + c), { name: "holed" });
    return fallLine(holed, holed.originX + 10.5, holed.originY - 10.5) === null; })());

  const lines = traceContours(east, 2, { indexEvery: 5 });
  const h = hachureLines(east, lines, { spacing: 3, minLength: 0.5, maxLength: 2 });
  ok("hachures are hung off the contours and every tick is a real two-point path",
    h.drawn > 0 && h.ticks.every((t) => t.length === 4));
  ok("no tick is zero length — a pierce with no travel", h.ticks.every((t) =>
    Math.hypot(t[2] - t[0], t[3] - t[1]) > 1e-9));
  ok("every tick runs downhill, west, on ground that rises east",
    h.ticks.every((t) => t[2] < t[0] - 1e-9 && near(t[3], t[1], 1e-6)));
  ok("uphill reverses every tick", (() => {
    const u = hachureLines(east, lines, { spacing: 3, minLength: 0.5, maxLength: 2, uphill: true });
    return u.ticks.every((t) => t[2] > t[0] + 1e-9); })());
  ok("no tick is longer than the longest allowed", h.ticks.every((t) =>
    Math.hypot(t[2] - t[0], t[3] - t[1]) <= 2 + 1e-9));
  ok("length follows steepness, and a fixed run makes them all equal", (() => {
    // A ramp that steepens eastward, so ticks should grow eastward.
    const steep = makeDEM(40, 40, 1, (c) => 50 + c * c * 0.02, { name: "steepening" });
    const sl = traceContours(steep, 2);
    const v = hachureLines(steep, sl, { spacing: 3, minLength: 0.4, maxLength: 3 });
    const lenAt = (west) => {
      const t = v.ticks.filter((q) => west ? q[0] < steep.originX + 12
                                           : q[0] > steep.originX + 28);
      return t.length ? t.reduce((a, q) => a + Math.hypot(q[2] - q[0], q[3] - q[1]), 0) / t.length : 0;
    };
    if (!(lenAt(false) > lenAt(true) * 1.4)) return false;
    const fx = hachureLines(steep, sl, { spacing: 3, minLength: 0.4, maxLength: 3, fixed: true });
    const lens = fx.ticks.map((q) => +Math.hypot(q[2] - q[0], q[3] - q[1]).toFixed(9));
    return new Set(lens).size === 1 && near(lens[0], 3, 1e-9); })());
  ok("a minimum slope leaves gentle ground bare", (() => {
    const gentle = hachureLines(east, lines, { spacing: 3, maxLength: 2, minSlope: 0.9 });
    return gentle.drawn === 0 && gentle.skipped > 0; })());
  ok("spacing is walked by arc length, so a rough contour is not crowded", (() => {
    const wide = hachureLines(east, lines, { spacing: 12, minLength: 0.5, maxLength: 2 });
    return wide.drawn > 0 && wide.drawn < h.drawn / 2; })());

  // Through the compiler.
  const dK = compile({ dem: east, sym: { legend: false, contours: {
    interval: 2, labels: false, style: "solid",
    hachures: { enabled: true, spacingMM: 4, minMM: 0.5, maxMM: 2,
      pass: "DLF-01_score_light" } } } });
  const kr = dK.report.contours.hachures;
  ok("the compiler draws hachures on their own pass and counts them",
    kr && kr.drawn > 0
    && dK.paths.filter((p) => p.layer === "DLF-01_score_light").length >= kr.drawn);
  ok("hachures land on the sheet", dK.paths.every((p) => {
    for (let i = 0; i < p.pts.length; i += 2) {
      if (p.pts[i] < -1e-9 || p.pts[i] > dK.sheet.width + 1e-9) return false;
      if (p.pts[i + 1] < -1e-9 || p.pts[i + 1] > dK.sheet.height + 1e-9) return false;
    }
    return true; }));
  ok("the cutting report states the hachure count and the direction",
    /HACHURES: \d+ ticks/.test(reportText(dK)) && /pointing downhill/.test(reportText(dK)));
  ok("pointing them uphill is warned about", (() => {
    const dU = compile({ dem: east, sym: { legend: false, contours: { interval: 2,
      labels: false, hachures: { enabled: true, spacingMM: 4, uphill: true } } } });
    return dU.warnings.some((w) => /pointing UPHILL/.test(w)); })());
  ok("index-only draws far fewer ticks than every contour", (() => {
    const dI = compile({ dem: east, sym: { legend: false, contours: { interval: 2,
      indexEvery: 5, labels: false,
      hachures: { enabled: true, spacingMM: 4, indexOnly: true } } } });
    return dI.report.contours.hachures.drawn < kr.drawn / 2; })());
}

// ── the one-drawing rule, guarded at the source ──────────────────────────────
// ⚠️ THIS IS THE ONE CHECK IN THE SUITE THAT READS CODE RATHER THAN RUNNING IT,
// and it earns its place because the bug it guards has now shipped TWICE.
//
// Bug 17 was `expDXF` compiling the primary raster only while the preview used
// the layer list, so every multi-raster DXF silently held one surface. It was
// fixed. Then the export handlers went on hand-building their own input object,
// and each translation added afterwards had to be remembered in three places.
// It was not: the circle grid, the hatching, the sections and the clip boundary
// were ALL missing from every exported file — a clipped drawing previewed
// clipped and exported whole.
//
// The property is not "the code looks a certain way". It is: EVERY ROUTE OUT OF
// THIS TOOL DRAWS THE SAME DRAWING. Nothing that runs in Node can observe that,
// because the drift lives in a browser-only module — so it is asserted where it
// can be: there is one builder, and every compile call uses it.
group("the one-drawing rule, guarded at the source");
{
  const appPath = fileURLToPath(new URL("../static/app.js", import.meta.url));
  const src = readFileSync(appPath, "utf8");
  const calls = [...src.matchAll(/\bcompile\s*\(/g)].map((m) => {
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
    return after.replace(/\s+/g, " ").trim();
  });
  ok("app.js compiles in more than one place — the preview and the writers",
    calls.length >= 2, `${calls.length} call(s)`);
  ok("every compile() in app.js is handed compileInput(), never a hand-built object",
    calls.every((a) => a.startsWith("compileInput(")),
    calls.filter((a) => !a.startsWith("compileInput(")).join(" | ") || "all ok");
  ok("compileInput carries every translation, so none can be dropped on the way out",
    (() => {
      const body = src.slice(src.indexOf("function compileInput"));
      const end = body.indexOf("\n}");
      const fn = body.slice(0, end);
      return ["layers", "photos", "regions", "symbols", "hatches", "sections",
        "clip", "image", "sym", "forExport"].every((k) => fn.includes(k + ":"));
    })());
  ok("only the export routes set forExport, so the preview can still show a restricted image",
    /forExport:\s*!!forExport/.test(src) && !/forExport:\s*true/.test(src));

  // ⚠️ AND THE SAME PROPERTY FOR HOW WIDE A BURN IS DRAWN. The preview, the SVG
  // and the PNG each decide what an engrave-pass stroke LOOKS like, and every
  // solid this tool makes is strokes close enough to merge — so if the three
  // disagree about that width, one shows stripes where another shows a solid,
  // and the preview is lying again. Three renderers, one constant.
  //
  // Nothing in Node can observe a canvas, so this is asserted where it can be:
  // all three must import BURN_MM, and the line where each branches on the
  // engrave pass must name it rather than a number of its own.
  const RENDERERS = ["../static/app.js", "../static/svg.js", "../static/raster.js"];
  const rendererUsesBurn = (rel) => {
    const t = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    if (!/import\s*\{[^}]*\bBURN_MM\b[^}]*\}\s*from\s*"\.\/patterns\.js"/.test(t)) return false;
    const lines = t.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('"DLF-00_engrave"')) continue;
      const window = lines.slice(i, i + 3).join(" ");
      if (/lineWidth|stroke-width|const w =|\? Math\.max/.test(window)) {
        if (!window.includes("BURN_MM")) return false;
      }
    }
    return true;
  };
  ok("all three renderers take the engrave width from BURN_MM, and none from a literal",
    RENDERERS.every(rendererUsesBurn), RENDERERS.join(" "));
}

// ── shapefile — just enough to read a boundary ───────────────────────────────
// ⚠️ THE FORMAT MIXES ENDIANNESS INSIDE ONE FILE and that is the whole trap:
// the record headers are big-endian, every shape field little-endian. Reading
// it all one way gives a nonsense record count or coordinates near 1e-300,
// both of which look like a corrupt file rather than a wrong reader.
group("shapefile — just enough to read a boundary");
{
  const one = makeSHP([[rectCW(100, 200, 400, 500)]]);
  const r = readShapefile(one, { name: "tile.shp" });
  ok("a polygon shapefile parses to one ring", r.rings.length === 1 && r.shapes === 1);
  ok("the coordinates are read little-endian and land where they were written", (() => {
    const p = r.rings[0].pts;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
      y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
    }
    return near(x0, 100, 1e-9) && near(y0, 200, 1e-9)
      && near(x1, 400, 1e-9) && near(y1, 500, 1e-9); })());
  ok("the header bounding box is read too",
    near(r.bbox.x0, 100, 1e-9) && near(r.bbox.y1, 500, 1e-9));
  ok("the repeated closing vertex is dropped — it would be a zero-length segment",
    r.rings[0].pts.length / 2 === 4);
  // ⚠️ CLOCKWISE IS AN OUTER RING IN THIS FORMAT — the opposite of regions.js.
  ok("a clockwise ring is an outer, a counter-clockwise one is a hole", (() => {
    const donut = readShapefile(makeSHP([[rectCW(0, 0, 100, 100), rectCCW(30, 30, 70, 70)]]));
    return donut.rings.length === 2 && !donut.rings[0].hole && donut.rings[1].hole; })());
  ok("signed area is positive for counter-clockwise",
    signedArea2(Float64Array.from(rectCCW(0, 0, 10, 10))) > 0
    && signedArea2(Float64Array.from(rectCW(0, 0, 10, 10))) < 0);
  ok("a lone counter-clockwise ring is taken as the boundary, not as a hole", (() => {
    const s = readShapefile(makeSHP([[rectCCW(0, 0, 10, 10)]]));
    return s.rings.length === 1 && !s.rings[0].hole && s.notes.length > 0; })());
  ok("several shapes all contribute their rings", (() => {
    const two = readShapefile(makeSHP([[rectCW(0, 0, 10, 10)], [rectCW(20, 20, 30, 30)]]));
    return two.shapes === 2 && two.rings.length === 2; })());
  // ⚠️ THE NOTE MOVED TO THE CLIP HANDLER. The reader now serves two callers —
  // the boundary and drawn features — and "treated as a closed ring" is only
  // true for one of them. A polyline drawn as a FEATURE stays open.
  ok("a polyline shapefile reads as lines, and the reader adds no closure note", (() => {
    const pl = readShapefile(makeSHP([[rectCW(0, 0, 10, 10)]], { type: 3 }));
    return pl.kind === "line" && pl.rings.length === 1
      && !pl.notes.some((n) => /closed ring/.test(n)); })());
  // ⚠️ THE COMMONEST MISTAKE IS PICKING THE WRONG SIBLING FILE, and the error
  // has to name the fix rather than say "invalid".
  ok("a file without the shapefile signature is refused by name", (() => {
    try { readShapefile(makeSHP([[rectCW(0, 0, 10, 10)]], { badCode: true }), { name: "tile.dbf" }); }
    catch (e) { return /\.shp/.test(e.message) && /geometry/.test(e.message); }
    return false; })());
  ok("a file too short to hold a header is refused", (() => {
    try { readShapefile(new ArrayBuffer(40), { name: "x.shp" }); }
    catch (e) { return /100/.test(e.message); }
    return false; })());
  // ⚠️ POINTS ARE NO LONGER REFUSED AT THE READER. They are legitimate drawn
  // features (a survey of trees); only the CLIP boundary requires an area, and
  // that refusal now lives in the clip handler where the requirement is.
  ok("a point shapefile is read rather than refused", (() => {
    const r = readShapefile(makeSHP([[[5, 6]]], { type: 1 }));
    return r.kind === "point" && r.points.length === 1 && r.rings.length === 0; })());
  ok("a shape type the reader does not know is still refused by name", (() => {
    try { readShapefile(makeSHP([[rectCW(0, 0, 10, 10)]], { type: 31 })); }
    catch (e) { return /does not understand/.test(e.message); }
    return false; })());
  ok("polygonZ and polygonM parse like polygons", (() => {
    for (const t of [15, 25]) {
      const z = readShapefile(makeSHP([[rectCW(0, 0, 10, 10)]], { type: t }));
      if (z.rings.length !== 1) return false;
    }
    return true; })());
}

// ── clipping to a boundary ───────────────────────────────────────────────────
// The whole model is compiled and cut afterwards, so a tile boundary is a line
// drawn through one continuous field. ⚠️ The clip region may be CONCAVE, which
// is why Sutherland–Hodgman is not used here.
group("clipping to a boundary");
{
  const square = [{ pts: Float64Array.from([0, 0, 100, 0, 100, 100, 0, 100]), hole: false }];
  ok("inside and outside are told apart",
    pointInRings(50, 50, square) && !pointInRings(150, 50, square)
    && !pointInRings(50, -10, square));
  ok("a hole is subtracted", (() => {
    const donut = [square[0],
      { pts: Float64Array.from([40, 40, 60, 40, 60, 60, 40, 60]), hole: true }];
    return pointInRings(10, 10, donut) && !pointInRings(50, 50, donut); })());
  ok("a line crossing the boundary keeps only the part inside", (() => {
    const p = clipPathToRings(Float64Array.from([-50, 50, 150, 50]), false, square);
    if (p.length !== 1) return false;
    return near(p[0][0], 0, 1e-9) && near(p[0][2], 100, 1e-9); })());
  ok("a line wholly inside is untouched", (() => {
    const p = clipPathToRings(Float64Array.from([10, 10, 90, 90]), false, square);
    return p.length === 1 && near(p[0][0], 10, 1e-9) && near(p[0][3], 90, 1e-9); })());
  ok("a line wholly outside disappears",
    clipPathToRings(Float64Array.from([200, 200, 300, 300]), false, square).length === 0);
  // ⚠️ THE CASE SUTHERLAND–HODGMAN GETS WRONG: a concave region, where one
  // straight line must come back as TWO separate spans.
  ok("a line crossing a CONCAVE boundary comes back as two separate spans", (() => {
    // A U: two legs with a notch between them, open at the top.
    const u = [{ hole: false, pts: Float64Array.from(
      [0, 0, 100, 0, 100, 100, 70, 100, 70, 30, 30, 30, 30, 100, 0, 100]) }];
    const p = clipPathToRings(Float64Array.from([-10, 60, 110, 60]), false, u);
    if (p.length !== 2) return false;
    return near(p[0][0], 0, 1e-9) && near(p[0][2], 30, 1e-9)
      && near(p[1][0], 70, 1e-9) && near(p[1][2], 100, 1e-9); })());
  ok("a closed ring clipped open is no longer flagged closed", (() => {
    const d = clipDrawing(
      { paths: [{ pts: Float64Array.from([50, 50, 150, 50, 150, 150, 50, 150]),
                  layer: "DLF-02_score_medium", closed: true }], circles: [] },
      square);
    // ⚠️ Left flagged closed, the DXF writer would join the loose ends across
    // the boundary — a cut straight through the tile.
    return d.paths.length > 0 && d.paths.every((p) => p.closed === false); })());
  ok("a path wholly inside keeps its closed flag", (() => {
    const d = clipDrawing(
      { paths: [{ pts: Float64Array.from([10, 10, 20, 10, 20, 20, 10, 20]),
                  layer: "DLF-02_score_medium", closed: true }], circles: [] },
      square);
    return d.paths.length === 1 && d.paths[0].closed === true; })());
  // ⚠️ WHOLE OR NOT AT ALL — an arc reads as a smaller value than it stands for.
  ok("a circle straddling the boundary is dropped whole, not clipped to an arc", (() => {
    const d = clipDrawing({ paths: [], circles: [
      { cx: 50, cy: 50, r: 10, layer: "DLF-00_engrave" },     // inside
      { cx: 98, cy: 50, r: 10, layer: "DLF-00_engrave" },     // straddling
      { cx: 200, cy: 50, r: 5, layer: "DLF-00_engrave" },     // outside
    ] }, square);
    return d.circles.length === 1 && d.circles[0].cx === 50 && d.droppedCircles === 2; })());
  // ⚠️ THE EXEMPTION IS A TAG ON THE ENTITY, NEVER ITS LAYER. The light-score
  // pass carries the scale bar AND the default hatching, hachures, labels and
  // section lines — exempting by layer let a 16,000-mark hatch straight
  // through a clip untouched, and the drawing came back looking barely cut.
  ok("tagged furniture survives the clip — a half scale bar is not a scale bar", (() => {
    const d = clipDrawing({ paths: [
      { pts: Float64Array.from([-50, 50, 150, 50]), layer: "DLF-01_score_light",
        closed: false, furniture: true },
    ], circles: [] }, square, { keep: (e) => e.furniture === true });
    return d.paths.length === 1 && d.paths[0].pts.length === 4; })());
  ok("an untagged path on the SAME layer as furniture is still clipped", (() => {
    const d = clipDrawing({ paths: [
      { pts: Float64Array.from([-50, 50, 150, 50]), layer: "DLF-01_score_light", closed: false },
    ], circles: [] }, square, { keep: (e) => e.furniture === true });
    return d.paths.length === 1 && d.clippedPaths === 1
      && near(d.paths[0].pts[0], 0, 1e-9) && near(d.paths[0].pts[2], 100, 1e-9); })());
  // ⚠️ The same trap from the other side: a two-point mark crossing the
  // boundary returns two points, so a count-only "untouched" test declared it
  // whole and pushed back its ORIGINAL coordinates — ink straight out of the
  // tile, on a path the report counted as kept.
  ok("a clipped two-point mark keeps its CLIPPED coordinates, not its original ones", (() => {
    const d = clipDrawing({ paths: [
      { pts: Float64Array.from([-20, 50, 60, 50]), layer: "L", closed: false },
    ], circles: [] }, square);
    return d.paths.length === 1 && near(d.paths[0].pts[0], 0, 1e-9); })());
  ok("the bounding box of the rings is reported", (() => {
    const b = ringsBBox(square);
    return b.x0 === 0 && b.y0 === 0 && b.x1 === 100 && b.y1 === 100; })());

  // Through the compiler.
  const dem = makeDEM(60, 60, 1, (c, r2) => 50 + c * 0.3 + r2 * 0.1, { name: "ground" });
  const half = { rings: [{ hole: false,
    pts: Float64Array.from([0, 0, 30, 0, 30, 60, 0, 60]) }], name: "west half" };
  const full = compile({ dem, sym: { legend: false, contours: { interval: 2, labels: false } } });
  const cut = compile({ dem, sym: { legend: false, contours: { interval: 2, labels: false } },
    clip: half });
  ok("clipping removes geometry and reports what it removed", (() => {
    const cr = cut.report.clip;
    return cr && cr.applied && cut.paths.length < full.paths.length
      && (cr.droppedPaths > 0 || cr.clippedPaths > 0); })());
  ok("everything kept lies within the boundary", (() => {
    const w = cut.sheet.X(30);
    for (const p of cut.paths) {
      if (p.furniture) continue;                             // belongs to the plate
      for (let i = 0; i < p.pts.length; i += 2) {
        if (p.pts[i] > w + 0.01) return false;
      }
    }
    return true; })());
  // ⚠️ THE REGRESSION THAT SHIPPED FOR TEN MINUTES: hatching defaults to the
  // same pass as the sheet furniture, so a layer-based exemption spared the
  // whole hatch. Assert the clip actually bites on a hatch, by count.
  ok("a hatch on the furniture's own pass is still clipped, and heavily", (() => {
    const symH = { legend: false, contours: { enabled: false } };
    const hAll = compile({ dem, sym: symH,
      hatches: [{ dem, name: "h", spacingMM: 2, pass: "DLF-01_score_light" }] });
    const hCut = compile({ dem, sym: symH, clip: half,
      hatches: [{ dem, name: "h", spacingMM: 2, pass: "DLF-01_score_light" }] });
    const marks = (d) => d.paths.filter((p) => !p.furniture).length;
    // The boundary keeps the western half, so roughly half the marks must go.
    return marks(hAll) > 200 && marks(hCut) < marks(hAll) * 0.75; })());
  // ⚠️ A PLATE CANNOT HAVE TWO OUTER CUTS.
  ok("the boundary becomes the outer cut and the rectangle is not drawn", (() => {
    const outer = cut.paths.filter((p) => p.layer === "DLF-05_cut_outer");
    if (outer.length !== 1) return false;
    let x1 = -Infinity;
    for (let i = 0; i < outer[0].pts.length; i += 2) x1 = Math.max(x1, outer[0].pts[i]);
    return near(x1, cut.sheet.X(30), 0.01); })());
  ok("the cutting report names the clip", /clipped to "west half"/.test(reportText(cut)));
  ok("the preview and the file are the same object, so a clip previews clipped",
    toDXF(cut).counts.polyline <= cut.paths.length);
  // ⚠️ A BOUNDARY IN THE WRONG CRS CLIPS EVERYTHING AWAY AND THE EXPORT LOOKS
  // LIKE A BROKEN TOOL. Refused and said, never silently applied.
  ok("a boundary that misses the drawing is refused, not applied", (() => {
    const far = { name: "wrong CRS", rings: [{ hole: false,
      pts: Float64Array.from([9e5, 9e5, 9e5 + 10, 9e5, 9e5 + 10, 9e5 + 10, 9e5, 9e5 + 10]) }] };
    const d = compile({ dem, sym: { legend: false, contours: { interval: 2, labels: false } },
      clip: far });
    return d.report.clip.applied === false && d.paths.length === full.paths.length
      && d.warnings.some((w) => /does not overlap/.test(w)); })());
  // ⚠️ A refused clip must leave the plate its own outline, or the drawing
  // engraves perfectly and never comes free of the sheet.
  ok("a refused clip still leaves the sheet an outer cut", (() => {
    const far = { name: "wrong CRS", rings: [{ hole: false,
      pts: Float64Array.from([9e5, 9e5, 9e5 + 10, 9e5, 9e5 + 10, 9e5 + 10, 9e5, 9e5 + 10]) }] };
    const d = compile({ dem, sym: { legend: false, contours: { interval: 2, labels: false } },
      clip: far });
    return d.paths.filter((p) => p.layer === "DLF-05_cut_outer").length === 1; })());
  // ⚠️ FURNITURE BEYOND THE BOUNDARY IS ENGRAVED ON THE OFFCUT. The boundary
  // IS the outer cut, so a scale bar at the sheet's own corner is burn time
  // spent on scrap and a plate that reaches the bench with no scale on it.
  ok("the scale bar and north point move inside the clip boundary", (() => {
    const box = { name: "corner tile", rings: [{ hole: false,
      pts: Float64Array.from([0, 40, 25, 40, 25, 60, 0, 60]) }] };
    const d = compile({ dem, sym: { legend: false, contours: { enabled: false },
      sheet: { scaleBar: true, north: true } }, clip: box });
    const furn = d.paths.filter((p) => p.furniture);
    if (!furn.length) return false;
    // Every furniture vertex must sit inside the boundary, in sheet mm.
    const rings = [{ hole: false, pts: Float64Array.from([
      d.sheet.X(0), d.sheet.Y(40), d.sheet.X(25), d.sheet.Y(40),
      d.sheet.X(25), d.sheet.Y(60), d.sheet.X(0), d.sheet.Y(60)]) }];
    for (const p of furn) {
      for (let i = 0; i < p.pts.length; i += 2) {
        if (!pointInRings(p.pts[i], p.pts[i + 1], rings)) return false;
      }
    }
    return true; })());
  ok("without a clip the furniture still sits at the sheet's own corners", (() => {
    const d = compile({ dem, sym: { legend: false, contours: { enabled: false },
      sheet: { scaleBar: true, north: true } } });
    const furn = d.paths.filter((p) => p.furniture);
    let lo = Infinity;
    for (const p of furn) for (let i = 1; i < p.pts.length; i += 2) lo = Math.min(lo, p.pts[i]);
    return furn.length > 0 && lo < 8; })());
  ok("moving the furniture is stated, so nobody looks for it at the corner", (() => {
    const d = compile({ dem, sym: { legend: false, contours: { enabled: false } },
      clip: half });
    return d.warnings.some((w) => /placed inside the clip boundary/.test(w)); })());
  // ⚠️ THE BBOX CORNER OF AN ARBITRARY POLYGON IS ROUTINELY OUTSIDE THE SHAPE.
  // ⚠️ THE REAL CASE: a ragged boundary whose bbox corners are OUTSIDE it.
  // Placing at the corner alone dropped the scale bar, the north point and the
  // footer from a tile with plenty of room a few millimetres in.
  ok("on a ragged boundary the furniture is placed, not abandoned", (() => {
    const ragged = { name: "nw tile", rings: [{ hole: false, pts: Float64Array.from(
      [4, 56, 34, 58, 38, 34, 28, 10, 6, 12]) }] };
    const d = compile({ dem, sym: { legend: false, contours: { enabled: false },
      sheet: { scaleBar: true, north: true, title: "NW TILE" } }, clip: ragged });
    if (d.warnings.some((w) => /could not be placed/.test(w))) return false;
    const rings = [{ hole: false, pts: Float64Array.from([
      d.sheet.X(4), d.sheet.Y(56), d.sheet.X(34), d.sheet.Y(58),
      d.sheet.X(38), d.sheet.Y(34), d.sheet.X(28), d.sheet.Y(10),
      d.sheet.X(6), d.sheet.Y(12)]) }];
    const furn = d.paths.filter((p) => p.furniture);
    if (furn.length < 3) return false;
    for (const p of furn) {
      for (let i = 0; i < p.pts.length; i += 2) {
        if (!pointInRings(p.pts[i], p.pts[i + 1], rings)) return false;
      }
    }
    return true; })());
  // ⚠️ THE CAPTION MUST STAY WITH THE BAR IT DESCRIBES. Placed independently
  // they drift, and "50 M 1:200" three centimetres from its own bar is a
  // caption for nothing.
  ok("the footer stays with the scale bar it describes", (() => {
    const ragged = { name: "nw tile", rings: [{ hole: false, pts: Float64Array.from(
      [4, 56, 34, 58, 38, 34, 28, 10, 6, 12]) }] };
    const d = compile({ dem, sym: { legend: false, contours: { interval: 2, labels: false },
      sheet: { scaleBar: true, north: false, title: "" } }, clip: ragged });
    const furn = d.paths.filter((p) => p.furniture);
    let barY = Infinity, textY = -Infinity, barX = Infinity, textX = Infinity;
    for (const p of furn) {
      for (let i = 0; i < p.pts.length; i += 2) {
        // The bar is the long horizontal run; the caption sits above it.
        if (p.pts.length <= 6) { barY = Math.min(barY, p.pts[i + 1]); barX = Math.min(barX, p.pts[i]); }
        else { textY = Math.max(textY, p.pts[i + 1]); textX = Math.min(textX, p.pts[i]); }
      }
    }
    if (!Number.isFinite(barY) || textY === -Infinity) return true;   // nothing to compare
    return Math.abs(textX - barX) < 6 && textY - barY < 12; })());
  ok("furniture that cannot fit the boundary is dropped and NAMED, not hidden", (() => {
    // A narrow diagonal sliver: its bounding box corners are well outside it.
    const wedge = { name: "wedge", rings: [{ hole: false,
      pts: Float64Array.from([0, 60, 4, 60, 60, 4, 60, 0]) }] };
    const d = compile({ dem, sym: { legend: false, contours: { enabled: false },
      sheet: { scaleBar: true, north: true, title: "TILE" } }, clip: wedge });
    return d.warnings.some((w) => /could not be placed inside the boundary/.test(w)); })());
  ok("a clip that removes everything says so rather than writing a hollow file", (() => {
    // Inside the sheet, over ground the drawing has nothing on: contours off,
    // furniture off, so only the boundary outline could survive.
    const tiny = { name: "sliver", rings: [{ hole: false,
      pts: Float64Array.from([1, 1, 2, 1, 2, 2, 1, 2]) }] };
    const d = compile({ dem, sym: { legend: false, contours: { enabled: false },
      sheet: { scaleBar: false, north: false, title: "" } }, clip: tiny });
    return d.warnings.some((w) => /NOTHING SURVIVED THE CLIP/.test(w)); })());
}

// ── shapefile features: points, lines, areas, and 24 fills ───────────────────
// ⚠️ PORTED FROM DL-TerrainSlicer AND CHECKED AGAINST IT. The two tools share a
// bed and a pass scheme; a bed hatched in one and then the other must come out
// the same, so the ported constants are asserted rather than trusted.
group("shapefile features: points, lines, areas, and 24 fills");
{
  const tracer = { traceContours };
  const sq = () => [{ pts: Float64Array.from([0, 0, 40, 0, 40, 40, 0, 40]), hole: false }];
  const inBox = (strokes, pad = 0.7) => strokes.every((p) => {
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < -pad || p[i] > 40 + pad || p[i + 1] < -pad || p[i + 1] > 40 + pad) return false;
    }
    return true;
  });

  // ⚠️ EVERY pattern, not a sample. A family that silently returns nothing is a
  // menu entry that draws an empty bed at the machine.
  ok("all 24 fill patterns produce strokes, and none escape the region", (() => {
    for (const key of Object.keys(FILL_PATTERNS)) {
      const f = fillRegion(sq(), { pattern: key, spacing: 3, rotationDeg: 30,
        minLength: 0.5, tracer });
      if (!f.strokes.length) return false;
      if (!inBox(f.strokes)) return false;
    }
    return true; })());
  // ⚠️ THE SLICER'S TWENTY-FOUR ARE ALL STILL THERE, BY NAME. The two tools
  // share this vocabulary on purpose — a student who styles a bed in one should
  // recognise it in the other — so the check is that none of them has been
  // renamed, regrouped or dropped, NOT that the table has exactly 24 entries.
  // This tool adds `solid`, which the Slicer has no use for: the Slicer cuts,
  // and solid is a spacing that only means something on an engrave pass.
  ok("the Slicer's 24 fills are all present, unrenamed and in their own groups", (() => {
    const SLICER = {
      lines: "linear", double: "linear", dashes: "linear", dashdot: "linear",
      cross: "linear", trigrid: "linear", zigzag: "linear",
      waves: "water", ripples: "water", scales: "water",
      herringbone: "paving", brick: "paving", hex: "paving", diamonds: "paving",
      dots: "scatter", rings: "scatter", stipple: "scatter", pebbles: "scatter",
      plus: "scatter", ticks: "scatter", grass: "scatter", marsh: "scatter",
      interference: "abstract", echo: "abstract",
    };
    return Object.entries(SLICER).every(([k, g]) => FILL_PATTERNS[k] && FILL_PATTERNS[k][0] === g)
      && Object.keys(SLICER).length === 24; })());
  // ⚠️ SOLID IS A SPACING, NOT A FLAG. It has to come out DENSER than any
  // spacing a reader would set by hand, or "solid" arrives at the machine as
  // stripes.
  ok("solid fills tighter than a hand-set spacing, and reports itself as linear", (() => {
    const solid = fillRegion(sq(), { pattern: "solid", rotationDeg: 0, minLength: 0.3, tracer });
    const hand = fillRegion(sq(), { pattern: "lines", spacing: 2, rotationDeg: 0,
      minLength: 0.3, tracer });
    return FILL_PATTERNS.solid[0] === "linear"
      && solid.strokes.length > hand.strokes.length * 3 && inBox(solid.strokes); })());
  // ⚠️ A SCATTER MUST NOT RESHUFFLE BETWEEN PREVIEW AND EXPORT.
  ok("scatter patterns are deterministic, not random", (() => {
    const a = fillRegion(sq(), { pattern: "stipple", spacing: 3, tracer });
    const b = fillRegion(sq(), { pattern: "stipple", spacing: 3, tracer });
    return JSON.stringify(a.strokes) === JSON.stringify(b.strokes) && a.strokes.length > 10;
  })());
  ok("the cell hash is stable and varies with the cell",
    cellRandom(3, 4, 1) === cellRandom(3, 4, 1) && cellRandom(3, 4, 1) !== cellRandom(3, 5, 1));
  ok("rotation turns the fill", (() => {
    const a = fillRegion(sq(), { pattern: "lines", spacing: 4, rotationDeg: 0, tracer });
    const b = fillRegion(sq(), { pattern: "lines", spacing: 4, rotationDeg: 90, tracer });
    const flat = (r) => r.strokes.every((p) => near(p[1], p[3], 1e-6));
    return flat(a) && !flat(b); })());
  // ⚠️ A POND INSIDE A PLANTING BED MUST NOT COME OUT PLANTED.
  ok("a hole is left unfilled", (() => {
    const donut = [sq()[0], { hole: true,
      pts: Float64Array.from([15, 15, 25, 15, 25, 25, 15, 25]) }];
    const f = fillRegion(donut, { pattern: "lines", spacing: 1.5, rotationDeg: 0, tracer });
    return f.strokes.length > 5 && f.strokes.every((p) => {
      for (let i = 0; i < p.length; i += 2) {
        if (p[i] > 15.4 && p[i] < 24.6 && p[i + 1] > 15.4 && p[i + 1] < 24.6) return false;
      }
      return true; }); })());
  // ⚠️ A CAP THAT IS VISIBLE BEATS A BROWSER THAT HANGS.
  ok("an absurdly fine spacing is capped, and says so", (() => {
    const f = fillRegion(sq(), { pattern: "lines", spacing: 0.001, rotationDeg: 0, tracer });
    return f.capped === true && f.strokes.length < 900; })());
  ok("a sane spacing is not capped",
    fillRegion(sq(), { pattern: "lines", spacing: 3, tracer }).capped === false);
  ok("an unknown pattern is refused by name", (() => {
    try { fillRegion(sq(), { pattern: "tartan", tracer }); } catch (e) {
      return /tartan/.test(e.message); }
    return false; })());
  // Contour echo needs no polygon-offsetting engine — it traces a distance field.
  ok("contour echo produces nested rings inside the region", (() => {
    const f = fillRegion(sq(), { pattern: "echo", spacing: 4, tracer });
    return f.strokes.length >= 3 && inBox(f.strokes); })());
  ok("contour echo without a tracer returns nothing rather than throwing",
    fillRegion(sq(), { pattern: "echo", spacing: 4 }).strokes.length === 0);

  // ── linetypes ──
  // ⚠️ THE SLICER'S RUN LENGTHS, WHICH ARE MEASURED. Its source records a dot as
  // 0.4 mm because 0.1 mm burns were invisible on cardboard AND in the preview.
  // linestyle.js here uses 0.25 mm; the two tables are deliberately separate and
  // must not be merged without a decision.
  ok("the feature linetypes carry the Slicer's measured run lengths",
    JSON.stringify(FEATURE_LINETYPES.dashed.pattern) === "[3,1.5]"
    && JSON.stringify(FEATURE_LINETYPES.dotted.pattern) === "[0.4,1.1]"
    && JSON.stringify(FEATURE_LINETYPES.dashdot.pattern) === "[3,1.1,0.4,1.1]"
    && FEATURE_LINETYPES.solid.pattern === null);

  // ── points ──
  const pts = [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 12 }];
  ok("points become circles of the asked-for radius", (() => {
    const f = buildFeature({ kind: "point", points: pts,
      style: { radiusMM: 3, linetype: "solid", pass: "DLF-02_score_medium" } },
      { sheet: { width: 40, height: 40 }, tracer });
    if (f.report.drawn !== 3) return false;
    const p = f.paths[0].pts;
    let cx = 0, cy = 0;
    for (let i = 0; i < p.length; i += 2) { cx += p[i]; cy += p[i + 1]; }
    cx /= p.length / 2; cy /= p.length / 2;
    return near(Math.hypot(p[0] - cx, p[1] - cy), 3, 0.05); })());
  ok("a point linetype breaks the ring into marks", (() => {
    const solid = buildFeature({ kind: "point", points: pts, style: { radiusMM: 3 } },
      { sheet: { width: 40, height: 40 }, tracer });
    const dotted = buildFeature({ kind: "point", points: pts,
      style: { radiusMM: 3, linetype: "dotted" } }, { sheet: { width: 40, height: 40 }, tracer });
    return dotted.paths.length > solid.paths.length * 3; })());
  ok("a point can carry a fill inside its symbol", (() => {
    const f = buildFeature({ kind: "point", points: [{ x: 20, y: 20 }],
      style: { radiusMM: 5, pattern: "stipple", spacingMM: 1.2 } },
      { sheet: { width: 40, height: 40 }, tracer });
    return f.report.fillStrokes > 3; })());
  // ⚠️ THE COMMONEST FAILURE IS A SHAPEFILE IN THE WRONG CRS.
  ok("points off the sheet are dropped and named, not silently missing", (() => {
    const f = buildFeature({ kind: "point", name: "trees",
      points: [{ x: 10, y: 10 }, { x: 9e5, y: 9e5 }] },
      { sheet: { width: 40, height: 40 }, tracer });
    return f.report.drawn === 1 && f.report.dropped === 1
      && f.warnings.some((w) => /different coordinate system/.test(w)); })());

  // ── lines ──
  // ⚠️ A POLYLINE IS A PATH, NOT A RING. Closing one would draw a line from the
  // end of a stream back to its source.
  ok("a line feature is never closed", (() => {
    const f = buildFeature({ kind: "line",
      rings: [{ pts: Float64Array.from([2, 2, 20, 8, 35, 30]), hole: false }],
      style: { linetype: "solid" } }, { sheet: { width: 40, height: 40 }, tracer });
    return f.paths.length === 1 && f.paths[0].closed === false; })());
  ok("a line linetype cuts it into marks", (() => {
    const g = { kind: "line", rings: [{ pts: Float64Array.from([2, 2, 38, 2]), hole: false }] };
    const solid = buildFeature({ ...g, style: { linetype: "solid" } },
      { sheet: { width: 40, height: 40 }, tracer });
    const dashed = buildFeature({ ...g, style: { linetype: "dashed" } },
      { sheet: { width: 40, height: 40 }, tracer });
    return solid.paths.length === 1 && dashed.paths.length > 5; })());
  ok("linetype scale stretches the pattern", (() => {
    const g = { kind: "line", rings: [{ pts: Float64Array.from([2, 2, 38, 2]), hole: false }] };
    const one = buildFeature({ ...g, style: { linetype: "dashed", linetypeScale: 1 } },
      { sheet: { width: 40, height: 40 }, tracer });
    const four = buildFeature({ ...g, style: { linetype: "dashed", linetypeScale: 4 } },
      { sheet: { width: 40, height: 40 }, tracer });
    return four.paths.length < one.paths.length; })());

  // ── polygons ──
  ok("a polygon draws an outline and a fill, and the outline can be switched off", (() => {
    const withO = buildFeature({ kind: "polygon", rings: sq(),
      style: { pattern: "lines", spacingMM: 4, outline: true } },
      { sheet: { width: 40, height: 40 }, tracer });
    const noO = buildFeature({ kind: "polygon", rings: sq(),
      style: { pattern: "lines", spacingMM: 4, outline: false } },
      { sheet: { width: 40, height: 40 }, tracer });
    return withO.paths.length === noO.paths.length + 1; })());
  ok("outline only, with no fill, is a legitimate choice", (() => {
    const f = buildFeature({ kind: "polygon", rings: sq(),
      style: { pattern: "none", outline: true } }, { sheet: { width: 40, height: 40 }, tracer });
    return f.paths.length === 1 && f.report.fillStrokes === 0; })());

  // ── through the compiler ──
  const demF = makeDEM(40, 40, 1, (c) => 50 + c * 0.1, { name: "f" });
  const mapRing = { pts: Float64Array.from([5, 5, 30, 5, 30, 30, 5, 30]), hole: false };
  const dF = compile({ dem: demF, sym: { legend: false, contours: { enabled: false } },
    features: [{ kind: "polygon", name: "bed", rings: [mapRing],
      style: { pattern: "grass", spacingMM: 3, pass: "DLF-01_score_light" } }] });
  ok("the compiler draws a feature layer on its own pass", (() => {
    const r = dF.report.features[0];
    return r && r.drawn === 1 && r.fillStrokes > 5
      && dF.paths.filter((p) => p.layer === "DLF-01_score_light").length > 5; })());
  ok("feature strokes are clipped to the sheet like everything else", dF.paths.every((p) => {
    for (let i = 0; i < p.pts.length; i += 2) {
      if (p.pts[i] < -1e-6 || p.pts[i] > dF.sheet.width + 1e-6) return false;
      if (p.pts[i + 1] < -1e-6 || p.pts[i + 1] > dF.sheet.height + 1e-6) return false;
    }
    return true; }));
  ok("the cutting report names the feature layer and its style",
    /features "bed": 1 polygon/.test(reportText(dF)) && /grass at 3 mm/.test(reportText(dF)));

  // ── the reader now reads points ──
  ok("a point shapefile is read, not refused", (() => {
    const r = readShapefile(makeSHP([[[100, 200]]], { type: 1 }), { name: "trees.shp" });
    return r.kind === "point" && r.points.length === 1
      && near(r.points[0].x, 100, 1e-9) && near(r.points[0].y, 200, 1e-9); })());
  ok("a multipoint shapefile yields every point", (() => {
    const r = readShapefile(makeSHP([[[0, 0, 10, 10, 20, 5]]], { type: 8 }));
    return r.kind === "point" && r.points.length === 3; })());
  ok("a polyline file reports kind line and invents no hole winding", (() => {
    const r = readShapefile(makeSHP([[rectCCW(0, 0, 10, 10)]], { type: 3 }));
    return r.kind === "line" && r.rings.every((x) => x.hole === false); })());
  ok("a polygon file still reports kind polygon with its winding intact", (() => {
    const r = readShapefile(makeSHP([[rectCW(0, 0, 10, 10), rectCCW(3, 3, 7, 7)]]));
    return r.kind === "polygon" && !r.rings[0].hole && r.rings[1].hole; })());
}

// ── attributes: the .dbf, and styling driven by it ───────────────────────────
// ⚠️ GEOMETRY AND ATTRIBUTES ARE PAIRED BY RECORD ORDER AND NOTHING ELSE — no
// key, no id, no join column. Every check here exists because getting that
// pairing or its arithmetic wrong sizes each symbol by the wrong feature, and
// the drawing still looks entirely plausible.
group("attributes: the .dbf, and styling driven by it");
{
  const F = [
    { name: "SPECIES", type: "C", length: 20 },
    { name: "DBH", type: "N", length: 7, decimals: 1 },
    { name: "ASPECT", type: "N", length: 6, decimals: 1 },
    { name: "ALIVE", type: "L", length: 1 },
  ];
  const R = [
    { SPECIES: "Pinus sylvestris", DBH: 10, ASPECT: 0, ALIVE: true },
    { SPECIES: "Betula", DBH: 40, ASPECT: 90, ALIVE: true },
    { SPECIES: "Sorbus", DBH: null, ASPECT: 180, ALIVE: false },
  ];
  const table = readDBF(makeDBF(F, R), { name: "trees.dbf" });

  ok("fields and their types are read", (() => {
    const t = table.fields.map((f) => f.name + ":" + f.type).join(",");
    return t === "SPECIES:C,DBH:N,ASPECT:N,ALIVE:L"; })());
  // ⚠️ dBASE pads with NUL, and trim() does not remove NUL.
  ok("a padded name comes back clean, and an inner space survives",
    table.rows[0].SPECIES === "Pinus sylvestris" && table.rows[1].SPECIES === "Betula");
  ok("numerics parse, including right-justified ones",
    table.rows[0].DBH === 10 && table.rows[1].DBH === 40);
  // ⚠️ A BLANK IS NULL, NEVER 0. A missing girth must not draw a zero-radius
  // circle as though the tree had been measured at nothing.
  ok("a blank numeric is null, not zero", table.rows[2].DBH === null);
  ok("logicals parse", table.rows[0].ALIVE === true && table.rows[2].ALIVE === false);
  ok("only numeric columns that hold numbers are offered for styling",
    JSON.stringify(table.numeric) === '["DBH","ASPECT"]');
  ok("a deleted record is skipped, and counted", (() => {
    const t = readDBF(makeDBF(F, R, { deleted: [1] }));
    return t.rows.length === 2 && t.deleted === 1
      && !t.rows.some((r) => r.SPECIES === "Betula"); })());
  ok("a truncated table reads what is there and says so", (() => {
    const t = readDBF(makeDBF(F, R, { lieAboutCount: 9 }));
    return t.rows.length === 3 && t.notes.some((n) => /claims 9 records/.test(n)); })());
  ok("a file too short to hold a header is refused", (() => {
    try { readDBF(new ArrayBuffer(10), { name: "x.dbf" }); }
    catch (e) { return /32/.test(e.message); }
    return false; })());
  ok("the range of a field ignores the blanks but counts them", (() => {
    const r = fieldRange(table.rows, "DBH");
    return r.lo === 10 && r.hi === 40 && r.n === 2 && r.missing === 1; })());
  // ⚠️ A COUNT MISMATCH IS REFUSED. Pairing 3 rows to 4 shapes would size every
  // symbol by the wrong feature and look completely reasonable.
  ok("a row/shape count mismatch is refused by name", (() => {
    try { assertPairs(table.rows, 4, "trees.shp"); }
    catch (e) { return /3 rows but the geometry has 4/.test(e.message)
      && /ORDER/.test(e.message); }
    return false; })());
  ok("a matching count passes", (() => {
    try { assertPairs(table.rows, 3); return true; } catch { return false; } })());

  // ── the scaling maths ──
  // ⚠️ AREA-PROPORTIONAL IS THE DEFAULT AND IT IS NOT THE SAME AS LINEAR. A
  // circle of twice the radius covers FOUR times the paper; scaling the radius
  // directly makes large values look several times larger than they are.
  ok("area scaling puts the midpoint above the linear midpoint", (() => {
    const a = scaleValue(50, 0, 100, 1, 5, "area");
    const l = scaleValue(50, 0, 100, 1, 5, "linear");
    return a > l && near(a, Math.sqrt((1 * 1 + 5 * 5) / 2), 1e-9); })());
  ok("both modes agree at the ends", (() => {
    for (const m of ["area", "linear"]) {
      if (!near(scaleValue(0, 0, 100, 1, 5, m), 1, 1e-9)) return false;
      if (!near(scaleValue(100, 0, 100, 1, 5, m), 5, 1e-9)) return false;
    }
    return true; })());
  ok("area scaling means the AREA is what interpolates linearly", (() => {
    // At t = 0.25 the area should be a quarter of the way from min to max.
    const r = scaleValue(25, 0, 100, 2, 6, "area");
    const wantArea = 2 * 2 + 0.25 * (6 * 6 - 2 * 2);
    return near(r * r, wantArea, 1e-9); })());
  ok("values outside the range are clamped, never extrapolated",
    near(scaleValue(-50, 0, 100, 1, 5, "area"), 1, 1e-9)
    && near(scaleValue(500, 0, 100, 1, 5, "area"), 5, 1e-9));
  ok("a zero-width range does not divide by zero",
    Number.isFinite(scaleValue(7, 7, 7, 1, 5, "area")));

  // ── angles ──
  // ⚠️ A BEARING RUNS CLOCKWISE FROM NORTH; the geometry runs anticlockwise
  // from east. Getting the sense wrong silently mirrors every direction.
  ok("degrees mode is used as is, clockwise from north", (() => {
    // 90° (east) must turn a north-pointing symbol to the east.
    const rot = angleValue(90, 0, 360, "degrees");
    const tri = symbolPaths("triangle", 0, 0, 10, rot);
    // apex started at (0, +10); at a bearing of 90 it should be near (+10, 0)
    return near(tri[0][0], 10, 0.01) && near(tri[0][1], 0, 0.01); })());
  ok("range mode spreads a non-angular field over a full turn", (() => {
    const a = angleValue(0, 0, 10, "range"), b = angleValue(10, 0, 10, "range");
    return near(a, 0, 1e-9) && near(Math.abs(b), 2 * Math.PI, 1e-9); })());
  ok("an offset turns the whole field", (() => {
    const a = angleValue(0, 0, 360, "degrees", 0);
    const b = angleValue(0, 0, 360, "degrees", 90);
    return !near(a, b, 1e-9); })());

  // ── the symbols ──
  ok("every symbol produces geometry at every rotation", (() => {
    for (const k of SYMBOL_ORDER) {
      for (const rot of [0, 0.7, 3.1]) {
        const p = symbolPaths(k, 5, 5, 3, rot);
        if (!p.length || p.some((q) => q.length < 4)) return false;
        for (const q of p) {
          for (let i = 0; i < q.length; i += 2) {
            if (Math.hypot(q[i] - 5, q[i + 1] - 5) > 3.001) return false;   // inside r
          }
        }
      }
    }
    return true; })());
  ok("a circle is unchanged by rotation, as it must be", (() => {
    const a = symbolPaths("circle", 0, 0, 4, 0)[0];
    const b = symbolPaths("circle", 0, 0, 4, 1.3)[0];
    // Same set of points, possibly from a different start: compare the radius.
    const rad = (p) => { let m = 0; for (let i = 0; i < p.length; i += 2)
      m = Math.max(m, Math.hypot(p[i], p[i + 1])); return m; };
    return near(rad(a), rad(b), 1e-9); })());
  ok("a directional symbol IS changed by rotation", (() => {
    const a = symbolPaths("arrow", 0, 0, 4, 0)[0];
    const b = symbolPaths("arrow", 0, 0, 4, 1.3)[0];
    return !near(a[0], b[0], 1e-6) || !near(a[1], b[1], 1e-6); })());
  ok("multi-stroke symbols report every stroke",
    symbolPaths("cross", 0, 0, 3, 0).length === 2
    && symbolPaths("arrow", 0, 0, 3, 0).length === 2);

  // ── through buildFeature ──
  const pts = [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }];
  const rows = [{ DBH: 10, ASPECT: 0 }, { DBH: 40, ASPECT: 90 }, { DBH: null, ASPECT: 180 }];
  ok("symbols are sized by the attribute", (() => {
    const f = buildFeature({ kind: "point", points: pts, rows, style: {
      symbol: "circle", radiusMM: 2,
      sizeBy: { field: "DBH", lo: 10, hi: 40, minMM: 1, maxMM: 4, mode: "area" } } },
      { sheet: { width: 40, height: 40 } });
    const rad = (p) => { let cx = 0, cy = 0; const n = p.length / 2;
      for (let i = 0; i < p.length; i += 2) { cx += p[i]; cy += p[i + 1]; }
      cx /= n; cy /= n; return Math.hypot(p[0] - cx, p[1] - cy); };
    const r0 = rad(f.paths[0].pts), r1 = rad(f.paths[1].pts);
    return near(r0, 1, 0.05) && near(r1, 4, 0.05); })());
  // ⚠️ AN UNMEASURED FEATURE IS DRAWN AT THE FIXED SIZE AND NAMED — it is still
  // a tree, it is just not measured, and deleting it would falsify the survey.
  ok("a feature with no value falls back to the fixed size, and is counted", (() => {
    const f = buildFeature({ kind: "point", name: "trees", points: pts, rows, style: {
      symbol: "circle", radiusMM: 2,
      sizeBy: { field: "DBH", lo: 10, hi: 40, minMM: 1, maxMM: 4, mode: "area" } } },
      { sheet: { width: 40, height: 40 } });
    return f.report.drawn === 3 && f.report.unmeasured === 1
      && f.warnings.some((w) => /NOT comparable/.test(w)); })());
  ok("rotation from an attribute reaches the drawing", (() => {
    const mk = (rotField) => buildFeature({ kind: "point", points: [pts[1]],
      rows: [rows[1]], style: { symbol: "arrow", radiusMM: 3,
        rotateBy: { field: rotField, lo: 0, hi: 360, mode: "degrees" } } },
      { sheet: { width: 40, height: 40 } });
    const off = mk(null).paths[0].pts, on = mk("ASPECT").paths[0].pts;
    return !near(off[0], on[0], 1e-6) || !near(off[1], on[1], 1e-6); })());
  // ⚠️ DENSITY IS INVERTED: a HIGH value must give a TIGHTER fill.
  ok("polygon density from an attribute is inverted — high value, tight fill", (() => {
    const ring = [{ pts: Float64Array.from([0, 0, 30, 0, 30, 30, 0, 30]), hole: false }];
    const mk = (v) => buildFeature({ kind: "polygon", rings: ring, rows: [{ D: v }],
      style: { pattern: "lines", rotationDeg: 0, outline: false,
        densityBy: { field: "D", lo: 0, hi: 100, minMM: 1, maxMM: 6 } } },
      { sheet: { width: 40, height: 40 }, tracer: { traceContours } });
    return mk(100).report.fillStrokes > mk(0).report.fillStrokes * 2; })());
  ok("with no field chosen, nothing is data-driven and the fixed values hold", (() => {
    const f = buildFeature({ kind: "point", points: pts, rows, style: {
      symbol: "circle", radiusMM: 2, sizeBy: { field: null } } },
      { sheet: { width: 40, height: 40 } });
    return f.report.drawn === 3 && f.report.unmeasured === 0; })());
}

// ── sections — the ground cut open ───────────────────────────────────────────
// ⚠️ AN UNSTATED VERTICAL EXAGGERATION IS A LIE ABOUT EVERY SLOPE ON THE
// DRAWING, and at plate scale the factor is always large. These checks pin the
// centre cut, the honest reporting of the factor, and the refusal to bridge
// unmeasured ground.
group("sections — the ground cut open");
{
  // A ridge running north–south: every horizontal cut crosses it, so each
  // profile has a real peak in the middle.
  const ridge = makeDEM(60, 80, 1, (c, r2) => 50 + 10 * Math.exp(-((c - 40) ** 2) / 200),
    { name: "ridge" });
  const cut = cutSections(ridge, { count: 3, axis: "horizontal", heightUnits: 8 });
  ok("three cuts are made and lettered A, B, C",
    cut.sections.length === 3 && cut.sections.map((S) => S.label).join("") === "ABC");
  ok("the middle cut runs exactly through the centre of the plate", (() => {
    const mid = cut.sections[1];
    const south = ridge.originY - ridge.nrows * ridge.cell;
    return near(mid.atFraction, 0.5, 1e-9)
      && near(mid.line[1], south + (ridge.nrows * ridge.cell) / 2, 1e-6); })());
  ok("the cuts are evenly spaced", (() => {
    const f = cut.sections.map((S) => S.atFraction);
    return near(f[1] - f[0], f[2] - f[1], 1e-9) && near(f[0], 0.25, 1e-9); })());
  ok("a profile is a continuous path when the ground is measured throughout",
    cut.sections.every((S) => S.profile.length === 1 && S.gaps === 0));
  ok("the profile rises where the ridge is and sits on its cut line elsewhere", (() => {
    const S = cut.sections[1];
    const p = S.profile[0];
    let peakY = -Infinity, edgeY = Infinity;
    for (let i = 0; i < p.length; i += 2) {
      if (near(p[i], ridge.originX + 40.5, 1.5)) peakY = Math.max(peakY, p[i + 1]);
      if (p[i] < ridge.originX + 5) edgeY = Math.min(edgeY, p[i + 1]);
    }
    return peakY > edgeY + 5; })());
  ok("no profile stands taller than the height it was allowed", (() => {
    for (const S of cut.sections) {
      for (const p of S.profile) {
        for (let i = 1; i < p.length; i += 2) {
          if (p[i] - S.line[1] > 8 + 1e-6) return false;
        }
      }
    }
    return true; })());
  ok("the exaggeration reported is the height divided by the relief", (() => {
    const S = cut.sections[1];
    return near(S.exaggeration, 8 / (S.max - S.min), 1e-6); })());
  ok("a shared datum scales every cut the same, an own datum does not", (() => {
    // A raster whose two halves have very different relief.
    const uneven = makeDEM(60, 80, 1, (c, r2) =>
      50 + (r2 < 30 ? 10 : 1) * Math.exp(-((c - 40) ** 2) / 200), { name: "uneven" });
    const own = cutSections(uneven, { count: 3, heightUnits: 8, datum: "own" });
    const sh = cutSections(uneven, { count: 3, heightUnits: 8, datum: "shared" });
    const spread = (r2) => Math.max(...r2.sections.map((S) => S.exaggeration))
                         / Math.min(...r2.sections.map((S) => S.exaggeration));
    return spread(own) > 3 && near(spread(sh), 1, 1e-6); })());
  ok("a flat cut gives a flat line, not an infinite one", (() => {
    const flat = makeDEM(30, 30, 1, () => 50, { name: "flat" });
    const c2 = cutSections(flat, { count: 3, heightUnits: 8 });
    return c2.sections.every((S) => S.profile.every((p) =>
      [...p].every((v) => Number.isFinite(v)))); })());
  ok("nodata BREAKS the profile rather than bridging it", (() => {
    const holed = makeDEM(60, 80, 1, (c) => (c > 30 && c < 50 ? NaN : 50 + c * 0.2),
      { name: "holed" });
    const c2 = cutSections(holed, { count: 3, heightUnits: 8 });
    return c2.sections.every((S) => S.profile.length === 2 && S.gaps >= 1); })());
  ok("a vertical axis cuts the other way", (() => {
    const v = cutSections(ridge, { count: 3, axis: "vertical", heightUnits: 8 });
    return v.sections.every((S) => near(S.line[0], S.line[2], 1e-6)); })());

  // Through the compiler.
  const dS = compile({ dem: ridge, sym: { contours: { enabled: false }, legend: false },
    sections: [{ dem: ridge, name: "three cuts", count: 3, heightMM: 12,
      pass: "DLF-03_score_strong", linePass: "DLF-01_score_light" }] });
  const sr = dS.report.sections[0];
  ok("the compiler draws the profiles, the cut lines and the letters",
    sr.count === 3 && sr.paths >= 3
    && dS.paths.some((p) => p.layer === "DLF-03_score_strong")
    && dS.paths.some((p) => p.layer === "DLF-01_score_light"));
  ok("every section entity lands on the sheet", dS.paths.every((p) => {
    for (let i = 0; i < p.pts.length; i += 2) {
      if (p.pts[i] < -1e-9 || p.pts[i] > dS.sheet.width + 1e-9) return false;
      if (p.pts[i + 1] < -1e-9 || p.pts[i + 1] > dS.sheet.height + 1e-9) return false;
    }
    return true; }));
  ok("the exaggeration is warned about, never left to be assumed",
    dS.warnings.some((w) => /EXAGGERATED about ×|COMPRESSED to about ×/.test(w)));
  ok("the cutting report states the factor in capitals",
    /VERTICAL (EXAGGERATION|COMPRESSION) ABOUT ×/.test(reportText(dS)));
  ok("the report names the cuts by their letters", sr.labels === "A, B, C");
  // ⚠️ A FACTOR UNDER 1 IS A COMPRESSION AND MUST NOT BE CALLED AN
  // EXAGGERATION — the drawing would be claiming it distorts the opposite way.
  ok("a compressed profile is called compressed, not exaggerated", (() => {
    // 2 mm of profile on a 10 m ridge at 1:200 is a heavy compression.
    const dC = compile({ dem: ridge, sym: { contours: { enabled: false }, legend: false,
      sheet: { scale: 200 } },
      sections: [{ dem: ridge, name: "squashed", count: 3, heightMM: 2 }] });
    return dC.report.sections[0].exaggeration < 1
      && dC.warnings.some((w) => /COMPRESSED to about ×/.test(w))
      && !dC.warnings.some((w) => /EXAGGERATED about ×/.test(w))
      && /VERTICAL COMPRESSION ABOUT ×/.test(reportText(dC)); })());
  ok("an exaggerated profile is called exaggerated", (() => {
    const dE = compile({ dem: ridge, sym: { contours: { enabled: false }, legend: false },
      sections: [{ dem: ridge, name: "stretched", count: 3, heightMM: 90 }] });
    return dE.report.sections[0].exaggeration > 1
      && dE.warnings.some((w) => /EXAGGERATED about ×/.test(w)); })());
  // ⚠️ TWO PROFILES ON TOP OF EACH OTHER ARE UNREADABLE ON MATERIAL.
  ok("profiles taller than the gap between cuts are warned about", (() => {
    const dOver = compile({ dem: ridge, sym: { contours: { enabled: false }, legend: false },
      sections: [{ dem: ridge, name: "crowded", count: 9, heightMM: 60 }] });
    return dOver.warnings.some((w) => /taller than the .* between neighbouring cuts/.test(w));
  })());
  ok("well-spaced profiles raise no overlap warning",
    !dS.warnings.some((w) => /neighbouring cuts/.test(w)));
}

// ── compression ──────────────────────────────────────────────────────────────
// ⚠️ THESE GUARD THE COMMONEST FILE IN THE WORLD. Every GeoTIFF QGIS writes is
// Deflate; Kartverket ships LZW. The reader once refused all of them and told
// the user to run gdal_translate, which is the whole tool failing at the first
// step. `tests/check-compression.mjs` goes wider; these are the ones that must
// never regress.
group("compression");
{
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const src = new Uint8Array(30000).map((_, i) => (i * 31) & 0xff);
  ok("inflate round-trips a zlib stream",
    same(inflate(new Uint8Array(zlib.deflateSync(Buffer.from(src))), src.length), src));
  ok("inflate round-trips raw deflate",
    same(inflate(new Uint8Array(zlib.deflateRawSync(Buffer.from(src))), src.length), src));
  ok("inflate handles stored blocks (level 0)",
    same(inflate(new Uint8Array(zlib.deflateSync(Buffer.from(src), { level: 0 })), src.length), src));
  ok("LZW round-trips past a table reset", (() => {
    const big = new Uint8Array(200000).map((_, i) => (i * 7919) & 0xff);
    return same(lzwDecode(tiffLZWEncode(big), big.length), big); })());
  ok("PackBits matches the TIFF 6 example", (() => {
    const packed = Uint8Array.of(0xfe, 0xaa, 0x02, 0x80, 0x00, 0x2a, 0xfd, 0xaa, 0x03,
      0x80, 0x00, 0x2a, 0x22, 0xf7, 0xaa);
    const want = Uint8Array.of(0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0xaa, 0xaa, 0xaa, 0xaa,
      0x80, 0x00, 0x2a, 0x22, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa);
    return same(packbits(packed, want.length), want); })());
  ok("the predictor steps by sample, not by byte", (() => {
    const o = new Uint16Array([1000, 1100, 1250, 900]);
    const b = new Uint8Array(o.buffer.slice(0));
    const dv2 = new DataView(b.buffer);
    for (let i = 3; i >= 1; i--) dv2.setUint16(i * 2, (o[i] - o[i - 1]) & 0xffff, true);
    unpredict(b, 4, 1, 16, 1, true);
    return [...new Uint16Array(b.buffer)].join(",") === [...o].join(","); })());

  const W = 61, H = 47;
  const z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    z[r * W + c] = 70 + 8 * Math.sin(c / 9) * Math.cos(r / 7) + c * 0.05;
  }
  const plain = readElevation(makeTIFF(z, W, H, { compression: 1 }), { name: "plain" });
  for (const [name, o] of [
    ["Deflate", { compression: 8 }],
    ["Deflate + predictor", { compression: 8, predictor: 2 }],
    ["LZW", { compression: 5 }],
    ["LZW + predictor", { compression: 5, predictor: 2 }],
    ["PackBits", { compression: 32773 }],
    ["tiled + Deflate + predictor", { compression: 8, predictor: 2, tile: 16 }],
    ["one row per strip", { compression: 8, rowsPerStrip: 1 }],
    // ⚠️ PREDICTOR 3 IS WHAT GDAL WRITES FOR FLOAT DEMs. Marc's LAR3072 plates
    // are all Deflate + predictor 3; refusing it refused the tool's own real
    // input. It is a byte-plane shuffle THEN a difference, not differencing
    // with floats in it — get the order wrong and the terrain is smooth,
    // finite and completely false.
    ["Deflate + predictor 3 (float)", { compression: 8, predictor: 3 }],
    ["LZW + predictor 3", { compression: 5, predictor: 3 }],
    ["uncompressed + predictor 3", { compression: 1, predictor: 3 }],
    ["tiled + predictor 3", { compression: 8, predictor: 3, tile: 16 }],
  ]) {
    let worst = Infinity;
    try {
      const got = readElevation(makeTIFF(z, W, H, o), { name });
      worst = 0;
      for (let i = 0; i < z.length; i++) worst = Math.max(worst, Math.abs(got.z[i] - plain.z[i]));
    } catch (e) { ok(`${name} decodes`, false, e.message); continue; }
    ok(`${name} decodes identically to uncompressed`, worst < 1e-6, `worst ${worst}`);
  }
  // ⚠️ ONE BAND MEANS PLANAR CONFIGURATION IS MEANINGLESS. Refusing on it cost
  // this reader seven of the project's own Ørndalen difference rasters.
  ok("a single-band planar-2 raster is accepted", (() => {
    const b = makeTIFF(z, W, H, { compression: 8 });
    const dv2 = new DataView(b);
    const ifd = dv2.getUint32(4, true), n = dv2.getUint16(ifd, true);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (dv2.getUint16(e, true) === 284) dv2.setUint16(e + 8, 2, true);
    }
    try { readTIFF(b); return true; } catch { return false; } })());
  ok("the float predictor is a shuffle then a difference, not the integer one", (() => {
    // The two must not be interchangeable: running the integer predictor over
    // float-predicted bytes is the exact mistake this pair of names prevents.
    const a = new Uint8Array(makeTIFF(z, 8, 4, { compression: 1, predictor: 3 }));
    const b = new Uint8Array(makeTIFF(z, 8, 4, { compression: 1, predictor: 2 }));
    return Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0; })());
  ok("predictor 3 on integer samples is refused, not misapplied", (() => {
    const b = makeTIFF(z, W, H, { compression: 1, predictor: 3 });
    const dv2 = new DataView(b);
    const ifd = dv2.getUint32(4, true), n = dv2.getUint16(ifd, true);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (dv2.getUint16(e, true) === 339) dv2.setUint16(e + 8, 1, true);   // claim integer
    }
    try { readTIFF(b); return false; } catch (e) { return /floating-point predictor/.test(e.message); } })());
  let refused = "";
  try { readTIFF(makeTIFF(z, W, H, { compression: 7 })); } catch (e) { refused = e.message; }
  ok("an unsupported compression is refused with advice",
    /not supported/.test(refused) && /re-export/.test(refused));
  let badPred = "";
  try {
    const b = makeTIFF(z, W, H, { compression: 1, predictor: 2 });
    const dv2 = new DataView(b);
    const ifd = dv2.getUint32(4, true), n = dv2.getUint16(ifd, true);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (dv2.getUint16(e, true) === 317) dv2.setUint16(e + 8, 9, true);
    }
    readTIFF(b);
  } catch (e) { badPred = e.message; }
  ok("an unknown predictor names the three that exist", /1 none, 2 horizontal, 3 floating point/.test(badPred));
}

// ── line styles ──────────────────────────────────────────────────────────────
group("line styles");
{
  const len = (p) => { let s = 0; for (let i = 2; i < p.length; i += 2)
    s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return s; };
  // ⚠️ MEASURED OVER A LONG LINE ON PURPOSE. The duty cycle is exact only in
  // the limit: any line that does not end on a period boundary carries a
  // partial mark at its far end, and on a 100 mm line an 8.1 mm dash-dot-dot
  // period makes that worth over a percent. Testing the asymptotic property on
  // a short line measures the end effect instead.
  const line = new Float64Array([0, 0, 1000, 0]);
  ok("solid returns the path unbroken", dashPath(line, false, null).length === 1);
  for (const k of STYLE_ORDER.filter((k) => k !== "solid")) {
    const pat = LINE_STYLES[k].pattern;
    const duty = pat.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0)
      / pat.reduce((a, b) => a + b, 0);
    const ink = dashPath(line, false, pat).reduce((a, p) => a + len(p), 0);
    ok(`${LINE_STYLES[k].label} lays down the right fraction of ink`,
      near(ink / 1000, duty, 0.005), `${(ink / 1000).toFixed(4)} vs ${duty.toFixed(4)}`);
  }
  // ⚠️ A DASH-DOT PATTERN HAS FOUR ELEMENTS. A boolean toggle would silently
  // turn it into an even dash and discard the dot.
  ok("dash-dot really alternates long and short", (() => {
    const marks = dashPath(line, false, LINE_STYLES.dash_dot.pattern).map(len).slice(1, -1);
    const longs = marks.filter((m) => m > 2).length, dots = marks.filter((m) => m < 1).length;
    return longs > 5 && dots > 5 && Math.abs(longs - dots) <= 1; })());

  // ⚠️ NO MARK MAY BE A DWELL. A ring's circumference is not a multiple of the
  // period, so the naive walk leaves a runt where the end meets the start —
  // measured at 0.126 mm, half a dot, which at kerf is a burn-through.
  const ring = [];
  for (let i = 0; i < 96; i++) { const a = i / 96 * 2 * Math.PI;
    ring.push(50 + 40 * Math.cos(a), 50 + 40 * Math.sin(a)); }
  for (const k of STYLE_ORDER.filter((k) => k !== "solid")) {
    const marks = dashPath(new Float64Array(ring), true, LINE_STYLES[k].pattern).map(len);
    const shortest = Math.min(...marks);
    const intended = Math.min(...LINE_STYLES[k].pattern.filter((_, i) => i % 2 === 0));
    ok(`${LINE_STYLES[k].label} closes a ring with no runt`,
      shortest >= intended * 0.9, `shortest ${shortest.toFixed(3)}, intended ${intended}`);
  }
  ok("a closed ring stays closed when solid", (() => {
    const r = applyStyle([{ pts: new Float64Array(ring), closed: true }], "solid");
    const p = r.paths[0];
    return r.after === 1 && near(p[0], p[p.length - 2], 1e-9) && near(p[1], p[p.length - 1], 1e-9); })());
  // A style that came from a foreign file has no entry in LINE_STYLES. Reading
  // its label through the table was `undefined.label`, and the throw aborted the
  // import handler one line before it recompiled: the controls showed the new
  // style, the log listed every decision, and the drawing silently did not move.
  ok("styleLabel survives a style that is not in the table",
    styleLabel("custom", [6, 1.5]) === "Custom 6/1.5 mm"
    && styleLabel("nonsense") === "Solid"
    && LINE_STYLES.custom === undefined);
  ok("a custom pattern is dashed with, not ignored", (() => {
    const r = applyStyle([{ pts: new Float64Array([0, 0, 100, 0]), closed: false }],
      "custom", [10, 10]);
    return r.after === 5 && /Custom/.test(styleLabel("custom", [10, 10])); })());
  ok("the cost of dashing is reported, not hidden", (() => {
    const r = applyStyle([{ pts: new Float64Array(ring), closed: true }], "dotted");
    return r.before === 1 && r.after > 100 && typeof r.verdict === "string"; })());
}

// ── several rasters on one sheet ─────────────────────────────────────────────
group("several rasters");
{
  const W = 90, H = 70;
  const ground = new Float32Array(W * H), canopy = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const g = 60 + 12 * Math.exp(-(((c / W - 0.4) ** 2) / 0.04 + ((r / H - 0.5) ** 2) / 0.06));
    ground[r * W + c] = g;
    canopy[r * W + c] = g + (c / W > 0.5 && c / W < 0.9 ? 8 : 0);
  }
  const mk = (z, n) => readElevation(makeTIFF(z, W, H, { compression: 8, predictor: 3,
    cell: 1, originX: 654000, originY: 7738070 }), { name: n });
  const dtm = mk(ground, "DTM"), dsm = mk(canopy, "DSM");
  const d = compile({
    layers: [
      { dem: dtm, name: "DTM", contours: { interval: 2, style: "solid",
        pass: "DLF-02_score_medium", indexPass: "DLF-03_score_strong" } },
      { dem: dsm, name: "DSM", contours: { interval: 2, style: "dashed", indexStyle: "dashed",
        labels: false, pass: "DLF-01_score_light", indexPass: "DLF-01_score_light" } },
    ],
    sym: { sheet: { scale: 500, margin: 0, scaleBar: false, north: false } },
  });
  ok("both rasters are reported separately", d.report.contourLayers.length === 2);
  ok("each layer lands on the pass it was given",
    d.paths.some((p) => p.layer === "DLF-02_score_medium")
    && d.paths.some((p) => p.layer === "DLF-01_score_light"));
  ok("a dashed layer becomes many more paths than it traced",
    d.report.contourLayers[1].drawn > d.report.contourLayers[1].paths * 3);
  ok("a solid layer is drawn as the paths it traced",
    d.report.contourLayers[0].verdict === "continuous"
    && d.report.contourLayers[0].drawn <= d.report.contourLayers[0].paths + 2);
  ok("nothing leaves the sheet", d.paths.every((p) => {
    for (let i = 0; i < p.pts.length; i += 2) {
      if (p.pts[i] < -1e-6 || p.pts[i] > d.sheet.width + 1e-6) return false;
      if (p.pts[i + 1] < -1e-6 || p.pts[i + 1] > d.sheet.height + 1e-6) return false;
    }
    return true; }));
  ok("the primary defines the sheet", near(d.sheet.width, W * 1000 / 500, 1e-6));

  // ⚠️ REORDERING THE LIST CHANGES THE DRAWING, which is the whole point of
  // being able to drag a raster to the top: the FIRST one defines the sheet.
  // A 2 x 2 km context tile can be promoted to get a context sheet, or demoted
  // to sit inside a plate. The interface only reorders the array; this is the
  // property that makes doing so mean something.
  {
    const small = mk(ground.slice(0, 40 * W), "small");
    const halved = { ...small, nrows: 40 };
    const asFirst = compile({ layers: [{ dem: halved, name: "small" }, { dem: dtm, name: "DTM" }],
      sym: { sheet: { scale: 500, margin: 0, scaleBar: false, north: false } } });
    const asSecond = compile({ layers: [{ dem: dtm, name: "DTM" }, { dem: halved, name: "small" }],
      sym: { sheet: { scale: 500, margin: 0, scaleBar: false, north: false } } });
    ok("swapping the order changes the sheet to the new primary's extent",
      near(asFirst.sheet.height, 40 * 1000 / 500, 1e-6)
      && near(asSecond.sheet.height, H * 1000 / 500, 1e-6),
      `${asFirst.sheet.height} vs ${asSecond.sheet.height}`);
    ok("and the demoted raster is still drawn, trimmed to the new sheet",
      asFirst.paths.length > 1 && asFirst.paths.every((p) => {
        for (let i = 1; i < p.pts.length; i += 2)
          if (p.pts[i] < -1e-6 || p.pts[i] > asFirst.sheet.height + 1e-6) return false;
        return true; }));
  }
  const t = toDXF(d).toString();
  ok("the multi-layer DXF is still balanced",
    (t.match(RE_POLYLINE) || []).length === (t.match(RE_SEQEND) || []).length);
  ok("and still ASCII", !RE_NON_ASCII.test(t));
  const rep = reportText(d, { date: "2026-08-23" });
  ok("the cutting report names every raster", /DTM/.test(rep) && /DSM/.test(rep));
  ok("and says a dashed layer is separate marks", /separate marks/.test(rep));
  const one = compile({ dem: dtm, sym: { sheet: { scale: 500, margin: 0 } } });
  ok("a single raster still compiles through the same path",
    one.report.contourLayers.length === 1 && one.report.contours !== null);
}

// ── the whole slice ──────────────────────────────────────────────────────────
group("the whole slice");
{
  const dem = makeDEM(180, 180, 0.5, (c, r) =>
    70 + 8 * Math.exp(-((c - 90) ** 2 + (r - 90) ** 2) / 3000) + Math.sin(c / 12) * 1.5,
    { originX: 654000, originY: 7738090, crs: "EPSG:25833", name: "fixture" });
  // ⚠️ THE FIXTURE PHOTOGRAPHS ARE DERIVED FROM THE TILE, NOT GUESSED AT.
  // Hand-picked degrees look plausible and land in the sea; going the other way
  // — pick a spot on the raster, invert the projection, write THOSE degrees into
  // the file — guarantees the slice is exercised with photographs that are
  // actually on the ground the drawing covers.
  const metas = [0.3, 0.5, 0.7].map((f, i) => {
    const g = fromUTM(dem.originX + dem.ncols * dem.cell * f,
                      dem.originY - dem.nrows * dem.cell * f, 33);
    return readPhotoMeta(makeExifJPEG({ lat: g.lat, lon: g.lon, direction: i * 90 }), `p${i}.jpg`);
  });
  const { points } = placePhotos(metas, dem);
  const drawing = compile({ dem, photos: points, sym: { sheet: { scale: 200, title: "slice" } } });

  ok("the drawing has contour paths", drawing.paths.some((p) => p.layer === "DLF-02_score_medium"));
  ok("index contours go to their own pass", drawing.paths.some((p) => p.layer === "DLF-03_score_strong"));
  ok("labels go to the light-score pass", drawing.paths.some((p) => p.layer === "DLF-01_score_light"));
  ok("the sheet outline is on the last cut pass",
    drawing.paths.some((p) => p.layer === "DLF-05_cut_outer"));
  ok("every path carries a declared layer",
    drawing.paths.every((p) => typeof p.layer === "string" && p.layer.startsWith("DLF-")));
  ok("every path has at least two points", drawing.paths.every((p) => p.pts.length >= 4));
  ok("the report states the CRS", drawing.report.raster.crs === "EPSG:25833");
  ok("the report counts what was drawn",
    drawing.report.totals.paths === drawing.paths.length);
  ok("uncorrected photographs raise a warning about the GPS error",
    drawing.warnings.some((w) => /raw GPS position/.test(w)));

  // The preview and the file are the same geometry.
  const d1 = toDXF(drawing).toString();
  const d2 = toDXF(drawing).toString();
  ok("compiling is deterministic", d1 === d2);
  ok("the DXF contains exactly the compiled entities",
    (d1.match(/\r\nPOLYLINE\r\n/g) || []).length === drawing.paths.length
    && (d1.match(/\r\nCIRCLE\r\n/g) || []).length === drawing.circles.length);
  ok("the DXF is ASCII", !/[^\x00-\x7F]/.test(d1));
  const rep = reportText(drawing, { date: "2026-08-23" });
  ok("the report names the six passes", /DLF-05_cut_outer/.test(rep) && /DLF-00_engrave/.test(rep));
  ok("the report is plain text", typeof rep === "string" && rep.endsWith("\n"));
}

// ── shapefiles out: the drawing put back on the ground ──────────────────────
// ⚠️ THE ORACLE IS THE READER, AND THAT IS ONLY LEGITIMATE BECAUSE THE READER
// WAS NEVER CHECKED AGAINST THIS WRITER. `shapefile.js` is validated against
// `shp-fixture.mjs`, which was written independently from the ESRI
// specification — so the chain is spec → fixture → reader → this writer, and at
// no point does an encoder grade its own homework.
//
// ⚠️ THE READER DISCARDS ANYTHING UNDER THREE POINTS ("fewer than 3 encloses
// nothing") because it exists to read boundaries. That is why every line here
// has at least three: a two-point line round-trips correctly and is dropped on
// the way back in, which would look like a writer fault and is not one.
group("shapefiles out — the drawing back on the ground");
{
  const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  // Real Norwegian eastings and northings: seven significant digits before the
  // point is where a float32 pipeline would quietly lose the last metre.
  const A = Float64Array.of(654000.25, 7730000.5, 654040.75, 7730030.25, 654100, 7730090);
  const B = Float64Array.of(654200, 7730200, 654250, 7730260, 654300, 7730300,
    654390.125, 7730375.75);
  const w = writeSHP([{ pts: A }, { pts: B }], SHP_POLYLINE);
  const back = readShapefile(ab(w.shp), { name: "lines.shp" });
  ok("both polylines survive the round trip", back.shapes === 2 && back.rings.length === 2,
    `${back.shapes} shapes, ${back.rings.length} rings`);
  const same = (g, e) => g.length === e.length && e.every((v, i) => g[i] === v);
  ok("UTM coordinates come back EXACTLY, to the last decimal",
    same(back.rings[0].pts, [...A]) && same(back.rings[1].pts, [...B]));

  // ⚠️ The header's length field is in 16-bit WORDS and BIG-endian, while the
  // version and shape type immediately after it are little-endian. Getting this
  // wrong yields a file every reader believes is twice as long as it is.
  const pdv = new DataView(ab(w.shp));
  ok("the .shp file length is written in words, not bytes",
    pdv.getInt32(24, false) * 2 === w.shp.length);
  ok("the file code is big-endian 9994 and the version little-endian 1000",
    pdv.getInt32(0, false) === 9994 && pdv.getInt32(28, true) === 1000);
  const sdv = new DataView(ab(w.shx));
  const off1 = sdv.getInt32(100, false), len1 = sdv.getInt32(104, false);
  const off2 = sdv.getInt32(108, false);
  ok("the .shx indexes the records where they actually are",
    off1 === 50 && off2 === off1 + 4 + len1 && pdv.getInt32(off2 * 2, false) === 2);

  const wp = writeSHP([{ pts: Float64Array.of(654000.25, 7730000.5) }], SHP_POINT);
  const rp = readShapefile(ab(wp.shp), { name: "p.shp" });
  ok("a point shapefile writes and reads back on the same spot",
    rp.points.length === 1 && rp.points[0].x === 654000.25 && rp.points[0].y === 7730000.5);

  // ⚠️ A numeric that is not right-justified comes back NaN from any reader that
  // trims one side only, and a NaN column is a column QGIS cannot style by.
  const dbf = writeDBF(
    [{ name: "pass", type: "C", length: 20 }, { name: "kind", type: "C", length: 16 },
      { name: "closed", type: "L", length: 1 },
      { name: "len_m", type: "N", length: 14, decimals: 3 }],
    [{ pass: "DLF-01_score_light", kind: "contours", closed: true, len_m: 123.456 },
      { pass: "DLF-00_engrave", kind: "hachures", closed: false, len_m: 7.5 }]);
  const t = readDBF(ab(dbf), { name: "lines.dbf" });
  ok("the .dbf round-trips its rows, text and booleans",
    t.rows.length === 2 && String(t.rows[0].PASS).trim() === "DLF-01_score_light"
    && t.rows[0].CLOSED === true && t.rows[1].CLOSED === false);
  ok("numerics are right-justified, so they parse rather than reading NaN",
    Math.abs(Number(t.rows[0].LEN_M) - 123.456) < 1e-9 && t.numeric.includes("LEN_M"));

  // ⚠️ CLAIMING A CRS IS WORSE THAN HAVING NONE. A guessed datum puts the
  // drawing somewhere confident and wrong on someone else's map.
  const p33 = prjFor("EPSG:25833");
  ok("EPSG:25833 becomes ETRS89 / UTM 33N on the correct central meridian",
    p33.includes("ETRS89 / UTM zone 33N") && p33.includes('"central_meridian",15'));
  ok("EPSG:32633 becomes WGS 84 / UTM 33N, a different datum on the same meridian",
    prjFor("EPSG:32633").includes("WGS 84 / UTM zone 33N"));
  ok("a code the tool cannot state exactly returns null instead of guessing",
    prjFor("EPSG:99999") === null && prjFor(undefined) === null);

  const z = zipStore([{ name: "a.txt", data: new TextEncoder().encode("hello") }]);
  const zdv = new DataView(ab(z));
  ok("the zip has a local header, and an end-of-central-directory where it says",
    zdv.getUint32(0, true) === 0x04034b50 && zdv.getUint32(z.length - 22, true) === 0x06054b50);

  // The whole route, from a compiled drawing.
  const dem = makeDEM(24, 18, 2, (x, y) => 40 + x * 0.4 + Math.sin(y / 3) * 3,
    { originX: 654000, originY: 7730000, crs: "EPSG:25833", name: "plate.tif" });
  const drawing = compile({ dem, sym: { contours: { interval: 1 } } });
  const out = drawingToShapefiles(drawing, { stem: "plate", crs: dem.crs });
  ok("a compiled drawing becomes a shapefile set with a .prj",
    out.lines === drawing.paths.length && out.prj
    && out.files.some((f) => f.name === "plate-lines.shp")
    && out.files.some((f) => f.name === "plate-lines.shx")
    && out.files.some((f) => f.name === "plate-lines.dbf")
    && out.files.some((f) => f.name === "plate-lines.prj"),
    `${out.lines} lines vs ${drawing.paths.length} paths`);
  // ⚠️ THE POINT OF THE WHOLE FEATURE: the geometry must land back on the
  // ground it was sampled from, not on the sheet it was drawn on. A sheet
  // millimetre and a UTM metre differ by a factor of 200 and an origin of
  // 654,000 — an inverse that was dropped or applied twice is not subtle.
  const bb = out.bbox;
  const eX0 = dem.originX, eX1 = dem.originX + dem.ncols * dem.cell;
  const eY1 = dem.originY, eY0 = dem.originY - dem.nrows * dem.cell;
  ok("the exported extent is the raster's own extent, not the sheet's",
    bb[0] >= eX0 - 1 && bb[2] <= eX1 + 1 && bb[1] >= eY0 - 1 && bb[3] <= eY1 + 1
    && bb[2] - bb[0] > (eX1 - eX0) * 0.9 && bb[3] - bb[1] > (eY1 - eY0) * 0.9,
    `got [${bb.map((v) => v.toFixed(1)).join(", ")}] against `
    + `[${eX0}, ${eY0}, ${eX1}, ${eY1}]`);
  // ⚠️ The forward and inverse maps must compose to the identity, or every
  // export is quietly displaced.
  const sh = drawing.sheet;
  ok("sheet.invX/invY are the exact inverse of sheet.X/Y",
    Math.abs(sh.invX(sh.X(654123.5)) - 654123.5) < 1e-6
    && Math.abs(sh.invY(sh.Y(7730077.25)) - 7730077.25) < 1e-6);
  ok("every path carries the translation that made it, so QGIS can pull them apart",
    drawing.paths.every((p) => p.kind || p.furniture),
    drawing.paths.filter((p) => !p.kind && !p.furniture).length + " untagged");
}

// ── the tile boundary, the image, and the .prj ──────────────────────────────
group("engraving as an image, and the tile's own outline");
{
  // ⚠️ THE TILE BOUNDARY MUST CUT, WHATEVER THE FRAME SETTING SAYS. It used to
  // inherit the sheet frame's checkbox: with the frame off, the outline of the
  // clipped tile was written to DLF-99_sheet — the layer assigned to NO PASS.
  // The plate then engraved perfectly and never came out of the sheet, with
  // nothing on screen to say why, because DLF-99 draws on screen like anything
  // else. The frame governs the sheet's RECTANGLE; a clipped tile's boundary is
  // the shape of the part.
  const dem = makeDEM(20, 20, 2, (x, y) => 30 + x + y,
    { originX: 654000, originY: 7730000, crs: "EPSG:25833", name: "tile.tif" });
  // ⚠️ IN WORLD COORDINATES, NOT SHEET MILLIMETRES. `compile()` places the
  // boundary on the ground and converts it itself — that is what lets the same
  // boundary clip two plates drawn at different scales. Handing it sheet mm
  // puts the tile a few metres from the origin, where it overlaps nothing, and
  // the clip is then correctly REFUSED rather than applied.
  const ring = { pts: Float64Array.of(
    654010, 7729990, 654030, 7729990, 654030, 7729970, 654010, 7729970), hole: false };
  for (const frame of [true, false]) {
    const d = compile({ dem, sym: { sheet: { frame } }, clip: { rings: [ring], name: "tile" } });
    const boundary = d.paths.filter((p) => p.kind === "clip-boundary");
    ok(`the clip boundary is the outer cut with the frame ${frame ? "on" : "OFF"}`,
      boundary.length === 1 && boundary[0].layer === "DLF-05_cut_outer",
      boundary.map((b) => b.layer).join(", ") || "no boundary drawn");
    ok(`nothing from the clipped tile is left on the no-pass sheet layer (frame ${frame})`,
      !d.paths.some((p) => p.layer === "DLF-99_sheet" && p.kind === "clip-boundary"));
  }

  // ⚠️ GREY IS POWER. Two passes at the same grey are two operations arriving at
  // the same depth, which is exactly what handing a raster engraver the screen
  // palette would do — pure green and pure cyan are near-identical luminance.
  const greys = Object.values(ENGRAVE_GREY);
  ok("every pass gets its own engraving grey, and they climb with the operation",
    new Set(greys).size === greys.length
    && greys.every((v, i) => i === 0 || v > greys[i - 1]), greys.join(" "));

  // ⚠️ px = mm / 25.4 × dpi. A 900 mm sheet at 150 dpi is 5,315 px, and getting
  // this wrong scales the whole engraving against the material.
  const plan = rasterPlan({ width: 900, height: 700 }, { dpi: 150, strokeMM: 0.25 });
  ok("the image is the sheet's true size at the chosen dpi",
    plan.wPx === Math.round(900 / 25.4 * 150) && plan.hPx === Math.round(700 / 25.4 * 150),
    `${plan.wPx} × ${plan.hPx}`);
  // ⚠️ A LINE UNDER ~1.5 px RASTERISES TO PALE GREY, and pale grey is not a
  // faint line here — it is a line the machine barely burns.
  ok("a stroke below the resolution's floor is widened, and the widening is reported",
    plan.widened && Math.abs(plan.strokeMM - 1.5 / (150 / 25.4)) < 1e-9,
    `${plan.strokeMM.toFixed(4)} mm from ${plan.requestedMM}`);
  ok("a stroke already above the floor is left alone",
    !rasterPlan({ width: 100, height: 100 }, { dpi: 300, strokeMM: 0.5 }).widened);
  // ⚠️ AN OVERSIZED CANVAS COMES BACK BLANK RATHER THAN THROWING, so the refusal
  // has to happen before anything is allocated.
  const huge = rasterPlan({ width: 4000, height: 4000 }, { dpi: 300 });
  ok("an image past what a canvas will hold is refused, with the dpi that fits",
    !huge.ok && /dpi/.test(huge.refusal), huge.refusal || "accepted!");

  // ⚠️ THE CUT FILE AND THE IMAGE MUST DESCRIBE THE SAME SHEET, or the operator
  // engraves the field, swaps files, and cuts an outline that no longer sits
  // over it.
  const d2 = compile({ dem, sym: { sheet: { frame: true } } });
  const cut = cutLinesOnly(d2);
  ok("the cut file carries only passes that cut through",
    cut.paths.length > 0
    && cut.paths.every((p) => p.layer === "DLF-04_cut_inner" || p.layer === "DLF-05_cut_outer"),
    [...new Set(cut.paths.map((p) => p.layer))].join(", "));
  ok("the cut file keeps the drawing's own sheet, so it registers with the image",
    cut.sheet === d2.sheet);
  ok("the cut file invents nothing — every path in it came from the drawing",
    cut.paths.every((p) => d2.paths.includes(p)));

  // ⚠️ THE LAST AUTHORITY WINS. WKT nests AUTHORITY at every level — spheroid,
  // datum, prime meridian, unit — and the FIRST one belongs to whichever came
  // first, not to the coordinate system.
  const wkt = prjFor("EPSG:25833");
  ok("a .prj this tool wrote reads back as the code it was written from",
    readPRJ(wkt).epsg === "EPSG:25833", JSON.stringify(readPRJ(wkt)));
  ok("the CRS name survives even when there is no authority code at all",
    readPRJ('PROJCS["ETRS89 / UTM zone 33N",GEOGCS["ETRS89",DATUM["ETRS89",'
      + 'SPHEROID["GRS 1980",6378137,298.257222101]]]]').name === "ETRS89 / UTM zone 33N");
  ok("an inner AUTHORITY is not mistaken for the coordinate system's own",
    readPRJ('PROJCS["x",GEOGCS["y",DATUM["d",SPHEROID["GRS 1980",6378137,298.25,'
      + 'AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","6258"]]],AUTHORITY["EPSG","25833"]]')
      .epsg === "EPSG:25833");
  ok("an empty or unparseable .prj says nothing rather than guessing",
    readPRJ("").epsg === null && readPRJ("not wkt at all").epsg === null);
}

// ── GML — the same features, as XML ─────────────────────────────────────────
// ⚠️ GML IS NOT A FORMAT, IT IS A FRAMEWORK FOR WRITING FORMATS, so the checks
// here are about the traps rather than about coverage: the two spellings of a
// coordinate list, the Z that scrambles a line if it is not dropped, the axis
// order that puts a layer in the wrong hemisphere, and the registry version
// number that looks exactly like an EPSG code.
group("GML — geometry, attributes and the axis-order trap");
{
  const coll = (body, ns = "http://www.opengis.net/gml/3.2") =>
    `<gml:FeatureCollection xmlns:gml="${ns}" xmlns:ns="http://x">${body}</gml:FeatureCollection>`;

  const poly = readGML(coll(
    `<gml:featureMember><ns:Bed><ns:NAME>birch</ns:NAME><ns:COVER>40.5</ns:COVER>
      <ns:geom><gml:Polygon srsName="urn:ogc:def:crs:EPSG::25833">
       <gml:exterior><gml:LinearRing><gml:posList>654000 7730000 654100 7730000 654100 7730080 654000 7730080 654000 7730000</gml:posList></gml:LinearRing></gml:exterior>
       <gml:interior><gml:LinearRing><gml:posList>654030 7730030 654060 7730030 654060 7730050 654030 7730050 654030 7730030</gml:posList></gml:LinearRing></gml:interior>
      </gml:Polygon></ns:geom></ns:Bed></gml:featureMember>`), { name: "beds.gml" });
  ok("a GML3 polygon reads, and its interior ring is marked a hole",
    poly.layers.length === 1 && poly.layers[0].kind === "polygon"
    && poly.layers[0].rings.length === 2
    && poly.layers[0].rings.filter((r) => r.hole).length === 1,
    JSON.stringify(poly.layers.map((l) => `${l.kind}:${l.count}`)));
  ok("coordinates land exactly where the document put them",
    poly.layers[0].rings[0].pts[0] === 654000 && poly.layers[0].rings[0].pts[1] === 7730000);
  ok("srsName becomes the CRS, so a GML layer needs no .prj beside it",
    poly.crs === "EPSG:25833", String(poly.crs));
  // ⚠️ ONE ROW PER RING, because features.js reads rows[i] for ring i. A polygon
  // with a courtyard is one feature and two rings; pairing per FEATURE left
  // every attribute after the first hole pointing at the wrong shape.
  ok("attributes come across and are repeated across the feature's own rings",
    poly.layers[0].rows.length === poly.layers[0].rings.length
    && poly.layers[0].rows[0].NAME === "birch" && poly.layers[0].rows[1].COVER === 40.5,
    JSON.stringify(poly.layers[0].rows));
  ok("a numeric column is detected as numeric, so it can drive a symbol size",
    poly.layers[0].numeric.includes("COVER") && !poly.layers[0].numeric.includes("NAME"),
    JSON.stringify(poly.layers[0].numeric));

  // ⚠️ GML 2 WRITES COORDINATES AS COMMA-SEPARATED TUPLES in one text node.
  const g2 = readGML(coll(
    `<gml:featureMember><ns:Path><ns:TYPE>gravel</ns:TYPE>
      <gml:LineString srsName="EPSG:25833"><gml:coordinates>654000,7730000 654050,7730040 654090,7730090</gml:coordinates></gml:LineString>
     </ns:Path></gml:featureMember>`, "http://www.opengis.net/gml"), { name: "paths.gml" });
  ok("GML2 <coordinates> parses as well as GML3 <posList>",
    g2.layers[0].kind === "line" && g2.layers[0].rings[0].pts.length === 6
    && g2.layers[0].rings[0].pts[4] === 654090,
    Array.from(g2.layers[0].rings[0].pts).join(" "));

  // ⚠️ A 3D posList READ AS PAIRS IS SCRAMBLED, NOT SLIGHTLY WRONG: the second
  // point becomes (z, x) and the third (y, z). It still plots — as nonsense.
  const z = readGML(coll(
    `<gml:featureMember><ns:L><gml:LineString srsName="EPSG:25833">
      <gml:posList srsDimension="3">654000 7730000 12.5 654050 7730040 13.0 654090 7730090 14.2</gml:posList>
     </gml:LineString></ns:L></gml:featureMember>`), { name: "z.gml" });
  ok("srsDimension=3 drops the Z rather than scrambling the line",
    Array.from(z.layers[0].rings[0].pts).join(" ")
      === "654000 7730000 654050 7730040 654090 7730090",
    Array.from(z.layers[0].rings[0].pts).join(" "));

  // ⚠️ EPSG DEFINES 4326 LATITUDE FIRST and GML in urn form must honour it —
  // the commonest way a GML layer lands in the wrong hemisphere.
  const ll = readGML(coll(
    `<gml:featureMember><ns:P><gml:Point srsName="urn:ogc:def:crs:EPSG::4326">
      <gml:pos>69.65 18.95</gml:pos></gml:Point></ns:P></gml:featureMember>`), { name: "ll.gml" });
  ok("a latitude-first urn CRS is read northing-first and reported",
    ll.axisSwapped && ll.layers[0].points[0].x === 18.95 && ll.layers[0].points[0].y === 69.65
    && ll.notes.some((n) => /latitude-first/.test(n)),
    JSON.stringify(ll.layers[0].points[0]));
  ok("a PROJECTED urn CRS is NOT swapped — only the latitude-first ones are",
    poly.axisSwapped === false);

  // ⚠️ ONE FILE, SEVERAL GEOMETRY KINDS — which a shapefile cannot hold.
  const mix = readGML(coll(
    `<gml:featureMember><ns:A><gml:Point srsName="EPSG:25833"><gml:pos>654010 7730010</gml:pos></gml:Point></ns:A></gml:featureMember>
     <gml:featureMember><ns:B><gml:LineString><gml:posList>654000 7730000 654050 7730050</gml:posList></gml:LineString></ns:B></gml:featureMember>`),
    { name: "mix.gml" });
  ok("mixed geometry becomes one layer per kind, not one confused layer",
    mix.layers.length === 2 && new Set(mix.layers.map((l) => l.kind)).size === 2,
    JSON.stringify(mix.layers.map((l) => `${l.kind}:${l.count}`)));

  // ⚠️ THE LAST NUMBER WINS: `urn:x-ogc:def:crs:EPSG:6.6:25833` carries the EPSG
  // REGISTRY VERSION before the code, so taking the first returns "EPSG:6".
  ok("a urn carrying an EPSG registry version still yields the right code",
    parseSRS("urn:x-ogc:def:crs:EPSG:6.6:25833").epsg === "EPSG:25833",
    parseSRS("urn:x-ogc:def:crs:EPSG:6.6:25833").epsg);
  ok("the OGC http form and the plain form both parse",
    parseSRS("http://www.opengis.net/def/crs/EPSG/0/25833").epsg === "EPSG:25833"
    && parseSRS("EPSG:25833").epsg === "EPSG:25833");
  ok("no srsName gives null rather than a guessed CRS",
    parseSRS(undefined).epsg === null && parseSRS("").epsg === null);

  // ⚠️ NOTHING IS DROPPED IN SILENCE. A layer that quietly loses half its
  // features is worse than one that refuses.
  const bad = readGML(coll(
    `<gml:featureMember><ns:X><ns:NAME>no geometry here</ns:NAME></ns:X></gml:featureMember>`),
    { name: "bad.gml" });
  ok("features with no readable geometry are counted and reported, not skipped quietly",
    bad.unreadable === 1 && bad.notes.some((n) => /no geometry/.test(n)),
    JSON.stringify(bad.notes));
}

// ── data-defined overrides, and width as geometry ───────────────────────────
group("attributes driving the drawing, and a width that becomes an area");
{
  const sq = (x, y, w, h = w, hole = false) =>
    ({ pts: Float64Array.of(x, y, x + w, y, x + w, y + h, x, y + h), hole });
  const sheet = { width: 300, height: 300 };
  const fills = (r) => r.paths.filter((p) => !p.closed).length;
  const within = (p, x0, x1) => {
    for (let i = 0; i < p.length; i += 2) if (p[i] >= x0 && p[i] <= x1) return true;
    return false;
  };

  // ⚠️ THE ATTRIBUTE HAS TO REACH EVERY FEATURE, NOT JUST THE FIRST. This read
  // `rows[0]` and filled the whole layer as one region, so a bed at 5% cover
  // came out exactly as dense as one at 95% — measured at nine fill strokes
  // each. The field picker filled, the range filled from real data, and the
  // drawing was wrong in a way nothing on screen contradicted.
  const two = buildFeature({
    kind: "polygon", name: "beds", rings: [sq(10, 10, 40), sq(100, 10, 40)],
    rows: [{ COVER: 5 }, { COVER: 95 }],
    style: { pattern: "lines", spacingMM: 2, rotationDeg: 0, outline: false,
      densityBy: { field: "COVER", lo: 0, hi: 100, minMM: 0.8, maxMM: 5 } },
  }, { sheet });
  const left = two.paths.filter((p) => !p.closed && within(p.pts, 10, 50)).length;
  const right = two.paths.filter((p) => !p.closed && within(p.pts, 100, 140)).length;
  ok("density is read per FEATURE, not once for the layer",
    right > left * 2, `COVER 5 -> ${left} strokes, COVER 95 -> ${right}`);

  // ⚠️ AND THE HOLE IS STILL FILLED WITH ITS OWN OUTER. That is why the layer
  // was filled as one region in the first place: hatching ring by ring runs
  // straight across a courtyard and a pond inside a bed comes out planted.
  const court = buildFeature({
    kind: "polygon", name: "court", rings: [sq(10, 10, 80), sq(30, 30, 40, 40, true)],
    rows: [{ C: 1 }, { C: 1 }],
    style: { pattern: "lines", spacingMM: 3, rotationDeg: 0, outline: false },
  }, { sheet });
  ok("a hole is still respected, so a courtyard is not hatched over",
    court.paths.filter((p) => !p.closed).every((p) => {
      for (let i = 0; i < p.pts.length; i += 2) {
        if (p.pts[i] > 32 && p.pts[i] < 68 && p.pts[i + 1] > 32 && p.pts[i + 1] < 68) return false;
      }
      return true;
    }), `${fills(court)} fill strokes, none inside the hole`);

  // ⚠️ WIDTH IS MEANINGLESS OFF THE ENGRAVE PASS. A score or a cut is a path the
  // head follows once and its weight is the pass's power and speed; a width
  // there is a number the machine has nowhere to put.
  const line = { pts: Float64Array.of(10, 10, 90, 10), hole: false };
  const scored = buildFeature({ kind: "line", name: "p", rings: [line], rows: [{ W: 3 }],
    style: { pass: "DLF-02_score_medium", widthMM: 3, linetype: "solid" } }, { sheet });
  ok("a width on a score pass draws a plain line, not a band",
    scored.paths.length === 1 && !scored.paths[0].closed, `${scored.paths.length} paths`);

  // ⚠️ AND ON ENGRAVE IT BECOMES GEOMETRY. Defect 7 was a circle that previewed
  // solid and exported as an outline; a width held in a stroke attribute would
  // repeat it — visible in the preview, the SVG and the PNG, absent from the DXF.
  const band = buildFeature({ kind: "line", name: "p", rings: [line], rows: [{ W: 3 }],
    style: { pass: "DLF-00_engrave", widthMM: 3, pattern: "solid", spacingMM: 0.3 } },
  { sheet });
  ok("on the engrave pass a wide line becomes an outlined, filled band",
    band.paths.filter((p) => p.closed).length === 1 && fills(band) > 5
    && band.paths.every((p) => p.layer === "DLF-00_engrave"),
    `${band.paths.filter((p) => p.closed).length} outline, ${fills(band)} fill strokes`);

  // ⚠️ AND THE WIDTH ITSELF IS PER FEATURE.
  const wide = buildFeature({
    kind: "line", name: "p",
    rings: [{ pts: Float64Array.of(10, 10, 90, 10), hole: false },
      { pts: Float64Array.of(10, 60, 90, 60), hole: false }],
    rows: [{ W: 1 }, { W: 8 }],
    style: { pass: "DLF-00_engrave", widthMM: 2, pattern: "solid", spacingMM: 0.3,
      widthBy: { field: "W", lo: 0, hi: 10, minMM: 0.5, maxMM: 6 } },
  }, { sheet });
  const spanOf = (lo, hi) => {
    const p = wide.paths.find((q) => q.closed
      && (() => { for (let i = 1; i < q.pts.length; i += 2) if (q.pts[i] > lo && q.pts[i] < hi) return true; return false; })());
    let a = Infinity, b = -Infinity;
    for (let i = 1; i < p.pts.length; i += 2) { a = Math.min(a, p.pts[i]); b = Math.max(b, p.pts[i]); }
    return b - a;
  };
  const thin = spanOf(5, 20), thick = spanOf(55, 70);
  ok("the band's width comes from the attribute, feature by feature",
    Math.abs(thin - 1.05) < 0.3 && Math.abs(thick - 4.9) < 0.3,
    `W=1 -> ${thin.toFixed(2)} mm, W=8 -> ${thick.toFixed(2)} mm`);

  // ⚠️ A BAND IS AN AREA, and its area is what the arithmetic says.
  ok("a straight band's area is length x width, and a ring's is perimeter x width",
    Math.abs(bandArea(strokeBand([0, 0, 100, 0], 2, false)) - 200) < 0.01
    && Math.abs(bandArea(strokeBand([0, 0, 100, 0, 100, 100, 0, 100], 2, true)) - 800) < 8);
  ok("a reversed ring gives the same band, so winding cannot invert it",
    Math.abs(bandArea(strokeBand([0, 0, 0, 100, 100, 100, 100, 0], 2, true))
      - bandArea(strokeBand([0, 0, 100, 0, 100, 100, 0, 100], 2, true))) < 0.5);
  // ⚠️ A MITRE AT A SHARP CORNER RUNS AWAY TO INFINITY. A 1 mm band at a 5°
  // corner puts the point 23 mm off the line — burn time somewhere the drawing
  // does not go — so past the limit it bevels.
  // ⚠️ THE ROW CAP USED TO COUNT ROWS ACROSS THE DIAGONAL. A 2 mm band 800 mm
  // long has a 400 mm half-diagonal, so the cap believed it was about to draw
  // 2,667 rows when the band holds seven — and coarsened the spacing until ONE
  // was left. A wide engraved line came out as a hairline, and the warning
  // blamed the spacing. Rows step across the SHORT axis; that is what is capped.
  ok("a band's fill does not thin out as the band gets longer", (() => {
    const at = (L) => fillRegion(strokeBand([0, 0, L, 0], 2, false),
      { pattern: "solid", rotationDeg: 0, minLength: 0.2 }).strokes.length;
    const n = at(20);
    return n >= 5 && [100, 400, 800, 2000].every((L) => at(L) === n); })(),
    [20, 100, 400, 800, 2000].map((L) => fillRegion(strokeBand([0, 0, L, 0], 2, false),
      { pattern: "solid", rotationDeg: 0, minLength: 0.2 }).strokes.length).join(" "));
  // ⚠️ AND THE CAP STILL FIRES WHERE IT IS MEANT TO. It exists so a fine spacing
  // over a large area cannot hang the browser; removing its teeth would trade
  // one silent failure for a worse one.
  ok("a large area at a fine spacing is still capped, and says so", (() => {
    const big = [{ pts: Float64Array.of(0, 0, 500, 0, 500, 500, 0, 500), hole: false }];
    const f = fillRegion(big, { pattern: "solid", rotationDeg: 0, minLength: 0.2 });
    return f.capped && f.strokes.length < 450; })());
  // ⚠️ A BAND IS FILLED BY OFFSETTING IT, NOT BY SCANLINES. Straight scanlines
  // step across whatever extent the band has in their direction — for a RING
  // that is the whole polygon — so the row cap fires and the band stripes.
  // Measured on a 1.5 mm band round a 200x150 polygon: 782 scanline strokes at
  // 79% coverage, against 5 offset lines at 100%. And `echo`, which does follow
  // a boundary, rasterises at a cell sized from the whole region and cannot
  // resolve a 0.6 mm band at all — 0% coverage.
  ok("a ring band fills completely, and with lines rather than hundreds of strokes", (() => {
    const ring = [0, 0, 200, 0, 200, 150, 0, 150];
    const at = (w) => {
      const area = bandArea(strokeBand(ring, w, true));
      const f = bandFill(ring, w, 0.3, true);
      let ink = 0;
      for (const q of f) for (let i = 2; i < q.length; i += 2) {
        ink += Math.hypot(q[i] - q[i - 2], q[i + 1] - q[i - 1]);
      }
      return { lines: f.length, cover: ink * 0.3 / area };
    };
    const a = at(1.5), b = at(3);
    return a.lines <= 8 && a.cover > 0.98 && b.lines <= 12 && b.cover > 0.98; })(),
    JSON.stringify([1.5, 3].map((w) => bandFill([0, 0, 200, 0, 200, 150, 0, 150], w, 0.3, true).length)));

  // ⚠️ THE LINE COUNT IS floor(width / spacing), and cannot be otherwise. A band
  // 0.4 mm wide filled at 0.3 mm gets ONE line: a second would overlap the
  // first, and an overlap is a double burn. The shortfall is sub-spacing, and
  // real kerf closes it.
  ok("the fill line count follows width and spacing, and never overlaps", (() => {
    for (const [w, sp, want] of [[0.4, 0.3, 1], [0.6, 0.3, 2], [1.5, 0.3, 5], [3, 0.3, 10],
      [2, 0.5, 4], [0.2, 0.3, 1]]) {
      if (bandFill([0, 0, 100, 0], w, sp, false).length !== want) return false;
    }
    return true; })());
  ok("a hairpin bevels instead of throwing a spike", (() => {
    let far = 0;
    for (const r of strokeBand([0, 0, 100, 0, 0, 0.5], 2, false)) {
      for (let i = 0; i < r.pts.length; i += 2) far = Math.max(far, Math.abs(r.pts[i]));
    }
    return far < 110; })());

  // ⚠️ A DROPPED FEATURE MUST NOT SHIFT EVERY ROW AFTER IT. Rows are paired to
  // geometry BY ORDER; the line branch was asking for the row of "however many
  // have been drawn so far", which is the same number only until something is
  // skipped. One line off the edge of the sheet and every remaining line took
  // its neighbour's width — plausible output, no warning, and nothing on screen
  // to contradict it. This is defect 1 again, one branch along.
  ok("a line that falls off the sheet does not shift the rows of the ones after it", (() => {
    const away = { pts: Float64Array.of(-900, -900, -800, -900), hole: false };
    const here = { pts: Float64Array.of(10, 60, 90, 60), hole: false };
    const style = { pass: "DLF-00_engrave", widthMM: 2, pattern: "solid", spacingMM: 0.3,
      widthBy: { field: "W", lo: 0, hi: 10, minMM: 0.5, maxMM: 6 } };
    const spanY = (r) => {
      const q = r.paths.find((z) => z.closed);
      let a = Infinity, b = -Infinity;
      for (let i = 1; i < q.pts.length; i += 2) { a = Math.min(a, q.pts[i]); b = Math.max(b, q.pts[i]); }
      return b - a;
    };
    // The same line, the same row: once on its own, once behind a dropped one.
    const alone = buildFeature({ kind: "line", name: "p", rings: [here],
      rows: [{ W: 8 }], style }, { sheet });
    const behind = buildFeature({ kind: "line", name: "p", rings: [away, here],
      rows: [{ W: 1 }, { W: 8 }], style }, { sheet });
    return behind.report.dropped === 1 && Math.abs(spanY(alone) - spanY(behind)) < 0.01; })(),
    "the surviving line keeps its own row");

  // ⚠️ AND NEITHER MUST A RING THE FILTER THREW AWAY. A degenerate ring — two
  // points, a collapsed sliver — is dropped before the rings are grouped, and
  // the rows do not move with it, so every polygon after it read the row before
  // its own.
  ok("a degenerate ring does not shift the rows of the polygons after it", (() => {
    const runt = { pts: Float64Array.of(5, 5, 6, 5), hole: false };     // 4 numbers: dropped
    const style = { pattern: "lines", spacingMM: 2, rotationDeg: 0, outline: false,
      densityBy: { field: "COVER", lo: 0, hi: 100, minMM: 0.8, maxMM: 5 } };
    const alone = buildFeature({ kind: "polygon", name: "b", rings: [sq(100, 10, 40)],
      rows: [{ COVER: 95 }], style }, { sheet });
    const behind = buildFeature({ kind: "polygon", name: "b", rings: [runt, sq(100, 10, 40)],
      rows: [{ COVER: 5 }, { COVER: 95 }], style }, { sheet });
    return fills(alone) > 10 && fills(alone) === fills(behind); })(),
    "the surviving polygon keeps its own row");
}

// ── result ───────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(64)}`);
if (fail) {
  console.log(`FAILED  ${fail} of ${pass + fail}`);
  for (const f of F) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`PASSED  ${pass}/${pass} checks`);
}
