# DL-TerrainMapper

**A laser-cut map compiler.** Terrain and field observations go in; a fabricable
drawing comes out — engraved contours, labelled heights, hachures, located
photograph marks, halftones, sections and thresholded material regions — where
the symbology maps to **laser operations** instead of to screen pixels.

*QGIS symbology, but the render target is a laser bed.*

Part of the Digital Landscapes tool family, beside
[DL-TerrainSlicer](https://github.com/DLandscapes/dl-terrain-slicer), which
builds the same ground as a **stack of solids**. This one draws it on **one
plane**: line work and marks, depth represented rather than built.

---

## Getting started

**What you need:** a terrain model as a **GeoTIFF** (`.tif`) — export one from
QGIS. Optionally JPEG photographs with GPS, and a `.qml`/`.sld` style. You can
try everything without your own data: there is a **demonstration site** button
that builds a landform in code.

### The quickest way — in your browser

Open the hosted copy. Nothing to install, and it works on a lab machine you
cannot install software on:

**<https://dlandscapes.github.io/dl-terrain-mapper/>**

### From a folder on your own machine

Download or clone the repository, then run:

```bash
start.bat
```

This opens the tool in your browser. It needs **Python 3** (any recent version
— only the standard library is used, there is nothing to `pip install`).

> ⚠️ **Do not open `project/index.html` by double-clicking it.** The tool is
> built from ES modules, and browsers refuse to load those over `file://`. You
> get a blank page and a console error, and nothing about it suggests the
> cause. Use `start.bat`, or the hosted link above.

---

## Your files never leave your computer

There is no upload, because **there is nowhere to upload to**. `launcher.py` is
a static file server from the Python standard library and it **refuses POST,
PUT and DELETE by design**. Every parser — GeoTIFF, EXIF, XML — is written in
JavaScript and runs in your own browser tab.

This is not a promise about a privacy policy; it is a property of the
architecture, and it is why the tool is built this way. Field photographs carry
GPS positions and often people, and they are nobody else's business.

---

## What it does

### One raster, several translations

The idea the whole tool is a test of: a value can become a mark in more than
one way, and the ways **compose on a single sheet**. Each is a per-layer block
with its own source, its own settings and its own laser pass.

| Translation | The value becomes |
|---|---|
| **Contours** | a line's **position** — continuous, labelled, index lines heavier |
| **Hachures** | strokes down the **fall line**, longer where it is steeper |
| **Modulated contours** | the **ink** along a contour, so one line carries a second quantity |
| **Circle grid** | a symbol's **size**; the sign becomes its form — a grading plan's cut and fill |
| **Hatching** | the **density** of ink along parallel scanlines |
| **Sections** | height against **distance** along a cut, engraved on the line it was taken from |
| **Regions** | one **threshold** → an outline cut from a second material |
| **Halftone** | an image's pixels as **marks** |

Each translation reads either the layer's own values, its **slope**, or its
**difference to another layer** — so a 2006 raster and a 2024 raster give you a
disturbance drawing, and the circle grid turns that into cut and fill.

### And the rest

- **Reads real files.** GeoTIFF striped or tiled, uint/int/float, Deflate, LZW
  and PackBits, predictors 2 and 3, GDAL nodata, GeoKeys. JPEG EXIF with GPS
  and bearings. QGIS `.qml` and `.sld`, translated with a decision log.
- **Multiple rasters as layers** — a DTM under a DSM, or the same ground in two
  years. Drop or pick several at once; they load in name order.
- **Two materials** — a threshold becomes either a window cut through the base
  sheet, or pieces cut from a second sheet and glued on. One DXF per material,
  with asymmetric registration holes so the boards cannot be pinned 180° wrong.
- **A material test sheet** the tool builds from its own parts, so you can
  measure what your material and machine will actually hold.
- **Exports** DXF (R12) and SVG, one file per material sheet, plus a plain-text
  cutting report naming everything — including how many separate marks a dashed
  or hachured layer became, *before* you send it to the machine.

---

## The laser passes

Layer names and colours are carried unchanged from DL-TerrainSlicer, so an
existing machine configuration works as it stands. **Cut passes run last.**

| Layer | ACI | Carries |
|---|---|---|
| `DLF-00_engrave` | 7 black | halftone dots, engraved fields |
| `DLF-01_score_light` | 5 blue | labels, numbers, furniture, hachures |
| `DLF-02_score_medium` | 3 green | intermediate contours, bearings |
| `DLF-03_score_strong` | 4 cyan | index contours, section profiles |
| `DLF-04_cut_inner` | 6 magenta | photo marks, region rings, registration holes |
| `DLF-05_cut_outer` | 1 red | the sheet outline — run last |
| `DLF-99_sheet` | 8 grey | ⚠️ boundary only — assign it to **no** pass |

⚠️ **Renaming a layer sends engraving power to a cut line, on material, at the
machine.** Do not.

⚠️ **No power and speed settings ship with this tool**, because they belong to
your machine and your material, not to a drawing. Cut the material test sheet
first and write your own down.

---

## For teaching

The tool is deliberately usable in a two-hour session: the demonstration site
gives every feature something honest to draw without anyone needing data, and
the readout explains its own refusals rather than failing silently.

Two things worth saying out loud to a class:

1. **The preview cannot lie.** The preview, the SVG and the DXF are rendered
   from the same compiled object; none builds its own geometry. What is on the
   screen is the literal content of the file, coloured by pass.
2. **Every dash is a pierce.** A dashed or hachured layer is many separate head
   moves, not one line, and the tool reports the count before you export
   precisely so that discovery does not happen at the machine.

---

## Running the checks

```bash
start.bat test
```

357 checks over the engine, the readers and the writers. Each one asserts
something that, if it broke, would be discovered on material rather than on
screen. They depend on nothing outside this repository.

---

## Licence and credits

**GNU General Public License v3.0 or later** — see [`LICENSE`](LICENSE).

Credits, prior work and the fonts' own licences are in
[`NOTICE.md`](NOTICE.md). If you cite the tool, [`CITATION.cff`](CITATION.cff)
has the details.

Built by **Digital Landscapes** — <https://digital-landscapes.com/>
