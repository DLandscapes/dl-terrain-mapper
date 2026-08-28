// @ts-check
// SVG OUT — the same drawing, for anything that is not a laser front-end.
//
// A DXF is what the machine wants. An SVG is what everything else wants: a
// print layout, a poster, a figure in a report, Illustrator, Inkscape, a web
// page. This writes the SAME `Drawing` the DXF writer takes, so the two cannot
// drift — one geometry, now three outputs.
//
// ⚠️ SVG'S Y AXIS POINTS DOWN AND THE SHEET'S POINTS UP. Every coordinate is
// flipped here, once, at the boundary. Miss it and the drawing is a perfect
// mirror of itself about the horizontal — which on a contour map is almost
// impossible to spot by eye and completely wrong.
//
// ⚠️ THE COLOURS ARE THE PASSES' OWN, from PASS_COLOURS in dxf.js. Same single
// table as the preview and the file. An SVG exported in "nicer" colours would be
// a third palette and the one most likely to end up in a printed document with
// nobody able to say which pass a line belonged to.
//
// ⚠️ STROKE WIDTH IS A HAIRLINE AND MEANS NOTHING TO THE MACHINE. On a laser the
// weight of a line is the power and speed of its pass; the width here exists so
// the file is visible when opened. Cutters that read SVG generally treat any
// stroke as a path to follow, so the value is deliberately small and stated.
//
// ⚠️ WITH ONE EXCEPTION, AND IT IS NOT AN EXCEPTION TO THAT RULE. The ENGRAVE
// pass is the one raster operation — the head sweeps a field — and every solid
// this tool draws is strokes spaced `SOLID_MM` apart, the distance at which the
// burns merge. Drawing those as hairlines shows a filled scale bar, a north
// needle and a letter as a set of separate stripes, which is not what comes off
// the machine. So engrave-pass paths are stroked at `BURN_MM`, the width one of
// those burns actually is: still not a weight the cutter reads, still only
// visibility, but now visible as the thing it will be.

import { PASS_COLOURS, DLF_LAYERS, SHEET_LAYER } from "./dxf.js";
import { BURN_MM } from "./patterns.js";

/** Six decimals, never an exponent — same rule the DXF writer keeps. */
function num(v) {
  if (!Number.isFinite(v)) return "0";
  let s = v.toFixed(4);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

/**
 * A compiled drawing as SVG.
 *
 * @param {import("./compile.js").Drawing} drawing
 * @param {{strokeMM?:number, background?:string|null, sheetLayer?:boolean,
 *          title?:string}} [o]
 * @returns {string}
 */
export function toSVG(drawing, o = {}) {
  const W = drawing.sheet.width, H = drawing.sheet.height;
  const stroke = o.strokeMM ?? 0.1;
  const sheetLayer = o.sheetLayer !== false;

  // ⚠️ THE ONE FLIP. Sheet y is up from the lower left; SVG y is down from the
  // upper left.
  const X = (x) => num(x);
  const Y = (y) => num(H - y);

  // ⚠️ THE SAME SHEET FILTER AS THE DXF WRITER. A two-material drawing is one
  // Drawing and several files; an SVG that ignored the sheet axis would show
  // both boards' geometry as if it were one, which is exactly the confusion the
  // axis exists to prevent.
  const wantSheet = o.sheet;
  const onSheet = (e) => wantSheet === undefined || (e.sheet || "surface") === wantSheet;

  /** @type {Map<string, {paths:any[], circles:any[]}>} */
  const byLayer = new Map();
  const bucket = (name) => {
    let b = byLayer.get(name);
    if (!b) { b = { paths: [], circles: [] }; byLayer.set(name, b); }
    return b;
  };
  for (const p of drawing.paths) if (onSheet(p)) bucket(p.layer).paths.push(p);
  for (const c of drawing.circles) if (onSheet(c)) bucket(c.layer).circles.push(c);

  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<!-- ${esc(o.title || "DL-TerrainMapper")} — one drawing, coloured by laser pass.`);
  out.push(`     Colours are the DLF passes' own; a hairline stroke is for visibility only,`);
  out.push(`     because on the machine a line's weight is its pass's power and speed. -->`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1"`);
  out.push(`  width="${num(W)}mm" height="${num(H)}mm"`);
  out.push(`  viewBox="0 0 ${num(W)} ${num(H)}">`);
  if (o.title) out.push(`  <title>${esc(o.title)}</title>`);
  if (o.background) {
    out.push(`  <rect x="0" y="0" width="${num(W)}" height="${num(H)}" fill="${esc(o.background)}"/>`);
  }

  // ⚠️ EMITTED IN PASS ORDER, NOT IN THE ORDER THE COMPILER HAPPENED TO BUILD
  // THEM. Later elements paint over earlier ones in SVG, so engrave must go
  // down first and the cut outline last — the same order the machine runs, and
  // the same order the DXF is written in.
  const order = [...DLF_LAYERS.map((l) => l[0]), SHEET_LAYER[0]];
  for (const name of order) {
    const b = byLayer.get(name);
    if (!b || (!b.paths.length && !b.circles.length)) continue;
    if (name === SHEET_LAYER[0] && !sheetLayer) continue;
    const colour = PASS_COLOURS[name] || "#000000";
    // The sheet boundary is not an operation; it is shown dashed and faint so
    // nobody mistakes it for something the machine will follow.
    const isBoundary = name === SHEET_LAYER[0];
    // The engrave pass is drawn at the width it burns — see the note at the top.
    const w = name === "DLF-00_engrave" ? Math.max(stroke, BURN_MM) : stroke;
    out.push(`  <g id="${esc(name)}" fill="none" stroke="${colour}"`
      + ` stroke-width="${num(w)}" stroke-linecap="round" stroke-linejoin="round"`
      + (isBoundary ? ` stroke-dasharray="2 2" opacity="0.5"` : "") + `>`);
    for (const p of b.paths) {
      const pts = p.pts;
      if (pts.length < 4) continue;
      let d = `M ${X(pts[0])} ${Y(pts[1])}`;
      for (let i = 2; i < pts.length; i += 2) d += ` L ${X(pts[i])} ${Y(pts[i + 1])}`;
      if (p.closed) d += " Z";
      out.push(`    <path d="${d}"/>`);
    }
    if (b.circles.length) {
      // ⚠️ THE ENGRAVE PASS IS FILLED, EVERYTHING ELSE IS STROKED. An engraved
      // halftone dot is a filled mark on the material, and drawing it as a ring
      // in a printed figure would misrepresent the object. On any other pass a
      // circle is a path the head follows, so it stays an outline.
      const filled = name === DLF_LAYERS[0][0];
      out.push(`    <g${filled ? ` fill="${colour}" stroke="none"` : ""}>`);
      for (const c of b.circles) {
        out.push(`      <circle cx="${X(c.cx)}" cy="${Y(c.cy)}" r="${num(c.r)}"/>`);
      }
      out.push(`    </g>`);
    }
    out.push(`  </g>`);
  }
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}
