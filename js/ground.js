/**
 * ground.js — the ground plane, made of what is actually there.
 *
 * Before this, everything below the buildings was two flat colours: one green
 * for "park", one tan for "ground". A city read as extrusions pushed up out of
 * a blank sheet — and worse, every footpath in the basemap was deliberately
 * hidden by cleanupBasemap (it keeps only major roads), so the paths people
 * actually walk were switched off. On campus that is most of the ground.
 *
 * This draws data/ground.geojson: real OSM paths, plazas, lawns, water,
 * pitches, tracks and parking, differentiated by what each surface IS. It also
 * takes the ROADS off the basemap — see the roads section below for why they
 * cannot stay there.
 *
 * TRUTH: every POSITION comes from OSM (see scripts/bake_ground.py) or from the
 * basemap's own OSM-derived `transportation` layer. What is generative is FORM
 * — the drawn width of a path OSM does not measure, the colour chosen for a
 * named surface, and the surface noise. No feature here is decorative.
 *
 * Public (window) API:
 *   initGround(map)              — add the source + layers under the buildings
 *   applyGroundColors(map, p)    — retint every surface for time-of-day p
 *   applyGroundSettings(map)     — re-read GROUND after a live edit
 *   GROUND                       — the taste block (below)
 */
(function () {
  'use strict';

  // ── Taste block. Every value here is a one-line override. ───────────
  const GROUND = {
    on: true,
    pathOpacity: 0.92,      // paths are the strongest read; keep them confident
    areaOpacity: 0.95,
    minZoom: 13.5,          // below this the ground is too far to earn the fill
    pathFadeZoom: [14.2, 15.4],   // paths fade in across this zoom range
    widthScale: 1.0,        // multiply every path width (form, not fact)
    // How much the path edge lightens (fake bevel). 0.10 drew a hard white
    // outline round every walk — at flying altitude the stroke is a larger
    // fraction of a 2.4 m sidewalk than of anything else on the ground, so the
    // walks read as pale tape laid on the city rather than as concrete with an
    // edge. Softened, and given its own opacity so the bevel can be quiet
    // without making the kerb thinner (thinner just makes it flicker).
    kerbLight: 0.06,        // how much the path edge lightens (fake bevel)
    // The kerb is a STROKE on the path polygon's boundary, in screen pixels on
    // purpose: a bevel is a highlight along an edge, so it should stay the same
    // apparent thickness whether the path is under the camera or by the horizon.
    // Metres were the right unit for the path itself and the wrong one for this.
    kerbPx: 2.0,
    kerbOpacity: 0.55,      // multiplies the kerb stroke's own opacity
    // How far a footway stands proud of the road it runs beside. A real kerb is
    // 150 mm; drawn at that it is a third of a pixel from flying altitude and
    // does not exist. Set to 0 for a flat painted path.
    pathRaise: 0.22,
    // Steps, terraces and basins from data/depth.geojson. false hands the
    // ground back to being perfectly flat.
    depth: true,

    // ── Roads ─────────────────────────────────────────────────────────
    // Roads now come from data/roads.geojson — real OSM, with a real lane
    // count where OSM has one. See the roads section further down for why the
    // basemap's vector tiles could not carry this pass.
    roads: true,            // false = hand the roads back to the basemap
    // THE CARRIAGEWAY'S WIDTH LIVES IN THE GEOMETRY NOW, like the paths' does.
    // scripts/bake_ground.py buffers each centreline by half its tagged width
    // and ships `k:'roadarea'` polygons, so there is no width knob here any
    // more -- changing how wide a road is drawn means re-running the bake. See
    // the note above addRoadLayers for the measurement that forced it.
    roadCasingDark: 0.38,   // how much darker than the asphalt the kerb reads
    // The kerb is a STROKE on the carriageway polygon's boundary, in screen
    // pixels, for exactly the reason GROUND.kerbPx is: a kerb line is a
    // highlight along an edge, so it should stay the same apparent thickness
    // near the camera and by the horizon. It used to be a second full-width
    // line 1.16x wider drawn underneath, which as geometry would mean a second
    // buffered polygon set for a two-pixel effect.
    roadKerbPx: 2.6,
    // The far-field arterial armature is the one road layer still drawn as a
    // LINE, and this is the ceiling on how wide it may be. Everything in it is
    // at least 3.4 km away (measured off data/roads.geojson against the campus
    // centre) and most of it is 7-15 km, where a real 14 m carriageway is
    // between 3.0 and 0.7 screen pixels. So 3 px is the widest it can honestly
    // be, and pinning it there is what stops it fanning: the width no longer
    // depends on the road's metres, so it cannot grow as the camera pitches
    // over. Polygonising these instead was measured at +185 KB gzipped on a
    // file that is not tiled, to draw roads nobody can reach.
    roadFarMaxPx: 3.0,
    roadMinZoom: 12.6,
    roadServiceFade: [15.2, 16.3],  // alleys arrive only once you are low enough

    // Lane markings, and ONLY where a real road has them: an undivided major
    // gets the yellow centre line, a oneway or divided carriageway gets the
    // white lane divider. Everything below `laneClasses` — every minor street,
    // every alley, every campus walkway — gets nothing.
    lanes: true,
    laneClasses: ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'],
    laneMinZoom: 15.3,
    laneWidthFrac: 0.035,   // of the road width, so dashes stay metre-true
    // OVER-SCALE, DECLARED. A US lane line is 4 in (0.10 m) wide. The camera
    // flies at 200–900 m, where one pixel is ~0.5 m, so a true-scale lane line
    // is a fifth of a pixel and does not exist. laneMinPx holds it at ~1.1 px,
    // i.e. it is drawn about 5x over-scale, and the low opacity below is what
    // keeps that from reading as a kerb.
    laneMinPx: 1.1,
    // In line-width units, so constant in METRES. 1:3 on:off, which is the real
    // US ratio (10 ft line, 30 ft gap). The first pass ran 2.6:3.6 at width
    // 0.055 and opacity 0.6, and six parallel I-35 carriageways came out looking
    // like an airstrip — a lane marking is a hint from 400 m, not a feature.
    laneDash: [2.4, 7.0],
    laneWarm: '#cfae62',    // undivided centre line (US yellow, dulled down)
    laneCool: '#c6c2b6',    // lane divider on a oneway carriageway
    laneOpacity: 0.42,
    laneNightFade: 0.5,     // markings still catch headlights, just dimmer

    // ── Bike lanes ────────────────────────────────────────────────────
    // Drawn ONLY where OSM says a lane physically exists: cycleway /
    // cycleway:left / cycleway:right / cycleway:both in {lane, track,
    // opposite_lane, opposite_track, shoulder}. A `shared_lane` is a sharrow
    // stencilled on a shared travel lane and gets NOTHING; `separate` is mapped
    // as its own way and would otherwise be drawn twice. The rule lives in
    // scripts/bake_ground.py (CYCLE_KIND) and the data carries the verdict.
    //
    // A 6 ft bike lane is 1.8 m, which is 3.6 px at the flying camera's ~0.5 m
    // per pixel. Unlike a lane stripe, this is TRUE SCALE — a bike lane is one
    // of the few road markings large enough to draw honestly from up here.
    bike: true,
    bikeWidth: 1.8,
    bikeMinZoom: 14.4,
    bikeOpacity: 0.95,
    bikeMinPx: 1.0,         // never let it vanish entirely on the way up
    // MEASURED, not assumed. scripts/sample_bike_lane_paint.py sweeps z20 nadir
    // imagery across every tagged lane in the core and scores green paint as
    // (G−R > 5 AND R−B < 12). Result: 301 m of Guadalupe's west-side protected
    // track comes back 37–52% green against a 0–2% carriageway background, and
    // NOTHING else in the modelled area clears 35%. So green is painted on
    // three OSM ways and nowhere else. Painting the network green would have
    // been wrong; painting none of it would have missed the one real one.
    bikeGreenFromData: true,

    // ── Stop bars ─────────────────────────────────────────────────────
    // OVER-SCALE, DECLARED. A real stop bar is 12–24 in (0.3–0.6 m) deep and
    // spans one direction of travel. The LENGTH here is true — half the
    // carriageway, from the data's own width. The DEPTH is drawn at 1.6 m,
    // roughly 3x over-scale, because 0.5 m is one pixel and one pixel of
    // anti-aliased white at 60° of pitch is nothing.
    stopBars: true,
    stopBarDepth: 1.6,
    stopBarMinZoom: 15.4,
    stopBarOpacity: 0.5,
    stopBarColor: '#cdc9bd',

    // ── Speedway Mall ─────────────────────────────────────────────────
    // A 30 ft golden sand-molded brick corridor in a HERRINGBONE bond, laid at
    // 45° to the corridor because it carries emergency vehicles (PWP Landscape
    // Architecture's project record for the Speedway Corridor). The brick
    // colour is sampled off nadir imagery, not guessed — see SURF.brickpave.
    //
    // OVER-SCALE, DECLARED. A paver is 8 x 4 in (0.203 x 0.102 m). Drawn at
    // true scale the whole weave is a tenth of a pixel from the flying camera.
    // The tile below puts 2 herringbone cells across the 9.1 m corridor, which
    // makes a "brick" 1.61 x 0.80 m — 7.9x over-scale — and 1.6 px wide at
    // 400 m. That is the smallest thing that can read at all, and it is what
    // makes Speedway read as laid units rather than as another grey ribbon.
    speedway: true,
    // The corridor is a POLYGON now, so this is a fill-pattern and the tile is
    // its own size on screen rather than being stretched across a line width.
    // 128 px stretched across a 9.1 m corridor put ~2 cells across it; as a
    // free-tiling fill the cell count follows the tile size instead, so this is
    // the knob that sets how big a brick reads. Smaller number = finer weave.
    speedwayTile: 48,       // px of screen, per herringbone tile
    speedwayCells: 2,       // herringbone cells per tile
    speedwayAngle: 45,      // degrees to the corridor axis
    speedwayOpacity: 0.72,
    speedwayNightFade: 0.45,

    // ── The walking surfaces' grain (D6/D7) ───────────────────────────
    //
    // BOTH of these ride ON TOP OF the path deck, and that is the whole point.
    // The herringbone used to be a flat `fill` at z=0 while `ground-paths` is a
    // fill-extrusion standing at `pathRaise`; a fill does not win a depth test
    // against an extrusion above it, so 92% of the weave was painted straight
    // over by the very deck it was meant to decorate (`pathOpacity` 0.92 is the
    // only reason any of it showed at all). Measured by hiding `ground-paths`:
    // the tile was drawing perfectly, all along, underneath. It is the same
    // mechanism §49 found burying the Capitol's walks under a 0.45 m park pad,
    // one layer down and inside this file's own stack.
    //
    // So a pattern that belongs to the deck has to STAND ON the deck. Both
    // layers are fill-extrusions from `pathRaise` to `pathRaise + pathTexLift`,
    // exactly the trick CHANNEL.sheen_m already uses over the water: two tops
    // at the same z is the A2 tie, so lift one and the order is defined instead
    // of undefined.
    pathTexLift: 0.02,      // m the grain stands proud of the deck it sits on
    // Sidewalks had NO texture at all — `ground-texture` filters `k:'area'`, so
    // every lawn and plaza got grain and every walk got a flat fill with a hard
    // bright stroke round it. That is the whole of "sidewalks look like
    // ducttape": not the colour, the absence of any surface at all.
    pathTexture: true,
    // ── Scored concrete, ONE TILE PER DIRECTION (I1) ──────────────────
    //
    // "sidewalks look like bathroom tiles. looks like its all one huge tile
    //  floor and the sidewalks just reveal a portion of that one floor."
    //
    // The old tile was a SQUARE GRID and a fill-pattern is anchored in tile
    // space, so it was one lattice laid over the whole city that every walk
    // cut a window into: two walks that never touch shared joint lines, a
    // walk running north-east wore joints running north and east, and a
    // square cell is what a tiled floor IS. Both halves of that were true and
    // both are gone.
    //
    // What replaced it: bars, not a grid, running ACROSS the direction of
    // travel the way real scored concrete does -- and `fill-extrusion-pattern`
    // picking a pre-rotated tile PER FEATURE off `o`, which
    // scripts/bake_ground.py bakes by cutting the walk area into regions of
    // constant direction. The joints now belong to the path.
    //
    // The angles are integer vectors (a,b) and that is a hard constraint, not
    // a taste value: phase = frac((a*x + b*y) * k / T) is exactly periodic on
    // the tile for ANY integers a,b,k, so the bars close on the tile edge with
    // no seam. Any other angle leaves a phase jump at every tile boundary,
    // which draws its own grid over the city -- the bug being fixed. Must
    // match WALK_ANG in scripts/bake_ground.py, in the same order.
    pathSlabAngles: [[1, 0], [2, 1], [1, 1], [1, 2],
                     [0, 1], [-1, 2], [-1, 1], [-2, 1]],
    // Two parallel walks either side of a street land in the same angle bucket.
    // With one tile per angle their joints would line up across the road, which
    // is the reported defect in miniature, so each walk also draws a variant:
    // the same bars at a different phase and a slightly different pitch.
    // Lengths must match WALK_VARIANTS in scripts/bake_ground.py.
    //
    // TWO, NOT THREE, AND THE REASON IS MEASURED. Every distinct pattern in a
    // data-driven `fill-extrusion-pattern` costs its own draw call per tile.
    // At the campus pose, median frame time went 28.3 ms with this layer hidden
    // -> 28.7 ms with one constant tile -> 34.9 ms with twenty-four. The
    // geometry is 0.4 ms of that and the pattern switching is six. Sixteen
    // tiles put the layer back level with the square grid it replaced (32.4 ms
    // on main) while still breaking the phase between neighbouring walks.
    // A third variant is a one-line edit here plus a re-bake, and it costs
    // about two milliseconds a frame.
    pathSlabPhase: [0.0, 0.45],
    pathSlabPitchVar: [0, 1],   // added to the band count; +1 = finer
    pathSlabTile: 64,       // texels (and css px) per tile
    // OVER-SCALE, DECLARED, like the Speedway brick and the lane markings. A
    // real slab is 1.5 m. A fill-pattern is measured in SCREEN pixels, so at
    // the altitude this app flies a 1.5 m slab is under a pixel and the joints
    // alias into a grey smear. 8 px is about 4 m of ground at z17 -- 2.7x
    // over-scale, against the old grid's 5x, and small enough that a 2.4 m walk
    // shows a joint about every one and a half of its own widths, which is what
    // a walk looks like.
    pathSlabPx: 8,          // screen px between joints, nominal
    pathSlabJoint: 0.11,    // fraction of a slab that is the scored groove
    // The trowelled lip on the far side of the groove. KEEP IT QUIET. A dark
    // line with a bright edge beside it is what a plank looks like, and a field
    // of planks is the next analogy in the series. A scored groove in concrete
    // is a groove: mostly the dark, barely any lip.
    pathSlabShoulder: 0.07,
    pathSlabShoulderLight: 0.035,
    // PANEL TO PANEL VARIATION IS MOST OF WHAT SELLS IT. A poured slab is a
    // separate pour from its neighbour and never quite matches it; a field of
    // identical panels reads as a printed sheet however good the joint is.
    pathSlabPanelVar: 0.075,
    pathTexOpacity: 0.46,
    pathTexNightFade: 0.5,
    // How dark a scored joint reads, 0..1. Lower than the old grid's 0.30 on
    // purpose: bars carry twice the ink of a grid over the same walk, because
    // every joint now crosses the full width instead of half of them running
    // along it, so the same number reads twice as loud.
    pathJointDark: 0.22,

    // ── Texture ───────────────────────────────────────────────────────
    // MEASURED (scripts/verify/pattern-scale.mjs): fill-pattern is anchored in
    // TILE space at the image's native pixel size and resets at every integer
    // zoom — a 32 px tile measured 33.0 m across at z16, 16.5 m at z17 and
    // 8.2 m at z18. So the feature size in metres HALVES every zoom level and
    // snaps back on the way. The only tile that survives that is scale-free
    // noise: anything with a recognisable motif visibly pops at each integer
    // zoom. That is why these tiles are blobs and speckle and nothing else.
    texture: true,
    texTile: 64,            // px => ~66 m at z16, ~33 m at z17, ~16 m at z18
    texOpacity: 0.62,       // master; multiplies every per-class strength
    texStrength: {          // per surface family, 0..1
      grass: 1.0, asphalt: 0.9, water: 0.95, paving: 0.5, canopy: 1.0,
    },
    // ── Waller Creek ──────────────────────────────────────────────────
    //
    // "the creek behind patton and alumni is a very vibrant in depth creek …
    // Hope you will add more detail there and not the bare minimum"
    //
    // The channel is CUT now — real geometry, `k:'bank'` prisms from
    // scripts/bake_ground.py's CHANNEL block, stepping from grade down to a
    // water surface 1.4–3.2 m below it. `channel:false` hands the creek back to
    // being a flat blue-green ribbon with a shadow along its edge.
    //
    // WHY THIS IS ALLOWED TO GO BELOW ZERO, when PR #62 says it cannot: a fill
    // does not depth-test against a fill-extrusion, so a flat lawn drawn over a
    // trench paints into it. The A2 resolver removes the lawn from the trench's
    // footprint entirely — `RANK[('bank','channel')]` is the top of the ladder —
    // so there is no fill over the hole and the extrusion is free to sink.
    channel: true,
    // Culverts and bridges where a street or a walk crosses the creek. `false`
    // hands the crossings back to being cut straight through by the trench.
    decks: true,
    // The blurred line along the water's edge. It used to be the ONLY thing
    // implying depth and carried 0.55; with a real cut section under it that
    // much reads as a smear, so it is turned down to a contact shadow.
    creekBank: true,
    creekBankColor: '#22301f',
    creekBankOpacity: 0.30,
    // THE WATER SURFACE. There has been a water prism in the channel since the
    // cut landed and it still read as "a green stripe", because the colour it
    // was given -- #41604a, luma 88 -- sat SIX LUMA from the `bankshade` two
    // metres away and had the same green hue. Two surfaces that measure the
    // same are one surface. The water is cool now (see BANK_MAT.water) and it
    // carries the ripple tile on its own thin slab, `m:'sheen'` from the bake.
    //
    // false hands the creek back to a flat-coloured water prism with no ripple;
    // the water KEEPS its colour either way, this knob is only the sheen.
    creekSheen: true,
    creekSheenOpacity: 1.0,   // the tile's own alpha peaks at 11%; this scales it
    creekSheenNightKeep: 0.7,

    // ── The creek canopy ──────────────────────────────────────────────
    //
    // "no canopy from flying altitude -- the src:'creek_canopy' hook added in
    // an earlier pass was never consumed."
    //
    // It is consumed here, but NOT the way it was meant to be: the hook was
    // written for shape_trees.py to densify data/trees.geojson over, and this
    // draws crown prisms that scripts/bake_ground.py's CANOPY block bakes into
    // data/ground.geojson instead. The reason is the one thing that makes a
    // canopy legible from 200 m -- it is TEN METRES OFF THE GROUND. Any flat
    // green polygon, at any colour, is a green stripe.
    //
    // Three species, one prism each and NEVER a stack: HANDOFF §35 item 7 is
    // that every tree in this scene is "a stack of flat octagonal discs", and
    // stacking is what makes that. Overlapping single prisms of varied radius
    // and height merge into a mass instead.
    canopy: true,
    canopyBaseFrac: 0.34,   // underside of the foliage, as a fraction of its top
    canopyJitter: 0.10,     // per-crown lightness, as a fraction of its own luma
    canopyOpacity: 1,
    texNightFade: 0.55,     // texture recedes after dark, never vanishes
    texWaterNightKeep: 0.8, // water keeps more of it — still reads as water
    // The catch-all ground under everything OSM does not classify measured 54%
    // of an isolated ground frame — by far the largest flat region in the
    // scene, and the one the "walkway of flour" complaint is really about. Its
    // colour belongs to timeofday.js, which this pass does not own, so it gets
    // its own patterned background layer stacked under ours instead.
    texGround: true,
    texGroundOpacity: 0.5,  // relative to texOpacity
    // 24, not 22 — and NOT 25, which is where QUEUE Z0 comes from. The style
    // spec's ceiling for a layer `maxzoom` is 24; the Y4 half-fix set this to
    // 25, MapLibre failed validation on `addLayer`, and the city-wide
    // `ground-base-texture` layer was therefore NEVER in the style on `main` —
    // every load logged "maxzoom: 25 is greater than the maximum value 24" and
    // then "Cannot style non-existing layer" (HANDOFF §116, QUEUE Z0). 24 is
    // the largest value the spec accepts, and above z24 you are closer than
    // 1.7 m eye height ever gets, so the cap still never binds in practice.
    //
    // Why it is above 22 at all — MEASURED when Y4 raised it:
    //
    //   * `controls.js` clamps the derived zoom at `ZOOM_MAX = 21.5`, which is
    //     BELOW 22 — so this cap has never once bound, and it is not what stops
    //     the camera pitching down. That clamp is, and it is not this file.
    //   * With the controller's writes frozen so a scripted pose survives, the
    //     camera really does reach z23.94 / pitch 60 / 1.70 m of eye height
    //     (MapLibre's own `getCameraAltitude`), so the library is not the
    //     obstacle either.
    //   * At that pose the cap's exact value changed **0 pixels** over the
    //     South Mall, 0 over the East Mall plaza and 14 over a West Campus
    //     street: the base grain is a `background` layer and every one of
    //     those surfaces is a classified polygon drawn on top of it.
    //
    // So the headroom is preparation, not a fix — it removes a cliff that would
    // have appeared the moment `ZOOM_MAX` rises, over the unclassified
    // catch-all ground where the base grain is the ONLY texture. What the
    // ground actually needs at 1.7 m is in HANDOFF §106: the carriageway has no
    // surface texture at all.
    texGroundMaxZoom: 24,

    // ── CLOSE RANGE (QUEUE Y8): the ground at walking height ──────────
    //
    // At 1.7 m the ground plane is 40-55% of every frame and, until this
    // block, it was one flat colour per surface: the far-field grain above
    // reads at 200-900 m and dissolves at 20. These three layers add
    // pedestrian-scale variation — aggregate on the carriageway (HANDOFF
    // §106: it had NO texture at all), tone clumps on the lawns, fine
    // aggregate standing on the walk deck — and they exist ONLY at close
    // range: `closeFadeZoom[0]` is each layer's `minzoom`, so below it they
    // are not drawn at all and the cruise/default frames are byte-identical
    // to a build without them. That gate is a ZOOM by necessity (a layer
    // gate IS a zoom in MapLibre; camera zoom here is derived from eye
    // height, so it is an altitude gate in practice: z18.8 is a camera
    // distance of ~120 m, walking height is D 18-49 m / floor(zoom) 20-21,
    // spawn is z16.5 and the cruise pose z15.3). The TILES themselves are
    // scale-free noise on purpose — fill-pattern halves its metre size every
    // integer zoom (see GROUND.texture), so when Y4 pushes walking height to
    // floor(zoom) 24-25 the grain gets finer but never becomes a countable
    // motif. Nothing else in this file changes below the fade.
    close: true,
    closeFadeZoom: [18.8, 19.8],  // minzoom + fade-in; keep [0] > 17 or the
                                  // flyover pays for a walking-height feature
    closeTile: 96,                // px per close tile (~6.2 m at z20)
    closeStrength: {              // per family, 0..1 — multiplied by the
      grass: 0.55, asphalt: 0.65, paving: 0.45,   // night fade below
    },
    closeNightFade: 0.5,          // same shape as texNightFade
    // The walk-deck aggregate is a prism standing on the scored grain
    // (base = pathRaise + pathTexLift), lifted by this so the depth order
    // against PATH_TEX's top is defined — same trick, one storey up.
    closePathLift: 0.02,

    // Per-feature lightness jitter, as a FRACTION of that surface's own luma,
    // so one number is right at noon and automatically quiet at night. This is
    // what stops 4,900 areas being 14 exact hexes.
    jitter: 0.06,
    pathJitter: 0.03,       // smaller: paths must not lose their separation

    // ── QUEUE J5: the lushness dial ───────────────────────────────────
    // "Make south mall more vibrant and saturated. Lawns like that
    // throughout the project should be more saturated." HANDOFF §70 did
    // the data half (LAWN_TONE in bake_ground.py moved the mown panels to
    // `turf`, the deepest green SURF had) and asked this file for the
    // control he actually described: a saturation multiplier over the
    // green band. This is that dial — applied in paletteAt(), scaled by
    // (1 − nightAmt) so the NIGHT table is untouched at p=1: the night
    // fades exist because lawns used to glow after dark, and this knob
    // must not be able to bring that back (checked at p=0.92).
    //
    // `lushSat` is the master: 1.0 turns the whole pass off. `lushLight`
    // rides along slightly BELOW 1 — an irrigated lawn is deeper, not
    // brighter, and saturation alone drifts toward neon. Both defaults
    // were chosen by eye against shots/f/lawns/ A-B frames.
    // `lushWeight` is per-class because the greens are NOT one band: the
    // creek corridor's three planting zones separate BY colour (scrub is
    // dry and grey ON PURPOSE — see SURF's own comments), so the mown
    // surfaces get the full dial and the creek zones a fraction, keeping
    // their luma/saturation order intact. A class not named here is never
    // touched.
    lushSat: 1.45,
    lushLight: 0.97,
    lushWeight: {
      turf: 1.0, grass: 1.0, gardenlawn: 1.0,   // the mown lawns he named
      understorey: 0.5, wood: 0.5,              // the creek keeps its depth
      scrub: 0.25,                              // dry on purpose — barely moves
    },
  };
  window.GROUND = GROUND;

  const SRC = 'city-ground', RSRC = 'city-roads', DSRC = 'city-depth';
  const AREA = 'ground-areas', TEX = 'ground-texture', BASE_TEX = 'ground-base-texture';
  const BANK = 'ground-creek-bank';
  const ROAD_CASE = 'ground-road-casing', ROAD = 'ground-road', LANE = 'ground-road-lane';
  const ROAD_FAR = 'ground-road-far';
  const BIKE_L = 'ground-bike-left', BIKE_R = 'ground-bike-right';
  const CYCLE = 'ground-cycleway', STOPBAR = 'ground-stopbar';
  const PATH_CASE = 'ground-paths-casing', PATH = 'ground-paths';
  const SPEEDWAY = 'ground-speedway-brick';
  const PATH_TEX = 'ground-paths-texture';
  const CLOSE_ROAD = 'ground-close-road-grain';
  const CLOSE_AREA = 'ground-close-area-grain';
  const CLOSE_PATH = 'ground-close-path-grain';
  const DEPTH = 'ground-depth', CHANNEL = 'ground-channel';
  const DECKL = 'ground-deck';
  const SHEEN = 'ground-creek-sheen', CANOPY = 'ground-creek-canopy';

  // `source-layer` for the road layers, or {} on the GeoJSON fallback. MODULE
  // SCOPE on purpose: the source is added in one function and the six layers
  // that read it are built in another (addRoadLayers, plus one inside a loop).
  // Declaring this next to addSource put it out of scope at the layer calls,
  // which threw `roadLP is not defined` and took the ENTIRE ground stage with
  // it — paths and the speedway brick vanished too. The aerial shot still
  // looked like a city, which is exactly why that trap is worth a comment.
  let roadLP = {};
  const TEX_IMG = { grass: 'gnd-tex-grass', asphalt: 'gnd-tex-asphalt',
                    water: 'gnd-tex-water', paving: 'gnd-tex-paving',
                    canopy: 'gnd-tex-canopy' };
  const HERRING_IMG = 'gnd-tex-herringbone';
  // The close-range tiles. Water and canopy families get NOTHING here: the
  // creek already carries its sheen slab and a canopy is overhead, not
  // underfoot.
  const CLOSE_IMG = { grass: 'gnd-close-grass', asphalt: 'gnd-close-asphalt',
                      paving: 'gnd-close-paving' };
  // One image per (angle, variant). `o` on a k:'pathslab' feature indexes this
  // list directly: o = angle * pathSlabPhase.length + variant, which is the
  // same arithmetic scripts/bake_ground.py does when it emits the feature.
  const WALK_IMG = o => 'gnd-tex-walk-' + o;
  const walkImgCount = () =>
    GROUND.pathSlabAngles.length * GROUND.pathSlabPhase.length;

  // ── band-limit: this atlas had NONE until now (QUEUE Z1's g-blur candidate) ──
  //
  // docs/ground-pattern-map.md is the read-only pass this is built from — same
  // shared kernel (`PatternLowpass.blurWrap`, js/pattern-lowpass.js) the other
  // six files already carry, same SOFTEN-shaped contract as js/drag.js's
  // DRAG_SOFTEN, hooked at the one line each of the four draw functions
  // already has in common: `getImageData` then `return` (map §6).
  //
  // RE-JUDGED 2026-08-22 (docs/ground-rejudge.md): this table was built and
  // measured on `acer/g-blur`, refused as "0.00pp at every radius" and parked
  // — but that verdict was taken at a `street-drag` pose with the camera
  // buried inside a surface (see `docs/pose-audit.md`). Re-measured at the
  // corrected pose it is NOT a no-op: 3.33% -> 2.99% whole-frame crawl
  // (-0.34pp, repeatable byte-identical across two runs — the instrument is
  // deterministic here, so that is the whole noise floor). Ported in as the
  // shipped default. The eye check below was re-run against the corrected
  // pose too, not just inherited from the parked branch.
  //
  // WHY THIS FILE IS DIFFERENT, AND WHY IT MIGHT NOT WORK. Every other atlas
  // paints a roughly vertical wall that can be face-on to the camera.
  // `fill-pattern`/`fill-extrusion-pattern` on a flat z=0 ground plane has no
  // face-on case — confirmed against the v5.24.0 vertex shader
  // (ground-pattern-map.md §5): a wall's `fill_extrusion_pattern.vertex.glsl`
  // carries an elevation term, the ground's `fill_pattern.vertex.glsl` does
  // not, so minification is driven purely by view obliquity, which at this
  // app's pitch ceiling is severe and HIGHLY ANISOTROPIC (compressed hard
  // along the view direction, barely across it). `blurWrap` is an ISOTROPIC
  // box blur — same radius both axes, no directional parameter exists in its
  // signature. A radius that band-limits the compressed axis may over-soften
  // the other one. See shots/q/ground/ for the eye check (Speedway herringbone
  // before/after, the highest-risk surface by this file's own words) and
  // docs/ground-rejudge.md for the measured crawl% this table actually bought.
  //
  // Per-family, not uniform — the ranking IS the priority order
  // (ground-pattern-map.md §7): the close-range tiles are the densest,
  // highest-frequency, scale-free noise in the file (its own header calls it
  // that on purpose) and the least likely to be damaged by a blur; the
  // far-field tiles are lower duty-cycle but live at every altitude; the
  // Speedway brick's own comment says its finest feature is ALREADY at the
  // Nyquist floor by design, so it gets the smallest radius and a partial
  // blend rather than the shared default, to avoid erasing the motif the
  // taste block spent its own words defending (§4's herringbone quote); the
  // scored-walk bars already run a 3x3 supersample of their own (drawScoredBars
  // above) so blurWrap here is a SECOND smoothing pass, not a replacement —
  // scaled down for the same reason.
  // TASTE KNOB: any value here is a one-line edit, readable from the console
  // as window.GROUND_SOFTEN, same contract as window.DRAG_SOFTEN.
  const GROUND_SOFTEN = {
    RADIUS: {
      grass: 3, asphalt: 3, water: 2, paving: 3, canopy: 3,     // TEX (far-field)
      closeGrass: 3, closeAsphalt: 3, closePaving: 3,           // CLOSE (walking-height)
      herringbone: 1,                                            // Speedway brick — floor already spent
      walk: 1,                                                   // scored-bar joints — already supersampled once
    },
    AMOUNT: {
      grass: 1.0, asphalt: 1.0, water: 0.8, paving: 1.0, canopy: 1.0,
      closeGrass: 1.0, closeAsphalt: 1.0, closePaving: 1.0,
      herringbone: 0.5,
      walk: 0.5,
    },
  };
  window.GROUND_SOFTEN = GROUND_SOFTEN;

  // ── Surface palettes, per hour ──────────────────────────────────────
  // Chosen against the protected palette: terracotta roofs over tan/olive
  // walls. So ground brick is browner and darker than any roof, and limestone
  // stays cooler than the wall tan — the buildings must still win the frame.
  const SURF = {
    // Paths must sit LIGHT on the mid-grey `ground` in timeofday.js and dark
    // where they are asphalt. Target ≥40 luma of separation from the ground —
    // the first attempt had 3.5 and the whole path network was invisible even
    // though it was rendering correctly (proved with a magenta pass).
    //
    // `asphalt` carries a second job now: it is the road surface as well as the
    // parking lots, because the roads moved off the basemap and onto this
    // palette. It went darker and COOLER than any pedestrian tone here — the
    // measured gap between a road and a footpath was 6.2 luma by day and 0.4
    // luma at night, which is why a six-lane arterial and a 2 m walkway were
    // the same object. Keep asphalt at least 60 luma below `concrete`.
    //
    // The five entries after `endzone` are this pass's:
    //
    // `roadconcrete` — a concrete CARRIAGEWAY, which is a real thing here: East
    //   MLK is tagged surface=concrete for most of its length. It sits between
    //   asphalt and a footpath, never near either.
    // `brickpave`    — Speedway Mall. SAMPLED, not chosen: nadir imagery over
    //   the corridor gives sunlit brick rgb(200,176,142), a chroma ratio of
    //   1 : 0.880 : 0.710, against an asphalt control of 1 : 0.96 : 0.85 in the
    //   same frame. That ratio is what is reproduced here; the lightness is
    //   raised to the palette's own pale-paving band, because this palette is
    //   stylised and the aerial is hazy. scripts/sample_speedway_colour.py.
    // `bikelane` / `biketrack` — a painted lane and a protected track. Both are
    //   asphalt, lifted slightly: a bike lane sits outside the wheel tracks so
    //   it never gets the polish, and that IS how it reads from above.
    // `bikegreen`    — MEASURED off the Guadalupe protected lane, rgb(158,168,151)
    //   in the aerial, scaled by the 0.73 the palette applies to that image's
    //   asphalt so it lands in the same relationship here. Used on 301 m of one
    //   street and nowhere else — see GROUND.bikeGreenFromData.
    day: {
      limestone:'#efe6cf', concrete:'#dfd9cb', paving:'#e6ddc9', brick:'#9a6249',
      asphalt:'#5e6165', gravel:'#c9bfa9', dirt:'#a28b6c', sand:'#e2d2ab',
      grass:'#8fa869', turf:'#4f7a3c', wood:'#5d7a48', water:'#8fbccd',
      // Waller Creek is a shaded, tree-covered channel, not open lake. Same
      // reason the endzone is not pavement: one `water` class was painting a 7 m
      // wooded creek and 600 m of Lady Bird Lake the same pale blue.
      // A pond keeps still-water blue but loses the lake's brightness.
      creek:'#4f6b52', pond:'#7fa8bb',
      // The riparian corridor is THREE zones, not one green. Understorey sits
      // between the lawn and the closed canopy: lighter and yellower than the
      // wood because it is scrub and young growth catching the light, darker
      // than the mown grass because it is never cut. If these three ever read
      // as one colour the whole creek pass is back to being a band of paint.
      understorey:'#6e8a4d',
      // SCRUB, and it used to be `grass`. The creek's three planting zones were
      // scrub / understorey / canopy, and the widest of them -- the one right
      // beside the water, the one you look at -- was painted with the mown lawn
      // colour AND given the mown lawn's texture tile. Two of the three "zones"
      // were therefore one zone. Creekside scrub in Austin is dry, mixed and
      // never cut, so it is yellower, greyer and 19 luma below the lawn (133
      // against 152), and it wears the canopy grain, not the lawn's speckle.
      scrub:'#8d9455',
      // A PLANTING BED, which is the one thing a garden has that a lawn does
      // not. Read off what a bed actually is from the air: dark hardwood mulch
      // with foliage over it, so it is browner and lower in value than any
      // grass here -- if it drifts toward `grass` the whole pass is invisible,
      // and if it goes too dark the bed reads as a HOLE in the lawn, which is
      // what the first cut at #4a442e did (67 luma against grass's 158, a 90
      // luma gap). 100 against 158 is the separation that reads as planting.
      bed:'#6f5f3d', gardenlawn:'#7d9c5c',
      track:'#a8503c', endzone:'#bf5700',
      roadconcrete:'#7c7d78', brickpave:'#e9cca4',
      bikelane:'#6d7075', biketrack:'#7a7d80', bikegreen:'#737b6e',
    },
    // GOLDEN HOUR, RETUNED — and it was carrying two reported defects at once.
    //
    // "concrete area right in front of tower renders too bright on default
    // sunset" and "looks like speedway got slimed out somewhere in between" are
    // the SAME four numbers. The old golden band did not go to dusk: it sat
    // within 4 luma of the midday band while every other surface in the scene
    // darkened, so the paved forecourt became the brightest object in a dusk
    // frame — brighter than the sunlit roofs. And it converged:
    //
    //                       brickpave vs concrete
    //     day       #e9cca4 vs #dfd9cb   sum|dRGB| 62   dLuma  -9.1
    //     golden    #eec69b vs #e3cba6   sum|dRGB| 27   dLuma  -0.9   <- gone
    //     now       #dda070 vs #cfb692   sum|dRGB| 70   dLuma -12.5
    //
    // 0.9 luma is not a colour difference, it is the same brightness with a
    // hint of hue, and at 400 m through haze it is nothing. Speedway was never
    // deleted — it was drawn, at 6,132 m2, in a tone the concrete it runs
    // through had risen to meet. Photographed at the identical pose it is a
    // confident ribbon at tod 0.30 and a smear at 0.62.
    //
    // So: the whole pale-paving band comes DOWN (a low sun is warm and it is
    // also LESS light), and the brick keeps its own separation by going warmer
    // rather than by staying bright. Sunset is where he leaves the slider, so
    // this band is the one that has to be right.
    golden: {
      limestone:'#e6cfa4', concrete:'#cfb692', paving:'#d4b992', brick:'#8f5439',
      asphalt:'#655d5a', gravel:'#c0a37e', dirt:'#a37f5b', sand:'#d9ba8a',
      grass:'#8a9457', turf:'#4a6b36', wood:'#5a6a3c', water:'#c9a184',
      creek:'#5c6b4c', pond:'#b0947f', understorey:'#6b7f42', scrub:'#8a8b4e',
      bed:'#75603a', gardenlawn:'#788b4c',
      track:'#a5482f', endzone:'#b04e00',
      roadconcrete:'#7e766d', brickpave:'#dda070',
      bikelane:'#75706c', biketrack:'#827c76', bikegreen:'#7a7a66',
    },
    night: {
      limestone:'#1b1e28', concrete:'#181b24', paving:'#1a1d26',
      brick:'#1d1720', asphalt:'#0d1017', gravel:'#1b1a22', dirt:'#191620',
      sand:'#201d26', grass:'#111a14', turf:'#0d1710', wood:'#0c130f',
      water:'#070f1e', creek:'#080f0c', pond:'#060d18',
      understorey:'#0e1510', scrub:'#131610', bed:'#12100e', gardenlawn:'#0f1712',
      track:'#1d1418', endzone:'#2a1608',
      // Night collapses every ground tone toward the same blue-grey, which is
      // true to life, but the brick was landing 4.2 luma ABOVE the concrete and
      // 19 sum|dRGB| from it — i.e. Speedway disappeared after dark as well as
      // at sunset, just less obviously. Warmed so the corridor stays findable
      // at 34 luma against concrete's 27 without becoming a lit surface.
      roadconcrete:'#14161c', brickpave:'#2a2019',
      bikelane:'#12151d', biketrack:'#171a23', bikegreen:'#131a15',
    },
  };
  const KEYS = Object.keys(SURF.day);

  // Which noise tile each surface wears. Everything paved that is not asphalt
  // shares the aggregate speckle; anything unmapped falls through to it too.
  // An endzone is painted TURF, not pavement — it belongs with the grass, and
  // wearing the asphalt speckle was visibly wrong on the practice fields.
  //
  // `wood` and `understorey` get their OWN tile rather than the lawn's. A mown
  // lawn and a closed riparian canopy are not the same texture at any distance:
  // the lawn is fine even speckle, a canopy is crown-sized lumps with shadow
  // between them. Sharing the grass tile is what made the creek corridor read
  // as "green paint" from the air — the colour was different and the grain was
  // not, so the eye merged them.
  const TEX_FAMILY = {
    grass: 'grass', turf: 'grass', endzone: 'grass', gardenlawn: 'grass',
    // `scrub` takes the CANOPY grain rather than the lawn's, and that is the
    // half of its separation that survives distance. §34's own lesson: the
    // colour was already different from grass and the grain was not, so at
    // altitude the eye merged them and the corridor read as paint.
    wood: 'canopy', understorey: 'canopy', scrub: 'canopy', bed: 'canopy',
    asphalt: 'asphalt', track: 'asphalt',
    roadconcrete: 'asphalt', bikelane: 'asphalt', biketrack: 'asphalt',
    bikegreen: 'asphalt', brickpave: 'paving',
    water: 'water', creek: 'water', pond: 'water',
  };

  // ── colour helpers (same convention as timeofday.js) ────────────────
  const hex2rgb = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const rgb2hex = (r,g,b) => '#' + [r,g,b].map(v =>
    Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
  function lerpHex(a, b, t) {
    const A = hex2rgb(a), B = hex2rgb(b);
    return rgb2hex(A[0]+(B[0]-A[0])*t, A[1]+(B[1]-A[1])*t, A[2]+(B[2]-A[2])*t);
  }
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const luma = c => 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2];

  /** The palette at hour p, blended day→golden→night like every other colour. */
  function paletteAt(p) {
    p = clamp01(p);
    const a = p <= 0.5 ? SURF.day : SURF.golden;
    const b = p <= 0.5 ? SURF.golden : SURF.night;
    const t = p <= 0.5 ? p / 0.5 : (p - 0.5) / 0.5;
    const out = {};
    for (const k of KEYS) out[k] = lerpHex(a[k], b[k], t);
    // QUEUE J5: the lush dial rides the same blend — full strength through
    // day and golden, fading to zero exactly as the night table takes over,
    // so a saturated lawn cannot glow after dark. One hook here covers every
    // consumer (initial build and applyGroundColors both read paletteAt).
    const lw = 1 - nightAmt(p);
    if (lw > 0 && GROUND.lushWeight) {
      for (const k in GROUND.lushWeight) {
        if (out[k]) out[k] = lushify(out[k], GROUND.lushWeight[k] * lw);
      }
    }
    return out;
  }
  /** How far into night we are — the same second half of the palette blend. */
  const nightAmt = p => clamp01((clamp01(p) - 0.5) / 0.5);

  // ── QUEUE J5: saturation over the green band (see GROUND.lushSat) ───
  /** hex → [h 0..360, s 0..1, l 0..1]. Only the lush dial reads these. */
  function hex2hsl(hex) {
    const [r, g, b] = hex2rgb(hex).map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn;
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h;
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hsl2hex(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, pp = 2 * l - q;
    const f = t => {
      t = ((t % 1) + 1) % 1;
      if (t < 1 / 6) return pp + (q - pp) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return pp + (q - pp) * (2 / 3 - t) * 6;
      return pp;
    };
    return rgb2hex(f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255);
  }
  /** Push one green toward lush by w of the dial — w=0 is an exact no-op. */
  function lushify(hex, w) {
    const sat = 1 + (GROUND.lushSat - 1) * w;
    const light = 1 + (GROUND.lushLight - 1) * w;
    if (sat === 1 && light === 1) return hex;
    const [h, s, l] = hex2hsl(hex);
    return hsl2hex(h, clamp01(s * sat), clamp01(l * light));
  }

  /** ['match', ['get','s'], 'grass', '#..', …, fallback] */
  function matchExpr(pal, tweak) {
    const e = ['match', ['get', 's']];
    for (const k of KEYS) e.push(k, tweak ? tweak(pal[k]) : pal[k]);
    e.push(tweak ? tweak(pal.concrete) : pal.concrete);
    return e;
  }

  /** Lighten a hex by t toward white — used for the path kerb highlight. */
  function lighten(h, t) {
    const c = hex2rgb(h);
    return rgb2hex(c[0]+(255-c[0])*t, c[1]+(255-c[1])*t, c[2]+(255-c[2])*t);
  }
  /** Darken a hex by t toward black — the road kerb. */
  function darken(h, t) {
    const c = hex2rgb(h);
    return rgb2hex(c[0]*(1-t), c[1]*(1-t), c[2]*(1-t));
  }
  /**
   * Shift a colour along its own luma by `frac` of that luma, hue intact.
   * Expressing the jitter as a fraction rather than an absolute step is what
   * makes ONE number correct at every hour: ±6% of a 217-luma daytime path is
   * ±13, and ±6% of the same path at night (luma 27) is ±1.6 — loud where the
   * eye can see it, silent where it would just look like noise.
   */
  function shiftLuma(h, frac) {
    const c = hex2rgb(h), d = luma(c) * frac;
    return rgb2hex(c[0]+d, c[1]+d, c[2]+d);
  }

  /**
   * Feature id → [0,1). `generateId` on the source hands every feature a stable
   * integer; ×2654435761 mod 1024 is a bijection whose step (433) is coprime
   * with 1024, so neighbouring ids land far apart and two adjacent lawns never
   * come out the same shade. Features with no id (there should be none) fall
   * back to 0, which is simply the low end of the jitter.
   */
  const hash01 = () => ['/', ['%', ['*', ['to-number', ['id'], 0], 2654435761], 1024], 1024];

  /** matchExpr, but every feature sits somewhere in a ±amp band of its colour. */
  function jitterExpr(pal, amp, tweak) {
    const base = c => (tweak ? tweak(c) : c);
    if (!amp) return matchExpr(pal, base);
    return ['interpolate', ['linear'], hash01(),
      0, matchExpr(pal, c => shiftLuma(base(c), -amp)),
      1, matchExpr(pal, c => shiftLuma(base(c), +amp))];
  }

  // Metres of ground → screen px. MapLibre uses 512 px tiles, so one pixel is
  // 78271.517·cos(lat)/2^zoom metres; at Austin's latitude that is 67546/2^zoom.
  // Width in px is therefore w·2^zoom/67546, which is exactly a base-2
  // exponential in zoom — so two stops describe it perfectly.
  //
  // AND IT IS ONLY EVER RIGHT AT THE MAP CENTRE, which is the whole of A2: it
  // is derived from the centre-scale relation, and under perspective the rest
  // of the frame is at a different scale. Everything still using it below is
  // something that is deliberately NOT metre-true — a marking held at a
  // pixel floor, or the far armature under a pixel ceiling. The surfaces
  // (paths, carriageways, cycleways) carry their width in the geometry.
  //
  // The generic `widthExpr(scale)` that used to live here went with the last
  // line layer that wanted it. It was dead code for one commit and dead code
  // is how js/ground.js ended up shipping a whole creek-bank layer that had
  // never drawn a pixel (HANDOFF §46).
  const PX_AT = z => Math.pow(2, z) / 67546;

  // ── Roads ───────────────────────────────────────────────────────────
  //
  // Roads were the Liberty basemap's own `transportation` lines, kept by
  // cleanupBasemap and painted from the `road`/`roadCasing` entries in
  // timeofday.js — a pale warm cream, ONE width for every class. Measured, that
  // put a six-lane arterial 6.2 luma from a 2 m campus footpath by day and 0.4
  // luma from it at night. They were the same object. The previous pass fixed
  // the TONE by taking those layers over and redrawing them off the same vector
  // tiles with a width per OpenMapTiles `class`.
  //
  // This pass takes the DATA over too, because the tiles cannot carry the rest
  // of the job. The `transportation` source-layer holds `class`, `subclass`,
  // `oneway`, `ramp` and `brunnel`, and that is all. It has:
  //
  //   no `lanes`      -> every width was a guess per class, so a 2-lane
  //                      San Jacinto and a 5-lane MLK were both "secondary"
  //   no cycleway tag -> a bike lane could not exist even in principle
  //   no `name`       -> Speedway could not be told from anything
  //   no `surface`    -> East MLK's concrete carriageway could not be drawn
  //
  // So the geometry now comes from data/roads.geojson (scripts/fetch_roads.py
  // -> scripts/bake_ground.py), baked over the OUTER-RING bbox, which is about
  // what the camera can see from 900 m. The basemap's road lines stay hidden.
  // Set GROUND.roads = false to hand them straight back.
  let _hiddenBasemapRoads = [];

  const ROAD_FILTER = ['==', ['get', 'k'], 'road'];
  const CYCLE_FILTER = ['==', ['get', 'k'], 'cycle'];
  const STOPBAR_FILTER = ['==', ['get', 'k'], 'stopbar'];
  // The two surfaces that used to be `line` layers and are polygons now. They
  // come off data/ground.geojson (SRC), not data/roads.geojson (RSRC), because
  // the bake writes them there -- see widen_roads in scripts/bake_ground.py.
  const ROADAREA_FILTER = ['==', ['get', 'k'], 'roadarea'];
  const CYCLEAREA_FILTER = ['==', ['get', 'k'], 'cyclearea'];
  // What is left on the line: the far-field armature only.
  const ROAD_FAR_FILTER = ['all', ROAD_FILTER, ['==', ['get', 'far'], 1]];

  /**
   * The far armature's width, capped in PIXELS. See GROUND.roadFarMaxPx.
   *
   * The metres term is kept below the cap rather than thrown away so that a
   * wide establishing shot at z13 still draws a motorway wider than a
   * secondary, which is the only place the class distinction is visible at all.
   */
  function roadFarWidthExpr() {
    const px = z => ['min', GROUND.roadFarMaxPx, ['*', ['get', 'w'], PX_AT(z)]];
    return ['interpolate', ['exponential', 2], ['zoom'], 12, px(12), 21, px(21)];
  }
  /**
   * Alleys, driveways and parking aisles are real and they are what breaks a
   * West Campus block up — but at altitude thousands of extra hairlines read as
   * noise, so they arrive on a zoom fade. Written as stop VALUES of a top-level
   * zoom interpolate because ['zoom'] is only legal there.
   */
  function roadOpacityExpr(base) {
    const isService = ['==', ['get', 'c'], 'service'];
    return ['interpolate', ['linear'], ['zoom'],
      GROUND.roadServiceFade[0], ['case', isService, 0, base],
      GROUND.roadServiceFade[1], base];
  }
  /** The carriageway's own surface: asphalt unless OSM says concrete. */
  function roadColorExpr(pal) {
    return ['match', ['get', 's'],
      'roadconcrete', pal.roadconcrete,
      'paving', pal.paving,
      'gravel', pal.gravel,
      'dirt', pal.dirt,
      pal.asphalt];
  }
  const LANE_FILTER = () => ['all',
    ROAD_FILTER,
    ['match', ['get', 'c'], GROUND.laneClasses, true, false],
    ['!=', ['get', 'lk'], 1],
  ];
  /** Constant in metres where it can be, with a floor so it never disappears. */
  function laneWidthExpr() {
    const m = ['*', ['get', 'w'], GROUND.laneWidthFrac];
    return ['interpolate', ['exponential', 2], ['zoom'],
      GROUND.laneMinZoom, GROUND.laneMinPx,
      17, ['max', GROUND.laneMinPx, ['*', m, PX_AT(17)]],
      21, ['*', m, PX_AT(21)]];
  }
  /** Yellow down the middle of an undivided road, white on a oneway carriageway. */
  function laneColorExpr(p) {
    const n = nightAmt(p);
    const dim = c => lerpHex(c, '#0a0c12', n * GROUND.laneNightFade);
    return ['case',
      ['any', ['==', ['get', 'ow'], 1], ['==', ['get', 'ow'], -1]],
      dim(GROUND.laneCool), dim(GROUND.laneWarm)];
  }

  // ── Bike lanes ──────────────────────────────────────────────────────
  //
  // One layer per side, offset from the road centreline. `line-offset` is
  // positive to the RIGHT of the line's direction, which is exactly OSM's own
  // left/right convention, so the two agree without a sign fudge.
  //
  // The lane occupies the outer 1.8 m of the pavement, and `w` already INCLUDES
  // it (bake_ground.py adds BIKE_M per tagged side), so its centre sits at
  // w/2 − 0.9 m. That is why a "2 lane" street with lanes both sides comes out
  // 12.0 m and not 8.4 m, and it is why the lane lands on the pavement instead
  // of in the gutter.
  const bikeOffsetM = () => ['-', ['/', ['get', 'w'], 2], GROUND.bikeWidth / 2];
  function bikeOffsetExpr(sign) {
    const m = ['*', bikeOffsetM(), sign];
    return ['interpolate', ['exponential', 2], ['zoom'],
      13, ['*', m, PX_AT(13)],
      21, ['*', m, PX_AT(21)]];
  }
  function bikeWidthExpr() {
    return ['interpolate', ['exponential', 2], ['zoom'],
      13, ['max', GROUND.bikeMinPx, GROUND.bikeWidth * PX_AT(13)],
      17, ['max', GROUND.bikeMinPx, GROUND.bikeWidth * PX_AT(17)],
      21, GROUND.bikeWidth * PX_AT(21)];
  }
  /**
   * `gp` is set by the bake ONLY on ways where green paint was measured in
   * nadir imagery. `bl`/`br` are 1 for a painted lane and 2 for a protected
   * track. Nothing else reaches this expression, because the bake dropped
   * `shared_lane`, `share_busway`, `separate` and `no` before writing the file.
   */
  function bikeColorExpr(pal, sideKey) {
    const green = GROUND.bikeGreenFromData
      ? [['==', ['get', 'gp'], 1], pal.bikegreen] : [];
    return ['case',
      ...green,
      ['==', ['get', sideKey], 2], pal.biketrack,
      pal.bikelane];
  }
  const bikeFilter = sideKey => ['all', ROAD_FILTER, ['>', ['get', sideKey], 0]];

  /** A separate cycleway's own surface. Shared by the layer and the retint. */
  function cycleColorExpr(pal) {
    return ['match', ['get', 's'],
      'roadconcrete', pal.concrete, 'gravel', pal.gravel, 'dirt', pal.dirt,
      pal.biketrack];
  }

  /** Stop-bar depth, over-scale, with a floor. See GROUND.stopBarDepth. */
  function stopBarWidthExpr() {
    return ['interpolate', ['exponential', 2], ['zoom'],
      GROUND.stopBarMinZoom, Math.max(1, GROUND.stopBarDepth * PX_AT(GROUND.stopBarMinZoom)),
      21, GROUND.stopBarDepth * PX_AT(21)];
  }

  // ── Texture tiles ───────────────────────────────────────────────────
  //
  // These are pure ALPHA modulation — black where they darken, white where they
  // lighten, and nothing in between — which is the whole reason they are cheap.
  // The facade atlas has to be redrawn on every time-of-day tick because its
  // colour lives inside the image; these carry no colour at all, so they are
  // generated once at load and never touched again. Time of day moves the
  // layer's opacity, which is one setPaintProperty.
  //
  // Every blob is drawn nine times, offset by ±TILE, so the tile wraps without
  // a seam. Seams are the failure mode you only see once it is tiled 400 times
  // across a lawn.
  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function wrapped(ctx, T, x, y, draw) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) draw(x + dx*T, y + dy*T);
  }
  function blob(ctx, T, x, y, r, rgb, a) {
    wrapped(ctx, T, x, y, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    });
  }
  function speckle(ctx, T, rand, n, maxA, size) {
    for (let i = 0; i < n; i++) {
      const light = rand() < 0.5;
      ctx.fillStyle = `rgba(${light ? '255,255,255' : '0,0,0'},${(0.25 + rand()*0.75) * maxA})`;
      ctx.fillRect(Math.floor(rand()*T), Math.floor(rand()*T), size, size);
    }
  }

  function drawTexture(family, T) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = T;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, T, T);
    const rand = rng({ grass: 12345, asphalt: 777, water: 4242, paving: 90210,
                       canopy: 5150 }[family]);

    if (family === 'canopy') {
      // A CLOSED CANOPY, not a lawn. Same wrap-nine-times rule as everything
      // here; what differs is the statistics. Crowns are big (a live oak is
      // 8-14 m, which at z16's ~66 m tile is 8-14 px), they OVERLAP, and the
      // gap between them is deep shadow rather than a lighter green. So: few
      // large dark blobs for the shadow between crowns, then bright caps set
      // slightly up-sun of each, which is what makes a canopy read as a lumpy
      // volume instead of a flat tint.
      //
      // Deliberately still shapeless at the small end. fill-pattern resets at
      // every integer zoom (GROUND.texture's note), so anything with a
      // countable period pops on the way in; crowns at three sizes with random
      // centres have no period to count.
      for (let i = 0; i < 26; i++) {
        const r = 7 + rand() * 9;
        blob(ctx, T, rand()*T, rand()*T, r, '10,18,6', 0.16 + rand()*0.12);
      }
      for (let i = 0; i < 34; i++) {
        const x = rand()*T, y = rand()*T, r = 3.5 + rand()*5;
        blob(ctx, T, x, y, r, '196,220,150', 0.10 + rand()*0.10);
        blob(ctx, T, x + r*0.7, y + r*0.7, r*0.8, '8,14,5', 0.10 + rand()*0.08);
      }
      speckle(ctx, T, rand, 700, 0.13, 1);
    } else if (family === 'grass') {
      // Clumps at a range of sizes — mown stripes and beds would be a motif and
      // would pop at every integer zoom, so this is deliberately shapeless.
      // Many small clumps, not few large ones: at z16 the tile spans ~66 m, so
      // a 4 px blob is a 4 m patch, which is the scale that survives the flying
      // camera. The first pass used 34 blobs up to 20 px and read as weather.
      for (let i = 0; i < 62; i++) {
        const r = 3 + rand() * 8, dark = rand() < 0.55;
        blob(ctx, T, rand()*T, rand()*T, r, dark ? '20,26,10' : '236,246,206',
             (0.05 + rand()*0.10) * (dark ? 1 : 0.8));
      }
      speckle(ctx, T, rand, 900, 0.10, 1);
    } else if (family === 'asphalt') {
      // Aggregate, then the patching. A road surface is never one age.
      speckle(ctx, T, rand, 2100, 0.12, 1);
      for (let i = 0; i < 9; i++) {
        const r = 6 + rand() * 13, fresh = rand() < 0.6;
        blob(ctx, T, rand()*T, rand()*T, r, fresh ? '0,0,0' : '255,255,255',
             (0.04 + rand()*0.05));
      }
    } else if (family === 'water') {
      // Four crossing waves at integer frequencies, so the tile wraps and so no
      // single one of them dominates. The first pass was one band plus a wobble
      // at 0.26 alpha and Waller Creek came out a zebra ribbon — a period the
      // eye can count is the one thing that must not happen here, because
      // fill-pattern resets at every integer zoom and a countable period pops.
      const WAVES = [
        [0, 3, 0.00, 0.45],   // [freq x, freq y, phase, weight]
        [1, 7, 1.10, 0.28],
        [2, 5, 2.40, 0.20],
        [3, -2, 0.40, 0.16],
      ];
      const norm = WAVES.reduce((a, w) => a + w[3], 0);
      const img = ctx.createImageData(T, T);
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
        let v = 0;
        for (const [fx, fy, ph, wt] of WAVES) v += wt * Math.sin(2*Math.PI*(fx*x + fy*y)/T + ph);
        v /= norm;
        const a = Math.min(1, Math.abs(v) * 0.11);
        const i = (y*T + x) * 4, light = v > 0;
        img.data[i] = img.data[i+1] = img.data[i+2] = light ? 255 : 0;
        img.data[i+3] = Math.round(a * 255);
      }
      ctx.putImageData(img, 0, 0);
      speckle(ctx, T, rand, 520, 0.08, 1);
    } else {
      // Paving / concrete / gravel / sand: aggregate and a few old stains. The
      // paving tones are pale ON PURPOSE, so this is the gentlest of the four —
      // it must add grain without eating the path-versus-ground separation.
      // Stains stay small: at 10-24 px they rendered as literal round spots on
      // a light surface rather than as a wash.
      speckle(ctx, T, rand, 1500, 0.09, 1);
      for (let i = 0; i < 9; i++) {
        blob(ctx, T, rand()*T, rand()*T, 5 + rand()*7, '0,0,0', 0.02 + rand()*0.018);
      }
    }
    const d = ctx.getImageData(0, 0, T, T);
    if (window.PatternLowpass) {
      window.PatternLowpass.blurWrap(d.data, T,
        GROUND_SOFTEN.RADIUS[family], GROUND_SOFTEN.AMOUNT[family]);
    }
    return { width: T, height: T, data: new Uint8Array(d.data.buffer.slice(0)) };
  }

  /**
   * THE CLOSE-RANGE TILES (QUEUE Y8) — what a surface is made of, seen from
   * 1.7 m. Pure alpha modulation like every tile above, drawn once at load,
   * and deliberately still scale-free noise: fill-pattern halves its metre
   * size at every integer zoom, so a countable motif (a paver, a crack, a
   * blade of grass) would pop on the way down. What survives is statistics —
   * aggregate density, clump size, patch frequency.
   *
   * The densities are the taste here and they are all named above
   * (closeTile, closeStrength). At z20 a 96 px tile is ~6.2 m of ground, so
   * a 1 px speckle is a ~6 cm stone — true aggregate scale, which is why
   * these read as material where the 200-900 m tiles read as weather.
   */
  function drawCloseTexture(family, T) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = T;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, T, T);
    const rand = rng({ grass: 60301, asphalt: 60302, paving: 60303 }[family]);
    if (family === 'asphalt') {
      // Aggregate first — dense 1 px chip, a scatter of 2 px stones — then
      // the patching: an asphalt surface is never one age or one pour.
      speckle(ctx, T, rand, Math.round(T * T * 0.55), 0.16, 1);
      speckle(ctx, T, rand, Math.round(T * T * 0.06), 0.10, 2);
      for (let i = 0; i < 7; i++) {
        const fresh = rand() < 0.55;
        blob(ctx, T, rand() * T, rand() * T, 10 + rand() * 22,
             fresh ? '0,0,0' : '255,255,255', 0.030 + rand() * 0.035);
      }
    } else if (family === 'grass') {
      // Tone clumps, not blades: a mown lawn at 2 m is patches of thicker
      // and thinner growth. Many small clumps at two tones, then a fine
      // speckle for the broken texture inside each.
      for (let i = 0; i < 90; i++) {
        const r = 2 + rand() * 6, dark = rand() < 0.55;
        blob(ctx, T, rand() * T, rand() * T, r,
             dark ? '18,26,9' : '232,244,198',
             (0.05 + rand() * 0.09) * (dark ? 1 : 0.75));
      }
      speckle(ctx, T, rand, Math.round(T * T * 0.30), 0.12, 1);
    } else {
      // Paving / concrete: fine aggregate and old stains, quieter than the
      // asphalt — the walking surfaces already carry their scored joints
      // (PATH_TEX); this adds the material between the joints.
      speckle(ctx, T, rand, Math.round(T * T * 0.40), 0.11, 1);
      for (let i = 0; i < 6; i++) {
        blob(ctx, T, rand() * T, rand() * T, 6 + rand() * 10, '0,0,0',
             0.018 + rand() * 0.020);
      }
    }
    const d = ctx.getImageData(0, 0, T, T);
    if (window.PatternLowpass) {
      const key = 'close' + family[0].toUpperCase() + family.slice(1);
      window.PatternLowpass.blurWrap(d.data, T,
        GROUND_SOFTEN.RADIUS[key], GROUND_SOFTEN.AMOUNT[key]);
    }
    return { width: T, height: T, data: new Uint8Array(d.data.buffer.slice(0)) };
  }

  /**
   * The Speedway Mall herringbone, as pure ALPHA — dark joints, per-brick
   * lightness jitter, no colour. Same reason as the four tiles above: colour
   * inside an image means redrawing it on every time-of-day tick.
   *
   * THE PATTERN. A herringbone is the two-brick L-pair {H at (0,0) size 2W x W,
   * V at (2W,0) size W x 2W} repeated on a lattice. Brute-forcing which lattice
   * actually tiles (see the note in docs/PASS_ROADS.md) gives generators
   * (W, −W) and (4W, 0), whose axis-aligned period is exactly 4W x 4W — and the
   * first thing this got wrong was a four-brick cell that produced a PINWHEEL,
   * which was obvious the moment it was rendered and looked at, and invisible
   * on paper.
   *
   * Rotated 45° to the corridor (the real bond, chosen because Speedway carries
   * emergency vehicles), the smallest axis-aligned period becomes 4W·√2. So the
   * tile is drawn oversized, rotated, and cropped to a window whose side is an
   * exact whole number of those periods — which is what makes it wrap.
   *
   * The per-brick jitter is hashed on the brick's position MODULO the tile, not
   * on its lattice index. Hash the index and the brick clipped by the right
   * edge gets a different tone from the one that continues at the left edge,
   * and the tile seams show as a grid the instant it is laid down a 700 m
   * corridor.
   */
  function drawHerringbone(T, cells, angDeg) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = T;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, T, T);

    const a = angDeg * Math.PI / 180;
    const period = 4 * (angDeg ? Math.SQRT2 : 1);     // in units of W
    const W = T / (cells * period);
    const JOINT = Math.max(0.9, W * 0.09);
    const ca = Math.cos(a), sa = Math.sin(a), c = T / 2;

    // Deterministic hash of a wrapped pixel position -> [0,1).
    const h01 = (x, y) => {
      const xi = ((Math.round(x) % T) + T) % T, yi = ((Math.round(y) % T) + T) % T;
      let s = (xi * 73856093) ^ (yi * 19349663);
      s = (s ^ (s >>> 13)) >>> 0;
      return ((s * 1274126177) >>> 0) / 4294967296;
    };

    ctx.fillStyle = 'rgba(0,0,0,0.42)';               // the mortar joint
    ctx.fillRect(0, 0, T, T);

    // Lattice space -> tile space, once. Brick coordinates below are centred on
    // the origin, so this is translate-then-rotate and nothing else; an extra
    // translate(-c,-c) here silently shifts every brick by half a tile and the
    // pattern stops wrapping.
    ctx.translate(c, c);
    ctx.rotate(a);

    const PAIR = [[0, 0, 2, 1], [2, 0, 1, 2]];
    const reach = Math.ceil(T / W) + 4;
    for (let i = -reach; i <= reach; i++) {
      for (let j = -Math.ceil(reach / 4) - 2; j <= Math.ceil(reach / 4) + 2; j++) {
        const ox = (i + 4 * j) * W, oy = -i * W;
        for (const [bx, by, bw, bh] of PAIR) {
          const x0 = ox + bx * W, y0 = oy + by * W;
          const cx = x0 + bw * W / 2, cy = y0 + bh * W / 2;
          const px = c + cx * ca - cy * sa, py = c + cx * sa + cy * ca;
          if (px < -2 * W || px > T + 2 * W || py < -2 * W || py > T + 2 * W) continue;
          const t = h01(px, py);
          // Brick faces: mostly light, a scatter of darker ones. A real
          // sand-molded brick field is never one tone, and this is the only
          // thing in the tile that survives being 1.6 px wide at 400 m.
          const v = t < 0.30 ? -(0.05 + t * 0.25) : (0.03 + (t - 0.30) * 0.22);
          const fx = x0 + JOINT / 2, fy = y0 + JOINT / 2;
          const fw = bw * W - JOINT, fh = bh * W - JOINT;
          // Clear the joint back out of the brick's face, then lay the face on.
          ctx.globalCompositeOperation = 'destination-out';
          ctx.fillStyle = '#000';
          ctx.fillRect(fx, fy, fw, fh);
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = v < 0 ? `rgba(0,0,0,${(-v).toFixed(3)})`
                                : `rgba(255,255,255,${v.toFixed(3)})`;
          ctx.fillRect(fx, fy, fw, fh);
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const d = ctx.getImageData(0, 0, T, T);
    if (window.PatternLowpass) {
      window.PatternLowpass.blurWrap(d.data, T,
        GROUND_SOFTEN.RADIUS.herringbone, GROUND_SOFTEN.AMOUNT.herringbone);
    }
    return { width: T, height: T, data: new Uint8Array(d.data.buffer.slice(0)) };
  }

  /**
   * SCORED CONCRETE — BARS ACROSS THE WALK, one pre-rotated tile per direction.
   *
   * "sidewalks look like bathroom tiles. looks like its all one huge tile floor
   * and the sidewalks just reveal a portion of that one floor. At first it
   * looked like tape now it looks like bathroom tiles."
   *
   * WHAT THE OLD TILE WAS AND WHY IT READ THAT WAY. It was a SQUARE GRID, and
   * it was chosen on purpose: a fill-pattern is anchored in tile space rather
   * than to the feature's own axis, and a square grid is the one scoring
   * pattern that looks the same at every orientation. That reasoning is sound
   * and the conclusion was still wrong, because it optimised the wrong thing.
   * A square cell IS a tile; and one lattice over the whole city means two
   * walks that never touch share joint lines, which is exactly "one huge tile
   * floor that the sidewalks reveal a portion of". Being orientation-agnostic
   * was the defect, not the fix for it.
   *
   * SO THE ORIENTATION MOVED INTO THE DATA. `fill-extrusion-pattern` is
   * data-driven, so `['match', ['get','o'], …]` picks a different pre-rotated
   * tile per feature, and scripts/bake_ground.py cuts the walk area into
   * `k:'pathslab'` regions of constant direction for it to match on. The bars
   * run across the walk; on a curve the region changes and the bars turn with
   * it, which is what a poured radius actually looks like.
   *
   * PER-SLAB GEOMETRY WAS PRICED AND REJECTED, so this comment is here instead
   * of that: 136 km of centreline at a true 1.5 m pitch is 90,600 quads and
   * about 19 MB of GeoJSON on a 3.9 MB file.
   *
   * WHY THE ANGLES ARE INTEGER VECTORS. phase = frac((a·x + b·y)·k / T) is
   * periodic on the T×T tile for ANY integers a, b, k — step x by T and the
   * phase advances by a·k, a whole number, so the bars close on the seam
   * exactly. At a non-integer angle they do not, and the phase jump at every
   * tile edge draws a grid across the city: the bug, rebuilt.
   *
   * The canvas y axis runs SOUTH and the bake's y runs NORTH, so b is negated
   * here and nowhere else. Get that sign wrong and 0° and 90° still look
   * right — only the diagonals mirror — which is why the check is a photograph
   * of a diagonal walk and not a reading of this line.
   */
  function drawScoredBars(T, angIdx, variant) {
    const ang = GROUND.pathSlabAngles[angIdx];
    const A = ang[0], B = -ang[1];
    const norm = Math.hypot(ang[0], ang[1]);
    // Bands per tile edge. Integer, or the lattice does not close on the tile.
    const k = Math.max(2, Math.round(T / (GROUND.pathSlabPx * norm))
                          + GROUND.pathSlabPitchVar[variant]);
    const phase = GROUND.pathSlabPhase[variant];
    const jw = GROUND.pathSlabJoint, sh = GROUND.pathSlabShoulder;
    const dark = GROUND.pathJointDark, pv = GROUND.pathSlabPanelVar;
    // Panel lightness must repeat every k bands and only every k bands: stepping
    // x by T moves the band index by a·k and y by T moves it by b·k, so any
    // period that divides k tiles and nothing longer does.
    const tone = new Float32Array(k);
    for (let i = 0; i < k; i++) {
      let s = ((i * 2654435761) ^ (angIdx * 40503) ^ (variant * 1000003)) >>> 0;
      s = (s ^ (s >>> 13)) >>> 0;
      tone[i] = ((((s * 1274126177) >>> 0) / 4294967296) - 0.5) * 2 * pv;
    }
    const cv = document.createElement('canvas');
    cv.width = cv.height = T;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, T, T);
    const img = ctx.createImageData(T, T);
    const px = img.data;
    // 3x3 supersampling. A joint is about one texel wide, and one texel wide
    // and hard-edged is what makes a repeating line pattern crawl and alias
    // once it is minified across a city.
    const SS = 3, INV = 1 / (SS * SS);
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        let acc = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
            const t = ((A * fx + B * fy) / T) * k + phase;
            const band = Math.floor(t);
            const f = t - band;
            if (f < jw) acc += -dark;
            else if (f < jw + sh) acc += GROUND.pathSlabShoulderLight;
            else acc += tone[((band % k) + k) % k];
          }
        }
        const v = acc * INV;
        const i = (y * T + x) * 4;
        const a = Math.min(1, Math.abs(v));
        const c = v < 0 ? 0 : 255;
        px[i] = c; px[i + 1] = c; px[i + 2] = c; px[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    // Aggregate. Concrete is not a flat sheet between its joints, and this is
    // the difference between a drawn line and a poured surface.
    speckle(ctx, T, rng(5150 + angIdx * 17 + variant), Math.round(T * T * 0.22), 0.07, 1);
    const d = ctx.getImageData(0, 0, T, T);
    if (window.PatternLowpass) {
      window.PatternLowpass.blurWrap(d.data, T,
        GROUND_SOFTEN.RADIUS.walk, GROUND_SOFTEN.AMOUNT.walk);
    }
    return { width: T, height: T, data: new Uint8Array(d.data.buffer.slice(0)) };
  }

  function initTextures(map) {
    const T = GROUND.texTile;
    for (const [family, id] of Object.entries(TEX_IMG)) {
      if (map.hasImage && map.hasImage(id)) continue;
      try { map.addImage(id, drawTexture(family, T)); } catch (e) {}
    }
    if (GROUND.close) {
      for (const [family, id] of Object.entries(CLOSE_IMG)) {
        if (map.hasImage && map.hasImage(id)) continue;
        try { map.addImage(id, drawCloseTexture(family, GROUND.closeTile)); } catch (e) {}
      }
    }
    if (GROUND.speedway && !(map.hasImage && map.hasImage(HERRING_IMG))) {
      try {
        map.addImage(HERRING_IMG, drawHerringbone(
          GROUND.speedwayTile, GROUND.speedwayCells, GROUND.speedwayAngle));
      } catch (e) {}
    }
    if (GROUND.pathTexture) {
      const NV = GROUND.pathSlabPhase.length;
      // A silent skew between these two lists and the bake's WALK_ANG /
      // WALK_VARIANTS is a walk wearing another walk's joint angle, which looks
      // like nothing in particular and so never gets reported. Say it out loud.
      if (NV !== GROUND.pathSlabPitchVar.length) {
        console.error('[ground] pathSlabPhase and pathSlabPitchVar must be the ' +
                      'same length; walk scoring will be wrong');
      }
      for (let o = 0; o < walkImgCount(); o++) {
        if (map.hasImage && map.hasImage(WALK_IMG(o))) continue;
        try {
          map.addImage(WALK_IMG(o),
            drawScoredBars(GROUND.pathSlabTile, Math.floor(o / NV), o % NV));
        } catch (e) {}
      }
    }
  }

  /**
   * regenGroundTextures — force every pattern image to be redrawn and
   * re-registered, bypassing `initTextures`'s `hasImage` skip.
   *
   * WHY THIS EXISTS. Every image drawn above is cached forever and never
   * touched again in normal operation (ground-pattern-map.md §2: "no
   * per-repaint cost question here at all" — time-of-day retinting is
   * `fill-opacity`, never pixels). That is correct for production, but it
   * means `initTextures` alone gives `scripts/verify/shimmer.mjs`'s
   * SHIM_SOFTEN sweep no way to see a GROUND_SOFTEN override take effect —
   * the images are already registered by the time the sweep sets
   * `window.GROUND_SOFTEN.RADIUS[...]`. This is the repaint hook, same shape
   * as `applyDragColors`/`applyTowerColors`/etc. get from their own sweep
   * entries in shimmer.mjs, just keyed on the taste table instead of `p`
   * because these tiles carry no time-of-day content to re-quantise.
   *
   * `map.updateImage` replaces an already-registered image's bytes without a
   * remove/re-add cycle (same dimensions here in every case, so it always
   * applies); `addImage` covers the first call before anything is
   * registered. Exposed on `window` for the same console-overridable
   * contract as `initGround`/`applyGroundColors` below.
   */
  function regenGroundTextures(map) {
    const put = (id, img) => {
      try {
        if (map.hasImage && map.hasImage(id)) map.updateImage(id, img);
        else map.addImage(id, img);
      } catch (e) {}
    };
    const T = GROUND.texTile;
    for (const [family, id] of Object.entries(TEX_IMG)) put(id, drawTexture(family, T));
    if (GROUND.close) {
      for (const [family, id] of Object.entries(CLOSE_IMG)) {
        put(id, drawCloseTexture(family, GROUND.closeTile));
      }
    }
    if (GROUND.speedway) {
      put(HERRING_IMG, drawHerringbone(
        GROUND.speedwayTile, GROUND.speedwayCells, GROUND.speedwayAngle));
    }
    if (GROUND.pathTexture) {
      const NV = GROUND.pathSlabPhase.length;
      for (let o = 0; o < walkImgCount(); o++) {
        put(WALK_IMG(o), drawScoredBars(GROUND.pathSlabTile, Math.floor(o / NV), o % NV));
      }
    }
  }
  window.regenGroundTextures = regenGroundTextures;

  /**
   * ['match', ['get','o'], 0, img0, …, img0] — one tile per direction.
   *
   * The fallback is tile 0 rather than "no pattern": a `k:'pathslab'` feature
   * whose `o` is out of range is a bake/render version skew, and an unscored
   * walk beside a scored one is a much louder defect than a walk whose joints
   * point the wrong way.
   */
  function walkPatternExpr() {
    const e = ['match', ['get', 'o']];
    for (let o = 0; o < walkImgCount(); o++) e.push(o, WALK_IMG(o));
    e.push(WALK_IMG(0));
    return e;
  }
  /** ['match', ['get','s'], …, imageName] — one tile per surface family. */
  function texPatternExpr() {
    const e = ['match', ['get', 's']];
    for (const k of KEYS) e.push(k, TEX_IMG[TEX_FAMILY[k] || 'paving']);
    e.push(TEX_IMG.paving);
    return e;
  }
  /** Per-surface strength × master × the night fade. */
  function texOpacityExpr(p) {
    const n = nightAmt(p);
    const fade = f => GROUND.texOpacity * f * (1 - n * (1 - GROUND.texNightFade));
    const waterFade = GROUND.texOpacity * GROUND.texStrength.water *
                      (1 - n * (1 - GROUND.texWaterNightKeep));
    const e = ['match', ['get', 's']];
    for (const k of KEYS) {
      const fam = TEX_FAMILY[k] || 'paving';
      e.push(k, +(fam === 'water' ? waterFade : fade(GROUND.texStrength[fam])).toFixed(3));
    }
    e.push(+fade(GROUND.texStrength.paving).toFixed(3));
    return e;
  }
  /** The base-ground grain rides the same night fade as everything else. */
  function baseTexOpacity(p) {
    const n = nightAmt(p);
    return +(GROUND.texOpacity * GROUND.texStrength.paving * GROUND.texGroundOpacity *
             (1 - n * (1 - GROUND.texNightFade))).toFixed(3);
  }
  /** The ripple survives the night better than the ground grain: still water. */
  function sheenOpacity(p) {
    const n = nightAmt(p);
    return +(GROUND.creekSheenOpacity *
             (1 - n * (1 - GROUND.creekSheenNightKeep))).toFixed(3);
  }
  /** The brick weave keeps more of itself after dark than the ground grain. */
  function speedwayTexOpacity(p) {
    const n = nightAmt(p);
    return +(GROUND.speedwayOpacity * (1 - n * (1 - GROUND.speedwayNightFade))).toFixed(3);
  }
  /** The walk's scoring, on the same night curve as everything else's grain. */
  function pathTexOpacity(p) {
    const n = nightAmt(p);
    return +(GROUND.pathTexOpacity * (1 - n * (1 - GROUND.pathTexNightFade))).toFixed(3);
  }

  // ── Close-range grain (QUEUE Y8) ────────────────────────────────────
  /** Which close tile a surface key wears, or null for none (water, canopy). */
  function closeFamilyOf(k) {
    const fam = TEX_FAMILY[k] || 'paving';
    return CLOSE_IMG[fam] ? fam : null;
  }
  /** Only surfaces that have a close tile — water and canopy stay bare. */
  function closeAreaFilter() {
    const bare = KEYS.filter(k => !closeFamilyOf(k));
    return ['all', ['==', ['get', 'k'], 'area'],
            ['match', ['get', 's'], bare, false, true]];
  }
  /** ['match', ['get','s'], …] — one close tile per surface family. */
  function closeAreaPatternExpr() {
    const e = ['match', ['get', 's']];
    for (const k of KEYS) {
      const fam = closeFamilyOf(k);
      if (fam) e.push(k, CLOSE_IMG[fam]);
    }
    e.push(CLOSE_IMG.paving);
    return e;
  }
  /**
   * 0 below closeFadeZoom[0] (where the layer's minzoom already hides it),
   * the full per-family strength above closeFadeZoom[1]. The minzoom is the
   * byte-identity gate; this fade only stops the arrival being a pop.
   */
  function closeZoomFade(val) {
    return ['interpolate', ['linear'], ['zoom'],
            GROUND.closeFadeZoom[0], 0, GROUND.closeFadeZoom[1], val];
  }
  const closeStrengthAt = (fam, p) =>
    +(GROUND.closeStrength[fam] *
      (1 - nightAmt(p) * (1 - GROUND.closeNightFade))).toFixed(3);
  function closeAreaOpacityExpr(p) {
    const e = ['match', ['get', 's']];
    for (const k of KEYS) {
      const fam = closeFamilyOf(k);
      if (fam) e.push(k, closeStrengthAt(fam, p));
    }
    e.push(closeStrengthAt('paving', p));
    return closeZoomFade(e);
  }
  const closeRoadOpacityExpr = p => closeZoomFade(closeStrengthAt('asphalt', p));
  const closePathOpacityExpr = p => closeZoomFade(closeStrengthAt('paving', p));

  /**
   * GROUND THAT IS NOT FLAT. "fountain in front of tower has stairs on both
   * sides is that possible depth throughout or did we already rule that out."
   *
   * It is possible and it was never ruled out: a fill-extrusion takes a base
   * and a height, so a step is a thin extrusion at a raised base -- the same
   * trick the roofs and the tree crowns already use. scripts/bake_depth.py
   * generates the courses; this draws them.
   *
   * Day / golden / night trios, the shape every other pass uses.
   */
  const DEPTH_MAT = {
    // The two are further apart than a real stone would be. Four courses of the
    // SAME limestone at heights 140 mm apart rendered as one flat tan blob from
    // flying altitude: what carries a flight at that distance is the light/dark
    // banding of tread against riser, not the height. Declared, and narrow this
    // gap if it ever reads as stripes rather than as steps.
    // Cooler and greyer than the mall paving they sit on. Matched to the
    // paving they were invisible: a tan step on a tan plaza is a tan plaza.
    stone:   ['#cfc9bb', '#d8c8a6', '#23242e'],   // Texas limestone, lit tread
    stonedk: ['#9a9184', '#a28a6f', '#171821'],   // the riser, in its own shade
    water:   ['#5f86a0', '#6d87a0', '#141a26'],
    shell:   ['#4a4a34', '#56502f', '#12131a'],   // a turtle, wet, in Austin sun
  };
  /**
   * Blend a day/golden/night trio at hour p, the same shape paletteAt() uses.
   *
   * Written here rather than reaching for props.js's `pick`, which is what the
   * first cut did: `pick` does not exist in this file, initGround threw on the
   * very first call, and the WHOLE ground stage -- paths, roads, areas, the lot
   * -- silently failed to build. The screenshot showed a washed-out campus with
   * no ground at all and it took a console read to see why. A missing layer
   * makes everything look fine at a glance.
   */
  function trioAt(t, p) {
    const q = clamp01(p);
    return q <= 0.5 ? lerpHex(t[0], t[1], q / 0.5) : lerpHex(t[1], t[2], (q - 0.5) / 0.5);
  }
  function depthColour(p) {
    const e = ['match', ['get', 'm']];
    for (const k of Object.keys(DEPTH_MAT)) e.push(k, trioAt(DEPTH_MAT[k], p));
    e.push(trioAt(DEPTH_MAT.stone, p));
    return e;
  }

  /**
   * THE CUT CHANNEL. Waller Creek's bed and bank courses, `k:'bank'` from
   * scripts/bake_ground.py.
   *
   * These are the only extrusions in the scene that go BELOW z=0, and the whole
   * reason they can is that the A2 resolver takes the flat ground away from
   * their footprint first — a `fill` does not depth-test against a
   * `fill-extrusion`, so a lawn drawn over a trench paints into it.
   *
   * The bank is limestone and pale clay, which is what the channel through
   * campus actually is: the ledges below the 23rd Street bridge are exposed
   * Austin Chalk. It is deliberately NOT the mall's limestone from DEPTH_MAT —
   * that stone is a dressed, swept tread and this is a raw cut face, so it is
   * browner, dirtier and lower in value. The two courses differ by more than a
   * real bank would: what carries a 2 m cut section from 300 m is the light
   * tread against the dark riser, not the height between them.
   */
  const BANK_MAT = {
    // WATER, AND THE OLD VALUE IS THE WHOLE STORY. It was #41604a — "channel
    // water, under canopy" — which is a defensible thing to write down and a
    // measurably wrong thing to render:
    //
    //     water     #41604a  rgb( 65, 96, 74)  luma 88   b-r = +9
    //     bankshade #425c33  rgb( 66, 92, 51)  luma 82   b-r = -15
    //
    // Six luma and 24 units of blue apart, two metres apart on screen, both
    // green-dominant. From 200 m that is not a water surface next to a bank, it
    // is one green ribbon — which is exactly what has been reported about this
    // creek in every pass since it was cut.
    //
    // Water reads from the air because it REFLECTS THE SKY, and that is true
    // under a canopy too: what little sky reaches the surface is all of the
    // light there is, so the channel is the one COOL thing in a warm-green
    // corridor. So this is cool and mid-value: luma 118, sitting between the
    // chalk toe (142) and the bank shade (82), with b-r = +63 against the
    // bank's -15. That 78-unit hue swing is the read.
    water:     ['#4d7f8c', '#5a7a80', '#0b1a24'],  // channel water, sky in shade
    bankveg:   ['#5c7742', '#59683a', '#0a110c'],  // top of bank, planted
    bankshade: ['#425c33', '#3f5230', '#080d09'],  // the same bank, in its own shade
    bank:      ['#9a8f70', '#a08a63', '#131319'],  // Austin Chalk at the toe
    // Turtle Pond's rim. Dressed limestone, so it is PALER and cooler than
    // the creek's raw cut face -- a built edge and a broken bank should not
    // be the same colour.
    coping:    ['#c6bda4', '#cdb894', '#1b1c24'],
    // A CULVERT / BRIDGE DECK where a street crosses the creek. "the creek near
    // DKR completely slices through 21st and DKR, but sidewalks still go over
    // them" -- the channel was cut with no idea that anything crosses it, so the
    // trench ran straight through the carriageway while the walks floated over
    // the water on nothing.
    //
    // What is visible of a deck is its EDGE: the road surface on top is drawn by
    // `ground-road` and the walks by `ground-paths`, both of which stand on it.
    // So this is the colour of a concrete soffit and headwall seen from an
    // oblique angle -- grey, cool, and deliberately NOT the chalk of the bank it
    // interrupts, because a structure and a cut bank reading as one material is
    // how the crossing stayed invisible in the first place.
    deck:      ['#8d8b85', '#8a8078', '#15171d'],
  };
  function bankColour(p) {
    const e = ['match', ['get', 'm']];
    for (const k of Object.keys(BANK_MAT)) e.push(k, trioAt(BANK_MAT[k], p));
    e.push(trioAt(BANK_MAT.bank, p));
    return e;
  }

  /**
   * THE CREEK CANOPY, three species, one prism each.
   *
   * The species are not decoration: Waller Creek through campus is bald cypress
   * at the water, pecan and cedar elm above it and live oak on the terrace, and
   * they are three genuinely different greens. One green over 647 crowns is a
   * hedge — the same failure the ground zones had before this pass, one level up.
   *
   * Every trio is day / golden / night, the shape every other palette here uses.
   * `cypress` is the blue-green one and `pecan` the light yellow-green one, and
   * they are 40 luma apart on purpose: from 400 m the only thing left of a
   * species is its tone.
   */
  const CROWN_MAT = {
    cypress: ['#4c6b53', '#4f6949', '#0a120e'],
    pecan:   ['#7d9a4e', '#87954a', '#0e150c'],
    liveoak: ['#4f6a3c', '#546239', '#0a0f09'],
  };
  /** matchExpr on `m`, with each crown somewhere in its own ±amp luma band. */
  function crownColour(p) {
    const one = shift => {
      const e = ['match', ['get', 'm']];
      for (const k of Object.keys(CROWN_MAT)) e.push(k, shiftLuma(trioAt(CROWN_MAT[k], p), shift));
      e.push(shiftLuma(trioAt(CROWN_MAT.liveoak, p), shift));
      return e;
    };
    const a = GROUND.canopyJitter;
    if (!a) return one(0);
    return ['interpolate', ['linear'], hash01(), 0, one(-a), 1, one(+a)];
  }

  window.initGround = function initGround(map) {
    if (!GROUND.on || map.getSource(SRC)) return;
    // generateId is what makes the per-feature jitter possible: without it
    // ['id'] is null for every feature and 4,900 areas stay 14 exact hexes.
    // Nothing in the app puts feature-state on this source, so it is free.
    map.addSource(SRC, { type: 'geojson', data: 'data/ground.geojson', generateId: true, ...(window.PATTERN_TILING || {}) });
    // Roads are their own source: they come from a different bbox (the outer
    // ring, so arterials do not end in mid-frame), they want a lower minzoom
    // than the ground fill, and keeping them separate means GROUND.roads=false
    // costs nothing at all rather than filtering 11,000 features out of a
    // source the fill layers also read.
    // Roads stream as tiles when data/tiles/roads.pmtiles is present, and fall
    // back to the whole 3.70 MB GeoJSON when it is not (a fresh clone, or a
    // branch where CI has not built them). See js/tiles.js.
    const roadTiles = window.tileSource && window.tileSource('roads');
    roadLP = roadTiles ? roadTiles.layerProps : {};
    if (GROUND.roads && !map.getSource(RSRC)) {
      map.addSource(RSRC, roadTiles
        ? roadTiles.source
        : { type: 'geojson', data: 'data/roads.geojson' });
    }

    // Under everything of ours: the buildings' contact shadows and extrusions
    // must sit ON the ground, not under it.
    const under = ['buildings-shadow', 'buildings-ao', 'buildings-3d']
      .find(id => map.getLayer(id));

    const p = window.__todCurrentP != null ? window.__todCurrentP : 0.5;
    const pal = paletteAt(p);

    // Images before any layer references them, or MapLibre logs "image not
    // found" and paints the fill transparent — the same trap as the facades.
    if (GROUND.texture) initTextures(map);

    // Order, bottom to top: the base ground grain, the areas, their texture,
    // the roads, the road markings, then the paths over everything. Each
    // addLayer inserts immediately before `under`, so the call order below IS
    // the paint order.
    if (GROUND.texture && GROUND.texGround && !map.getLayer(BASE_TEX)) {
      map.addLayer({
        id: BASE_TEX, type: 'background',
        minzoom: GROUND.minZoom, maxzoom: GROUND.texGroundMaxZoom,
        paint: {
          'background-pattern': TEX_IMG.paving,
          'background-opacity': baseTexOpacity(p),
        },
      }, under);
    }

    // `s:'creek'` is EXCLUDED and that is the change that let the channel sink.
    // The creek polygon is still in the file — shape_trees.py and bake_props.py
    // read it to keep a trunk or a bench out of the water — but painting it
    // here would put a flat fill straight over the trench, which is exactly the
    // failure PR #62 documented. The extruded bed carries the water now.
    const NOT_CHANNEL = GROUND.channel
      ? ['!=', ['get', 's'], 'creek'] : ['literal', true];
    if (!map.getLayer(AREA)) {
      map.addLayer({
        id: AREA, type: 'fill', source: SRC, minzoom: GROUND.minZoom,
        filter: ['all', ['==', ['get', 'k'], 'area'], NOT_CHANNEL],
        paint: {
          'fill-color': jitterExpr(pal, GROUND.jitter),
          'fill-opacity': GROUND.areaOpacity,
          'fill-antialias': true,
        },
      }, under);
    }

    // ── The creek's cut bank ─────────────────────────────────────────
    //
    // "Make that area read as a green creek with actual depth." There is no
    // terrain in this scene — no DEM, no MapLibre terrain source — so depth has
    // to be implied rather than modelled, and the honest cheap way is the shadow
    // a cut bank throws on its own water. A blurred dark line drawn ALONG the
    // creek polygon's own edge reads, from a flying camera, as the channel being
    // below the ground either side of it.
    //
    // Deliberately not an extrusion: a fill-extrusion cannot go DOWN from the
    // ground plane, so a sunk channel would need every surrounding surface
    // raised instead, which is a re-bake of the entire ground and every building
    // base. That is the "campus-wide terrain" idea, and it is correctly out of
    // scope — one line layer gets most of the read for none of the cost.
    if (GROUND.creekBank && !map.getLayer(BANK)) {
      map.addLayer({
        id: BANK, type: 'line', source: SRC, minzoom: GROUND.minZoom,
        filter: ['all', ['==', ['get', 'k'], 'area'], ['==', ['get', 's'], 'creek']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': GROUND.creekBankColor,
          // Wide enough to read as a bank rather than an outline, and scaled
          // with zoom so it stays the same few metres of ground at every
          // altitude instead of a constant screen width.
          'line-width': ['interpolate', ['exponential', 2], ['zoom'],
                         14, 1.5, 17, 9, 19, 30],
          'line-blur': ['interpolate', ['exponential', 2], ['zoom'],
                        14, 1, 17, 6, 19, 20],
          'line-opacity': GROUND.creekBankOpacity,
        },
      }, under);
    }

    if (GROUND.texture && !map.getLayer(TEX)) {
      map.addLayer({
        id: TEX, type: 'fill', source: SRC, minzoom: GROUND.minZoom,
        filter: ['all', ['==', ['get', 'k'], 'area'], NOT_CHANNEL],
        paint: {
          'fill-pattern': texPatternExpr(),
          'fill-opacity': texOpacityExpr(p),
          'fill-antialias': false,   // the fill under it already drew the edge
        },
      }, under);
    }

    /**
     * CLOSE-RANGE GRAIN ON THE AREAS (QUEUE Y8). Same features as TEX, a
     * finer tile, and a `minzoom` that is the whole contract: below
     * closeFadeZoom[0] this layer does not exist, so the flyover and the
     * spawn pose render byte-identically to a build without it. See the
     * GROUND.close block for the full argument.
     */
    if (GROUND.texture && GROUND.close && !map.getLayer(CLOSE_AREA)) {
      map.addLayer({
        id: CLOSE_AREA, type: 'fill', source: SRC,
        minzoom: GROUND.closeFadeZoom[0],
        filter: closeAreaFilter(),
        paint: {
          'fill-pattern': closeAreaPatternExpr(),
          'fill-opacity': closeAreaOpacityExpr(p),
          'fill-antialias': false,
        },
      }, under);
    }

    /**
     * THE CULVERT / BRIDGE DECKS, and WHERE THIS LAYER SITS IS THE FIX.
     *
     * "the creek near DKR completely slices through 21st and DKR, but sidewalks
     * still go over them". The mechanism, once photographed, is the one PR #62
     * wrote down and nothing since has applied to the creek: **a `fill` does not
     * depth-test against a `fill-extrusion`.** `ground-road` is a flat fill at
     * z=0 and `ground-channel` is an extrusion drawn after it, so the trench
     * painted straight over the carriageway no matter how deep it was cut —
     * that is the creek "slicing through" 21st. The walks are extrusions at
     * 0.22 m, so THEY won, and crossed the water on nothing.
     *
     * So the deck does two separate jobs and needs two separate mechanisms.
     * `RANK[('bank','deck')]` = 95 takes the ground off the channel in the BAKE,
     * which is what stops the trench being drawn across the road at all. And
     * this layer is anchored `under` — BEFORE the roads and the walks — so the
     * carriageway and the pavement paint over their own deck and what is left
     * showing is the parapet and the soffit. Sharing `ground-channel` instead
     * put the deck back on the wrong side of exactly the rule it exists to fix,
     * and photographed as a pale slab lying where the road should be.
     */
    if (GROUND.channel && GROUND.decks && !map.getLayer(DECKL)) {
      map.addLayer({
        id: DECKL, type: 'fill-extrusion', source: SRC, minzoom: GROUND.minZoom,
        filter: ['all', ['==', ['get', 'k'], 'bank'], ['==', ['get', 'u'], 'deck']],
        paint: {
          'fill-extrusion-color': bankColour(p),
          'fill-extrusion-base': ['get', 'b'],
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-opacity': 1,
          // ON: like a bank course and unlike everything else here, a deck has
          // a meaningful vertical face — the soffit is the only part of it that
          // is ever seen from below the parapet.
          'fill-extrusion-vertical-gradient': true,
        },
      }, under);
    }

    if (GROUND.roads) addRoadLayers(map, pal, p, under);

    /**
     * CLOSE-RANGE AGGREGATE ON THE CARRIAGEWAY (QUEUE Y8). HANDOFF §106,
     * standing on the Drag at 1.7 m: "the carriageway is a flat grey field
     * with no texture at all, filling ~70% of the frame … a gnd-tex-asphalt
     * image exists, is registered and is strength-tuned — and no layer uses
     * it". This is that layer, on the close tile rather than the far one,
     * and gated to walking height by the same minzoom as CLOSE_AREA.
     *
     * Anchored UNDER the lane markings when they exist: the grain is the
     * road surface, the markings are paint on it. (The alpha grain crossing
     * a marking would only darken it, but under is simply correct.)
     */
    if (GROUND.texture && GROUND.close && GROUND.roads && !map.getLayer(CLOSE_ROAD)) {
      const markAnchor = [LANE, STOPBAR].find(id => map.getLayer(id)) || under;
      map.addLayer({
        id: CLOSE_ROAD, type: 'fill', source: SRC,
        minzoom: GROUND.closeFadeZoom[0],
        filter: ROADAREA_FILTER,
        paint: {
          'fill-pattern': CLOSE_IMG.asphalt,
          'fill-opacity': closeRoadOpacityExpr(p),
          'fill-antialias': false,
        },
      }, markAnchor);
    }

    /**
     * PATHS ARE FILLS, NOT LINES, and that is the fix for the Speedway fan.
     *
     * A `line-width` is a number of screen pixels and it is the SAME number for
     * the whole line. Under perspective the ground is not: 9.1 m of Speedway
     * near the camera is many pixels, 9.1 m of it up by Dean Keeton is a few.
     * One constant width therefore cannot be right along the length, and the
     * error is large. scripts/verify/road-fan.mjs, camera on the south end of
     * the promenade looking north:
     *
     *     pitch 20   1.10x at the only sample still on screen
     *     pitch 60   1.26x near  ->  3.33x far
     *     pitch 86   1.30x near  ->  3.69x far
     *
     * 3.69x on a 9.1 m mall renders a 34 m motorway. And it looks like it gets
     * worse as you lie the camera down not because the ratio moves much past 60
     * — it barely does — but because pitching over drags the far, wrong end of
     * the road INTO frame. At pitch 20 everything past 30.2845 was off screen.
     *
     * The old `widthExpr` was not sloppy: it is exactly right at the map centre,
     * which is where it was derived from. MapLibre has no per-vertex line width,
     * so NO expression can fix this. The width has to live in the geometry.
     *
     * bake_ground.py now buffers each centreline by half its real width and
     * unions per (use, surface), so `k:'patharea'` polygons arrive width-correct
     * and a fill gets the true perspective for free at any pitch. 2,512
     * LineStrings became 1,006 polygons and ground.geojson got SMALLER (856 ->
     * 784 KB): the union dissolved more than the buffer added.
     *
     * The carriageways have had the same treatment since (`k:'roadarea'`, see
     * addRoadLayers), which is what closed A2: "some roads dont do this" was
     * these paths, already fixed, sitting next to roads that were not.
     */
    if (!map.getLayer(PATH)) {
      map.addLayer({
        id: PATH, type: 'fill-extrusion', source: SRC, minzoom: GROUND.minZoom,
        filter: ['==', ['get', 'k'], 'patharea'],
        paint: {
          'fill-extrusion-color': jitterExpr(pal, GROUND.pathJitter),
          'fill-extrusion-base': 0,
          // A KERB, NOT A PAINTED STRIP. "roads are wtv but sidewalks
          // especially in wampus are a bit lame" — and the reason a West Campus
          // block looked lame is that its footways were flat fills lying in the
          // same plane as the asphalt, so a sidewalk was a pale rectangle
          // rather than a thing you step up onto. A real kerb is 150 mm; this
          // is drawn at pathRaise because at 150 mm the riser is a third of a
          // pixel from any altitude this app flies, the same declared
          // over-scale as the fountain courses and the lane markings.
          //
          // It also buys correctness for free: an extrusion depth-tests against
          // the road extrusions and the buildings, where a fill does not.
          'fill-extrusion-height': GROUND.pathRaise,
          'fill-extrusion-opacity': GROUND.pathOpacity,
          // OFF. The gradient darkens the bottom of every extrusion and this one
          // is 0.22 m tall, so every sidewalk would be a dark ribbon.
          'fill-extrusion-vertical-gradient': false,
        },
      });
    }

    /**
     * THE KERB IS A STROKE ON THE POLYGON BOUNDARY, and staying in pixels here
     * is deliberate rather than a leftover.
     *
     * It used to be a second, 1.34x wider line drawn underneath. As geometry
     * that would mean a second buffered polygon set, 0.55 MB, to draw a bevel.
     * A bevel is a screen-space effect — a highlight a couple of pixels wide
     * along an edge — so a constant pixel width is the RIGHT unit for it and
     * it looks correct at every pitch and distance for free.
     *
     * A `line` layer over a Polygon source strokes its rings, so this rides the
     * same features as the fill and cannot drift out of register with it.
     */
    if (!map.getLayer(PATH_CASE)) {
      map.addLayer({
        id: PATH_CASE, type: 'line', source: SRC, minzoom: GROUND.minZoom,
        filter: ['==', ['get', 'k'], 'patharea'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': jitterExpr(pal, GROUND.pathJitter, c => lighten(c, GROUND.kerbLight)),
          'line-width': GROUND.kerbPx,
          'line-opacity': ['interpolate', ['linear'], ['zoom'],
            GROUND.pathFadeZoom[0], 0,
            GROUND.pathFadeZoom[1], +(GROUND.pathOpacity * 0.8 * GROUND.kerbOpacity).toFixed(3)],
        },
      }, under);
    }

    /**
     * THE GRAIN ON THE WALKING SURFACES — the herringbone on Speedway, and
     * scored concrete on every other walk. Both stand ON the path deck.
     *
     * The herringbone rides on top of the Speedway path's own brick colour, so
     * the image stays colourless and time of day is one setPaintProperty.
     *
     * It was a `line-pattern` because that is stretched across a line and
     * repeated along it, which suited a corridor and — unlike `fill-pattern` —
     * did not reset at every integer zoom (measured in roads-pattern.mjs). With
     * the corridor now a polygon that choice is gone, and `fill-pattern` is what
     * is left. That is the same property the 555 ground areas already use and
     * have shipped with, so the zoom reset is a behaviour this scene already
     * has rather than a new one; and a weave seen from 100-900 m is a texture
     * hint, where being the right WIDTH matters and being phase-locked does not.
     *
     * WHY THEY ARE EXTRUSIONS AND NOT FILLS, which is the actual bug fix here.
     * Both of these used to be flat `fill` layers at z=0, sitting UNDER a
     * `ground-paths` fill-extrusion standing at `pathRaise` 0.22 m. A fill does
     * not win a depth test against an extrusion above it, so the deck painted
     * over its own decoration and only the 8% that `pathOpacity` 0.92 let
     * through survived. Proved by hiding `ground-paths`: the weave was there
     * the whole time, crisp and complete, buried. Same shape of defect as §49's
     * park pad over the Capitol walks — a flat surface under a raised one.
     *
     * So they are prisms from `pathRaise` to `pathRaise + pathTexLift`. The lift
     * is 20 mm and its only job is to make the depth order DEFINED: two tops at
     * exactly the same z is the A2 tie and the winner is whatever the driver
     * feels like. CHANNEL.sheen_m stands the water's ripple 0.10 m proud for
     * precisely this reason and this is the same trick, ten times smaller
     * because a walk is not two metres below grade.
     *
     * `fill-extrusion-vertical-gradient` is OFF on both: the prism is 20 mm
     * tall, so a gradient over its height would black out the only face anyone
     * ever sees.
     */
    if (GROUND.texture && GROUND.pathTexture && !map.getLayer(PATH_TEX)) {
      map.addLayer({
        id: PATH_TEX, type: 'fill-extrusion', source: SRC, minzoom: GROUND.minZoom,
        // `k:'pathslab'`, not `k:'patharea'` — the direction regions, which the
        // bake already emits only for walks that get scoring. The brick mall
        // and the steps are excluded there rather than here now, so the filter
        // that used to name them is gone and cannot drift out of step with the
        // geometry it was describing.
        filter: ['==', ['get', 'k'], 'pathslab'],
        paint: {
          'fill-extrusion-pattern': walkPatternExpr(),
          'fill-extrusion-base': GROUND.pathRaise,
          'fill-extrusion-height': GROUND.pathRaise + GROUND.pathTexLift,
          'fill-extrusion-opacity': pathTexOpacity(p),
          'fill-extrusion-vertical-gradient': false,
        },
      });
    }

    /**
     * CLOSE-RANGE AGGREGATE ON THE WALKS (QUEUE Y8). The walks already
     * carry their scored joints (PATH_TEX); at 2 m the material BETWEEN the
     * joints is still a flat sheet, and this is that material. A prism one
     * lift above the scored grain — top at pathRaise + pathTexLift +
     * closePathLift — so the depth order is defined, the same reason
     * PATH_TEX stands on the deck. Speedway's brick is excluded: a mortar
     * weave already is its close-range surface.
     */
    if (GROUND.texture && GROUND.close && !map.getLayer(CLOSE_PATH)) {
      map.addLayer({
        id: CLOSE_PATH, type: 'fill-extrusion', source: SRC,
        minzoom: GROUND.closeFadeZoom[0],
        filter: ['all', ['==', ['get', 'k'], 'patharea'],
                        ['!=', ['get', 's'], 'brickpave']],
        paint: {
          'fill-extrusion-pattern': CLOSE_IMG.paving,
          'fill-extrusion-base': GROUND.pathRaise + GROUND.pathTexLift,
          'fill-extrusion-height':
            GROUND.pathRaise + GROUND.pathTexLift + GROUND.closePathLift,
          'fill-extrusion-opacity': closePathOpacityExpr(p),
          // OFF, like every thin prism in this file: the slab is 20 mm tall.
          'fill-extrusion-vertical-gradient': false,
        },
      });
    }
    if (GROUND.texture && GROUND.speedway && !map.getLayer(SPEEDWAY)) {
      map.addLayer({
        id: SPEEDWAY, type: 'fill-extrusion', source: SRC, minzoom: GROUND.minZoom,
        filter: ['all', ['==', ['get', 'k'], 'patharea'],
                        ['==', ['get', 's'], 'brickpave']],
        paint: {
          'fill-extrusion-pattern': HERRING_IMG,
          'fill-extrusion-base': GROUND.pathRaise,
          'fill-extrusion-height': GROUND.pathRaise + GROUND.pathTexLift,
          'fill-extrusion-opacity': speedwayTexOpacity(p),
          'fill-extrusion-vertical-gradient': false,
        },
      });
    }

    /**
     * The steps and terraces. NOT anchored under `under` like the flat ground
     * layers are: these are extrusions and they have to sit in the same depth
     * sort as the buildings, or a step half a metre proud of the paving gets
     * painted over by the flat fill it stands on.
     */
    /**
     * The cut channel. NOT anchored under `under`, for the same reason the
     * steps are not: these are extrusions and they have to sit in the same
     * depth sort as the buildings and the bridges over them.
     */
    if (GROUND.channel && !map.getLayer(CHANNEL)) {
      map.addLayer({
        id: CHANNEL, type: 'fill-extrusion', source: SRC, minzoom: GROUND.minZoom,
        // `m:'sheen'` is excluded: it is the SAME footprint as the water prism,
        // standing 0.10 m on it, and it is drawn by its own pattern layer
        // below. Leaving it in here would paint a solid `bank`-coloured lid
        // over the water — the fallback of bankColour's match — which is a tan
        // ribbon down the middle of the channel and would have been read as
        // "the creek is a dirt track" for the third time in this file's history.
        // `u:'deck'` is excluded for the same class of reason `m:'sheen'` is:
        // it is drawn by its own layer, and that layer has to sit BEFORE the
        // roads so the carriageway paints over its own bridge. Leaving it in
        // here would draw every deck twice, once on each side of the roads.
        filter: ['all', ['==', ['get', 'k'], 'bank'],
                        ['!=', ['get', 'm'], 'sheen'],
                        ['!=', ['get', 'u'], 'deck']],
        paint: {
          'fill-extrusion-color': bankColour(p),
          'fill-extrusion-base': ['get', 'b'],
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-opacity': 1,
          // ON, unlike everywhere else in this file. Every other extrusion here
          // is 0.14-0.62 m tall and the gradient would black out its whole
          // face; a bank course is 2-4 m of vertical cut and the gradient is
          // exactly the shading that makes it read as a cut rather than as a
          // stripe of a different colour.
          'fill-extrusion-vertical-gradient': true,
        },
      });
    }

    /**
     * THE RIPPLE ON THE WATER. A 0.10 m slab standing on the water prism,
     * wearing the same scale-free water tile the lake and the ponds wear.
     *
     * WHY A SECOND SLAB AND NOT A PATTERN ON THE WATER ITSELF: a
     * fill-extrusion takes `fill-extrusion-color` OR `fill-extrusion-pattern`
     * and not both, so putting the ripple on the water prism costs the water
     * its time-of-day colour — and the whole point of this pass is the colour.
     * Two prisms with tops at exactly the same z is the A2 z-fight, so the bake
     * stands this one 0.10 m proud (CHANNEL.sheen_m). That is a fifth of a
     * pixel at any altitude this camera flies and it makes the depth order
     * defined rather than undefined.
     *
     * The tile carries NO colour — it is alpha modulation, peaking at 11% —
     * so this darkens and lightens the water under it and nothing else, and
     * time of day is one setPaintProperty on the opacity.
     */
    if (GROUND.channel && GROUND.creekSheen && GROUND.texture && !map.getLayer(SHEEN)) {
      map.addLayer({
        id: SHEEN, type: 'fill-extrusion', source: SRC, minzoom: GROUND.minZoom,
        filter: ['all', ['==', ['get', 'k'], 'bank'], ['==', ['get', 'm'], 'sheen']],
        paint: {
          'fill-extrusion-pattern': TEX_IMG.water,
          'fill-extrusion-base': ['get', 'b'],
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-opacity': sheenOpacity(p),
          // OFF. The slab is 0.10 m tall; a vertical gradient over 0.10 m
          // blacks out the only face anyone sees.
          'fill-extrusion-vertical-gradient': false,
        },
      });
    }

    /**
     * THE CANOPY. `k:'cnp'` crowns from scripts/bake_ground.py's CANOPY block.
     *
     * NOT anchored under `under`, same as the channel and the steps: these are
     * 5-18 m extrusions and they have to sort against the buildings, the
     * bridges and the trees, not sit beneath the whole city.
     *
     * `fill-extrusion-base` is DERIVED, not baked — 647 crowns x 12 bytes of
     * `"b":4.62,` on a file that is not tiled and ships whole. The underside of
     * a crown carries no information the top does not.
     */
    if (GROUND.canopy && !map.getLayer(CANOPY)) {
      map.addLayer({
        id: CANOPY, type: 'fill-extrusion', source: SRC, minzoom: GROUND.minZoom,
        filter: ['==', ['get', 'k'], 'cnp'],
        paint: {
          'fill-extrusion-color': crownColour(p),
          'fill-extrusion-base': ['*', ['get', 'h'], GROUND.canopyBaseFrac],
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-opacity': GROUND.canopyOpacity,
          // ON. A crown is 3-12 m of vertical face and the gradient is what
          // turns a stack of prisms into a mass with shadow under it. This is
          // the same argument the bank courses make and the opposite of the
          // 0.22 m paths, which is the whole rule: gradient where the extrusion
          // is tall enough to have a side.
          'fill-extrusion-vertical-gradient': true,
        },
      });
    }

    if (GROUND.depth && !map.getSource(DSRC)) {
      map.addSource(DSRC, { type: 'geojson', data: 'data/depth.geojson' });
      map.addLayer({
        id: DEPTH, type: 'fill-extrusion', source: DSRC, minzoom: GROUND.minZoom,
        paint: {
          'fill-extrusion-color': depthColour(p),
          'fill-extrusion-base': ['get', 'b'],
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-opacity': 1,
          // OFF. A course is 0.14-0.62 m tall and the gradient darkens the
          // bottom of every extrusion, so every tread would carry a black band
          // as deep as the step itself. Same reason the tower bands turn it off.
          'fill-extrusion-vertical-gradient': false,
        },
      });
    }
  };

  /**
   * THE CARRIAGEWAY IS A POLYGON NOW, and it is the same fix, for the same
   * reason, as the one PR #70 made to the paths.
   *
   * "when im all the way down vertically and look at an angle towards the roads
   *  and start facing upright, the roads get bigger. some roads dont do this."
   *
   * The ones that DIDN'T were the sidewalks, because their width had already
   * been moved into the geometry. A `line-width` is a number of screen pixels
   * and it is the SAME number for the whole line, while 12 m of ground under
   * the camera is many pixels and 12 m of it by the horizon is a fraction of
   * one. Measured on merged main with scripts/verify/road-fan.mjs, camera on
   * the south end of Speedway looking north, layer `ground-road`:
   *
   *     pitch 20   1.10x at the only sample still on screen
   *     pitch 40   1.19x near  ->  1.77x far
   *     pitch 60   1.26x near  ->  3.33x far
   *     pitch 86   1.30x near  ->  3.69x far
   *
   * and that is over 900 m of road; the error keeps growing with distance, so
   * an arterial 4 km out was drawn about twenty times too wide. Pitching over
   * is what drags the far, wrong end of every road into frame -- which is
   * exactly "start facing upright and the roads get bigger".
   *
   * MapLibre has no per-vertex line width and no metres unit on `line-width`,
   * so NO expression can fix this. bake_ground.py's widen_roads() buffers each
   * centreline by half its tagged width and unions per (class, surface), and
   * `k:'roadarea'` polygons arrive width-correct: a fill gets the true
   * perspective for free at any pitch and any distance.
   *
   * WHAT STAYS ON THE CENTRELINE, and why each one is not the same defect:
   *   - lane markings   pinned at GROUND.laneMinPx (1.1 px) at every zoom the
   *                     camera flies, so they are already a constant hairline
   *   - stop bars       1.6 m of over-scale by declaration, 165 of them
   *   - bike lanes      drawn ON the carriageway from its centreline; these DO
   *                     still carry the defect and it is written down in
   *                     HANDOFF rather than half-fixed here
   *   - the far-field arterials, see GROUND.roadFarMaxPx
   */
  function addRoadLayers(map, pal, p, under) {
    const L = (id, opts) => { if (!map.getLayer(id)) map.addLayer(opts, under); };
    // FIRST, and unconditionally: leaving the basemap's own road lines on
    // paints a pale cream ribbon under every road we draw, and it shows at
    // every kerb. This used to sit behind the RSRC guard, so a missing roads
    // source gave you the basemap's roads AND ours.
    hideBasemapRoads(map);

    // The casing goes in FIRST so it sits under the pavement and only its outer
    // half shows -- a kerb line, not an outline. Same construction as the
    // paths' casing, and the same reason it is in pixels.
    L(ROAD_CASE, {
      id: ROAD_CASE, type: 'line', source: SRC,
      minzoom: GROUND.roadMinZoom, filter: ROADAREA_FILTER,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': darken(pal.asphalt, GROUND.roadCasingDark),
        'line-width': GROUND.roadKerbPx,
        'line-opacity': roadOpacityExpr(0.9),
      },
    });
    L(ROAD, {
      id: ROAD, type: 'fill', source: SRC,
      minzoom: GROUND.roadMinZoom, filter: ROADAREA_FILTER,
      paint: {
        'fill-color': roadColorExpr(pal),
        'fill-opacity': roadOpacityExpr(1),
        'fill-antialias': true,
      },
    });

    if (!map.getSource(RSRC)) {
      console.warn('[ground] no roads source; markings and the far armature are absent');
      return;
    }

    L(ROAD_FAR, {
      id: ROAD_FAR, type: 'line', source: RSRC, ...roadLP,
      minzoom: GROUND.roadMinZoom, filter: ROAD_FAR_FILTER,
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: {
        'line-color': roadColorExpr(pal),
        'line-width': roadFarWidthExpr(),
        'line-opacity': 0.9,
      },
    });

    // Bike lanes sit ON the carriageway, so they go over the road and under the
    // centre line — a lane marking crossing a bike lane is what the junction
    // actually looks like.
    if (GROUND.bike) {
      for (const [id, sideKey, sign] of [[BIKE_L, 'bl', -1], [BIKE_R, 'br', 1]]) {
        L(id, {
          id, type: 'line', source: RSRC, ...roadLP,
          minzoom: GROUND.bikeMinZoom, filter: bikeFilter(sideKey),
          layout: { 'line-join': 'round', 'line-cap': 'butt' },
          paint: {
            'line-color': bikeColorExpr(pal, sideKey),
            'line-width': bikeWidthExpr(),
            'line-offset': bikeOffsetExpr(sign),
            'line-opacity': GROUND.bikeOpacity,
          },
        });
      }
      // Separate `highway=cycleway` ways: the Shoal Creek and Waller Creek
      // trails, the Dell Med paths, the campus shared-use routes. They are not
      // a marking on a road, they are their own piece of ground -- which is
      // also why they are polygons now and the markings are not.
      L(CYCLE, {
        id: CYCLE, type: 'fill', source: SRC,
        minzoom: GROUND.bikeMinZoom, filter: CYCLEAREA_FILTER,
        paint: {
          'fill-color': cycleColorExpr(pal),
          'fill-opacity': ['interpolate', ['linear'], ['zoom'],
            GROUND.bikeMinZoom, 0, GROUND.bikeMinZoom + 1.0, GROUND.bikeOpacity],
          'fill-antialias': true,
        },
      });
    }

    if (GROUND.lanes) {
      L(LANE, {
        id: LANE, type: 'line', source: RSRC, ...roadLP,
        minzoom: GROUND.laneMinZoom, filter: LANE_FILTER(),
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: {
          'line-color': laneColorExpr(p),
          'line-width': laneWidthExpr(),
          'line-dasharray': GROUND.laneDash.slice(),
          'line-opacity': GROUND.laneOpacity,
        },
      });
    }
    if (GROUND.stopBars) {
      L(STOPBAR, {
        id: STOPBAR, type: 'line', source: RSRC, ...roadLP,
        minzoom: GROUND.stopBarMinZoom, filter: STOPBAR_FILTER,
        layout: { 'line-cap': 'butt' },
        paint: {
          'line-color': GROUND.stopBarColor,
          'line-width': stopBarWidthExpr(),
          'line-opacity': ['interpolate', ['linear'], ['zoom'],
            GROUND.stopBarMinZoom, 0,
            GROUND.stopBarMinZoom + 0.8, GROUND.stopBarOpacity],
        },
      });
    }
  }

  /**
   * Every basemap line off the `transportation` source-layer goes dark, and we
   * remember which ones we turned off so GROUND.roads = false can put them back
   * exactly. timeofday.js still writes `road`/`roadCasing` colours to these
   * layers on every tick; those writes are now harmless no-ops on a hidden
   * layer, which is the cheapest possible way to not have to edit that file.
   */
  function hideBasemapRoads(map) {
    if (_hiddenBasemapRoads.length) return;
    // Our road layers used to read from the same vector source and the same
    // `transportation` source-layer, so "every visible transportation line"
    // matched them too. It cost a real bug: toggling GROUND.roads back ON
    // showed the three layers and then this immediately hid them again on the
    // same call, and the frame proved it — our asphalt covered 27.8% of the
    // pose with roads on, 3.2% with them off, and 3.2% again after turning
    // them back on. They now sit on a geojson source and cannot match, but the
    // guard stays: it is one line, and the failure it prevents was invisible.
    const ours = new Set([ROAD, ROAD_CASE, ROAD_FAR, LANE, BIKE_L, BIKE_R, CYCLE, STOPBAR]);
    for (const l of map.getStyle().layers) {
      if (ours.has(l.id)) continue;
      if ((l['source-layer'] || '') !== 'transportation') continue;
      if (l.type !== 'line') continue;
      if ((l.layout && l.layout.visibility) === 'none') continue;
      try {
        map.setLayoutProperty(l.id, 'visibility', 'none');
        _hiddenBasemapRoads.push(l.id);
      } catch (e) {}
    }
  }
  function showBasemapRoads(map) {
    for (const id of _hiddenBasemapRoads) {
      try { map.setLayoutProperty(id, 'visibility', 'visible'); } catch (e) {}
    }
    _hiddenBasemapRoads = [];
  }

  window.applyGroundColors = function applyGroundColors(map, p) {
    if (!map || !map.getLayer || !map.getLayer(AREA)) return;
    const pal = paletteAt(p);
    const set = (id, prop, val) => { try { map.setPaintProperty(id, prop, val); } catch (e) {} };
    set(AREA, 'fill-color', jitterExpr(pal, GROUND.jitter));
    set(PATH, 'fill-extrusion-color', jitterExpr(pal, GROUND.pathJitter));
    set(PATH_CASE, 'line-color', jitterExpr(pal, GROUND.pathJitter, c => lighten(c, GROUND.kerbLight)));
    // The texture images carry no colour, so time of day only moves opacity —
    // no getImageData readback, no atlas upload, nothing per tick.
    set(TEX, 'fill-opacity', texOpacityExpr(p));
    set(BASE_TEX, 'background-opacity', baseTexOpacity(p));
    // `fill-extrusion-opacity`, not `fill-opacity`: both grain layers became
    // prisms so they would stop losing the depth test to the deck they sit on.
    // A retint is exactly where a layer-type change goes wrong in silence —
    // setPaintProperty on a property the layer does not have throws, the throw
    // is swallowed by `set`, and the layer simply stops following the clock.
    set(SPEEDWAY, 'fill-extrusion-opacity', speedwayTexOpacity(p));
    set(PATH_TEX, 'fill-extrusion-opacity', pathTexOpacity(p));
    // The close grain follows the same clock. Its tiles carry no colour, so
    // night is an opacity move here exactly as it is for TEX and BASE_TEX.
    set(CLOSE_AREA, 'fill-opacity', closeAreaOpacityExpr(p));
    set(CLOSE_ROAD, 'fill-opacity', closeRoadOpacityExpr(p));
    set(CLOSE_PATH, 'fill-extrusion-opacity', closePathOpacityExpr(p));
    set(DEPTH, 'fill-extrusion-color', depthColour(p));
    set(CHANNEL, 'fill-extrusion-color', bankColour(p));
    set(DECKL, 'fill-extrusion-color', bankColour(p));
    set(SHEEN, 'fill-extrusion-opacity', sheenOpacity(p));
    set(CANOPY, 'fill-extrusion-color', crownColour(p));
    // `fill-color` on the carriageway and the cycleways: they are polygons now.
    // The retint is where a layer-type change goes wrong silently, because
    // setPaintProperty on the wrong property throws into the `set` catch and
    // the road simply keeps its load-time colour through every hour of the day.
    set(ROAD, 'fill-color', roadColorExpr(pal));
    set(ROAD_FAR, 'line-color', roadColorExpr(pal));
    set(ROAD_CASE, 'line-color', darken(pal.asphalt, GROUND.roadCasingDark));
    set(LANE, 'line-color', laneColorExpr(p));
    set(BIKE_L, 'line-color', bikeColorExpr(pal, 'bl'));
    set(BIKE_R, 'line-color', bikeColorExpr(pal, 'br'));
    set(CYCLE, 'fill-color', cycleColorExpr(pal));
    // The stop bar is paint, and paint at night is whatever the headlights and
    // the signal give it. Same ramp as the lane markings.
    set(STOPBAR, 'line-color',
        lerpHex(GROUND.stopBarColor, '#0a0c12', nightAmt(p) * GROUND.laneNightFade));
  };

  /** Re-read GROUND after a live edit (widths, opacity, scale). */
  window.applyGroundSettings = function applyGroundSettings(map) {
    if (!map.getLayer(PATH)) return;
    const set = (id, prop, val) => { try { map.setPaintProperty(id, prop, val); } catch (e) {} };
    // PATH and SPEEDWAY carry their width in the GEOMETRY now (bake_ground.py
    // buffers the centreline), so there is no width to retune here. Changing
    // GROUND.widthScale means re-running the bake. The kerb is still paint.
    set(PATH_CASE, 'line-width', GROUND.kerbPx);
    set(PATH, 'fill-extrusion-height', GROUND.pathRaise);
    set(PATH, 'fill-extrusion-opacity', GROUND.pathOpacity);
    set(AREA, 'fill-opacity', GROUND.areaOpacity);
    // ROAD carries its width in the GEOMETRY now, exactly as PATH does, so
    // there is no width to retune here -- re-run scripts/bake_ground.py. The
    // kerb and the far armature are still paint.
    set(ROAD_CASE, 'line-width', GROUND.roadKerbPx);
    set(ROAD_FAR, 'line-width', roadFarWidthExpr());
    set(LANE, 'line-width', laneWidthExpr());
    set(LANE, 'line-dasharray', GROUND.laneDash.slice());
    set(LANE, 'line-opacity', GROUND.laneOpacity);
    set(BIKE_L, 'line-width', bikeWidthExpr());
    set(BIKE_R, 'line-width', bikeWidthExpr());
    set(BIKE_L, 'line-offset', bikeOffsetExpr(-1));
    set(BIKE_R, 'line-offset', bikeOffsetExpr(1));
    for (const id of [BIKE_L, BIKE_R]) set(id, 'line-opacity', GROUND.bikeOpacity);
    set(STOPBAR, 'line-width', stopBarWidthExpr());
    const p = window.__todCurrentP != null ? window.__todCurrentP : 0.5;
    set(TEX, 'fill-opacity', texOpacityExpr(p));
    set(BASE_TEX, 'background-opacity', baseTexOpacity(p));
    set(SPEEDWAY, 'fill-extrusion-opacity', speedwayTexOpacity(p));
    set(SPEEDWAY, 'fill-extrusion-base', GROUND.pathRaise);
    set(SPEEDWAY, 'fill-extrusion-height', GROUND.pathRaise + GROUND.pathTexLift);
    set(PATH_TEX, 'fill-extrusion-opacity', pathTexOpacity(p));
    set(PATH_TEX, 'fill-extrusion-base', GROUND.pathRaise);
    set(PATH_TEX, 'fill-extrusion-height', GROUND.pathRaise + GROUND.pathTexLift);
    set(CLOSE_AREA, 'fill-opacity', closeAreaOpacityExpr(p));
    set(CLOSE_ROAD, 'fill-opacity', closeRoadOpacityExpr(p));
    set(CLOSE_PATH, 'fill-extrusion-opacity', closePathOpacityExpr(p));
    set(CLOSE_PATH, 'fill-extrusion-base', GROUND.pathRaise + GROUND.pathTexLift);
    set(CLOSE_PATH, 'fill-extrusion-height',
        GROUND.pathRaise + GROUND.pathTexLift + GROUND.closePathLift);
    set(SHEEN, 'fill-extrusion-opacity', sheenOpacity(p));
    set(CANOPY, 'fill-extrusion-base', ['*', ['get', 'h'], GROUND.canopyBaseFrac]);
    set(CANOPY, 'fill-extrusion-opacity', GROUND.canopyOpacity);
    set(CANOPY, 'fill-extrusion-color', crownColour(p));

    const show = (id, on) => {
      try { map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); } catch (e) {}
    };
    for (const id of [AREA, PATH, PATH_CASE]) show(id, GROUND.on);
    show(CHANNEL, GROUND.on && GROUND.channel);
    show(DECKL, GROUND.on && GROUND.channel && GROUND.decks);
    show(SHEEN, GROUND.on && GROUND.channel && GROUND.creekSheen && GROUND.texture);
    show(CANOPY, GROUND.on && GROUND.canopy);
    show(TEX, GROUND.on && GROUND.texture);
    show(BASE_TEX, GROUND.on && GROUND.texture && GROUND.texGround);
    show(SPEEDWAY, GROUND.on && GROUND.texture && GROUND.speedway);
    show(PATH_TEX, GROUND.on && GROUND.texture && GROUND.pathTexture);
    show(CLOSE_AREA, GROUND.on && GROUND.texture && GROUND.close);
    show(CLOSE_PATH, GROUND.on && GROUND.texture && GROUND.close);
    show(CLOSE_ROAD, GROUND.on && GROUND.texture && GROUND.close && GROUND.roads);
    for (const id of [ROAD, ROAD_CASE, ROAD_FAR]) show(id, GROUND.on && GROUND.roads);
    show(LANE, GROUND.on && GROUND.roads && GROUND.lanes);
    for (const id of [BIKE_L, BIKE_R, CYCLE]) show(id, GROUND.on && GROUND.roads && GROUND.bike);
    show(STOPBAR, GROUND.on && GROUND.roads && GROUND.stopBars);
    // Turning our roads off has to give the basemap's back, or the scene ends
    // up with no roads at all and that reads as a broken layer, not a setting.
    if (GROUND.on && GROUND.roads) hideBasemapRoads(map); else showBasemapRoads(map);
  };
})();
