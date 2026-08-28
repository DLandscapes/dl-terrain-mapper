// @ts-check
// THE MATERIAL, MEASURED — and the difference between a reading and a guess.
//
// Every floor in this tool used to be a justified guess. On 2026-08-28 the SP500
// coupon was finally cut and read, and these are the numbers off it. They are
// kept in ONE place, with what each one is and what it is NOT, because a number
// that has been measured and a number that was reasoned about have to be
// distinguishable by anyone reading the code — the whole point of cutting a
// coupon is lost if its results dissolve into the same anonymous constants they
// replaced.
//
// ⚠️ THESE ARE FOR ONE MATERIAL ON ONE MACHINE. 2 mm MDF on a Trotec SP500.
// Another board, another thickness or another machine invalidates all of them,
// which is why the record names all three. `output/SP500-material-test.dxf`
// cuts the coupon again for the next material.
//
// ⚠️ AND POWER AND SPEED ARE STILL NOT RECORDED ANYWHERE IN THIS FAMILY. The
// coupon sheet has a table for them at the top and it came back blank. Until it
// is filled in, `ENGRAVE_GREY` in `raster.js` — which maps each pass to a burn
// value — stays a reasoned guess, because a grey ladder is a statement about
// power and nothing here knows what the powers are.

/**
 * What the coupon said.
 *
 * @type {{name:string, machine:string, read:string,
 *         legibleMM:number, minMarkMM:number, kerfMM:number,
 *         failedOnCurve:string[]}}
 */
export const MATERIAL = {
  name: "2 mm MDF",
  machine: "Trotec SP500",
  read: "2026-08-28",

  /**
   * BLOCK A — the smallest cap height at which "104.25" is still unambiguous.
   *
   * ⚠️ THE TOOL'S GUESS WAS RIGHT, AND THAT IS WORTH RECORDING RATHER THAN
   * QUIETLY KEEPING. `labelSize` already defaulted to 2.2 mm; the coupon says
   * 2.2 mm. What changes is the SLIDER, which went down to 1.2 — a reader could
   * set a contour label to a size this material cannot hold, and nothing said
   * so. The floor is now the measurement.
   */
  legibleMM: 2.2,

  /**
   * BLOCK D — the smallest circle that comes off as a RING rather than as a
   * filled hole. Below it the burn closes the middle and a halftone punches
   * through the board instead of marking it.
   *
   * ⚠️ IT IS A FLOOR ON EVERY SMALL MARK, NOT ONLY ON HALFTONE DOTS. A dash
   * shorter than this, a hatch runt, the dot in a dash-dot pattern: all of them
   * are the same event — a burn that does not travel far enough to read as a
   * mark. They were floored at 0.15 mm and 0.3 mm by reasoning; they are floored
   * at 0.4 mm by measurement.
   */
  minMarkMM: 0.4,

  /**
   * BLOCK E — kerf, callipers on the dropped square.
   *
   * ⚠️ THIS IS THE CUT PASS, AND IT IS NOT THE ENGRAVE MARK WIDTH. They are
   * different passes at different power and speed, and they measure different
   * things: kerf is material REMOVED by a cut, `BURN_MM` in `patterns.js` is how
   * wide an engraved line READS. Do not substitute one for the other — see the
   * note there, which explains why block D and not this number is what settles
   * the merge distance.
   *
   * What it unlocks is kerf-compensated inlay: a part cut 0.18 mm oversize drops
   * into its own hole instead of rattling in it. `DESIGN-two-materials.md` §5d.
   */
  kerfMM: 0.18,

  /**
   * BLOCK B — the line styles that stopped reading on the 12 mm radius.
   *
   * ⚠️ THE CURVE IS THE TEST, NOT THE STRAIGHT. A contour is never straight, so
   * a pattern that survives a straight run and dies on a bend is a pattern this
   * tool cannot use for the thing it mostly draws.
   */
  failedOnCurve: ["dotted"],
};

/**
 * ⚠️ WHAT THE COUPON DID NOT MEASURE, so nobody has to work it out twice:
 *
 * - **Power and speed for the six passes.** The table on the sheet is blank.
 * - **The merge distance directly.** There is no block that lays engraved lines
 *   at a ladder of spacings and asks which one stops reading as stripes. Block D
 *   bounds it instead (see `patterns.js`), which is weaker than measuring it.
 *   ⚠️ **Add that block before the next material is cut.**
 */
export const NOT_MEASURED = ["power", "speed", "merge distance"];
