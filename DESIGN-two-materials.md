# DL-TerrainMapper — two materials

**Design proposal, 2026-08-23**, from Marc's question: *"imagine you compose the model of two
materials — one base material and one that shows the fill or cut, like an nDSM."*

> **STATUS, later the same day: §8 IS BUILT.** Marc confirmed the model — *"the second
> material's outline should come from one threshold… these values could be the disturbance
> values"* — and the vertical slice landed: `static/regions.js` (closed rings always, winding =
> holes, per-patch statistics), a regions emit block in the compiler with window and overlay
> constructions, the sheet axis with one DXF/SVG per material, asymmetric registration holes,
> and a "Second material" section in the properties window with the difference-of-two-layers
> source. Run against the real `orndalen_DIFF_2006_2024.tif`: 25 disturbed patches above 2 m,
> 210,927 m², mean |dz| 5.94 m — the demo files are in `output/`. §5d (kerf-compensated inlay)
> remains deliberately unbuilt — but the blocker is gone: the coupon was read on
> **2026-08-28** and the kerf on 2 mm MDF / Trotec SP500 is **0.18 mm**. See §5d.

---

## 1 · The idea worth having

Most two-material models use the second material as **colour**: the same flat sheet, in a
different tone, to say "this bit is different". That is a legend, and a legend is something you
have to be told how to read.

There is a better move available here, and it is specific to earthworks:

> ⚠️ **Let the material do what the earth did.**
> Where ground was **added**, add material. Where ground was **removed**, remove it.

A fill region becomes a piece sitting *proud* of the base. A cut region becomes a *void* through
it, showing whatever is behind. Nobody has to be told which is which — the model has already
done the thing it is describing, and you can read it with a fingertip in the dark.

That is the proposal. Everything below is how to build it and what it costs.

## 2 · The two readings of the question, and they want different constructions

Marc's phrasing — *"the fill or cut, like an nDSM"* — groups two things that are physically
opposite.

| | what it is | sign | the honest construction |
|---|---|---|---|
| **nDSM / CHM** | canopy and buildings, measured **above** the ground | always **+** | material **on top** |
| **Cut and fill** | earth **moved**, between two epochs or existing vs proposed | **±** | added **on top**, removed as a **void** |

An nDSM is only ever positive, so it only ever needs one extra layer above the base. Cut and
fill is signed, and the sign is the whole content — which is why it deserves the two-sided
treatment and an nDSM does not.

## 3 · Three constructions

### A · Overlay — the second material sits on the base

Cut the region from sheet 2, glue it onto sheet 1. It stands proud by the material thickness.

- ⚠️ **This is the physically correct metaphor for an nDSM**, and it is the cheap one: a canopy
  *is* above the ground, and a 2 mm board over a 2 mm base says so at roughly 1:1000 vertical
  exaggeration without anybody choosing an exaggeration.
- **No kerf problem.** The piece is glued down, not fitted into anything, so being 0.2 mm small
  costs nothing.
- Height bands can use **thickness**: 2 mm board for one band, two laminations for the next.
  ⚠️ Past about three bands this stops being this tool and becomes DL-TerrainSlicer — see §7.

### B · Inlay — the second material sits *in* the base

Cut a hole in sheet 1 and drop a matching piece of sheet 2 into it, flush.

- The most beautiful result and the most demanding. Flush marquetry reads as one surface with
  two materials, which is exactly right for **cut and fill on a plan**: it is one ground, in two
  states.
- ⚠️ **Kerf is the entire difficulty**, and it is not optional — see §5.

### C · Window — the base shows through

Cut the region out of sheet 1 entirely and let sheet 2 behind show through the hole.

- The strongest reading of a **cut**: material genuinely removed, a void you can put a finger in.
- Cheap: no fitting, no kerf compensation, no glue at the boundary — sheet 2 is a full backing
  panel, and only sheet 1 carries any region geometry.

### The recommendation

**Cut = window (C). Fill = overlay (A). Both against one backing sheet.**

Three parts, no fitted joints, no kerf compensation anywhere, and the model is legible without a
key: holes where earth went, raised pieces where earth arrived. Inlay (B) is the version to
build *after* the material test tells us what the kerf actually is.

## 4 · What the tool already has — and it is most of it

Measured, not assumed. On a synthetic nDSM with two separate woods, one containing a clearing:

```
rings 3: 2 outer, 1 hole, 0 open
  outer  area 918 m2
  outer  area 384 m2
  HOLE   area 104 m2
net material area: 1198 m2
```

- ⚠️ **A region boundary is just a contour at one level.** "Everywhere the nDSM exceeds 2 m" is
  `traceContours(nDSM, …, {levels:[2]})`. The tracer already returns it **closed**, **chained
  into continuous paths**, and **reaching the raster's true edge**. No new geometry.
- ⚠️ **Winding already separates an outer boundary from a hole.** Orientation was made part of
  the tracer's output on purpose — high ground on the left — so a clearing inside a wood comes
  back wound the opposite way and needs no point-in-polygon test to find. This is the part that
  would normally be a day of fiddly work, and it is free.
- **Area falls out of the same rings**, so the drawing can state how much ground was cut and how
  much filled without a second calculation.
- **Several rasters, each on its own pass**, already exists. A material is one more axis on the
  same list.

## 5 · What is genuinely new — and one of it is hard

**a · A material axis on the layer list.** Today a layer has a pass. It would gain a **sheet**:
which physical piece of material this geometry is cut from. Export then writes one DXF per
sheet, not one per drawing. Small, mechanical.

**b · Regions rather than lines.** A new emit block in `compile.js`: threshold a raster, take the
rings, put outer boundaries and holes on the cut pass. Everything it needs exists.

**c · Registration.** ⚠️ **Two sheets that do not align are two sheets.** Needs corner marks
engraved on both, or two small drill/pin holes cut through both — the tool already places
photograph marks from coordinates, so placing two registration marks is the same operation.
Non-negotiable and easy to forget until the glue is out.

**d · Kerf compensation — the hard one, and only for inlay.** A laser removes material. Cut the
same outline in both sheets and the hole is *bigger* than the piece by one full kerf, so the
inlay rattles. The fix is to cut the inlay from an outline offset **outward by one kerf**, which
means true polygon offsetting: self-intersections where the offset exceeds a feature's own size,
rings that collapse, holes that grow while their parents shrink. ⚠️ **DL-TerrainSlicer already
carries scar tissue here** — its contour-offset method and a GEOS simplify bug on a real Ørndalen
raster. This is the reason to ship **window + overlay first**: they need no offsetting at all,
and they answer most of the question.

## 6 · What the sheets would contain

For a cut-and-fill plate, three files:

| sheet | material | carries |
|---|---|---|
| **1 · surface** | the base board | contours, labels, photograph marks, **cut-region voids on `DLF-04_cut_inner`**, outline on `05` |
| **2 · fill** | the contrasting board | fill regions as closed cuts, each engraved with its depth |
| **3 · backing** | anything, ideally dark | a plain panel the size of the plate, with the registration marks |

⚠️ **The sign must be engraved, not only implied.** A raised piece says "something happened here"
but not how much. Each region carries its mean depth as a number, in the same single-stroke font
the contour labels use — otherwise the model is a shape without a quantity, and a shape without
a quantity is a picture.

## 7 · Where this stops being this tool

⚠️ **One extra material, or two. Not a stack.**

The moment the answer is "a layer per height band", this has become DL-TerrainSlicer — that tool
exists precisely to turn a surface into a stack of solids, it is released, and it does it well.
The line is worth stating plainly because the slide is so easy: two materials is a *drawing that
happens to be in two sheets*; five materials is a *model assembled from layers*, and it should be
built with the sibling instead.

The test: if the second material's outline comes from **one threshold**, it belongs here. If it
comes from **a series of levels**, it belongs to the slicer.

## 8 · What I would build first

One vertical slice, in this order, and it is small because §4 did most of the work already:

1. A **sheet** field on each layer, and export writing one DXF and SVG per sheet.
2. A **region** emit block — threshold, rings, outer and holes to the cut pass, mean depth
   engraved in each.
3. **Two registration marks**, cut through every sheet at the same coordinates.
4. The demonstration: an nDSM plate as **base + canopy overlay**, and a difference plate as
   **base with voids + fill overlay + backing**.

✅ **The kerf is measured: 0.18 mm** (coupon block E, callipers on the dropped square, 2 mm MDF
on a Trotec SP500, 2026-08-28 — recorded in `project/static/material.js` as `MATERIAL.kerfMM`).
So the inlay offset is **0.09 mm outward on each side of the piece**, or equivalently 0.18 mm on
the diameter. The blocker on §5d was never the offsetting algorithm; it was not knowing the
number, and this is precisely the kind of guess that is only discovered to be wrong after both
sheets are cut.

⚠️ **The number is per material and per machine, and 0.18 mm is a CUT-pass reading.** It is not
the width of an engraved line — different pass, different power and speed. Do not reuse it as a
mark width; `SOLID_MM` in `patterns.js` explains why at length.

## 9 · The question I cannot answer from here

**Which two materials?** It changes the recommendation. Two boards of the same thickness suit
inlay; a thin dark card behind a thicker pale board suits the window; anything translucent — 
acrylic, tracing stock — makes the void a *lit* void, which for a cut region is a strong effect
and needs no backing at all.

Worth deciding before any of §8 is built, because the construction follows the material rather
than the other way round.
