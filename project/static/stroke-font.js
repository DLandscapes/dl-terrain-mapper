// @ts-check
// A SINGLE-STROKE FONT — because an engraved number is a PATH, not a shape.
//
// ⚠️ THIS IS THE WHOLE REASON THE FILE EXISTS, AND IT IS NOT OBVIOUS. Every
// font on the machine is an OUTLINE font: the letter "8" is two closed loops
// describing the boundary of the ink, and a renderer fills between them. Give
// those loops to a laser and it does the only thing it can — it CUTS ROUND THE
// EDGE of the digit, so an 8 becomes a hole with two discs falling out of it,
// and at label size the discs are dust. What is wanted is the skeleton: the
// path a pen would take. That is a single-stroke (engineering, stick, Hershey)
// font, and it has to be carried by the tool because the operating system does
// not have one.
//
// ⚠️ COORDINATES ARE 0..100 ON THE CAP HEIGHT, baseline at y = 0, y UP. Glyphs
// are authored at a readable size and scaled at the point of use, so the
// hinting question — how small can this be before it fills in — is answered
// once, in millimetres, by the material test sheet rather than per glyph here.
//
// ⚠️ DESCENDERS GO BELOW ZERO and the comma uses it. Anything measuring a text
// block must use `measure()`, which reports the real ink bounds, rather than
// assuming 0..100.

/** Advance width in the same 0..100 units, including the side bearing. */
const ADVANCE = 65;
const ADVANCE_SPACE = 42;

// Strokes are authored as terse point lists: "x,y x,y x,y", several strokes
// separated by "|". Terse on purpose — a table this size written as nested
// arrays is unreadable, and unreadable glyph data is glyph data nobody fixes.
const GLYPHS = {
  "0": "5,25 5,75 25,100 45,75 45,25 25,0 5,25",
  "1": "8,78 25,100 25,0|8,0 42,0",
  "2": "5,78 25,100 45,78 45,62 5,0 45,0",
  "3": "5,85 25,100 45,85 45,68 27,57|27,57 45,45 45,15 25,0 5,13",
  "4": "36,0 36,100 5,32 45,32",
  "5": "45,100 8,100 6,56 25,64 45,48 45,15 25,0 5,13",
  "6": "45,82 25,100 8,72 5,25 25,0 45,20 45,40 25,55 7,47",
  "7": "5,100 45,100 20,0",
  "8": "25,55 8,68 8,87 25,100 42,87 42,68 25,55 8,42 5,15 25,0 45,15 42,42 25,55",
  "9": "5,18 25,0 42,28 45,75 25,100 8,75 8,58 25,45 45,58",
  A: "5,0 25,100 45,0|13,35 37,35",
  B: "8,0 8,100 33,100 45,85 45,63 30,52 8,52|30,52 45,40 45,15 33,0 8,0",
  C: "45,80 28,100 12,85 8,55 8,40 12,18 28,0 45,20",
  D: "8,0 8,100 28,100 43,80 45,45 30,0 8,0",
  E: "45,100 8,100 8,0 45,0|8,52 36,52",
  F: "45,100 8,100 8,0|8,52 36,52",
  G: "45,80 28,100 12,85 8,55 8,40 12,18 28,0 45,18 45,45 28,45",
  H: "8,100 8,0|45,100 45,0|8,52 45,52",
  I: "25,100 25,0|10,100 40,100|10,0 40,0",
  J: "40,100 40,22 30,2 15,2 6,20",
  K: "8,100 8,0|45,100 10,45|22,60 45,0",
  L: "8,100 8,0 45,0",
  M: "5,0 5,100 25,45 45,100 45,0",
  N: "8,0 8,100 45,0 45,100",
  O: "8,30 8,70 25,100 42,70 42,30 25,0 8,30",
  P: "8,0 8,100 33,100 45,85 45,65 33,50 8,50",
  Q: "8,30 8,70 25,100 42,70 42,30 25,0 8,30|30,20 47,-8",
  R: "8,0 8,100 33,100 45,85 45,65 33,50 8,50|30,50 45,0",
  S: "45,85 28,100 12,90 10,68 40,45 42,20 28,0 8,15",
  T: "5,100 45,100|25,100 25,0",
  U: "8,100 8,25 22,0 32,0 45,25 45,100",
  V: "5,100 25,0 45,100",
  W: "3,100 14,0 25,60 36,0 47,100",
  X: "6,100 45,0|45,100 6,0",
  Y: "6,100 25,52 45,100|25,52 25,0",
  Z: "6,100 45,100 6,0 45,0",
  // ⚠️ THE FULL STOP IS A CLOSED SQUARE, NOT A ZERO-LENGTH STROKE. A single
  // point is a pierce with no travel: the laser dwells, burns through, and the
  // decimal point on "77.5" becomes a hole while the digits stay crisp. A tiny
  // closed path gives the head somewhere to go and burns like the rest.
  ".": "22,0 30,0 30,8 22,8 22,0",
  ",": "30,8 30,0 22,0 22,8 30,8 24,-12",
  "-": "8,50 42,50",
  "+": "8,50 42,50|25,33 25,67",
  "/": "5,0 45,100",
  ":": "22,18 30,18 30,26 22,26 22,18|22,60 30,60 30,68 22,68 22,60",
  "(": "35,100 15,70 15,30 35,0",
  ")": "15,100 35,70 35,30 15,0",
  "°": "16,78 16,92 30,92 30,78 16,78",
  "×": "12,72 38,36|38,72 12,36",
  " ": "",
};

// ── lettering styles ─────────────────────────────────────────────────────────
// ⚠️ ONE SKELETON, SEVERAL DRESSES — NEVER A SECOND OUTLINE FONT. Every style
// here is an affine transform of the same glyph table: a width factor and a
// shear. That is the only kind of "font choice" a single-stroke face can offer
// honestly — a different TYPEFACE would mean a second hand-authored table, and
// an outline font from the OS stays banned for the reason at the top of this
// file (a laser cuts round the ink and drops the counters out as dust).
export const LETTERINGS = {
  regular:   { label: "Regular",   sx: 1,    slant: 0 },
  condensed: { label: "Condensed", sx: 0.82, slant: 0 },
  wide:      { label: "Wide",      sx: 1.25, slant: 0 },
  slanted:   { label: "Slanted",   sx: 1,    slant: 0.2 },
};

// ⚠️ MODULE STATE, SET ONCE PER COMPILE. The compiler sets this from the
// symbology before it draws anything, so every caller of textStrokes — labels,
// furniture, region numbers, the test sheet — letters the same way without
// each call site threading a style through. Geometry already emitted is baked;
// changing the style never reaches an existing Drawing.
let STYLE = LETTERINGS.regular;

/** Choose the lettering for everything set after this call. @param {string} name */
export function setLettering(name) {
  STYLE = LETTERINGS[name] || LETTERINGS.regular;
}

/** @type {Map<string, number[][]>} parsed once, on first use */
const CACHE = new Map();

/** @param {string} ch @returns {number[][]} strokes, each x,y,x,y,… */
function strokes(ch) {
  let s = CACHE.get(ch);
  if (s) return s;
  const src = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? null;
  if (src === null) { CACHE.set(ch, []); return []; }
  s = src === "" ? [] : src.split("|").map((run) =>
    run.trim().split(/\s+/).flatMap((p) => p.split(",").map(Number)));
  CACHE.set(ch, s);
  return s;
}

/** True when the font can draw this character at all. @param {string} ch */
export const hasGlyph = (ch) => ch === " " || (GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()]) !== undefined;

/** Advance of one character in 0..100 units. @param {string} ch */
export const advance = (ch) => (ch === " " ? ADVANCE_SPACE : ADVANCE);

/**
 * Set a string as stroke paths.
 *
 * @param {string} text
 * @param {{x?:number, y?:number, size?:number, angle?:number,
 *          anchor?:"start"|"middle"|"end", baseline?:"base"|"middle"|"cap",
 *          tracking?:number}} [o]
 *   `size` is the CAP HEIGHT in output units (mm on a sheet). `angle` is
 *   radians, counter-clockwise. `tracking` adds to every advance, in 0..100
 *   units, for the wider spacing small engraved text wants.
 * @returns {Float64Array[]} one path per stroke, x,y interleaved
 */
export function textStrokes(text, o = {}) {
  const size = o.size ?? 10;
  const k = size / 100;
  const tracking = o.tracking ?? 0;
  const angle = o.angle ?? 0;
  const { sx, slant } = STYLE;
  const chars = [...String(text)];

  let width = 0;
  for (const ch of chars) width += advance(ch) * sx + tracking;
  if (chars.length) width -= tracking;                 // no tracking after the last

  // Anchoring is applied in UNSCALED units, then everything is scaled and
  // rotated together, so a rotated label pivots about its own anchor rather
  // than about the origin of the sheet.
  let ox = 0;
  if (o.anchor === "middle") ox = -width / 2;
  else if (o.anchor === "end") ox = -width;
  let oy = 0;
  if (o.baseline === "middle") oy = -50;
  else if (o.baseline === "cap") oy = -100;

  const ca = Math.cos(angle), sa = Math.sin(angle);
  const X0 = o.x ?? 0, Y0 = o.y ?? 0;
  const out = [];
  let pen = 0;
  for (const ch of chars) {
    for (const st of strokes(ch)) {
      const p = new Float64Array(st.length);
      for (let i = 0; i < st.length; i += 2) {
        // Width first, then the shear rides on the (unsheared) height, then
        // the pen — so a slanted glyph leans without changing its advance.
        const gx = (st[i] * sx + st[i + 1] * slant + pen + ox) * k;
        const gy = (st[i + 1] + oy) * k;
        p[i] = X0 + gx * ca - gy * sa;
        p[i + 1] = Y0 + gx * sa + gy * ca;
      }
      out.push(p);
    }
    pen += advance(ch) * sx + tracking;
  }
  return out;
}

/**
 * The box a string will occupy, before rotation.
 *
 * ⚠️ THE HEIGHT IS THE INK, NOT THE EM. Callers use this to reserve a gap in a
 * contour line, and reserving the em box would open a gap visibly larger than
 * the number sitting in it.
 * @param {string} text
 * @param {{size?:number, tracking?:number}} [o]
 * @returns {{width:number, height:number, top:number, bottom:number}}
 */
export function measure(text, o = {}) {
  const size = o.size ?? 10, k = size / 100, tracking = o.tracking ?? 0;
  const chars = [...String(text)];
  let width = 0;
  for (const ch of chars) width += advance(ch) * STYLE.sx + tracking;
  if (chars.length) width -= tracking;
  let top = -Infinity, bottom = Infinity;
  for (const ch of chars) {
    for (const st of strokes(ch)) {
      for (let i = 1; i < st.length; i += 2) {
        if (st[i] > top) top = st[i];
        if (st[i] < bottom) bottom = st[i];
      }
    }
  }
  if (!Number.isFinite(top)) { top = 0; bottom = 0; }
  return { width: width * k, height: (top - bottom) * k, top: top * k, bottom: bottom * k };
}

/**
 * Format an elevation the way a contour label reads it.
 *
 * ⚠️ THE INTERVAL DECIDES THE DECIMALS, NOT THE VALUE. Labelling a 0.25 m
 * interval as "77" three times running is worse than useless — it states that
 * three different lines are the same height. Labelling a 5 m interval as
 * "75.00" claims a precision the survey does not have. The number of decimals
 * is therefore derived from the interval, once, here.
 * @param {number} level @param {number} interval
 */
export function formatLevel(level, interval) {
  if (!(interval > 0)) return String(level);
  // ⚠️ THE EPSILON SUBTRACTS. An interval of exactly 0.1 gives −log10 = 1, and
  // nudging that UP crosses the integer and asks for two decimals — "77.00" for
  // a 0.1 m interval, which claims a centimetre the survey never measured.
  // Nudging DOWN keeps the exact powers of ten on their own side of the ceiling.
  const dp = Math.max(0, Math.min(3, Math.ceil(-Math.log10(interval) - 1e-9)));
  return level.toFixed(dp);
}
