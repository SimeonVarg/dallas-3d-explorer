/**
 * roofs.js — the roofscape. What is on top of the buildings, and what colour it is.
 *
 * WHY THIS FILE EXISTS. The app is a flyover: the camera spends most of its time
 * above the city looking down, so the surface the viewer actually sees most is
 * roofs. Before this pass every roof in the scene was one flat quad in
 * `rd` — and `rd` is derived in bake_detail.py as the building's own wall 12%
 * darker. So West Campus, which in the aerial is a field of BRIGHT WHITE TPO
 * membrane carpeted in condenser rows, rendered as a field of brown lids.
 *
 * `data/roofscape.geojson` (scripts/bake_roofscape.py) fixes both halves of
 * that, and the colour half matters more than the clutter half:
 *
 *   deck    one polygon per building in its OWN colour, measured off z20 Esri
 *           nadir imagery. It sits ON the parapet cap app.js already draws
 *           (CAP_GEOM), inset 1.1 m, so the cap reads as a rim around it.
 *
 *           THAT RIM WAS BURNT ORANGE FOR AS LONG AS THIS FILE HAS EXISTED, on
 *           every flat roof on campus, because `buildings-roof` is painted from
 *           the BUILDING's `rd` — a terracotta roof colour — and this deck is
 *           not. Measured at `day-tower-close`, the cap owned 9,543 px of
 *           rgb(173,88,51) around 81,414 px of rgb(151,138,114) deck
 *           (scripts/verify/roof-ring.mjs). It read as a selection highlight.
 *           The rim is still there and still reads as a parapet — it is now
 *           the deck's OWN colour, joined to the building offline by
 *           scripts/bake_roofs.py and applied to the building feature in
 *           js/app.js's loadScene. The sentence above is therefore still true;
 *           what changed is which palette the rim comes out of.
 *   clutter condensers, AHUs, fans, ducts, plant screens, stair/lift
 *           penthouses and rooftop pools — position, footprint, orientation and
 *           colour all measured from the same imagery. Height is the one
 *           generative number: a nadir photo cannot measure it.
 *
 * THE THING THAT WILL BITE YOU IS PERFORMANCE, not looks. This is a per-building
 * cost multiplied by ~1,700 buildings, on an app that has already auto-detected
 * ~30 fps and dropped itself into the `performance` preset. So the clutter is
 * split across two layers by SIZE, not by kind:
 *
 *   ROOFS.majorMinZoom  things that read from flying altitude — plant screens,
 *                       penthouses, big banks, pools, and every deck
 *   ROOFS.minorMinZoom  individual condensers, vents, small ducts. Held back
 *                       until they are information rather than noise, exactly
 *                       the way props.js holds back benches.
 *
 * ...and DENSITY IS A PARAMETER, NOT A CULL, the same way tree density is. Every
 * clutter feature carries `d`, a keep-order in 0..1 ordered biggest-first per
 * roof, so turning the knob down thins the specks off each roof and keeps the
 * plant that actually reads. Nothing is silently dropped by region.
 *
 * Public (window) API:
 *   initRoofscape(map)              — add source + layers
 *   applyRoofscapeColors(map, p)    — retint for time-of-day p
 *   setRoofDetail(v)                — 0..1 density, or null to follow the preset
 *   ROOFSCAPE                       — the taste block
 */
(function () {
  'use strict';

  const ROOFS = {
    on: true,
    // The deck is the cheapest feature here (one flat polygon per building, 0.25 m
    // tall, so it adds a top face and almost no side geometry) and the one that
    // carries the whole colour correction. It draws as low as the buildings do.
    deckMinZoom: 14.0,
    majorMinZoom: 14.5,
    minorMinZoom: 16.2,
    // null = follow the graphics preset. A number overrides it.
    detail: null,
    // What each preset asks for. `performance` keeps a bit over half of each
    // roof's units; the plant, penthouses and pools are tier 0 and survive at
    // any density because they are what reads from the air.
    byPreset: { performance: 0.45, balanced: 0.75, cinematic: 1.0, ultra: 1.0 },
  };
  window.ROOFSCAPE = ROOFS;

  const SRC = 'city-roofscape';           // decks + tier 0 — 1.4 MB, always
  const SRC_D = 'city-roofscape-detail';  // tier 1 — 2.4 MB, only if you go low
  const DECK = 'roofscape-deck', MAJOR = 'roofscape-major', MINOR = 'roofscape-minor';
  const LAYERS = [DECK, MAJOR, MINOR];

  const clamp01 = v => Math.max(0, Math.min(1, v));

  /**
   * Same shape as timeofday.js's own bakedColor: an `interpolate` whose INPUT is
   * the constant p and whose STOPS are per-feature `get`s, so one paint value
   * covers every feature and the day->golden->night ramp can never drift from
   * the ramp the rest of the scene uses.
   */
  function bakedColor(p) {
    p = clamp01(p);
    return ['interpolate', ['linear'], p,
      0,   ['to-color', ['get', 'rd'], '#8a8a82'],
      0.5, ['to-color', ['get', 'rg'], '#8a8a82'],
      1,   ['to-color', ['get', 'rn'], '#22242e'],
    ];
  }

  function detail() {
    if (typeof ROOFS.detail === 'number') return clamp01(ROOFS.detail);
    const g = window.GFX;
    if (g && typeof g.roofDetail === 'number') return clamp01(g.roofDetail);
    const pre = (g && g.preset) || 'balanced';
    return ROOFS.byPreset[pre] != null ? ROOFS.byPreset[pre] : 0.75;
  }

  // MapLibre filters cannot read ['zoom'], which is why the tiers are separate
  // layers with separate minzooms rather than one layer with one clever filter.
  function filterFor(tier) {
    const dens = detail();
    const base = ['all', ['!=', ['get', 'k'], 'deck'], ['==', ['get', 't'], tier]];
    return dens >= 1 ? base : ['all', base, ['<=', ['get', 'd'], dens]];
  }

  /**
   * Insert above our own buildings but below the first symbol layer that follows
   * them. Anchoring at the first symbol layer in the STYLE would drop these to
   * the bottom of the stack, under the ground fill — the exact mistake the
   * stadium layers document in app.js, and it renders as "the roofs vanished".
   */
  function anchorId(map) {
    const stack = map.getStyle().layers;
    const after = Math.max(0, stack.findIndex(l => l.id === 'buildings-3d'));
    const s = stack.slice(after + 1).find(l => l.type === 'symbol');
    return s ? s.id : undefined;
  }

  window.initRoofscape = function initRoofscape(map) {
    if (!ROOFS.on || !map || map.getSource(SRC)) return;
    map.addSource(SRC, { type: 'geojson', data: 'data/roofscape.geojson' });
    const p = window.__todCurrentP != null ? window.__todCurrentP : 0.5;
    const anchor = anchorId(map);
    const col = bakedColor(p);

    if (!map.getLayer(DECK)) {
      map.addLayer({
        id: DECK, type: 'fill-extrusion', source: SRC, minzoom: ROOFS.deckMinZoom,
        filter: ['==', ['get', 'k'], 'deck'],
        paint: {
          'fill-extrusion-color': col,
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-base': ['get', 'b'],
          'fill-extrusion-opacity': 1.0,
        },
      }, anchor);
    }
    if (!map.getLayer(MAJOR)) {
      map.addLayer({
        id: MAJOR, type: 'fill-extrusion', source: SRC, minzoom: ROOFS.majorMinZoom,
        filter: filterFor(0),
        paint: {
          'fill-extrusion-color': col,
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-base': ['get', 'b'],
          'fill-extrusion-opacity': 1.0,
          // ON for the clutter and pointless for the deck: the gradient darkens
          // the bottom of an extrusion, which is what makes a 1.7 m box read as
          // a box standing on a surface rather than a shape painted on it.
          'fill-extrusion-vertical-gradient': true,
        },
      }, anchor);
    }
    // timeofday.js drives every other palette in the scene from a fixed list of
    // applyXColors calls, and this file is not on it. Wrapping the function is
    // what lets the roofscape follow the sun without editing that file — see
    // docs/ROOFSCAPE.md "Registration" for the three-line alternative.
    if (!window.__roofscapeHooked && typeof window.applyTimeOfDay === 'function') {
      const orig = window.applyTimeOfDay;
      window.applyTimeOfDay = function (m, pp, force) {
        const r = orig.apply(this, arguments);
        try { window.applyRoofscapeColors(m, pp); } catch (e) {}
        return r;
      };
      window.__roofscapeHooked = true;
    }

    // The detail tier's source and layer are NOT added here — see maybeDetail().
    map.on('zoom', maybeDetail);
    maybeDetail();
    applyRoofscapeColors(map, p);
  };

  /**
   * Fetch and install the tier-1 detail tier, once, when the camera first gets
   * low enough to draw it.
   *
   * A flyover at z16 never draws an individual condenser, so shipping the 2.4 MB
   * that describes them in the always-loaded document would make every session
   * pay a download and a worker re-tile for geometry it never shows. The trigger
   * sits a little ABOVE minorMinZoom so the fetch and the tiling have started by
   * the time the layer's opacity ramp begins, rather than a thousand boxes
   * appearing several seconds into a descent.
   */
  let _detailAsked = false;
  function maybeDetail() {
    const map = window.__map;
    if (_detailAsked || !map || !ROOFS.on) return;
    if (detail() <= 0) return;
    if (map.getZoom() < ROOFS.minorMinZoom - 0.45) return;
    _detailAsked = true;
    try {
      // The detail tier streams as tiles when data/tiles/roofdetail.pmtiles is
      // there, and falls back to the whole 2.27 MB GeoJSON when it is not.
      // Source and layer are both built in THIS function, so layerProps can be
      // a local — unlike the roads pass, where they live in different functions
      // and a local threw out of scope and took the whole ground stage down.
      const dTiles = window.tileSource && window.tileSource('roofdetail');
      const dLP = dTiles ? dTiles.layerProps : {};
      if (!map.getSource(SRC_D)) {
        map.addSource(SRC_D, dTiles
          ? dTiles.source
          : { type: 'geojson', data: 'data/roofscape.detail.geojson' });
      }
      if (!map.getLayer(MINOR)) {
        const p = window.__todCurrentP != null ? window.__todCurrentP : 0.5;
        map.addLayer({
          id: MINOR, type: 'fill-extrusion', source: SRC_D, ...dLP, minzoom: ROOFS.minorMinZoom,
          filter: filterFor(1),
          paint: {
            'fill-extrusion-color': bakedColor(p),
            'fill-extrusion-height': ['get', 'h'],
            'fill-extrusion-base': ['get', 'b'],
            // Fades in over half a zoom level instead of a thousand boxes
            // popping into existence on one frame.
            'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'],
              ROOFS.minorMinZoom, 0, ROOFS.minorMinZoom + 0.5, 1],
            'fill-extrusion-vertical-gradient': true,
          },
        }, anchorId(map));
      }
    } catch (e) {
      _detailAsked = false;          // let a later zoom try again
      console.warn('[roofscape] detail tier:', e);
    }
  }
  window.roofscapeDetailLoaded = () => _detailAsked;

  function applyRoofscapeColors(map, p) {
    if (!map || !map.getLayer || !map.getLayer(DECK)) return;
    const col = bakedColor(p);
    for (const id of LAYERS) {
      try { if (map.getLayer(id)) map.setPaintProperty(id, 'fill-extrusion-color', col); } catch (e) {}
    }
  }
  window.applyRoofscapeColors = applyRoofscapeColors;

  /** 0..1, or null to follow the graphics preset. Re-filters in place. */
  window.setRoofDetail = function setRoofDetail(v) {
    ROOFS.detail = (v == null) ? null : clamp01(v);
    if (window.GFX) window.GFX.roofDetail = ROOFS.detail;
    const map = window.__map;
    if (!map || !map.getLayer(MAJOR)) return ROOFS.detail;
    try { map.setFilter(MAJOR, filterFor(0)); } catch (e) {}
    try { if (map.getLayer(MINOR)) map.setFilter(MINOR, filterFor(1)); } catch (e) {}
    // Raising the knob from zero at low altitude must still be able to pull the
    // detail tier in later, so re-test rather than assuming init already did.
    maybeDetail();
    return ROOFS.detail;
  };

  /** Visibility switch, so roof-perf.mjs can A/B the whole pass. */
  window.setRoofscapeVisible = function setRoofscapeVisible(on) {
    const map = window.__map;
    if (!map) return;
    for (const id of LAYERS) {
      try {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      } catch (e) {}
    }
  };

  // Self-install. app.js is owned by another pass, so rather than requiring a
  // line in buildScene() this waits for the map and the buildings to exist and
  // then inserts itself. Registering properly is one line and is documented; if
  // that line is ever added, the `getSource` guard above makes this a no-op.
  //
  // THIS USED TO POLL `isStyleLoaded() && getLayer('buildings-3d')` TOGETHER,
  // 600 times at 100 ms, AND THEN GIVE UP IN SILENCE. Both halves are wrong.
  //
  // `map.isStyleLoaded()` is not "the style has been parsed" — it is false
  // while ANY source in the style is still loading, and this scene carries the
  // core buildings, the outer ring, the ground, ~12,000 trees, ~6,000 props and
  // six self-booting building passes that each add their own source seconds
  // apart. Probed 30 s after load on an idle machine it is still false while
  // `buildings-3d` has existed for ages. So the conjunction was only ever
  // satisfied if the poll happened to sample during a momentary gap in source
  // loading — which is a coin flip, and when it lost, the ENTIRE roofscape
  // (3,649 + 8,034 features) simply was not in the scene and nothing said so.
  // A screenshot of that is a plausible-looking city with plain lids, which is
  // exactly the state this pass exists to fix. It is also how this file's
  // 12,058 features sat dead in the repo for days once before.
  //
  // The fix is the shape every other pass in this repo uses and that
  // docs/PASS_COMMON.md tells passes to copy verbatim from js/outer.js: take
  // the style's own `load` EVENT rather than polling a predicate that includes
  // it, then poll only for the thing that actually has to exist. And if it ever
  // does give up, say so at error level — a silent give-up is worse than a
  // crash, because the scene still renders.
  function boot() {
    const map = window.__map;
    if (!map) return setTimeout(boot, 60);

    let tries = 0;
    const go = () => {
      if (!map.getLayer('buildings-3d')) {
        if (++tries > 500) {           // ~60 s, and then LOUDLY
          console.error('[roofscape] buildings-3d never appeared after 60 s — ' +
                        'the roofscape is NOT in this scene');
          return;
        }
        return setTimeout(go, 120);
      }
      try { window.initRoofscape(map); } catch (e) { console.error('[roofscape]', e); }
    };
    if (map.isStyleLoaded && map.isStyleLoaded()) go();
    else map.once('load', () => setTimeout(go, 0));
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 200));
  } else {
    setTimeout(boot, 200);
  }
})();
