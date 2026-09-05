/**
 * signs.js — curated branded landmark signage for Austin 3D Explorer
 *
 * Loads data/signs.json (a small, hand-curated GeoJSON whose coordinates and
 * heights come straight from the baked snapshot, so each sign sits on the right
 * building).
 *
 * Design note — the labels used to be brand-coloured at every hour, which put
 * ~50 saturated words of six different hues over the scene at once and read as
 * a debug overlay. They're calm cream by day and only take their brand colour
 * as night falls, which is when a lit sign is supposed to be the thing you
 * notice. Priority-2 names hold back until you're close enough to care.
 *
 * Public (window) API:
 *   initSigns(map, data)                  — add source + layers
 *   applySignGlowLayer(map, signGlow, p)  — 0 (day) … 1 (night)
 */
(function () {
  'use strict';

  const SRC = 'city-signs', LABEL = 'signs-label', POOL = 'signs-ground-glow';

  // Heroes (priority 1) are larger and win placement. Sizes ramp with zoom.
  //
  // These sit at the TOP of the whole label hierarchy: signs > landmark
  // buildings > shops > building names > small building names. A hero is
  // therefore always at least as large as `buildings-labels-major` in app.js
  // (13.5 → 19.5 px over the same span) — if you raise one, raise both, or the
  // pyramid inverts and the Tower reads smaller than the hall behind it.
  const TEXT_SIZE = [
    'interpolate', ['linear'], ['zoom'],
    13, ['match', ['get', 'priority'], 1, 12, 10],
    16, ['match', ['get', 'priority'], 1, 16, 12],
    19, ['match', ['get', 'priority'], 1, 21, 15],
  ];

  // Halo width as a FRACTION of text size, not a fixed 1.5 px. A 1.5 px halo is
  // generous round a 21 px hero and far too thin round a 10 px priority-2 name,
  // which is exactly the size at which a label has to fight a busy roof. Same
  // ratio app.js uses for the building-name tiers, for the same reason.
  //
  // Built by a FUNCTION rather than multiplied at use time: wrapping the zoom
  // curve in ['*', curve, k] is rejected — a zoom expression may not be nested
  // inside another expression — and a rejected paint property takes the whole
  // layer down with it, which is the same trap the TEXT_OPACITY note below
  // records. The multiplier is folded into the output stops instead.
  const HALO_RATIO = 0.17;
  const haloWidth = (mult) => {
    const w = (px) => +(px * HALO_RATIO * mult).toFixed(2);
    return ['interpolate', ['linear'], ['zoom'],
      13, ['match', ['get', 'priority'], 1, w(12), w(10)],
      16, ['match', ['get', 'priority'], 1, w(16), w(12)],
      19, ['match', ['get', 'priority'], 1, w(21), w(15)],
    ];
  };

  // Heroes carry from far out; everything else waits until you're in the
  // neighbourhood. This one expression is most of the declutter.
  //
  // It has to be a SINGLE zoom interpolate with data-driven outputs — nesting
  // one zoom curve per priority inside a `case` is rejected outright ("Only one
  // zoom-based step or interpolate subexpression may be used"), and a rejected
  // paint property takes the whole layer down with it.
  const hero = (a, b) => ['case', ['==', ['get', 'priority'], 1], a, b];
  const TEXT_OPACITY = [
    'interpolate', ['linear'], ['zoom'],
    13.5, hero(0, 0),
    14.6, hero(1, 0),
    // Priority-2 names used to start fading in at 15.9 and reach full at 16.7,
    // which put them at 62% at the z16.4 aerial — half a dozen half-strength
    // 12 px words ("The Co-op", "Pointe on Rio", "Raising Cane's") scattered
    // over the campus frame, and they read as exactly the grey mush the
    // building-name tiers were just cleaned up to stop being. They hold at zero
    // until you are properly in the neighbourhood now.
    16.4, hero(1, 0),
    16.9, hero(1, 1),
  ];

  window.initSigns = function initSigns(map, data) {
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: data || 'data/signs.json' });
    }

    // Ground light pool — a soft brand-coloured disc flat on the ground under
    // each landmark. MapLibre has no fill-extrusion flood light, so this is the
    // low-poly stand-in. Kept deliberately tight: the previous radii (60 px at
    // z16, 380 px at z19) merged 48 pools into one mustard wash across the
    // whole ground plane at night.
    if (!map.getLayer(POOL)) {
      const beforeId = map.getLayer('buildings-shadow') ? 'buildings-shadow'
                     : map.getLayer('buildings-3d') ? 'buildings-3d' : undefined;
      map.addLayer({
        id: POOL, type: 'circle', source: SRC, minzoom: 14,
        paint: {
          'circle-pitch-alignment': 'map',
          'circle-color': ['get', 'color'],
          'circle-blur': 1.0,
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'],
            14, ['match', ['get', 'priority'], 1, 5, 3],
            16, ['match', ['get', 'priority'], 1, 20, 12],
            19, ['match', ['get', 'priority'], 1, 150, 90],
          ],
          'circle-opacity': 0, // driven by applySignGlowLayer()
        },
      }, beforeId);
    }

    // NOTE: there is deliberately NO separate glow-underlay symbol layer.
    // A second text layer with allow-overlap renders orphaned colour blocks
    // wherever the label layer's declutterer dropped the label (v5). The neon
    // comes from the label taking its brand colour at night + ground pools.
    if (!map.getLayer(LABEL)) {
      map.addLayer({
        id: LABEL, type: 'symbol', source: SRC, minzoom: 13.5,
        layout: {
          'text-field': ['get', 'label'],
          // Only Noto Sans Regular/Bold/Italic exist on OpenFreeMap's glyph
          // server — a missing fontstack 404s and MapLibre discards the whole
          // tile it was needed for.
          'text-font': ['Noto Sans Bold'],
          'text-size': TEXT_SIZE,
          'text-anchor': 'center',
          'text-max-width': 8,
          'text-padding': 16,
          'text-allow-overlap': false,
          // Lower sort-key places first → priority-1 heroes beat priority-2.
          'symbol-sort-key': ['get', 'priority'],
        },
        paint: {
          'text-color': '#fffaf0',
          'text-halo-color': 'rgba(10,7,2,0.97)',
          'text-halo-width': haloWidth(1),
          'text-halo-blur': 0.35,
          'text-opacity': TEXT_OPACITY,
        },
      });
    }

    // COLLISION PRIORITY IS LAYER ORDER, and this layer was added last.
    //
    // initSigns runs at step 'signs', after step 'labels', with no beforeId, so
    // the curated hero names ended up at the very END of the style — the LOWEST
    // priority in the entire map. The top of the hierarchy was losing its box to
    // OSM building names and to shop fascias, which is the opposite of what a
    // hero sign is for. app.js owns the ordering; it is re-run here because this
    // layer did not exist when it ran the first time.
    if (typeof window.orderLabelLayers === 'function') window.orderLabelLayers();
  };

  // signGlow: 0 = day (no glow), 1 = night (full neon). Called from timeofday.
  window.applySignGlowLayer = function applySignGlowLayer(map, signGlow, p) {
    const g = Math.max(0, Math.min(1, signGlow));
    if (map.getLayer && map.getLayer(LABEL)) {
      try {
        // Cream by day → the building's own brand colour once it's dark.
        map.setPaintProperty(LABEL, 'text-color', [
          'interpolate', ['linear'], (p == null ? g : p),
          0,    '#fffaf0',
          0.55, '#fffaf0',
          1,    ['to-color', ['get', 'color'], '#ffffff'],
        ]);
        map.setPaintProperty(LABEL, 'text-halo-color', `rgba(6,5,14,${0.92 + g * 0.06})`);
        // The night halo grows, it does not get REPLACED by a flat number. The
        // old `1.5 + g*1.1` threw the size-proportional width away the moment
        // the clock moved off noon, so a 10 px priority-2 name and a 21 px hero
        // got the same 2.6 px halo after dark.
        map.setPaintProperty(LABEL, 'text-halo-width', haloWidth(1 + g * 0.45));
        map.setPaintProperty(LABEL, 'text-halo-blur', 0.35 + g * 1.3);
      } catch (e) {}
    }
    if (map.getLayer && map.getLayer(POOL)) {
      try { map.setPaintProperty(POOL, 'circle-opacity', g * 0.2); } catch (e) {}
    }
  };
})();
