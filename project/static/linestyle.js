// @ts-check
// LINE STYLES — dashed, dotted, dash-dot, cut into the geometry itself.
//
// ⚠️ A DXF LINETYPE WOULD BE THE WRONG ANSWER HERE, AND DANGEROUSLY SO. In CAD
// a dashed line is a solid polyline wearing a LTYPE, and the renderer draws the
// gaps. Hand that to a laser front-end and most of them ignore the linetype
// entirely: the machine runs the polyline SOLID, at full length, and the
// drawing that came off the bed is not the drawing on screen. The few that do
// honour it disagree with each other about dash scale. So a dash here is a real
// break in a real path — what you see is what the head does.
//
// ⚠️ WHICH MEANS DASHING DELIBERATELY RE-CREATES THE PROBLEM contours.js EXISTS
// TO PREVENT. One continuous 40 m contour becomes some hundreds of separate
// paths, each with its own acceleration and deceleration. That is fine when it
// is asked for and understood — a dashed line is a legitimate cartographic
// statement, and on a score pass it is not a pierce — but the count must be
// visible BEFORE the file is written, never discovered at the machine. Every
// function here reports what it multiplied the path count by.
//
// ⚠️ A DOT IS A SHORT DASH, NEVER A POINT. Same rule as the full stop in
// stroke-font.js, for the same physical reason: a zero-length path is a head
// that stops and dwells, which burns a hole rather than making a mark. The
// shortest mark in the table below is 0.25 mm and nothing may go to zero.

/**
 * The patterns, in SHEET MILLIMETRES. Lengths are on the material, not in map
 * units — a dash is a mark you see, so it is specified where you see it.
 * @type {Record<string, {label:string, pattern:number[]|null}>}
 */
export const LINE_STYLES = {
  solid: { label: "Solid", pattern: null },
  dashed: { label: "Dashed", pattern: [3, 1.5] },
  fine_dashed: { label: "Fine dashed", pattern: [1.4, 1] },
  long_dashed: { label: "Long dashed", pattern: [7, 2] },
  dotted: { label: "Dotted", pattern: [0.25, 1.1] },
  dash_dot: { label: "Dash-dot", pattern: [4, 1.2, 0.25, 1.2] },
  dash_dot_dot: { label: "Dash-dot-dot", pattern: [4, 1.2, 0.25, 1.2, 0.25, 1.2] },
};

/** The order a picker should show them in. */
export const STYLE_ORDER = ["solid", "dashed", "fine_dashed", "long_dashed",
  "dotted", "dash_dot", "dash_dot_dot"];

/** A label for a style, including one that came from a foreign file. */
export function styleLabel(style, customPattern) {
  if (style === "custom" && customPattern && customPattern.length >= 2) {
    return `Custom ${customPattern.map((v) => +(+v).toFixed(2)).join("/")} mm`;
  }
  return (LINE_STYLES[style] || LINE_STYLES.solid).label;
}

/** Total run of a path. @param {Float64Array|number[]} p @param {boolean} closed */
function runLength(p, closed) {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  if (closed && p.length >= 4) s += Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]);
  return s;
}

/**
 * Cut one path into a dash pattern.
 *
 * ⚠️ THE PATTERN IS WALKED BY ARC LENGTH, NOT PER SEGMENT. A contour's segments
 * are whatever the tracer produced — often far shorter than one dash — so
 * restarting the pattern at every vertex would give a line whose dashes change
 * length with the terrain's roughness. Walking the accumulated length means the
 * dashes are even whatever the geometry underneath is doing.
 *
 * @param {Float64Array|number[]} pts x,y interleaved, sheet mm
 * @param {boolean} closed
 * @param {number[]|null} pattern alternating on/off lengths, mm
 * @returns {Float64Array[]} the "on" pieces
 */
export function dashPath(pts, closed, pattern) {
  const n = pts.length / 2;
  if (n < 2) return [];
  if (!pattern || !pattern.length) {
    const out = new Float64Array(closed ? pts.length + 2 : pts.length);
    out.set(pts);
    if (closed) { out[pts.length] = pts[0]; out[pts.length + 1] = pts[1]; }
    return [out];
  }
  const period = pattern.reduce((a, b) => a + b, 0);
  if (!(period > 0)) return [Float64Array.from(pts)];

  // ⚠️ A CLOSED RING GETS ITS PATTERN STRETCHED TO FIT A WHOLE NUMBER OF
  // PERIODS. A circumference is not a multiple of 4.5 mm, so walking the raw
  // pattern round a ring leaves a RUNT where the end meets the start — measured
  // at 0.126 mm on a 251 mm ring, half a dot. At laser kerf that is not a short
  // mark, it is a stationary head: a dwell, and a burn-through. Scaling the
  // period by at most a third closes the ring evenly instead, which is also what
  // the eye wants: a dashed circle with one odd gap in it looks like a mistake.
  let scale = 1;
  if (closed) {
    const len = runLength(pts, true);
    const reps = Math.max(1, Math.round(len / period));
    const want = len / reps / period;
    if (want >= 0.75 && want <= 1.34) scale = want;
  }
  pattern = scale === 1 ? pattern : pattern.map((v) => v * scale);

  // Anything below this is a dwell rather than a mark, and is dropped. It can
  // still occur at the far end of an OPEN path, where there is no ring to close.
  const MIN_MARK = 0.15;

  const pieces = [];
  let cur = [];
  let idx = 0;                 // where we are in the pattern
  let left = pattern[0];       // how much of this element remains
  let on = true;               // even indices are marks

  const closePiece = () => {
    if (cur.length >= 4) {
      const p = Float64Array.from(cur);
      if (runLength(p, false) >= MIN_MARK) pieces.push(p);
    }
    cur = [];
  };

  const N = closed ? n + 1 : n;
  for (let k = 0; k < N - 1; k++) {
    const a = k % n, b = (k + 1) % n;
    const ax = pts[a * 2], ay = pts[a * 2 + 1];
    const bx = pts[b * 2], by = pts[b * 2 + 1];
    const segLen = Math.hypot(bx - ax, by - ay);
    if (!(segLen > 0)) continue;
    let travelled = 0;
    if (on && cur.length === 0) cur.push(ax, ay);
    while (travelled < segLen) {
      const step = Math.min(left, segLen - travelled);
      travelled += step;
      left -= step;
      const t = travelled / segLen;
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      if (on) cur.push(px, py);
      if (left <= 1e-12) {
        // ⚠️ THE PATTERN ADVANCES BY INDEX, NOT BY FLIPPING A BOOLEAN. A
        // dash-dot pattern has four elements, not two; a boolean would make it
        // an even dash and quietly discard the dot.
        if (on) closePiece();
        idx = (idx + 1) % pattern.length;
        left = pattern[idx];
        on = idx % 2 === 0;
        if (on) cur = [px, py];
      }
    }
  }
  closePiece();
  return pieces;
}

/**
 * Cut a path into dashes whose INK VARIES ALONG IT, driven by a second field.
 *
 * A contour that runs solid on dry ground and breaks into dots where the
 * ground is wet says two things with one line — the height it stands for, and
 * a second quantity sampled underneath it — without spending a second line, a
 * second pass, or any ink the drawing did not already have. It is the cheapest
 * second variable in this whole tool.
 *
 * ⚠️ THE PERIOD IS CONSTANT AND THE DUTY CYCLE VARIES. Modulating the period
 * instead would produce a line whose dashes drift in and out of step with the
 * terrain, which reads as a drawing error rather than as data. Constant
 * period, varying mark: the eye reads that as tone immediately, and it is the
 * same grammar the hatch field uses.
 *
 * ⚠️ THE RING STILL GETS ITS PERIOD STRETCHED TO CLOSE. Same runt at the seam,
 * same dwell, same burn-through — the fix from `dashPath` is repeated here
 * rather than skipped because the pattern is now dynamic.
 *
 * @param {Float64Array|number[]} pts x,y interleaved, SHEET MM
 * @param {boolean} closed
 * @param {(x:number, y:number) => number} duty position in sheet mm → the ink
 *   fraction wanted there, 0..1. Values outside are clamped; NaN means no
 *   answer and leaves the paper bare, never a full mark.
 * @param {{period?:number, minInk?:number, maxInk?:number, minMark?:number}} [o]
 * @returns {Float64Array[]} the "on" pieces
 */
export function modulatedDash(pts, closed, duty, o = {}) {
  const n = pts.length / 2;
  if (n < 2) return [];
  let period = o.period > 0 ? o.period : 2;
  const minInk = Math.max(0, Math.min(1, o.minInk ?? 0));
  const maxInk = Math.max(minInk, Math.min(1, o.maxInk ?? 1));
  const minMark = o.minMark ?? 0.15;

  const total = runLength(pts, closed);
  if (!(total > 0)) return [];
  if (closed) {
    const reps = Math.max(1, Math.round(total / period));
    period = total / reps;                        // exact fit, no seam runt
  }

  // Walk the whole path once, resampling it at a fine step, so a period can be
  // filled from geometry of any vertex density. The step is a fraction of the
  // period, never of a segment.
  const step = Math.min(period / 8, Math.max(period / 64, 0.05));
  /** @type {number[][]} */
  const pieces = [];
  /** @type {number[]} */
  let cur = [];
  let sinceStart = 0;                             // distance into this period
  let inkLen = -1;                                // how much of it is a mark
  const N = closed ? n + 1 : n;
  let carry = 0;

  const closePiece = () => {
    if (cur.length >= 4) {
      const p = Float64Array.from(cur);
      if (runLength(p, false) >= minMark) pieces.push(p);
    }
    cur = [];
  };

  for (let k = 0; k < N - 1; k++) {
    const a = k % n, b = (k + 1) % n;
    const ax = pts[a * 2], ay = pts[a * 2 + 1];
    const bx = pts[b * 2], by = pts[b * 2 + 1];
    const segLen = Math.hypot(bx - ax, by - ay);
    if (!(segLen > 0)) continue;
    for (let d = carry; d < segLen; d += step) {
      const t = d / segLen;
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      if (inkLen < 0) {
        // ⚠️ THE FIELD IS SAMPLED ONCE PER PERIOD, AT ITS START, and that value
        // sizes the whole mark. Sampling per micro-step instead would let a
        // single mark be half one value and half another — a dash that is not
        // a measurement of anything in particular.
        const v = duty(px, py);
        const f = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
        inkLen = period * (minInk + (maxInk - minInk) * f);
      }
      if (sinceStart < inkLen) cur.push(px, py);
      else if (cur.length) closePiece();
      sinceStart += step;
      if (sinceStart >= period) {
        if (cur.length) { cur.push(px, py); closePiece(); }
        sinceStart = 0;
        inkLen = -1;
      }
    }
    carry = 0;
  }
  closePiece();
  return pieces.map((p) => (p instanceof Float64Array ? p : Float64Array.from(p)));
}

/**
 * Apply a style to a set of paths, and say what it cost.
 *
 * @param {{pts:Float64Array|number[], closed:boolean}[]} paths
 * @param {string} style a key of LINE_STYLES
 * @returns {{paths:Float64Array[], before:number, after:number, marks:number,
 *            shortest:number, verdict:string}}
 */
export function applyStyle(paths, style, customPattern) {
  // ⚠️ A CUSTOM PATTERN BEATS THE NAMED ONE. QGIS states dashes in exact
  // millimetres; snapping "5;2" onto the nearest of seven presets would throw
  // away the one part of a foreign style that carries across perfectly.
  const def = (style === "custom" && customPattern && customPattern.length >= 2)
    ? { label: `Custom ${customPattern.map((v) => +(+v).toFixed(2)).join("/")} mm`,
        pattern: customPattern.map(Number).filter((v) => v > 0) }
    : (LINE_STYLES[style] || LINE_STYLES.solid);
  const out = [];
  let shortest = Infinity;
  for (const p of paths) {
    for (const piece of dashPath(p.pts, p.closed, def.pattern)) {
      out.push(piece);
      if (def.pattern) shortest = Math.min(shortest, runLength(piece, false));
    }
  }
  const before = paths.length, after = out.length;
  // ⚠️ THE VERDICT IS ABOUT HEAD MOVES, NOT FILE SIZE. Past a few thousand
  // separate marks a score pass audibly stutters and the job time stops being
  // proportional to the ink.
  const verdict = !def.pattern ? "continuous"
    : after <= 1500 ? "comfortable"
    : after <= 6000 ? "heavy — check the time estimate before cutting"
    : "very heavy — the head will spend most of the job accelerating";
  return {
    paths: out, before, after,
    marks: def.pattern ? after : 0,
    shortest: Number.isFinite(shortest) ? shortest : 0,
    verdict,
  };
}
