# DL-TerrainMapper

**A laser-cut map compiler.** Terrain and field observations in; a fabricable drawing out —
engraved contours, labelled heights, located photograph marks, analysis and image halftones —
where the symbology maps to **laser operations** instead of to pixels.

The shortest framing: *QGIS symbology, but the render target is a laser bed.*

---

## Run it

Double-click **`start.bat`** in the folder above this one. That is the whole procedure — no
install, no build step, no dependencies. The tool is plain browser ES modules and the launcher
is a static file server from the standard library.

It takes the first free port from 8990 upward and opens a browser itself, so a window left over
from earlier cannot stop it starting. To bind one port exactly — and fail if it is taken, which
is what the editor's `launch.json` wants — name it:

```bash
python project/launcher.py --port 8990
```

Run the checks with `start.bat test`, or directly:

```bash
node tests/selftest.mjs
```

⚠️ **The checks are the gate before anything is cut.** They assert the properties the machine
depends on, not the shape of the code.

---

## Where it sits in the family

| | |
|---|---|
| **DL-TerrainSlicer** | the 3-D sibling: terrain as a **stack of solids**. This tool took its **DLF laser-pass layer scheme unchanged**, so a Trotec JobControl configuration set up for the slicer works here without being rebuilt. |
| **DL-TerrainDiversity** | the **analysis engine** of the family, and the source of this tool's interface grammar and its proportional-symbol rules. |
| **this tool** | terrain as a **drawing**: one plane, line work and marks, depth represented rather than built. |

It is built on TerrainDiversity's stack — browser ES modules, no server logic — rather than
TerrainSlicer's Python/FastAPI, for one decisive reason: **field photographs must never be
uploaded**, and the surest way to guarantee that is to have nowhere to upload them to.

---

## The architecture, in one paragraph

`compile.js` is the whole idea. Readers turn files into features; the compiler turns
**features plus a symbology** into one `Drawing` of paths and circles, each carrying the DLF
pass layer that *is* its laser operation. The DXF writer and the on-screen preview both render
that same `Drawing` and neither builds its own geometry — so the preview cannot lie about what
the machine will do. A new feature type is a new emit block in `compile.js` and nothing else
moves.

```
 geotiff.js ─┐                                    ┌─→ dxf.js ──→ .dxf
 exif.js ────┼─→ features ─→ compile.js ─→ Drawing ┤
 utm.js ─────┤                    ▲               └─→ app.js ──→ preview
 photos.js ──┘                    │
                        contours · labels · symbols
                        halftone · sheet · stroke-font
```

## The modules

| file | what it is |
|---|---|
| `dem.js` | the one raster shape everything speaks. Row 0 is north; nodata is **always** NaN |
| `geotiff.js` | one tag walk, two views — elevation as Float32, ortho as interleaved RGB |
| `decompress.js` | Deflate, TIFF LZW, PackBits and the predictor — hand-written, synchronous |
| `contours.js` | per-triangle marching (no saddle ambiguity) **chained into continuous polylines** |
| `stroke-font.js` | a single-stroke font, because an engraved number is a path, not an outline |
| `labels.js` | labels that cut their own gap in the line before the text is set into it |
| `sheet.js` | the one place ground metres become sheet millimetres |
| `utm.js` · `exif.js` · `photos.js` | photographs into the raster's own grid, with their bearings |
| `symbols.js` | proportional symbols — Marc's Hadseløya technique (2017), ported from TerrainDiversity |
| `halftone.js` | an image as marks: vector halftone, triple halftone, or raster engrave |
| `dxf.js` | R12 ASCII, no exponents, the six DLF pass layers |
| `linestyle.js` | dash patterns cut into the geometry — never a DXF LINETYPE |
| `qgis.js` · `xml.js` | `.qml`/`.sld` translated into passes and patterns, with a decision log |
| `compile.js` | the symbology → operation mapping |

## The four things worth knowing before changing anything

1. **Contours leave as continuous paths, never as segments.** An early prototype in this family
   produced ~3,700 dashes where the same drawing is 55 paths. On a machine that is 3,700 pierces,
   a stuttering head and a witness mark at every restart. The chaining pass in `contours.js` is
   the feature.

2. **A restricted image can be previewed and cannot be written.** Aerial imagery is commonly
   licensed for education and research only, and a halftone is a derivative carrying its pixels.
   `assertExportable()` guards every path out; the preview deliberately does not set `forExport`.

3. **The DLF layer names and ACI colours are not ours to change.** Renaming one silently sends
   engraving power to a cut line, on material, at the machine.

4. **`style.css` is a COPY of DL-TerrainDiversity's committed theme**, byte for byte, along with
   the DL brand fonts. Nothing here may define a second palette — if a colour is wanted, it is
   already a token in that file. The copy can drift from the sibling; re-copying is a deliberate
   act, which is the right trade for two independently released tools.

## What is built, and what is not

**Built** — the vertical slice end to end, plus the image work: raster and ortho readers,
contour tracing and chaining, labelling with gaps, the photograph path from EXIF to marks with
hand correction, vector and triple halftones, the DXF writer, the compiler, the preview, and a
218-check suite.

Rasters open **compressed or not** — Deflate, LZW, PackBits, with or without the predictor,
striped or tiled. Measured against every TIFF on this machine: 42 opened, 0 refused.

**Not built** — SVG output, leader-line label placement, the material
legibility test sheet, analysis rasters beyond slope (they belong to TerrainDiversity), and
raster-engrave PNG export from the interface (`rasterTile()` exists; the page does not yet
write the file).

## Licence

To be settled before this enters any teaching material — the family rule is an open licence
first. See `../history and back up/OLD/CONCEPT - v01.md` §6.
