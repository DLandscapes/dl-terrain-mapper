// @ts-check
// GML — the same features, as XML.
//
// A second door into the feature pipeline, beside the shapefile reader. It
// produces the same shapes, so everything downstream — the 24 fill patterns,
// the attribute-driven sizing, the clip — works on a GML layer without knowing
// where it came from.
//
// ⚠️ GML CARRIES WHAT A SHAPEFILE NEEDS THREE FILES TO SAY. The geometry, the
// attributes and the coordinate system are all in the one document: `srsName`
// is the .prj, the feature's own child elements are the .dbf. So a GML layer
// can be dropped on its own and still be fully styled and fully checked, which
// a lone .shp cannot.
//
// ⚠️ THIS IS A SUBSET AND SAYS SO. GML is not a format, it is a framework for
// writing formats, and no reader handles all of it. What is covered: GML 2 and
// GML 3 geometry — Point, LineString, LinearRing, Polygon, Curve, Surface and
// the Multi* forms — under the usual FeatureCollection wrappers, with `pos`,
// `posList` and GML 2 `coordinates`. What is not: schema resolution, xlink
// references between features, arcs and circles as true curves, and 3D as
// anything other than a Z to discard. Anything unrecognised is COUNTED AND
// REPORTED rather than skipped in silence — a layer that silently loses half
// its features is worse than one that refuses.

import { parseXML, findAll } from "./xml.js";

/** Geometry containers we can walk, in the order it is worth trying them. */
const AREAL = ["Polygon", "Surface", "MultiSurface", "MultiPolygon"];
const LINEAL = ["LineString", "Curve", "MultiCurve", "MultiLineString", "LinearRing"];
const PUNCTUAL = ["Point", "MultiPoint"];
const GEOMETRY = new Set([...AREAL, ...LINEAL, ...PUNCTUAL, "MultiGeometry"]);

/**
 * The EPSG code out of any of the five spellings of `srsName` in the wild.
 *
 * ⚠️ THE LAST NUMBER WINS, and that is not laziness: `urn:x-ogc:def:crs:EPSG:6.6:25833`
 * carries the EPSG registry VERSION (6.6) before the code, so taking the first
 * number returns "6" and labels a Norwegian tile as something in the Atlantic.
 *
 * @param {string|undefined} srs
 * @returns {{epsg:string|null, urnForm:boolean}}
 */
export function parseSRS(srs) {
  const s = String(srs || "").trim();
  if (!s) return { epsg: null, urnForm: false };
  // urn: and the OGC http form both put the authority ahead of the code and
  // both imply EPSG's own axis order — which is why the form matters, not just
  // the number.
  const urnForm = /^urn:|^http:\/\/www\.opengis\.net\/def\/crs\//i.test(s);
  const nums = s.match(/\d+/g);
  if (!nums || !nums.length) return { epsg: null, urnForm };
  return { epsg: `EPSG:${nums[nums.length - 1]}`, urnForm };
}

/**
 * ⚠️ EPSG DEFINES SOME COORDINATE SYSTEMS LATITUDE FIRST, and GML in `urn:`
 * form is required to honour that. So the very same numbers mean (E, N) when
 * the file says `EPSG:25833` and (N, E) when it says
 * `urn:ogc:def:crs:EPSG::4326`. This is the single commonest way a GML layer
 * lands in the wrong hemisphere, and it looks like a broken tool rather than a
 * convention.
 *
 * Only the geographic systems this tool is likely to meet are listed. Anything
 * unknown is read in file order, which is right for every projected CRS a UTM
 * raster will be paired with.
 */
const LAT_FIRST = new Set(["EPSG:4326", "EPSG:4258", "EPSG:4979", "EPSG:4269"]);

/** Numbers out of a posList/pos, dropping the Z when the file declares three. */
function ordinates(node) {
  const dim = +(node.attrs.srsDimension || node.attrs.dimension || 0) || 0;
  const raw = (node.text || "").trim().split(/[\s,]+/).filter((t) => t !== "");
  const nums = raw.map(Number);
  if (!nums.length || nums.some((v) => !Number.isFinite(v))) return [];
  // ⚠️ A 3D posList READ AS PAIRS IS NOT SLIGHTLY WRONG, IT IS SCRAMBLED: the
  // second point becomes (z, x), the third (y, z). The result still plots, as a
  // spray of nonsense across the sheet, which is why it has to be caught here
  // and not left to look like bad data.
  if (dim === 3) {
    const out = [];
    for (let i = 0; i + 2 < nums.length + 1; i += 3) out.push(nums[i], nums[i + 1]);
    return out;
  }
  return nums;
}

/**
 * GML 2 `<coordinates>`: tuples separated by `ts`, ordinates by `cs`.
 * The defaults are a space and a comma, and files do override them.
 */
function gml2Coordinates(node) {
  const cs = node.attrs.cs || ",";
  const ts = node.attrs.ts || " ";
  const dec = node.attrs.decimal || ".";
  let txt = (node.text || "").trim();
  if (!txt) return [];
  if (dec !== ".") txt = txt.split(dec).join(".");
  const out = [];
  for (const tuple of txt.split(new RegExp(`[${ts.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\s]+`))) {
    if (!tuple) continue;
    const parts = tuple.split(cs).map(Number);
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
    out.push(parts[0], parts[1]);          // a third ordinate is elevation; dropped
  }
  return out;
}

/** Every coordinate in one geometry element, as a flat list per ring/line. */
function coordLists(node) {
  /** @type {number[][]} */
  const out = [];
  for (const p of findAll(node, "posList")) { const v = ordinates(p); if (v.length >= 4) out.push(v); }
  for (const c of findAll(node, "coordinates")) {
    const v = gml2Coordinates(c); if (v.length >= 4) out.push(v);
  }
  if (!out.length) {
    // A run of <gml:pos> elements is a legal way to write a line, too.
    const pts = [];
    for (const p of findAll(node, "pos")) pts.push(...ordinates(p));
    if (pts.length >= 4) out.push(pts);
  }
  return out;
}

/** A single point's coordinates. */
function pointOf(node) {
  const pos = findAll(node, "pos")[0];
  if (pos) { const v = ordinates(pos); if (v.length >= 2) return [v[0], v[1]]; }
  const co = findAll(node, "coordinates")[0];
  if (co) { const v = gml2Coordinates(co); if (v.length >= 2) return [v[0], v[1]]; }
  return null;
}

/** Signed area × 2 — positive is counter-clockwise. */
function area2(p) {
  let s = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return s;
}

/**
 * Pull the geometry out of one feature.
 *
 * @returns {{kind:string, rings:{pts:Float64Array,hole:boolean}[],
 *            points:{x:number,y:number}[]}|null}
 */
function geometryOf(featureEl, swap) {
  const fix = (flat) => {
    const out = new Float64Array(flat.length);
    for (let i = 0; i < flat.length; i += 2) {
      out[i] = swap ? flat[i + 1] : flat[i];
      out[i + 1] = swap ? flat[i] : flat[i + 1];
    }
    return out;
  };

  // Areas first: a Polygon contains LinearRings, which are also "lineal", so
  // asking in the other order would file every polygon as a line.
  for (const tag of AREAL) {
    const found = findAll(featureEl, tag);
    if (!found.length) continue;
    const rings = [];
    for (const g of found) {
      // ⚠️ INTERIOR RINGS ARE HOLES AND MUST BE MARKED, or a courtyard is
      // filled in and a lake becomes land. GML 3 says `interior`, GML 2 says
      // `innerBoundaryIs`; both appear.
      const inner = new Set();
      for (const tagName of ["interior", "innerBoundaryIs"]) {
        for (const h of findAll(g, tagName)) for (const r of findAll(h, "LinearRing")) inner.add(r);
      }
      for (const r of findAll(g, "LinearRing")) {
        for (const flat of coordLists(r)) {
          if (flat.length < 6) continue;
          rings.push({ pts: fix(flat), hole: inner.has(r) });
        }
      }
      // A Surface patch may carry its posList without a LinearRing wrapper.
      if (!findAll(g, "LinearRing").length) {
        for (const flat of coordLists(g)) {
          if (flat.length >= 6) rings.push({ pts: fix(flat), hole: false });
        }
      }
    }
    if (rings.length) {
      // ⚠️ WINDING IS NOT TRUSTED FROM THE FILE for the outer ring. GML does not
      // require a direction, and plenty of writers emit both. Only rings the
      // document itself called `interior` are holes.
      for (const r of rings) if (!r.hole && area2(r.pts) === 0) r.hole = false;
      return { kind: "polygon", rings, points: [] };
    }
  }

  for (const tag of LINEAL) {
    const found = findAll(featureEl, tag);
    if (!found.length) continue;
    const rings = [];
    for (const g of found) {
      for (const flat of coordLists(g)) {
        if (flat.length >= 4) rings.push({ pts: fix(flat), hole: false });
      }
    }
    if (rings.length) return { kind: "line", rings, points: [] };
  }

  for (const tag of PUNCTUAL) {
    const found = findAll(featureEl, tag);
    if (!found.length) continue;
    const points = [];
    for (const g of found) {
      for (const p of findAll(g, "Point").length ? findAll(g, "Point") : [g]) {
        const xy = pointOf(p);
        if (xy) points.push(swap ? { x: xy[1], y: xy[0] } : { x: xy[0], y: xy[1] });
      }
    }
    if (points.length) return { kind: "point", rings: [], points };
  }
  return null;
}

/** A feature's simple-content children become its attribute row. */
function attributesOf(featureEl) {
  /** @type {Record<string, any>} */
  const row = {};
  for (const c of featureEl.children) {
    if (GEOMETRY.has(c.name)) continue;
    // A property that WRAPS a geometry (<ns:the_geom><gml:Polygon/></ns:the_geom>)
    // is not an attribute either.
    if (c.children.some((k) => GEOMETRY.has(k.name))) continue;
    if (c.children.length) continue;               // nested structure, not a value
    const t = (c.text || "").trim();
    if (t === "") continue;
    const n = Number(t);
    row[c.name.toUpperCase()] = t !== "" && Number.isFinite(n) && /^[-+0-9.eE]+$/.test(t) ? n : t;
  }
  return row;
}

/**
 * Read a GML document into feature layers, one per geometry kind present.
 *
 * ⚠️ ONE FILE CAN HOLD SEVERAL GEOMETRY KINDS, which a shapefile cannot. They
 * are split into separate layers rather than forced together, because a fill
 * pattern means nothing on a point and a radius means nothing on an area — the
 * whole reason the tool keeps three lists.
 *
 * @param {string} text
 * @param {{name?:string, demBBox?:{x0:number,y0:number,x1:number,y1:number}}} [o]
 * @returns {{layers:{kind:string, rings:{pts:Float64Array,hole:boolean}[],
 *            points:{x:number,y:number}[], count:number,
 *            rows:Record<string,any>[]|null, fields:string[], numeric:string[]}[],
 *            crs:string|null, srsName:string|null, features:number,
 *            unreadable:number, bbox:{x0:number,y0:number,x1:number,y1:number}|null,
 *            axisSwapped:boolean, notes:string[]}}
 */
export function readGML(text, o = {}) {
  const notes = [];
  let root;
  try {
    root = parseXML(text);
  } catch (e) {
    throw new Error(`${o.name || "this file"} is not XML this reader can follow: ${e.message}`);
  }

  // ⚠️ srsName MAY BE ON THE COLLECTION, ON THE FEATURE, OR ON THE GEOMETRY, and
  // the innermost one wins in the specification. In practice files put it in one
  // place; the first one found anywhere is used and the fact is reported, rather
  // than pretending to a per-geometry resolution the rest of the tool could not
  // act on anyway — nothing here reprojects.
  let srsName = root.attrs.srsName || null;
  if (!srsName) {
    const walk = (n) => {
      if (srsName) return;
      if (n.attrs.srsName) { srsName = n.attrs.srsName; return; }
      for (const c of n.children) walk(c);
    };
    walk(root);
  }
  const { epsg, urnForm } = parseSRS(srsName);
  const swap = !!(epsg && urnForm && LAT_FIRST.has(epsg));
  if (swap) {
    notes.push(`${srsName} is a latitude-first system in urn form, so the ordinates were `
      + `read as northing then easting — that is what the specification requires and it is `
      + `the commonest reason a GML layer lands in the wrong place.`);
  }

  // Feature members, under any of the wrappers in use.
  let features = [];
  for (const tag of ["featureMember", "featureMembers", "member"]) {
    for (const m of findAll(root, tag)) features.push(...m.children);
  }
  if (!features.length) {
    // A bare collection, or a single feature at the root.
    features = root.children.filter((c) => !GEOMETRY.has(c.name));
    if (!features.length) features = [root];
  }

  const buckets = new Map();
  let unreadable = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const eat = (x, y) => {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  };

  for (const f of features) {
    const g = geometryOf(f, swap);
    if (!g) { unreadable++; continue; }
    if (!buckets.has(g.kind)) {
      buckets.set(g.kind, { kind: g.kind, rings: [], points: [], rows: [] });
    }
    const b = buckets.get(g.kind);
    b.rings.push(...g.rings);
    b.points.push(...g.points);
    // ⚠️ ONE ROW PER RING, NOT PER FEATURE, because that is how the rest of the
    // tool reads them: `features.js` takes `rows[i]` for ring `i` when sizing or
    // turning a symbol by a value. A polygon with a courtyard is ONE feature
    // with TWO rings, and a multipolygon more still — so the feature's own
    // attributes are repeated across its rings, which is what they mean. Pushing
    // one row per feature instead left every attribute after the first hole
    // pointing at the wrong shape.
    const row = attributesOf(f);
    const n = g.kind === "point" ? g.points.length : g.rings.length;
    for (let i = 0; i < n; i++) b.rows.push(row);
    for (const r of g.rings) for (let i = 0; i < r.pts.length; i += 2) eat(r.pts[i], r.pts[i + 1]);
    for (const p of g.points) eat(p.x, p.y);
  }

  if (unreadable) {
    notes.push(`${unreadable} feature${unreadable === 1 ? "" : "s"} carried no geometry this `
      + `reader could follow and ${unreadable === 1 ? "was" : "were"} left out — arcs, circles `
      + `and xlink references to geometry held elsewhere are the usual causes.`);
  }

  const layers = [...buckets.values()].map((b) => {
    // ⚠️ ONE ROW PER FEATURE, NOT PER RING. A multipolygon is one feature with
    // one set of attributes, so pairing rows to rings would misalign every
    // attribute after the first multipart — which is exactly the failure
    // `assertPairs` exists to catch on the .dbf side.
    const count = b.kind === "point" ? b.points.length : b.rings.length;
    const fields = [...new Set(b.rows.flatMap((r) => Object.keys(r)))];
    const numeric = fields.filter((k) =>
      b.rows.some((r) => typeof r[k] === "number")
      && b.rows.every((r) => r[k] === undefined || typeof r[k] === "number"));
    const paired = b.rows.length === count ? b.rows : null;
    return { kind: b.kind, rings: b.rings, points: b.points, count,
      rows: paired, fields: paired ? fields : [], numeric: paired ? numeric : [] };
  });

  for (const L of layers) {
    if (!L.rows && L.count) {
      notes.push(`${L.kind === "point" ? "points" : L.kind === "line" ? "lines" : "areas"}: `
        + `multipart features mean there are more shapes than attribute rows, so the `
        + `attributes were dropped rather than lined up wrongly.`);
    }
  }

  return {
    layers, crs: epsg, srsName, features: features.length, unreadable,
    bbox: Number.isFinite(x0) ? { x0, y0, x1, y1 } : null,
    axisSwapped: swap, notes,
  };
}
