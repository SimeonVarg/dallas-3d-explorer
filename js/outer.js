/**
 * outer.js — the outer ring: the rest of Austin, drawn cheap.
 *
 * THE PROBLEM. scripts/config.sh models 2.5 x 2.2 km. Fly two blocks past its
 * edge in any direction and the city stops dead — no downtown, no lake, no
 * neighbourhoods, just the basemap plain running to the horizon. The Capitol
 * pass (js/capitol.js) fixed one 600 m strip of that. This is the other 55 km2.
 *
 * THE CONSTRAINT. The core scene was ALREADY at its frame budget before this
 * existed — js/graphics.js measures the frame and drops itself to the
 * performance preset at ~30 fps. So the ring is not "more of the same city". It
 * is a second, cheaper class of building, and every cut is deliberate:
 *
 *   the core gets                        the outer ring gets
 *   ------------------------------------ ------------------------------------
 *   a facade pattern from the atlas      a flat baked colour  (towers excepted)
 *   buildings-ao, a 44 px blurred        nothing. That layer was measured at
 *     contact shadow per footprint         3.6 fps on 2,400 footprints alone
 *   a parapet roof cap (2nd extrusion)   nothing  (towers excepted)
 *   a swept ground shadow (shadows.js)   nothing
 *   an OSM label                         nothing
 *   hero palettes, OSM parts, pitched    nothing
 *     roofs, curated signage
 *   full Overture geometry               85% fewer vertices, holes dropped,
 *                                          largest ring only
 *   14 data-derived colour buckets       6 tones
 *   every footprint in the box           a minimum-area cull that GROWS with
 *                                          distance: 33,307 of 40,656 dropped
 *
 * THE ONE EXCEPTION is downtown towers (`t=1`, at or above 40 m). They keep the
 * core's facade pattern and a roof cap, because the skyline silhouette is the
 * entire reason the box reaches south to the lake.
 *
 * They used to snap onto the campus atlas and register no new image, which was
 * cheap and wrong: the fourteen campus buckets are means of tan brick and
 * limestone, so the Austonian, Frost Bank Tower, the Independent and 111 more
 * arrived downtown wearing four or five browns and the skyline read as one mass.
 * quantiseOuterFacades now clusters the towers on their OWN baked colours into
 * ten buckets and registers ten images — the same call quantiseStadiumFacades
 * makes, for the same reason, and bounded so the per-image atlas repaint stays
 * cheap.
 *
 * REGISTRATION. This module bootstraps itself: it waits for window.__map and
 * for the core building layers to exist, then inserts itself underneath them.
 * The only wiring needed is the script tag — see docs/OUTER_RING.md.
 *
 * Public (window) API:
 *   initOuter(map)            — add the source + layers (called automatically)
 *   applyOuterColors(map, p)  — retint for time-of-day p (hooked automatically)
 *   applyOuterSettings(map)   — re-read OUTER after a live edit / preset change
 *   OUTER                     — the taste block (below)
 */
(function () {
  'use strict';

  const q = new URLSearchParams(window.location.search);

  const OUTER = {
    // ?outer=0 removes the ring entirely at load. This exists for
    // scripts/verify/outer-perf.mjs, which measures the A/B on the same build
    // rather than on two checkouts.
    on: q.get('outer') !== '0',
    // Below this the ring is off screen anyway and the tiles are wasted work.
    // 12.6 is roughly "the whole box fills the frame".
    minZoom: 12.6,
    // At or above this a ring building is a tower: pattern + roof cap.
    // Matches TOWER_H in scripts/bake_outer.py, which stamps `t`.
    towerCap: true,
    // ── The brown smear above 80 degrees of pitch ──────────────────
    //
    // The ring's low-rise half gets no roads, no trees, no ground detail and no
    // pattern — by design, it is backdrop. Look near-horizontally and thousands
    // of those flat prisms mass edge-on into one featureless brown plane that
    // covers the real scene. Measured at the same camera, share of the lower
    // frame that is flat ring brown:
    //
    //     pitch 70   6.6%      pitch 84   18.6%
    //     pitch 78   6.1%      pitch 88   61.9%
    //
    // Nothing between 70 and 78, then it runs away. It was invisible until now
    // because MapLibre's maxPitch was 85; the pitch ceiling was just raised to
    // 90, which is what exposed it. Confirmed pre-existing and NOT caused by the
    // tiling change below: reverting that to maxzoom 15 / tolerance 1.5 renders
    // the identical frame.
    //
    // The TOWERS keep drawing at any pitch — the skyline silhouette is the whole
    // reason this module reaches south to the lake, and 114 towers do not mass
    // into anything. It is only the 7,511 low-rise prisms that go.
    flatMaxPitch: 80,
    flatFadePitch: 84,   // fully gone by here
    opacity: 1.0,
    // ── QUEUE K5: downtown reads cooler and greyer than campus ──────
    //
    // Measured (HANDOFF #74, re-confirmed acer/q-downtown 2026-08-22, same
    // wide day pose both times): downtown towers B-R -13.5 sat 8.8% against
    // campus B-R -49.4 sat 30.2%. Two lanes already showed GRADE (js/graphics.js)
    // can't fix this — it's one filter over the whole canvas and campus already
    // matches its own reference photograph, so warming GRADE globally would
    // make campus wrong to fix downtown.
    //
    // What's actually cool and grey is narrower than "downtown": HANDOFF #74's
    // population read found downtown's own 645-building streetwall is already
    // warm (B-R -34.3, close to campus) — it is specifically the 243 glass
    // TOWERS (`pal.buckets` below, not `pal.midrise`) that are blue-dominant.
    // So this dial only ever touches tower wall/glass day+golden colour
    // (`wd`/`wg`) — see warmTowerBuckets() below, applied once per palette
    // fetch. `wn` (night) is untouched: at night the wall is mostly covered by
    // lit windows and this was never a night complaint.
    //
    // Bounded on purpose: the reference photographs this palette was fitted to
    // (HANDOFF #74 again) put real downtown glass at B-R +1..+45 -- genuinely
    // blue, not grey-neutral -- so this closes the "greyer" half hard and the
    // "cooler" half partway, it does not chase downtown all the way to
    // campus's own -49.4. TASTE KNOB (CLAUDE.md rule 11): 0 disables this
    // entirely and ships the bake's own colours unmodified; 1 is what ships.
    towerWarmAmount: 1,
    // ── QUEUE K7 #2: far-ring vegetation outlines ignored the hour ──
    //
    // The Liberty basemap's `park` FILL ships an explicit constant
    // fill-outline-color — rgba(95, 208, 100, 1), a bright mint green.
    // js/timeofday.js retints every park/landcover fill to the hour's park
    // tone, but it only writes 'fill-color', and a fill layer with an
    // AUTHORED outline keeps it. So beyond the core box (where our own
    // opaque ground covers the basemap) every far park polygon wore a
    // glowing daylight-green wireframe at night — the squiggles in
    // shots/f/sweep/sw-H4-city-night.png, muted but present at day/dusk.
    // Isolated by magenta mask 2026-08-22 (docs/k7-greenring.md): painting
    // this one paint property magenta recoloured exactly the squiggles.
    //
    // The fix copies the fill's own just-tinted colour onto the outline on
    // every retint, so the outline rides the same night fade the fill does,
    // at every hour, by construction — no second copy of the park palette
    // in this file to drift. TASTE KNOB (CLAUDE.md rule 11): false leaves
    // the basemap outlines exactly as authored.
    vegOutlineTint: true,
  };
  window.OUTER = OUTER;

  // The colour transform itself, and the numbers it runs on. Split out from
  // OUTER above only because there are several of them and they're not
  // independently meaningful — dial `OUTER.towerWarmAmount` for the one knob
  // a taste call needs; these are for whoever re-derives the shape of it.
  const TOWER_WARM = {
    // RGB channel multipliers pulling a bucket toward warm: red up, blue down,
    // green nearly flat. Applied luma-preserving (see warmRgb below) so this
    // never reads as a brightness change, only a colour one.
    gain: [1.28, 1.03, 0.74],
    // How much of `gain` each bucket CLASS receives — see classifyBucket().
    // Buckets already warm (masonry-toned accents) or already near-white
    // (showpiece pale glass, e.g. a diagrid tower) get a light touch so they
    // don't get pushed into looking like a different material; the plainly
    // blue-grey buckets, which are the ones the complaint is actually about,
    // get the full amount.
    amount: { cool: 1.0, warm: 0.25, pale: 0.30 },
    // HSL saturation multiplier applied AFTER the warm shift (the shift alone
    // pulls some buckets close to neutral before it pulls them past it into
    // warm, which would otherwise leave them looking greyer mid-transform).
    satBoost: { cool: 1.3, warm: 1.1, pale: 1.15 },
    // Ceiling on the boosted saturation so no bucket becomes a cartoon colour.
    satCap: 42,
  };

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  }
  const LUMA_W = [0.299, 0.587, 0.114];             // Rec.601, same as facades.js
  const luma = rgb => rgb[0] * LUMA_W[0] + rgb[1] * LUMA_W[1] + rgb[2] * LUMA_W[2];
  function rgbToHsl(rgb) {
    let [r, g, b] = rgb.map(v => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s; const l = (max + min) / 2;
    if (max === min) { h = s = 0; } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h * 360, s * 100, l * 100];
  }
  function hslToRgb(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    if (s === 0) { const v = l * 255; return [v, v, v]; }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
  }

  /**
   * cool  — blue channel clearly leads red: the blue-grey glass this exists for.
   * pale  — light and already low-saturation: a showpiece near-white tower.
   * warm  — everything else (already red-leaning masonry/accent tone).
   *
   * Classified from the bucket's OWN `wd`, not a hardcoded bucket-index map,
   * so this keeps working if bake_outer_facades.py ever re-clusters the ten
   * buckets differently — the rule is about what colour a bucket IS, not
   * which ordinal it happens to land on this bake.
   */
  function classifyBucket(wdHex) {
    const rgb = hexToRgb(wdHex);
    const [, s, l] = rgbToHsl(rgb);
    if (l > 80 && s < 20) return 'pale';
    if (rgb[2] - rgb[0] > 8) return 'cool';
    return 'warm';
  }

  /** Warm one hex colour by `amount` of TOWER_WARM.gain, luma-preserving. */
  function warmHex(hex, amount) {
    const rgb0 = hexToRgb(hex);
    const g = TOWER_WARM.gain.map((v, i) => 1 + (v - 1) * amount);
    const shifted = rgb0.map((v, i) => v * g[i]);
    const l0 = luma(rgb0), l1 = luma(shifted);
    const scaled = l1 > 0 ? shifted.map(v => v * (l0 / l1)) : shifted;
    return scaled.map(v => Math.max(0, Math.min(255, v)));
  }

  /** Boost HSL saturation of an [r,g,b] by `factor`, capped, luma-preserving. */
  function boostSat(rgb, factor, cap) {
    const [h, s, l] = rgbToHsl(rgb);
    const rgb1 = hslToRgb(h, Math.min(cap, s * factor), l);
    const l0 = luma(rgb), l1 = luma(rgb1);
    return l1 > 0 ? rgb1.map(v => Math.max(0, Math.min(255, v * (l0 / l1)))) : rgb1;
  }

  /**
   * Returns a NEW buckets array (day + golden warmed, night and `fb` kept
   * exactly as baked) — never mutates the fetched palette, so a second call
   * (there isn't one today, but nothing here assumes there won't be) always
   * starts from the same source numbers.
   */
  function warmTowerBuckets(buckets) {
    const master = (window.OUTER && typeof window.OUTER.towerWarmAmount === 'number')
      ? window.OUTER.towerWarmAmount : 1;
    if (!master) return buckets;
    return buckets.map(b => {
      const cls = classifyBucket(b.wd);
      const amt = TOWER_WARM.amount[cls] * master;
      const satF = TOWER_WARM.satBoost[cls];
      const warm = field => rgbToHex(boostSat(warmHex(b[field], amt), satF, TOWER_WARM.satCap));
      return Object.assign({}, b, { wd: warm('wd'), wg: warm('wg') });
    });
  }

  const SRC = 'city-outer';
  const L_FLAT = 'outer-3d';
  const L_TOWER = 'outer-tower';
  const L_TOWER_ROOF = 'outer-tower-roof';
  const L_MID = 'outer-midrise';
  const L_MID_ROOF = 'outer-midrise-roof';
  const L_DETAIL = 'outer-detail';
  const DATA = 'data/outer_ring.geojson';
  const TOWER_PALETTE = 'data/outer_tower_palette.json';

  // ── the four kinds of feature in outer_ring.geojson ─────────────────
  //
  // `k` is the downtown-detail discriminator (scripts/bake_outer.py, PASS D).
  // A feature WITHOUT it is a wall — a low-rise prism, a tower shaft, a podium,
  // a Jenga block, a taper step — and keeps the pattern and the parapet cap. A
  // feature WITH it is a flat-coloured solid that is not a wall:
  //
  //   k='c'  crown, gable, corner fin, mast   sits on the shaft
  //   k='r'  ground-floor band                sits on the pavement, outset 0.4 m
  //   k='g'  park / plaza pad                 0.45 m off the ground
  //
  // All three want the same paint — one baked colour, own base, own height —
  // so they share ONE layer. Three layers would be three more draw calls over
  // the whole ring to express a difference only the bake cares about.
  const IS_DETAIL = ['has', 'k'];
  const IS_WALL = ['!', IS_DETAIL];
  const IS_TOWER = ['all', ['==', ['get', 't'], 1], IS_WALL];
  // `t=2` is the downtown STREETWALL (scripts/bake_outer.py:MIDRISE_H). It is
  // the second exception to "the ring is flat colour", and it exists because a
  // detailed tower standing between blank cream boxes is what "the smaller ones
  // are just skeletons" describes. 725 features, not 7,511 — the argument for
  // keeping the ring flat is a count argument, and this count is a thirtieth of
  // it.
  const IS_MID = ['all', ['==', ['get', 't'], 2], IS_WALL];
  // Everything that is neither, i.e. what stays flat. This USED to be
  // `!= 1`, which would now hand the mid-rise to both layers at once and
  // z-fight the whole of downtown against itself.
  const NOT_TOWER = ['all', ['!=', ['get', 't'], 1], ['!=', ['get', 't'], 2], IS_WALL];

  // Every wall now MAY start above the ground: a tower shaft stands on its
  // podium, a Jenga block on the block below it. `b` is absent on the 7,511
  // low-rise prisms that still start at zero, so this coalesce is what keeps
  // the file from carrying "b":0 seven thousand times.
  const BASE = ['coalesce', ['get', 'b'], 0];

  /**
   * The density filter, shaped exactly like js/app.js:treeFilter.
   *
   * `d` is baked as an importance rank (0 = most worth drawing), so a density
   * below 1 thins the small and the far first, evenly, everywhere — instead of
   * deleting a neighbourhood. Towers rank in the top 1.6% and are never thinned
   * by any density above 0.02.
   */
  function densityFilter(base) {
    const dens = (window.GFX && typeof window.GFX.outerDensity === 'number')
      ? window.GFX.outerDensity : 1;
    return dens >= 1 ? base : ['all', base, ['<=', ['get', 'd'], dens]];
  }

  /** ['interpolate', p, day, golden, night] — the shape timeofday.js bakes with. */
  function tod(p, d, g, n) {
    p = Math.max(0, Math.min(1, p));
    return ['interpolate', ['linear'], p,
      0, ['to-color', ['get', d], '#888888'],
      0.5, ['to-color', ['get', g], '#888888'],
      1, ['to-color', ['get', n], '#333344'],
    ];
  }
  const bakedColor = p => tod(p, 'wd', 'wg', 'wn');
  const roofColor = p => tod(p, 'rd', 'rg', 'rn');

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ': ' + r.status);
    return await r.json();
  }

  /**
   * ── THE TOWER PALETTE IS FETCHED HERE, AT PARSE TIME, AND THAT IS THE POINT ──
   *
   * MEASURED on a cold load (V8 sampler + a wrapped `fetch`, 2026-08-16, the
   * numbers are in HANDOFF §133): `initOuter` used to be the thing that asked
   * for this file, and it does not get to run until buildScene() has finished —
   * around t = 8.0 s. By then roughly a hundred other requests for `data/` are
   * in flight, so a 3 KB JSON took **1,201 ms** to come back. Requested from
   * here it goes out at ~0.5 s into a queue that is still empty.
   *
   * That matters far more than 1.2 s of network sounds, because this file is on
   * the critical path of DOWNTOWN. `city-outer` is not "the far skyline" —
   * it is where every downtown tower in the scene lives (L_TOWER, 114 of them),
   * and nothing about downtown can start loading until this promise settles.
   * Simeon's complaint is "the downtown buildings aren't loaded even when the
   * loading screen completes", and this fetch was sitting in the middle of it.
   *
   * It costs one 3 KB request that the page was always going to make anyway. If
   * the ring is switched off with ?outer=0 it is not made at all.
   */
  let _palettePromise = null;
  function towerPaletteOnce() {
    if (!_palettePromise) {
      // QUEUE K5: warm the TOWERS only (see TOWER_WARM above) -- midrise is
      // left exactly as baked, it was never the blue-grey half of the split.
      _palettePromise = getJSON(TOWER_PALETTE).then(pal => {
        if (pal && pal.buckets) pal.buckets = warmTowerBuckets(pal.buckets);
        return pal;
      });
    }
    return _palettePromise;
  }
  // The .catch is not optional: an unawaited rejected promise is an unhandled
  // rejection, and initOuter's own try/catch cannot cover a promise created
  // before it ran. Both callers see the same rejection; only one reports it.
  if (OUTER.on) towerPaletteOnce().catch(() => {});

  let _added = false;
  let _gj = null;          // kept for the palette-churn re-snap, below
  // `source-layer` for the ring's three layers, or {} on the GeoJSON fallback.
  // MODULE SCOPE: the source is created in one place and the layers are built
  // further down the same function. Declaring it beside addSource is what broke
  // the roads pass — it went out of scope and took the whole ground stage with
  // it.
  let outerLP = {};
  let _palSig = null;

  /** A cheap signature of the facade palette, to notice when it changes. */
  function paletteSignature() {
    try {
      return (window.facadePalette() || []).map(k => k.wd).join('|');
    } catch (e) { return null; }
  }

  /**
   * Re-snap the towers if the facade palette moved under them.
   *
   * Switching snapshot date re-runs quantiseFacades on the new buildings, which
   * re-derives the fourteen buckets FROM THAT DATA. If a bucket shifts, the
   * pattern ids the towers were stamped with at load either point at a
   * different colour now or stop being repainted by updateFacades at all — a
   * downtown that silently stops following the time of day.
   *
   * In practice the four snapshots on disk are the same buildings, so the
   * signature check makes this a no-op and the re-tile is never paid. It exists
   * so that stops being true quietly.
   */
  function resnapIfPaletteChanged(map) {
    if (!_gj || !map.getSource(SRC)) return;
    const sig = paletteSignature();
    if (!sig || sig === _palSig) return;
    _palSig = sig;
    const towers = _gj.features.filter(f => f.properties && f.properties.t === 1);
    const n = window.quantiseOuterFacades(towers, map);
    map.getSource(SRC).setData(_gj);
    console.log('[outer] facade palette changed —', n, 'towers re-snapped');
  }

  window.initOuter = async function initOuter(map) {
    if (!OUTER.on || _added || map.getSource(SRC)) return;
    _added = true;

    // TILES, AND THE ONE THING THEY COST HERE.
    //
    // The ring is 2.59 MB of GeoJSON against a 1.56 MB archive. But the tower
    // facades are stamped ONTO THE FEATURES at runtime: quantiseOuterFacades
    // clusters the 114 downtown towers' baked wall colours against the campus
    // palette and writes `wp` on each one, and FACADE_PATTERN_EXPR is
    // ['coalesce', ['get','wp'], 'mh00']. A vector tile cannot be mutated, and
    // `wp` is not in the archive because it does not exist until the campus
    // palette has been derived in the browser.
    //
    // So on the tile path every tower falls back to the 'mh00' pattern. That is
    // a VISUAL change to the most-filmed subject in the scene, not a free win,
    // which is why it is measured in the PR rather than assumed.
    const outerTiles = window.tileSource && window.tileSource('outer');
    outerLP = outerTiles ? outerTiles.layerProps : {};

    let gj = null, towers = [];
    // How L_TOWER and L_MID find their pattern: a match on the BAKED ordinal
    // `fb`, on BOTH data paths.
    //
    // THIS USED TO BE TWO DIFFERENT ELECTIONS and that was a latent divergence.
    // The tile path joined the baked buckets by `fb`; the GeoJSON path threw
    // them away and re-clustered the same towers in the browser
    // (quantiseOuterFacades), so `&tiles=0` rendered a downtown built by
    // different arithmetic from the one the site serves — and the fallback is
    // exactly the path you reach for when you are debugging the real one. The
    // ordinal is in outer_ring.geojson either way, so there is no reason for
    // the browser to elect anything: one election, in the bake, for both.
    //
    // The low-rise ring is still snapped in the browser, because its buckets
    // are the CAMPUS palette and porting that election is C1's other half.
    let towerPattern = window.FACADE_PATTERN_EXPR;
    let midPattern = null;

    // Both classes register the same way; only the family differs. Towers are
    // `tg` (51% glazing, curtain wall) and the streetwall is `mh` (20%, the
    // punched campus-hall grid) — putting a curtain wall on a two-storey
    // shopfront is the same category error as putting campus tan on a tower.
    const joinBuckets = (buckets, key, family) => {
      if (!buckets || !buckets.length) return null;
      const ids = window.registerFacadeBuckets &&
                  window.registerFacadeBuckets(map, buckets, { key, family });
      if (!ids || !ids.length) return null;
      const match = ['match', ['get', 'fb']];
      buckets.forEach((b, i) => { match.push(b.fb, ids[i]); });
      match.push('mh00');            // an unstamped building keeps the old look
      return window.facadeTierExpr ? window.facadeTierExpr(match) : match;
    };

    if (!outerTiles) {
      try {
        gj = await getJSON(DATA);
      } catch (e) {
        console.warn('[outer]', e.message, '- ring not drawn');
        return;
      }

      // NOTHING IS STAMPED HERE ANY MORE. `fb` is already on every tower and
      // every mid-rise in the file, put there by
      // scripts/bake_outer_facades.py, and the match built above reads it — so
      // this path and the tile path now render downtown from the same
      // arithmetic instead of two elections that merely agreed in practice.
      //
      // The old code called quantiseOuterFacades(towers) here, which clustered
      // the same 243 towers a second time in the browser and wrote `wp`. That
      // is what the removal is; `quantiseOuterFacades` itself is untouched and
      // still owns the campus/low-rise snap it was written for.
      towers = gj.features.filter(f => f.properties && f.properties.t === 1);
      _gj = gj;
      _palSig = paletteSignature();
    }

    // This used to listen to the snapshot <select> so it could re-snap when
    // app.js reloaded a different date's buildings and re-derived the palette.
    // The snapshot feature is gone, so there is no longer any event that can move
    // the palette under the towers. resnapIfPaletteChanged() is kept and still
    // correct — it is simply no longer wired to anything.

    map.addSource(SRC, outerTiles ? outerTiles.source : {
      type: 'geojson',
      data: gj,
      // Three tiler settings, and all three are the point of this layer.
      //   maxzoom 15  stop generating tiles above z15. The spawn pose is z16.5,
      //               so the ring is permanently overzoomed — which is exactly
      //               the LOD wanted, and it means the tile set is built once
      //               instead of re-cut at every zoom the camera passes.
      //   tolerance   geojson-vt's own simplification, on top of the 85% the
      //               bake already removed. Cheap, and invisible at this range.
      //   buffer      left at MapLibre's default 128 on purpose. Lowering it
      //               saves duplicated geometry across tile seams and clips
      //               large footprints, which shows up as a wall face floating
      //               at a tile boundary — a visible artefact to save bytes
      //               that gzip mostly gets back anyway.
      // maxzoom 15 was already the right instinct and it is what
      // window.PATTERN_TILING generalised to every other patterned source after
      // the city-wide window flicker was traced to fill-extrusion-pattern being
      // TILE-anchored and cross-faded between zoom levels. This source was the
      // one that never got it, and it is the one carrying the 114 downtown
      // towers' curtain-wall pattern (L_TOWER below) from OUTER.minZoom 12.6 —
      // so a descent over downtown crosses an uncapped tile boundary and blends
      // two scales of the same window grid onto one tower face. Same defect,
      // most-filmed subject in the scene.
      //
      // Spread the shared block rather than restating the numbers, so the ring
      // can never drift away from the rest of the city again. It resolves to
      // maxzoom 16 / tolerance 0.5 / buffer 128 — a z16 tile is ~611 m and the
      // ring's own bake has already removed 85% of its vertices, so the finer
      // tolerance costs little and buys back the "wall face floating at a tile
      // boundary" clipping this comment used to worry about.
      ...(window.PATTERN_TILING || { maxzoom: 15, tolerance: 1.5 }),
    });

    // Underneath everything of ours. `buildings-ao` is the first layer app.js
    // adds for the core, so inserting before it keeps the ring at the bottom of
    // our stack and above the basemap. (Depth testing makes fill-extrusion
    // order mostly moot; this matters for the AO line, which is 2D.)
    //
    // RECOMPUTED PER CALL, not captured once. The patterned layers below are now
    // added in a second turn, after an await, and by then the graphics preset may
    // have removed `buildings-ao` — addLayer against a `before` id that no longer
    // exists THROWS, which would take downtown's towers out entirely.
    const beforeId = () => ['buildings-ao', 'buildings-3d', 'buildings-labels']
      .find(id => map.getLayer(id));
    const p = (window.__todCurrentP != null) ? window.__todCurrentP : 0.3;

    // 1. The ring proper: ONE fill-extrusion, flat colour, no cap, no AO.
    map.addLayer({
      id: L_FLAT, type: 'fill-extrusion', source: SRC, ...outerLP,
      minzoom: OUTER.minZoom,
      filter: densityFilter(NOT_TOWER),
      paint: {
        'fill-extrusion-color': bakedColor(p),
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-base': BASE,
        'fill-extrusion-opacity': OUTER.opacity,
        // Kept ON. It is a shader constant, not a draw, and it is most of what
        // stops 6,800 flat prisms reading as a carpet: the darkened base gives
        // every box a self-shadow and the block reads as depth.
        'fill-extrusion-vertical-gradient': true,
      },
    }, beforeId());

    watchPitch(map);

    // ── STAGE TWO: the patterned downtown. Everything above this line is the
    //    tile stream; everything below it needs the facade ATLAS.
    //
    // WHY THE SPLIT EXISTS. Measured on a cold load (HANDOFF §133): the source
    // used to be added at 12.3-13.2 s, and the first downtown tile came back at
    // 16.6 s. `initOuter` itself entered at 8.0 s — so four to five seconds went
    // on things MapLibre did not need in order to start fetching downtown: a
    // 1,201 ms fetch of a 3 KB palette (now prefetched at parse time, above) and
    // registerFacadeBuckets, which rasterises new facade tiles into the shared
    // atlas and re-uploads it. The atlas is the single most expensive thing this
    // app does on a moving frame (measured.md §1.2 FINDING 2) and it was sitting
    // in front of the tile request for the most-filmed subject in the scene.
    //
    // A vector source fetches nothing until a visible layer references it, so
    // L_FLAT above is what actually opens the stream. By the time the buckets
    // are registered the tiles are already in the browser and the patterned
    // layers light up on the geometry that is there.
    //
    // The cost of the split, stated honestly: for the window between the two
    // stages downtown's TOWERS are absent while the low-rise ring is drawn —
    // L_FLAT's filter is NOT_TOWER. That window is short and it replaces a
    // window in which NOTHING was drawn, so it is strictly less empty, not more.
    let patterned = 0;
    try {
      // ── the tile path's own facade join ────────────────────────────
      //
      // A vector tile cannot be mutated, so `wp` — which does not exist until
      // the campus palette has been derived in this browser — cannot be on it,
      // and every one of the 114 downtown towers fell through
      // ['coalesce', ['get','wp'], 'mh00'] to the campus-hall pattern. That is
      // why downtown is forty identical brick-red boxes: not a data problem,
      // one missing join. The towers' real colours are blue-grey glass and they
      // have been baked and parity-proved (PR #71, #73) since; nothing rendered
      // them.
      //
      // The join is an inert integer. `scripts/bake_outer_facades.py` clusters
      // the towers on their OWN wall colours offline and stamps each with its
      // bucket ORDINAL `fb`, plus the bucket colours in
      // data/outer_tower_palette.json. At boot the browser registers those ten
      // buckets in the shared atlas, gets back whatever palette indices it
      // allocated, and builds the ordinal -> id map here. The ordinal belongs
      // to the data; the id belongs to the session; neither can drift into the
      // other.
      const pal = await towerPaletteOnce();
      const t = joinBuckets(pal.buckets, 'outer-tower', 'tg');
      if (t) { towerPattern = t; patterned += pal.buckets.length; }
      midPattern = joinBuckets(pal.midrise, 'outer-midrise', 'mh');
      if (midPattern) patterned += pal.midrise.length;
    } catch (e) {
      // Unchanged behaviour: the towers still get drawn, on the campus pattern.
      // "Palette missing" must never mean "downtown missing".
      console.warn('[outer] downtown palette not applied:', e.message);
    }

    // The map can be torn down between the two stages (a reload mid-boot, the
    // graphics menu rebuilding the style). Adding a layer to a dead map throws
    // inside a promise, where nothing catches it.
    if (!map.getSource(SRC)) {
      console.warn('[outer] source gone before the patterned layers landed');
      return;
    }

    // 2. The exception: downtown towers, on the core's existing atlas.
    map.addLayer({
      id: L_TOWER, type: 'fill-extrusion', source: SRC, ...outerLP,
      minzoom: OUTER.minZoom,
      filter: IS_TOWER,
      paint: {
        'fill-extrusion-pattern': towerPattern,
        'fill-extrusion-height': ['get', 'h'],
        // A shaft starts on its podium. Before this the podium and the shaft
        // were the same prism and downtown was forty flat-sided boxes.
        'fill-extrusion-base': BASE,
        'fill-extrusion-opacity': OUTER.opacity,
        'fill-extrusion-vertical-gradient': true,
      },
    }, beforeId());

    // 2a. The downtown STREETWALL. Same treatment as a tower — a real window
    //     pattern and a parapet — on the 8-40 m buildings between them. Falls
    //     back to the flat layer if the palette did not register, rather than
    //     drawing an unpatterned hole: MapLibre paints an unknown pattern id
    //     TRANSPARENT, so "no pattern" must mean "no layer", not "empty layer".
    if (midPattern) {
      map.addLayer({
        id: L_MID, type: 'fill-extrusion', source: SRC, ...outerLP,
        minzoom: OUTER.minZoom,
        filter: IS_MID,
        paint: {
          'fill-extrusion-pattern': midPattern,
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-base': BASE,
          'fill-extrusion-opacity': OUTER.opacity,
          'fill-extrusion-vertical-gradient': true,
        },
      }, beforeId());
    }

    // 2b. The downtown detail: crowns, gables, masts, ground-floor bands and
    //     park pads. One flat-coloured fill-extrusion for all of them, filtered
    //     on `k`. NOT density-filtered: a crown is 4% of its tower's height and
    //     the whole point of it, so thinning it before the tower under it is
    //     backwards, and there are 674 of these against 7,754 walls.
    //
    // IT STAYS IN STAGE TWO, AND THE REASON IS MEASURED. This layer does not
    // need the palette, so the first cut of the split put it in stage one with
    // L_FLAT — which moved it from fourth in the stack to second, ahead of
    // L_TOWER. A settled downtown A/B then showed 63 pixels changed against a
    // zero-pixel same-build noise floor, scattered as single pixels along the
    // 2-8 km skyline. That is a coplanar tie-break flipping: a crown's BASE is
    // exactly its shaft's HEIGHT, so the two surfaces meet on one plane and
    // whichever fill-extrusion draws first wins the depth test on the seam.
    //
    // Nothing about opening the tile stream needs this layer — L_FLAT alone
    // does that, since a vector source fetches nothing until a visible layer
    // references it. So it costs nothing to keep the six layers in the order
    // they have always been in, and the split becomes pixel-identical.
    map.addLayer({
      id: L_DETAIL, type: 'fill-extrusion', source: SRC, ...outerLP,
      minzoom: OUTER.minZoom,
      filter: IS_DETAIL,
      paint: {
        'fill-extrusion-color': bakedColor(p),
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-base': BASE,
        'fill-extrusion-opacity': OUTER.opacity,
        'fill-extrusion-vertical-gradient': true,
      },
    }, beforeId());

    // 3. A parapet cap on the towers only, using app.js's shared geometry rule
    //    so the ring cannot drift from the core's. Without it the window
    //    pattern wraps over the roof plane, and from campus you look slightly
    //    DOWN at downtown — those roofs are in frame.
    const G = window.CAP_GEOM;
    if (OUTER.towerCap && G) {
      map.addLayer({
        id: L_TOWER_ROOF, type: 'fill-extrusion', source: SRC, ...outerLP,
        minzoom: OUTER.minZoom,
        filter: IS_TOWER,
        paint: {
          // rd/rg/rn are baked for the TOWERS ONLY — 114 features, not 7,138 —
          // for exactly the reason the rest of the ring does not get them:
          // three more hex strings on every house would be most of the file for
          // a roof plane nobody ever sees. This first reused wd/wg/wn, which
          // painted the parapet the same colour as the wall it sits on: a cap
          // you cannot see is a draw call you are paying for.
          'fill-extrusion-color': roofColor(p),
          'fill-extrusion-height': G.height(['get', 'h']),
          'fill-extrusion-base': G.base(['get', 'h']),
          'fill-extrusion-opacity': 1.0,
        },
      }, beforeId());

      // 3b. …and the same parapet on the streetwall, which is where a flat cut
      //     is most obvious: you look DOWN on a 12 m roof from anywhere on
      //     campus. This costs no new features — `t=2` carries rd/rg/rn for
      //     exactly this, the same way `t=1` does — and it is the shared
      //     CAP_GEOM rule, so the ring's parapet cannot drift from the core's.
      if (midPattern) {
        map.addLayer({
          id: L_MID_ROOF, type: 'fill-extrusion', source: SRC, ...outerLP,
          minzoom: OUTER.minZoom,
          filter: IS_MID,
          paint: {
            'fill-extrusion-color': roofColor(p),
            'fill-extrusion-height': G.height(['get', 'h']),
            'fill-extrusion-base': G.base(['get', 'h']),
            'fill-extrusion-opacity': 1.0,
          },
        }, beforeId());
      }
    }

    // The pitch fade and the visibility sweep both walk the full layer list, and
    // two of those layers only exist now. Re-run it so a camera that was already
    // above OUTER.flatMaxPitch when stage one landed is honoured.
    try { window.applyOuterSettings(map); } catch (e) {}

    console.log('[outer]', outerTiles ? 'ring streaming as tiles;'
                                      : gj.features.length + ' ring buildings;',
                patterned, 'downtown facade buckets registered from the baked',
                'ordinals (towers + streetwall)', midPattern ? '' : '- NO STREETWALL');
  };

  // ── K7 #2: keep the basemap's vegetation outlines on the hour's tint ──
  //
  // Which layers: mirrors the park bucket test in js/timeofday.js
  // cleanupBasemap() — the basemap fills whose 'fill-color' already follows
  // the hour — narrowed to the ones that CARRY an authored outline, since a
  // fill without one antialiases in its own (tinted) fill colour and needs
  // nothing. On today's Liberty style that is exactly one layer, `park`;
  // derived rather than hardcoded so a basemap update cannot quietly ship a
  // second daylight wireframe.
  const isVegFill = l => l.type === 'fill' && (
    ['park', 'landcover'].includes((l['source-layer'] || '').toLowerCase()) ||
    /park|grass|wood|forest|garden/.test(l.id.toLowerCase()));
  let _vegOutlineIds = null;    // derived once; existence re-checked per call
  const _vegOutlineLast = {};   // last colour written, to skip per-frame writes
  function tintVegOutlines(map) {
    if (!OUTER.vegOutlineTint || !map || !map.getStyle) return;
    if (_vegOutlineIds === null) {
      try {
        const style = map.getStyle();
        if (!style || !style.layers) return;
        _vegOutlineIds = style.layers
          .filter(l => isVegFill(l) &&
                       map.getPaintProperty(l.id, 'fill-outline-color') != null)
          .map(l => l.id);
      } catch (e) { return; }
    }
    for (const id of _vegOutlineIds) {
      try {
        if (!map.getLayer(id)) continue;
        const fill = map.getPaintProperty(id, 'fill-color');
        if (fill == null) continue;
        // applyOuterColors runs on EVERY applyTimeOfDay call, including the
        // cheap per-frame ones; the fill only moves on the quantised heavy
        // passes, so a string compare skips the redundant writes.
        const key = typeof fill === 'string' ? fill : JSON.stringify(fill);
        if (_vegOutlineLast[id] === key) continue;
        map.setPaintProperty(id, 'fill-outline-color', fill);
        _vegOutlineLast[id] = key;
      } catch (e) {}
    }
  }

  window.applyOuterColors = function applyOuterColors(map, p) {
    if (!map || !map.getLayer) return;
    // Before the early returns on our own layers: the vegetation outlines are
    // BASEMAP layers and must follow the hour even with the ring off (?outer=0).
    tintVegOutlines(map);
    try {
      if (map.getLayer(L_FLAT))
        map.setPaintProperty(L_FLAT, 'fill-extrusion-color', bakedColor(p));
    } catch (e) {}
    try {
      // The crowns and the park pads carry their own baked trio, so they follow
      // the hour by the same expression the ring does. Miss this and every
      // tower keeps a daylit hat after dark — the §35 item 1 failure, on 146
      // features instead of one stadium.
      if (map.getLayer(L_DETAIL))
        map.setPaintProperty(L_DETAIL, 'fill-extrusion-color', bakedColor(p));
    } catch (e) {}
    try {
      // BOTH parapets, or the mid-rise keeps a daylit roof after dark — the
      // §35 item 1 failure, on 725 more features. A layer added in this pass
      // that is missing from this function is the single easiest way to
      // reintroduce it, which is why the list is walked rather than written out.
      for (const id of [L_TOWER_ROOF, L_MID_ROOF]) {
        if (map.getLayer(id))
          map.setPaintProperty(id, 'fill-extrusion-color', roofColor(p));
      }
    } catch (e) {}
    // L_TOWER and L_MID carry their colour inside the shared facade atlas,
    // which updateFacades() has already repainted by the time we get here.
  };

  /**
   * How much of the flat ring to draw at the current pitch. 1 below
   * flatMaxPitch, 0 at flatFadePitch and above, linear between — a fade rather
   * than a switch, so it cannot pop while the camera is tilting.
   */
  function flatOpacityFor(map) {
    const pitch = map.getPitch ? map.getPitch() : 0;
    if (pitch <= OUTER.flatMaxPitch) return OUTER.opacity;
    if (pitch >= OUTER.flatFadePitch) return 0;
    const t = (pitch - OUTER.flatMaxPitch) / (OUTER.flatFadePitch - OUTER.flatMaxPitch);
    return OUTER.opacity * (1 - t);
  }

  /** Re-read OUTER / GFX.outerDensity after a live edit or a preset change. */
  window.applyOuterSettings = function applyOuterSettings(map) {
    if (!map || !map.getLayer) return;
    const flatOp = flatOpacityFor(map);
    // L_DETAIL is deliberately NOT in the pitch fade. The fade exists because
    // 7,511 low-rise prisms mass edge-on into one brown plane above 80 degrees;
    // 146 crowns and 309 flat park pads cannot mass into anything, and a
    // skyline that loses its crowns when the camera tilts is the defect this
    // whole pass is fixing.
    // L_MID is not in the pitch fade either, for the same reason as L_DETAIL:
    // it is downtown, it is 725 features, and it cannot mass into a plane.
    const ROOFS = [L_TOWER_ROOF, L_MID_ROOF];
    for (const id of [L_FLAT, L_TOWER, L_MID, L_TOWER_ROOF, L_MID_ROOF, L_DETAIL]) {
      if (!map.getLayer(id)) continue;
      try {
        map.setLayoutProperty(id, 'visibility', OUTER.on ? 'visible' : 'none');
        map.setPaintProperty(id, 'fill-extrusion-opacity',
                             ROOFS.indexOf(id) >= 0 ? 1.0
                             : id === L_FLAT ? flatOp : OUTER.opacity);
      } catch (e) {}
    }
    try {
      if (map.getLayer(L_FLAT)) map.setFilter(L_FLAT, densityFilter(NOT_TOWER));
    } catch (e) {}
  };

  /**
   * Follow the pitch. `pitch` fires on every frame of a tilt, so the opacity is
   * only written when the bucket it lands in actually changes — otherwise this
   * is a setPaintProperty per frame on a layer with 7,511 features.
   */
  let _lastFlatOp = null;
  function watchPitch(map) {
    const update = () => {
      if (!map.getLayer(L_FLAT) || !OUTER.on) return;
      const op = flatOpacityFor(map);
      if (_lastFlatOp != null && Math.abs(op - _lastFlatOp) < 0.02) return;
      _lastFlatOp = op;
      try { map.setPaintProperty(L_FLAT, 'fill-extrusion-opacity', op); } catch (e) {}
    };
    map.on('pitch', update);
    map.on('move', update);
    update();
  }

  // ── bootstrap ─────────────────────────────────────────────────────
  // A new module needs a <script> tag and nothing else. js/app.js is owned by
  // another pass, so rather than ask for a call inside buildScene(), this waits
  // for the map and for the core layers to be up and then inserts itself under
  // them. It also wraps applyTimeOfDay the same way — installed here, after
  // every module has loaded, so script order cannot break it.
  function boot() {
    const map = window.__map;
    if (!map) return setTimeout(boot, 60);

    const hookTod = () => {
      if (typeof window.applyTimeOfDay !== 'function' || window.applyTimeOfDay.__outer) return;
      const prev = window.applyTimeOfDay;
      const wrapped = function (m, p, force) {
        const r = prev.apply(this, arguments);
        try { window.applyOuterColors(m, p); } catch (e) {}
        return r;
      };
      wrapped.__outer = true;
      window.applyTimeOfDay = wrapped;
    };

    const go = () => {
      // Wait for the core buildings AND the facade atlas: the towers snap onto
      // patterns that must already be registered, and a tower that asks for an
      // image MapLibre does not have is painted transparent.
      if (!map.getLayer('buildings-3d') || typeof window.quantiseOuterFacades !== 'function') {
        return setTimeout(go, 120);
      }
      hookTod();
      // Catch-up for K7 #2: the initial retint may have run before the hook
      // above existed, leaving the vegetation outlines on their authored
      // daylight green until the next slider move. Copy the (already tinted)
      // fills once now; every later retint flows through the wrapper. Once
      // more on idle, in case the basemap's own layers land after us.
      try { tintVegOutlines(map); } catch (e) {}
      try { map.once('idle', () => tintVegOutlines(map)); } catch (e) {}
      window.initOuter(map);
    };
    if (map.isStyleLoaded && map.isStyleLoaded()) go();
    else map.once('load', () => setTimeout(go, 0));
  }
  boot();
})();
