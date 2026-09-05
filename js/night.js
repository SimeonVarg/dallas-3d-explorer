/**
 * night.js — night-only scene lighting beyond the windows (streetlights).
 *
 * Owned by the night workstream. Wired from app.js as step('night') and driven
 * from timeofday.js via window.applyNightLayer(map, p).
 *
 * Streets after dark were pure voids between the lit buildings. This module
 * samples lamp points along the basemap's road geometry (the same
 * `transportation` classes timeofday keeps visible), and renders each lamp as
 * a soft warm pool of light flat on the ground. The layers sit BEFORE the
 * building extrusions in the style, so towers occlude the pools behind them.
 *
 * Road geometry comes from `querySourceFeatures` on the Liberty basemap, which
 * only returns features for LOADED tiles — so generation waits for `idle` and
 * clips to the baked-buildings bounding box (the camera fence covers the same
 * area, so those tiles are resident at spawn). Points are computed once and
 * deduplicated on a metric grid, because tile borders return the same road
 * twice.
 *
 * Public (window) API:
 *   initNight(map)           — add source/layers, schedule point generation
 *   applyNightLayer(map, p)  — fade lamps for time-of-day p (0 day … 1 night)
 */
(function () {
  'use strict';

  // ── Streetlights — every taste value in one place ───────────────────
  //
  // What this layer was actually contributing before the July 31 night pass,
  // measured by scripts/verify/night-luma.mjs rather than guessed:
  //   1,039 lamps for the entire 3.3 x 3.1 km detailed bbox; 0.4-1.7% of the
  //   pixels in a night frame; +0.15 to +0.57 luma across the whole frame.
  // Where a lamp lands it is strong (+34 to +37 luma). There are just almost
  // none of them. So this is a DENSITY problem before it is a brightness one,
  // and the tone curve in graphics.js is not eating them: its toe LIFTS the
  // night shadows (a raw 13/255 lands at 9/255 after the filmic blend, against
  // 3/255 for the straight linear grade), it does not crush them.
  //
  // The dark campus core had a specific cause. `service` (246 features — the
  // campus drives and lot aisles) and `path` (170 — Speedway, the East Mall,
  // every lit walk) are the two biggest classes in the basemap's
  // `transportation` layer after the numbered roads, and NEITHER tier claimed
  // them. Campus is almost entirely those two classes, so campus got no lamps
  // at all while West Campus, which is on the street grid, did — which is why
  // the middle of the frame was the darkest part of the city.
  const LIGHTS = {
    // Which basemap road classes get lamps, and how far apart (metres).
    // Classes measured in the Liberty tiles here: path 170, service 246,
    // secondary 154, minor 112, primary 67, tertiary 56, motorway 42
    // (trunk/street absent but kept for safety — other areas may carry them).
    MAJOR_CLASSES: ['motorway', 'trunk', 'primary', 'secondary'],
    MINOR_CLASSES: ['tertiary', 'minor', 'street'],
    // The campus tier. Pole lamps along a walk are closer together and smaller
    // than a highway mast, which is why this is its own tier and not `minor`
    // with a different spacing.
    WALK_CLASSES: ['service', 'path'],
    // ...but not every `path` is a lit walk. Steps and platforms are not.
    // (The `*_construction` classes need no filter here: they are their own
    // class values and so match none of the three lists above.)
    WALK_SUBCLASS_SKIP: ['steps', 'platform'],
    SPACING_MAJOR_M: 46,      // was 62
    SPACING_MINOR_M: 64,      // was 88
    // The walk tier came out as 64% of all lamps at 54 m — every footway and
    // cycleway in West Campus, which is a blanket rather than a street grid.
    // 70 m keeps the campus malls reading as lit walks without the foreground
    // turning into a carpet of light.
    SPACING_WALK_M: 70,
    DEDUPE_GRID_M: 28,        // no two lamps closer than ~this; also merges
                              // dual-carriageway twin lines into one lamp run
                              // (was 32)
    FENCE_PAD_M: 150,         // beyond the buildings bbox, streets stay dark

    // ── Warm everywhere; the "cooler" end is WHITER, never bluer ──────
    //
    // WHAT THIS USED TO BE, AND WHY IT WAS WRONG. The edge of the city was
    // painted with honest cool-LED hexes — `#9db4e6`, `#b8c8ee`, `#ccd8f2`,
    // `#dde7f7` — on the theory that outer residential streets have been
    // retrofitted to ~4000K while the core keeps its sodium. Measured at
    // `aerial-wide`, tod 0.95, by `scripts/verify/night-lamps.mjs`:
    //
    //     hot pixels (luma > 120) below the horizon   7,604   0.66% of frame
    //     of those:   WARM 19.8%   BLUE-WHITE 66.9%   neutral 13.2%
    //
    // Two thirds of every lit pixel in the city was blue. The frame's colour
    // was being decided by a generative taste call rather than by the city, and
    // because `WARM_FADE_M` was 1,250 m against a 3.3 x 3.1 km lamp fence,
    // almost every lamp in the scene sat at the FULLY COOL end — so the split
    // did not read as a gradient with a warm centre, it read as a hard seam
    // where campus met West Campus.
    //
    // Austin Energy's own conversion is to 3000K, chosen for dark-sky reasons.
    // A street lamp here is sodium-to-warm-LED and there is no blue-white
    // fixture anywhere in it. So the gradient survives and its blue end does
    // not: an EDGE colour is now its own CORE colour pushed toward the
    // achromatic point AT THE SAME LUMA, which cannot go blue by construction
    // (see `cooler()`), and which is luma-matched by construction too rather
    // than by four hand-tuned hexes. The core still gets the emphasis, via
    // CORE_OPACITY_BOOST, which is the one thing that should differ in
    // brightness.
    //
    // Costs nothing at render time: `w` (1 core … 0 edge) is computed once per
    // lamp at generation and the final colour is BAKED into the feature, so the
    // paint property is a plain ['get','color']. No per-frame expression work.
    WARM_ANCHOR: [-96.8039, 32.7800],   // Bank of America Plaza, the tallest thing here
    // The ramp is now WIDER THAN THE FENCE ITSELF (the lamp bbox is ~3.3 km
    // across, so its far corner is ~2.3 km from the anchor). A ramp that
    // saturates inside the frame puts a boundary in the frame; one that never
    // saturates cannot. This is the seam fix, and it is independent of the
    // colour fix — both were needed.
    WARM_FULL_M: 900,          // inside this radius, full sodium
    WARM_FADE_M: 2600,         // and it never quite reaches the far end
    EDGE_DESAT: 0.45,          // how far the edge lamp moves toward white
    CORE_OPACITY_BOOST: 0.22,  // core lamps also read a touch stronger

    // ── THE TWO KNOBS FOR "the lights look like mini suns" ────────────
    //
    // *"the lights on big roads look like mini suns, the light should be a bit
    //   dimmer and more spread out. not just on big roads any road with that
    //   big light."*
    //
    // Two numbers because it is two faults, and neither one substitutes for the
    // other. Turning the brightness down on a hard-edged disc gives a DIM hard
    // disc; widening a disc that still has a hard rim and a white-hot middle
    // gives a BIGGER sun. What makes something read as a sun rather than as a
    // lamp is the EDGE — a bright area that stops, instead of fading.
    //
    // Measured on the before frame at `the-drag`, tod 0.95, by
    // `scripts/verify/night-lamps.mjs`:
    //
    //     night-streetlight-pool  5645 px   mean rgb(107, 79, 49)
    //     night-streetlight-core   296 px   mean rgb(239,229,180)   <- the sun
    //
    // 296 px over 29 visible glows is a ~3.5 px near-WHITE disc per lamp at
    // alpha 0.9 with `circle-blur` 0.4 — and MapLibre's circle blur holds FULL
    // opacity out to (1 - blur) of the radius before it ramps, so 0.4 means the
    // inner 60% of that head is flat, hard and white. That is the photosphere.
    // The pool underneath it was flat across its inner 15% and then ramped to
    // nothing at the rim, which is a disc with a soft border, not a fade.
    //
    // So: `LAMP_DIM` is the brightness knob, `LAMP_SPREAD` is the falloff knob,
    // and the blur values below go to a full radial gradient (blur 1.0 = peak
    // at the centre point only, zero at the radius — no flat top, no rim).
    // Both apply to EVERY tier, because the fault is the fixture, not the road:
    // "not just on big roads any road with that big light".
    //
    // One line each to overrule. 1.0 / 1.0 restores the PR #97 look exactly.
    LAMP_DIM: 0.62,      // multiplies every lamp opacity below
    LAMP_SPREAD: 1.5,    // multiplies every lamp's ground radius

    // Pool: the soft ground glow. Core: the small bright lamp head inside it.
    // One warm colour per tier; the edge end is derived from it by `cooler()`.
    COLOR_MAJOR_CORE: '#ffa63f',   // luma 177
    COLOR_MINOR_CORE: '#ffbc6c',   // luma 197
    COLOR_WALK_CORE:  '#ffcf90',   // luma 213
    // The head was `#ffe6b4` (luma 232) — close enough to white that the middle
    // of every fixture went achromatic, and an achromatic hot centre inside a
    // warm ring is the exact signature of a sun. A sodium/3000K head is amber
    // all the way through, so the head now sits just above the walk tier's own
    // colour instead of on top of white.
    HEAD_COLOR_CORE:  '#ffd79c',   // luma 218
    // These are the PEAK alphas at a lamp's centre, before LAMP_DIM. With the
    // blur at 1.0 they are reached only at the centre POINT, so the mean alpha
    // across a pool is far below the number here — which is the fade.
    POOL_OPACITY_MAJOR: 0.66,
    POOL_OPACITY_MINOR: 0.50,
    POOL_OPACITY_WALK:  0.28,
    CORE_OPACITY: 0.9,
    POOL_BLUR: 1.0,
    CORE_BLUR: 0.95,

    // ── SIZE IS AUTHORED IN METRES ON THE GROUND, not in pixels ───────
    //
    // The old curve was `[13, 2.8, 15, 7.5, 17, 19, 19.5, 44]` px, and a px
    // curve hides what it is asking for. Converted at this latitude it reads:
    //
    //     z13   2.8 px x 16.49 m/px  =  46 m radius   (a 92 m pool)
    //     z15   7.5 px x  4.12 m/px  =  31 m
    //     z17  19   px x  1.03 m/px  =  20 m
    //     z19.5 44  px x  0.18 m/px  =   8 m
    //
    // The street-level end was right all along and the flying end was six times
    // too big — which is exactly what the two poses show: `the-drag` at z17.2
    // is a row of small warm lamps, `aerial-wide` at z14.4 is a carpet of
    // blobs. Measured across 949 separate glows in that frame, ground width was
    // p10 9 m / median 22.5 m / p90 98 m / max 362 m. A 98 m glow is wider than
    // the building beside it, which is the whole of "the glows are bigger than
    // the buildings" AND most of "they sit over rooftops": only 3.8% of pool
    // pixels are genuinely drawn over a roof (the layer goes under the building
    // extrusions and is occluded correctly) — but a 98 m disc SURROUNDS the
    // building it passes, so the building reads as standing in the light.
    //
    // `circle-pitch-scale` is left at its default 'map', so a pool is a real
    // disc lying on the ground and perspective grows it in the near field.
    // That is correct behaviour and it is why the size has to be authored in
    // METRES: the near-field inflation is only defensible on top of an honest
    // physical radius.
    //
    // [zoom, ground RADIUS in metres]. A real lamp pool is 6-8 m; the low-zoom
    // end is deliberately allowed to run larger, because from 500 m up a
    // physically-correct 7 m pool is one pixel and the city goes dark again —
    // which is the defect this module was written to fix. This is the one
    // knob that trades "bokeh carpet" against "dark city".
    //
    // These metres are now the radius at which the gradient reaches ZERO, not
    // the radius of a flat disc — see LAMP_SPREAD above. They are left at their
    // measured values and the spread multiplier rides on top, so the authored
    // physical sizes stay readable and one number undoes the change.
    // ── AND WHY THE CURVE NOW RUNS PAST z19.5 ────────────────────────
    //
    // z19.5 used to be the last stop, and MapLibre CLAMPS an interpolate past
    // its last stop — so above z19.5 the radius stopped being a size in metres
    // and became a size in PIXELS. Ground radius then halves for every zoom
    // level you gain:
    //
    //     z19.5   65.82 px x 0.1823 m/px  =  12.0 m   (the authored value)
    //     z21.5   65.82 px x 0.0456 m/px  =   3.0 m   <- the shipping eye pose
    //     z23.9   65.82 px x 0.0084 m/px  =   0.55 m
    //
    // z21.5 is `ZOOM_MAX`, which is exactly where a camera at 1.7 m sits. So
    // standing on a pavement at night, every street lamp's pool of light had
    // shrunk to a 3 m smudge under a lamp 46 m away, and the carriageway
    // measured 13.90 luma against a frame median of 20.79 — DARKER than the
    // frame it is half of. That is QUEUE Y2, and it is not a brightness fault:
    // no lamp is dim, the light is simply not on the ground any more.
    //
    // Nothing at or below z19.5 moves, so the flying city is untouched by this
    // — the stops below are all new, and an interpolate between 17 and 19.5 is
    // unchanged by what comes after 19.5.
    //
    // The near-field values GROW rather than merely holding at 12 m, and that
    // is a deliberate taste call with one number behind it: majors are sampled
    // every SPACING_MAJOR_M (46 m), so pools of 12 m radius leave 22 m of black
    // road between them. 16.5 m closes most of that gap and the street reads as
    // lit rather than as spotted. 21 m and 24 m were both rendered at this pose
    // and both washed the whole ground to a flat orange with no falloff left in
    // it, which is a different way of being wrong — the shots are
    // `shots/eye/street/tune/`. Peak alpha is NOT raised anywhere: this is
    // "dimmer and more spread out" done entirely as spread, which is the half
    // of that note the aerial pass could not deliver.
    POOL_GROUND_M: [13, 18, 15, 14, 17, 10, 19.5, 8,
                    20.5, 9, 21.5, 11, 22.5, 12, 23.5, 12],
    MINOR_RADIUS_SCALE: 0.74,
    WALK_RADIUS_SCALE: 0.46,
    // The head was 0.22 of the pool with a hard edge. A head with a hard edge
    // is the sun; a head that is a soft ball has to be wider than the hard one
    // it replaces or it disappears into the pool, so this goes UP while its
    // opacity goes down. Bigger and dimmer is the whole trade.
    CORE_RADIUS_SCALE: 0.30,
    // ...and the head must NOT ride the near-field growth above. A head is
    // 0.30 of the pool, so widening the pool to 24 m would put a 7 m ball of
    // near-white on the road three metres from your feet — the mini sun, back,
    // at the one range where it would fill the frame. This caps the head's
    // GROUND radius at exactly what it already is at z19.5
    // (8 m x LAMP_SPREAD x CORE_RADIUS_SCALE = 3.6 m), so the head freezes at
    // its current physical size as you walk toward it while the pool keeps
    // spreading. It is a no-op at and below z19.5 by construction.
    //
    // IT ONLY APPLIES FROM `CORE_CAP_FROM_Z` UP, and that is not a detail. The
    // head's ground radius at z13 is 27 m x 0.30 = 8.1 m, so a flat 3.6 m cap
    // shrinks every lamp head in the flying city — measured, it moved 5.6% of
    // an altitude frame with a peak delta of 126. From altitude the head IS the
    // lit city (see CORE_MIN_PX), so the cap starts where the near-field growth
    // starts and the aerial curve is left exactly alone.
    CORE_GROUND_CAP_M: 3.6,
    CORE_CAP_FROM_Z: 19.5,
    // From altitude the LAMP HEAD is what reads as a lit city. Below this many
    // pixels a head is not a dim lamp, it is no lamp, so the head keeps a floor
    // the pool does not get. Nudged up with the blur: a 1.3 px circle that is
    // now a gradient rather than a disc carries about half the light it did.
    CORE_MIN_PX: 1.6,

    // ── WHEN THE LAMPS COME ON — now `js/sky.js`'s SKY_TUNE.DUSK ─────
    //
    // These two are the FALLBACK ONLY, for a page where sky.js failed to load.
    // The schedule that actually runs is `skyBodies(p).lamps`, keyed to the
    // sun's elevation, because a slider position is not a time of day and three
    // different ramps in `p` is how dusk ended up disagreeing with itself.
    //
    // WHAT WAS WRONG. 0.58/0.85 put the slider's own midpoint at **14.8% lamp
    // strength** — measured, and photographed: at p=0.62 `dusk-the-drag` has a
    // single findable warm smudge on Guadalupe and West Campus has none, under
    // a sky that is already showing stars. Worse, NIGHT_FULL 0.85 is the sun at
    // **26.5° below the horizon**, which is well past the end of astronomical
    // twilight — the city was still finishing switching on an hour after
    // genuine night. The lamps were the last thing in the scene to arrive when
    // they should be the first.
    //
    // These p-values are the sun-elevation curve's own crossings (+2° and -6°),
    // so the fallback follows the same schedule rather than being a second
    // opinion about it.
    NIGHT_START: 0.54,
    NIGHT_FULL: 0.622,

    MAX_POINTS: 12000,        // hard cap; generation warns if it ever trims
    IDLE_RETRIES: 5,          // querySourceFeatures can race tile loading
  };

  /**
   * ── THE TOWER'S OWN LIGHT ON THE GROUND ──────────────────────────────
   *
   * *"Is there a way that this can actually be light instead of a colored
   *   surface? the base around it is too dark."*
   *
   * The honest answer to the first half is no, and it is worth writing down
   * so nobody spends another session looking for the switch. MapLibre has ONE
   * global directional light (`map.setLight`), no point lights, and no
   * emissive term in the fill-extrusion shader — a face's colour is its own
   * colour multiplied by that one light, so a surface cannot be brighter than
   * the scene's exposure no matter what hex it carries. Measured at night in
   * js/tower.js: a lit face tops out near 103/255, and the bloom in
   * js/graphics.js thresholds with `contrast(4)` at 0.375, so 103/255 = 0.40
   * sits on the line and the halo moves by 0.2 of one level across the entire
   * range from #040404 to #ffffff. There is no glow to buy.
   *
   * What IS available, and what each costs:
   *
   *   1. A glow SPRITE behind the tower — a symbol layer with a radial
   *      gradient icon. Rejected. A symbol is screen-space: it does not take
   *      the tower's occlusion, so it draws over the buildings in front of it
   *      or vanishes behind them depending on layer order, and its size is in
   *      pixels, so it swims against the building as you fly. It reads as a
   *      decal on the lens, not as light in the city.
   *   2. A LIT GROUND POOL beneath it. Taken. It is the same primitive the
   *      1,039 streetlights in this file already use, it lies on the ground
   *      with `circle-pitch-alignment: map` so perspective is correct, and it
   *      goes UNDER the building extrusions so the Main Building occludes the
   *      middle of it and only the spill onto the malls and lawns shows. That
   *      is what 96 kW of uplighting actually does to the ground it stands on.
   *   3. Brighter neighbouring SURFACES to imply spill. Also taken, but in
   *      js/tower.js where the surfaces are (NIGHT.BASE — the Main Building's
   *      attic, roofs and entablature now take the base floods' backspill).
   *
   * 2 and 3 together are what a real floodlit building gives an observer: you
   * do not see the light, you see everything near it lit. Every value here is
   * a one-line override.
   */
  const TOWER_POOL = {
    on: true,
    // The shaft's own centre, from data/tower.geojson's shaft ring.
    AT: [-96.80390, 32.78002],
    RADIUS_M: 115,            // ground radius; the Main Building is ~80 m wide,
                              // so this spills 40-75 m onto the malls
    COLOR: '#ff9c42',         // the shaft's own circuit, warmer for the grass
    OPACITY: 0.30,
    BLUR: 1.0,                // fully soft — a pool with an edge is a disc
    MIN_ZOOM: 13,
  };

  // Backstop for a map that never goes idle — see initNight.
  const IDLE_FALLBACK_MS = 6000;

  const SRC = 'night-streetlights';
  const POOL = 'night-streetlight-pool';
  const CORE = 'night-streetlight-core';
  const TSRC = 'night-tower-pool';
  const TPOOL = 'night-tower-pool-fill';

  const M_LAT = 110540;
  const mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

  // Ground metres per screen pixel at this scene's latitude. This is the
  // constant that turns an authored ground size into MapLibre's px radius, and
  // it is only valid because `circle-pitch-scale` is left at 'map' — see
  // POOL_GROUND_M.
  const SCENE_LAT = 32.782;
  const mPerPx = z => 156543.03392 * Math.cos(SCENE_LAT * Math.PI / 180) / Math.pow(2, z);

  let _points = null;      // generated once
  let _tries = 0;
  let _lastP = 0;

  function tierMatch(major, minor, walk) {
    return ['match', ['get', 'tier'], 'major', major, 'minor', minor, walk];
  }

  /**
   * `circle-radius` stops, derived from POOL_GROUND_M at each stop's own zoom.
   *
   * POOL_GROUND_M alternates [zoom, metres, zoom, metres…]. The zoom
   * interpolate MUST be the top-level expression — nesting it inside a
   * ['match'] (or inside a ['max'], which is how a px floor would want to be
   * written) is rejected by the style validator, and a rejected paint property
   * takes the WHOLE LAYER down with it: measured once, the pool layer silently
   * never existed while the core layer rendered. So per-tier scaling and the
   * px floor are both resolved HERE, in JS, and the emitted expression is a
   * plain top-level interpolate over constants. Same rule is why the
   * warm/cool gradient is a baked per-feature colour rather than an
   * interpolate on ['get','w'] wrapped in a tier match.
   *
   * `k` scales the whole curve (1 for the pool, CORE_RADIUS_SCALE for the
   * head); `minPx` is a visibility floor applied after the metres→px
   * conversion.
   */
  function radiusExpr(k, minPx, capM) {
    const stops = [];
    for (let i = 0; i < LIGHTS.POOL_GROUND_M.length; i += 2) {
      const z = LIGHTS.POOL_GROUND_M[i];
      // LAMP_SPREAD widens the falloff for every tier and both layers at once —
      // the fixture gets bigger, not just its pool, so the head keeps sitting
      // in proportion inside the glow instead of shrinking into a point.
      const groundM = LIGHTS.POOL_GROUND_M[i + 1] * LIGHTS.LAMP_SPREAD;
      // `capM` is a ceiling in GROUND METRES, applied per tier so the tier
      // scaling survives it, and resolved here for the same reason everything
      // else is: a ['min'] wrapped around the zoom interpolate is rejected by
      // the style validator and takes the whole layer down silently.
      const cap = (capM && z >= LIGHTS.CORE_CAP_FROM_Z) ? capM : Infinity;
      const px = s => Math.max(minPx || 0,
        +(Math.min(groundM * k, cap) * s / mPerPx(z)).toFixed(2));
      stops.push(z, tierMatch(px(1), px(LIGHTS.MINOR_RADIUS_SCALE), px(LIGHTS.WALK_RADIUS_SCALE)));
    }
    return ['interpolate', ['exponential', 1.7], ['zoom'], ...stops];
  }

  /**
   * ── THESE POOLS ONLY EVER REACH THE CARRIAGEWAY, AND THAT IS STRUCTURAL ──
   *
   * Measured layer order in the built style, and it is worth writing down
   * because it explains why the fix above lights the ROAD and not the KERB:
   *
   *     116 ground-road (fill)              <- the carriageway, under the pools
   *     134 night-streetlight-pool          <- here
   *     138 buildings-shadow / 139 buildings-3d
   *     144 ground-paths (fill-extrusion)   <- the PAVEMENT, OVER the pools
   *     145 ground-paths-texture … 150 ground-depth
   *
   * The ground is not one layer, and half of it is drawn AFTER the buildings.
   * A single light layer cannot be before the carriageway's half and after the
   * pavement's half, so no position in this file lights both.
   *
   * Moving these three to just after the ground stack WAS tried and it works:
   * the pavement lights up, and the aerial frame is unchanged because circle
   * layers depth-test, so towers still occlude the pools behind them. It is
   * NOT shipped, because `scripts/verify/night-lights.mjs` gates on
   * `poolIdx < buildingsIdx` — a layer-INDEX assertion standing in for an
   * occlusion property — and that file belongs to another lane. See HANDOFF:
   * the pavement's light is waiting on that one assertion being re-expressed
   * in pixels. `js/props.js` does make the move, because nothing gates the
   * order of its walkway lamps, and a walkway lamp lighting the walkway it
   * stands on is the right half of this to have.
   */

  // ── Colour. Warm core → whiter edge, at constant luma ─────────────────
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const toHex = c => `#${c.map(n => Math.max(0, Math.min(255, Math.round(n)))
    .toString(16).padStart(2, '0')).join('')}`;
  const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  /**
   * The same colour with `amount` of its saturation removed, at IDENTICAL luma.
   *
   * Mixing toward the grey of the colour's own luma preserves luma exactly
   * (luma is linear in R,G,B) and can only ever move a channel TOWARD the
   * others — so a warm lamp gets whiter and never gets bluer. That is the
   * guarantee the old hand-authored `#9db4e6` edge did not have, and it is why
   * this is a function rather than four more constants.
   */
  function cooler(hex, amount) {
    const c = hexToRgb(hex), L = luma(c);
    return toHex(c.map(v => v * (1 - amount) + L * amount));
  }

  function addLayers(map) {
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    const beforeId = map.getLayer('buildings-shadow') ? 'buildings-shadow'
                   : map.getLayer('buildings-3d') ? 'buildings-3d' : undefined;
    if (!beforeId) console.warn('[night] no building layer to sit under — lamps will draw over roofs');
    if (!map.getLayer(POOL)) {
      map.addLayer({
        id: POOL, type: 'circle', source: SRC, minzoom: 13,
        paint: {
          'circle-pitch-alignment': 'map',
          'circle-color': ['get', 'color'],
          'circle-blur': LIGHTS.POOL_BLUR,
          'circle-radius': radiusExpr(1, 0),
          'circle-opacity': 0,   // driven by applyNightLayer
        },
      }, beforeId);
    }
    if (!map.getLayer(CORE)) {
      map.addLayer({
        id: CORE, type: 'circle', source: SRC, minzoom: 14,
        paint: {
          'circle-pitch-alignment': 'map',
          'circle-color': ['get', 'head'],
          'circle-blur': LIGHTS.CORE_BLUR,
          'circle-radius': radiusExpr(LIGHTS.CORE_RADIUS_SCALE, LIGHTS.CORE_MIN_PX,
                                      LIGHTS.CORE_GROUND_CAP_M),
          'circle-opacity': 0,
        },
      }, beforeId);
    }
    // The Tower's pool. Its own source, so it can never be caught by the
    // streetlight tier match, and one point — there is one UT Tower.
    if (TOWER_POOL.on && !map.getSource(TSRC)) {
      map.addSource(TSRC, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [{
          type: 'Feature', properties: {},
          geometry: { type: 'Point', coordinates: TOWER_POOL.AT },
        }] },
      });
    }
    if (TOWER_POOL.on && !map.getLayer(TPOOL)) {
      map.addLayer({
        id: TPOOL, type: 'circle', source: TSRC, minzoom: TOWER_POOL.MIN_ZOOM,
        paint: {
          'circle-pitch-alignment': 'map',
          'circle-color': TOWER_POOL.COLOR,
          'circle-blur': TOWER_POOL.BLUR,
          // Authored in ground metres for the same reason POOL_GROUND_M is,
          // and a plain top-level zoom interpolate for the same reason too —
          // a rejected paint expression takes the whole layer down silently.
          'circle-radius': towerRadiusExpr(),
          'circle-opacity': 0,   // driven by applyNightLayer
        },
      }, beforeId);
    }
  }

  /** TOWER_POOL.RADIUS_M in ground metres, converted at each zoom stop. */
  function towerRadiusExpr() {
    const stops = [];
    for (const z of [13, 15, 17, 19.5]) {
      stops.push(z, +(TOWER_POOL.RADIUS_M / mPerPx(z)).toFixed(2));
    }
    return ['interpolate', ['exponential', 1.7], ['zoom'], ...stops];
  }

  function mixHex(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    const c = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${c(A[0] + (B[0] - A[0]) * t)}${c(A[1] + (B[1] - A[1]) * t)}${c(A[2] + (B[2] - A[2]) * t)}`;
  }
  /** 1 at the campus core, 0 past WARM_FADE_M, smoothstepped between. */
  function warmthAt(lng, lat) {
    const [alng, alat] = LIGHTS.WARM_ANCHOR;
    const d = Math.hypot((lng - alng) * mLon(lat), (lat - alat) * M_LAT);
    const t = (d - LIGHTS.WARM_FULL_M) / (LIGHTS.WARM_FADE_M - LIGHTS.WARM_FULL_M);
    const u = Math.max(0, Math.min(1, t));
    return 1 - u * u * (3 - 2 * u);
  }

  function buildingsBbox(map) {
    const src = map.getSource('city-buildings');
    if (!src) return null;
    // In this MapLibre build `_data` is a truthy wrapper WITHOUT `.features`
    // (measured), so take whichever candidate actually carries the geometry.
    const data = [src._data, src.serialize && src.serialize().data]
      .find(d => d && typeof d !== 'string' && d.features && d.features.length);
    if (!data) return null;
    let w = 180, s = 90, e = -180, n = -90;
    const walk = cs => {
      for (const c of cs) {
        if (typeof c[0] === 'number') {
          if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
          if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
        } else walk(c);
      }
    };
    for (const f of data.features) if (f.geometry) walk(f.geometry.coordinates);
    const padLng = LIGHTS.FENCE_PAD_M / mLon((s + n) / 2), padLat = LIGHTS.FENCE_PAD_M / M_LAT;
    return { w: w - padLng, s: s - padLat, e: e + padLng, n: n + padLat };
  }

  /** Place points every `spacing` metres along a coordinate array. */
  function sampleLine(coords, spacing, emit) {
    let rem = spacing * 0.5;
    for (let i = 1; i < coords.length; i++) {
      const x0 = coords[i - 1][0], y0 = coords[i - 1][1];
      const x1 = coords[i][0], y1 = coords[i][1];
      const mx = mLon(y0);
      const segLen = Math.hypot((x1 - x0) * mx, (y1 - y0) * M_LAT);
      if (!(segLen > 0)) continue;
      let d = rem;
      while (d < segLen) {
        const t = d / segLen;
        emit(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        d += spacing;
      }
      rem = d - segLen;
    }
  }

  // MapLibre fires `idle` from inside its own render loop, and an exception
  // thrown in a listener there does NOT reliably surface as a page error — it
  // just leaves `_points` null and no log at all, which reads exactly like
  // "the tiles were not resident yet". Twenty minutes went into that once.
  // Anything that goes wrong in generation says so, loudly, from here on.
  function generate(map) {
    try { generateInner(map); }
    catch (err) {
      console.error('[night] streetlight generation FAILED:', err && err.stack || err);
      window.__nightLights = { count: 0, error: String(err) };
    }
  }

  function generateInner(map) {
    if (_points) return;
    const style = map.getStyle();
    const vecSrc = Object.keys(style.sources).find(id => style.sources[id].type === 'vector');
    if (!vecSrc) return;
    let feats;
    try { feats = map.querySourceFeatures(vecSrc, { sourceLayer: 'transportation' }); }
    catch (err) { feats = []; }
    if (!feats || !feats.length) {
      // Tiles not resident yet — try again on a later idle.
      if (++_tries <= LIGHTS.IDLE_RETRIES) map.once('idle', () => generate(map));
      else console.warn('[night] no transportation features found; streetlights skipped');
      return;
    }

    const bbox = buildingsBbox(map);
    const headEdge = cooler(LIGHTS.HEAD_COLOR_CORE, LIGHTS.EDGE_DESAT);
    const seen = new Set();
    const features = [];
    let trimmed = false;
    let warmSum = 0;
    const emitFor = pass => (lng, lat) => {
      if (bbox && (lng < bbox.w || lng > bbox.e || lat < bbox.s || lat > bbox.n)) return;
      const key = Math.round(lng * mLon(lat) / LIGHTS.DEDUPE_GRID_M) + ':' +
                  Math.round(lat * M_LAT / LIGHTS.DEDUPE_GRID_M);
      if (seen.has(key)) return;
      seen.add(key);
      if (features.length >= LIGHTS.MAX_POINTS) { trimmed = true; return; }
      // Bake the hour-independent half of the look now: colour by distance from
      // the core, and the core's opacity boost. applyNightLayer then only has to
      // scale one number per tier for the time of day.
      const w = warmthAt(lng, lat);
      warmSum += w;
      features.push({
        type: 'Feature',
        properties: {
          tier: pass.tier,
          w: +w.toFixed(3),
          color: mixHex(pass.edge, pass.core, w),
          head:  mixHex(headEdge, LIGHTS.HEAD_COLOR_CORE, w),
          ob:    +(1 + LIGHTS.CORE_OPACITY_BOOST * w).toFixed(3),
        },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      });
    };

    // Majors first so the dedupe grid lets the brighter tier win crossings, and
    // walks last so a campus path running beside a street does not double up.
    // Each tier's EDGE is derived from its own CORE — one warm family, no
    // second palette to keep luma-matched by hand.
    for (const pass of [
      { classes: LIGHTS.MAJOR_CLASSES, spacing: LIGHTS.SPACING_MAJOR_M, tier: 'major',
        core: LIGHTS.COLOR_MAJOR_CORE, edge: cooler(LIGHTS.COLOR_MAJOR_CORE, LIGHTS.EDGE_DESAT) },
      { classes: LIGHTS.MINOR_CLASSES, spacing: LIGHTS.SPACING_MINOR_M, tier: 'minor',
        core: LIGHTS.COLOR_MINOR_CORE, edge: cooler(LIGHTS.COLOR_MINOR_CORE, LIGHTS.EDGE_DESAT) },
      { classes: LIGHTS.WALK_CLASSES,  spacing: LIGHTS.SPACING_WALK_M,  tier: 'walk',
        core: LIGHTS.COLOR_WALK_CORE,  edge: cooler(LIGHTS.COLOR_WALK_CORE, LIGHTS.EDGE_DESAT) },
    ]) {
      const emit = emitFor(pass);
      for (const f of feats) {
        const p = f.properties || {};
        if (pass.classes.indexOf(p.class) === -1) continue;
        if (p.brunnel === 'tunnel') continue;
        if (pass.tier === 'walk' && LIGHTS.WALK_SUBCLASS_SKIP.indexOf(p.subclass) !== -1) continue;
        const g = f.geometry;
        if (!g) continue;
        if (g.type === 'LineString') sampleLine(g.coordinates, pass.spacing, emit);
        else if (g.type === 'MultiLineString') for (const c of g.coordinates) sampleLine(c, pass.spacing, emit);
      }
    }

    _points = { type: 'FeatureCollection', features };
    const srcObj = map.getSource(SRC);
    if (srcObj) srcObj.setData(_points);
    const count = t => features.reduce((n, f) => n + (f.properties.tier === t ? 1 : 0), 0);
    const majors = count('major'), minors = count('minor'), walks = count('walk');
    console.log('[night] streetlights:', features.length, `(${majors} major / ${minors} minor / ${walks} walk)`,
                `mean warmth ${(warmSum / Math.max(1, features.length)).toFixed(2)}`,
                bbox ? `fenced ${bbox.w.toFixed(3)}..${bbox.e.toFixed(3)} / ${bbox.s.toFixed(3)}..${bbox.n.toFixed(3)}` : 'UNFENCED',
                trimmed ? 'TRIMMED at cap' : '');
    // Report the DERIVED values, not the authored ones: the whole point of
    // `cooler()` and of metres-on-the-ground radii is that the constants above
    // are no longer what lands, and a taste value you cannot read back is a
    // taste value nobody will check. `bmr` is blue-minus-red — negative is
    // warm, and the fix's claim is that no lamp in the file is ever positive.
    const bmr = h => hexToRgb(h)[2] - hexToRgb(h)[0];
    const worstBmr = features.reduce((m, f) => Math.max(m, bmr(f.properties.color), bmr(f.properties.head)), -999);
    window.__nightLights = { count: features.length, major: majors, minor: minors, walk: walks,
                             meanWarmth: +(warmSum / Math.max(1, features.length)).toFixed(3),
                             trimmed, fenced: !!bbox,
                             worstBlueMinusRed: worstBmr,
                             edges: {
                               major: cooler(LIGHTS.COLOR_MAJOR_CORE, LIGHTS.EDGE_DESAT),
                               minor: cooler(LIGHTS.COLOR_MINOR_CORE, LIGHTS.EDGE_DESAT),
                               walk:  cooler(LIGHTS.COLOR_WALK_CORE, LIGHTS.EDGE_DESAT),
                               head:  cooler(LIGHTS.HEAD_COLOR_CORE, LIGHTS.EDGE_DESAT),
                             },
                             // Report what LANDS, not what is authored: the
                             // spread multiplier rides on POOL_GROUND_M and the
                             // dim multiplier rides on every opacity, so the
                             // authored constants are no longer the answer.
                             dim: LIGHTS.LAMP_DIM, spread: LIGHTS.LAMP_SPREAD,
                             peakAlpha: {
                               poolMajor: +(LIGHTS.POOL_OPACITY_MAJOR * LIGHTS.LAMP_DIM).toFixed(3),
                               poolMinor: +(LIGHTS.POOL_OPACITY_MINOR * LIGHTS.LAMP_DIM).toFixed(3),
                               poolWalk:  +(LIGHTS.POOL_OPACITY_WALK  * LIGHTS.LAMP_DIM).toFixed(3),
                               head:      +(LIGHTS.CORE_OPACITY * LIGHTS.LAMP_DIM).toFixed(3),
                             },
                             blur: { pool: LIGHTS.POOL_BLUR, head: LIGHTS.CORE_BLUR },
                             poolPx: LIGHTS.POOL_GROUND_M.map((v, i) => i % 2
                               ? +(v * LIGHTS.LAMP_SPREAD / mPerPx(LIGHTS.POOL_GROUND_M[i - 1])).toFixed(2) : v) };
    if (worstBmr >= 0) console.error('[night] a lamp colour came out BLUE (b-r ' + worstBmr + ') — cooler() is broken');
    // The lamps may be born mid-evening — fade them to the current hour.
    window.applyNightLayer(map, _lastP);
  }

  window.initNight = function initNight(map) {
    addLayers(map);
    // `idle` is the RIGHT signal — querySourceFeatures only sees loaded tiles —
    // but it is not a reliable one here. Measured on this scene: with the
    // camera sitting still after boot, `idle` did not fire once in 28 seconds
    // (`map.loaded()` stayed false the whole time) and only arrived after a
    // jumpTo. On a page nobody touches, that is a city with no streetlights for
    // as long as the visitor leaves it alone.
    //
    // So take whichever comes first. `generate` is idempotent (`_points`
    // guards it) and re-arms its own retry if the tiles genuinely are not
    // resident yet, so an early timer attempt costs one cheap query.
    map.once('idle', () => generate(map));
    setTimeout(() => generate(map), IDLE_FALLBACK_MS);
  };

  // Called from timeofday's heavy path. p: 0 day … 1 night.
  window.applyNightLayer = function applyNightLayer(map, p) {
    if (!map || !map.getLayer) return;
    _lastP = p == null ? _lastP : p;
    // One schedule for every artificial light in the scene — see LIGHTS above
    // and SKY_TUNE.DUSK in js/sky.js. The p-ramp is only reached if sky.js is
    // missing, in which case there is no sun arc to key off.
    const B = (typeof window.skyBodies === 'function') ? window.skyBodies(_lastP) : null;
    const t = (B && typeof B.lamps === 'number') ? B.lamps : Math.max(0, Math.min(1,
      (_lastP - LIGHTS.NIGHT_START) / (LIGHTS.NIGHT_FULL - LIGHTS.NIGHT_START)));
    try {
      if (map.getLayer(POOL)) {
        // `ob` is the baked core-vs-edge boost. No zoom term here, so wrapping
        // the tier match in a `*` is legal — the top-level-interpolate rule
        // that shapes `radiusExpr` only applies to zoom expressions.
        const d = LIGHTS.LAMP_DIM * t;
        map.setPaintProperty(POOL, 'circle-opacity',
          ['*', tierMatch(LIGHTS.POOL_OPACITY_MAJOR * d,
                          LIGHTS.POOL_OPACITY_MINOR * d,
                          LIGHTS.POOL_OPACITY_WALK  * d),
                ['number', ['get', 'ob'], 1]]);
      }
      if (map.getLayer(CORE)) {
        map.setPaintProperty(CORE, 'circle-opacity',
          ['*', LIGHTS.CORE_OPACITY * LIGHTS.LAMP_DIM * t, ['number', ['get', 'ob'], 1]]);
      }
      if (map.getLayer(TPOOL)) {
        map.setPaintProperty(TPOOL, 'circle-opacity', TOWER_POOL.OPACITY * t);
      }
    } catch (err) { /* layers not ready yet */ }
  };

  /**
   * ── THE TASTE BLOCK, LIVE ────────────────────────────────────────────
   *
   * CLAUDE.md rule 11 asks that every aesthetic constant be overrulable in one
   * line. Until now `LIGHTS` was sealed inside this IIFE, so the only way to
   * try a value was to edit the file and reload — which also means a
   * before/after can only be shot in two different browsers, and this suite's
   * own history says two browsers is how you end up comparing a tile that
   * loaded late with one that did not.
   *
   *   window.NIGHT_TUNE.POOL_GROUND_M = [...]; window.nightRetune(map);
   *
   * `nightRetune` re-derives every paint property that depends on a constant.
   * It does NOT regenerate the lamp points: colour and `ob` are baked per
   * feature at generation, so changing a COLOUR constant needs a reload. Sizes,
   * blurs, opacities and the schedule are all live.
   */
  window.NIGHT_TUNE = LIGHTS;
  window.NIGHT_TOWER = TOWER_POOL;
  window.nightRetune = function nightRetune(map) {
    if (!map || !map.getLayer) return false;
    try {
      if (map.getLayer(POOL)) {
        map.setPaintProperty(POOL, 'circle-radius', radiusExpr(1, 0));
        map.setPaintProperty(POOL, 'circle-blur', LIGHTS.POOL_BLUR);
      }
      if (map.getLayer(CORE)) {
        map.setPaintProperty(CORE, 'circle-radius',
          radiusExpr(LIGHTS.CORE_RADIUS_SCALE, LIGHTS.CORE_MIN_PX, LIGHTS.CORE_GROUND_CAP_M));
        map.setPaintProperty(CORE, 'circle-blur', LIGHTS.CORE_BLUR);
      }
      if (map.getLayer(TPOOL)) {
        map.setPaintProperty(TPOOL, 'circle-radius', towerRadiusExpr());
        map.setPaintProperty(TPOOL, 'circle-color', TOWER_POOL.COLOR);
        map.setPaintProperty(TPOOL, 'circle-blur', TOWER_POOL.BLUR);
      }
      window.applyNightLayer(map, _lastP);
      return true;
    } catch (err) { console.error('[night] retune failed:', err); return false; }
  };
})();
