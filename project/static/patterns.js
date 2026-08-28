// @ts-check
// FILL PATTERNS — a polygon turned into strokes a laser can draw.
//
// ⚠️ PORTED FROM DL-TerrainSlicer's `slicer/hatch.py`, DELIBERATELY AND
// FAITHFULLY. The two tools share a bed, a material and a pass scheme, and a
// student who hatches a planting bed in one and then in the other must get the
// same drawing. The constants below are therefore COPIED, not re-derived: the
// 0.28 offset of a double line, the 1.4/1.9/2.4 rhythm of a dash-dot, the 0.7
// row factor of fish scales. Changing one here without changing it there is how
// two tools that look alike start producing drawings that do not match.
//
// ⚠️ THE ROTATION TRICK IS THE WHOLE ARCHITECTURE. Every generator works in an
// axis-aligned frame and knows nothing about rotation. To hatch at an angle the
// REGION is rotated backwards, filled, and the strokes rotated forward again.
// One implementation per pattern, any angle, no trigonometry inside the
// families.
//
// ⚠️ AND EVERY STROKE IS CLIPPED SEPARATELY. Overlaying one big multi-line
// geometry and intersecting it wholesale would NODE the crossings — every
// place two hatch lines cross becomes a vertex, and a crosshatch turns into
// thousands of tiny separate laser moves instead of a few long ones. Clipping
// each line on its own keeps a stroke a stroke.
//
// This module is pure geometry in SHEET MILLIMETRES and knows nothing about
// rasters, passes or files.

import { clipPathToRings, pointInRings, ringsBBox } from "./clip.js";

/**
 * The patterns, as `key -> [group, label]`. ⚠️ Same keys and same grouping as
 * the Slicer, so a preset carried between the tools still means something.
 */
export const FILL_PATTERNS = {
  solid: ["linear", "Solid"],
  lines: ["linear", "Lines"],
  double: ["linear", "Double lines"],
  dashes: ["linear", "Dashes"],
  dashdot: ["linear", "Dash-dot"],
  cross: ["linear", "Crosshatch"],
  trigrid: ["linear", "Triangle grid"],
  zigzag: ["linear", "Zigzag"],
  waves: ["water", "Waves"],
  ripples: ["water", "Ripples"],
  scales: ["water", "Fish scales"],
  herringbone: ["paving", "Herringbone"],
  brick: ["paving", "Running bond"],
  hex: ["paving", "Honeycomb"],
  diamonds: ["paving", "Diamonds"],
  dots: ["scatter", "Dots"],
  rings: ["scatter", "Rings"],
  stipple: ["scatter", "Stipple"],
  pebbles: ["scatter", "Pebbles"],
  plus: ["scatter", "Plus marks"],
  ticks: ["scatter", "Ticks"],
  grass: ["scatter", "Grass tufts"],
  marsh: ["scatter", "Marsh reeds"],
  interference: ["abstract", "Interference"],
  echo: ["abstract", "Contour echo"],
};

/** The order a picker shows them in — grouped, as the Slicer groups them. */
export const PATTERN_ORDER = Object.keys(FILL_PATTERNS);

/**
 * Deterministic 0..1 hash of a grid cell.
 *
 * ⚠️ NOT Math.random(). A scattered pattern must come out THE SAME every time
 * the drawing is compiled: the preview a student approves has to be the file
 * they cut, and a re-compile between the two must not reshuffle the stipple.
 * Same integer hash as the Slicer's, so both tools scatter identically.
 * @param {number} i @param {number} j @param {number} salt
 */
export function cellRandom(i, j, salt = 0) {
  let n = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(salt, 83492791)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  return ((n >>> 8) & 0xffff) / 65535;
}

const circle = (cx, cy, r, n = 8) => {
  const p = [];
  for (let k = 0; k <= n; k++) {
    p.push(cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n));
  }
  return p;
};

/**
 * ⚠️ A CAP ON THE ROW COUNT, NOT ON THE AREA. A 0.1 mm spacing over a large bed
 * is millions of strokes and a browser that stops responding; the Slicer caps
 * at 400 rows and so does this. The drawing comes out coarser than asked for,
 * which is visible, rather than the tool appearing to hang, which is not.
 */
const capSpacing = (s, half, maxRows = 400) => Math.max(s, (2 * half) / maxRows);

/**
 * ⚠️ SOLID IS NOT A FILL, IT IS A SPACING. Nothing this tool draws is filled —
 * a laser makes a solid field by sweeping lines close enough together that the
 * burns merge, and that is what this is: `lines` at the distance where they
 * stop reading as lines. Expressing it as geometry rather than as a "filled"
 * flag is the same rule that fixed defect 7.
 *
 * ⚠️ 0.3 mm WAS A GUESS. THE COUPON DID NOT OVERTURN IT — AND DID NOT QUITE
 * MEASURE IT EITHER, WHICH IS WORTH BEING PRECISE ABOUT.
 *
 * There is no block on the sheet that lays engraved lines at a ladder of
 * spacings and asks which one stops reading as stripes. What block D gives is a
 * BOUND: the smallest circle that comes off as a ring rather than as a filled
 * hole is 0.4 mm, and 0.3 mm came back closed. A traced circle of diameter d
 * closes when the burn covers its middle, so the burn is at least about 0.3 mm
 * wide and less than about 0.4. The spacing at which such burns merge sits at
 * the bottom of that window — which is where 0.3 already was.
 *
 * ⚠️ AND THE KERF IS NOT THIS NUMBER. Block E measured 0.18 mm, and it is
 * tempting to read that as the burn width and halve every spacing in the tool.
 * It is the wrong pass: kerf is material REMOVED by a CUT, at its own power and
 * speed and measured on a through-cut edge. What matters for a solid field is
 * how wide an engraved line READS once the board has charred, which is what
 * block D saw. See `MATERIAL.kerfMM` in `material.js`.
 *
 * ⚠️ SO THIS IS A BOUNDED INFERENCE, NOT A READING, and the honest fix is one
 * more block on the next coupon. `NOT_MEASURED` in `material.js` says so.
 */
export const SOLID_MM = 0.3;

/**
 * How WIDE one of those burns is, for anything drawing the material.
 *
 * ⚠️ WIDER THAN THE SPACING, BECAUSE MERGING IS OVERLAP AND NOT ABUTMENT. Two
 * neighbouring engrave passes each cut a groove with a rounded profile; laid
 * exactly edge to edge they leave a ridge between them, which is why raster
 * engraving is run with an overlap rather than a tangency. So if 0.3 mm is the
 * spacing at which burns merge, the burn is wider than 0.3 mm — and drawing it
 * at exactly the spacing showed a scale bar as five black bands separated by
 * grey seams, which is the preview inventing a defect the material will not
 * have.
 *
 * ⚠️ 15% IS THE COMMON WORKSHOP FIGURE AND IS STILL A GUESS, like its parent.
 * It is tied to `SOLID_MM` rather than set on its own so one reading settles
 * both, and so the two can never drift apart. Block D puts the burn between
 * about 0.3 and 0.4 mm; 0.345 sits inside that window, which is the most that
 * can be said for it.
 *
 * ⚠️ THIS IS FOR DRAWING ONLY, NEVER FOR SPACING. Fills step at `SOLID_MM`.
 * Stepping them at the burn width instead would leave real gaps.
 */
export const BURN_MM = SOLID_MM * 1.15;

/**
 * The frame a family fills.
 *
 * ⚠️ `half` IS THE DIAGONAL AND IS TOO BIG TO STEP ROWS ACROSS. The rings handed
 * here are ALREADY rotated into the family's own frame, so the bbox is the true
 * extent and the diagonal is only a safe over-estimate — safe for how far a line
 * must REACH, and badly wrong for how many rows there are.
 *
 * A 2 mm band 800 mm long has a 400 mm half-diagonal. Stepping rows across that
 * at 0.3 mm asks for 2,667 rows when the band holds seven, so the row cap fires
 * and coarsens the spacing until ONE row is left — a wide engraved line comes
 * out as a hairline, and the warning blames the spacing. Rows step across
 * `halfY`; lines reach across `halfX`.
 */
function frameOf(rings) {
  const b = ringsBBox(rings);
  return {
    cx: (b.x0 + b.x1) / 2,
    cy: (b.y0 + b.y1) / 2,
    half: Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2 + 1,
    halfX: (b.x1 - b.x0) / 2 + 1,
    halfY: (b.y1 - b.y0) / 2 + 1,
  };
}

const rowsOf = (cy, half, s) => {
  const n = Math.floor(half / s) + 1;
  const out = [];
  for (let k = -n; k <= n; k++) out.push(cy + k * s);
  return out;
};

// ── line families ───────────────────────────────────────────────────────────
// Each returns an array of flat [x,y,x,y,…] polylines in the axis-aligned frame.

const famLines = (cx, cy, half, s, halfY = half) =>
  rowsOf(cy, halfY, s).map((y) => [cx - half, y, cx + half, y]);

const famDouble = (cx, cy, half, s) => {
  const out = [];
  for (const y of rowsOf(cy, half, s)) {
    out.push([cx - half, y, cx + half, y]);
    out.push([cx - half, y + 0.28 * s, cx + half, y + 0.28 * s]);
  }
  return out;
};

const famDashes = (cx, cy, half, s, dash = 1.5, gap = 0.75) => {
  const out = [];
  for (const y of rowsOf(cy, half, s)) {
    for (let x = cx - half; x < cx + half; x += (dash + gap) * s) {
      out.push([x, y, Math.min(x + dash * s, cx + half), y]);
    }
  }
  return out;
};

const famDashdot = (cx, cy, half, s) => {
  const out = [];
  for (const y of rowsOf(cy, half, s)) {
    for (let x = cx - half; x < cx + half; x += 2.4 * s) {
      out.push([x, y, Math.min(x + 1.4 * s, cx + half), y]);
      const dot = x + 1.9 * s;
      if (dot < cx + half) out.push([dot, y, dot + 0.06 * s, y]);
    }
  }
  return out;
};

const famZigzag = (cx, cy, half, s) => {
  const out = [];
  const amp = 0.38 * s;
  for (const y of rowsOf(cy, half, s)) {
    const p = [];
    let k = 0;
    for (let x = cx - half; x <= cx + half; x += s) {
      p.push(x, y + (k % 2 ? amp : -amp));
      k++;
    }
    if (p.length >= 4) out.push(p);
  }
  return out;
};

const famWaves = (cx, cy, half, s, lam = 3.2, amp = 0.35, phaseAlt = false) => {
  const out = [];
  const rows = rowsOf(cy, half, s);
  rows.forEach((y, r) => {
    const phase = phaseAlt && r % 2 ? Math.PI : 0;
    const p = [];
    const step = (lam * s) / 8;
    for (let x = cx - half; x <= cx + half; x += step) {
      p.push(x, y + amp * s * Math.sin((2 * Math.PI * x) / (lam * s) + phase));
    }
    if (p.length >= 4) out.push(p);
  });
  return out;
};

const famRipples = (cx, cy, half, s) => famWaves(cx, cy, half, s, 2.0, 0.5, true);

const famScales = (cx, cy, half, s) => {
  const out = [];
  const r = 0.8 * s;
  rowsOf(cy, half, 0.7 * r).forEach((y, row) => {
    const shift = row % 2 ? r * 0.85 : 0;
    for (let x = cx - half + shift; x < cx + half; x += 2 * r * 0.85) {
      const p = [];
      for (let k = 0; k <= 8; k++) {
        const a = (Math.PI * k) / 8;
        p.push(x + r * Math.cos(a), y + r * 0.55 * Math.sin(a));
      }
      out.push(p);
    }
  });
  return out;
};

const famHerringbone = (cx, cy, half, s) => {
  const out = [];
  const n = Math.floor(half / s) + 1;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const x0 = cx + i * s, y0 = cy + j * s;
      if ((i + j) % 2 === 0) out.push([x0, y0, x0 + s, y0 + s]);
      else out.push([x0, y0 + s, x0 + s, y0]);
    }
  }
  return out;
};

const famBrick = (cx, cy, half, s) => {
  const out = famLines(cx, cy, half, s);
  const bw = 2 * s;
  const n = Math.floor(half / s) + 1;
  for (let j = -n; j <= n; j++) {
    const y = cy + j * s;
    const off = j % 2 ? bw / 2 : 0;
    for (let x = cx - half + off; x < cx + half; x += bw) out.push([x, y, x, y + s]);
  }
  return out;
};

/** Honeycomb from three consecutive edges per cell, which avoids doubling. */
const famHex = (cx, cy, half, s) => {
  const a = 0.7 * s;
  const out = [];
  const ni = Math.floor(half / (1.5 * a)) + 2;
  const S3 = Math.sqrt(3);
  const nj = Math.floor(half / (S3 * a)) + 2;
  for (let i = -ni; i <= ni; i++) {
    for (let j = -nj; j <= nj; j++) {
      const hx = cx + 1.5 * a * i;
      const hy = cy + S3 * a * j + (i % 2 ? (S3 / 2) * a : 0);
      const v = [];
      for (let k = 0; k < 6; k++) {
        v.push([hx + a * Math.cos((Math.PI / 3) * k), hy + a * Math.sin((Math.PI / 3) * k)]);
      }
      out.push([v[0][0], v[0][1], v[1][0], v[1][1], v[2][0], v[2][1], v[3][0], v[3][1]]);
    }
  }
  return out;
};

/** Rotate a set of flat polylines about a point. */
function rotateAll(list, cx, cy, deg) {
  const a = (deg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  return list.map((p) => {
    const q = new Array(p.length);
    for (let i = 0; i < p.length; i += 2) {
      const dx = p[i] - cx, dy = p[i + 1] - cy;
      q[i] = cx + dx * ca - dy * sa;
      q[i + 1] = cy + dx * sa + dy * ca;
    }
    return q;
  });
}

const famCross = (cx, cy, half, s) => {
  const base = famLines(cx, cy, half, s);
  return base.concat(rotateAll(base, cx, cy, 90));
};

const famTrigrid = (cx, cy, half, s) => {
  const base = famLines(cx, cy, half, 1.2 * s);
  return base.concat(rotateAll(base, cx, cy, 60), rotateAll(base, cx, cy, 120));
};

const famInterference = (cx, cy, half, s) => {
  const base = famWaves(cx, cy, half, s, 2.6, 0.4);
  return base.concat(rotateAll(base, cx, cy, 60));
};

const LINE_FAMILIES = {
  solid: famLines, lines: famLines, double: famDouble, dashes: famDashes, dashdot: famDashdot,
  cross: famCross, zigzag: famZigzag, waves: famWaves, ripples: famRipples,
  herringbone: famHerringbone, brick: famBrick, hex: famHex, trigrid: famTrigrid,
  interference: famInterference, scales: famScales,
};

// ── scatter symbols ─────────────────────────────────────────────────────────
// Each returns {gx, gy, stagger, jitter, margin, make(x,y,r1,r2) -> polylines}.

const SYMBOLS = {
  dots: (s) => { const r = Math.max(0.15, 0.12 * s);
    return { gx: s, gy: s, stagger: false, jitter: 0, margin: r,
      make: (x, y) => [circle(x, y, r, 6)] }; },
  rings: (s) => { const r = 0.45 * s;
    return { gx: 1.5 * s, gy: 1.3 * s, stagger: true, jitter: 0, margin: r,
      make: (x, y) => [circle(x, y, r, 10)] }; },
  stipple: (s) => { const r = Math.max(0.12, 0.07 * s);
    return { gx: 0.62 * s, gy: 0.62 * s, stagger: false, jitter: 0.45, margin: r,
      make: (x, y) => [circle(x, y, r, 5)] }; },
  pebbles: (s) => ({ gx: 1.15 * s, gy: 1.15 * s, stagger: true, jitter: 0.32,
    margin: 0.55 * s, make: (x, y, r1) => [circle(x, y, (0.22 + 0.3 * r1) * s, 9)] }),
  plus: (s) => { const a = 0.3 * s;
    return { gx: 1.3 * s, gy: 1.3 * s, stagger: true, jitter: 0, margin: a,
      make: (x, y) => [[x - a, y, x + a, y], [x, y - a, x, y + a]] }; },
  ticks: (s) => { const ln = 0.55 * s;
    return { gx: 0.95 * s, gy: 0.95 * s, stagger: false, jitter: 0.4, margin: ln,
      make: (x, y, r1) => [[
        x - (ln / 2) * Math.cos(Math.PI * r1), y - (ln / 2) * Math.sin(Math.PI * r1),
        x + (ln / 2) * Math.cos(Math.PI * r1), y + (ln / 2) * Math.sin(Math.PI * r1)]] }; },
  grass: (s) => { const h = 0.62 * s;
    return { gx: 1.35 * s, gy: 1.15 * s, stagger: true, jitter: 0.3, margin: h,
      make: (x, y, r1) => {
        const lean = (r1 - 0.5) * 0.35;
        return [-0.32, 0, 0.3].map((a) =>
          [x, y, x + h * Math.sin(a + lean), y + h * Math.cos(a + lean)]);
      } }; },
  marsh: (s) => { const w = 0.55 * s, h = 0.45 * s;
    return { gx: 2.1 * s, gy: 1.55 * s, stagger: true, jitter: 0.15, margin: Math.max(w, h),
      make: (x, y) => {
        const out = [[x - w, y, x + w, y]];
        for (const dx of [-0.5 * w, 0, 0.5 * w]) out.push([x + dx, y, x + dx, y + h]);
        return out;
      } }; },
  diamonds: (s) => { const w = 0.42 * s, h = 0.65 * s;
    return { gx: 1.5 * s, gy: 1.7 * s, stagger: true, jitter: 0, margin: Math.max(w, h),
      make: (x, y) => [[x, y - h, x + w, y, x, y + h, x - w, y, x, y - h]] }; },
};

/** Total run of a flat polyline. */
function runLength(p) {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
}

/**
 * Concentric inward offsets of a region — the "contour echo" pattern.
 *
 * ⚠️ DONE WITH A DISTANCE FIELD AND THE CONTOUR TRACER, NOT WITH POLYGON
 * OFFSETTING. The Slicer has GEOS and calls `buffer(-k*spacing)`; there is no
 * geometry engine here, and a hand-rolled inward offset by angle bisector
 * self-intersects on any concave shape — which a planting bed or a shoreline
 * always is. Sampling distance-to-boundary onto a grid and tracing its levels
 * gives the same rings, is robust to concavity, holes and pinch points, and
 * reuses the marching-triangles tracer this tool already trusts. The cost is a
 * grid: resolution is capped, so a very large region echoes slightly coarsely
 * rather than slowly.
 *
 * @param {import("./clip.js").Ring[]} rings @param {number} spacing
 * @param {number} minLen
 * @returns {number[][]}
 */
function echoRings(rings, spacing, minLen) {
  const b = ringsBBox(rings);
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (!(w > 0) || !(h > 0) || !(spacing > 0)) return [];
  // Four samples per ring spacing, capped so a big bed stays responsive.
  let cell = spacing / 4;
  const MAX = 320;
  cell = Math.max(cell, Math.max(w, h) / MAX);
  const ncols = Math.max(4, Math.ceil(w / cell) + 3);
  const nrows = Math.max(4, Math.ceil(h / cell) + 3);
  const ox = b.x0 - cell, oy = b.y1 + cell;          // north-up, like a DEM
  const z = new Float32Array(nrows * ncols);
  // Distance to the nearest boundary segment, negative outside.
  const segs = [];
  for (const r of rings) {
    const p = r.pts;
    const n = p.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      segs.push([p[j * 2], p[j * 2 + 1], p[i * 2], p[i * 2 + 1]]);
    }
  }
  for (let row = 0; row < nrows; row++) {
    const y = oy - (row + 0.5) * cell;
    for (let col = 0; col < ncols; col++) {
      const x = ox + (col + 0.5) * cell;
      let best = Infinity;
      for (const [ax, ay, bx, by] of segs) {
        const dx = bx - ax, dy = by - ay;
        const L2 = dx * dx + dy * dy;
        let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        if (d < best) best = d;
      }
      z[row * ncols + col] = pointInRings(x, y, rings) ? best : -best;
    }
  }
  // Levels at k*spacing inside the boundary.
  const out = [];
  let maxD = 0;
  for (let i = 0; i < z.length; i++) if (z[i] > maxD) maxD = z[i];
  const levels = [];
  for (let k = 1; k * spacing < maxD; k++) levels.push(k * spacing);
  if (!levels.length) return out;
  const dem = { nrows, ncols, cell, originX: ox, originY: oy, z };
  // Imported lazily to keep this module free of a hard dependency cycle.
  const { traceContours } = echoRings._tracer;
  for (const line of traceContours(dem, 0, { levels })) {
    const p = Array.from(line.pts);
    if (line.closed && p.length >= 4) p.push(p[0], p[1]);
    if (runLength(p) >= minLen) out.push(p);
  }
  return out;
}
/** @type {any} injected by fillRegion, so patterns.js imports no tracer itself */
echoRings._tracer = null;

/**
 * Fill a region with a pattern.
 *
 * @param {import("./clip.js").Ring[]} rings  sheet mm, outer + holes
 * @param {{pattern?:string, spacing?:number, rotationDeg?:number,
 *          minLength?:number, tracer?:any}} [o]
 * @returns {{strokes:number[][], capped:boolean}}
 */
export function fillRegion(rings, o = {}) {
  const pattern = o.pattern || "lines";
  const rot = o.rotationDeg ?? 45;
  const minLen = o.minLength ?? 1;
  // Solid takes its spacing from the material, not from the control.
  let spacing = pattern === "solid" ? (o.solidMM > 0 ? o.solidMM : SOLID_MM)
    : (o.spacing > 0 ? o.spacing : 2);
  if (!rings || !rings.length) return { strokes: [], capped: false };

  if (pattern === "echo") {
    echoRings._tracer = o.tracer;
    if (!o.tracer) return { strokes: [], capped: false };
    return { strokes: echoRings(rings, spacing, minLen), capped: false };
  }

  // ⚠️ ROTATE THE REGION BACKWARDS, FILL, ROTATE THE STROKES FORWARD. The
  // families never see an angle.
  const f0 = frameOf(rings);
  const work = rot
    ? rings.map((r) => ({ hole: r.hole,
        pts: Float64Array.from(rotateAll([Array.from(r.pts)], f0.cx, f0.cy, -rot)[0]) }))
    : rings;
  const { cx, cy, half, halfY } = frameOf(work);
  const capped0 = spacing;
  // ⚠️ CAPPED ON THE DIRECTION THE ROWS STEP, not on the diagonal. Capping on the
  // diagonal made the row limit depend on a region's LENGTH, which the scanlines
  // never cross — so a long thin band was coarsened until nothing was left of it.
  spacing = capSpacing(spacing, halfY);
  const capped = spacing > capped0 + 1e-9;

  /** @type {number[][]} */
  let raw = [];
  if (LINE_FAMILIES[pattern]) {
    raw = LINE_FAMILIES[pattern](cx, cy, half, spacing, halfY);
  } else if (SYMBOLS[pattern]) {
    let { gx, gy, stagger, jitter, margin, make } = SYMBOLS[pattern](spacing);
    // ⚠️ CAP THE SYMBOL COUNT the way the Slicer does — a huge bed at a fine
    // spacing is otherwise tens of thousands of marks.
    while (((2 * half) / gx) * ((2 * half) / gy) > 6000) { gx *= 1.5; gy *= 1.5; }
    const ni = Math.floor(half / gx) + 1, nj = Math.floor(half / gy) + 1;
    for (let i = -ni; i <= ni; i++) {
      for (let j = -nj; j <= nj; j++) {
        let x = cx + i * gx + (stagger && j % 2 ? gx / 2 : 0);
        let y = cy + j * gy;
        if (jitter) {
          x += (cellRandom(i, j, 1) - 0.5) * jitter * gx * 2;
          y += (cellRandom(i, j, 2) - 0.5) * jitter * gy * 2;
        }
        // ⚠️ THE WHOLE SYMBOL SHOULD BE INSIDE, not just its centre, or marks
        // hang over the edge of a planting bed. The Slicer shrinks the region
        // by the symbol's radius; there is no buffer routine here, so the
        // symbol's own extent is tested at four cardinal points instead.
        // ⚠️ That is an APPROXIMATION, not an equivalent: a symbol tucked into
        // a sharp concave corner can still poke out diagonally. It is cheap,
        // it never rejects a symbol that genuinely fits, and the failure it
        // permits is a tick crossing an edge — not a cut in the wrong place.
        if (!pointInRings(x, y, work)) continue;
        if (margin > 0 && !(pointInRings(x - margin, y, work)
          && pointInRings(x + margin, y, work)
          && pointInRings(x, y - margin, work)
          && pointInRings(x, y + margin, work))) continue;
        raw.push(...make(x, y, cellRandom(i, j, 3), cellRandom(i, j, 4)));
      }
    }
  } else {
    throw new Error(`unknown fill pattern "${pattern}"`);
  }

  // ⚠️ EACH STROKE CLIPPED SEPARATELY — see the note at the top.
  const strokes = [];
  for (const p of raw) {
    for (const piece of clipPathToRings(Float64Array.from(p), false, work)) {
      if (runLength(Array.from(piece)) >= minLen) strokes.push(Array.from(piece));
    }
  }
  return {
    strokes: rot ? rotateAll(strokes, f0.cx, f0.cy, rot) : strokes,
    capped,
  };
}
