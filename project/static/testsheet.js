// @ts-check
// THE MATERIAL TEST SHEET — the one drawing that is not about a site.
//
// Every label size, dash pattern and halftone density in this tool is currently
// a guess with a good justification. This sheet turns them into measurements.
// It answers four questions that only a machine and a piece of material can
// answer, and it is the drawing to cut FIRST on any material the tool has not
// been used on before.
//
//   A · How small can an engraved figure be before it fills in?
//   B · Which dash patterns survive at contour scale, and on a curve?
//   C · Is the DXF's pass mapping wired to the operations you think it is?
//   D · What is the smallest halftone dot that reads as a mark, not a hole?
//
// ⚠️ IT IS BUILT FROM THE TOOL'S OWN PARTS — the same `stroke-font.js`, the same
// `linestyle.js` dash engine, the same `dxf.js` writer, the same pass layers. A
// test sheet drawn by separate code measures the test sheet. Every figure on
// this one is produced by the code that will produce the real drawing, so the
// number you read off it transfers directly.
//
// ⚠️⚠️ NOTHING CUTS THROUGH EXCEPT ONE SMALL, LABELLED COUPON. The sheet outline
// is on DLF-99_sheet, which is a boundary and not an operation, so a first run
// on unfamiliar material is engrave-and-score only: it cannot drop parts, cannot
// pull focus, and leaves the coupon in one piece to be handled and read. The cut
// test is an 18 mm square in the corner, on the real cut passes, so that side of
// the mapping is verified too — deliberately, visibly, and small.

import { textStrokes, measure } from "./stroke-font.js";
import { applyStyle, LINE_STYLES, STYLE_ORDER } from "./linestyle.js";
import { OPERATIONS } from "./compile.js";

/** Cap heights to test, in mm, bracketing the tool's 2.2 mm default. */
export const TYPE_LADDER = [1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.6, 3.0, 3.5, 4.0];

/** Halftone dot diameters, mm. The tool's own smallest mark is about 0.3. */
export const DOT_LADDER = [0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.2, 1.6, 2.0, 2.6];

/**
 * Build the sheet.
 *
 * @param {{material?:string, date?:string, machine?:string, width?:number,
 *          height?:number, cutTest?:boolean}} [o]
 * @returns {import("./compile.js").Drawing}
 */
export function buildTestSheet(o = {}) {
  const W = o.width ?? 200;
  const H = o.height ?? 150;
  const material = o.material || "____________________";
  const machine = o.machine || "Trotec SP500";
  const date = o.date || "";
  const cutTest = o.cutTest !== false;

  const paths = [];
  const circles = [];
  const warnings = [];
  const add = (pts, layer, closed = false) => {
    if (pts && pts.length >= 4) paths.push({ pts, layer, closed });
  };
  /** Engraved text, on the label pass, exactly as a contour label is drawn. */
  const label = (t, x, y, size, opts = {}) => {
    for (const st of textStrokes(t, { x, y, size, tracking: 6, ...opts })) {
      add(st, opts.layer || OPERATIONS.contourLabel);
    }
  };
  const rule = (x0, y0, x1, y1, layer) => add([x0, y0, x1, y1], layer || OPERATIONS.furniture);

  // ── identity ─────────────────────────────────────────────────────────────
  // ⚠️ THE SHEET SAYS WHAT IT IS. A coupon found on a bench three weeks later
  // with no material, machine or date on it is a coupon that has to be cut
  // again. It is engraved, not written, because the pen would be a second
  // process nobody does.
  let y = H - 8;
  label("DL-TERRAINMAPPER  MATERIAL TEST", 8, y, 3.2, { tracking: 10 });
  y -= 5.5;
  label(`MATERIAL ${material}`, 8, y, 2, { tracking: 8 });
  label(machine.toUpperCase(), W - 8, y, 2, { tracking: 8, anchor: "end" });
  if (date) { y -= 4; label(date, W - 8, y, 2, { tracking: 8, anchor: "end" }); }
  y -= 4;
  rule(8, y, W - 8, y);
  y -= 7;

  // ── A · the type ladder, the number this sheet exists for ───────────────
  label("A  SMALLEST READABLE FIGURE", 8, y, 2.2, { tracking: 9 });
  y -= 5;
  label("read from the top down; the answer is the last line you can still read", 8, y, 1.6,
    { tracking: 5 });
  y -= 6;
  // ⚠️ THE SAMPLE IS A REAL CONTOUR LABEL, not "Abc" or a row of eights. The
  // glyphs that decide legibility here are the ones the tool actually engraves:
  // digits, a decimal point, and a minus for ground below datum.
  for (const size of TYPE_LADDER) {
    const s = `${size.toFixed(1)}`;
    label(`${s}`, 8, y - size, 1.6, { tracking: 5 });            // the ruler mark
    label("77.5", 20, y - size, size);
    label("104.25", 38, y - size, size);
    label("-3.0", 62, y - size, size);
    y -= size + 2.4;
  }
  y -= 2;
  rule(8, y, 88, y);

  // ── B · line styles, straight and curved ────────────────────────────────
  let by = H - 34;
  const bx = 96;
  label("B  LINE STYLES", bx, by, 2.2, { tracking: 9 });
  by -= 5;
  label("each on the contour pass, straight and on a 12 mm radius", bx, by, 1.6, { tracking: 5 });
  by -= 7;
  for (const key of STYLE_ORDER) {
    const def = LINE_STYLES[key];
    label(def.label, bx, by - 1, 1.8, { tracking: 5 });
    const straight = { pts: new Float64Array([bx + 34, by, bx + 70, by]), closed: false };
    for (const p of applyStyle([straight], key).paths) add(p, OPERATIONS.contourIntermediate);
    // ⚠️ A CURVE IS TESTED TOO. A dash pattern that reads on a straight line can
    // disintegrate on a contour's curvature, which is all a contour ever is.
    const arc = [];
    for (let i = 0; i <= 40; i++) {
      const a = Math.PI * (0.15 + 0.7 * (i / 40));
      arc.push(bx + 84 + 12 * Math.cos(a), by - 6 + 12 * Math.sin(a));
    }
    for (const p of applyStyle([{ pts: new Float64Array(arc), closed: false }], key).paths) {
      add(p, OPERATIONS.contourIntermediate);
    }
    by -= 9;
  }

  // ── C · the pass check ──────────────────────────────────────────────────
  // ⚠️ THIS IS THE ONE THAT PREVENTS AN EXPENSIVE MISTAKE. It confirms that the
  // pass named in the file is the operation the machine performs. If the strip
  // marked "02 SCORE MEDIUM" comes back cut through, the JobControl mapping is
  // wrong and no model should be run until it is fixed.
  let cy = by - 8;
  label("C  PASS CHECK", bx, cy, 2.2, { tracking: 9 });
  cy -= 5;
  label("each strip is drawn on the pass it names", bx, cy, 1.6, { tracking: 5 });
  cy -= 6;
  const passStrips = [
    ["00 ENGRAVE", OPERATIONS.halftone],
    ["01 SCORE LIGHT", OPERATIONS.contourLabel],
    ["02 SCORE MEDIUM", OPERATIONS.contourIntermediate],
    ["03 SCORE STRONG", OPERATIONS.contourIndex],
  ];
  for (const [name, layer] of passStrips) {
    label(name, bx, cy - 0.8, 1.8, { tracking: 5, layer });
    // ⚠️ THESE STOP WELL SHORT OF THE CUT COUPON. At their first length they ran
    // to x = 166 and the coupon began at x = 162: the engrave strip crossed into
    // a square that gets cut out, which would have severed the strip and carried
    // half of it away on the dropped piece — destroying both readings at once.
    add([bx + 34, cy, bx + 54, cy], layer);
    add([bx + 34, cy + 1.6, bx + 54, cy + 1.6], layer);
    cy -= 6;
  }

  // ── D · halftone dots ───────────────────────────────────────────────────
  let dy = y - 8;
  label("D  SMALLEST HALFTONE DOT", 8, dy, 2.2, { tracking: 9 });
  dy -= 5;
  label("the answer is the first circle that is a ring, not a filled hole", 8, dy, 1.6,
    { tracking: 5 });
  dy -= 9;
  let dx = 10;
  for (const d of DOT_LADDER) {
    circles.push({ cx: dx, cy: dy, r: d / 2, layer: OPERATIONS.halftone });
    label(d.toFixed(1), dx, dy - 6, 1.4, { tracking: 4, anchor: "middle" });
    dx += Math.max(7, d + 5.5);
  }

  // ── E · the cut coupon, small and labelled ──────────────────────────────
  if (cutTest) {
    const cx0 = W - 26, cy0 = 9;
    label("E  CUT TEST", cx0 - 4, cy0 + 30, 2, { tracking: 8 });
    label("04 inner drops out", cx0 - 4, cy0 + 26, 1.4, { tracking: 4 });
    label("05 outer frees it", cx0 - 4, cy0 + 22.5, 1.4, { tracking: 4 });
    // ⚠️ THE LABELS SIT ABOVE THE OUTER CUT, NOT INSIDE IT. Anything engraved
    // between the two squares leaves on the ring when pass 05 runs, so the marks
    // that say which pass did what would walk off the sheet with the offcut.
    // inner cut: a 10 mm square that should drop out
    add([cx0, cy0, cx0 + 10, cy0, cx0 + 10, cy0 + 10, cx0, cy0 + 10],
      OPERATIONS.photoMark, true);
    // outer cut: a 18 mm square around it, run last
    add([cx0 - 4, cy0 - 4, cx0 + 14, cy0 - 4, cx0 + 14, cy0 + 14, cx0 - 4, cy0 + 14],
      OPERATIONS.sheetFrame, true);
  } else {
    warnings.push("The cut coupon is switched off: this sheet only engraves and scores. "
      + "Nothing verifies passes 4 and 5.");
  }

  // ── the boundary, which is NOT an operation ─────────────────────────────
  // ⚠️ ON DLF-99_sheet ON PURPOSE. A first run on unfamiliar material must not
  // drop the coupon out of the sheet: a part that falls mid-job can lift, catch
  // the head, and ruins the very reading the sheet was cut to take.
  add([0, 0, W, 0, W, H, 0, H], OPERATIONS.sheetBounds, true);

  warnings.push("Cut this before trusting any label size on a material the tool has not been "
    + "used on. The smallest readable line in block A is the floor for `labelSize`.");
  if (cutTest) {
    warnings.push("Block E cuts through. Check the material is clear beneath and that passes 4 "
      + "and 5 are the ones you intend before running it.");
  }

  return {
    paths, circles,
    sheet: { scale: 1, mmPerUnit: 1, margin: 0, width: W, height: H, drawW: W, drawH: H,
      X: (x) => x, Y: (yy) => yy, L: (d) => d },
    warnings,
    report: {
      raster: { name: "material test sheet", size: `${W} × ${H} mm`, cell: 1,
        crs: "none — this drawing is not georeferenced", z: "n/a", measured: "n/a" },
      sheet: { scale: "1:1", size: `${W} × ${H} mm`, ground: "n/a" },
      contours: null, photos: null, halftone: null,
      contourLayers: [],
      testSheet: {
        material, machine, date,
        typeLadder: TYPE_LADDER.join(", "),
        dotLadder: DOT_LADDER.join(", "),
        styles: STYLE_ORDER.length,
        cutTest,
      },
      totals: { paths: paths.length, circles: circles.length,
        vertices: paths.reduce((a, p) => a + p.pts.length / 2, 0) },
    },
  };
}

/** The procedure, as a plain-text sheet to keep with the coupon. */
export function testSheetProcedure(drawing) {
  const t = drawing.report.testSheet;
  return [
    "DL-TerrainMapper — material test sheet",
    t.date ? `date:     ${t.date}` : "date:     ____________",
    `material: ${t.material}`,
    `machine:  ${t.machine}`,
    "",
    "SETTINGS USED (fill in before running, keep with the coupon)",
    "  pass                  power   speed   ppi/Hz   passes",
    "  00 engrave            _____   _____   ______   ______",
    "  01 score light        _____   _____   ______   ______",
    "  02 score medium       _____   _____   ______   ______",
    "  03 score strong       _____   _____   ______   ______",
    "  04 cut inner          _____   _____   ______   ______",
    "  05 cut outer          _____   _____   ______   ______",
    "",
    "⚠ DLF-99_sheet is the sheet boundary. It must NOT be assigned to any pass.",
    "  On this sheet only block E cuts through; everything else engraves or scores.",
    "",
    "WHAT TO READ OFF IT",
    "",
    "A · Smallest readable figure",
    `    Cap heights tested: ${t.typeLadder} mm.`,
    "    Read the column from the top down. The last line where 104.25 is still",
    "    unambiguous is the legibility floor for this material.",
    "    → put that number into Properties ▸ Labels ▸ Size, and never go below it.",
    "    The tool currently defaults to 2.2 mm, which is a guess until this is read.",
    "",
    "B · Line styles",
    `    All ${t.styles} styles, straight and on a 12 mm radius.`,
    "    Note which patterns still read on the CURVE — a contour is never straight.",
    "    Dotted and dash-dot are the ones that usually fail first.",
    "",
    "C · Pass check",
    "    Each strip is drawn on the pass it names.",
    "    ⚠ If a strip marked SCORE comes back cut through, the JobControl mapping is",
    "      wrong. Stop and fix it before running any model.",
    "",
    "D · Smallest halftone dot",
    `    Diameters: ${t.dotLadder} mm.`,
    "    The answer is the smallest circle that reads as a RING rather than a filled",
    "    hole. Below that, a halftone will burn through instead of marking.",
    "    → that is the floor for the halftone's minimum mark.",
    "",
    t.cutTest
      ? "E · Cut test\n    The 10 mm square (pass 04) should drop out; the 20 mm square (pass 05)\n    releases the coupon. Check kerf on the dropped square with callipers."
      : "E · Cut test — SWITCHED OFF for this sheet. Passes 4 and 5 are unverified.",
    "",
    "AFTERWARDS",
    "  Write the two numbers — smallest figure, smallest dot — on the coupon itself",
    "  and keep it. A material tested once should not need testing again.",
    "",
  ].join("\n") + "\n";
}
