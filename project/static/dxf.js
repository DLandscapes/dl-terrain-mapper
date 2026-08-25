// @ts-check
// DXF OUT — the file the laser software actually opens.
//
// ⚠️ THE LAYER SCHEME IS NOT OURS TO INVENT. These six pass layers, their
// names, their ACI numbers and their true colours are copied exactly from
// DL-TerrainSlicer (slicer/dxfout.py), which took them from the Grasshopper
// original (DL-Contour_offset_method_011.gh) so that laser configurations set
// up in Trotec JobControl keep working without being rebuilt. A drawing from
// this tool and a drawing from the slicer must drop into the same job. If a
// layer is renamed here, somebody's saved pass configuration silently sends
// engraving power to a cut line, on material, at the machine. Do not rename.
//
// ⚠️ ASCII ONLY, AND NO EXPONENTS. Two separate hard-won facts about laser
// front-ends, both of which produce a file that opens fine in a CAD viewer and
// fails at the machine. Group codes and values are written as plain ASCII with
// no BOM; and every number goes through `num()`, which never emits "1e-7",
// because a parser that reads coordinates with `atof` on a hand-rolled importer
// stops at the "e" and places the geometry at the origin.
//
// ⚠️ R12 (AC1009), DELIBERATELY. The sibling tool writes R2010 through ezdxf,
// which has a library to keep handles, classes and the objects section
// consistent. Written by hand, that bookkeeping is a source of silent
// corruption. R12 needs none of it — no handles, no OBJECTS section — and every
// laser front-end and CAD package still reads it. The one thing R12 costs is
// LWPOLYLINE, so paths are POLYLINE/VERTEX/SEQEND, which is more verbose in the
// file and identical on the bed.

/** name, ACI colour, true colour — pass order 0..5, cut LAST. */
export const DLF_LAYERS = [
  ["DLF-00_engrave", 7, [0, 0, 0]],           // engraved fills, halftone       black
  ["DLF-01_score_light", 5, [0, 0, 255]],     // (A) labels                     blue
  ["DLF-02_score_medium", 3, [0, 255, 0]],    // (B) intermediate contours      green
  ["DLF-03_score_strong", 4, [0, 255, 255]],  // graphics, index contours       cyan
  ["DLF-04_cut_inner", 6, [255, 0, 255]],     // (C) inner cut lines            magenta
  ["DLF-05_cut_outer", 1, [255, 0, 0]],       // (D) sheet outline, last pass   red
];
export const SHEET_LAYER = ["DLF-99_sheet", 8, [128, 128, 128]];  // never cut

/** The names, for anything that needs to offer a choice. */
export const LAYER_NAMES = [...DLF_LAYERS.map((l) => l[0]), SHEET_LAYER[0]];

/**
 * The colour a pass DECLARES, as CSS. The preview reads this.
 *
 * ⚠️ THERE IS ONE COLOUR TABLE AND THIS IS IT. The preview used to carry its
 * own, tuned for legibility on a white screen — `#00a000` where the file says
 * `(0,255,0)`, `#00a0a0` where it says `(0,255,255)`, and so on for four of the
 * seven. Marc spotted it: "the green in the display does not look like RGB
 * green." He was right, and the drift is the whole problem in miniature — this
 * tool's one promise is that the preview IS the file, and a preview that
 * repaints the passes in nicer colours has already broken it. If a pass is hard
 * to see on paper-white, that is a fact about the pass, and the answer is line
 * weight, not a second palette.
 */
export const PASS_COLOURS = Object.fromEntries(
  [...DLF_LAYERS, SHEET_LAYER].map(([name, , rgb]) =>
    [name, `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`]));

/** A pass's declared colour, or black for a name that is not one. */
export const passColour = (layer) => PASS_COLOURS[layer] || "#000000";

/** Short human labels for the six passes, for a picker. */
export const PASS_LABELS = {
  "DLF-00_engrave": "0 · engrave (black)",
  "DLF-01_score_light": "1 · score light (blue)",
  "DLF-02_score_medium": "2 · score medium (green)",
  "DLF-03_score_strong": "3 · score strong (cyan)",
  "DLF-04_cut_inner": "4 · cut inner (magenta)",
  "DLF-05_cut_outer": "5 · cut outer (red)",
};

/**
 * A number, ASCII, never in exponent form.
 *
 * Six decimals is far below any laser's positioning resolution (a good machine
 * repeats to about 0.01 mm) and keeps the file readable. Trailing zeros go
 * because a 40 MB file of "12.340000" is 40 MB of nothing.
 * @param {number} v
 */
export function num(v) {
  if (!Number.isFinite(v)) return "0";
  // ⚠️ toFixed IS NOT AN EXPONENT-FREE GUARANTEE. At 1e21 and above it gives up
  // and returns exponential notation regardless of the digits asked for, which
  // is precisely the form this function exists to prevent. Nothing sane places
  // a coordinate there — it is a symptom of a projection gone wrong upstream —
  // but the promise is either kept for every input or it is not a promise, and
  // a parser meeting "1.2e+21" drops the geometry at the origin without saying so.
  if (Math.abs(v) >= 1e21) return BigInt(Math.trunc(v)).toString();
  let s = v.toFixed(6);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

/**
 * A DXF being built. Coordinates are SHEET MILLIMETRES, y up, origin at the
 * sheet's lower left — the frame every laser front-end expects.
 */
export class DXF {
  constructor() {
    /** @type {string[]} */
    this.body = [];
    this.minX = Infinity; this.minY = Infinity;
    this.maxX = -Infinity; this.maxY = -Infinity;
    this.counts = { polyline: 0, circle: 0, vertices: 0 };
  }

  /** @param {string} code @param {string|number} value */
  g(code, value) { this.body.push(code, String(value)); return this; }

  /** @param {number} x @param {number} y */
  _seen(x, y) {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  /**
   * One continuous path. THE entity this tool exists to write.
   *
   * ⚠️ A PATH OF FEWER THAN TWO POINTS IS DROPPED, NOT WRITTEN. A one-point
   * POLYLINE is legal DXF and, at the machine, a pierce that burns a hole and
   * moves on. Every such scrap costs material and time and none of them draw
   * anything, so they are refused at the only place that can refuse them all.
   *
   * @param {Float64Array|number[]} pts x,y interleaved, sheet mm
   * @param {string} layer @param {{closed?:boolean}} [o]
   */
  polyline(pts, layer, o = {}) {
    const n = pts.length / 2;
    if (n < 2) return this;
    const closed = !!o.closed;
    this.g(0, "POLYLINE").g(8, layer).g(66, 1).g(70, closed ? 1 : 0)
      .g(10, "0").g(20, "0").g(30, "0");
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      this._seen(x, y);
      this.g(0, "VERTEX").g(8, layer).g(10, num(x)).g(20, num(y)).g(30, "0");
      this.counts.vertices++;
    }
    this.g(0, "SEQEND").g(8, layer);
    this.counts.polyline++;
    return this;
  }

  /**
   * A true circle.
   *
   * ⚠️ NOT A POLYGONISED ONE. A halftone sheet carries thousands of these; as
   * 24-sided polylines that is a file tens of megabytes long and a bed full of
   * visibly faceted dots. CIRCLE is eight lines in the file and the controller
   * interpolates a real arc.
   * @param {number} cx @param {number} cy @param {number} r @param {string} layer
   */
  circle(cx, cy, r, layer) {
    if (!(r > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) return this;
    this._seen(cx - r, cy - r); this._seen(cx + r, cy + r);
    this.g(0, "CIRCLE").g(8, layer)
      .g(10, num(cx)).g(20, num(cy)).g(30, "0").g(40, num(r));
    this.counts.circle++;
    return this;
  }

  /** Several paths onto one layer. @param {Array<Float64Array|number[]>} paths */
  paths(paths, layer, o = {}) {
    for (const p of paths) this.polyline(p, layer, o);
    return this;
  }

  /** An axis-aligned rectangle, closed. */
  rect(x0, y0, x1, y1, layer) {
    return this.polyline([x0, y0, x1, y0, x1, y1, x0, y1], layer, { closed: true });
  }

  /** The finished file, as text. */
  toString() {
    const h = [];
    const g = (c, v) => h.push(String(c), String(v));
    g(0, "SECTION"); g(2, "HEADER");
    g(9, "$ACADVER"); g(1, "AC1009");
    // Millimetres. R12 predates $INSUNITS, but importers that understand it use
    // it and those that do not skip an unknown header variable, so stating the
    // unit costs nothing and prevents a drawing arriving at 1/25.4 scale.
    g(9, "$INSUNITS"); g(70, 4);
    g(9, "$MEASUREMENT"); g(70, 1);
    const has = Number.isFinite(this.minX);
    g(9, "$EXTMIN"); g(10, num(has ? this.minX : 0)); g(20, num(has ? this.minY : 0)); g(30, "0");
    g(9, "$EXTMAX"); g(10, num(has ? this.maxX : 0)); g(20, num(has ? this.maxY : 0)); g(30, "0");
    g(0, "ENDSEC");

    g(0, "SECTION"); g(2, "TABLES");
    // ⚠️ THE LINETYPE TABLE IS NOT OPTIONAL. Every layer below names CONTINUOUS,
    // and a strict reader that cannot resolve the name rejects the whole file.
    g(0, "TABLE"); g(2, "LTYPE"); g(70, 1);
    g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0);
    g(3, "Solid line"); g(72, 65); g(73, 0); g(40, "0");
    g(0, "ENDTAB");
    const layers = [...DLF_LAYERS, SHEET_LAYER];
    g(0, "TABLE"); g(2, "LAYER"); g(70, layers.length);
    for (const [name, aci] of layers) {
      g(0, "LAYER"); g(2, name); g(70, 0); g(62, aci); g(6, "CONTINUOUS");
    }
    g(0, "ENDTAB");
    g(0, "ENDSEC");

    g(0, "SECTION"); g(2, "ENTITIES");
    // ⚠️ CRLF, and a trailing newline. DXF is a line-oriented format and the
    // older front-ends split on CRLF; a lone LF leaves the group code and its
    // value on one line as far as they are concerned.
    return [...h, ...this.body, "0", "ENDSEC", "0", "EOF"].join("\r\n") + "\r\n";
  }

  /** The file as bytes, for a download. Latin-1 clean by construction. */
  toBytes() {
    return new TextEncoder().encode(this.toString());
  }
}
