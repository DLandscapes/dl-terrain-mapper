// @ts-check
// A WIDE LINE, AS GEOMETRY.
//
// On a laser a line has no width: its weight is the power and speed of the pass
// it is drawn on. That is true of every pass this tool writes except one. The
// ENGRAVE pass is a raster operation — the head sweeps a FIELD, not a path — so
// a wide engraved line is a real thing, and the honest way to express it is the
// way the machine will actually make it: as an AREA, filled.
//
// ⚠️ SO WIDTH BECOMES GEOMETRY, AND NOT A NUMBER ON A LINE. This tool has been
// burnt by the alternative once already. Defect 7: a circle on the engrave pass
// was drawn solid by the preview and by the SVG, while the DXF carried a bare
// outline — "filled" was only ever true on screen, and whether it came out solid
// depended on somebody's JobControl rastering closed paths. The fix then was to
// put the distinction in the geometry, and this is the same fix for the same
// reason. A width that lived only in a stroke attribute would show in the
// preview, show in the SVG, show in the PNG, and vanish in the DXF.
//
// ⚠️ AN OPEN PATH BECOMES ONE RING; A CLOSED PATH BECOMES TWO. Offsetting a
// closed ring outward and inward gives an annulus — an outer boundary and a
// hole — which is exactly what a wide outline around a polygon is. Returning it
// as a hole rather than as two independent rings is what lets `fillRegion()`
// hatch the band and leave the middle alone.

/** Unit vector along a segment, or null when the segment has no length. */
function unit(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const L = Math.hypot(dx, dy);
  return L > 1e-12 ? [dx / L, dy / L] : null;
}

/**
 * Offset one polyline to one side by `h`.
 *
 * ⚠️ THE JOIN IS A MITRE WITH A LIMIT, FALLING BACK TO A BEVEL. At a sharp
 * enough corner the mitre point runs away to infinity — a 1 mm band at a 5°
 * corner puts it 23 mm from the line — so past the limit the two offset ends are
 * simply joined. A spike is worse than a flat corner: it is burn time spent
 * somewhere the drawing does not go.
 *
 * @param {number[]} p flat x,y
 * @param {number} h half the width, signed for the side
 * @param {boolean} closed
 * @param {number} miterLimit multiples of h before bevelling
 */
function offsetSide(p, h, closed, miterLimit = 4) {
  const n = p.length / 2;
  const out = [];
  const seg = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    const u = unit(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]);
    if (u) seg.push({ i, j, nx: -u[1], ny: u[0] });
  }
  if (!seg.length) return out;

  for (let k = 0; k < seg.length; k++) {
    const s = seg[k];
    const prev = seg[(k - 1 + seg.length) % seg.length];
    const startsRun = closed || k > 0;
    if (!startsRun) {
      out.push(p[s.i * 2] + s.nx * h, p[s.i * 2 + 1] + s.ny * h);
    } else {
      // the corner between prev and s, at vertex s.i
      const vx = p[s.i * 2], vy = p[s.i * 2 + 1];
      const mx = prev.nx + s.nx, my = prev.ny + s.ny;
      const len = Math.hypot(mx, my);
      const cosHalf = len / 2;                       // |n1+n2|/2 = cos(theta/2)
      if (len < 1e-9 || 1 / Math.max(cosHalf, 1e-9) > miterLimit) {
        // bevel: end of the previous offset, then start of this one
        out.push(vx + prev.nx * h, vy + prev.ny * h);
        out.push(vx + s.nx * h, vy + s.ny * h);
      } else {
        // (n1+n2)/|n1+n2| is the bisector; h/cos(theta/2) is how far along it the
        // mitre point sits.
        out.push(vx + (mx / len) * (h / cosHalf), vy + (my / len) * (h / cosHalf));
      }
    }
    if (!closed && k === seg.length - 1) {
      out.push(p[s.j * 2] + s.nx * h, p[s.j * 2 + 1] + s.ny * h);
    }
  }
  return out;
}

/**
 * Turn a path into the band it covers when drawn `widthMM` wide.
 *
 * @param {Float64Array|number[]} pts flat x,y in sheet mm
 * @param {number} widthMM
 * @param {boolean} closed
 * @param {number} [miterLimit] multiples of the half-width before a corner
 *   bevels. ⚠️ LETTERFORMS WANT THIS LOW. A mitre at the apex of an A overshoots
 *   the cap line — measured 0.086 mm on a 3.2 mm capital — so a title placed to
 *   sit 4 mm below the sheet edge lands at 3.914. Real typefaces flatten apexes
 *   for the same reason; at these sizes the flat is invisible and the metric is
 *   true.
 * @returns {{pts:Float64Array, hole:boolean}[]} rings, ready for fillRegion()
 */
export function strokeBand(pts, widthMM, closed, miterLimit = 4) {
  const p = Array.from(pts);
  const h = widthMM / 2;
  if (!(h > 0) || p.length < 4) return [];

  if (closed) {
    // ⚠️ OUTER FIRST, THEN THE INNER AS A HOLE. Which side is "outward" depends
    // on the ring's winding, so both are built and the one enclosing more area
    // is taken as the outer. Guessing from the winding would invert the band on
    // every counter-clockwise ring in a file — and shapefiles carry both.
    const a = offsetSide(p, h, true, miterLimit);
    const b = offsetSide(p, -h, true, miterLimit);
    if (a.length < 6 || b.length < 6) return [];
    return Math.abs(area2(a)) >= Math.abs(area2(b))
      ? [{ pts: Float64Array.from(a), hole: false },
        { pts: Float64Array.from(b), hole: true }]
      : [{ pts: Float64Array.from(b), hole: false },
        { pts: Float64Array.from(a), hole: true }];
  }

  // Open: down one side, back along the other. The ends are square caps —
  // a round cap would add vertices a laser cannot use at these widths.
  const left = offsetSide(p, h, false, miterLimit);
  const right = offsetSide(p, -h, false, miterLimit);
  if (left.length < 4 || right.length < 4) return [];
  const ring = left.slice();
  for (let i = right.length - 2; i >= 0; i -= 2) ring.push(right[i], right[i + 1]);
  return [{ pts: Float64Array.from(ring), hole: false }];
}


/**
 * Fill a band with lines that follow the path, by offsetting it again.
 *
 * ⚠️ A BAND DOES NOT NEED A SCANLINE FILL, AND SHOULD NOT HAVE ONE. Straight
 * scanlines step across whatever extent the band has in their direction, which
 * for a ring is the whole polygon and for a curve is its bounding box — so the
 * row cap fires and the band comes out striped. The lines that actually fill a
 * band are the band's own centreline offset by less: parallel to it by
 * construction, at any curvature, closed if it is closed.
 *
 * ⚠️ AND `echo` CANNOT DO IT EITHER. That pattern rasterises a distance field
 * whose cell is sized from the region's OVERALL extent — 320 cells across a
 * 200 mm polygon is 0.625 mm, which cannot resolve a 0.6 mm band at all.
 * Measured: 0% coverage. Offsetting is exact and costs nothing.
 *
 * ⚠️ AN OFFSET CAN STILL CROSS ITSELF where the path turns tighter than the
 * offset distance — a hairpin at 4 mm wide. The band's own outline has the same
 * limit; nothing here unions it away, and at engraving widths on survey geometry
 * it does not arise. It would show as a doubled burn, not as a wrong place.
 *
 * @param {Float64Array|number[]} pts the centreline
 * @param {number} widthMM
 * @param {number} spacing between fill lines
 * @param {boolean} closed
 * @returns {Float64Array[]} the fill lines
 */
export function bandFill(pts, widthMM, spacing, closed) {
  const p = Array.from(pts);
  const h = widthMM / 2;
  const step = spacing > 0 ? spacing : 0.3;
  if (!(h > 0) || p.length < 4) return [];
  const out = [];
  // ⚠️ HALF A SPACING IN FROM EACH EDGE, not from the centreline. A row sitting
  // exactly on the boundary is half outside the band, which at a cut pass would
  // be a line in the wrong place and here is ink on unburnt material.
  for (let d = -h + step / 2; d <= h - step / 2 + 1e-9; d += step) {
    const side = offsetSide(p, d, closed);
    if (side.length >= 4) {
      const line = Float64Array.from(closed ? side.concat([side[0], side[1]]) : side);
      out.push(line);
    }
  }
  // A band thinner than one spacing still gets its single centre line, or it
  // would draw as an empty outline.
  if (!out.length) {
    const mid = offsetSide(p, 0, closed);
    if (mid.length >= 4) {
      out.push(Float64Array.from(closed ? mid.concat([mid[0], mid[1]]) : mid));
    }
  }
  return out;
}

/** Twice the signed area of a flat ring. */
function area2(p) {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a;
}

/** The area a band covers, for reporting and for sanity checks. */
export function bandArea(rings) {
  let a = 0;
  for (const r of rings) a += (r.hole ? -1 : 1) * Math.abs(area2(Array.from(r.pts))) / 2;
  return a;
}
