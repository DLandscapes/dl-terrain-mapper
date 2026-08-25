// @ts-check
// CONTOUR LABELS — a number set into a gap in the line it names.
//
// ⚠️ THE GAP IS THE FEATURE, NOT THE TEXT. A number printed on top of its
// contour is two marks fighting for the same millimetre; on paper the ink wins,
// on 2 mm MDF the line and the digit burn into one smudge and neither survives.
// Every label here therefore CUTS ITS OWN HOLE in the line first, and the text
// is set into the hole. That is also why the labelling module owns the contour
// geometry on the way past: it must be allowed to modify the lines, so it is
// the last thing to touch them before the DXF.
//
// ⚠️ HORIZONTAL BY DEFAULT, AND THIS IS A FABRICATION DECISION. Text set along
// a curve is the cartographic convention and it is the wrong one here: it means
// a separate rotation per glyph, it engraves slowly because the head is turning
// constantly, and at label size on a real material the rotated strokes read
// worse than upright ones. Upright text in a gap is faster on the machine and
// more legible on the object. `orientation: "tangent"` is offered for drawings
// meant for paper, and rotates the label as ONE rigid block — never per glyph.
//
// ⚠️ CLIPPING RUNS IN SHEET MILLIMETRES, NOT IN MAP UNITS. Text size and
// clearance are millimetres on the material; the size of the hole they need has
// nothing to do with how many metres of ground it covers. Callers convert the
// contours to sheet space first — `toSheet` below — and label afterwards.

import { textStrokes, measure, formatLevel } from "./stroke-font.js";

/**
 * A traced contour, moved onto the sheet.
 * @param {import("./contours.js").Polyline} line
 * @param {import("./sheet.js").Sheet} sheet
 * @returns {{pts:Float64Array, closed:boolean, level:number, index:boolean}}
 */
export function toSheet(line, sheet) {
  const p = line.pts, out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    out[i] = sheet.X(p[i]);
    out[i + 1] = sheet.Y(p[i + 1]);
  }
  return { pts: out, closed: line.closed, level: line.level, index: line.index };
}

/** Cumulative arc length of a path. @param {Float64Array} p @param {boolean} closed */
function arcTable(p, closed) {
  const n = p.length / 2;
  const t = new Float64Array(closed ? n + 1 : n);
  for (let i = 1; i < n; i++) {
    t[i] = t[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  }
  if (closed) t[n] = t[n - 1] + Math.hypot(p[0] - p[n * 2 - 2], p[1] - p[n * 2 - 1]);
  return t;
}

/** Point and unit tangent at arc position s. */
function atArc(p, closed, t, s) {
  const n = p.length / 2;
  const total = t[t.length - 1];
  if (!(total > 0)) return null;
  if (closed) s = ((s % total) + total) % total;
  else if (s < 0 || s > total) return null;
  let lo = 0, hi = t.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (t[m] <= s) lo = m; else hi = m; }
  const seg = t[hi] - t[lo];
  const f = seg > 0 ? (s - t[lo]) / seg : 0;
  const i0 = lo % n, i1 = hi % n;
  const x0 = p[i0 * 2], y0 = p[i0 * 2 + 1], x1 = p[i1 * 2], y1 = p[i1 * 2 + 1];
  const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy) || 1;
  return { x: x0 + dx * f, y: y0 + dy * f, tx: dx / d, ty: dy / d };
}

/**
 * How far the path strays from the chord across a window — the straightness
 * test a label site has to pass.
 *
 * ⚠️ MEASURED AS DEVIATION, NOT AS TURNED ANGLE. A line can turn ninety degrees
 * across a window and still leave a perfectly good straight stretch either side
 * of the centre; and it can turn barely at all while bulging enough to run
 * through the middle of the number. What matters is whether the ink will fall
 * inside the hole, and that is a distance.
 */
function deviation(p, closed, t, s, half) {
  const a = atArc(p, closed, t, s - half), b = atArc(p, closed, t, s + half);
  if (!a || !b) return Infinity;
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
  if (!(d > 0)) return Infinity;
  let worst = 0;
  const STEPS = 8;
  for (let i = 1; i < STEPS; i++) {
    const q = atArc(p, closed, t, s - half + (2 * half * i) / STEPS);
    if (!q) return Infinity;
    worst = Math.max(worst, Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx) / d);
  }
  return worst;
}

/**
 * The stretch of a segment that falls inside a box, in the box's own frame.
 * Liang–Barsky. @returns {[number,number]|null}
 */
function insideSpan(x0, y0, x1, y1, hw, hh) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const test = (pp, qq) => {
    if (pp === 0) return qq >= 0;                 // parallel: inside iff not outside
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!test(-dx, x0 + hw) || !test(dx, hw - x0) ||
      !test(-dy, y0 + hh) || !test(dy, hh - y0)) return null;
  return t0 < t1 ? [t0, t1] : null;
}

/**
 * @typedef {{cx:number, cy:number, hw:number, hh:number, angle:number}} Box
 */

/**
 * Everything of a path that lies OUTSIDE a box.
 * @param {Float64Array|number[]} p @param {Box} box @returns {number[][]}
 */
function clipOutside(p, box) {
  const n = p.length / 2;
  if (n < 2) return [Array.from(p)];
  const ca = Math.cos(-box.angle), sa = Math.sin(-box.angle);
  const lx = new Float64Array(n), ly = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = p[i * 2] - box.cx, dy = p[i * 2 + 1] - box.cy;
    lx[i] = dx * ca - dy * sa;
    ly[i] = dx * sa + dy * ca;
  }
  const pieces = [];
  /** @type {number[]|null} */
  let cur = null;
  const push = (x, y) => { (cur ??= []).push(x, y); };
  const flush = () => { if (cur && cur.length >= 4) pieces.push(cur); cur = null; };
  const lerp = (i, t) => [
    p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * t,
    p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * t,
  ];
  for (let i = 0; i < n - 1; i++) {
    const span = insideSpan(lx[i], ly[i], lx[i + 1], ly[i + 1], box.hw, box.hh);
    if (!span) {
      push(p[i * 2], p[i * 2 + 1]);
      if (i === n - 2) push(p[i * 2 + 2], p[i * 2 + 3]);
      continue;
    }
    const [t0, t1] = span;
    if (t0 > 0) { push(p[i * 2], p[i * 2 + 1]); const q = lerp(i, t0); push(q[0], q[1]); }
    flush();
    if (t1 < 1) {
      const q = lerp(i, t1); push(q[0], q[1]);
      if (i === n - 2) push(p[i * 2 + 2], p[i * 2 + 3]);
    }
  }
  flush();
  return pieces;
}

/** Same coordinates, to within a hair. */
const same = (ax, ay, bx, by) => Math.abs(ax - bx) < 1e-9 && Math.abs(ay - by) < 1e-9;

/**
 * A line, minus every box, still knowing whether it stayed whole.
 * @returns {{pts:number[]|Float64Array, closed:boolean}[]}
 */
function subtractBoxes(pts, closed, boxes) {
  if (!boxes.length) return [{ pts, closed }];
  // ⚠️ A RING IS OPENED AT ITS SEAM BEFORE CLIPPING, THEN RE-CLOSED IF THE SEAM
  // SURVIVED. Clipping a ring as if it were an open path leaves a false break at
  // the seam — an extra pierce on the bed, at an arbitrary place, on a line the
  // eye follows all the way round.
  let work = pts;
  if (closed) {
    const w = new Float64Array(pts.length + 2);
    w.set(pts); w[pts.length] = pts[0]; w[pts.length + 1] = pts[1];
    work = w;
  }
  let parts = [work];
  for (const b of boxes) {
    const next = [];
    for (const part of parts) next.push(...clipOutside(part, b));
    parts = next;
    if (!parts.length) break;
  }
  if (!parts.length) return [];
  if (closed) {
    if (parts.length === 1 &&
        same(parts[0][0], parts[0][1], pts[0], pts[1]) &&
        same(parts[0][parts[0].length - 2], parts[0][parts[0].length - 1], pts[0], pts[1])) {
      return [{ pts, closed: true }];                       // untouched
    }
    if (parts.length >= 2) {
      const first = parts[0], last = parts[parts.length - 1];
      if (same(first[0], first[1], pts[0], pts[1]) &&
          same(last[last.length - 2], last[last.length - 1], pts[0], pts[1])) {
        parts.pop(); parts.shift();
        parts.push([...last, ...first.slice(2)]);           // heal across the seam
      }
    }
  }
  return parts.map((pp) => ({ pts: pp, closed: false }));
}

/**
 * Label a set of sheet-space contours, punching the gaps as it goes.
 *
 * @param {{pts:Float64Array, closed:boolean, level:number, index:boolean}[]} lines
 * @param {{interval:number, every?:number, indexOnly?:boolean, size?:number,
 *          spacing?:number, clearance?:number, maxDeviation?:number,
 *          orientation?:"horizontal"|"tangent", tracking?:number,
 *          suffix?:string, maxPerLine?:number}} opts
 *   `every` labels one level in n, counted from zero so the labelled lines do
 *   not change when the extent does. `spacing` is millimetres of line between
 *   one label and the next. Sizes and clearances are millimetres on the sheet.
 * @returns {{lines:{pts:Float64Array|number[], closed:boolean, level:number,
 *            index:boolean}[], labels:Float64Array[], placed:number,
 *            skipped:number}}
 */
export function labelContours(lines, opts) {
  const interval = opts.interval;
  const every = Math.max(1, Math.round(opts.every ?? 5));
  const size = opts.size ?? 2.2;
  const spacing = opts.spacing ?? 60;
  const clearance = opts.clearance ?? size * 0.45;
  const maxDev = opts.maxDeviation ?? size * 0.35;
  const tangent = opts.orientation === "tangent";
  const tracking = opts.tracking ?? 6;
  const suffix = opts.suffix ?? "";
  const maxPerLine = opts.maxPerLine ?? 24;

  const outLines = [];
  const labels = [];
  let placed = 0, skipped = 0;

  for (const line of lines) {
    const wanted = opts.indexOnly
      ? line.index
      : Math.abs(Math.round(line.level / interval)) % every === 0;
    if (!wanted) { outLines.push(line); continue; }

    const text = formatLevel(line.level, interval) + suffix;
    const m = measure(text, { size, tracking });
    const hw = m.width / 2 + clearance;
    const hh = Math.max(size, m.height) / 2 + clearance;
    const t = arcTable(line.pts, line.closed);
    const total = t[t.length - 1];
    // ⚠️ A LINE TOO SHORT TO HOLD A LABEL IS LEFT ALONE, NOT SHRUNK TO FIT. The
    // alternative — a smaller number on short lines — produces a drawing whose
    // text size encodes nothing and whose smallest labels are the ones nobody
    // can read.
    if (!(total > m.width * 2.5)) { outLines.push(line); skipped++; continue; }

    /** @type {Box[]} */
    const boxes = [];
    // The phase staggers labels between neighbouring contours, so they do not
    // line up into a seam running across the drawing.
    const phase = (Math.abs(Math.round(line.level / interval)) % 3) * (spacing / 3);
    const step = Math.max(spacing, m.width * 2);
    const nWant = Math.min(maxPerLine, Math.max(1, Math.floor(total / step)));
    const gap = total / nWant;
    for (let k = 0; k < nWant; k++) {
      let s = phase + gap * (k + 0.5);
      if (!line.closed && (s < m.width || s > total - m.width)) continue;
      const half = m.width / 2 + clearance;
      // Nudge along the line looking for somewhere flat enough, rather than
      // giving up at the first curve.
      let best = null;
      for (const d of [0, 0.12, -0.12, 0.24, -0.24, 0.36, -0.36]) {
        const ss = s + gap * d;
        const dev = deviation(line.pts, line.closed, t, ss, half);
        if (dev <= maxDev) { best = ss; break; }
        if (!best && dev < Infinity) best = null;
      }
      if (best === null) { skipped++; continue; }
      const at = atArc(line.pts, line.closed, t, best);
      if (!at) { skipped++; continue; }
      let angle = 0;
      if (tangent) {
        angle = Math.atan2(at.ty, at.tx);
        // Never set upside down: a label is read, not admired.
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle < -Math.PI / 2) angle += Math.PI;
      }
      boxes.push({ cx: at.x, cy: at.y, hw, hh, angle });
      for (const st of textStrokes(text, {
        x: at.x, y: at.y, size, angle, tracking,
        anchor: "middle", baseline: "middle",
      })) labels.push(st);
      placed++;
    }
    for (const part of subtractBoxes(line.pts, line.closed, boxes)) {
      outLines.push({ pts: part.pts, closed: part.closed, level: line.level, index: line.index });
    }
  }
  return { lines: outLines, labels, placed, skipped };
}
