/**
 * places.js — the storefronts. 133 real businesses on the campus edge, West
 * Campus and Guadalupe, each given a shopfront on its host building's ground
 * floor in the brand's real sign colour, with the business name as a label.
 *
 * WHAT THIS ADDS THAT js/drag.js DOES NOT. drag.js fixed the SHAPE of the
 * problem for Guadalupe between 21st and 24th: it stopped painting apartment
 * windows on the ground floor of a bookstore and gave that run a shopfront
 * vocabulary — glass band, bulkhead, sign band, upper floors. This file keeps
 * every one of those decisions and adds the thing drag.js could not know: WHICH
 * BUSINESS is behind each stretch of glass, and therefore what colour its
 * fascia is. It also carries the vocabulary off the Drag and onto the ~90 other
 * storefronts in the bbox that had none — West Campus, the Speedway edge,
 * 26th Street, Dobie, MLK.
 *
 * NO BRAND ARTWORK. Not one logo image is fetched, embedded or drawn. That is
 * partly a trademark call — this is going out on AWS Kiro's channels — and
 * partly that it would be wasted bytes: the camera flies 200-900 m up, one
 * pixel of wall is about half a metre, and a logo is four pixels of mush. What
 * a person actually recognises from a block away is the SIGN COLOUR and the
 * NAME, and those are what this draws.
 *
 * ── THE THREE THINGS THAT MAKE IT READ ───────────────────────────────────────
 *
 *   1. THE FASCIA IS FLAT COLOUR, NOT A PATTERN. A brand colour is one value.
 *      Painting it through a 64 px tile would put the renderer's pattern
 *      machinery between the sourced hex and the screen for no gain, and would
 *      cost one atlas image per brand. So the sign band is a plain
 *      fill-extrusion-color driven off the feature's own wd/wg/wn, which is
 *      also what lets 35 different sourced hexes cost exactly zero images.
 *
 *   2. THE SIGN GOES UP AT NIGHT, NOT DOWN. Every other surface in this repo
 *      rides a ramp that ends dark. A shop fascia is the opposite: channel
 *      letters and lightboxes are the brightest thing on a two-storey building
 *      after dark, and it is the entire reason the Drag reads at night. The
 *      `wn` the bake writes for a sign is the brand hue at near-full chroma and
 *      high value. Run a sign through the wall ramp and Chipotle's red lands at
 *      #29181f, which deletes the pass at exactly the hour it matters most.
 *
 *   3. THE AWNING IS WHAT THE FLYING CAMERA ACTUALLY SEES. At 60-75 degrees of
 *      pitch a vertical fascia is foreshortened to roughly a third of its true
 *      height while a horizontal surface is seen at nearly full size. So the
 *      surface that delivers "that is a Whataburger" from altitude is the
 *      awning's TOP face, not the sign. That is why the bake cantilevers one
 *      1.3 m deep off every shopfront and pre-corrects its colour cool for the
 *      sun tint the top face picks up.
 *
 * ── THE TRAP THIS PASS IS BUILT AROUND ───────────────────────────────────────
 * `fill-extrusion-pattern` is TILE-locked and has NO VERTICAL ANCHOR: it repeats
 * from the extrusion base with no idea where the building's top or bottom is. So
 * a ground-floor shopfront painted into a wall tile reappears every ~40 m all
 * the way up. Every band here is therefore its own feature with its own `base`
 * and `h`, emitted by scripts/bake_places.py — bake_stadium.py's BANDS list,
 * applied per tenant. The single pattern this file registers (the glazing's
 * mullions) is STATIONARY IN Y, exactly as js/drag.js's tiles are: vertical
 * mullions survive a moving slice, a transom bar would not, so there is no
 * transom bar.
 *
 * ── LOD: THREE TIERS, FROM A TABLE, NOT FROM TASTE ───────────────────────────
 * scripts/bake_places.py's second pass gave all 133 shopfronts an ENTRY — a
 * recessed bay, piers, a lintel, door leaves with their own glazing, a lit
 * interior plane and a pool of spill on the pavement — and emitted it with NO
 * zoom gate, because a per-feature gate cannot be expressed from a bake. That
 * put 755 features between 0.16 m and 2.13 m on screen from z15, where the
 * smallest of them is a twentieth of a pixel.
 *
 * docs/entrances/shopfronts.md §9.2 already answers what survives what
 * altitude, derived from js/controls.js's own ALT/ZOOM constants. This file
 * applies it as three layers over one source:
 *
 *   base  z15.0  bulkhead, glazing, sign band, awning, RECESS PANEL   1,582
 *   pool  z15.5  the pavement spill                                      63
 *   entry z16.7  door leaves, door glazing, jamb returns, lintel        755
 *   label z17.3  the tenant names                                       133
 *
 * (Counted off the file at init, not from this comment — placesStats().tiers.)
 *
 * The recess panel stays in the base tier for two separate reasons and either
 * alone would be enough: §9.2 puts it at 1 px at 854 m, above ALT_MAX, so it is
 * the one entry piece that survives the whole envelope — and the bake splits the
 * bulkhead and glazing AROUND the bay, so a tier that took the panel with it
 * would punch a hole through every shopfront to the host wall.
 *
 * ── IT REPLACES NOTHING ──────────────────────────────────────────────────────
 * `replacedBuildingIds` is empty on purpose and this module writes no filter on
 * `buildings-3d`. The shopfronts are a thin slab standing 0.30 m PROUD of the
 * host wall, so they can never z-fight with the building behind them, they work
 * whether or not drag.js has already rebuilt that wall, and — the reason that
 * matters — this pass cannot collide with any of the six others landing on this
 * repo, because it never claims a building any of them might also claim.
 *
 * Public (window) API:
 *   initPlaces(map)             — add the source + layers (called automatically)
 *   applyPlacesColors(map, p)   — retint for time-of-day p (hooked automatically)
 *   applyPlacesSettings(map)    — re-read PLACES after a live edit
 *   placesTileSample(p)         — the glass tile's mean colour at hour p, no map
 *   placesStats()              — what actually got drawn
 *   PLACES                      — the taste block (below)
 */
(function () {
  'use strict';

  const q = new URLSearchParams(window.location.search);

  const PLACES = {
    // ?places=0 removes the whole pass at load, so scripts/verify/places-perf.mjs
    // can measure the A/B on ONE build instead of two checkouts. Same lever
    // js/drag.js exposes as ?drag=0.
    on: q.get('places') !== '0',
    // ?placelabels=0 keeps the geometry and drops the text, which is how you
    // tell "the shopfronts are invisible" apart from "the labels are covering
    // them" without rebuilding anything.
    labels: q.get('placelabels') !== '0',
    minZoom: 15,
    // "restaurant names are a bit too visible from afar". They were: shop names
    // started at z16 in BOLD white on a saturated brand halo, while building names
    // started at 16.7 in regular weight — so a boba shop announced itself sooner
    // and louder than the building it is inside. A storefront is a street-level
    // detail; it should arrive when you are close enough to walk into it.
    labelMinZoom: 17.3,

    // ── the three altitude tiers ──────────────────────────────────────
    // docs/entrances/shopfronts.md §9.2 is a table of "at what altitude is this
    // feature one pixel", derived from js/controls.js's own ALT/ZOOM constants
    // and cross-checked against the figure that file records. These three
    // numbers are that table applied. The bake (HANDOFF §91) emitted the entry
    // geometry with no gate at all — 755 of the 2,533 features were being drawn
    // from z15, where a 0.16 m lintel is a twentieth of a pixel.
    //
    // WHAT STAYS AT `minZoom` AND WHY IT IS NOT ALL OF IT. `plBack` — the
    // recess panel, 2.40 x 2.60 m — is the one entry piece §9.2 says survives
    // the whole envelope (1 px at 854 m, above ALT_MAX). It is also the piece
    // that fills the bay: the bake splits the bulkhead and the glazing AROUND
    // the doorway, so gating the whole `entry` kind punches a hole through the
    // shopfront to the host wall at every door. So the panel is base tier and
    // the four fine pieces are not.
    //
    //   base   plBulk plGlass plSign plAwn plBack   1,582 features   15.0
    //   portal plLeaf plLite plPier plHead            755 features   16.7
    //   pool   plPool                                  63 features   15.5
    entryMinZoom: 16.7,   // SF_PORTAL_MIN_ZOOM: 225 m, the spawn altitude. A
                          // door leaf is 3 px tall here — it arrives exactly
                          // when you are close enough to be looking at the Drag.
    poolMinZoom: 15.5,    // SF_POOL_MIN_ZOOM: below this the spill is a smear.
    // Which families are the recess panel and which are the fine portal pieces.
    // Anything the bake grows later lands in the BASE tier by default, which is
    // the safe failure — drawn too early, never missing.
    entryFams: ['plLeaf', 'plLite', 'plPier', 'plHead'],
    poolFams: ['plPool'],

    opacity: 1.0,
  };
  window.PLACES = PLACES;

  const SRC = 'city-places';
  const L_SOLID = 'places-solid';
  const L_ENTRY = 'places-entry';
  const L_POOL = 'places-pool';
  const L_GLASS = 'places-glass';
  const L_LABEL = 'places-label';
  const DATA = 'data/places.geojson';
  const TILE = 64;
  const GLASS_IMG = 'pl-glass';

  // ── taste: the glazing tile, in tile pixels ─────────────────────────
  // One tile is ~40 m of wall in the middle of the flying range, so 1 px is
  // about 0.63 m. These are drag.js's shopGlass numbers, deliberately: the two
  // passes' glazing sits on the same buildings and must not disagree about what
  // a shopfront window looks like.
  const T = {
    // 3, not 5. At 5 the spacing is ~3.2 m; the Kawneer working bay is 1.35 m
    // and the published ceiling is 1.83 m, so the rhythm was at roughly double
    // the real one. And NOT 2 — at 2 the 1 px dark line is 50% of the tile's
    // area and MULL_DARK 0.26 takes a quarter of the band's mean luma out,
    // which is the "black ribbed void, not glass, a hole" failure recorded
    // below at GLASS_DARK. 3 is ~1.9 m, one step off the published ceiling,
    // and costs 33% of the tile instead of 50%.
    MULL: 3, MULL_DARK: 0.26,      // mullions every ~1.9 m, 1 px wide
    // 0.50 — drag.js's own value — is right when `k.glass` is derived from a
    // sunlit stucco wall, and wrong here, because this pass derives it from ONE
    // fixed base tone instead of per-building. The tile came back at luma 80
    // against a ~145 wall and rendered as a black ribbed void under every
    // shopfront: not glass, a hole. Which is the same failure drag.js already
    // recorded fixing at 0.66, one step further along the same axis. Measured by
    // placesTileSample, not by eye — see scripts/verify/places-check.mjs, which
    // now asserts a floor on this.
    GLASS_DARK: 0.40,              // how far the glass goes from its base tone by day
    SKY: [126, 148, 176], SKY_MIX: 0.26,
    NIGHT: 0.86,                   // ... and how hard it glows after dark
    // [255,206,148] is R:B 1.72 as authored and lands ~40% cooler on screen
    // than the doorway three metres to its left — the entry's own `plBack` `wn`
    // is #ffbe5e (R:B 2.71 authored, 2.06 measured) and js/entrances.js's five
    // lit campus doorways measured 1.79-2.31. A shopfront window and the door
    // beside it are the same room. [255,190,94] is R:B 2.71 authored, which is
    // the same value the bake writes for the interior it is a window onto.
    NIGHT_TONE: [255, 190, 94],
    BAY_RATE: 0.34,                // share of bays that are a brighter interior
    GAIN: 1.42,                    // the pattern removes mean luma; this puts it back
  };
  window.PLACES_T = T;

  // ── band-limit: this atlas had NONE until now ───────────────────────
  //
  // js/facades.js samples `fill-extrusion-pattern` through the exact same
  // engine path this module does — MapLibre's pattern atlas is LINEAR-
  // filtered with no mipmap, unconditionally, confirmed against the v5.24.0
  // source in docs/pattern-sampling.md — so the same crawl-while-moving
  // defect applies here (docs/shimmer-mechanism.md). This module never had
  // facades.js's SOFTEN/TIERS machinery: `glassTile` above drew one TILE=64
  // texel image and handed it straight to `map.addImage`/`updateImage`, at
  // full resolution, unconditionally, at every zoom (docs/facade-atlas-map.md
  // §2's table — `places.js` was one of the six files listed with zero
  // SOFTEN/TIERS references).
  //
  // This is the SAME shipped fix (shim-lowpass — docs/shimmer-verdict.md)
  // applied here, through the shared kernel js/pattern-lowpass.js
  // (`PatternLowpass.blurWrap`, extracted from js/facades.js's own softenTile
  // — QUEUE F2, applied first to js/drag.js). Only ONE image exists here
  // (GLASS_IMG / `pl-glass`), so this is a single-key registry rather than
  // drag.js's eleven-family table — still SOFTEN-shaped (RADIUS/AMOUNT keyed
  // by family, here just `plGlass`) so scripts/verify/shimmer.mjs's existing
  // generic sweep (which does `for (const f of Object.keys(S.RADIUS)) ...`)
  // drives it with no special-casing.
  //
  // CALIBRATION. Radius is in TILE=64 drawing-space texels, the same unit
  // js/drag.js's shopGlass uses (no SCALE multiplier or decimation here
  // either). MULL=3 above means this tile's mullion pattern repeats every 3
  // texels — a MUCH finer period than facades.js's window grids or drag.js's
  // coffers, and that period is what makes the naive "copy drag.js's shipped
  // r3" choice actively wrong here, found by direct measurement, not assumed:
  //
  // DIRECT PIXEL DIAGNOSTIC on the actual registered `pl-glass` image
  // (scripts/verify/places-glass-variance.mjs, texel-luma variance, mean
  // preserved ~123 at every radius by the box blur's own construction):
  //
  //   radius   variance   vs floor   BY EYE (shots/shimmer/front2/wcplaces/
  //                                  places-glass-tile-r*.png, 64px tile,
  //                                  nearest-neighbour 10x)
  //   0 (floor)  272.93      —       crisp mullions, high contrast
  //   1            4.49    -98%      COMPLETELY FLAT — no mullions at all
  //   2           13.24     -95%     soft but CLEARLY still a repeating
  //                                  mullion pattern — the best-surviving
  //                                  legibility of any nonzero radius
  //   3            6.03     -98%     a faint WIDE-BANDED beat pattern, not
  //                                  mullions — worse to look at than r2
  //   4            1.36    -100%     nearly flat
  //   6            2.24     -99%     nearly flat, faintest hint of texture
  //
  // r1's near-total erasure is not "aggressive softening", it is exact
  // numerical resonance: a radius-1 box kernel is 3 texels wide, exactly one
  // mullion period, so EVERY 3-texel window on this tile contains exactly one
  // dark texel and two light ones — the average is a near-constant, by
  // construction, regardless of camera pose. r3 (7-wide kernel) and r6
  // (13-wide) are NOT integer multiples of the 3-texel period, so they leave
  // a residual BEAT pattern instead of either crisp mullions or a clean flat
  // band — visibly worse than either endpoint, not a graceful middle ground.
  // r2 (5-wide kernel, also not a multiple of 3) is the one radius in this
  // sweep whose beat residual still reads as "a repeating window pattern"
  // rather than either a moiré band or nothing.
  //
  // shimmer.mjs's crawl% meter (SHIM_SOFTEN_TARGET=places), at `places-close`
  // and `places-cruise` (scripts/verify/shots-front2-wcplaces.json, a Raku
  // Sushi & Asian Bistro storefront in West Campus — off the Drag entirely)
  // does NOT discriminate any of this: whole-frame, r0/r3/r6 sit within
  // 0.02pp of each other at both poses (2.54/2.56/2.56 and 4.13/4.12/4.12),
  // because The Standard and Union on 24th's own walls dominate the frame.
  // Re-measured with buildings-3d AND wc-wall hidden to isolate this atlas's
  // own pixels (scripts/verify/shots-front2-places-iso.json): STILL flat —
  // r0=3.24%, r1=3.24%, r2=3.24%, r3=3.24%, identical to the hundredth of a
  // point, even though r1 visually erases the pattern completely. The
  // remaining ~3.2% at this pose is not the glass pattern at all (awning
  // silhouettes, door/frame edges and tree-canopy occlusion boundaries are
  // the likely source, per the pose's own screenshot) — this fix was never
  // going to move it, and no radius choice here is more "correct" by that
  // number. Said plainly, the same way drag.js's own commit said it for the
  // ground-contaminated street-drag pose: the whole-frame crawl% is the WRONG
  // instrument for this radius choice; the direct pixel diagnostic above is
  // the real evidence, and it is decisive.
  //
  // SHIPPED: radius 2, not 3 — a deliberate departure from facades.js's and
  // drag.js's own r3 default, because their tiles do not share this one's
  // 3-texel mullion period and r3 is demonstrably worse here, not just
  // "the same conservative choice". TASTE KNOB: readable and settable from
  // the console as window.PLACES_SOFTEN, same contract as
  // window.FACADE_SOFTEN / window.DRAG_SOFTEN.
  const PLACES_SOFTEN = {
    RADIUS: { plGlass: 2 },
    AMOUNT: { plGlass: 1.0 },
  };
  window.PLACES_SOFTEN = PLACES_SOFTEN;

  // ── colour helpers (this module's own; drag.js's are private) ───────
  function hexToRgb(hex) {
    const h = String(hex || '#888888').replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function mix(a, b, t) {
    const A = Array.isArray(a) ? a : hexToRgb(a), B = Array.isArray(b) ? b : hexToRgb(b);
    return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
  }
  function css(rgb, alpha) {
    return `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${alpha == null ? 1 : alpha})`;
  }
  /** Deterministic 0..1 — the night scatter must not flicker between repaints. */
  function hash01(a, b) {
    let x = (a * 374761393 + b * 668265263) | 0;
    x = (x ^ (x >> 13)) * 1274126177;
    return ((x ^ (x >> 16)) >>> 0) / 4294967295;
  }

  /** Fill a vertical stripe that wraps. NOTHING in this tile may read y — a band
   * here is 3.7 m tall against a tile spanning 30-59 m, so it shows an arbitrary
   * horizontal SLICE whose position moves with zoom. Vertical features survive
   * that; horizontal ones appear at a different height on every building. */
  const fillC = (ctx, c, x, w, a) => {
    ctx.fillStyle = css(c, a);
    x = ((x % TILE) + TILE) % TILE;
    ctx.fillRect(x, 0, w, TILE);
    if (x + w > TILE) ctx.fillRect(x - TILE, 0, w, TILE);
  };

  /** The light at hour p, derived the way js/drag.js and js/facades.js derive it
   * so this module and the rest of the city agree about when dusk is. */
  function lightAt(p, wall) {
    const night = Math.max(0, (p - 0.55) / 0.45);
    const sunElev = (typeof window.skyBodies === 'function')
      ? window.skyBodies(p).sun.elev : (0.5 - p) * 100;
    const dark = Math.max(night, Math.min(1, Math.max(0, -sunElev / 9)));
    const golden = 1 - Math.abs(p - 0.5) / 0.5;
    let glass = mix(wall, [46, 58, 74], 0.62);
    glass = mix(glass, [255, 176, 96], golden * 0.45);
    glass = mix(glass, [12, 15, 28], dark * 0.9);
    return { night, dark, golden, glass };
  }

  let _canvas = null, _ctx = null;

  /**
   * The one image this pass registers.
   *
   * A shopfront IS continuous glass on thin mullions, so the pier minimum that
   * governs punched-window families in js/facades.js does not apply — the same
   * exemption drag.js's shopGlass and facades.js's `tg` already carry.
   *
   * And the night state is an unbroken warm ribbon, NOT a per-pane scatter. The
   * reference is the Drag after dark: a continuous run of lit shop interiors. A
   * scatter of lit panes reads as apartments, which is the exact error this
   * whole family of passes exists to fix.
   */
  function glassTile(p) {
    if (!_canvas) {
      _canvas = document.createElement('canvas');
      _canvas.width = _canvas.height = TILE;
      // willReadFrequently because this always ends in getImageData. Do NOT
      // composite a second canvas in here: drawImage into a CPU-backed context
      // took the facade atlas from 44 ms to 230 ms (js/facades.js).
      _ctx = _canvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = _ctx;
    const base = hexToRgb('#6e7a84');
    const k = lightAt(p, base);
    ctx.clearRect(0, 0, TILE, TILE);

    let glass = mix(k.glass, [0, 0, 0], T.GLASS_DARK * (1 - k.night));
    // Sky in the glass, by day only. A shopfront is the one surface in this pass
    // that is a mirror, and without it the band reads as a hole punched in the
    // building rather than as a window.
    glass = mix(glass, T.SKY, T.SKY_MIX * (1 - k.dark));
    glass = glass.map(c => Math.min(250, c * T.GAIN));
    fillC(ctx, glass, 0, TILE);
    if (k.night > 0.02) {
      const glow = mix(glass, T.NIGHT_TONE, T.NIGHT * Math.min(1, k.night * 1.35));
      fillC(ctx, glow, 0, TILE);
      // Shop to shop the interiors differ in brightness. Tenancies are ~7 m
      // apart, not 3 m, so this runs on a coarser rhythm than the mullions and
      // cannot beat against them.
      for (let b = 0; b < 6; b++) {
        if (hash01(71, b) > T.BAY_RATE) continue;
        fillC(ctx, mix(glow, [255, 240, 214], 0.30 * k.night),
              Math.round(b * TILE / 6) + 1, Math.round(TILE / 6) - 2);
      }
    }
    const mull = mix(glass, [0, 0, 0], T.MULL_DARK);
    for (let x = 0; x < TILE; x += T.MULL) fillC(ctx, mull, x, 1);

    const img = ctx.getImageData(0, 0, TILE, TILE);
    // Band-limit LAST, after every layer above (sky mix, night glow, bay
    // scatter, mullions) is already in the buffer — the blur has to see the
    // same texture MapLibre will sample, not a cleaner draft of it. Only one
    // image/family here (`plGlass`), unlike js/drag.js's per-family table, so
    // this reads the registry directly rather than looking up by feature.
    const rOv = PLACES_SOFTEN.RADIUS.plGlass, aOv = PLACES_SOFTEN.AMOUNT.plGlass;
    window.PatternLowpass.blurWrap(img.data, TILE, rOv, aOv);
    return { width: TILE, height: TILE, data: new Uint8Array(img.data.buffer.slice(0)) };
  }

  /**
   * The mean colour the glass tile is DRAWN at, for a given hour.
   *
   * This separates two questions that look identical on screen and have
   * completely different fixes: "is the tile wrong?" and "is the tile right and
   * the light doing something to it?". It re-runs the draw and reads the bytes,
   * with no map, no light and no post-process involved. Copied in spirit from
   * window.dragTileSample, which existed because a screenshot could not tell a
   * tile that had never been repainted from one that had.
   */
  window.placesTileSample = function placesTileSample(p) {
    const d = glassTile(p == null ? 0.3 : p).data;
    let r = 0, g = 0, b = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    r /= n; g /= n; b /= n;
    return { p, mean: [Math.round(r), Math.round(g), Math.round(b)],
             luma: +(0.30 * r + 0.59 * g + 0.11 * b).toFixed(1) };
  };

  // ── layers ──────────────────────────────────────────────────────────
  /** ['interpolate', p, wd, wg, wn] — the shape timeofday.js bakes with. */
  function bakedColor(p) {
    p = Math.max(0, Math.min(1, p));
    return ['interpolate', ['linear'], p,
      0, ['to-color', ['get', 'wd'], '#888888'],
      0.5, ['to-color', ['get', 'wg'], '#888888'],
      1, ['to-color', ['get', 'wn'], '#333344'],
    ];
  }

  let _added = false, _stats = null;

  window.initPlaces = async function initPlaces(map) {
    if (!PLACES.on || _added || map.getSource(SRC)) return;
    _added = true;

    let gj;
    try {
      const r = await fetch(DATA);
      if (!r.ok) throw new Error(DATA + ': ' + r.status);
      gj = await r.json();
    } catch (e) {
      console.warn('[places]', e.message, '- pass not drawn');
      return;
    }

    const p = (window.__todCurrentP != null) ? window.__todCurrentP : 0.3;
    try { map.addImage(GLASS_IMG, glassTile(p)); } catch (e) { /* already there */ }
    map.addSource(SRC, { type: 'geojson', data: gj, ...(window.PATTERN_TILING || {}) });

    // The anchor must be the first symbol layer AFTER the buildings, not the
    // first in the style. The basemap puts symbol layers immediately after
    // `background`, so anchoring there drops the whole pass to the BOTTOM of the
    // stack, under the ground — which is exactly what happened to the stadium.
    const stack = map.getStyle().layers;
    const after = Math.max(0, stack.findIndex(l => l.id === 'buildings-3d'));
    const anchor = (stack.slice(after + 1).find(l => l.type === 'symbol') || {}).id;

    // Bulkhead, fascia, awning and recess panel in ONE layer. They are all flat
    // colour off the feature's own ramp, so splitting them would buy nothing and
    // cost a draw call per frame. Depth testing sorts the awning in front of the
    // wall for free.
    //
    // The three solid tiers share one paint block — they differ ONLY in filter
    // and minzoom — so it is written once and the three layers are otherwise
    // identical by construction. That matters: a tier that drifted in opacity or
    // in the vertical-gradient flag would read as a seam at the gate zoom.
    const solidPaint = () => ({
      'fill-extrusion-color': bakedColor(p),
      'fill-extrusion-height': ['get', 'h'],
      'fill-extrusion-base': ['get', 'base'],
      'fill-extrusion-opacity': PLACES.opacity,
      // OFF. The gradient darkens the BOTTOM of every extrusion and these bands
      // are 0.16 m to 1.05 m tall, so the whole band falls inside the gradient
      // and a sourced brand colour renders as a dark smear. The band tones
      // already carry the vertical hierarchy. (Same call as stadium-wall and
      // drag-wall.)
      'fill-extrusion-vertical-gradient': false,
    });

    if (!map.getLayer(L_SOLID)) {
      map.addLayer({
        id: L_SOLID, type: 'fill-extrusion', source: SRC, minzoom: PLACES.minZoom,
        // Everything that is NOT glazing, NOT a fine portal piece, NOT the
        // pavement pool and NOT a label point. `plBack` falls through to here
        // on purpose — see PLACES.entryFams for why the recess panel is base
        // tier and the four pieces in front of it are not.
        filter: ['all',
          ['!=', ['get', 'fam'], 'plGlass'],
          ['!=', ['get', 'kind'], 'label'],
          ['match', ['get', 'fam'], PLACES.entryFams.concat(PLACES.poolFams), false, true],
        ],
        paint: solidPaint(),
      }, anchor);
    }

    // THE PAVEMENT SPILL, one zoom step earlier than the door it comes out of.
    // It is a horizontal surface, and a horizontal surface is the one thing a
    // 64-degree camera sees at nearly full size — 5.0 m of pool is 8 px of
    // screen at 225 m where the 2.13 m door leaf it belongs to is 3. So it
    // earns z15.5 while the leaves wait for 16.7. (§9.2's own finding, applied:
    // "the surface that delivers it from altitude is the top face".)
    if (!map.getLayer(L_POOL)) {
      map.addLayer({
        id: L_POOL, type: 'fill-extrusion', source: SRC, minzoom: PLACES.poolMinZoom,
        filter: ['match', ['get', 'fam'], PLACES.poolFams, true, false],
        paint: solidPaint(),
      }, anchor);
    }

    // THE PORTAL TIER. Door leaves, their glazing, the jamb returns and the
    // lintel: 755 features that are between 0.16 m and 2.13 m on their dominant
    // axis, i.e. under three pixels above 225 m. Added AFTER the base layer so
    // a leaf draws over the recess panel behind it where the two are within a
    // few centimetres of each other at the threshold.
    if (!map.getLayer(L_ENTRY)) {
      map.addLayer({
        id: L_ENTRY, type: 'fill-extrusion', source: SRC, minzoom: PLACES.entryMinZoom,
        filter: ['match', ['get', 'fam'], PLACES.entryFams, true, false],
        paint: solidPaint(),
      }, anchor);
    }

    if (!map.getLayer(L_GLASS)) {
      map.addLayer({
        id: L_GLASS, type: 'fill-extrusion', source: SRC, minzoom: PLACES.minZoom,
        filter: ['==', ['get', 'fam'], 'plGlass'],
        paint: {
          'fill-extrusion-pattern': GLASS_IMG,
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-base': ['get', 'base'],
          'fill-extrusion-opacity': PLACES.opacity,
          'fill-extrusion-vertical-gradient': false,
        },
      }, anchor);
    }
    if (!map.getLayer(L_LABEL)) {
      map.addLayer({
        id: L_LABEL, type: 'symbol', source: SRC, minzoom: PLACES.labelMinZoom,
        filter: ['==', ['get', 'kind'], 'label'],
        layout: {
          'text-field': ['get', 'nm'],
          // ONE font, not a fallback list. MapLibre requests a fontstack as a
          // single URL — the three names above became
          // /fonts/Noto%20Sans%20Bold,Open%20Sans%20Bold,Arial%20Unicode%20MS%20Bold/0-255.pbf,
          // which OpenFreeMap 404s because it serves only Noto Sans
          // Regular/Bold/Italic. A 404 glyph is not cosmetic: MapLibre discards
          // the ENTIRE tile that needed it, which is how every building once
          // disappeared with err:0 and no console error (HANDOFF 7.12).
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 17.3, 8.5, 18.4, 11, 19.5, 12.5],
          'text-max-width': 8,
          'text-padding': 3,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          // Within the layer, a brand whose colour is SOURCED outranks one whose
          // colour is a category guess. When 133 names compete for a screenful of
          // boxes, the ones that survive should be the ones carrying real
          // information. (Lower sort key = placed first = wins.)
          'symbol-sort-key': ['case', ['==', ['get', 'src'], 'S'], 0, 1],
          'visibility': PLACES.labels ? 'visible' : 'none',
        },
        paint: {
          // White on a halo of the shop's OWN sign colour. This is doing two
          // jobs: it is legible against anything, and it carries the brand
          // colour at the zooms where a 1 m fascia band is under a pixel and
          // the geometry alone cannot. A label that took its colour FROM the
          // sign would be invisible for every dark fascia (Urban Outfitters is
          // #1a1a1a) and unreadable for every pale one (Pluckers is #ffe525).
          'text-color': '#ffffff',
          'text-halo-color': ['to-color', ['get', 'sign'], '#333333'],
          'text-halo-width': 1.9,
          'text-halo-blur': 0.2,
          'text-opacity': 0.95,
        },
      }, map.getLayer('buildings-labels') ? 'buildings-labels' : undefined);
      // ^ THE ANCHOR ON THIS LAYER IS A COLLISION DECISION, NOT A DRAW-ORDER ONE.
      //
      // MapLibre resolves label collisions in LAYER ORDER: whatever is earlier in
      // the style wins the box and everything later is dropped. The first cut
      // added this with no anchor, which puts it last, which is the lowest
      // priority in the whole style — and it measured exactly that. Labels placed
      // at zoom 15.5: 0. At 16.4: 0. At 17.2: 18. Every shop name was losing its
      // box to `buildings-labels`' apartment-block names, and the pass looked
      // like it had a minzoom bug when it had a priority bug. Anchoring before
      // `buildings-labels` gives a business name precedence over the name of the
      // building it is inside, which is also the right answer on the merits.
    }

    const nSolid = gj.features.filter(f => f.properties.kind !== 'label'
                                        && f.properties.fam !== 'plGlass').length;
    const nGlass = gj.features.filter(f => f.properties.fam === 'plGlass').length;
    const nLabel = gj.features.filter(f => f.properties.kind === 'label').length;
    const src = new Set(), gen = new Set();
    for (const f of gj.features) {
      if (f.properties.kind !== 'label') continue;
      (f.properties.src === 'S' ? src : gen).add(f.properties.nm);
    }
    // The tier census, counted off the file rather than asserted from the
    // filters, so a verification script can watch the split without a
    // screenshot and a family the bake grows later shows up as a base-tier
    // number that moved. `deferred` is what the gate is actually buying: the
    // features NOT drawn at the spawn altitude.
    const inFam = (f, list) => list.indexOf(f.properties.fam) >= 0;
    const nEntry = gj.features.filter(f => inFam(f, PLACES.entryFams)).length;
    const nPool = gj.features.filter(f => inFam(f, PLACES.poolFams)).length;
    const nBase = nSolid - nEntry - nPool;
    _stats = { features: gj.features.length, solid: nSolid, glass: nGlass,
               labels: nLabel, shopfronts: nLabel,
               sourcedColour: src.size, generativeColour: gen.size, images: 1,
               tiers: {
                 base: { z: PLACES.minZoom, features: nBase + nGlass },
                 pool: { z: PLACES.poolMinZoom, features: nPool },
                 entry: { z: PLACES.entryMinZoom, features: nEntry },
                 label: { z: PLACES.labelMinZoom, features: nLabel },
               },
               deferredBelowSpawn: nEntry };
    // The tenant catalogue this layer is authoritative for. Derived here, once,
    // from the file that was actually loaded — see placesTenantNames() above.
    _names = [...new Set([...src, ...gen])].sort();
    // js/app.js owns the cross-layer label hierarchy and does the suppression.
    // It is called from BOTH ends because the two modules boot independently:
    // signs.js calls orderLabelLayers() when `signs-label` appears, and this
    // call covers the other order, where places.js finishes last.
    try { if (window.dedupeTenantLabels) window.dedupeTenantLabels(); } catch (e) {}

    console.log('[places]', _stats.shopfronts, 'shopfronts,', _stats.features,
                'features (', nBase + nGlass, 'base z' + PLACES.minZoom, '/',
                nPool, 'pool z' + PLACES.poolMinZoom, '/',
                nEntry, 'entry z' + PLACES.entryMinZoom, '/',
                nLabel, 'labels z' + PLACES.labelMinZoom, '), 1 image,',
                src.size, 'brands with a sourced colour,', gen.size, 'generative');
  };

  window.placesStats = () => _stats;

  // ── ONE LABEL PER TENANT ────────────────────────────────────────────
  // QUEUE W5: "Chipotle" appeared twice in one frame — once from this layer,
  // once from `signs-label`, whose curated `data/signs.json` carries TEN of the
  // same businesses (Chipotle, Whataburger, P. Terry's, Raising Cane's,
  // Chick-fil-A, Cain & Abel's, Dirty Martin's, Scholz Garten, Texas Chili
  // Parlor, The Co-op). Neither file is wrong on its own; drawing both is.
  //
  // js/app.js owns the label hierarchy across layers and makes the suppression
  // there. This is the list it suppresses against, and it is DERIVED FROM THE
  // LOADED DATA, never a second hand-written catalogue — the same rule QUEUE W1
  // landed for `places-check.mjs`, for the same reason: a copied list is correct
  // on the day it is written and stale on the next bake.
  let _names = [];
  window.placesTenantNames = () => _names.slice();

  /**
   * THE GUARD. Every symbol layer in the style, queried once over the viewport,
   * grouped by the string it drew. Anything that comes back naming two layers
   * is a tenant labelled twice — which is the defect, stated as a number a
   * script can assert on rather than as a screenshot somebody has to read.
   *
   * queryRenderedFeatures consults the collision index, so a name that lost its
   * box is correctly absent: this counts what is ON SCREEN, not what is in the
   * data. Call it ONCE at a settled pose — a full-viewport query on every
   * `render` event takes the renderer down (docs/night/entrances-payload.md §7).
   *
   * Returns { names, rendered, duplicates: [{text, layers}] }.
   */
  window.labelDuplicates = function labelDuplicates(map) {
    if (!map || !map.getStyle) return null;
    const w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight;
    const byText = new Map();
    for (const l of map.getStyle().layers) {
      if (l.type !== 'symbol') continue;
      let hits = [];
      try { hits = map.queryRenderedFeatures([[0, 0], [w, h]], { layers: [l.id] }); }
      catch (e) { continue; }
      for (const f of hits) {
        const pr = f.properties || {};
        // The four text fields our own label layers read. A layer that names
        // things through some other key is invisible to this and would need
        // adding here — which is a one-line edit, on purpose.
        const t = pr.nm || pr.label || pr.text || pr.name;
        if (!t) continue;
        if (!byText.has(t)) byText.set(t, new Set());
        byText.get(t).add(l.id);
      }
    }
    const duplicates = [];
    for (const [t, set] of byText) {
      if (set.size > 1) duplicates.push({ text: t, layers: [...set].sort() });
    }
    duplicates.sort((a, b) => a.text.localeCompare(b.text));
    return { names: _names.length, rendered: byText.size, duplicates };
  };

  window.applyPlacesColors = function applyPlacesColors(map, p) {
    if (!map || !map.getLayer) return;
    try {
      if (map.hasImage && map.hasImage(GLASS_IMG)) map.updateImage(GLASS_IMG, glassTile(p));
      else map.addImage(GLASS_IMG, glassTile(p));
    } catch (e) { /* not registered yet */ }
    // All three solid tiers, not just the base one. The first cut of the split
    // retinted L_SOLID alone and left the door leaves and the pavement pool
    // frozen at whatever hour the page happened to load at — which by day is
    // invisible and at 22:00 is 755 daylit aluminium doors in a dark street.
    for (const id of [L_SOLID, L_POOL, L_ENTRY]) {
      try {
        if (map.getLayer(id)) map.setPaintProperty(id, 'fill-extrusion-color', bakedColor(p));
      } catch (e) {}
    }
  };

  /** Re-read PLACES after a live edit. */
  window.applyPlacesSettings = function applyPlacesSettings(map) {
    if (!map || !map.getLayer) return;
    for (const id of [L_SOLID, L_POOL, L_ENTRY, L_GLASS]) {
      if (!map.getLayer(id)) continue;
      try {
        map.setLayoutProperty(id, 'visibility', PLACES.on ? 'visible' : 'none');
        map.setPaintProperty(id, 'fill-extrusion-opacity', PLACES.opacity);
      } catch (e) {}
    }
    if (map.getLayer(L_LABEL)) {
      try {
        map.setLayoutProperty(L_LABEL, 'visibility',
                              (PLACES.on && PLACES.labels) ? 'visible' : 'none');
      } catch (e) {}
    }
    // If this layer just stopped drawing tenant names, the layers that yielded
    // them have to get them back. app.js decides; it just has to be asked.
    try { if (window.dedupeTenantLabels) window.dedupeTenantLabels(); } catch (e) {}
  };

  // ── bootstrap ───────────────────────────────────────────────────────
  // js/app.js is owned by another pass and will not call us. Copied from the
  // boot() at the bottom of js/outer.js by way of js/drag.js, including the
  // applyTimeOfDay wrap — installed here, after every module has loaded, so
  // script order cannot break it.
  function boot() {
    const map = window.__map;
    if (!map) return setTimeout(boot, 60);

    const hookTod = () => {
      if (typeof window.applyTimeOfDay !== 'function' || window.applyTimeOfDay.__places) return;
      const prev = window.applyTimeOfDay;
      const wrapped = function (m, p, force) {
        const r = prev.apply(this, arguments);
        try { window.applyPlacesColors(m, p); } catch (e) {}
        return r;
      };
      wrapped.__places = true;
      window.applyTimeOfDay = wrapped;
      // ALSO a global, not only a property on the wrapper: several passes wrap
      // this same function and whichever boots last owns the outermost closure,
      // so `window.applyTimeOfDay.__places` reads false for every pass except
      // that one even though all of them are being called. drag.js shipped a
      // check written against the property that read "the pass never hooked
      // time-of-day" while the pass was demonstrably going dark at night.
      window.__placesTodHooked = true;
    };

    const go = () => {
      // Wait for the core buildings. A shopfront slab added before the wall it
      // stands in front of exists is invisible from every angle except directly
      // overhead, and the anchor search below depends on `buildings-3d` being
      // in the style already.
      if (!map.getLayer('buildings-3d')) return setTimeout(go, 120);
      hookTod();
      window.initPlaces(map);
    };
    if (map.isStyleLoaded && map.isStyleLoaded()) go();
    else map.once('load', () => setTimeout(go, 0));
  }
  boot();
})();
