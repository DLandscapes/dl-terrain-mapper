// @ts-check
// AN IMAGE, ENGRAVED AS MARKS — and the two ways that can mean.
//
// ⚠️ THESE ARE TWO DIFFERENT FUNCTIONS AND CONFLATING THEM IS THE MISTAKE THIS
// FILE IS SHAPED TO PREVENT.
//
//   RASTER ENGRAVE. Hand the machine a greyscale image and let its own
//   dithering burn it. Photographic, one operation, as fine as the optics allow,
//   and the file stays an image. Use it when the goal is "the ortho, on the
//   material". `rasterTile()` prepares it.
//
//   VECTOR HALFTONE. A few hundred to a few thousand circles, each sized by the
//   value under it, drawn as real paths. This is a DRAWING ABOUT the place, not
//   a picture of it: it can be measured against a legend, it can carry several
//   attributes at once, and it belongs to the same symbology as the analysis
//   sheet. `vectorHalftone()` builds it.
//
// ⚠️ THE COUNT IS THE WHOLE PRACTICAL DIFFERENCE. An image needs 150–200
// samples across before it reads as a place, and 180 × 180 is 32,400 circles —
// each one a separate path, a pierce and two head accelerations. That is the
// 3,700-dashes lesson from contours.js multiplied by ten, and it is why
// `budget()` exists and why the interface must show the number BEFORE the file
// is written. Past roughly 4,000 marks a vector halftone is the wrong tool and
// the honest answer is raster engrave.
//
// ⚠️⚠️ LICENCE. AERIAL IMAGERY IS OFTEN NOT YOURS TO CUT. Norge i bilder /
// Kartverket imagery — the ortho this family normally works with — is licensed
// for education and research only: no redistribution, no publication, and no
// derivative carrying its pixels leaving the machine. A halftone IS such a
// derivative, and a laser-cut halftone is one that can be hung on a wall. So
// provenance travels WITH the image (`ImageSource.licence`) and
// `assertExportable()` guards every path out of the tool. DL-TerrainDiversity
// solves the same problem structurally by keeping the drape out of the table
// its exporters walk; the equivalent here is that a restricted image can be
// previewed and never written. Do not add an export path that skips the guard.

import { symbolField, strideFor } from "./symbols.js";

/**
 * @typedef {object} ImageSource
 * @property {number} width
 * @property {number} height
 * @property {Uint8ClampedArray} rgb   interleaved, 3 bytes per pixel
 * @property {number} cell             map units per pixel
 * @property {number} originX          west edge
 * @property {number} originY          north edge
 * @property {"own"|"open"|"restricted"|"unknown"} licence
 * @property {string} [name]
 * @property {string} [note]           where it came from, for the report
 */

/**
 * What a channel means, and whether it means anything to a reader.
 *
 * ⚠️ RAW R, G AND B ARE OFFERED AND ARE NOT RECOMMENDED, WHICH IS WHY EACH ONE
 * SAYS SO. Three circles reading red, green and blue is mechanically fine and
 * perceptually empty: nobody looks at three radii and recovers "dry grass" or
 * "wet peat", because RGB is a property of the sensor, not of the ground. The
 * derived channels below carry the same three-circle mechanism and land on
 * quantities a landscape reader can name. Keep the mechanism; change what it
 * encodes.
 */
export const CHANNELS = {
  luminance: {
    label: "Luminance",
    hint: "The classic halftone. One circle per sample; the honest way to abstract a photograph.",
    good: true,
    f: (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255,
  },
  greenness: {
    label: "Greenness (excess green)",
    hint: "2G−R−B: vegetation against bare ground and stone. The nearest thing to an NDVI an RGB photograph can give.",
    good: true,
    f: (r, g, b) => Math.max(0, Math.min(1, (2 * g - r - b) / 255 * 0.5 + 0.5)),
  },
  brightness: {
    label: "Brightness",
    hint: "Plain lightness — snow, sand and rock against shadow and water.",
    good: true,
    f: (r, g, b) => Math.max(r, g, b) / 255,
  },
  saturation: {
    label: "Saturation",
    hint: "Colourfulness against grey. Separates vegetation and painted surfaces from stone, tarmac and water.",
    good: true,
    f: (r, g, b) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      return mx > 0 ? (mx - mn) / mx : 0;
    },
  },
  darkness: {
    label: "Darkness (inverted luminance)",
    hint: "Bigger circle where the ground is darker — the way ink behaves on paper.",
    good: true,
    f: (r, g, b) => 1 - (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255,
  },
  red: { label: "Red band", hint: "Raw sensor band. Mechanically fine, perceptually empty — prefer a derived channel.", good: false, f: (r) => r / 255 },
  green: { label: "Green band", hint: "Raw sensor band. Mechanically fine, perceptually empty — prefer greenness.", good: false, f: (r, g) => g / 255 },
  blue: { label: "Blue band", hint: "Raw sensor band. Mechanically fine, perceptually empty — prefer a derived channel.", good: false, f: (r, g, b) => b / 255 },
};

/**
 * Refuse to let restricted pixels leave. Called by every export path.
 * @param {ImageSource|null|undefined} img
 */
export function assertExportable(img) {
  if (!img) return;
  if (img.licence === "restricted") {
    throw new Error(
      `"${img.name || "this image"}" is marked as licence-restricted, so a halftone made `
      + `from it may not be written to a file. Aerial imagery supplied for education and `
      + `research (Norge i bilder / Kartverket and similar) carries that condition, and a `
      + `halftone is a derivative that carries its pixels. Use your own imagery, or obtain `
      + `written permission from the rights holder and mark the image accordingly.`);
  }
  if (img.licence === "unknown") {
    throw new Error(
      `"${img.name || "this image"}" has no licence marked. Say where it came from before `
      + `exporting: your own imagery, openly licensed data, or restricted.`);
  }
}

/**
 * Sample an image onto a grid of values in 0..1, in the image's own frame.
 *
 * ⚠️ AVERAGED OVER THE SAMPLE'S OWN FOOTPRINT, NOT POINT-SAMPLED. A single
 * pixel out of a 4 cm ortho is noise — one leaf, one shadow, one bright stone —
 * and a halftone built from it shimmers rather than describing the ground. The
 * average over the block the circle stands for is what the circle claims to
 * represent, so it is what gets measured.
 *
 * @param {ImageSource} img
 * @param {number} across how many samples along the wider side
 * @param {keyof CHANNELS|((r:number,g:number,b:number)=>number)} channel
 * @returns {{grid:Float32Array, nrows:number, ncols:number, cell:number,
 *            originX:number, originY:number}}
 */
export function sampleImage(img, across, channel) {
  const f = typeof channel === "function" ? channel : (CHANNELS[channel] || CHANNELS.luminance).f;
  const wide = Math.max(img.width, img.height);
  const step = Math.max(1, Math.round(wide / Math.max(2, across)));
  const ncols = Math.max(1, Math.floor(img.width / step));
  const nrows = Math.max(1, Math.floor(img.height / step));
  const grid = new Float32Array(nrows * ncols);
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let y = r * step; y < (r + 1) * step && y < img.height; y++) {
        for (let x = c * step; x < (c + 1) * step && x < img.width; x++) {
          const i = (y * img.width + x) * 3;
          sr += img.rgb[i]; sg += img.rgb[i + 1]; sb += img.rgb[i + 2]; n++;
        }
      }
      grid[r * ncols + c] = n ? f(sr / n, sg / n, sb / n) : NaN;
    }
  }
  return {
    grid, nrows, ncols,
    cell: img.cell * step,
    originX: img.originX, originY: img.originY,
  };
}

/**
 * How many marks a given density costs, and whether that is sane.
 * @param {number} across @param {number} [aspect] height/width
 */
export function budget(across, aspect = 1) {
  const marks = Math.round(across * across * aspect);
  return {
    marks,
    verdict: marks <= 1200 ? "comfortable"
      : marks <= 4000 ? "heavy — check the estimate before cutting"
      : "too many for vector marks — use raster engrave instead",
    ok: marks <= 4000,
  };
}

/**
 * One image, one channel, as circles in map units.
 *
 * @param {ImageSource} img
 * @param {{across?:number, channel?:string, minFraction?:number,
 *          maxFraction?:number, threshold?:number, invert?:boolean}} [o]
 * @returns {{symbols:import("./symbols.js").Symbol[], channel:string,
 *            across:number, budget:ReturnType<typeof budget>}}
 */
export function vectorHalftone(img, o = {}) {
  const across = Math.max(4, Math.round(o.across ?? 90));
  const channel = o.channel && CHANNELS[o.channel] ? o.channel : "darkness";
  const s = sampleImage(img, across, channel);
  const symbols = symbolField(s.grid, s, {
    lo: 0, hi: 1, stride: 1,
    minFraction: o.minFraction ?? 0.0,
    maxFraction: o.maxFraction ?? 0.95,
    threshold: o.threshold ?? 0.04,
    invert: o.invert,
  });
  return { symbols, channel, across, budget: budget(s.ncols, s.nrows / s.ncols) };
}

/**
 * Three channels at one set of sample points, each keeping its own identity.
 *
 * ⚠️ THIS IS THE HADSELØYA TECHNIQUE AT FULL STRETCH: several attributes
 * coexisting because each keeps its own fill-and-stroke identity — which here
 * means its own laser pass. The three are drawn CONCENTRICALLY at the same
 * sample point, so a reader compares three radii about one centre rather than
 * hunting three scattered dots.
 *
 * ⚠️ THE SAMPLE COUNT IS THE SAME BUT THE MARK COUNT IS TRIPLED, and the budget
 * below reports the honest number. A "modest" 60-across triple is 10,800 marks.
 *
 * @param {ImageSource} img
 * @param {{across?:number, channels?:string[], minFraction?:number,
 *          maxFraction?:number, threshold?:number}} [o]
 * @returns {{layers:{channel:string, label:string, recommended:boolean,
 *            symbols:import("./symbols.js").Symbol[]}[],
 *            budget:ReturnType<typeof budget>}}
 */
export function tripleHalftone(img, o = {}) {
  const across = Math.max(4, Math.round(o.across ?? 50));
  const chans = (o.channels && o.channels.length === 3)
    ? o.channels
    : ["greenness", "brightness", "saturation"];
  const layers = [];
  let ncols = 0, aspect = 1;
  // Each channel gets a smaller maximum than the last so the three circles nest
  // instead of coinciding — the innermost can still reach the outermost's size
  // only if its value is far higher, which is exactly the comparison wanted.
  const maxes = [o.maxFraction ?? 0.95, (o.maxFraction ?? 0.95) * 0.66, (o.maxFraction ?? 0.95) * 0.36];
  chans.forEach((ch, i) => {
    const def = CHANNELS[ch] || CHANNELS.luminance;
    const s = sampleImage(img, across, ch);
    ncols = s.ncols; aspect = s.nrows / s.ncols;
    layers.push({
      channel: ch,
      label: def.label,
      recommended: !!def.good,
      symbols: symbolField(s.grid, s, {
        lo: 0, hi: 1, stride: 1,
        minFraction: o.minFraction ?? 0.0,
        maxFraction: maxes[i],
        threshold: o.threshold ?? 0.04,
      }),
    });
  });
  const b = budget(ncols, aspect);
  return { layers, budget: { ...b, marks: b.marks * 3, ok: b.marks * 3 <= 4000 } };
}

/**
 * A greyscale tile for the machine's OWN dithering — the other answer.
 *
 * Returns plain pixel data; turning it into a PNG needs a canvas and therefore
 * belongs to the page, not to this module, which stays testable without a DOM.
 * @param {ImageSource} img
 * @param {{channel?:string, gamma?:number, invert?:boolean}} [o]
 * @returns {{width:number, height:number, grey:Uint8ClampedArray}}
 */
export function rasterTile(img, o = {}) {
  const def = CHANNELS[o.channel] || CHANNELS.luminance;
  const gamma = o.gamma ?? 1;
  const grey = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0, n = img.width * img.height; i < n; i++) {
    let v = def.f(img.rgb[i * 3], img.rgb[i * 3 + 1], img.rgb[i * 3 + 2]);
    if (gamma !== 1) v = Math.pow(Math.max(0, Math.min(1, v)), gamma);
    if (o.invert) v = 1 - v;
    grey[i] = v * 255;
  }
  return { width: img.width, height: img.height, grey };
}
