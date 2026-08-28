// @ts-check
// THE DRAWING AS A PICTURE — a greyscale raster for engraving.
//
// Everything this tool makes is line work, and a laser can take line work two
// ways: as vectors it traces with the head, or as a raster it sweeps like a
// printer. This is the second. The whole drawing becomes one image, nothing is
// cut, and the machine engraves what it sees.
//
// ⚠️ NOTHING IS CUT. NOT THE OUTER CUT EITHER. Run as a raster, DLF-05 stops
// being the line that releases the plate and becomes a dark line drawn on it.
// The part stays in the sheet. That is the point of the mode and it is still
// the first thing anyone will forget, so the exporter says it every time rather
// than trusting a heading to carry it.
//
// ⚠️ GREY IS POWER, AND COLOUR IS NOT. On screen a pass is a colour so a reader
// can tell operations apart; in a raster engrave the pixel value IS how hard
// the machine burns, so the passes have to become an intensity ladder instead.
// Handing a raster engraver the screen palette would put pure green and pure
// cyan at nearly the same luminance — DLF-02 and DLF-03, two operations
// deliberately distinguishable on screen, arriving at the material as the same
// depth.
//
// ⚠️ THE LADDER BELOW IS A JUSTIFIED GUESS, LIKE EVERY OTHER FLOOR IN THIS TOOL
// THAT THE COUPON HAS NOT READ YET. It orders the passes the way the machine
// orders them — a surface mark, three scores, two cuts — and spaces them evenly
// enough to be told apart. The honest version is derived from the POWER each
// pass is actually configured at, and no power/speed values exist anywhere in
// this family's records yet. When the SP500 coupon is read, this table is one
// of the things it settles.

import { BURN_MM } from "./patterns.js";

/** Ink for each pass when the drawing is flattened to one engraved image. */
export const ENGRAVE_GREY = {
  "DLF-00_engrave": 0.35,
  "DLF-01_score_light": 0.45,
  "DLF-02_score_medium": 0.60,
  "DLF-03_score_strong": 0.75,
  "DLF-04_cut_inner": 0.90,
  "DLF-05_cut_outer": 1.00,
};

/** The offered resolutions. */
export const DPI_LADDER = [72, 150, 300];

/** The passes that cut through, and so belong in the vector file, not the image. */
export const CUT_LAYERS = ["DLF-04_cut_inner", "DLF-05_cut_outer"];

/**
 * The same Drawing, showing only what cuts.
 *
 * ⚠️ A SELECTION, NOT A SECOND DRAWING. It filters the entities `compile()`
 * produced and keeps `sheet` untouched — which is the whole point: the SVG and
 * the PNG must describe the SAME sheet, same origin, same size, or the operator
 * rasters the field, swaps files, and cuts an outline that no longer sits over
 * it. Building the cut file from its own geometry is exactly the mistake the
 * one-drawing rule exists to prevent.
 *
 * @param {import("./compile.js").Drawing} d
 * @param {{sheet?:string}} [o]
 * @returns {import("./compile.js").Drawing}
 */
export function cutLinesOnly(d, o = {}) {
  const keep = (e) => CUT_LAYERS.includes(e.layer)
    && (o.sheet === undefined || (e.sheet || "surface") === o.sheet);
  return { ...d, paths: d.paths.filter(keep), circles: (d.circles || []).filter(keep) };
}

/**
 * ⚠️ BROWSERS CAP A CANVAS, AND THE CAP IS NOT ONE NUMBER. Chrome refuses any
 * side over 16,384 px and, separately, refuses very large AREAS; a canvas that
 * exceeds either comes back BLANK rather than throwing, which would export a
 * white PNG and look like the tool lost the drawing. Both are checked before
 * anything is allocated.
 */
export const MAX_SIDE = 16384;
export const MAX_MEGAPIXELS = 256;

/** How many image pixels one millimetre of sheet becomes. */
export const pxPerMM = (dpi) => dpi / 25.4;

/**
 * Work out the image before making it, so the page can show the size, refuse
 * politely, and say why a line got fatter.
 *
 * ⚠️ A STROKE THINNER THAN ABOUT A PIXEL AND A HALF DOES NOT SURVIVE
 * RASTERISATION. It lands as a row of pale antialiased grey — which, since grey
 * IS power here, is not a faint line but a line the machine barely burns.
 * Widening it is the honest fix and the tool reports that it happened; the
 * alternative, drawing it at its true width and letting it disappear, is a
 * drawing that lies about what will be engraved.
 *
 * @param {{width:number, height:number}} sheet millimetres
 * @param {{dpi?:number, strokeMM?:number}} [o]
 * @returns {{dpi:number, wPx:number, hPx:number, scale:number, strokeMM:number,
 *            requestedMM:number, floorMM:number, widened:boolean,
 *            megapixels:number, ok:boolean, refusal:string|null}}
 */
export function rasterPlan(sheet, o = {}) {
  const dpi = o.dpi || 300;
  const scale = pxPerMM(dpi);
  const wPx = Math.max(1, Math.round(sheet.width * scale));
  const hPx = Math.max(1, Math.round(sheet.height * scale));
  const megapixels = (wPx * hPx) / 1e6;

  const requestedMM = o.strokeMM ?? 0.25;
  const floorMM = 1.5 / scale;
  const strokeMM = Math.max(requestedMM, floorMM);

  // ⚠️ A REFUSAL MUST NAME A FIX THE READER CAN ACTUALLY MAKE. The first version
  // of this said "this sheet tops out near 59 dpi" — true, and useless, because
  // the lowest resolution on offer is 72. Naming a number no control can be set
  // to reads as the tool blaming the user for its own limit. When even the
  // coarsest setting overruns, the real problem is not the resolution: it is a
  // sheet metres across, and the fix is the SCALE or a tile boundary.
  const biggestMM = Math.max(sheet.width, sheet.height);
  const bestDPI = Math.floor(MAX_SIDE / (biggestMM / 25.4));
  const size = `${Math.round(sheet.width)} × ${Math.round(sheet.height)} mm`
    + (biggestMM >= 1500 ? ` (${(sheet.width / 1000).toFixed(2)} × `
      + `${(sheet.height / 1000).toFixed(2)} m)` : "");
  let refusal = null;
  if (wPx > MAX_SIDE || hPx > MAX_SIDE) {
    refusal = `${wPx} × ${hPx} px is past the ${MAX_SIDE} px a browser canvas will hold. `
      + (bestDPI >= DPI_LADDER[0]
        ? `This sheet takes up to ${bestDPI} dpi — use ${
          DPI_LADDER.filter((d) => d <= bestDPI).slice(-1)[0]} dpi.`
        : `The sheet is ${size}, and at that size even ${DPI_LADDER[0]} dpi overruns — no `
          + `resolution here will fit it. Reduce the scale in Compose, or clip to a tile: a `
          + `sheet this size is past any bed or printer as well.`);
  } else if (megapixels > MAX_MEGAPIXELS) {
    refusal = `${megapixels.toFixed(0)} megapixels is more than a browser canvas will paint, `
      + `and it would come back blank rather than fail. `
      + (bestDPI >= DPI_LADDER[0] ? `Try ${DPI_LADDER[0]} dpi.`
        : `The sheet is ${size} — reduce the scale in Compose, or clip to a tile.`);
  }

  return { dpi, wPx, hPx, scale, strokeMM, requestedMM, floorMM,
    widened: strokeMM > requestedMM + 1e-9, megapixels, ok: !refusal, refusal };
}

/**
 * Paint a compiled Drawing onto a 2D context as greyscale engraving.
 *
 * ⚠️ IT RENDERS THE SAME `Drawing` THE DXF, THE SVG AND THE PREVIEW RENDER, and
 * builds no geometry of its own — that is the one-drawing rule, and it is why a
 * fourth output can be added without a fourth chance to disagree. Every mark
 * here came out of `compile()`.
 *
 * ⚠️ THE SHEET BOUNDARY IS NOT DRAWN. DLF-99 is a declaration of where the
 * material ends, not an operation; engraved, it would be a rectangle burnt
 * around the drawing.
 *
 * ⚠️ Y IS FLIPPED ONCE, HERE. Sheet millimetres run north-up; image rows run
 * downward. Doing it in the transform rather than per point means no call site
 * can forget, and the geometry is untouched.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {import("./compile.js").Drawing} d
 * @param {ReturnType<typeof rasterPlan>} plan
 * @param {{sheet?:string}} [o] one material sheet only, when there are several
 */
export function paintEngraving(ctx, d, plan, o = {}) {
  const { scale, strokeMM } = plan;
  ctx.save();
  // ⚠️ TRANSPARENT IS OFFERED AND IS NOT THE DEFAULT. Several laser drivers
  // composite an alpha channel onto BLACK, which turns an empty background into
  // a full-power burn over the whole plate — the worst failure this file could
  // cause, and silent until the material is in the machine. White is what
  // "engrave nothing here" means to a raster engraver.
  if (!o.transparent) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, plan.wPx, plan.hPx);
  }
  ctx.setTransform(scale, 0, 0, -scale, 0, d.sheet.height * scale);
  ctx.lineWidth = strokeMM;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const want = (e) => (o.sheet === undefined || (e.sheet || "surface") === o.sheet)
    && e.layer !== "DLF-99_sheet";

  const byLayer = new Map();
  const bucket = (k) => {
    if (!byLayer.has(k)) byLayer.set(k, { paths: [], circles: [] });
    return byLayer.get(k);
  };
  for (const p of d.paths) if (want(p)) bucket(p.layer).paths.push(p);
  for (const c of d.circles || []) if (want(c)) bucket(c.layer).circles.push(c);

  // Darkest last, so where two operations cross the deeper one shows.
  const order = [...byLayer.keys()].sort(
    (a, b) => (ENGRAVE_GREY[a] ?? 0.5) - (ENGRAVE_GREY[b] ?? 0.5));

  for (const layer of order) {
    const g = byLayer.get(layer);
    const k = ENGRAVE_GREY[layer] ?? 0.5;
    const v = Math.round(255 * (1 - k));
    const ink = `rgb(${v},${v},${v})`;
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    // ⚠️ THE ENGRAVE PASS IS NEVER THINNER THAN THE MERGE DISTANCE. Every solid
    // in this tool is strokes `SOLID_MM` apart; drawing them narrower than that
    // spacing puts white gaps into a field that comes off the bed black, and the
    // picture is meant to be what the machine makes. The control still widens
    // the pass, it just cannot make it lie thinner.
    ctx.lineWidth = layer === "DLF-00_engrave" ? Math.max(strokeMM, BURN_MM) : strokeMM;
    if (g.paths.length) {
      ctx.beginPath();
      for (const p of g.paths) {
        const pts = p.pts;
        if (pts.length < 4) continue;
        ctx.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        if (p.closed) ctx.closePath();
      }
      ctx.stroke();
    }
    if (g.circles.length) {
      ctx.beginPath();
      for (const c of g.circles) {
        if (c.r <= 0) continue;
        ctx.moveTo(c.cx + c.r, c.cy);
        ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
      }
      // The engrave pass is a filled field on the bed, so it is filled here —
      // the same distinction `hatchCircle()` puts into the geometry elsewhere.
      if (layer === "DLF-00_engrave") ctx.fill();
      else ctx.stroke();
    }
  }
  ctx.restore();
}
