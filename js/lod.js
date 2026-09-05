/**
 * lod.js — render distance: draw less detail the further the camera is from it.
 *
 * WHAT WAS TRIED FIRST AND DOES NOT WORK, so nobody spends the afternoon again.
 *
 * The obvious build is per-building distance culling: a circle around the
 * camera, and a `within` filter so anything outside it is not drawn. MapLibre
 * 5.24 ACCEPTS `['within', poly]` on a fill-extrusion layer — setFilter does not
 * throw, and the style validates. It then culls EVERYTHING. Measured by painting
 * the buildings magenta and counting ink (scripts/verify/lod-within.mjs): the
 * city covers 32.9% of the frame unfiltered and 0.00% at every radius tested,
 * including 4000 m, which contains the whole visible scene. `within` supports
 * points and lines; on polygons it is false for every feature. queryRenderedFeatures
 * cannot catch this — it returns 0 for fill-extrusion at a flying pitch either
 * way — which is exactly why that test measures pixels.
 *
 * So per-feature distance is not expressible in this stack. What IS expressible
 * is dropping whole DRAW PASSES, and that turns out to be where the money was:
 *
 *   scripts/verify/lod-perf.mjs, headed Chrome, 3 interleaved and
 *   counterbalanced reps, deterministic bearing sweep, dropped frames not means:
 *
 *     baseline            31.0 fps   135 dropped
 *     tier 1 off          32.6 fps   133 dropped
 *     tier 1+2 off        37.0 fps   109 dropped     <- +6.0 fps, ranges do not overlap
 *     renderScale 0.75    32.5 fps   135 dropped
 *
 * Dropping the two detail tiers beat renderScale 0.75, the lever HANDOFF §20.1
 * calls the master one. That is worth knowing on its own: this app runs 41
 * fill-extrusion layers, and a pass costs whether or not the features in it are
 * big enough to see.
 *
 * THE MODEL. Camera altitude is the proxy for "how far away the scene is" —
 * at a flying pitch the ground under the frame is roughly an altitude away, and
 * altitude is the one number the flight controller already maintains honestly
 * (js/controls.js __fly.eye().alt). So:
 *
 *     tier 1 (fine)  hidden when alt > distance * 0.45
 *     tier 2 (mid)   hidden when alt > distance
 *
 * with `distance` the user's slider in metres. Street level keeps everything;
 * climbing drops the detail that has stopped being legible anyway.
 *
 * WHAT THIS IS NOT. It cannot thin the far half of a LOW, flat view across the
 * city — the camera is close to the near buildings and far from the downtown
 * ones, and MapLibre gives no way to tell those apart in a filter. Per-feature
 * distance would need a baked centroid on every feature and a re-tile, which is
 * a data pass, not a graphics one.
 *
 * Public (window) API:
 *   initLOD(map)      — self-booting; also called by applyGraphics()
 *   applyLOD(map)     — re-evaluate now (after a settings change)
 *   window.LOD_TIERS  — the tier table, for scripts/verify/lod-perf.mjs
 */
(function () {
  'use strict';

  // ── Taste block ─────────────────────────────────────────────────────
  const LOD = {
    // Fraction of the render distance at which the FINE tier goes. Fine detail
    // is sub-metre geometry — bollards, trunks, window mullions — and it stops
    // resolving long before the shapes it sits on do.
    fineAt: 0.45,
    // Hysteresis, as a fraction of the threshold. Without it a camera hovering
    // exactly on a boundary toggles whole layer groups every frame, which reads
    // as flicker and costs more than it saves.
    hysteresis: 0.08,
    // The camera writes altitude every frame; re-evaluating on every one of
    // those would be 60 style writes a second for a decision that changes at
    // walking pace.
    settleMs: 140,
    // At or above this the slider means "unlimited" and nothing is ever dropped.
    // It matches the slider's own maximum in js/graphics.js. 1500 rather than
    // 4000 because the camera cannot climb past ALT_MAX = 900 m: a threshold
    // above that can never be crossed, which is how the whole control came to
    // do nothing on three of the four presets.
    unlimitedAt: 1500,
  };

  // The two tiers, coarsest last. Grouped by what they COST — one full
  // fill-extrusion or symbol pass each — not by how many features they carry.
  // A layer that is not listed is never dropped: the bulk building layers
  // (buildings-3d, outer-3d, outer-tower) are the city itself, and losing them
  // at altitude would be losing the view rather than the detail.
  const TIERS = {
    fine: [
      'props-lit', 'props-art', 'props-art-label', 'props-furniture',
      'props-construction', 'props-flat', 'props-pole', 'props-canopy',
      'trees-trunk', 'roofscape-minor', 'tower-detail', 'arts-panel',
      'arts-glass', 'moody-plant', 'places-glass', 'stadium-detail',
      'drag-cap', 'wc-wall-cap',
    ],
    // NOT IN HERE: `buildings-roof`, `parts-roof`, `outer-tower-roof`. They were,
    // and it is the bug Simeon reported as *"when i go up on low detail mode the
    // roofs of houses become windows this is pretty bad."*
    //
    // Those three are not detail. They are the CAP over the top face of every
    // building extrusion, and the walls under them are drawn with
    // `fill-extrusion-pattern`, which MapLibre paints on the TOP face as well as
    // the sides. Hide the cap and every roof in the city becomes the window grid
    // off its own walls — photographed at detail 350 from 1,127 m in
    // shots/lod/detail-350.png against shots/lod/detail-1500.png.
    //
    // It is also the wrong thing to drop on its own terms: from altitude, roofs
    // are most of what you are looking at. The seven that remain are real detail
    // — canopy, roofscape, pitched roofs, the Moody roof, the arts cap.
    mid: [
      'trees-canopy', 'roofscape-major', 'roofscape-deck',
      'roofs-pitched', 'moody-roof', 'arts-cap',
    ],
  };
  window.LOD_TIERS = TIERS;

  let _map = null, _timer = null;
  // What WE last set each layer to. Any layer we have never hidden is left
  // completely alone, so a module that hides its own layer for its own reasons
  // (graphics.js does this for buildings-ao and the shadow layer) is not fought
  // over — we only ever restore a layer we ourselves hid.
  const _hidden = new Set();

  function distance() {
    const g = window.GFX;
    const d = g && typeof g.renderDistance === 'number' ? g.renderDistance : 0;
    // 0, missing, or the slider at its top = unlimited: draw everything.
    return d > 0 && d < LOD.unlimitedAt ? d : Infinity;
  }

  /** Camera altitude in metres. */
  function altitude() {
    try {
      const a = window.__fly && window.__fly.eye().alt;
      if (isFinite(a) && a > 0) return a;
    } catch (e) {}
    // No flight controller (a bare map or a shot script driving jumpTo): derive
    // it the way atmosphere.js used to. This is the same closed form MapLibre
    // uses internally, not an estimate.
    try {
      const t = _map.transform;
      const a = t.cameraToCenterDistance / t.pixelsPerMeter;
      if (isFinite(a) && a > 0) return a;
    } catch (e) {}
    return 0;
  }

  function wantHidden(tier, alt, D) {
    if (!isFinite(D)) return false;
    const thr = tier === 'fine' ? D * LOD.fineAt : D;
    // Hysteresis: once hidden it takes a real move back inside to return.
    const isHidden = _hidden.has(TIERS[tier][0]);
    return isHidden ? alt > thr * (1 - LOD.hysteresis) : alt > thr * (1 + LOD.hysteresis);
  }

  function apply() {
    if (!_map || !_map.getStyle) return;
    const alt = altitude();
    const D = distance();
    for (const tier of ['fine', 'mid']) {
      const hide = wantHidden(tier, alt, D);
      for (const id of TIERS[tier]) {
        if (!_map.getLayer(id)) continue;
        if (hide) {
          if (_hidden.has(id)) continue;
          try { _map.setLayoutProperty(id, 'visibility', 'none'); _hidden.add(id); } catch (e) {}
        } else if (_hidden.has(id)) {
          // Only ever restore what we hid — never force-show a layer some other
          // module is deliberately holding down.
          try { _map.setLayoutProperty(id, 'visibility', 'visible'); } catch (e) {}
          _hidden.delete(id);
        }
      }
    }
  }

  function schedule() {
    if (_timer) return;
    _timer = setTimeout(() => { _timer = null; apply(); }, LOD.settleMs);
  }

  window.applyLOD = function applyLOD(map) { _map = map || _map; apply(); };

  window.initLOD = function initLOD(map) {
    if (!map || _map === map) return;
    _map = map;
    // `move` covers the flight controller's per-frame jumpTo as well as any
    // easeTo, and it is debounced, so the cost is one evaluation per settle.
    map.on('move', schedule);
    map.on('zoom', schedule);
    apply();
  };

  // Self-booting, the same shape as js/outer.js and the pass modules: index.html
  // and _harness.html each need the script tag and nothing else. KEEP THE TWO
  // FILES IN SYNC — a module present in only one of them renders a scene that
  // looks fine and is not the one the site serves.
  (function boot() {
    if (window.__map) { window.initLOD(window.__map); return; }
    let n = 0;
    const t = setInterval(() => {
      if (window.__map) { clearInterval(t); window.initLOD(window.__map); }
      else if (++n > 600) clearInterval(t);
    }, 100);
  })();
})();
