/**
 * facades.js — procedural facade textures for Austin 3D Explorer
 *
 * MapLibre v5 supports `fill-extrusion-pattern`. NOTE, because the comment
 * here used to say the opposite and it cost a whole investigation: the pattern
 * does NOT tile in world space. It is scaled by the TILE grid, so a 64 px
 * repeat covers ~14.8 m at tile zoom 18 and doubles with every zoom out —
 * ~118 m by zoom 15. See the measurement note above GRIDS.
 *
 * The catch: a pattern REPLACES `fill-extrusion-color`, so per-building colour
 * would be lost. Fix: quantise the 900-odd baked wall colours down to a small
 * adaptive palette (~14 buckets), then generate one pattern image per
 * (facade family × colour bucket). Buildings keep their identity, and the
 * flattening is an art-direction win — 14 deliberate tones beat 900 muddy
 * near-duplicates.
 *
 * Patterns are regenerated (in place, via map.updateImage) when the
 * time-of-day changes, so glass goes cool-dark by day, amber-reflective at
 * golden hour, and a scatter of windows lights up warm at night.
 *
 * THE TWO INVARIANTS THIS FILE MUST NOT BREAK, both for the same reason — ONE
 * PITCHED FRAME READS EVERY MIP TIER AT ONCE, because past 60 degrees of pitch
 * MapLibre picks a tile zoom per tile and the tier is chosen at the tile's zoom:
 *
 *   1. Every mip tier holds the SAME HOUR. A tier left behind is a hard seam
 *      across the city with night windows on one side and daylight on the
 *      other. See the ATLAS block.
 *   2. Every mip tier is the SAME PATTERN AT THE SAME WORLD SCALE, differing
 *      only in RESOLUTION. A tier with a different `displaySize` puts a
 *      different number of windows on the same metre of wall, so a wall whose
 *      tile changes zoom visibly switches rhythm — the reported "rapidly
 *      alternates between the less and more dense window pattern on movement".
 *      See the TIERS block.
 *
 * Public (window) API:
 *   quantiseFacades(features)  — assign wp/wf per feature, build the palette
 *   initFacades(map)           — register every needed pattern image
 *   updateFacades(map, p)      — repaint the images for time-of-day p
 *   FACADE_PATTERN_EXPR        — paint value for fill-extrusion-pattern
 */
(function () {
  'use strict';

  const TILE = 64;              // DRAWING units per pattern repeat
  const TARGET_BUCKETS = 14;    // colour buckets kept after merging

  // ── The pattern is SCREEN-locked, and that is the whole of two defects ──
  //
  // MEASURED, and it is definitional rather than empirical: one repeat covers
  // `image.width / image.pixelRatio` CSS PIXELS of screen, at every zoom. With
  // a 64 px image at pixelRatio 1 that is 64 CSS px, always. Convert it to
  // metres at this latitude (res = 67551 / 2^zoom m per CSS px) and the world
  // size of one repeat is:
  //
  //     zoom      14      15      16      17      18
  //     m/repeat  264     132      66      33      16
  //
  // A downtown tower is 30-60 m wide. So at the zooms this app actually flies —
  // and the tour's own downtown pose is z15.2 — the repeat is TWO TO FOUR TIMES
  // WIDER THAN THE BUILDING, and each tower shows an arbitrary FRAGMENT of one
  // repeat: whichever slice of the 64 px tile its footprint happens to land on.
  // A tower that lands on the tile's pier band gets no windows at all; one that
  // lands on a single column of openings gets exactly one window column. That is
  // the reported "sometimes like one window column renders per downtown
  // building", and it is not intermittent — it is a phase, fixed by where the
  // building sits, and it changes as you fly.
  //
  // The same fact is half of "windows are super blurred": at z15-16 one texel is
  // 1-2 m of wall, so a window is one or two texels wide before anything is
  // drawn.
  //
  // THE FIX IS A MIP CHAIN, hand-rolled, because MapLibre samples the pattern
  // atlas LINEAR with no mipmaps (atlases cannot be mipmapped without bleeding
  // between images). Three tiers of the SAME drawing, selected by a `step` on
  // zoom.
  //
  // ── WHAT A TIER IS ALLOWED TO CHANGE, AND IT IS ONLY ONE THING ──────
  //
  // A TIER MAY CHANGE RESOLUTION. A TIER MAY NOT CHANGE SCALE. Every tier below
  // covers exactly `TIER_CSS` css pixels of screen per repeat, so every tier
  // puts the same windows in the same places on the same wall; the coarser ones
  // simply hold fewer texels to say it with. Break that and the app flickers,
  // for a reason that is worth writing out in full because it survived one
  // "fixed" PR already:
  //
  //   1. The pattern's WORLD SCALE is set by the CAMERA. MapLibre's pattern
  //      uniforms go through `pixelsToTileUnits(tile, 1, transform.tileZoom)`,
  //      and the tile's own overscaledZ cancels out of that expression exactly.
  //      One repeat is `displaySize * 67551 / 2^floor(cameraZoom)` metres of
  //      wall, the SAME number for every tile on screen.
  //   2. The pattern's IMAGE is chosen by the TILE. `['step',['zoom'],...]` is
  //      evaluated when a tile's buckets are built, at that TILE's zoom.
  //   3. Past ~60 degrees of pitch MapLibre picks a tile zoom PER TILE by
  //      distance (`allowVariableZoom`), and this app spawns at pitch 74.
  //      Measured at the spawn pose: `city-buildings` renders tiles at z13,
  //      14, 15 and 16 in ONE frame, and the counts change frame to frame as
  //      the camera moves.
  //
  // Put those together and a tier whose `displaySize` differs from its
  // neighbour's paints a DIFFERENT NUMBER OF WINDOWS PER METRE on a tile that
  // happens to have landed one zoom away. The tiers used to be 16 / 32 / 64 css
  // px, so at the spawn pose the near-field walls carried a 66 m repeat and the
  // far-field walls a 16.5 m repeat — a 4x density difference across one frame,
  // and a 2x or 4x jump on any wall whose tile changed zoom. That is exactly
  // the report: *"it rapidly alternates between the less and more dense window
  // pattern on movement ... they all happen from a distance"*.
  // `shots/h2-before/u24-far-tierx.png` against `-tiernear.png` is the same
  // camera with the tier forced, and the two frames are not the same city.
  //
  // So the tiers are a REAL mip chain now: one scale, three resolutions.
  // `div` is how much the shared drawing is box-downsampled for that tier, and
  // a box the width of the decimation IS the prefilter that minification needs
  // — the same rule the old `soften` column was reaching for, done by the
  // resampling itself rather than by a blur on top of a full-size image. It is
  // also what HANDOFF §46 named as the next win in this file: the far tier was
  // carrying 16x more texels than it could ever show.
  //
  //     tier   texels(dpr1)   displaySize   m of wall per repeat at camera z
  //                                          z14   z15   z16   z17   z18
  //     far        32            32 css      132    66    33    16     8
  //     near       64            32 css      132    66    33    16     8
  //
  // ── WHY THERE ARE TWO LEVELS AND NOT THREE. `pixelRatio` MUST BE AN
  // INTEGER ≥ 1, and this cost a whole rebuild of the change to find out.
  // MapLibre carries it into the shader as a VERTEX ATTRIBUTE declared
  // `{ name: 'a_pixel_ratio_from', components: 1, type: 'Uint16' }`, and the
  // pattern vertex shader divides by it to recover the display size. A tier
  // registered at pixelRatio 0.5 therefore arrives in the shader as ZERO, the
  // division blows up, and the whole far field renders as a transparent ghost
  // of itself — `shots/h2-before/u24-far-tierx-pr05.png` is what that looks
  // like, and it is nothing like a "missing image", so it would not have been
  // recognised from the symptom. displaySize is texels / pixelRatio, so with a
  // 64-texel drawing and a 32 css-px repeat the only levels available on a 1x
  // screen are pixelRatio 2 (64 texels) and 1 (32 texels). Two.
  //
  // TASTE KNOB. `TIER_CSS` is the world scale of the windows — bigger means
  // fewer, larger windows on every building at every distance. 32 is chosen so
  // the repeat is 33 m of wall at the zoom this app spawns at: that is 4.1 m
  // floor-to-floor through `mh`'s 8 rows, which is a real storey, and it is the
  // scale the OLD mid tier already produced there. 16 would put a storey at
  // 2.1 m and 64 at 8.3 m. `minZoom` is where the sharp level takes over; the
  // stop is an INTEGER on purpose, because MapLibre evaluates a *-pattern
  // property at floor(zoom) and floor(zoom)+1 and cross-fades between them, so
  // a fractional stop would not land where it was written.
  const TIER_CSS = 32;
  const TIERS = [
    // `soften` is an EXTRA box-blur radius in 64-unit drawing space, on top of
    // the decimation. Only the near tier needs one: it keeps every texel of the
    // drawing and is then shown over TIER_CSS css px, i.e. minified 2:1 on a
    // 1x screen (and 1:1 on a 2x one, which is why the texels are kept). 0.75
    // is the value the old MID tier carried for exactly that 2:1 case, so it is
    // calibrated rather than guessed. The far tier is a 2x box DECIMATION of
    // the same drawing — a box the width of the decimation is precisely the
    // prefilter minification wants — and is then drawn at 1:1 or magnified, so
    // it cannot alias from minification at all and gets nothing extra.
    { id: 'x', div: 2, minZoom: 0,  soften: 0.0 },   // far — half res
    { id: '',  div: 1, minZoom: 17, soften: 0.75 },  // near — full res
  ];
  window.FACADE_TIERS = TIERS;
  window.FACADE_TIER_CSS = TIER_CSS;

  // Texels per repeat in the NEAR tier. A screen shows `css * devicePixelRatio`
  // device pixels per repeat, so drawing more texels than that is minification
  // and drawing fewer is magnification — a 1x tile composited at 2x is soft by
  // construction, which is the third candidate on the list and the only one that
  // costs anything to fix. Quantised, and capped at 2: nothing on a phone is
  // reading a window at 3x.
  const SCALE = Math.max(1, Math.min(2, Math.round(window.devicePixelRatio || 1)));
  const RES = TILE * SCALE;     // real canvas texels per repeat, NEAR tier
  /** Texels per repeat in one tier — the shared drawing, decimated by `div`. */
  const tierRes = t => RES / t.div;
  // The pixelRatio each tier is registered with, and the whole invariant is in
  // this one line: `displaySize` is `texels / pixelRatio`, so putting `TIER_CSS`
  // in the denominator makes displaySize TIER_CSS for every tier by
  // construction. A tier cannot drift in scale without someone editing this.
  // It must come out a positive INTEGER — see the TIERS block; the assert below
  // is there because the failure is a silent, plausible-looking ghost city.
  const tierPixelRatio = t => tierRes(t) / TIER_CSS;
  for (const t of TIERS) {
    const pr = tierPixelRatio(t);
    if (!(pr >= 1) || pr !== Math.round(pr)) {
      console.error('[facades] tier "%s" needs pixelRatio %s — MapLibre stores '
        + 'it in a Uint16 attribute, so it must be a whole number >= 1. The far '
        + 'field will render transparent. Fix TIER_CSS or the tier\'s div.',
        t.id || 'near', pr);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  THE GRID IS A PITCH IN METRES, NOT A COUNT OF ROWS
  // ══════════════════════════════════════════════════════════════════
  //
  // WHAT WAS WRONG, and it was wrong for every building in the city, not just
  // the sixteen measured ones. One repeat covers
  // `TIER_CSS * 67551 / 2^tileZoom` METRES of wall — the block at the top of
  // this file measures it — so a tile holding a FIXED number of rows draws a
  // storey pitch that HALVES every time you zoom in one level:
  //
  //     camera zoom            16     17     18     19     20     21
  //     metres per repeat   32.98  16.49   8.25   4.12   2.06   1.03
  //     `mh`'s 8 rows are    4.12   2.06   1.03   0.52   0.26   0.13 m apart
  //
  // A 13 cm storey. MEASURED on the running app rather than derived: standing
  // 30 m off Battle Hall's east wall at eye height (1.7 m, pitch 88 — the pose
  // this app's own walk mode puts you in) the camera is at z19.93, the repeat
  // is 4.12 m, and Battle Hall — a TWO-storey building — renders about fifteen
  // rows of windows. At pitch 85, the other end of the band walking height can
  // express, it is z21.3 and about thirty. The per-building measurement landed
  // in the previous pass was therefore correct at EXACTLY ONE ZOOM, 16, the one
  // it was converted at, and the app does not spend much time there: every
  // "stand and look at a building" pose measured came out z17.1-17.8.
  //
  // THE FIX. A family now carries `pitchM` (floor-to-floor, metres) and `bayM`
  // (bay centres, metres). The ROW COUNT is derived from those against the
  // repeat the camera is currently drawing at:
  //
  //     rows = round(repeatM(zoom) / pitchM)      cols = round(repeatM / bayM)
  //
  // so the pitch on the WALL stays put and the count in the TILE is what moves.
  // The tile is redrawn (map.updateImage, same id, same size, same pixelRatio)
  // when the camera crosses an integer zoom. ZERO new images, zero change to
  // the pattern expression, and nothing outside this file needs to know.
  //
  // WHY THIS REMOVES A POP RATHER THAN ADDING ONE. The repeat already jumps by
  // 2x at every integer zoom crossing — it is a `2^floor(zoom)` — so today the
  // window rhythm on a wall visibly doubles or halves as you cross one. With
  // the count moving in step, the metre pitch is CONTINUOUS across the crossing
  // and only the texel resolution changes.
  //
  // WHY IT NEVER GOES BELOW REF_ZOOM. `zAnchor` is clamped at REF_ZOOM, so this
  // can only ever make a wall COARSER than it is today, never denser. Three
  // reasons, and the first is the one that matters: a denser grid is what
  // docs/shimmer-mechanism.md root-caused the window CRAWL to, so a change that
  // could add rows at cruise would be trading a defect nobody reported for one
  // Simeon has reported twice. Second, at z15 the honest answer for `mh` is 16
  // rows and the tile's aliasing ceiling is 10, so it could not be drawn
  // anyway. Third, it makes the z<=16 render bit-identical to before this
  // change, which is what makes the whole thing reviewable.
  //
  // REF_ZOOM is 16 because that is what TIER_CSS was calibrated against — "the
  // repeat is 33 m of wall at the zoom this app spawns at" — and every authored
  // number in GRIDS below is a count AT THAT ZOOM. TASTE KNOB: raising it makes
  // every window in the city smaller and more numerous at cruise.
  const REF_ZOOM = 16;
  const repeatMAt = z => TIER_CSS * 67551 / Math.pow(2, z);
  const REPEAT_M = repeatMAt(REF_ZOOM);   // 32.98 m
  // `?facadeanchor=0` freezes the anchor at REF_ZOOM, i.e. puts the pre-anchor
  // behaviour back with no other difference. It exists so the A/B is a URL and
  // not a checkout: scripts/verify/shimmer.mjs (via SHIM_Q) and the perf scripts
  // both need to measure this change against its own absence on the same
  // machine in the same minute, and this file's own history says an A/B run
  // across two checkouts measures the machine. Same precedent as
  // `?bakedfacades=0` and `?storeys=0` already in here.
  const ANCHOR_ON = !/[?&]facadeanchor=0(?:&|$)/.test(location.search);
  window.FACADE_ANCHOR_ON = ANCHOR_ON;

  // The zoom the tiles currently HOLD. Never below REF_ZOOM (see above).
  let _zAnchor = REF_ZOOM;
  // Set by facadeSetZoomAnchor. A verification script that forces the anchor
  // must not have the live camera fight it back: index.html runs an intro flight
  // and an idle cinematic, both of which fire `zoom`, and the first cut of the
  // sweep in scripts/verify/facadegrid.mjs silently measured the REF tile at
  // four of six zooms because the drift reverted the anchor inside the settle.
  // It read as "the anchor does not work at z20" — a plausible, wrong, and
  // entirely self-inflicted conclusion.
  let _zPinned = false;

  // THE ALIASING FLOOR, and it is a hard limit rather than a preference. The
  // material block below establishes that a feature under ~2 texels does not
  // survive camera motion, and docs/shimmer-mechanism.md root-caused the window
  // rows CRAWLING as continuous minification aliasing — denser grids make it
  // worse. So a wall cannot ask for more rows than the tile can carry: with
  // MIN_SPANDREL 3 px of wall between rows and a 3 px minimum opening,
  // 64/(3+3) is ten. Same arithmetic across, with MIN_PIER 5: 64/(5+2) is nine.
  // A building that wants more is CLAMPED and says so — Burdine asks for 21
  // rows because its extruded height is a third of the real building's.
  //
  // `minCols` is ONE, not two, and that is a consequence of metre-anchoring
  // rather than a loosening: at z19 a repeat is 4.1 m of wall and a real
  // 6.6 m bay pitch fits in it once, not twice. Forcing two would put a column
  // every 2 m on a building whose bays are 6.6 m apart — the same fabrication
  // this whole block exists to stop, in the other axis. It cannot change any
  // family assignment, because at REF_ZOOM no measured building comes out under
  // two columns; scripts/verify/facade_parity.py is what convicts that if it
  // ever stops being true.
  const GRID_CLAMP = { maxRows: 10, maxCols: 9, minRows: 1, minCols: 1, minOpen: 2 };
  // Largest share of its own cell one opening may cover. See gridFromSpec.
  const OPEN_MAX_FRAC = 0.72;

  // Facade families — window geometry, chosen by height/class.
  //   lo  low-rise houses + sheds: sparse, large openings
  //   md  walk-ups, campus halls: punched-window grid
  //   tw  towers: dense curtain-wall grid
  //   dk  parking decks: open horizontal slots, no glass
  //   st  stadiums + arenas: masonry piers, NOT windows (see drawStadium)
  // ── The scale bug these numbers exist to fix ────────────────────────
  //
  // The module header above used to claim the pattern tiles in WORLD space and
  // "keeps a constant physical size as you fly". MEASURED, that is false: a
  // 64 px repeat covers ~14.8 m at tile zoom 18, ~30 m at 17, ~59 m at 16 and
  // ~118 m at 15. It HALVES at every integer zoom, because MapLibre scales
  // *-pattern by the tile grid, not by the world. Confirmed by rendering one
  // tower at z17.6 / z16.6 / z15.6 and counting window rows down its face: the
  // count halves each step. If the pattern were world-locked it would not move.
  //
  // The old grids were sized for a 20 m tile, which only exists near zoom 18.
  // At the zooms this app actually flies — 15 to 17 — the same tile spans
  // 30-118 m, so one "window" was drawn 5 to 18 m across. That is the whole of
  // the reported "huge blocky uniform windows": a scale bug, not a taste one.
  //
  // These are sized for the middle of the real flying range (tile zoom 16-17,
  // 30-59 m per tile), which puts floor-to-floor in the 3-6 m band where it
  // belongs. Very close in they read as fine texture, which is the correct
  // failure direction — a real window at cruise IS sub-pixel.
  //
  // GLAZING is the second correction. Measured references: UT campus historic
  // 15-18%, mid-century academic ~20-26%, West Campus student mid-rise 20-28%,
  // curtain-wall towers 55-70%. The old `md` was 39% and `tw` 43% — the
  // midpoint of everything, which is why one texture looked wrong on a
  // limestone hall AND on a glass tower. `tg` now goes UP, the rest come DOWN.
  // A WALL IS MOSTLY WALL. That is the rule the first cut of these numbers broke
  // and it is worth stating as a rule, because the failure does not look like
  // "too much glass" — it looks like scaffolding. Packing the openings closer
  // together left 1.3 to 3 px of wall between them, and at any real viewing
  // distance those hairlines fuse: the facade stops reading as punched windows
  // and starts reading as ribbed metal, or a parking deck with no floors.
  //
  // So the constraint is on the GAP, not just the ratio: at least MIN_PIER px of
  // wall across and MIN_SPANDREL px down, between every pair of openings.
  //
  // `want` is the intended glazing fraction, and it is CHECKED against the
  // geometry at load (see the audit below) rather than trusted. The previous
  // values carried hand-written comments claiming half the glazing the numbers
  // actually produced — 17.1% written next to a grid that computes to 34.2% —
  // and that wrong number was reported as a fix. Arithmetic in a comment is a
  // claim; arithmetic in code is a fact.
  const MIN_PIER = 5, MIN_SPANDREL = 3;
  // Minimum day-time luma separation between a pane and its own wall. See the
  // glass block in drawTile.
  const GLASS_MIN_CONTRAST = 26;
  const GRIDS = {
    lo: { rows: 2, cols: 3, w: 8, h: 7, want: 0.08 },  // houses, sheds
    mr: { rows: 6, cols: 5, w: 6, h: 4, want: 0.18 },  // 2-3 storey walk-ups, shops
    mh: { rows: 8, cols: 5, w: 5, h: 4, want: 0.20 },  // 4-7 storey campus halls
    tr: { rows: 9, cols: 5, w: 5, h: 4, want: 0.22 },  // residential towers
    // `curtain` exempts a family from the pier/spandrel minimum: real curtain
    // wall IS tight glass on thin mullions, so the gap rule that stops punched
    // facades reading as scaffolding is simply the wrong rule here.
    tg: { rows: 10, cols: 7, w: 6, h: 5, want: 0.51, curtain: true },
    dk: null, // drawn as bands
    st: null, // drawn as piers + spandrel/slot tiers (drawStadium)
  };

  // ── GRIDS, read as metres ──────────────────────────────────────────
  //
  // The table above stays the authored one, unchanged and unmoved: it is what
  // scripts/verify/campusmeter.mjs parses out of this file as its held-out
  // oracle, what scripts/bake_westcampus.py reads to decide which families have
  // a window grid, and what bake_facades.py transcribes. It is also the taste
  // knob — a count at REF_ZOOM is a far easier thing to have an opinion about
  // than a pitch in metres.
  //
  // So the metre form is DERIVED from it rather than written beside it. The
  // tile is square and covers repeatM x repeatM of wall, so metres-per-pixel is
  // the same on both axes and an aspect in tile pixels IS an aspect in metres.
  //
  // The derivation is exact at REF_ZOOM by construction, and that is checked
  // rather than asserted: `gridFromSpec(specOf(fam), REF_ZOOM)` reproduces
  // every one of `rows/cols/w/h` for all five families, so nothing about the
  // z<=16 render moves. facadeGridAudit re-runs it at init.
  function specOfTemplate(fam, g) {
    return {
      base: fam,
      pitchM: REPEAT_M / g.rows,      // floor-to-floor
      bayM: REPEAT_M / g.cols,        // bay centres
      want: g.want,                   // glazing fraction of the wall
      aspect: g.h / g.w,              // opening height / width
      curtain: !!g.curtain,
      measured: false,
    };
  }

  /**
   * A family's spec, resolved into the tile a camera at `z` should be drawing.
   *
   * ONE builder for templates and for measured buildings alike, deliberately:
   * the previous pass had two, and a measured family could then drift out of
   * the pier/spandrel spec the templates are held to. A measured family is a
   * family.
   *
   * GLAZING IS NOT A FREE PARAMETER. `want` is the share of wall that is glass
   * and it is held across every zoom band; the aspect only REDISTRIBUTES it.
   * That keeps this file's hardest-won rule — A WALL IS MOSTLY WALL — true at
   * every band, and means a regression here can only ever be a rhythm or shape
   * regression, never a "someone turned the glass up" one.
   */
  function gridFromSpec(spec, z) {
    const R = repeatMAt(z);
    const notes = [];
    let rows = Math.round(R / spec.pitchM);
    if (rows > GRID_CLAMP.maxRows) { notes.push(`rows ${rows}->${GRID_CLAMP.maxRows}`); rows = GRID_CLAMP.maxRows; }
    if (rows < GRID_CLAMP.minRows) { notes.push(`rows ${rows}->${GRID_CLAMP.minRows}`); rows = GRID_CLAMP.minRows; }
    let cols = Math.round(R / spec.bayM);
    if (cols > GRID_CLAMP.maxCols) { notes.push(`cols ${cols}->${GRID_CLAMP.maxCols}`); cols = GRID_CLAMP.maxCols; }
    if (cols < GRID_CLAMP.minCols) { notes.push(`cols ${cols}->${GRID_CLAMP.minCols}`); cols = GRID_CLAMP.minCols; }

    const stepX = TILE / cols, stepY = TILE / rows;
    const area = spec.want * stepX * stepY;
    const a = spec.aspect > 0 ? spec.aspect : 1;
    let w = Math.round(Math.sqrt(area / a));
    let h = Math.round(w * a);
    // A PUNCHED OPENING DOES NOT FILL ITS BAY, and this cap is what says so.
    //
    // The glazing fraction is held across bands while the CELL grows, so once a
    // wall is down to one or two columns the arithmetic asks for one enormous
    // window per cell: Sutton at z18 wanted a 29 px opening in a 32 px cell, a
    // window 88% of the storey height, and the 3 px of spandrel left over was
    // then eaten by its own head shadow and sill — so the tile stopped carrying
    // ANY row rhythm and the storey count it was drawn to hold became
    // unreadable. The zoom sweep in scripts/verify/facadegrid.mjs is what found
    // that; nothing at REF_ZOOM could see it.
    //
    // TASTE KNOB. 0.72 is the largest share that leaves a real spandrel at
    // every band, and it does not bite at REF_ZOOM on ANY of the five templates
    // or any of the sixteen measured buildings — checked, not assumed, which is
    // what keeps the z<=16 render and every family assignment identical.
    // Curtain wall is exempt for the same reason it is exempt from MIN_PIER:
    // tight glass on thin mullions IS the thing being drawn.
    const wCap = Math.min(Math.floor(stepX - (spec.curtain ? 1 : MIN_PIER)),
                          spec.curtain ? Infinity : Math.floor(stepX * OPEN_MAX_FRAC));
    const hCap = Math.min(Math.floor(stepY - (spec.curtain ? 1 : MIN_SPANDREL)),
                          spec.curtain ? Infinity : Math.floor(stepY * OPEN_MAX_FRAC));
    if (w > wCap) { notes.push(`w ${w}->${wCap}`); w = wCap; }
    if (h > hCap) { notes.push(`h ${h}->${hCap}`); h = hCap; }
    w = Math.max(GRID_CLAMP.minOpen, w);
    h = Math.max(GRID_CLAMP.minOpen, h);

    return {
      rows, cols, w, h,
      // Recomputed from the geometry that actually came out, so
      // facadeGridAudit's glazing check stays a real check of the CLAMPS rather
      // than a tautology.
      want: (rows * cols * w * h) / (TILE * TILE),
      baseWant: spec.want,
      curtain: spec.curtain,
      measured: !!spec.measured,
      colsMeasured: !!spec.colsMeasured,
      clamp: notes,
      // What this tile actually puts on the wall, in metres. These are the
      // numbers comparable to a photograph and what scripts/verify/facadegrid.mjs
      // asserts on across the whole zoom sweep.
      pitchDrawnM: R / rows,
      bayDrawnM: R / cols,
      repeatM: R, zoom: z,
    };
  }

  // Templates, keyed the same way families are.
  const SPECS = {};
  for (const [fam, g] of Object.entries(GRIDS)) if (g) SPECS[fam] = specOfTemplate(fam, g);

  // ── Wall material ───────────────────────────────────────────────────
  //
  // The wall between the openings was a flat colour field, which is the other
  // half of "ALL walls are just so many windows" — there was no wall, only a
  // grid.
  //
  // WHAT CANNOT BE DRAWN, measured rather than assumed. At this app's flying
  // zooms a 64 px repeat covers 30-59 m, so one texel is 0.43-0.65 m of wall
  // and the smallest feature that survives camera motion is about two texels,
  // ~1.0-1.3 m. That rules out every masonry unit outright: a modular brick
  // course is 0.068 m = 0.1 texels; an ashlar course 0.2-0.3 m = 0.3-0.7; a
  // precast panel joint 0.019 m = 0.03. Drawing brick at the 1 px floor does
  // not draw brick — it asserts a 0.5 m course, which is concrete block, and
  // states it confidently on a limestone hall. So no coursing, on anything.
  //
  // WHAT SURVIVES, and is therefore all we draw: block-to-block value scatter
  // at ~2 m, vertical weathering, and the structural bay.
  //
  // Also ruled out by the tile itself: cornices, plinths, string courses and
  // ground-floor storefronts. The tile repeats vertically with no anchor, so
  // anything keyed to the top or bottom of a building appears every ~40 m up
  // the wall. That needs stacked geometry (bake_stadium.py does it for DKR) and
  // is not attempted here.
  const WALL = {
    CELL: 4,                     // px per mottle cell -> 1.7-2.6 m, one block face
    MOTTLE:  { lo: 0.070, mr: 0.075, mh: 0.080, tr: 0.055, tg: 0.030 },
    STREAKS: { lo: 3, mr: 5, mh: 7, tr: 6, tg: 3 },
    STREAK_DARK: 0.07,
    STREAK_ALPHA: 0.22,
    PIER: { mr: 1, mh: 1, tr: 1 },   // masonry families only; not tg, not lo
    PIER_LIGHT: 0.045,
    PIER_SHADOW: 0.055,
  };

  // The mottle depends only on (family, seed) — not on wall colour and not on
  // the hour — so it is built once and composited. Emitting 256 fillRects per
  // tile instead would land on updateFacades, which repaints every image on
  // every time-of-day step.
  // Cells are signed deltas in [-1,1], not a canvas. The first cut built a 64x64
  // canvas per (family,bucket) and composited it with drawImage; correct, but it
  // took the atlas repaint from 44 ms to 230 ms, because the tile context is
  // `willReadFrequently` (it has to be — tileData ends in getImageData) and
  // drawImage into a CPU-backed canvas takes the slow path. applyTimeOfDay
  // quantises to 1/128, so dragging the hour slider would have paid that 128
  // times. Applied to the pixel buffer we are already reading instead.
  //
  // ── EVERY FIXED PIXEL SIZE IN THIS FILE IS A SIZE IN METRES ─────────
  //
  // The window grid is not the only thing the screen-lock was quietly rescaling.
  // A mottle cell is 4 px, which is 2.06 m of wall at REF_ZOOM — "one block
  // face", exactly as the block above claims. At the zoom walking height puts
  // the camera at, the same 4 px is 0.26 m: not a block face, a speckle, and a
  // speckle at that frequency is the thing docs/shimmer-mechanism.md convicts
  // for the crawl. Same for the weathering streaks (they get 8x denser), the
  // parking-deck bands (a 6.7 m deck becomes 0.84 m), the pilasters, the window
  // head shadow, the sill and the reveal.
  //
  // `detailK` is the one factor that puts all of them back: the number of times
  // the current repeat divides into REF_ZOOM's. It is exactly 1 at REF_ZOOM, so
  // nothing about the z<=16 render moves, and it doubles per zoom in. Capped at
  // 8 because past that a mottle cell is the whole tile and the wall is a flat
  // colour again.
  const DETAIL_K_MAX = 8;
  const detailK = () => Math.max(1, Math.min(DETAIL_K_MAX, Math.round(REPEAT_M / repeatMAt(_zAnchor))));

  const _noise = new Map();
  function noiseCells(seed, cellPx) {
    const key = seed + '|' + cellPx;
    let a = _noise.get(key);
    if (a) return a;
    const N = TILE / cellPx;
    a = new Float32Array(N * N);
    for (let i = 0; i < a.length; i++) a[i] = hash01(seed + 5501, i % N, (i / N) | 0) * 2 - 1;
    _noise.set(key, a);
    return a;
  }

  // Set by drawTile, consumed by tileData on the same call.
  let _mottle = null;

  /** Fill a full-height column, wrapping across the tile seam. */
  function fillWrap(ctx, x, w, style) {
    ctx.fillStyle = style;
    x = ((x % TILE) + TILE) % TILE;
    ctx.fillRect(x, 0, w, TILE);
    if (x + w > TILE) ctx.fillRect(x - TILE, 0, w, TILE);
  }

  function drawWallMaterial(ctx, fam, wall, dark, seed) {
    const k = detailK();
    // Mottle is handed to tileData rather than drawn — see noiseCells above.
    // `cellPx` is 4 at REF_ZOOM and doubles with the anchor, so a cell is the
    // same 2 m of wall at every zoom. Capped at TILE/2 so there is always more
    // than one cell across the tile.
    const cellPx = Math.min(TILE / 2, WALL.CELL * k);
    // AMPLITUDE FALLS AS THE CELL GROWS, and it has to. The authored 7-8% is
    // block-to-block scatter seen at cruise, where a 4 px cell is averaged away
    // by the decimation and the soften before it ever reaches a screen. Held
    // flat as the cell grows to 16-32 px it stops being a material and becomes
    // visible blotching — and it also swamps the tile's own row rhythm in the
    // low bins, which is how scripts/verify/facadegrid.mjs first saw it: four
    // buildings whose two-row tiles read as one-row tiles because the mottle
    // carried more energy at bin 1 than the windows did at bin 2. sqrt is the
    // usual variance-preserving fall for a block average, so the wall keeps the
    // same total scatter per square metre and stops shouting it per block.
    const amp = WALL.MOTTLE[fam] && WALL.MOTTLE[fam] * Math.sqrt(WALL.CELL / cellPx);
    _mottle = amp ? { cells: noiseCells(seed, cellPx), cellPx, amp: amp * (1 - dark * 0.6) } : null;
    // Weathering: aperiodic in x, CONSTANT in y, so it tiles in both axes with
    // no anchor dependency and cannot moire against the window grid. Same
    // technique as DKR's `sd` band, which is the one large flat surface in this
    // file that already does not read as plastic.
    // COUNT falls and WIDTH rises with the anchor, both by the same k, so the
    // streaks stay the same distance apart and the same width IN METRES. The
    // `max(1)` is what stops a close-in wall going completely unweathered.
    const n = Math.max(WALL.STREAKS[fam] ? 1 : 0, Math.round((WALL.STREAKS[fam] || 0) / k));
    for (let s = 0; s < n; s++) {
      const x = Math.round(hash01(seed + 5623, s, 0) * TILE);
      const w = (2 + Math.round(hash01(seed + 5641, s, 0) * 2)) * k;   // 2-4 px at REF, never 1
      fillWrap(ctx, x, w, css(mix(wall, [0, 0, 0], WALL.STREAK_DARK),
                              WALL.STREAK_ALPHA * (1 - dark * 0.7)));
    }
  }

  // Runtime audit. Cheap, runs once, and turns a silent 2x error into a console
  // line. Exposed so a verification script can assert on it too.
  window.facadeGridAudit = function facadeGridAudit() {
    const rows = [];
    // The measured per-building families are audited by the SAME arithmetic as
    // the seven templates, deliberately: a bespoke grid that reads as
    // scaffolding is exactly as wrong as a template that does, and a guard the
    // new path can skip is a guard the new path will eventually break.
    const all = Object.entries(GRIDS).concat(Object.entries(measuredGridTable()));
    for (const [fam, g] of all) {
      if (!g) continue;
      const glaze = (g.rows * g.cols * g.w * g.h) / (TILE * TILE);
      const pier = TILE / g.cols - g.w, spandrel = TILE / g.rows - g.h;
      const ok = Math.abs(glaze - g.want) < 0.04 &&
                 (g.curtain || (pier >= MIN_PIER && spandrel >= MIN_SPANDREL));
      const row = { fam, glaze: +(glaze * 100).toFixed(1), want: +(g.want * 100).toFixed(1),
                    pierPx: +pier.toFixed(1), spandrelPx: +spandrel.toFixed(1), ok };
      // For a measured family, the interesting number is not `want` (which is
      // recomputed from the geometry that came out) but how far the CLAMPS
      // dragged it away from the template's glazing. That distance is the
      // honest cost of asking a 64 px tile for more rows than it can carry.
      if (g.measured) {
        row.measured = true;
        row.baseWant = +(g.baseWant * 100).toFixed(1);
        row.clampCostPct = +((glaze - g.baseWant) * 100).toFixed(1);
        row.clamp = g.clamp.join(' ') || '-';
      }
      rows.push(row);
      if (!ok) console.warn('[facades] grid out of spec:', fam, row);
    }
    return rows;
  };

  // ── Stadium facade ──────────────────────────────────────────────────
  // A stadium is not an office building, and DKR in particular has almost NO
  // glass: what reads as windows in every photograph is open VOID — recessed
  // slots, vomitory mouths, the shadow under a cantilevered deck. A punched
  // window grid therefore puts glazing where there is literally a hole. The
  // right read is a structural frame: full-height piers crossed by stacked
  // spandrel-and-slot bands, one material, one colour, light doing the work.
  //
  // Researched, not assumed. The obvious guess — brick, because the north end
  // zone masonry is well documented — is WRONG for the building as a whole:
  // the dominant surface is cast-in-place concrete, repainted 2012-13 and
  // again on the west face in 2017, reading warm off-white. Brick appears only
  // at the 2008 north end zone. Sampled references: sunlit painted concrete on
  // DKR's own concourse decks #C5C1B6 (from data/dkr_aerial.png), recessed
  // voids #14100A, deck soffit in shade #4E433F, UT burnt orange #BF5700
  // (Pantone 159, published).
  //
  // ANCHOR-AGNOSTIC BY DESIGN. The tile repeats every ~20 m VERTICALLY as well
  // as horizontally, so nothing here may assume it sits at the roofline or at
  // grade. A first cut had a fascia band near the tile top and a plinth band at
  // the bottom; they landed adjacent across the seam and produced a phantom
  // dark-light-dark stripe three times up the wall. Everything below is
  // designed to tile.
  const STADIUM = {
    GAIN: 1.15,            // wall lift: the pattern removes ~13% of mean luma
    WARM: 0.25,            // pull toward warm concrete, luminance-gated
    WARM_TINT: [232, 222, 206],

    TIERS: 5,              // bands per 20 m -> ~4.0 m floor-to-floor
    SLOT_H: 4,             // px recessed slot (~1.25 m)
    SLOT_DARK: 0.50,
    CORE_DARK: 0.66,       // 1 px deep core at the head of the slot
    LIP_LIGHT: 0.16,       // 1 px sunlit hood above the slot

    CONCOURSE_TIER: 1,     // one tier in five is the deep concourse band, so a
    CONCOURSE_H: 7,        // concourse recurs every 20 m -> 3 on a 63 m bowl,
    CONCOURSE_DARK: 0.58,  // which is what DKR actually has

    PIERS: 4,              // per 20 m -> 5.0 m bay centres
    PIER_W: 5,             // px (~1.6 m)
    MAJOR_PIER_W: 7,       // pier 0 is the wider circulation pier
    PIER_LIGHT: 0.10,
    PIER_SHADOW: 0.28,     // hard shadow down the right flank of each pier
    GOLDEN_WARM: 0.25,

    NIGHT_GLOW: [255, 186, 110],
    NIGHT_CONCOURSE: 0.30, // a lit concourse is a RIBBON, not a window scatter
    NIGHT_PORTAL: 0.35,
    PORTAL_RATE: 0.30,
  };

  /** One stadium tile: prepared wall, spandrel/slot tiers, night ribbon, piers. */
  function drawStadium(ctx, wall, dark, night, golden, seed) {
    const T = TILE;
    const fill = (c, x, y, w, h) => { ctx.fillStyle = css(c); ctx.fillRect(x, y, w, h); };

    // Brightness compensation. The pattern darkens the wall ~13% on average, so
    // without this DKR renders darker and greyer than its baked colour intends.
    // MULTIPLICATIVE on purpose: a mix-to-white would lift a dark building far
    // more in relative terms and turn Moody Center's #4c4c51 into mid grey.
    let w = wall.map(c => Math.min(250, c * STADIUM.GAIN));
    const lum = (0.30 * w[0] + 0.59 * w[1] + 0.11 * w[2]) / 255;
    // Gate the warm-concrete pull on luminance so it applies to DKR and the
    // pale grandstands and effectively not at all to a dark arena.
    const warmT = STADIUM.WARM * Math.max(0, Math.min(1, (lum - 0.35) / 0.30));
    w = mix(w, STADIUM.WARM_TINT, warmT);

    fill(w, 0, 0, T, T);

    // ── horizontal tiers: spandrel, then a recessed slot with a lit hood
    let concourseY = 0, concourseH = 0;
    for (let k = 0; k < STADIUM.TIERS; k++) {
      const y1 = Math.round((k + 1) * T / STADIUM.TIERS);
      const isC = (k === STADIUM.CONCOURSE_TIER);
      const sh = isC ? STADIUM.CONCOURSE_H : STADIUM.SLOT_H;
      const sy = y1 - sh - 1;                       // 1 px of spandrel below each
      fill(mix(w, [255, 255, 255], STADIUM.LIP_LIGHT * (1 - dark * 0.8)), 0, sy - 1, T, 1);
      fill(mix(w, [0, 0, 0], isC ? STADIUM.CONCOURSE_DARK : STADIUM.SLOT_DARK), 0, sy, T, sh);
      fill(mix(w, [0, 0, 0], STADIUM.CORE_DARK), 0, sy, T, 1);
      if (isC) { concourseY = sy; concourseH = sh; }
    }

    // ── night: a continuous ribbon of concourse light, with brighter portals.
    // Deliberately NOT the per-pane scatter the window families use — a lit
    // stadium concourse is a strip, and the slots staying dark is what keeps
    // DKR reading as the big silhouette on the east side of campus.
    if (night > 0.02 && concourseH) {
      const base = mix(w, [0, 0, 0], STADIUM.CONCOURSE_DARK);
      const glow = mix(base, STADIUM.NIGHT_GLOW, STADIUM.NIGHT_CONCOURSE * night);
      fill(glow, 0, concourseY, T, concourseH);
      for (let b = 0; b < 8; b++) {
        if (hash01(seed + 7001, b, 0) > STADIUM.PORTAL_RATE) continue;
        fill(mix(glow, STADIUM.NIGHT_GLOW, STADIUM.NIGHT_PORTAL * night),
             Math.round(b * T / 8) + 2, concourseY + 1, 4, concourseH - 2);
      }
    }

    // ── piers last, so they cross the slots and the night ribbon like real
    // structure standing in front of the openings.
    const hi = mix(mix(w, [255, 255, 255], STADIUM.PIER_LIGHT * (1 - dark * 0.8)),
                   [255, 198, 132], STADIUM.GOLDEN_WARM * golden);
    const sha = mix(w, [0, 0, 0], STADIUM.PIER_SHADOW);
    for (let i = 0; i < STADIUM.PIERS; i++) {
      const x = Math.round(i * T / STADIUM.PIERS);
      const pw = i === 0 ? STADIUM.MAJOR_PIER_W : STADIUM.PIER_W;
      fill(hi, x, 0, pw, T);
      fill(sha, x + pw, 0, 1, T);
    }
  }

  // ── DKR's four elevations, and the two bands they share ─────────────
  //
  // These are the tiles for the stacked wall bands baked by bake_stadium.py.
  // Each band is 11-25 m tall, so a 20 m tile shows roughly one repeat and the
  // texture can finally mean something instead of marching up 63 m of wall.
  //
  // STILL ANCHOR-AGNOSTIC. The tile's vertical phase within a band is not
  // controllable, so no tile below puts a one-off feature near its top or
  // bottom edge — that is what produced a phantom dark-light-dark stripe three
  // times up the wall on the first attempt. Vertical hierarchy comes from the
  // BAND BOUNDARIES, which are geometry, not from the texture.
  const DKR = {
    GAIN: 1.15,            // the pattern removes ~13% of mean luma; put it back
    WARM: 0.22,
    WARM_TINT: [232, 222, 206],

    // sp — concourse arcade. Massive piers, deep portals between them. This is
    // the band at eye level from San Jacinto, so it does most of the work of
    // saying "you cannot walk into an office building here".
    SP_BAYS: 4,            // per 20 m -> 5 m bay centres
    SP_PIER: 7,            // px (~2.2 m) of pier
    SP_VOID: 0.56,         // how dark the opening goes. 0.74 went effectively
                           // black and the plinth read as a row of teeth
                           // rather than an arcade you could walk into.
    SP_FLOOR: 0.34,        // light spilling across the floor of the opening
    SP_NIGHT: 0.42,        // a lit concourse is a continuous glow, not panes

    // sb — Bellmont Hall (west): eleven levels of 1972 concrete with deep-set
    // horizontal window bands and slim vertical fins.
    SB_TIERS: 5,           // ~4 m floor-to-floor
    SB_GLASS_H: 5,
    SB_REVEAL: 0.20,       // lit hood over each band
    SB_SPANDREL: 0.13,
    SB_FIN_EVERY: 8,
    SB_FIN_LIGHT: 0.11,

    // sn — 2008 north end zone: brick veneer, punched windows, pier towers.
    // North end zone: chamfered brick piers with OPEN bays between them, per
    // the 2008 photograph. 3 bays across a 64 px tile puts the pier centres at
    // roughly 5-10 m depending on zoom, which is the real spacing.
    SN_BAYS: 3,
    SN_PIER: 11,           // px of brick pier
    SN_PIER_LIGHT: 0.11,
    SN_PIER_SHADE: 0.26,   // the chamfered return, in shadow
    SN_STONE: 0.30,        // buff cast-stone quoin at the chamfer
    SN_VOID: 0.62,         // how dark the open bay goes
    SN_SLAB: 0.34,         // lit slab edge of each concourse deck inside
    SN_DECK: 9,            // px between those decks
    SN_MULLION: 4,
    SN_NIGHT: 0.30,

    // sf — east grandstand back: cast-in-place concrete, board-formed, almost
    // solid. A few narrow slots are the backs of the vomitories.
    SF_BOARD: 4,           // px between form-board lines
    SF_BOARD_DARK: 0.06,
    SF_SLOTS: 3, SF_SLOT_W: 3, SF_SLOT_DARK: 0.50,

    // sg — 2021 south end zone: club and suite levels, so horizontal glazing.
    SG_TIERS: 4,           // ~5 m floor-to-floor
    SG_GLASS_H: 8,
    SG_MULLION: 6,
    SG_METAL: 0.10,        // spandrel panel, cooler than the concrete

    // sd — back of the upper deck. NOT a blank wall: the first cut made this a
    // near-featureless slab and, at 34% of a 63 m elevation, it became the
    // dominant surface and read as fog. What is actually up there is the
    // exposed structural bay rhythm carrying the raked deck — piers with
    // shallow recesses between them. Lower contrast than the plinth, because
    // these recesses are shallow and those are holes through the building.
    SD_BAYS: 4,            // per 20 m -> 5 m bay centres, same grid as the piers below
    SD_PIER: 6,
    SD_RECESS: 0.10,       // 0.19 turned the whole top third into a picket fence
    SD_PIER_LIGHT: 0.05,
    SD_PANEL: 11,          // px between vertical joints inside a recess
    SD_JOINT_DARK: 0.10,
    SD_STAIN: 0.05,        // faint vertical weathering, the thing that stops a
                           // large surface reading as untextured plastic
  };

  // How much each tile darkens its wall on average, and therefore how much
  // brightness to put back. One shared 1.15 over-lit the near-blank fascia into
  // a pale haze while barely covering the deep-portal plinth.
  // Per-family brightness. `sn` is BELOW 1 on purpose: it is the one brick
  // elevation, the gain and the warm tint together were lifting it into the same
  // pale tan as the concrete sides, and a north end zone that does not read as
  // brick is the whole per-side facade idea failing quietly.
  const DKR_GAIN = { sp: 1.20, sb: 1.14, sn: 0.92, sf: 1.06, sg: 1.12, sd: 1.04 };

  let palette = [];   // [{ wd, wg, wn }]
  let combos = [];    // ['md07', 'tw03', ...] — only families/buckets in use


  // ── Night windows — every taste value in one place ─────────────────
  //
  // Real cities are not one amber. Most windows are warm-white at slightly
  // different temperatures, a minority are cooler fluorescent/office light,
  // and the occasional pane flickers TV-blue. Weights are relative (normalised
  // at pick time). Order matters: the warm tones come first so a per-family
  // warm bias (below) can compress rolls into the warm end of the list.
  const WINDOW_TONES = [
    { rgb: [255, 191, 115], w: 0.40 },  // warm incandescent
    { rgb: [255, 209, 150], w: 0.30 },  // warm-white LED
    { rgb: [244, 235, 200], w: 0.18 },  // neutral white
    { rgb: [205, 219, 235], w: 0.09 },  // cool fluorescent (office)
    { rgb: [150, 190, 255], w: 0.03 },  // TV blue
  ];
  // Per-pane brightness, biased BRIGHT (1 - roll² keeps most panes near full
  // and leaves a dim tail). First cut used roll² — biased dim — and measurably
  // hollowed the city out: lit-pixel share in a fixed night crop fell from
  // 3.97% to 2.13% and the skyline went sleepy.
  //
  // MIN raised 0.40 -> 0.58 by the July 31 night pass. The dim tail was the
  // half of the scatter you could not see. Measured by night-luma.mjs with the
  // streetlights hidden, so this is the windows alone: lit window pixels were
  // 4.5% of a night frame at the campus core and 2.8% at the western edge, with
  // a MEDIAN lit pane at luma 70-86 — against unlit pale limestone that was the
  // brightest large surface in the same frame. The floor of the tail is what
  // moves here; PANE_BRIGHT_MAX is untouched, so nothing new clips.
  const PANE_BRIGHT_MIN = 0.58;
  const PANE_BRIGHT_MAX = 1.00;
  // A rare "hot pane" much brighter than its neighbours — pushed toward white.
  const HOT_PANE_RATE  = 0.07;   // fraction of LIT panes (was 0.05)
  const HOT_PANE_BOOST = 0.35;   // extra mix toward white
  // Occupancy range per family, hashed per (family × bucket) into a continuous
  // value — replaces the old `0.14 + (bucketIdx % 5) * 0.06`, which lit
  // neighbouring buildings in five visible lockstep classes. Family baselines
  // are urban truth: offices (tw) go dark at night, walk-up apartments (md)
  // don't, houses (lo) glow warm but sparse.
  // The roll is squared before mapping into the range, so most buildings sit
  // near the low end and a scatter run lively — matching the baseline look's
  // density (the dominant colour buckets sat at the low end of the old
  // formula too; a uniform roll here measured 2× the baseline lit-pixel
  // share and washed the skyline).
  //
  // The LOW ends were raised by the July 31 night pass (the high ends move with
  // them, by the same amount, so the spread per family is unchanged). Because
  // the roll is squared, the low end is what most buildings actually get:
  // E[occupancy] = lo + (hi-lo)/3, so raising `lo` by 0.12 moves the typical
  // building's occupancy by the full 0.12 while a building at the top of its
  // range barely notices. That is deliberately the shape of the fix — the
  // complaint is that the ordinary background city is too dark, not that the
  // liveliest towers are.
  //
  // Ceiling on this: the same comment above warns that a uniform (unsquared)
  // roll measured 2x the baseline lit-pixel share and washed the skyline out.
  // These land at ~1.5-1.7x the baseline mean occupancy, deliberately under it.
  // The check that says so is `scripts/verify/night-luma.mjs --baseline`, which
  // asserts the unlit mass did not rise with the lights. NOT night-silhouette
  // .mjs: that one locates its roofline with queryRenderedFeatures and finds no
  // column about two thirds of the time at its own pose (see docs/PASS_NIGHT.md
  // §4), so a green run from it is not evidence of much.
  const OCCUPANCY = {
    lo: [0.22, 0.46],   // houses: warm but sparse, moved least
    mr: [0.25, 0.54],   // walk-ups and shops: people are home
    mh: [0.24, 0.52],   // campus halls: partly offices, partly dorms
    tr: [0.28, 0.58],   // residential towers stay lit latest
    tg: [0.20, 0.46],   // offices go dark — but not to 8% of panes
    md: [0.24, 0.54],   // kept: parts still classify into it via span
    tw: [0.20, 0.48],
    dk: [0.00, 0.00],  // parking decks have no glazing (drawn as bands)
  };
  // Compresses a family's tone roll into the warm end of WINDOW_TONES.
  // 1.0 = full palette; 0.6 = houses almost never go fluorescent.
  //
  // `mh` and `tg` — campus halls and campus offices — were pulled warm by the
  // July 31 night pass as the facade half of the warm-core/cool-edge read.
  // Be honest about how weak a lever this is: the atlas is keyed by
  // (family x colour bucket) and carries NO position, so it cannot do a spatial
  // gradient at all. It only works here because the campus families happen to
  // sit in the core and the residential ones (`mr`, `tr`) happen to sit in West
  // Campus. The gradient that is actually spatial is the streetlights'
  // (js/night.js, WARM_ANCHOR).
  const TONE_WARM_BIAS = { lo: 0.60, mr: 0.85, mh: 0.74, tr: 0.80, tg: 0.86, md: 1.00, tw: 1.00, dk: 1.00 };
  // Parking decks at night: the deck-edge strip takes a cool fluorescent cast
  // and a touch more brightness — garages are the one building type lit cool.
  const DK_EDGE_NIGHT_TINT  = [190, 210, 235];
  const DK_EDGE_NIGHT_MIX   = 0.55;   // how far the edge shifts toward the tint
  const DK_EDGE_NIGHT_BOOST = 0.14;   // extra white in the edge at full night

  const TONE_CUM = [];
  { let acc = 0; for (const t of WINDOW_TONES) TONE_CUM.push(acc += t.w); }
  function pickTone(roll) {
    const x = roll * TONE_CUM[TONE_CUM.length - 1];
    for (let i = 0; i < TONE_CUM.length; i++) if (x <= TONE_CUM[i]) return WINDOW_TONES[i].rgb;
    return WINDOW_TONES[WINDOW_TONES.length - 1].rgb;
  }

  // ── colour helpers ────────────────────────────────────────────────
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }
  function rgbToHex(r,g,b) {
    const c = n => Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0');
    return `#${c(r)}${c(g)}${c(b)}`;
  }
  function mix(a, b, t) {
    const A = Array.isArray(a) ? a : hexToRgb(a), B = Array.isArray(b) ? b : hexToRgb(b);
    return [A[0]+(B[0]-A[0])*t, A[1]+(B[1]-A[1])*t, A[2]+(B[2]-A[2])*t];
  }
  function rgbToHsl(r,g,b) {
    r/=255; g/=255; b/=255;
    const mx = Math.max(r,g,b), mn = Math.min(r,g,b), l = (mx+mn)/2;
    if (mx === mn) return [0, 0, l];
    const d = mx-mn, s = l > 0.5 ? d/(2-mx-mn) : d/(mx+mn);
    let h;
    if (mx === r)      h = ((g-b)/d + (g < b ? 6 : 0));
    else if (mx === g) h = (b-r)/d + 2;
    else               h = (r-g)/d + 4;
    return [h/6, s, l];
  }
  function dist2(a, b) {
    // Weighted RGB — cheap and good enough for "nearest surviving bucket".
    const dr = a[0]-b[0], dg = a[1]-b[1], db = a[2]-b[2];
    return 2*dr*dr + 4*dg*dg + 3*db*db;
  }

  /**
   * The COARSE KEY — which of the ~20 tone groups a wall colour belongs to.
   *
   * This arithmetic used to be written out three times inside quantiseFacades
   * (the group pass, the protected pass and the stamp pass) and it has to give
   * the same answer in all three or a building is counted into one group and
   * stamped out of another. It is now written once, for that reason and for a
   * second one: scripts/bake_facades.py has to reproduce these exact floor()
   * boundaries offline, and a rule with one definition is a rule a port can be
   * held to. scripts/verify/facade_parity.py is what holds it.
   *
   * `s < 0.10` is the grey escape — a near-neutral wall has no meaningful hue,
   * so binning it by hue would scatter limestone across twelve groups.
   */
  function coarseKey(rgb) {
    const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    return s < 0.10
      ? `n${Math.floor(l * 5)}`
      : `${Math.floor(h * 12)}-${Math.floor(l * 5)}-${s < 0.22 ? 0 : 1}`;
  }

  /**
   * Night walls come from the baked `wn`, which is now correct.
   *
   * History worth keeping, so nobody re-adds it: the bake used to mix 30% of a
   * warm "lit window" tint into the WALL, landing the whole city on mid
   * olive-khaki after dark (#63615b, #7b6d53) — brighter than the night sky
   * behind it, so the skyline had no silhouette. This file worked around it by
   * deriving its own night wall and ignoring `wn`. That workaround is gone:
   * scripts/bake_detail.py:night_wall() now IS that derivation, verified to
   * produce byte-identical values across all 2,453 features, so there is one
   * definition instead of two.
   */
  const RESIDENTIAL = /apartment|dormitory|residential|hotel|condo/;
  // Tall, and NOT curtain wall. Height alone cannot tell an office tower from a
  // science building, and on this campus the difference is the whole look: a
  // 1970s lab block is a punched masonry grid and a downtown office box is
  // glass. The `tg` fallthrough was answering "is it over 26 m and not flats?"
  // and calling everything else glass, which put 51% glazing on 19 university
  // buildings, 3 churches, 2 hospitals, a presidential library and a chilled
  // water plant. Named casualties included Patton Hall, the Harry Ransom
  // Center, the Neural Molecular Science Building and Chilling Station No. 6.
  //
  // Two of the buildings Simeon reported sit here: Gary L. Thomas clears the
  // 26 m line by 0.8 m (26.8 m over 8 floors is 3.35 m floor to floor, which is
  // an academic building, not a tower) and Biomedical Engineering at 32.6 m.
  // `tg` is also the only family exempt from the MIN_PIER / MIN_SPANDREL guard
  // via `curtain: true`, so it is the one family whose mullions land near the
  // pixel floor — which is the best available candidate for "glitches badly".
  const PUNCHED = new RegExp([
    'university', 'college', 'school', 'kindergarten',
    'church', 'chapel', 'cathedral', 'synagogue', 'mosque', 'temple',
    'hospital', 'clinic', 'civic', 'public', 'government',
    'library', 'museum', 'train_station', 'transportation',
    'industrial', 'manufacture', 'warehouse', 'utility', 'service',
  ].join('|'));

  // ── PER-BUILDING MEASURED GRIDS ─────────────────────────────────────
  //
  // The seven families below are a HEIGHT CLASSIFIER, and that is the defect
  // Simeon named: "windows on walls are just a template copied and pasted".
  // Every 4-to-7 storey campus hall lands on `mh` — 8 rows, 5 columns — so
  // Welch, Painter, Burdine and Mezes are different buildings wearing the same
  // wall. A height class cannot tell a two-storey Beaux-Arts reading room from
  // an eight-storey Brutalist slab, because it is not looking at either one.
  //
  // So the grid becomes a PER-BUILDING PROPERTY where somebody has measured
  // one, and the seven templates survive as the fallback for the ~2,437
  // buildings nobody has. `data/facade_grids.json` (scripts/bake_facade_grids.py)
  // carries the measurements; `registerMeasuredGrids` below turns each into its
  // own family and this map is the join, keyed by the snapshot's own feature id.
  //
  // WHY THE MAP IS DECLARED HERE, three lines above the function that reads it,
  // and not up beside GRIDS: `scripts/verify/campusmeter.mjs` scores the
  // FALLBACK by slicing this file's source from `const RESIDENTIAL =` to the
  // baked-palette banner and evaluating it outside a browser. A map declared
  // inside that slice comes out EMPTY there, so campusmeter keeps measuring
  // exactly what it measured before — the templates, unchanged — and cannot be
  // accidentally flattered by a registry that only exists at runtime.
  const MEASURED = new Map();     // feature id -> { fam, base, ... }
  const MEASURED_SPECS = {};      // family code -> metre spec, read by specFor()
  const MEASURED_BASE = {};       // family code -> the template it borrows
                                  // wall MATERIAL from (mottle, streaks, piers,
                                  // occupancy). Only the GRID is per-building;
                                  // changing the material at the same time
                                  // would make a regression unattributable.

  function familyFor(props) {
    const m = props && props.id != null ? MEASURED.get(props.id) : null;
    if (m) return m.fam;
    const cls = props.building_class || '';
    if (/parking|garage|carport/.test(cls)) return 'dk';
    // A stadium is not an office building. Before this, DKR was 63 m tall so it
    // fell through to `tw` and wore a dense curtain-wall grid — the single
    // loudest wrong note on campus. Class comes from the Overture/OSM bake.
    if (/stadium|arena|sports_centre|grandstand/.test(cls)) return 'st';
    const h = props.final_height || 0;
    if (h < 5)   return 'lo';
    if (h < 12)  return 'mr';
    if (h < 26)  return 'mh';
    // Above 26 m, class decides. Note the ORDER: a university dormitory matches
    // both lists, and it is a dormitory first — punched windows with the
    // residential rhythm, not a lab grid.
    if (RESIDENTIAL.test(cls)) return 'tr';
    // A tall punched building still wants the taller family's rhythm; `mh` is
    // sized for a 4-7 storey hall and reads squat on a 40 m block.
    if (PUNCHED.test(cls)) return h < 45 ? 'mh' : 'tr';
    // Everything left is unclassed or genuinely commercial. Downtown's towers
    // are almost entirely unclassed and land here, which is what `tg` is for.
    return 'tg';
  }

  // ── the baked palette ─────────────────────────────────────────────
  //
  // WHY THE ELECTION HAS TO LEAVE THE BROWSER. `scripts/tile.sh` says it in one
  // line: "a tile of West Campus and a tile of downtown would each elect their
  // own 14 tones against one shared atlas." The election below is a function of
  // the WHOLE feature list, and a tiled source never hands you the whole feature
  // list. So the fourteen buckets are elected offline by
  // `scripts/bake_facades.py` into `data/facade_palette.json`, and this file
  // adopts them.
  //
  // THE ADOPTION IS PROVED, NOT ASSUMED, and in two places.
  // `scripts/verify/facade_parity.py` compares the bake against a live capture
  // of the real `mergeCapitolScene`/`applyUnion24`/`quantiseFacades`, feature by
  // feature — 3,057 of 3,057, same fourteen hex triples, same (family, bucket)
  // on every building. The same harness then loads the page a SECOND time with
  // the baked path armed and diffs the two runs against each other, so the
  // switch is proved inside the browser too and not only offline.
  //
  // TWO GUARDS, BOTH ALL-OR-NOTHING. A palette that is half baked and half
  // elected is fourteen buckets that do not mean the same thing twice.
  //   1. The bake records the snapshot it was computed from, and it is only
  //      adopted for THAT snapshot. `austin-data-bot` rebuilds the snapshot on
  //      a schedule; if it does so without re-running the bake, the date stops
  //      matching and the browser elects, exactly as it did before this change.
  //   2. Every group key present in the scene must be present in the baked
  //      index. `capitol.geojson` and `capitol_overrides.json` are NOT dated by
  //      the snapshot, so a new material could appear under an unchanged date.
  //      One missing key and the whole baked palette is refused.
  //
  // Falling back is safe rather than merely tolerable: the two paths are
  // measured to produce identical output on this snapshot, so a fallback is the
  // same answer computed twice, not a degradation.
  //
  // `?bakedfacades=0` forces the election, so a before/after comes out of ONE
  // build rather than out of a checkout (HANDOFF §37).
  const BAKED_URL = 'data/facade_palette.json';
  let baked = null;             // { snapshot, palette, buckets } once fetched
  window.FACADE_BAKED_ON = !/[?&]bakedfacades=0(?:&|$)/.test(location.search);
  // What actually happened, for the console line and for verification. Never
  // left as a placeholder: "pending" printed in a report is a state nobody can
  // act on, and the honest answer when the flag is off is that nothing was
  // tried.
  let bakedSource = window.FACADE_BAKED_ON ? 'the baked file had not landed'
                                           : 'forced off by ?bakedfacades=0';

  // Kicked off at parse time, not at first use: `quantiseFacades` is
  // synchronous, so the only way it can see this file is for the request to
  // have been in flight while app.js was fetching the 5 MB snapshot in front of
  // it. It is ~1 KB against that, so it lands first with room to spare — and if
  // it somehow does not, guard 1 has nothing to compare and the browser elects.
  const bakedReady = !window.FACADE_BAKED_ON ? Promise.resolve(null) :
    Promise.all([
      fetch(BAKED_URL).then(r => r.ok ? r.json() : null).catch(() => null),
      // The date the app will actually load — js/app.js:209 uses manifest.latest
      // and does not publish it, so this asks the same question rather than
      // trusting a guess. It is a cache hit; app.js has already requested it.
      fetch('data/manifest.json').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([b, m]) => {
      if (!b || !b.palette || !b.buckets) { bakedSource = 'no baked file'; return null; }
      const want = m && m.latest;
      if (want && b.snapshot !== want) {
        bakedSource = `baked for ${b.snapshot}, scene is ${want}`;
        return null;
      }
      baked = { snapshot: b.snapshot, palette: b.palette,
                buckets: new Map(Object.entries(b.buckets)) };
      return baked;
    });
  window.facadeBakedReady = () => bakedReady;
  // WHICH PATH ACTUALLY RAN, not which one was asked for. The two guards fail
  // silently and identically by design — the scene looks the same either way —
  // so without this a verification can only ever confirm what it already
  // assumed. It reads `baked <date>` when the bake was adopted and says why
  // when it was not.
  window.facadePaletteSource = () => bakedSource;

  /** Adopt the baked palette for `features`, or return null and leave state alone. */
  function adoptBaked(features) {
    if (!baked) return null;
    for (const f of features) {
      const p = f.properties;
      if (!p || !p.wd) continue;
      if (!baked.buckets.has(coarseKey(hexToRgb(p.wd)))) {
        bakedSource = 'a wall colour the bake has never seen — re-run '
                    + 'scripts/bake_facades.py';
        return null;
      }
    }
    // Built as a LOCAL and only published on success, so a refusal below still
    // honours this function's contract of leaving state alone. The election
    // reassigns `palette` wholesale anyway, but a half-written module global is
    // the kind of thing that is true until the day somebody reorders two calls.
    const next = baked.palette.map(k => ({ wd: k.wd, wg: k.wg || k.wd, wn: k.wn || k.wd }));

    // PROTECTED TONES ARE RE-APPLIED FROM THE LIVE SPEC, exactly as step 2b of
    // the election below does, and this is the difference between a fast path
    // and a wrong one.
    //
    // WHAT WENT WRONG WITHOUT IT (measured, not reasoned — QUEUE NB6):
    // `js/capitol.js:180-182` mutates the protected spec's `wn` to
    // `CAPITOL.floodWall` at merge time, so the list this module elects over is
    // NOT the list sitting in `data/capitol_parts.geojson`. The bake reads the
    // file, so its bucket 0 carried `#1f1b23`, unlit granite, while the browser
    // elected `#d38e5e`, floodlit. Arming the baked palette without this loop
    // turned the floodlight on the Texas Capitol OFF — one bucket out of
    // fourteen, invisible in every daytime frame, and the whole point of the
    // building after dark.
    //
    // GENERAL, NOT A CAPITOL PATCH. Anything that registers a protected tone
    // gets its EXACT runtime colour here, whatever computed it and however late
    // it ran, so the baked path cannot drift from the election again by the
    // same mechanism. `scripts/bake_facades.py` also transcribes the override
    // now, so the file and this loop agree — belt and braces, deliberately:
    // the bake keeps `facade_parity.py` honest, this keeps the SCENE right even
    // against a palette baked before the override existed.
    const protectedIn = Array.isArray(window.FACADE_PROTECTED) ? window.FACADE_PROTECTED : [];
    const seenProtected = new Set();
    for (const spec of protectedIn) {
      if (!spec || !spec.wd) continue;
      const key = coarseKey(hexToRgb(spec.wd));
      if (seenProtected.has(key)) continue;   // first wins, as in the election
      seenProtected.add(key);
      const b = baked.buckets.get(key);
      if (b == null || !next[b]) {
        // All-or-nothing, like the two guards above: a palette in which the
        // protected material silently fell back to a neighbourhood mean is the
        // pink-dome-on-tan-walls failure, and it is better to spend the 14 ms.
        bakedSource = 'the baked index has no bucket for a protected tone — '
                    + 're-run scripts/bake_facades.py';
        return null;
      }
      // Round-tripped through hexToRgb/rgbToHex so the string is byte-identical
      // to the one the election produces for the same spec.
      next[b] = {
        wd: rgbToHex(...hexToRgb(spec.wd)),
        wg: rgbToHex(...hexToRgb(spec.wg || spec.wd)),
        wn: rgbToHex(...hexToRgb(spec.wn || spec.wd)),
      };
    }

    palette = next;
    // The bucket colours just moved; every painted tile is now describing a
    // palette that no longer exists. See facadeDrawSig.
    if (window.facadeInvalidateAtlasSig) window.facadeInvalidateAtlasSig();
    bakedSource = 'baked ' + baked.snapshot;
    return stampAll(features, baked.buckets);
  }

  // ══════════════════════════════════════════════════════════════════
  //  MEASURED GRIDS — turning "2 storeys, 7 bays, 1:2.8 windows" into a tile
  //  data: scripts/bake_facade_grids.py -> data/facade_grids.json
  // ══════════════════════════════════════════════════════════════════
  //
  // THE ONE THING THAT MAKES THIS SUBTLE, and getting it wrong is how you ship
  // a confident wrong number: `rows` IS NOT THE BUILDING'S STOREY COUNT. This
  // file's own header spends four hundred words on why — the pattern is
  // SCREEN-locked, so one 64 px repeat covers a fixed number of METRES of wall
  // set by the camera, not by the building. A tile with 8 rows puts a window
  // row every REPEAT_M/8 metres, and a 12 m building shows a different number
  // of them than a 40 m one. Writing `rows: 2` for a two-storey building would
  // draw TWO ROWS PER 33 METRES — a 16 m floor-to-floor — which is not Battle
  // Hall, it is a grain silo.
  //
  // So the measurement is a COUNT ON THE REAL BUILDING, and it is turned into
  // the two numbers the tile is actually built from — a FLOOR-TO-FLOOR PITCH
  // and a BAY PITCH, both in metres, against the height the app extrudes:
  //
  //     pitchM = height_m / storeys        bayM = wall_m / bays
  //
  // The row and column COUNTS then fall out of whatever repeat the camera is
  // drawing at (see "THE GRID IS A PITCH IN METRES" at the top of this file),
  // so the wall keeps its storeys at every zoom instead of only at REF_ZOOM.
  // Both are inverted from the same identity, so a later fix to the height bake
  // moves the facade with it and needs no edit here. That matters, because
  // several of the sixteen have visibly wrong heights today (Burdine's 8 floors
  // are extruded into 12.8 m) and the residual shows up in `clamp` rather than
  // being quietly absorbed.
  //
  // REF_ZOOM, repeatMAt, REPEAT_M, GRID_CLAMP and gridFromSpec all live in that
  // block now; this one only turns a measurement into a spec.

  /**
   * One measured entry -> the spec gridFromSpec draws from.
   *
   * GLAZING IS NOT A FREE PARAMETER. The measurements carry the window's
   * ASPECT (a ratio, which survives an oblique photograph) and NOT its area
   * fraction, which was not measured. So the opening keeps the base template's
   * `want` and the aspect only REDISTRIBUTES that area: a 1:5.5 Burdine slot
   * and a 1:1.5 Jackson punch cover the same share of wall as the template they
   * replace.
   */
  function specFromMeasured(m, base, baseFam) {
    const h = m.app_height_m || 0;
    const tpl = SPECS[baseFam] || SPECS.mh;
    // Columns only when the photograph could carry the count against a wall
    // whose length the footprint knows. Otherwise the building keeps its
    // template's bay rhythm — an unmeasured axis stays unmeasured rather than
    // being filled in with something that looks like a measurement.
    const colsMeasured = !!(m.bays && m.bay_wall_m);
    return {
      base: baseFam,
      pitchM: (h > 0 && m.storeys > 0) ? h / m.storeys : tpl.pitchM,
      bayM: colsMeasured ? m.bay_wall_m / m.bays : tpl.bayM,
      want: base.want,
      aspect: m.aspect > 0 ? m.aspect : 1,
      curtain: !!base.curtain,
      measured: true, colsMeasured,
      // Carried so a verifier can compare against the photograph without
      // re-deriving anything: what the building really is.
      storeys: m.storeys, bays: m.bays || null,
      heightM: h, wallM: m.bay_wall_m || null,
    };
  }

  /** The spec for a family, measured or template. One lookup, one fallback. */
  function specFor(fam) { return MEASURED_SPECS[fam] || SPECS[fam] || SPECS.mh; }
  /** The grid a family draws AT THE ZOOM THE ATLAS IS CURRENTLY ANCHORED AT. */
  function gridFor(fam) { return gridAt(fam, _zAnchor); }
  // One grid object per (family, zoom). drawTile asks for this once per tile
  // and facadeGridAudit walks every family, so the cache is worth having and
  // costs one small object per band a session actually visits.
  const _gridCache = new Map();
  function gridAt(fam, z) {
    const key = fam + '|' + z;
    let g = _gridCache.get(key);
    if (!g) { g = gridFromSpec(specFor(fam), z); _gridCache.set(key, g); }
    return g;
  }
  /** The family whose wall MATERIAL a family borrows. Identity for templates. */
  function baseFamOf(fam) { return MEASURED_BASE[fam] || fam; }
  /** Live view of the measured families at the current anchor, for the audit. */
  function measuredGridTable() {
    const out = {};
    for (const fam of Object.keys(MEASURED_SPECS)) out[fam] = gridAt(fam, _zAnchor);
    return out;
  }
  window.facadeGridFor = gridFor;
  window.facadeGridAt = gridAt;
  window.facadeSpecFor = fam => ({ ...specFor(fam) });
  window.facadeMeasuredCount = () => MEASURED.size;
  window.facadeRepeatM = () => REPEAT_M;
  window.facadeRepeatMAt = repeatMAt;
  window.facadeRefZoom = () => REF_ZOOM;
  /** The zoom the atlas is currently drawn for. Never below REF_ZOOM. */
  window.facadeZoomAnchor = () => _zAnchor;
  window.facadeGridClamp = () => ({ ...GRID_CLAMP });

  /**
   * Adopt `data/facade_grids.json`. Called by js/app.js BEFORE quantiseFacades,
   * because familyFor() reads the registry and quantiseFacades is what stamps
   * `wp`/`wf` on every feature.
   *
   * Family codes are `k0`..`kz` (base 36). Two characters, because `wp` is
   * family + a two-digit bucket and the whole atlas is keyed on that four-char
   * string; `k` is unused by lo/mr/mh/tr/tg/dk/st and by bake_stadium's `s?`
   * tiles. Thirty-six measured buildings is the ceiling, and passing it is
   * loud rather than silent.
   *
   * COST, because the atlas budget is not free and was hard-won (its
   * main-thread share went from ~46% to 2-3% on 2026-08-19): each measured
   * building adds at most ONE (family, bucket) combo, and each combo is two
   * images (near + far tier). Sixteen buildings is at most 32 extra images on
   * top of the campus atlas's existing ~30, and in practice fewer, because
   * buildings sharing a colour bucket still get separate families — that is
   * the point — but a building whose grid comes out identical to its template
   * is not registered at all (see `same` below).
   */
  window.registerMeasuredGrids = function registerMeasuredGrids(doc) {
    MEASURED.clear();
    for (const k of Object.keys(MEASURED_SPECS)) delete MEASURED_SPECS[k];
    for (const k of Object.keys(MEASURED_BASE)) delete MEASURED_BASE[k];
    _gridCache.clear();
    if (window.facadeInvalidateAtlasSig) window.facadeInvalidateAtlasSig();
    const list = (doc && doc.buildings) || [];
    const out = [];
    let n = 0, same = 0;
    for (const m of list) {
      if (!m || !m.id) continue;
      const baseFam = GRIDS[m.base] ? m.base : 'mh';
      const base = GRIDS[baseFam];
      const spec = specFromMeasured(m, base, baseFam);
      // THE SAME-AS-TEMPLATE TEST IS TAKEN AT REF_ZOOM, ALWAYS, and it has to
      // be: the family code a building gets is stamped onto the feature once,
      // in `wp`, and scripts/bake_facades.py transcribes this decision so the
      // bake and the browser agree (scripts/verify/facade_parity.py convicts
      // them when they do not). A test taken at the CURRENT zoom would hand a
      // building a family code that changes as you fly, which is not a thing
      // `wp` can express.
      const g = gridFromSpec(spec, REF_ZOOM);
      // A measured building whose grid comes out exactly its template's is not
      // given a family of its own: it would cost an atlas image to draw the
      // identical tile. Sutton Hall is the real instance — 3 storeys on 13.0 m
      // derives 8 rows, which IS `mh`. It only earns a family if the SHAPE
      // differs too, which for every building in this set it does.
      if (g.rows === base.rows && g.cols === base.cols && g.w === base.w && g.h === base.h) {
        same++;
        out.push({ ...m, fam: baseFam, grid: g, spec, sameAsTemplate: true });
        continue;
      }
      if (n >= 36) { console.warn('[facades] more than 36 measured grids; ignoring', m.ref); break; }
      const fam = 'k' + n.toString(36);
      MEASURED_SPECS[fam] = spec;
      MEASURED_BASE[fam] = baseFam;
      MEASURED.set(m.id, { fam, base: baseFam, ref: m.ref });
      out.push({ ...m, fam, grid: g, spec, sameAsTemplate: false });
      n++;
    }
    window.facadeMeasured = out;
    console.log('[facades] measured grids: %d buildings, %d own families, %d identical to their template',
                list.length, n, same);
    return out;
  };

  // ── quantisation ──────────────────────────────────────────────────
  /**
   * Assign `wp` (pattern image id) and `wf` (family) to every feature, and
   * derive the shared colour palette from the data itself so the scene keeps
   * its real character instead of snapping to a guessed set of tones.
   *
   * Takes the baked palette when it is current; elects one otherwise. The
   * election below is the definition either way — the bake is a transcription
   * of it, and scripts/verify/facade_parity.py is what keeps that true.
   */
  window.quantiseFacades = function quantiseFacades(features) {
    const fromBake = adoptBaked(features);
    if (fromBake) {
      console.log('[facades] palette %s — %d buckets, %d patterns, %d buildings',
                  bakedSource, fromBake.buckets, fromBake.patterns, features.length);
      return fromBake;
    }
    // 1. coarse keys → groups
    const groups = new Map();
    for (const f of features) {
      const p = f.properties;
      if (!p || !p.wd) continue;
      const rgb = hexToRgb(p.wd);
      const key = coarseKey(rgb);
      let g = groups.get(key);
      if (!g) { g = { n: 0, wd: [0,0,0], wg: [0,0,0], wn: [0,0,0] }; groups.set(key, g); }
      g.n++;
      const acc = (arr, c) => { arr[0]+=c[0]; arr[1]+=c[1]; arr[2]+=c[2]; };
      acc(g.wd, rgb); acc(g.wg, hexToRgb(p.wg || p.wd)); acc(g.wn, hexToRgb(p.wn || p.wd));
    }

    // 2. keep the most populous groups, mean-colour each
    const all = [...groups.entries()]
      .map(([key, g]) => ({
        key,
        n: g.n,
        wd: g.wd.map(v => v / g.n),
        wg: g.wg.map(v => v / g.n),
        wn: g.wn.map(v => v / g.n),
      }))
      .sort((a, b) => b.n - a.n);

    // 2b. Protected colours survive the cut regardless of how few buildings
    // wear them. Keeping the 14 most POPULOUS tones is the right default —
    // it is what stops 900 near-duplicates becoming mud — but it also means a
    // one-off material on a landmark is guaranteed to lose, and gets folded
    // into whatever tan its neighbours happen to average to. That is how the
    // Texas Capitol came back with a Sunset Red granite dome (its own layer)
    // standing on tan office walls (this atlas). A protected entry keeps its
    // EXACT colour rather than its group's mean, because the point is the
    // material, not the neighbourhood.
    const protectedIn = Array.isArray(window.FACADE_PROTECTED) ? window.FACADE_PROTECTED : [];
    const protectedBuckets = [];
    const protectedKeys = new Map();               // group key → protected idx
    for (const spec of protectedIn) {
      if (!spec || !spec.wd) continue;
      const rgb = hexToRgb(spec.wd);
      const key = coarseKey(rgb);
      if (protectedKeys.has(key)) continue;
      protectedKeys.set(key, protectedBuckets.length);
      protectedBuckets.push({
        key, n: 0, wd: rgb,
        wg: hexToRgb(spec.wg || spec.wd),
        wn: hexToRgb(spec.wn || spec.wd),
      });
    }

    const kept = protectedBuckets.concat(
      all.filter(g => !protectedKeys.has(g.key))
         .slice(0, Math.max(0, TARGET_BUCKETS - protectedBuckets.length)));
    const index = new Map();                       // group key → bucket idx
    kept.forEach((k, i) => index.set(k.key, i));
    // 3. fold the tail into its nearest survivor
    for (const g of all) {
      if (index.has(g.key)) continue;
      let best = 0, bestD = Infinity;
      kept.forEach((k, i) => { const d = dist2(g.wd, k.wd); if (d < bestD) { bestD = d; best = i; } });
      index.set(g.key, best);
    }

    if (window.facadeInvalidateAtlasSig) window.facadeInvalidateAtlasSig();
    palette = kept.map(k => ({
      wd: rgbToHex(...k.wd), wg: rgbToHex(...k.wg), wn: rgbToHex(...k.wn),
    }));

    // 4. stamp every feature, collecting the (family, bucket) combos in use
    const stats = stampAll(features, index);
    console.log('[facades] palette elected in the browser (%s) — %d buckets, '
                + '%d patterns, %d buildings',
                bakedSource, stats.buckets, stats.patterns, features.length);
    return stats;
  };

  /**
   * Stamp `wp`/`wf` on every feature from a group-key → bucket index.
   *
   * SPLIT OUT OF THE ELECTION ON PURPOSE, and this split is the whole of C1.
   * Steps 1-3 above need to see EVERY building at once — you cannot elect the
   * fourteen most populous tones from one tile of West Campus. Step 4 needs to
   * see one feature. Once the index arrives from the bake instead of from the
   * election, this is the only step a tiled source has to run, and it runs per
   * feature with no global view. See scripts/bake_facades.py.
   */
  function stampAll(features, index) {
    const used = new Set();
    for (const f of features) {
      const p = f.properties;
      if (!p || !p.wd) continue;
      const b = index.get(coarseKey(hexToRgb(p.wd))) || 0;
      const fam = familyFor(p);
      const id = fam + String(b).padStart(2, '0');
      p.wp = id;
      p.wf = fam;
      used.add(id);
    }
    combos = [...used];
    return { buckets: palette.length, patterns: combos.length };
  }

  // Parts inherit their parent's look; they carry baked colours but no class,
  // so classify them by their own volume.
  window.quantisePartFacades = function quantisePartFacades(features) {
    if (!palette.length) return;
    for (const f of features) {
      const p = f.properties;
      if (!p || !p.wd) continue;
      const rgb = hexToRgb(p.wd);
      const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
      let best = 0, bestD = Infinity;
      palette.forEach((k, i) => { const d = dist2(rgb, hexToRgb(k.wd)); if (d < bestD) { bestD = d; best = i; } });
      const span = (p.h || 0) - (p.base || 0);
      const fam = span < 5 ? 'lo' : span < 12 ? 'mr' : span < 26 ? 'mh' : 'tg';
      p.wp = fam + String(best).padStart(2, '0');
      p.wf = fam;
      if (combos.indexOf(p.wp) === -1) combos.push(p.wp);
    }
  };

  // The stadium's perimeter wall is baked geometry, not a building feature, so
  // it misses quantiseFacades. It also needs something the buildings source
  // cannot express: a different pattern per ELEVATION and per HEIGHT BAND. The
  // tile repeats every ~20 m in both axes, so a single 63 m extrusion can only
  // ever wear one texture from grade to rim — which is precisely the "big
  // repetitive window pattern" being fixed. bake_stadium.py emits twelve wall
  // features (four sides x three bands) each carrying its own `fam` and `wd`.
  window.quantiseStadiumFacades = function quantiseStadiumFacades(map, features) {
    if (!palette.length) return 0;
    let added = 0;
    const own = new Map();          // baked hex -> palette index
    for (const f of features) {
      const p = f.properties;
      if (!p || p.kind !== 'wall' || !p.wd) continue;
      // Its OWN palette entries, not the nearest of the city's fourteen. Those
      // buckets are the means of Austin's building colours and are almost all
      // tan; snapping to them turned the 2008 north end zone's brick veneer
      // back into tan and erased the one elevation with a different material.
      let idx = own.get(p.wd);
      if (idx == null) {
        idx = palette.length;
        palette.push({ wd: p.wd, wg: p.wg || p.wd, wn: p.wn || p.wd });
        own.set(p.wd, idx);
      }
      const fam = p.fam || 'st';
      p.wp = fam + String(idx).padStart(2, '0');
      p.wf = fam;
      if (combos.indexOf(p.wp) === -1) combos.push(p.wp);
      // initFacades has already run by now, so a new combo has no image yet and
      // MapLibre would paint the wall transparent. Every tier, not just the one
      // on screen — see ensureImages.
      added += ensureImages(map, p.wp, window.__todCurrentP != null ? window.__todCurrentP : 0.5);
    }
    return added;
  };

  // ── pattern drawing ───────────────────────────────────────────────
  function lerpHexAt(bucket, p) {
    return p <= 0.5
      ? mix(bucket.wd, bucket.wg, p / 0.5)
      : mix(bucket.wg, bucket.wn, (p - 0.5) / 0.5);
  }

  // Deterministic 0..1 — lets each bucket light a different window scatter at
  // night without any randomness that would flicker between repaints.
  function hash01(a, b, c) {
    let x = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
    x = (x ^ (x >> 13)) * 1274126177;
    return ((x ^ (x >> 16)) >>> 0) / 4294967295;
  }

  function css(rgb, alpha) {
    return `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${alpha == null ? 1 : alpha})`;
  }

  // ── DKR's per-elevation tiles ─────────────────────────────────────
  // One function per band family. All six share the same preamble: lift the
  // wall (the pattern costs ~13% of mean luma) and pull it a little toward warm
  // concrete, gated on luminance so a dark surface is left alone.
  function dkrWall(wall, fam) {
    let w = wall.map(c => Math.min(250, c * (DKR_GAIN[fam] || DKR.GAIN)));
    const lum = (0.30 * w[0] + 0.59 * w[1] + 0.11 * w[2]) / 255;
    return mix(w, DKR.WARM_TINT, DKR.WARM * Math.max(0, Math.min(1, (lum - 0.35) / 0.30)));
  }

  const DKR_TILES = {
    /** sp — concourse arcade: piers with deep portals between them. */
    sp(ctx, wall, dark, night, golden, glass, seed) {
      const T = TILE, w = dkrWall(wall, 'sp');
      const fill = (c, x, y, ww, hh) => { ctx.fillStyle = css(c); ctx.fillRect(x, y, ww, hh); };
      fill(w, 0, 0, T, T);
      const bay = T / DKR.SP_BAYS;
      const voidC = mix(w, [0, 0, 0], DKR.SP_VOID);
      const floor = mix(voidC, [255, 240, 215], DKR.SP_FLOOR * (1 - dark));
      const lit = mix(voidC, [255, 186, 110], DKR.SP_NIGHT * night);
      for (let b = 0; b < DKR.SP_BAYS; b++) {
        const x = Math.round(b * bay) + DKR.SP_PIER;
        const ow = Math.round(bay) - DKR.SP_PIER;
        if (ow <= 0) continue;
        const back = night > 0.02 ? lit : voidC;
        fill(back, x, 0, ow, T);
        // The opening is a hole through a thick wall, so one jamb is in deep
        // shade and the far side of the reveal catches light. Both run the FULL
        // tile height — nothing here may key off the top or bottom edge.
        fill(mix(back, [0, 0, 0], 0.40), x, 0, 1, T);
        fill(mix(back, night > 0.02 ? [255, 210, 150] : floor, 0.5), x + ow - 1, 0, 1, T);
      }
      // Piers last so they stand IN FRONT of the openings.
      const hi = mix(mix(w, [255, 255, 255], 0.09 * (1 - dark * 0.8)), [255, 198, 132], 0.22 * golden);
      const sha = mix(w, [0, 0, 0], 0.30);
      for (let b = 0; b < DKR.SP_BAYS; b++) {
        const x = Math.round(b * bay);
        fill(hi, x, 0, DKR.SP_PIER, T);
        fill(sha, x + DKR.SP_PIER, 0, 1, T);
      }
    },

    /** sb — Bellmont Hall: 1972 concrete, deep horizontal window bands. */
    sb(ctx, wall, dark, night, golden, glass, seed) {
      const T = TILE, w = dkrWall(wall, 'sb');
      const fill = (c, x, y, ww, hh) => { ctx.fillStyle = css(c); ctx.fillRect(x, y, ww, hh); };
      fill(w, 0, 0, T, T);
      const step = T / DKR.SB_TIERS;
      for (let k = 0; k < DKR.SB_TIERS; k++) {
        const y = Math.round(k * step + (step - DKR.SB_GLASS_H) / 2);
        fill(mix(w, [0, 0, 0], DKR.SB_SPANDREL), 0, y - 2, T, DKR.SB_GLASS_H + 4);
        fill(glass, 0, y, T, DKR.SB_GLASS_H);
        // A lit hood over the band is what makes it read RECESSED rather than
        // painted on — the single cheapest depth cue on a flat extrusion.
        fill(mix(w, [255, 255, 255], DKR.SB_REVEAL * (1 - dark * 0.8)), 0, y - 1, T, 1);
        if (night > 0.02) {
          for (let c = 0; c < 10; c++) {
            const r = hash01(seed, k, c);
            if (r > 0.34) continue;
            const tone = pickTone(hash01(seed + 11, k, c));
            const br = PANE_BRIGHT_MIN + (PANE_BRIGHT_MAX - PANE_BRIGHT_MIN) * (1 - Math.pow(hash01(seed + 3, k, c), 2));
            fill(mix(glass, tone, night * br), Math.round(c * T / 10) + 1, y, Math.round(T / 10) - 2, DKR.SB_GLASS_H);
          }
        }
      }
      const fin = mix(w, [255, 255, 255], DKR.SB_FIN_LIGHT * (1 - dark * 0.8));
      for (let x = 0; x < T; x += DKR.SB_FIN_EVERY) {
        fill(fin, x, 0, 2, T);
        fill(mix(w, [0, 0, 0], 0.16), x + 2, 0, 1, T);
      }
    },

    /** sn — 2008 north end zone. NOT a window wall; go and look at it.
     *
     * The reference is Commons `DKR_new_north_end_2008-08-30.JPG`, and it shows
     * something this tile previously got completely wrong. There is no punched
     * window grid on the north elevation. There are MASSIVE CHAMFERED BRICK
     * PIERS, and between them the bays are simply OPEN — you see straight
     * through to the stacked concourse decks inside, their slab edges catching
     * light against a deep shadow. That open-bay-and-pier rhythm is the entire
     * character of the elevation, and it is what the contractor meant by
     * "radiused block walls on the pedestrian ramps ... creates the angular
     * expression seen from the exterior".
     *
     * Drawing windows here was the same mistake as the city-wide one: reaching
     * for a window because it is a building, instead of looking at the building.
     * A few bays do carry tall grey-mullioned glass, so those are kept — as the
     * exception the photograph shows them to be, roughly one bay in three.
     */
    sn(ctx, wall, dark, night, golden, glass, seed) {
      const T = TILE, w = dkrWall(wall, 'sn');
      const fill = (c, x, y, ww, hh) => { ctx.fillStyle = css(c); ctx.fillRect(x, y, ww, hh); };
      fill(w, 0, 0, T, T);
      // Brick coursing is 68 mm and one texel is half a metre, so a "course"
      // here would be a lie about the material. What survives at this scale is
      // block-to-block colour scatter, which is what brick actually reads as.
      const bay = T / DKR.SN_BAYS;
      const deep = mix(w, [0, 0, 0], DKR.SN_VOID);
      const slab = mix(deep, [235, 226, 210], DKR.SN_SLAB * (1 - dark * 0.7));
      const rail = mix(deep, [90, 110, 96], 0.45);          // the green guardrails
      const litVoid = mix(deep, [255, 196, 122], DKR.SN_NIGHT * night);
      for (let b = 0; b < DKR.SN_BAYS; b++) {
        const x = Math.round(b * bay) + DKR.SN_PIER;
        const ow = Math.round(bay) - DKR.SN_PIER;
        if (ow <= 0) continue;
        const isGlass = ((b + (seed | 0)) % 3) === 1;
        if (isGlass) {
          // A tall grey-mullioned curtain panel, set back behind the piers.
          fill(mix(w, [138, 146, 152], 0.75), x - 1, 0, ow + 2, T);
          fill(glass, x, 0, ow, T);
          if (night > 0.02) fill(mix(glass, [255, 226, 186], night * 0.55), x, 0, ow, T);
          for (let m = 0; m < ow; m += DKR.SN_MULLION) fill(mix(w, [0, 0, 0], 0.34), x + m, 0, 1, T);
        } else {
          fill(night > 0.02 ? litVoid : deep, x, 0, ow, T);
          // The stacked concourse decks seen through the opening. These run the
          // FULL tile height and repeat on the tile's own period — nothing here
          // may key off a top or a bottom edge, because the pattern has neither.
          for (let y = DKR.SN_DECK; y < T; y += DKR.SN_DECK) {
            fill(slab, x, y, ow, 2);
            fill(rail, x, y - 2, ow, 2);
          }
          fill(mix(deep, [0, 0, 0], 0.45), x, 0, 1, T);       // shaded jamb
        }
      }
      // Piers last, so they stand in FRONT of the openings. Each is chamfered:
      // a lit return on one side, a shadowed one on the other, which is what
      // gives the elevation its faceted, sawtooth read from an oblique camera.
      const face = mix(mix(w, [255, 255, 255], DKR.SN_PIER_LIGHT * (1 - dark * 0.8)),
                       [255, 198, 132], 0.20 * golden);
      const cham = mix(w, [0, 0, 0], DKR.SN_PIER_SHADE);
      const stone = mix(w, [232, 224, 205], DKR.SN_STONE);   // buff cast stone
      for (let b = 0; b < DKR.SN_BAYS; b++) {
        const x = Math.round(b * bay);
        fill(face, x, 0, DKR.SN_PIER, T);
        fill(stone, x + 1, 0, 2, T);                          // quoin at the chamfer
        fill(cham, x + DKR.SN_PIER - 2, 0, 2, T);
        fill(mix(w, [0, 0, 0], 0.24), x + DKR.SN_PIER, 0, 1, T);
      }
    },

    /** sf — east grandstand back: board-formed concrete, near solid. */
    sf(ctx, wall, dark, night, golden, glass, seed) {
      const T = TILE, w = dkrWall(wall, 'sf');
      const fill = (c, x, y, ww, hh) => { ctx.fillStyle = css(c); ctx.fillRect(x, y, ww, hh); };
      fill(w, 0, 0, T, T);
      const board = mix(w, [0, 0, 0], DKR.SF_BOARD_DARK);
      const lip = mix(w, [255, 255, 255], 0.05 * (1 - dark * 0.8));
      for (let x = 0; x < T; x += DKR.SF_BOARD) { fill(board, x, 0, 1, T); fill(lip, x + 1, 0, 1, T); }
      const slot = mix(w, [0, 0, 0], DKR.SF_SLOT_DARK);
      const glow = mix(slot, [255, 186, 110], 0.30 * night);
      for (let s = 0; s < DKR.SF_SLOTS; s++) {
        const x = Math.round((s + 0.5) * T / DKR.SF_SLOTS) - 1;
        fill(night > 0.02 ? glow : slot, x, 0, DKR.SF_SLOT_W, T);
      }
    },

    /** sg — 2021 south end zone: club and suite levels, horizontal glazing. */
    sg(ctx, wall, dark, night, golden, glass, seed) {
      const T = TILE, w = dkrWall(wall, 'sg');
      const fill = (c, x, y, ww, hh) => { ctx.fillStyle = css(c); ctx.fillRect(x, y, ww, hh); };
      const metal = mix(w, [206, 212, 219], DKR.SG_METAL);
      fill(metal, 0, 0, T, T);
      const step = T / DKR.SG_TIERS;
      for (let k = 0; k < DKR.SG_TIERS; k++) {
        const y = Math.round(k * step + (step - DKR.SG_GLASS_H) / 2);
        fill(glass, 0, y, T, DKR.SG_GLASS_H);
        fill(mix(metal, [255, 255, 255], 0.16 * (1 - dark * 0.8)), 0, y - 1, T, 1);
        fill(mix(metal, [0, 0, 0], 0.18), 0, y + DKR.SG_GLASS_H, T, 1);
        // Club levels are lit as a continuous room, not as a pane scatter.
        if (night > 0.02) {
          fill(mix(glass, [255, 214, 168], night * 0.62), 0, y, T, DKR.SG_GLASS_H);
          for (let c = 0; c < 8; c++) {
            if (hash01(seed, k, c) > 0.45) continue;
            fill(mix(glass, [255, 232, 200], night * 0.78),
                 Math.round(c * T / 8) + 1, y, Math.round(T / 8) - 2, DKR.SG_GLASS_H);
          }
        }
        for (let x = 0; x < T; x += DKR.SG_MULLION) {
          fill(mix(metal, [0, 0, 0], 0.22), x, y, 1, DKR.SG_GLASS_H);
        }
      }
    },

    /** sd — back of the upper deck: the exposed structural bay rhythm. */
    sd(ctx, wall, dark, night, golden, glass, seed) {
      const T = TILE, w = dkrWall(wall, 'sd');
      const fill = (c, x, y, ww, hh) => { ctx.fillStyle = css(c); ctx.fillRect(x, y, ww, hh); };
      fill(w, 0, 0, T, T);
      const bay = T / DKR.SD_BAYS;
      const recess = mix(w, [0, 0, 0], DKR.SD_RECESS);
      const joint = mix(recess, [0, 0, 0], DKR.SD_JOINT_DARK);
      for (let b = 0; b < DKR.SD_BAYS; b++) {
        const x = Math.round(b * bay) + DKR.SD_PIER;
        const ow = Math.round(bay) - DKR.SD_PIER;
        if (ow <= 0) continue;
        fill(recess, x, 0, ow, T);
        for (let j = x + DKR.SD_PANEL; j < x + ow; j += DKR.SD_PANEL) fill(joint, j, 0, 1, T);
      }
      // Weathering streaks. Deterministic and full height, so they tile.
      for (let s = 0; s < 7; s++) {
        const x = Math.round(hash01(seed + 91, s, 0) * T);
        const wd = 1 + Math.round(hash01(seed + 92, s, 0) * 2);
        ctx.fillStyle = css(mix(w, [0, 0, 0], DKR.SD_STAIN), 0.6);
        ctx.fillRect(x, 0, wd, T);
      }
      // Piers last, standing in front of the recesses.
      const hi = mix(mix(w, [255, 255, 255], DKR.SD_PIER_LIGHT * (1 - dark * 0.8)),
                     [255, 198, 132], 0.20 * golden);
      const sha = mix(w, [0, 0, 0], 0.22);
      for (let b = 0; b < DKR.SD_BAYS; b++) {
        const x = Math.round(b * bay);
        fill(hi, x, 0, DKR.SD_PIER, T);
        fill(sha, x + DKR.SD_PIER, 0, 1, T);
      }
    },
  };

  /** Draw one (family, bucket) tile for time-of-day p into a canvas ctx. */
  function drawTile(ctx, fam, bucketIdx, p) {
    const bucket = palette[bucketIdx] || palette[0];
    const wallBase = lerpHexAt(bucket, p);
    // TWO night factors, deliberately on different schedules.
    //
    // `night` (p-driven) drives the LIT WINDOWS, and its lag is intentional:
    // the city's lights come up as the sky finishes darkening, not the instant
    // the sun clears the horizon.
    //
    // `dark` (sun-elevation-driven) drives how far the WALL itself falls. Riding
    // the p-schedule for both left walls 60% golden-lit at p=0.7, when the sun is
    // already 8° below the horizon — measured as an INVERTED dusk silhouette
    // (sky luma 75.7 against wall 88.5), the city glowing against a darker sky.
    // Walls follow the sun; windows follow the hour.
    const night = Math.max(0, (p - 0.55) / 0.45);
    const sunElev = (typeof window.skyBodies === 'function') ? window.skyBodies(p).sun.elev : (0.5 - p) * 100;
    const dark = Math.max(night, Math.min(1, Math.max(0, -sunElev / 9)));
    const golden = 1 - Math.abs(p - 0.5) / 0.5;     // peaks at golden hour

    // Pull the wall the rest of the way toward its night tone once the sun is
    // actually down, so the skyline silhouettes correctly through dusk.
    const wall = mix(wallBase, bucket ? hexToRgb(bucket.wn) : wallBase, Math.max(0, dark - night));
    ctx.clearRect(0, 0, TILE, TILE);
    ctx.fillStyle = css(wall);
    ctx.fillRect(0, 0, TILE, TILE);

    // Glass tone: cool + dark by day, amber-reflective at golden, near-black at
    // night (the lit windows are painted over it).
    let glass = mix(wall, [46, 58, 74], 0.62);
    glass = mix(glass, [255, 176, 96], golden * 0.45);
    glass = mix(glass, [12, 15, 28], dark * 0.9);
    // ── A WINDOW HAS TO BE VISIBLE AGAINST ITS OWN WALL ─────────────
    //
    // Every glass tone above is a MIX WITH THE WALL, so on the darker buckets
    // the two converge and the openings stop reading at all. Gregory Gym is the
    // measured instance: its tile's only row structure is the head shadow and
    // the sill, the panes themselves are within a few luma of the brick, and
    // scripts/verify/facadegrid.mjs's zoom sweep reads its one-row tile as a
    // two-row one because the two trim lines are the only signal in it. That is
    // not an instrument failure — a wall whose windows are invisible is the
    // defect, and it is invisible at every zoom, not only under a DFT.
    //
    // So: a floor on the day-time separation, in luma, applied in whichever
    // direction the wall leaves room for. Scaled by (1 - dark) because after
    // sunset a dark pane against a dark wall is CORRECT — the lit-pane scatter
    // is what carries the night facade, and forcing daylight contrast into it
    // would put a grey grid on the whole city at midnight.
    // TASTE KNOB: 26 of 255 is roughly twice the wall's own mottle swing at
    // REF_ZOOM, i.e. the point where an opening stops being confusable with a
    // block of stone.
    const lum = c => 0.30 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    const needC = GLASS_MIN_CONTRAST * (1 - dark);
    const lw = lum(wall), lg = lum(glass);
    if (lw - lg < needC) {
      if (lw - needC > 24) {
        // Room below: darken the pane to sit `needC` under the wall.
        glass = mix(glass, [0, 0, 0], Math.max(0, Math.min(0.9, 1 - (lw - needC) / Math.max(1, lg))));
      } else {
        // The wall is already dark, so the pane goes the other way — a lit
        // interior read, which is what a dark masonry building actually does.
        glass = mix(glass, [214, 222, 232], Math.max(0, Math.min(0.55, (needC - (lg - lw)) / 255)));
      }
    }

    if (fam === 'st') {
      // Stadium/arena masonry: piers and bays, not windows. See drawStadium.
      drawStadium(ctx, wall, dark, night, golden, bucketIdx * 4 + 3);
      return;
    }

    if (fam.length === 2 && fam[0] === 's' && DKR_TILES[fam]) {
      DKR_TILES[fam](ctx, wall, dark, night, golden, glass, bucketIdx * 4 + 5);
      return;
    }

    if (fam === 'dk') {
      // Parking deck: open horizontal slots + a thin bright deck edge.
      // At night the edge goes cool-fluorescent (see DK_EDGE_NIGHT_*).
      const shade = mix(wall, [0, 0, 0], 0.55 + night * 0.2);
      let edge = mix(wall, [255, 255, 255], 0.18 + night * DK_EDGE_NIGHT_BOOST);
      edge = mix(edge, DK_EDGE_NIGHT_TINT, night * DK_EDGE_NIGHT_MIX);
      // 13 px at REF_ZOOM is a 6.7 m deck-to-deck pitch; k holds it there as
      // the camera comes in. Capped so at least one band fits in the tile.
      const dk = Math.max(1, Math.min(4, detailK()));
      const pitch = 13 * dk, slot = 7 * dk, top = 5 * dk;
      for (let y = top; y < TILE; y += pitch) {
        ctx.fillStyle = css(shade);
        ctx.fillRect(0, y, TILE, slot);
        ctx.fillStyle = css(edge, 0.85);
        ctx.fillRect(0, y + slot, TILE, Math.max(1, Math.round(dk / 2)));
      }
      return;
    }

    // `GRIDS.md` does not exist — the families are lo/mr/mh/tr/tg/dk/st — so
    // this fallback threw on an unregistered family instead of degrading to
    // one. `mh` is the intended default: the punched campus-hall grid, the
    // safest thing to put on a wall we cannot classify.
    // `gridFor` is the ONE lookup: a measured per-building grid if this family
    // has one, else the template. Everything below this line is unchanged and
    // does not know which it got — a measured family is a family.
    const g = gridFor(fam);
    // MATERIAL, on the other hand, comes from the family the measurement was
    // taken against. Only the GRID is per-building; a measured Battle Hall
    // still wears `mh`'s mottle, streaks, piers, occupancy and tone bias, so a
    // change in this pass can only ever be a rhythm or shape change.
    const mat = baseFamOf(fam);
    const stepX = TILE / g.cols, stepY = TILE / g.rows;
    const offX = (stepX - g.w) / 2, offY = (stepY - g.h) / 2;

    // WHAT USED TO BE HERE, and why it is gone: a full-width dark line across
    // the whole tile at EVERY floor —
    //     for (let r = 0; r < g.rows; r++) ctx.fillRect(0, r * stepY, TILE, 1);
    // — sold as "faint floor lines give the wall texture". Combined with the
    // per-window head shadow and sill landing on those same rows, that is three
    // horizontal darks per storey, one of them spanning the entire facade.
    // Continuous full-width horizontal banding is not texture: it is the exact
    // primitive the `dk` family uses to say PARKING DECK (see the `dk` branch
    // above, which draws bands at a 13 px pitch and nothing else). So every
    // building in the city was wearing the garage texture, reported verbatim as
    // "maybe theyre all garages going all the way up". It stays in `dk`, which
    // is a garage. Wall texture now comes from material, below.
    // `mat`, not `fam`, so a measured family lands on its template's index and
    // wears its template's material. The measured families then get their OWN
    // slot in the seed stream from the second term: without it `k0` and `k1`
    // sharing a colour bucket would land on the identical seed and light the
    // identical night-window scatter on two different buildings, which is the
    // "copied and pasted" complaint reappearing after dark.
    const famIdx = ['lo','mr','mh','tr','tg','dk','st'].indexOf(mat) + 1;
    const measIdx = fam === mat ? 0 : (parseInt(fam.slice(1), 36) + 1);
    const seed = bucketIdx * 4 + famIdx + measIdx * 331;
    drawWallMaterial(ctx, mat, wall, dark, seed);

    // Pilaster relief, LOCKED to the window column pitch and given no count of
    // its own. A second vertical frequency near but not equal to the window
    // pitch beats against it, and that is the ribbed-metal failure this file has
    // already shipped once.
    // `dk` is the same metre anchor as the wall material: a pilaster is ~1 m of
    // stone at REF_ZOOM and stays ~1 m as the camera comes in, rather than
    // thinning to a hairline. Capped at 4 so a very close tile does not end up
    // more pier than wall.
    //
    // AND THEN CAPPED AGAIN BY THE GAP IT HAS TO FIT IN, which is not a nicety:
    // the head shadow and the sill are drawn INTO the spandrel, and the first
    // cut of this scaled them without asking how much spandrel there was. At
    // z17 Main Building draws a 9 px opening in a 12.8 px cell — 3.8 px of wall
    // between rows — and a 2 px head plus a 2 px sill closed it completely, so
    // five window rows fused into one dark field and the tile stopped carrying
    // any row rhythm at all. The zoom sweep in scripts/verify/facadegrid.mjs
    // caught it on six buildings; nothing else would have.
    const dk = Math.min(4, detailK());
    // ...and the cap leaves MIN_SPANDREL / MIN_PIER of CLEAN wall behind it, so
    // thickening the trim can never be what closes a gap the grid arithmetic
    // deliberately left open.
    const dkRow = Math.max(1, Math.min(dk, Math.floor((stepY - g.h - MIN_SPANDREL) / 2)));
    const dkCol = Math.max(1, Math.min(dk, Math.floor((stepX - g.w - MIN_PIER) / 3)));
    if (WALL.PIER[mat]) {
      const lit = css(mix(wall, [255,255,255], WALL.PIER_LIGHT * (1 - dark * 0.8)));
      const sha = css(mix(wall, [0,0,0], WALL.PIER_SHADOW * (1 - dark * 0.5)));
      for (let c = 0; c < g.cols; c++) {
        const xc = Math.round(c * stepX);       // cell boundary = pier centre
        fillWrap(ctx, xc - dkCol, 2 * dkCol, lit);
        fillWrap(ctx, xc + dkCol, dkCol, sha);
      }
    }

    // A bright reveal reads as a recessed opening in daylight, but after dark a
    // pale grid over every wall turns the city into graph paper — so the frame
    // fades toward the wall as night falls, leaving only the lit panes.
    const frame = mix(wall, [255, 255, 255], 0.22 * (1 - dark * 0.85));
    const sill  = mix(wall, [0, 0, 0], 0.3);
    // Continuous occupancy per (family × bucket) hash — see OCCUPANCY above.
    // `seed` decorrelates the per-pane rolls between families sharing a bucket
    // and between the four rolls each pane makes (lit / tone / bright / hot);
    // the salts are primes far larger than any bucket index so the streams
    // can't collide.
    const occRange = OCCUPANCY[mat] || OCCUPANCY.mh;
    const occRoll = hash01(seed + 4001, 0, 0);
    const occupancy = occRange[0] + (occRange[1] - occRange[0]) * occRoll * occRoll;
    const warmBias = TONE_WARM_BIAS[mat] != null ? TONE_WARM_BIAS[mat] : 1;

    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const x = Math.round(c * stepX + offX), y = Math.round(r * stepY + offY);
        // NO bright rectangle around the opening. A 1 px light frame on all four
        // sides is the single biggest contributor to the "blocky" read — it
        // outlines every window like a cell in a spreadsheet, and no real
        // building has one. Real depth is directional: the head is in shadow,
        // the sill catches light. Head goes on first so the glass covers its
        // inner edge; the sill is drawn after the pane, below.
        ctx.fillStyle = css(mix(wall, [0, 0, 0], 0.30), 0.7 * (1 - dark * 0.6));
        ctx.fillRect(x, y - dkRow, g.w, dkRow);

        const roll = hash01(seed, r, c);
        const isLit = night > 0.05 && roll < occupancy;
        if (isLit) {
          let tone = pickTone(hash01(seed + 1009, r, c) * warmBias);
          const bRoll = hash01(seed + 2003, r, c);
          let bright = PANE_BRIGHT_MIN + (PANE_BRIGHT_MAX - PANE_BRIGHT_MIN) * (1 - bRoll * bRoll);
          if (hash01(seed + 3001, r, c) < HOT_PANE_RATE) {
            tone = mix(tone, [255, 255, 255], HOT_PANE_BOOST);
            bright = PANE_BRIGHT_MAX;
          }
          ctx.fillStyle = css(mix(glass, tone, Math.min(1, night * 1.3) * bright));
        } else {
          ctx.fillStyle = css(glass);
        }
        ctx.fillRect(x, y, g.w, g.h);

        // Reveal: the jamb the opening is recessed behind, on one side only.
        // One-sided because the sun is on one side — a symmetric reveal reads
        // as an outline again, which is what we just removed.
        if (g.w >= 4 * dkCol) {
          ctx.fillStyle = css(mix(glass, [0, 0, 0], 0.35), 0.75);
          ctx.fillRect(x, y, dkCol, g.h);
        }
        // Sill — a lit lip directly under the opening. Sits tight against the
        // pane (was one pixel clear of it, which read as a detached underline).
        ctx.fillStyle = css(sill, 0.6 * (1 - dark * 0.6));
        ctx.fillRect(x - dkRow, y + g.h, g.w + 2 * dkRow, dkRow);
      }
    }
  }

  let _canvas = null, _ctx = null;
  // One draw serves all three tiers — they are the SAME picture at three screen
  // sizes, and only the prefilter differs. Drawing once and blurring three ways
  // is what keeps a three-tier atlas from costing three times the repaint.
  let _rawKey = null, _raw = null;

  /** Draw (fam, bucket, p) once into a RES x RES buffer, mottle applied. */
  function rawTile(fam, bucketIdx, p) {
    // `_zAnchor` is in the key because it changes the DRAWING (row and column
    // counts, mottle cell size, deck band pitch), not just the resampling. It
    // was the one-deep cache that made the first cut of the metre anchor look
    // like it had no effect: the tile was correct and stale.
    const key = fam + '|' + bucketIdx + '|' + p + '|' + _zAnchor;
    if (_rawKey === key) return _raw;
    if (!_canvas) {
      _canvas = document.createElement('canvas');
      _canvas.width = _canvas.height = RES;
      _ctx = _canvas.getContext('2d', { willReadFrequently: true });
    }
    _mottle = null;
    // Everything below draws in 64-unit space; the transform puts it on RES
    // texels. Every rect in this file is on integer 64-space coordinates, so at
    // an integer SCALE they stay pixel-aligned and nothing gains an AA fringe.
    _ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    drawTile(_ctx, fam, bucketIdx, p);
    _ctx.setTransform(1, 0, 0, 1, 0, 0);
    const d = _ctx.getImageData(0, 0, RES, RES).data;
    if (_mottle) {
      // Block-to-block value scatter, one 4-unit cell = ~2 m of wall. Applied
      // over the finished tile so the openings pick it up too, which is right:
      // the glass in a weathered wall is not uniformly clean either.
      const { cells, amp, cellPx } = _mottle;
      const N = TILE / cellPx, C = cellPx * SCALE;
      for (let y = 0; y < RES; y++) {
        const row = ((y / C) | 0) * N;
        for (let x = 0; x < RES; x++) {
          const t = cells[row + ((x / C) | 0)];
          if (!t) continue;
          const k = amp * Math.abs(t), tgt = t < 0 ? 0 : 255, i = (y * RES + x) * 4;
          d[i]     += (tgt - d[i])     * k;
          d[i + 1] += (tgt - d[i + 1]) * k;
          d[i + 2] += (tgt - d[i + 2]) * k;
        }
      }
    }
    _rawKey = key; _raw = d;
    return d;
  }

  /**
   * Box-decimate a RES x RES RGBA buffer by an integer factor.
   *
   * This is the mip level, and a box the width of the decimation is EXACTLY the
   * prefilter that minification wants — which is why the decimated tiers carry
   * no blur of their own. It is also wrap-safe for free: the blocks tile the
   * image exactly, so no sample ever needs a neighbour across the seam, which
   * is the trap `softenTile` has to wrap around.
   */
  function decimate(src, res, div) {
    const out = res / div;
    const d = new Uint8ClampedArray(out * out * 4);
    const area = div * div;
    for (let y = 0; y < out; y++) {
      for (let x = 0; x < out; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < div; j++) {
          const row = (y * div + j) * res;
          for (let i = 0; i < div; i++) {
            const o = (row + x * div + i) * 4;
            r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3];
          }
        }
        const o = (y * out + x) * 4;
        d[o] = r / area; d[o + 1] = g / area; d[o + 2] = b / area; d[o + 3] = a / area;
      }
    }
    return d;
  }

  /** The image for one tier: the shared drawing at that tier's resolution. */
  function tileData(fam, bucketIdx, p, tier) {
    const raw = rawTile(fam, bucketIdx, p);
    const res = tierRes(tier);
    // ours, and softenTile mutates it
    const d = tier.div > 1 ? decimate(raw, RES, tier.div) : new Uint8ClampedArray(raw);
    softenTile(d, fam, tier, res);
    // A VIEW, not `d.buffer.slice(0)`. The buffer was allocated on the line
    // above and nothing else holds it, so the second copy was 300 x 64 KB of
    // memcpy and garbage per time-of-day step for nothing — and MapLibre copies
    // again on its side either way (`addImage` does `new Uint8Array(data)`,
    // `updateImage` does `RGBAImage.replace(data, copy=true)` for a plain
    // object; checked in the 5.24.0 source rather than assumed).
    return { width: res, height: res, data: new Uint8Array(d.buffer) };
  }

  // ── The windows crawl while the camera moves ──────────────────────
  //
  // Reported: "it's glitchy whenever I move... a ton of diagonal lines that go
  // across the window that are lit and not lit", and — the part that names the
  // cause — on Biological Laboratories' north face, far away almost the whole
  // wall crawls, and as the camera closes the NEARER side settles first while
  // the far tenth holds out longest.
  //
  // That is texture minification, not z-fighting. Measured with
  // scripts/verify/shimmer.mjs, which steps the camera in equal increments and
  // counts sign changes in each pixel's luma: real geometry under a monotonic
  // camera move changes monotonically, aliasing oscillates. Stripping
  // fill-extrusion-pattern and painting flat colour instead cut the crawling
  // share roughly in half at every pose (bme-near 6.96% -> 3.41%, waggener-n
  // 9.78% -> 6.06%, and a 0.10 zoom step 40.23% -> 26.17%). The mask PNGs show
  // the flagged pixels lying in the shape of the window grid itself.
  //
  // Two things make it unavoidable at source. MapLibre samples the pattern atlas
  // LINEAR with no mipmaps — atlases cannot be mipmapped without bleeding
  // between images — so there is no filtering as the texture minifies. And the
  // pattern is TILE-locked, so its metres-per-texel HALVES at every integer
  // zoom (measured: 33.0 m at z16, 16.5 at z17, 8.2 at z18), which drags the
  // window pitch through the one-pixel danger zone on the way in.
  //
  // MSAA does not help: it antialiases geometry EDGES, not texture interiors.
  // Measured at 4 samples, the crawl went UP on every pose, because smoothing
  // edges adds small per-frame variation of its own. Depth is 24-bit here, so
  // the file's older "a phone's 16-bit depth buffer" reasoning does not apply
  // to this defect either.
  //
  // What is left is to stop putting energy into the tile at frequencies that
  // cannot survive. This is a wrap-aware low-pass — the poor man's mipmap, done
  // once at generation instead of per sample. RADIUS is in texels and one texel
  // is 0.43-0.65 m of wall at the zooms this app flies, so a radius of 1 is a
  // ~0.5 m soft edge: invisible from a flying camera, and the difference between
  // a window that reads and a window that strobes.
  //
  // Per family, because the need is not uniform. `tg` is the worst by
  // construction — 1.40 px of spandrel and 3.14 px of pier, the only family
  // exempt from MIN_SPANDREL/MIN_PIER via `curtain: true` — and `lo` has big
  // sparse openings that never approach the pixel floor.
  //
  // TASTE KNOB: set any of these to 0 to get the old razor-sharp, strobing tile
  // back for that family. Nothing else has to change.
  // HOW STRONG, measured rather than guessed. Every number below is a shimmer.mjs
  // run, % of pixels crawling, same poses each time:
  //
  //   pose          pattern on   r1/a0.6   HERE     r6/a1.0   pattern OFF
  //   bme-near          6.96       5.84     5.57      3.50        3.41
  //   waggener-n        9.78       8.67     8.15      6.78        6.06
  //   bme-zoom         40.23      38.76    38.72     26.16       26.17
  //
  // Two things to read off that, and the second one matters more than the fix.
  //
  // First, the crawl has a FLOOR — the pattern-off column — and a big enough
  // low-pass reaches it exactly (26.16 against 26.17). So sharpness is the whole
  // lever, and this is a pure sharpness-versus-crawl trade with a known bottom.
  //
  // Second, and honestly: RADIUS is doing the work, not amount, and the radius
  // that gets most of the win is 6 — a 13-texel box, which at z17 is 3.4 m of
  // wall and visibly mushes the windows. The setting below is the strongest one
  // that still reads as punched windows up close, and it only recovers about a
  // third of the available win at translation and almost none at the zoom step.
  // A single fixed tile cannot be both crisp near and quiet far. The complete
  // fix is two tiers switched by zoom — a soft tile on a far layer, the sharp
  // one on a near layer — which is a bigger change than this and is written up
  // in the PR rather than half-done here.
  //
  // The blur is in TEXEL space, which at least biases it the right way: a texel
  // is 0.26 m of wall at z17 and 0.52 m at z16, so it softens hardest at the
  // distances where the crawl is worst and least where you can read a window.
  //
  // WHAT CHANGED, and it is the whole of "windows are super blurred". The
  // numbers above were one setting for every zoom, because there was one tile
  // for every zoom: radius 2 at amount 0.9 is a 5x5 box over a 5x4 window, run
  // on the tile you are looking at from fifty metres as well as the one two
  // kilometres away. The tier chain above splits that. Each tier now carries
  // only the prefilter its OWN minification needs — a box the width of the
  // minification factor, which is what a mip level is — and the FAR tier,
  // which is decimated and then drawn at 1:1 or magnified so it cannot alias
  // from minification at all, carries none (the sentence used to say "near"
  // tier here — backwards; the TIERS block above and `far: soften 0.0` in
  // TIERS agree with this correction, not with the old wording).
  //
  // ── QUEUE shim-lowpass, 2026-08-22: the near tier's OWN radius, raised ──
  //
  // The near tier still crawls, because `tier.soften=0.75` was calibrated for
  // its NOMINAL 2:1 minification (a wall viewed face-on at the top of the
  // near tier's zoom range), and the mechanism doc
  // (docs/shimmer-mechanism.md) measured that real flight geometry pushes
  // minification well past that at oblique pitch/bearing/distance within the
  // SAME tier — crawl climbs from 2.19% to 21.27% across one zoom ladder and
  // from 5.70% to 12.67% across one pitch ladder, all inside the near tier.
  // A fixed radius calibrated for the best case under-filters the worst case;
  // that headroom is what this raises.
  //
  // MEASURED with shimmer.mjs, shots-mech-std.json, translate mode, same
  // poses as the mechanism doc (baseline reproduced fresh rather than
  // trusted): pattern-on / this change / pattern-off floor —
  //
  //   pose          pattern-on   RADIUS below   floor
  //   bme-near         8.57%        4.99%       3.83%   (75% of headroom)
  //   biolab-near      7.28%        6.12%       3.08%   (28% of headroom)
  //   waggener-n       9.96%      (not fully re-measured at these exact
  //                                 per-family values — see commit message)
  //
  // The 4.99/6.12 pair is the UNIFORM r3/a1.0 override
  // (SHIM_SOFTEN=1 SHIM_SOFTEN_R=3), not yet split by family; it is quoted
  // here as the closest measured anchor to what ships below. Recovery is NOT
  // uniform across buildings — bme-near's grid responds much better to a
  // fixed radius than biolab-near's, which is itself evidence that one radius
  // cannot be exactly right everywhere (the real fix is recommendation #1 in
  // docs/shimmer-mechanism.md, a further-split zoom-stepped tier, not owned
  // by this change).
  //
  // r6 (docs/shimmer-mechanism.md's own override, and the OLD investigation's
  // number above) reaches the floor almost exactly but VISUALLY MUSHES the
  // windows up close — confirmed by eye, not inferred: compare
  // shots/shimmer/lowpass/soften-check-current.png,
  // shots/shimmer/lowpass/soften-check-r3.png and
  // shots/shimmer/lowpass/soften-check-r6.png. At r3 the Biomedical
  // Engineering Building and Neural Molecular Science still read as punched
  // windows, softer than today's default; at r6 they read as flat wall. r3 is
  // shipped for exactly that reason — it is the strongest radius this pass
  // could confirm BY EYE still reads as windows at the pose the calibration
  // table above was measured at, not the strongest radius the meter alone
  // would have picked.
  //
  // `tg` (curtain wall) gets LESS of this increase than the other glazed
  // families on purpose, and it is a deliberate reversal of the OLD
  // FAMILY multiplier (which gave tg the LARGEST multiplier, on the theory
  // that the family nearest the pixel floor needs the most help). Geometrically
  // it is the family that can least afford a wide box: its own pier/spandrel
  // gap (3.14 / 1.40 texels, GRIDS.tg) is narrower than a 7-texel r3 kernel,
  // so a box that size does not anti-alias tg's glazing, it erases it. `dk`
  // and `st` are not window grids (bands, piers) and are left conservative for
  // the same reason: no measurement was taken to justify moving them.
  const SOFTEN = {
    // Multiplier on the tier's radius, per family. `lo` has big sparse openings
    // that never approach the pixel floor; `tg` is the one curtain-wall family
    // and lands nearest it (1.40 units of spandrel, 3.14 of pier). Superseded
    // for radius by the explicit RADIUS table below wherever that table sets a
    // number — this multiplier still governs any family RADIUS leaves null.
    // TASTE KNOB: set a family to 0 for the old razor-sharp, strobing tile.
    FAMILY: { lo: 0.5, mr: 1.0, mh: 1.0, tr: 1.0, tg: 1.2, dk: 1.0, st: 0.8 },
    AMOUNT_BASE: 1.0,
    // Per-family OVERRIDES, null meaning "use the tier's own prefilter × the
    // FAMILY multiplier above" (round(0.75 * mult) ≈ 1 texel for every family
    // — see the QUEUE shim-lowpass comment above for why that is too small on
    // the worst-case oblique view within the near tier). They exist as objects
    // keyed by family because scripts/verify/shimmer.mjs sweeps them by name,
    // and that script is how this low-pass is calibrated — breaking its sweep
    // would take the instrument away from the next person who has to argue
    // about this trade. TASTE KNOB: any value here is a one-line override,
    // still readable from the console as window.FACADE_SOFTEN.
    RADIUS: { lo: 3, mr: 3, mh: 3, tr: 3, tg: 2, dk: 2, st: 1 },
    AMOUNT: { lo: 1.0, mr: 1.0, mh: 1.0, tr: 1.0, tg: 0.85, dk: 0.85, st: 0.85 },
  };
  // Exposed so scripts/verify/shimmer.mjs can sweep it, and so an aesthetic call
  // here can be overruled from the console without an edit.
  window.FACADE_SOFTEN = SOFTEN;

  /**
   * The wrap-safe separable box blur itself now lives in
   * js/pattern-lowpass.js (`window.PatternLowpass.blurWrap`), extracted so
   * js/drag.js (and eventually tower.js/moody.js/heroes.js/arts.js/places.js
   * — docs/facade-atlas-map.md §2's six-file table) can band-limit their own
   * atlases with the identical, already-calibrated kernel instead of each
   * carrying its own copy of this math. Nothing below this line changed
   * behaviour — this file still owns 100% of ITS OWN taste (which family
   * gets how much radius, at what tier) — only the wrap+sum+blend kernel
   * moved. Verified unchanged: scripts/verify/shimmer.mjs on the facades
   * poses before/after this extraction landed inside the 0.00pp noise floor
   * docs/shimmer-verdict.md established (see the commit message for the
   * numbers).
   *
   * `res` is the tier's own resolution, NOT RES: a decimated tier is a
   * smaller image and blurring it as if it were RES wide would read straight
   * off the end of the buffer.
   */
  function softenTile(d, fam, tier, res) {
    const mult = SOFTEN.FAMILY[fam] != null ? SOFTEN.FAMILY[fam] : 1;
    const rOv = SOFTEN.RADIUS[fam], aOv = SOFTEN.AMOUNT[fam];
    // The radius is in DRAWING units, so it scales with the tier's own texel
    // density — a 2-texel box on the near tier is a half-texel box on the far
    // one, which is no box at all, and correctly so: that tier is magnified.
    const r = Math.round((rOv != null ? rOv : (tier ? tier.soften : 0) * mult)
                         * SCALE / (tier ? tier.div : 1));
    const a = aOv != null ? aOv : SOFTEN.AMOUNT_BASE;
    window.PatternLowpass.blurWrap(d, res, r, a);
  }

  function parseId(id) { return { fam: id.slice(0, 2), idx: parseInt(id.slice(2), 10) }; }

  // ── the tier chain: selection, registration, repaint ────────────────

  /**
   * The tiers a frame can actually SAMPLE — which is ALL of them, and pretending
   * otherwise is what HANDOFF §46 had to unpick.
   *
   * The camera's zoom does not decide this. Past 60 degrees of pitch MapLibre
   * picks a tile zoom per tile, and the pattern id is evaluated at the TILE's
   * zoom, so one pitched frame reads every tier at once — measured at the spawn
   * pose, `city-buildings` renders z13 through z16 together. §46 kept a
   * camera-derived subset as a LATENCY path and put the rest on a timer; that
   * is no longer worth the machinery, because the decimated tiers now cost
   * 1/4 and 1/16 of the near one instead of a full-resolution blur each. All
   * three in the calling frame is CHEAPER than the two this used to return, and
   * it makes "every tier holds the same hour" true by construction rather than
   * true within 90 ms.
   */
  function activeTiers() {
    return TIERS;
  }

  const suffixed = (base, id) => (id ? ['concat', base, id] : base);

  /**
   * Wrap a base pattern-id expression in the zoom `step` that picks a tier.
   *
   * Exposed rather than inlined because more than one layer names its bucket its
   * own way — the outer ring reads an `fb` ordinal off a vector tile it cannot
   * mutate — and every one of them needs the same stops. Restating the stops per
   * layer is how a tier boundary drifts between two layers and nobody notices.
   *
   * The step is a RESOLUTION choice now and nothing else — every tier draws the
   * same windows at the same world scale — so a tile picking a tier one zoom
   * away from its neighbour changes sharpness and not rhythm. That is what makes
   * per-tile evaluation safe here, and it is the whole of QUEUE H2.
   */
  window.facadeTierExpr = function facadeTierExpr(baseId) {
    const expr = ['step', ['zoom'], suffixed(baseId, TIERS[0].id)];
    for (let i = 1; i < TIERS.length; i++) {
      expr.push(TIERS[i].minZoom, suffixed(baseId, TIERS[i].id));
    }
    return expr;
  };

  /** Every tier's image for one combo, registered if missing. */
  function ensureImages(map, id, p) {
    const { fam, idx } = parseId(id);
    let added = false;
    for (const t of TIERS) {
      const key = id + t.id;
      try {
        if (map.hasImage && map.hasImage(key)) continue;
        map.addImage(key, tileData(fam, idx, p, t), { pixelRatio: tierPixelRatio(t) });
        added = true;
      } catch (e) { /* already added */ }
    }
    return added ? 1 : 0;
  }

  /**
   * ── QUEUE A1/A4: THE ATLAS MUST NOT HOLD TWO DIFFERENT HOURS AT ONCE ──
   *
   * This is where "half the buildings past a certain point switch their windows
   * to night mode, in complete daylight" came from, and the mechanism is exactly
   * as reported: it is TILES, and the quadrant boundaries are tile boundaries.
   *
   * The version of this block that shipped repainted only the tiers
   * `activeTiers(map)` named — the tiers implied by the CAMERA's zoom — and put
   * the rest in a `_stale` set drained on the next `zoom` event. Its own comment
   * defended that as free, "in practice the hour does not change mid-flight".
   *
   * BOTH HALVES OF THAT ARE FALSE, and the second one is why nobody caught it:
   *
   * 1. **A pitched frame is not at one zoom.** Past ~60 degrees of pitch
   *    (`MercatorCoveringTilesDetailsProvider.allowVariableZoom`, and this app
   *    spawns at pitch 74) MapLibre chooses a tile zoom PER TILE by distance
   *    from the camera. Measured at the spawn pose, `getVisibleCoordinates()`
   *    for `city-buildings` returns tiles at z13, 14, 15, 16, 17 and 18 in one
   *    frame. The pattern id is picked by `['step', ['zoom'], ...]`, which
   *    MapLibre evaluates at the TILE's zoom, so a single frame samples every
   *    tier at once — the near field from one tier, the far field from another.
   * 2. **The camera-zoom set can never contain the far tier.** At z16.5,
   *    `activeTiers` returns mid+near. Tier `x` covers every tile at z<16, which
   *    at that camera is 9 of the 14 tiles on screen — and it was NEVER
   *    repainted, at any hour, because the drain only fires when a stale tier
   *    becomes camera-active, i.e. when you fly below z16 entirely.
   *
   * Measured on `main`, spawn pose, mean luma over the 100 registered images of
   * each tier (scratchpad probe, printed in the PR):
   *
   *     after DAY                  near 148.7   mid 148.7   far 153.6
   *     after DAY -> NIGHT         near  63.5   mid  63.5   far 153.6   <- A4
   *     night, out to z14, back,
   *     then DAY                   near 148.7   mid 148.7   far  63.5   <- A1
   *
   * The far tier holds whatever hour it was last dragged to and nothing brings
   * it back. "Fly over a chunk to fix that chunk" is the near tiles arriving;
   * "they go back to being dark after a while" is flying away again.
   *
   * THE RULE NOW: every tier holds the same hour, always — and since the H2 mip
   * change every tier is repainted in the CALLING frame, so there is no window
   * in which it can be false. §46 could not afford that (three full-resolution
   * blurs); a decimated tier costs a quarter and a sixteenth of the near one, so
   * all three together are cheaper than the two the camera-derived set used to
   * paint. The timer below survives as a belt-and-braces path for combos
   * registered after a repaint; `staleTiers()` normally finds nothing.
   */
  const ATLAS = {
    // Milliseconds after a time-of-day change by which every remaining mip tier
    // is brought current. 0 repaints every tier synchronously in the caller.
    // It is a floor, not a debounce: a continuous drag still gets a flush this
    // often, so no amount of dragging can starve the far field.
    FLUSH_MS: 90,

    // The highest zoom the tile drawing is anchored to. Above it the grid stops
    // following the camera and the wall goes back to getting denser, which is
    // the pre-anchor failure — so this is a CEILING ON HOW RIGHT IT CAN BE, not
    // a safety valve, and it is only here because a repeat has to hold at least
    // one row: at 21 a repeat is 1.03 m of wall and a 4 m storey does not fit in
    // it however many times the tile is redrawn. Closing the last two zooms
    // needs a bigger `displaySize`, which needs a bigger IMAGE (pixelRatio is a
    // Uint16 in MapLibre's shader and cannot go below 1), which is an atlas
    // budget question and not a drawing one. Written up in the pass notes.
    MAX_ZOOM_ANCHOR: 22,

    /**
     * ── THE ATLAS TAX: MAPLIBRE NEVER FORGETS AN UPDATED IMAGE ──
     *
     * This is the single largest per-frame cost this app has ever had, it is
     * 100 % waste, and it is invisible from our own source. MEASURED, not
     * reasoned (scratchpad probe, 2026-08-16, cruise sweep, hardware GL):
     *
     *   updatedImages held      patchUpdatedImages   frames in 3 s   ms/frame
     *   385 keys                6,044,885 key scans        26          46.07
     *   0 keys (set emptied)            0 key scans       125           0.28
     *   385 again (2nd rep)     7,192,955 key scans        30          46.79
     *
     * and in all 15,701 of those calls the count of images that ACTUALLY
     * needed patching was ZERO.
     *
     * The mechanism, read out of maplibre-gl 5.24.0:
     *   - `ImageManager.updateImage(id, img)` does `this.updatedImages[id] = true`
     *   - the string `updatedImages` appears exactly three times in the bundle:
     *     that write, the constructor's `updatedImages = {}`, and one read.
     *     **Nothing ever deletes from it.** One repaint marks it for the life
     *     of the page.
     *   - `Tile.prepare(imageManager)` -> `ImageAtlas.patchUpdatedImages`, which
     *     is `for (const n in imageManager.updatedImages)` with two
     *     `getImage(n)` calls in the body — and it runs for EVERY loaded tile
     *     of EVERY source on EVERY render. This app had 592 tiles carrying an
     *     image atlas across 34 sources, so one time-of-day tick bought a
     *     permanent ~232,000 key-iterations and ~465,000 property lookups per
     *     frame, for nothing.
     *   - a tile built AFTER the repaint never needs patching: its atlas is
     *     built in the worker from the current image data at the current
     *     version, so `pos.version === img.version` on arrival. That is why
     *     the "actually patched" column is zero. The mark is only ever needed
     *     by a tile that already existed when the pixels changed.
     *
     * So: leave the mark up long enough for MapLibre to consume it, then take
     * it back down. The authority on "long enough" is not the frame counter —
     * it is `staleImageIds()`, which asks the live tiles themselves whether any
     * of them is still holding an older version. A key is only ever released
     * when NO in-view tile still wants it, which makes this incapable of
     * reintroducing the A1/A4 split-hour atlas above.
     */
    RELEASE: {
      // Master switch. `window.FACADE_ATLAS.RELEASE.on = false` restores stock
      // MapLibre behaviour live, for an A/B.
      on: true,
      // Rendered frames to leave a fresh mark up before the first release
      // attempt. Pure slack: the staleness scan is the real guard, so this
      // only exists so the common case never has to scan twice.
      holdFrames: 1,
      // With the set empty, re-ask the live tiles this often whether any of
      // them has gone stale — which is how a tile returning from MapLibre's
      // out-of-view cache at an older hour gets its repaint. The `data` hook
      // below normally catches that in the same frame; this is the net under
      // it, and it is what bounds the worst case at this many frames.
      rescanFrames: 30,
    },
  };
  window.FACADE_ATLAS = ATLAS;

  // ── the release sweeper ───────────────────────────────────────────────
  // Counters, so this is testable from a verification script rather than by
  // reading the source and believing it.
  const REL = window.__atlasRelease = {
    on: true, frames: 0, releases: 0, released: 0, rescans: 0,
    remarks: 0, staleFound: 0, held: 0, scans: 0, scanMsMax: 0,
    tilesSeen: 0, blankScans: 0, disabled: null,
  };
  let _relMap = null, _relHooked = false, _relHold = 0, _relIdle = 0;

  const imageManagerOf = (map) => {
    try { return (map && map.style && map.style.imageManager) || null; }
    catch (e) { return null; }
  };

  /** A tile, whether it arrived bare or wrapped in a cache entry. */
  function tileOf(v) {
    if (!v || typeof v !== 'object') return null;
    if (v.imageAtlas) return v;
    if (v.value && v.value.imageAtlas) return v.value;
    return null;
  }

  /**
   * Every tile that is IN VIEW — deliberately not the out-of-view cache.
   *
   * MapLibre only calls `Tile.prepare` on tiles it is drawing, so a cached tile
   * is never patched however long the mark is left up. Including them here
   * would find a permanent stale key and pin the mark up forever, i.e. it would
   * silently turn this whole optimisation off. They are handled on the way back
   * in instead, by `noteTile` on the `data` event and by the rescan.
   *
   * Returns the tile count, or -1 if MapLibre's internals are not where this
   * expects them — in which case the caller must fail SAFE (leave the marks
   * alone) rather than guess.
   */
  function eachInViewTile(map, fn) {
    const st = map && map.style;
    const tms = st && (st.tileManagers || st._sourceCaches || st.sourceCaches);
    if (!tms || typeof tms !== 'object') return -1;
    let n = 0;
    // ONE level of unwrapping, because 5.24's `_inViewTiles` is not the dict —
    // it is a small class holding the dict as its single own property. Probed,
    // not assumed: `Object.keys(tm._inViewTiles)` has length 1 and that entry's
    // own keys are the tile-id strings.
    const walk = (store, depth) => {
      if (!store || typeof store !== 'object') return;
      if (typeof store.forEach === 'function' && typeof store.size === 'number') {
        store.forEach(v => { const t = tileOf(v); if (t) { n++; fn(t); } });
        return;
      }
      for (const k in store) {
        const v = store[k];
        const t = tileOf(v);
        if (t) { n++; fn(t); continue; }
        if (depth > 0 && v && typeof v === 'object' && !Array.isArray(v)) walk(v, depth - 1);
      }
    };
    for (const k in tms) {
      const tm = tms[k];
      if (!tm) continue;
      walk(tm._inViewTiles, 1);
      walk(tm._tiles, 1);
    }
    return n;
  }

  /**
   * Image ids some in-view tile is still holding at an older version.
   *
   * Returns `null` when MapLibre's tile store cannot be found at all — the
   * caller must then fail safe. Returns `{ tiles: 0 }` when it can be walked but
   * is empty, which is NOT the same thing: an empty walk proves nothing, so the
   * caller must decline to release rather than release everything. Getting that
   * distinction wrong once already made this "work" by releasing without ever
   * checking a single tile.
   */
  function staleImageIds(map) {
    const im = imageManagerOf(map);
    if (!im || !im.images) return null;
    const t0 = performance.now();
    const seen = Object.create(null);
    const ids = [];
    const check = (pos) => {
      if (!pos) return;
      for (const id in pos) {
        if (seen[id]) continue;
        const img = im.images[id];
        if (img && pos[id].version !== img.version) { seen[id] = 1; ids.push(id); }
      }
    };
    const n = eachInViewTile(map, (t) => {
      const a = t.imageAtlas;
      if (!a) return;
      check(a.patternPositions);
      check(a.iconPositions);
    });
    if (n < 0) return null;
    REL.scans++; REL.tilesSeen = n;
    const ms = performance.now() - t0;
    if (ms > REL.scanMsMax) REL.scanMsMax = +ms.toFixed(2);
    return { tiles: n, ids };
  }

  /** One tile just arrived (or came back). Re-mark only what IT still wants. */
  function noteTile(map, tile) {
    if (!ATLAS.RELEASE.on) return;
    const im = imageManagerOf(map);
    const a = tile && tile.imageAtlas;
    if (!im || !im.images || !a || !im.updatedImages) return;
    let marked = 0;
    const check = (pos) => {
      if (!pos) return;
      for (const id in pos) {
        const img = im.images[id];
        if (img && pos[id].version !== img.version) { im.updatedImages[id] = true; marked++; }
      }
    };
    check(a.patternPositions);
    check(a.iconPositions);
    if (marked) { REL.remarks += marked; _relHold = ATLAS.RELEASE.holdFrames; _relIdle = 0; }
  }

  function releaseTick() {
    const map = _relMap;
    if (!map || !ATLAS.RELEASE.on) return;
    const im = imageManagerOf(map);
    if (!im || !im.updatedImages) return;
    REL.frames++;

    let any = false;
    for (const k in im.updatedImages) { any = true; break; }

    if (any) {
      if (_relHold > 0) { _relHold--; REL.held++; return; }
      const stale = staleImageIds(map);
      // Internals moved: do nothing, forever, and say so once. A wrong guess
      // here shows the city at two different hours at once.
      if (stale === null) {
        ATLAS.RELEASE.on = false; REL.on = false;
        REL.disabled = 'cannot enumerate in-view tiles';
        console.warn('[facades] atlas release disabled: ' + REL.disabled);
        return;
      }
      // Walked, but found nothing to ask. That is not permission to release.
      if (stale.tiles === 0) { REL.blankScans++; return; }
      const before = Object.keys(im.updatedImages).length;
      const keep = Object.create(null);
      for (let i = 0; i < stale.ids.length; i++) keep[stale.ids[i]] = true;
      im.updatedImages = keep;
      REL.releases++;
      REL.released += before - stale.ids.length;
      REL.staleFound += stale.ids.length;
      _relIdle = 0;
      return;
    }

    if (++_relIdle >= ATLAS.RELEASE.rescanFrames) {
      _relIdle = 0;
      REL.rescans++;
      const stale = staleImageIds(map);
      if (stale && stale.ids.length) {
        for (let i = 0; i < stale.ids.length; i++) im.updatedImages[stale.ids[i]] = true;
        REL.staleFound += stale.ids.length;
        REL.remarks += stale.ids.length;
        _relHold = ATLAS.RELEASE.holdFrames;
      }
    }
  }

  function armRelease(map) {
    if (!map) return;
    _relMap = map;
    _relHold = ATLAS.RELEASE.holdFrames;
    if (_relHooked) return;
    _relHooked = true;
    map.on('render', releaseTick);
    // A tile arriving from the out-of-view cache is the ONE case that can be
    // stale, and the event hands us the tile, so no private tile store is
    // needed for the common path.
    map.on('data', (e) => { if (e && e.tile) noteTile(map, e.tile); });
  }

  // `_atlasP` is the hour the atlas has been ASKED for. `_tierP` is the hour
  // each tier's images actually HOLD. A tier whose entry differs is stale, and
  // "stale" is now derived from those two rather than remembered in a set that
  // could be cleared without the pixels changing.
  let _atlasP = 0.5;
  // A tier's entry is the (hour, zoom anchor) its PIXELS hold. The zoom anchor
  // belongs in here for the same reason the hour does: both change what the
  // tile draws, and "stale" has to mean either of them having moved.
  const _tierP = new Map();
  const atlasKey = () => _atlasP + '@' + _zAnchor;
  let _flushTimer = 0;
  let _warnedUpdate = false;

  // What an image's PIXELS currently depend on. Everything drawTile reads that
  // is not the colour bucket: the hour, the grid the zoom anchor resolved to,
  // and the metre-anchored detail scale.
  //
  // WHY IT EXISTS. Crossing an integer zoom now redraws the atlas, and a full
  // repaint measured 237-303 ms here (headless swiftshader, busy machine; the
  // repo's hardware-GL figure for the same work is 80.4 ms). Paid on every
  // crossing that is a hitch on every crossing. But most crossings do not
  // actually change most tiles — past z19 every punched family has already
  // collapsed to one row and one column and `detailK` is at its cap, so z19 to
  // z20 to z21 redraws nothing at all — and `st`/`s?` stadium tiles never
  // depend on the anchor in the first place. So the skip is not an
  // optimisation bolted on: it is the statement that a tile is a function of
  // these three things, and it makes the common crossing free.
  const _imgSig = new Map();
  function drawSig(fam, p) {
    if (fam === 'st' || (fam.length === 2 && fam[0] === 's')) return 'st|' + p;
    if (fam === 'dk') return 'dk|' + p + '|' + detailK();
    const g = gridFor(fam);
    return p + '|' + g.rows + 'x' + g.cols + 'x' + g.w + 'x' + g.h
      + '|' + detailK() + '|' + baseFamOf(fam);
  }
  window.facadeDrawSig = drawSig;
  // The sig covers everything drawTile reads EXCEPT the colour bucket, which is
  // held in `palette` and can be re-elected under us (adoptBaked, a new
  // snapshot, registerFacadeBuckets). Anything that moves the palette or the
  // measured registry has to say so here or a stale tile survives forever.
  window.facadeInvalidateAtlasSig = () => _imgSig.clear();

  // Combos OUTSIDE, tiers INSIDE, so rawTile's one-deep cache actually hits:
  // repainting three tiers costs ONE draw plus three resamples, not three draws.
  function paintTiers(map, tiers, p) {
    if (!tiers.length) return;
    for (const id of combos) {
      const { fam, idx } = parseId(id);
      const sig = drawSig(fam, p);
      for (const tier of tiers) {
        const key = id + tier.id;
        if (_imgSig.get(key) === sig && map.hasImage && map.hasImage(key)) continue;
        try {
          if (map.hasImage && map.hasImage(key)) map.updateImage(key, tileData(fam, idx, p, tier));
          else map.addImage(key, tileData(fam, idx, p, tier), { pixelRatio: tierPixelRatio(tier) });
          _imgSig.set(key, sig);
        } catch (e) {
          // `ImageManager.updateImage` THROWS on a size mismatch and MapLibre's
          // own wrapper only fires an error event, so a silent catch here would
          // freeze the atlas at one hour and look exactly like the bug above.
          // Say it once rather than never.
          if (!_warnedUpdate) {
            _warnedUpdate = true;
            console.warn('[facades] atlas repaint failed on ' + key + ': ' + e.message);
          }
        }
      }
    }
    for (const t of tiers) _tierP.set(t.id, p + '@' + _zAnchor);
    // Every path that repaints images goes through here — updateFacades, the
    // stale-tier flush timer and the zoom watch — so the mark's grace period is
    // set here rather than at each of the three call sites.
    _relHold = ATLAS.RELEASE.holdFrames;
  }

  /** Tiers whose pixels are not at `_atlasP` and `_zAnchor`. */
  function staleTiers() {
    const want = atlasKey();
    return TIERS.filter(t => _tierP.get(t.id) !== want);
  }

  function flushStaleTiers(map) {
    _flushTimer = 0;
    paintTiers(map, staleTiers(), _atlasP);
  }

  function scheduleFlush(map) {
    if (!staleTiers().length) return;
    // FLUSH_MS 0 means "in this call", and it has to mean that even when a
    // timer from an earlier step is still pending — an early return on
    // `_flushTimer` made the knob silently inert, which cost a wrong perf
    // reading before it cost a wrong frame.
    if (!(ATLAS.FLUSH_MS > 0)) {
      if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = 0; }
      flushStaleTiers(map);
      return;
    }
    // A pending timer already flushes to the LATEST `_atlasP`, so leave it be
    // rather than restarting it — that is what makes FLUSH_MS a floor under a
    // continuous drag instead of a debounce that a drag can hold off forever.
    if (_flushTimer) return;
    _flushTimer = setTimeout(() => flushStaleTiers(map), ATLAS.FLUSH_MS);
  }

  // A safety net, not a path anything relies on: updateFacades already paints
  // every tier in its own frame, so this only ever finds work if a combo was
  // registered between two repaints.
  /**
   * The zoom anchor, and the only place it moves.
   *
   * MapLibre scales a *-pattern by `transform.tileZoom`, not by the fractional
   * camera zoom (the block at the top of this file measures that: one repeat is
   * `displaySize * 67551 / 2^tileZoom` metres of wall, the same number for
   * every tile on screen). So the anchor is an INTEGER and it moves only when
   * the camera crosses one — a handful of times in a whole flight, not per
   * frame. `tileZoom` is read off the transform rather than floored here so
   * this cannot drift from what the renderer actually did.
   *
   * Clamped at REF_ZOOM: this may only ever coarsen a wall, never densify it.
   */
  function anchorZoomOf(map) {
    if (!ANCHOR_ON) return REF_ZOOM;
    let tz;
    try { tz = map.transform && map.transform.tileZoom; } catch (e) { tz = undefined; }
    if (!isFinite(tz)) tz = Math.floor(map.getZoom());
    return Math.max(REF_ZOOM, Math.min(ATLAS.MAX_ZOOM_ANCHOR, tz));
  }

  function watchTierZoom(map) {
    if (map.__facadeTierWatch) return;
    map.__facadeTierWatch = true;
    const onZoom = () => {
      if (_zPinned) return;
      const z = anchorZoomOf(map);
      if (z !== _zAnchor) {
        _zAnchor = z;
        _rawKey = null;              // the one-deep draw cache is keyed on it
        // Through the FLUSH_MS floor, not straight to paintTiers: a scroll
        // wheel crosses three or four integer zooms in a second and a repaint
        // per crossing is a hitch per crossing. Same machinery the time-of-day
        // drag already rides.
        scheduleFlush(map);
        return;
      }
      const want = staleTiers();
      if (want.length) paintTiers(map, want, _atlasP);
    };
    map.on('zoom', onZoom);
    onZoom();
  }

  /**
   * Force the anchor, for verification. Returns the zoom actually adopted.
   * scripts/verify/facadegrid.mjs sweeps this rather than flying the camera,
   * because the claim under test is about the TILE the atlas holds and a real
   * flight would drag tile loading, fog and the collision floor into it.
   */
  window.facadeSetZoomAnchor = function facadeSetZoomAnchor(map, z) {
    if (z == null) {                      // release the pin, hand the camera back
      _zPinned = false;
      if (map) { map.fire('zoom'); }
      return _zAnchor;
    }
    _zPinned = true;
    const want = Math.max(REF_ZOOM, Math.min(ATLAS.MAX_ZOOM_ANCHOR, Math.floor(z)));
    if (want !== _zAnchor) {
      _zAnchor = want;
      _rawKey = null;
      if (map) paintTiers(map, TIERS, _atlasP);
    }
    return _zAnchor;
  };

  window.initFacades = function initFacades(map, p) {
    // BEFORE the palette check, on purpose. The release sweeper is a property of
    // MapLibre's image manager, not of this file's palette — ten other modules
    // call `map.updateImage` on their own time-of-day hooks and 130 images are
    // already marked at boot before any facade repaint. A tree with no facade
    // palette would otherwise pay the full scan forever with nothing to show.
    armRelease(map);
    if (!palette.length) return 0;
    // facadeGridAudit had ZERO call sites — the guard written to catch a grid
    // whose arithmetic disagrees with its own `want`, in a file whose comments
    // record shipping exactly that (17.1% written beside a grid computing
    // 34.2%), had never once run. It is pure arithmetic over five constants, so
    // running it at init costs nothing and warns in the console if a future edit
    // pushes a family out of spec.
    try { window.facadeGridAudit(); } catch (e) { /* audit must never break init */ }
    _atlasP = p;
    _tierP.clear();
    // ALL tiers at boot, not just the visible one: the `step` can select a tier
    // the moment the camera moves, and MapLibre paints an unregistered pattern
    // id transparent — a building-shaped hole, which is the failure mode
    // HANDOFF §30 already paid for once.
    for (const id of combos) ensureImages(map, id, p);
    // The SAME key paintTiers writes — hour and zoom anchor. Writing a bare `p`
    // here left every tier permanently stale against `atlasKey()` and put the
    // atlas into a repaint on every zoom event.
    for (const t of TIERS) _tierP.set(t.id, atlasKey());
    watchTierZoom(map);
    armRelease(map);
    return combos.length;
  };

  window.updateFacades = function updateFacades(map, p) {
    if (!palette.length) return;
    _atlasP = p;
    // EVERY tier, in this frame. See the ATLAS block: nothing derived from the
    // camera can name the tiers a pitched frame reads, and the decimated tiers
    // are cheap enough now that there is no reason to try.
    paintTiers(map, activeTiers(), p);
    scheduleFlush(map);
    watchTierZoom(map);
    armRelease(map);
    // The marks this repaint just raised have to survive long enough for
    // MapLibre to consume them — see ATLAS.RELEASE.
    _relHold = ATLAS.RELEASE.holdFrames;
  };

  /**
   * The hour the atlas is holding. Anything registering a NEW combo after
   * `initFacades` must draw it at this hour and not at its own idea of the
   * time, or the atlas ends up holding two hours at once — which is the whole
   * subject of the ATLAS block above.
   */
  window.facadeAtlasHour = () => _atlasP;

  /**
   * Snap the OUTER RING's towers onto patterns that already exist — and only
   * onto those.
   *
   * The outer ring (js/outer.js) is deliberately cheaper than the core: 6,800
   * simplified footprints wearing a flat colour, no atlas, no cap, no shadow.
   * Downtown towers are the one exception, because the skyline silhouette is
   * the whole reason the box reaches south, and a 267 m flat slab reads as a
   * monolith rather than a building.
   *
   * The rule that makes that exception free is here: this NEVER calls addImage.
   * quantiseStadiumFacades may, because twelve stadium walls carrying materials
   * the city palette does not have is worth twelve textures. A hundred downtown
   * towers are not worth a hundred more, and the atlas is a texture upload plus
   * a repaint on every time-of-day tick — the cost is per IMAGE, not per
   * building. So each tower takes the nearest EXISTING (family, bucket) combo,
   * and if the family it wants has no combo at all it borrows another family's
   * at the same bucket. Zero new images, zero new cost per frame.
   *
   * Call after quantiseFacades and after initFacades.
   */
  /**
   * The 114 downtown TOWERS get their own colours; the 7,511 low-rise buildings
   * behind them keep snapping to the campus palette.
   *
   * "downtown - more accurate and more vibrant." The accuracy was already there:
   * every named landmark is present at a curated height. The flatness was this
   * function. It snapped every outer feature to the nearest of the fourteen
   * CAMPUS buckets, which are the means of Austin's campus building colours and
   * are almost all tan brick and limestone — so the Austonian, Frost Bank Tower,
   * the Independent and 111 more arrived downtown wearing the same four or five
   * browns, and the skyline read as one grey-brown mass.
   *
   * It is the same mistake quantiseStadiumFacades already records and refuses to
   * make: "Its OWN palette entries, not the nearest of the city's fourteen...
   * snapping to them turned the 2008 north end zone's brick veneer back into tan
   * and erased the one elevation with a different material."
   *
   * So the towers are clustered on their own baked `wd` instead. Clustered, not
   * one-per-hex: the atlas is repainted per image on every time-of-day step, so
   * 114 new images would be a real cost for no visible gain at skyline distance.
   * TOWER_BUCKETS is the knob — raise it for more variety, lower it for a
   * cheaper atlas.
   *
   * The low-rise ring is deliberately left on the campus palette. It IS mostly
   * the same brick and stucco as campus, it is 66x the feature count, and it is
   * the backdrop rather than the subject.
   */
  const TOWER_BUCKETS = 10;

  /** k-means on RGB, seeded evenly through the sorted-by-luma list. */
  function clusterColours(hexes, k) {
    const pts = hexes.map(hexToRgb);
    if (pts.length <= k) return pts;
    const lum = c => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
    const sorted = [...pts].sort((a, b) => lum(a) - lum(b));
    let cent = Array.from({ length: k }, (_, i) =>
      sorted[Math.floor((i + 0.5) * sorted.length / k)].slice());
    for (let iter = 0; iter < 12; iter++) {
      const sum = cent.map(() => [0, 0, 0, 0]);
      for (const p of pts) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < cent.length; i++) {
          const d = dist2(p, cent[i]);
          if (d < bd) { bd = d; bi = i; }
        }
        sum[bi][0] += p[0]; sum[bi][1] += p[1]; sum[bi][2] += p[2]; sum[bi][3]++;
      }
      cent = cent.map((c, i) => sum[i][3]
        ? [sum[i][0] / sum[i][3], sum[i][1] / sum[i][3], sum[i][2] / sum[i][3]]
        : c);
    }
    return cent;
  }

  const toHex = c => '#' + c.map(v =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

  window.quantiseOuterFacades = function quantiseOuterFacades(features, map) {
    if (!palette.length || !combos.length) return 0;
    // Snapshot the campus bucket count BEFORE any tower entries are appended.
    // The low-rise pass below must not snap a warehouse onto a glass tower's new
    // colour, and must not overwrite the towers it is about to skip.
    const campusBuckets = palette.length;

    // ── towers first, on their own colours ──────────────────────────
    const towers = features.filter(f => f.properties && f.properties.t === 1 && f.properties.wd);
    let towersDone = 0;
    if (towers.length && map) {
      const cent = clusterColours(towers.map(f => f.properties.wd), TOWER_BUCKETS);
      const idxOf = cent.map(c => {
        const i = palette.length;
        const wd = toHex(c);
        // Golden and night are derived the way the bake derives them, so a tower
        // follows the same day->golden->night ramp as everything else rather
        // than sitting at one colour all day.
        palette.push({
          wd,
          wg: toHex(c.map((v, j) => v * (j === 2 ? 0.92 : 1.06))),
          wn: toHex(c.map((v, j) => v * 0.34 + [17, 22, 42][j] * 0.30)),
        });
        return i;
      });
      // The hour the ATLAS holds, not the hour the clock says: a new combo drawn
      // at a different hour from its neighbours is A1 again, one bucket at a
      // time. (These agree in practice — updateFacades sets _atlasP on every
      // time-of-day step — but only one of them is the thing being matched.)
      const p = _atlasP;
      for (const f of towers) {
        const rgb = hexToRgb(f.properties.wd);
        let best = 0, bd = Infinity;
        for (let i = 0; i < cent.length; i++) {
          const d = dist2(rgb, cent[i]);
          if (d < bd) { bd = d; best = i; }
        }
        const idx = idxOf[best];
        const id = 'tg' + String(idx).padStart(2, '0');
        f.properties.wp = id;
        f.properties.wf = 'tg';
        if (combos.indexOf(id) === -1) combos.push(id);
        // initFacades has already run, so a new combo has no image yet and
        // MapLibre would paint the wall transparent.
        ensureImages(map, id, p);
        towersDone++;
      }
    }

    // bucket index -> the combos that exist for it, keyed by family
    const have = new Map();
    for (const id of combos) {
      const { fam, idx } = parseId(id);
      if (!have.has(idx)) have.set(idx, new Map());
      have.get(idx).set(fam, id);
    }
    const buckets = palette.slice(0, campusBuckets).map(k => hexToRgb(k.wd));
    let n = 0;
    for (const f of features) {
      const p = f.properties;
      if (!p || !p.wd) continue;
      if (p.t === 1 && p.wp) continue;   // a tower already has its own colour
      const rgb = hexToRgb(p.wd);
      let best = 0, bestD = Infinity;
      for (let i = 0; i < buckets.length; i++) {
        const d = dist2(rgb, buckets[i]);
        if (d < bestD) { bestD = d; best = i; }
      }
      // Walk outward from the nearest bucket until one has ANY pattern.
      let pick = null;
      for (let step = 0; step < palette.length && !pick; step++) {
        for (const idx of [best - step, best + step]) {
          const fams = have.get(idx);
          if (!fams) continue;
          pick = fams.get('tg') || fams.get('mh') || fams.get('mr') || fams.values().next().value;
          if (pick) break;
        }
      }
      if (!pick) continue;
      p.wp = pick;
      p.wf = pick.slice(0, 2);
      n++;
    }
    return n + towersDone;
  };

  /**
   * Register a SET OF COLOUR BUCKETS that did not come from the campus
   * snapshot, and hand back the pattern id for each one.
   *
   * WHY THIS EXISTS AT ALL. `quantiseFacades` derives the fourteen campus
   * buckets in the BROWSER, from the buildings snapshot, so the palette index a
   * bucket lands on is a property of the session and not of the data. A vector
   * tile cannot be mutated, so a tiled layer cannot carry `wp`. What it CAN
   * carry is an inert ORDINAL — `fb` — baked offline, and this is the other
   * half of that split: the ordinal belongs to the data, the id belongs to the
   * session, and this function is the join. (HANDOFF §30 is the entry about
   * what happens when the two are confused: a baked `wp` names an atlas image
   * nothing registers, and MapLibre paints that wall TRANSPARENT.)
   *
   * WRITTEN FOR MORE THAN ONE CALLER, deliberately. The downtown towers are the
   * first set; the campus bake parked on `acer/facade-bake` is the second, and
   * the ONLY thing it needs from this file is a second call with a different
   * `key`. Keys namespace the result so two callers cannot claim each other's
   * indices, and a repeat call with the same key is idempotent — which matters
   * because a source can be re-added.
   *
   * @param {Map}    map      so the images can be registered on the spot
   * @param {Array}  buckets  [{ wd, wg, wn }] in ordinal order
   * @param {Object} opts     { key, family }  family defaults to 'tg'
   * @returns {Array<string>} pattern ids, indexed the same as `buckets`
   */
  const _registeredSets = new Map();
  window.registerFacadeBuckets = function registerFacadeBuckets(map, buckets, opts) {
    opts = opts || {};
    const key = opts.key || 'anon';
    const fam = opts.family || 'tg';
    if (_registeredSets.has(key)) return _registeredSets.get(key);
    // The campus palette has to exist first: these buckets are APPENDED to it,
    // and appending to an empty palette would hand out index 0, which is the
    // campus default every unclassified wall falls back to.
    if (!palette.length || !Array.isArray(buckets) || !buckets.length) return null;
    const p = _atlasP;                    // the hour the atlas holds — see above
    const ids = buckets.map(b => {
      const idx = palette.length;
      palette.push({ wd: b.wd, wg: b.wg || b.wd, wn: b.wn || b.wd });
      const id = fam + String(idx).padStart(2, '0');
      if (combos.indexOf(id) === -1) combos.push(id);
      // Every tier, or the first zoom that crosses a stop paints a hole.
      ensureImages(map, id, p);
      return id;
    });
    _registeredSets.set(key, ids);
    return ids;
  };

  /** The downtown towers' ten baked buckets. See scripts/bake_outer_facades.py. */
  window.registerOuterTowerBuckets = function registerOuterTowerBuckets(map, buckets) {
    return window.registerFacadeBuckets(map, buckets, { key: 'outer-tower', family: 'tg' });
  };

  // Fall back to a plain fill where a feature somehow has no pattern, then wrap
  // the whole thing in the zoom step that picks a mip tier.
  window.FACADE_PATTERN_EXPR = window.facadeTierExpr(['coalesce', ['get', 'wp'], 'mh00']);
  window.facadePalette = () => palette;

  // ══════════════════════════════════════════════════════════════════
  //  CAMPUS STOREY BANDS — QUEUE Y5, the campus half
  //  data: scripts/bake_campus_storeys.py -> data/campus_storeys.geojson
  //  design: docs/camera/walls-campus.md
  // ══════════════════════════════════════════════════════════════════
  //
  // THIS IS THE ANSWER TO THIS FILE'S OWN HEADER. Everything above draws a
  // SCREEN-locked pattern: one repeat is `displaySize x mpp(floor(cameraZoom))`
  // metres of wall, so at walking height campus is on TIER_CSS 32 == 2.06 m per
  // repeat and family `mh` puts eight window rows in it. A 26 cm storey. No
  // change to a tile can fix that, because the failure is that the tile has no
  // fixed size in metres at all.
  //
  // So the horizontal structure comes from GEOMETRY instead: proud rings baked
  // in metres, which is also the only form that survives Y4 raising ZOOM_MAX
  // (docs/camera/facades-at-two-metres.md's sequencing note — express it as
  // metres of wall or a later zoom change silently undoes it). Same recipe as
  // the Drag's shipped bands (PR #167), different vocabulary per era.
  //
  // WHY IT LIVES IN facades.js AND NOT IN A NEW MODULE. walls-campus.md §5.1
  // proposed `js/storeys.js`. A new module needs a `<script>` tag in BOTH
  // index.html and _harness.html, and those two files are shared with every
  // other lane; this pass does not own them. This block needs nothing from the
  // atlas and nothing in the atlas needs it, so it is self-contained and could
  // be lifted into its own file later by moving it verbatim and adding the two
  // tags. Recorded so the next pass knows it was a lane decision, not a design
  // one.
  //
  // ADDS ZERO PATTERN IMAGES. The atlas budget (2,840 KB / 284 images,
  // updateFacades 80.4 ms) is untouched by construction: these are flat-colour
  // extrusions, which is the whole point — a 0.24 m course showing an arbitrary
  // slice of a 2.06 m tile is the exact trap this file's header is about.
  const CS = {
    on: !/[?&]storeys=0(?:&|$)/.test(location.search),

    // The layer is DEFERRED, the same way js/entrances.js defers its doors
    // (HANDOFF §126/§127): 440 KB raw / 48 KB gzipped is nothing on a wire but
    // it is a main-thread parse, and a storey band is invisible from cruise. So
    // it loads at whichever comes first — the map's first idle plus a delay so
    // the parse does not land in the veil-lift frame, the camera dropping below
    // `altM`, or a ceiling because `idle` provably does not fire on a
    // CPU-throttled machine. Thresholds copied from ENT.defer, which measured
    // them: 60 m is below every pose the app flies on its own and still ~35x
    // eye level, so crossing it can only mean a deliberate descent.
    defer: { on: true, altM: 60, idleDelayMs: 2000, maxWaitMs: 25000 },

    // A METRE-ANCHORED VISIBILITY GATE, not a zoom one. `minZoom` here is a
    // floor under the whole layer and it exists for one reason only: the
    // flyover. It is set from the MEASURED cruise cost (see HANDOFF) rather
    // than guessed, and it is expressed as a zoom because MapLibre's layer
    // property is a zoom — the BANDS themselves are in metres and nothing about
    // their size or position depends on this number.
    minZoom: 15.5,
    opacity: 1.0,
  };
  window.CAMPUS_STOREYS = CS;

  const CS_SRC = 'campus-storeys';
  const CS_LAYER = 'campus-storeys';
  const CS_DATA = 'data/campus_storeys.geojson';

  /** The baked day/golden/night trio, ridden with the rest of the city rather
   * than inventing a second dusk. Same shape as js/drag.js's bakedColor. */
  function csColor(p) {
    p = Math.max(0, Math.min(1, p));
    return ['interpolate', ['linear'], p,
      0, ['to-color', ['get', 'wd'], '#b7a98f'],
      0.5, ['to-color', ['get', 'wg'], '#c6b294'],
      1, ['to-color', ['get', 'wn'], '#23222a'],
    ];
  }

  let _csLoaded = false;

  window.initCampusStoreys = function initCampusStoreys(map) {
    if (!CS.on || _csLoaded || !map || map.getSource(CS_SRC)) return Promise.resolve(0);
    _csLoaded = true;
    const t0 = performance.now();
    return fetch(CS_DATA).then(r => r.json()).then(gj => {
      const p = (window.__todCurrentP != null) ? window.__todCurrentP : 0.3;
      map.addSource(CS_SRC, { type: 'geojson', data: gj,
                              ...(window.PATTERN_TILING || {}) });

      // The anchor must be the first symbol layer AFTER buildings-3d, not the
      // first in the style: the basemap puts symbol layers immediately after
      // `background`, and anchoring there drops the pass under the ground.
      // Learned the expensive way by the stadium; copied from js/drag.js.
      const stack = map.getStyle().layers;
      const after = Math.max(0, stack.findIndex(l => l.id === 'buildings-3d'));
      const anchor = (stack.slice(after + 1).find(l => l.type === 'symbol') || {}).id;

      if (!map.getLayer(CS_LAYER)) {
        map.addLayer({
          id: CS_LAYER, type: 'fill-extrusion', source: CS_SRC,
          minzoom: CS.minZoom,
          filter: ['==', ['get', 'kind'], 'detail'],
          paint: {
            'fill-extrusion-color': csColor(p),
            // `dh`/`dbase`, NOT `h`/`base`. Trim OVERLAPS the wall on purpose —
            // it is a proud ring containing the wall's own face — and `h`/`base`
            // in this repo's band files mean "tiles the building height with no
            // gap and no overlap", which a checker asserts. Different name,
            // different contract. See detail_feature in the bake.
            'fill-extrusion-height': ['get', 'dh'],
            'fill-extrusion-base': ['get', 'dbase'],
            'fill-extrusion-opacity': CS.opacity,
            // OFF, and this is not optional: the gradient darkens the BOTTOM of
            // every extrusion, and a 0.24 m course falls ENTIRELY inside it and
            // goes black. Same call as drag-detail and stadium-wall.
            'fill-extrusion-vertical-gradient': false,
          },
        }, anchor);
      }
      const ms = performance.now() - t0;
      window.__campusStoreys = { features: (gj.features || []).length,
                                 fetchParseMs: +ms.toFixed(1) };
      console.log('[campus-storeys]', (gj.features || []).length,
                  'bands in', ms.toFixed(0) + ' ms');
      return (gj.features || []).length;
    }).catch(e => {
      _csLoaded = false;
      console.warn('[campus-storeys]', e.message, '- pass not drawn');
      return 0;
    });
  };

  window.applyCampusStoreyColors = function applyCampusStoreyColors(map, p) {
    if (!map || !map.getLayer || !map.getLayer(CS_LAYER)) return;
    try { map.setPaintProperty(CS_LAYER, 'fill-extrusion-color', csColor(p)); }
    catch (e) {}
  };

  /**
   * Where the eye is, vertically. Transcribed from js/entrances.js's
   * cameraAltM, INCLUDING its order, which that file learned the hard way: a
   * `move` handler runs synchronously with the transform write while `__fly`
   * copies the pose on its own rAF tick, so inside this very handler `__fly` is
   * one frame stale and a `jumpTo` straight to eye level would read as "high"
   * forever. MapLibre's own value first. Infinity on failure, deliberately — a
   * broken altitude must defer, not fire on every frame.
   */
  function csCameraAltM(map) {
    try {
      const t = map.transform;
      if (t && typeof t.getCameraAltitude === 'function') {
        const a = t.getCameraAltitude();
        if (isFinite(a)) return a;
      }
    } catch (e) {}
    try {
      const a = window.__fly && window.__fly.eye && window.__fly.eye().alt;
      if (isFinite(a)) return a;
    } catch (e) {}
    return Infinity;
  }

  function armCampusStoreys(map) {
    const D = CS.defer;
    const dbg = window.__csDefer = {
      on: !!(CS.on && D.on), altM: D.altM, armedAt: performance.now(),
      trigger: null, firedAt: null,
    };
    if (!CS.on) { dbg.trigger = 'off'; return; }
    if (!D.on) {
      dbg.trigger = 'eager'; dbg.firedAt = performance.now();
      window.initCampusStoreys(map);
      return;
    }
    let fired = false, timer = null;
    const fire = (why) => {
      if (fired) return;
      fired = true;
      map.off('move', onMove);
      if (timer) clearTimeout(timer);
      dbg.trigger = why; dbg.firedAt = performance.now();
      window.initCampusStoreys(map);
    };
    const onMove = () => { if (csCameraAltM(map) < D.altM) fire('alt'); };
    map.on('move', onMove);
    map.once('idle', () => setTimeout(() => fire('idle'), D.idleDelayMs));
    timer = setTimeout(() => fire('timeout'), D.maxWaitMs);
    // A page that STARTS below the threshold — which every eye-level verify
    // pose does, because it jumps the camera before it moves it — must not sit
    // waiting for a move event that will never come.
    onMove();
  }

  // ── bootstrap ─────────────────────────────────────────────────────
  // js/app.js is owned by another pass and calls initFacades, not this. Copied
  // from js/entrances.js's boot, including the GLOBAL flag rather than a
  // property on the wrapper: six passes wrap applyTimeOfDay and whichever boots
  // last owns the outermost closure, so a check written against the wrapper's
  // own property reads false for every pass except that one.
  function csBoot() {
    const map = window.__map;
    if (!map) return setTimeout(csBoot, 60);

    const hookTod = () => {
      if (typeof window.applyTimeOfDay !== 'function' || window.__csTodHooked) return;
      const prev = window.applyTimeOfDay;
      const wrapped = function (m, p) {
        const r = prev.apply(this, arguments);
        try { window.applyCampusStoreyColors(m, p); } catch (e) {}
        return r;
      };
      wrapped.__campusStoreys = true;
      window.applyTimeOfDay = wrapped;
      window.__csTodHooked = true;
    };

    const go = () => {
      // Wait for the core buildings: the anchor search needs `buildings-3d` in
      // the style, and trim standing proud of a wall that does not exist yet is
      // invisible from every angle except straight down.
      if (!map.getLayer('buildings-3d')) return setTimeout(go, 120);
      hookTod();
      armCampusStoreys(map);
    };
    go();
  }
  if (document.readyState === 'complete') csBoot();
  else window.addEventListener('load', csBoot);
})();
