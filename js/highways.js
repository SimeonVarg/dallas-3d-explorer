/**
 * highways.js — the elevated deck network, drawn as structure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR. Downtown Dallas is wrapped in concrete: the Mixmaster where
 * I-30 and I-35E cross in five levels, the elevated run of I-345 up the east
 * side, and Woodall Rodgers with Klyde Warren Park lidded over it. Drawn flat —
 * which is what every road in this scene was before this file existed — none of
 * that reads. A five-level stack renders as a wide grey smear.
 *
 * The heights come from scripts/bake_highways.py, which derives them from OSM's
 * `layer` ordering rather than measuring them; that file's header says exactly
 * how far that can be trusted and where the number came from. This file is only
 * the drawing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE THINGS ABOUT THE DRAWING THAT ARE NOT OBVIOUS.
 *
 * 1. THE DECK IS A SLAB, NOT A SURFACE. Each piece is extruded from `b` to `h`
 *    — a 1.5 m thick plate — rather than drawn as a flat polygon at height `h`.
 *    A zero-thickness deck is invisible from below and from the side, which is
 *    where the camera spends most of a flyover: you would fly under the
 *    Mixmaster and see nothing above you. The thickness IS the structure.
 *
 * 2. THE PIERS ARE WHY IT READS AS ELEVATED AT ALL. A deck floating with
 *    nothing under it reads as a rendering error, not as a bridge — the eye has
 *    no cue for the height. 366 columns is a small cost for the one thing that
 *    makes the gap beneath legible. They are only generated under decks above
 *    8 m, because below that the gap is too small to see and the columns just
 *    thicken the road.
 *
 * 3. RAMPS ARE MANY FLAT PIECES. A fill-extrusion has one base and one height,
 *    so nothing here can slope. bake_highways.py cuts each ramp into runs that
 *    vary by less than 1.1 m and this draws them as a flight of steps. At any
 *    altitude the camera actually flies at, that reads as a curve. Nose to the
 *    pavement it reads as steps, and that is a known and accepted limit.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COLOUR. Highway concrete is not building concrete: it is greyer, flatter and
 * a little colder than anything in the facade palette, and it weathers toward
 * the same grey everywhere regardless of what it was poured as. So it gets its
 * own three-stop ramp rather than borrowing a class palette, and the ramp is
 * deliberately narrow — concrete does not take much colour off a sunset, and
 * giving it a warm golden stop was the first version and made the Mixmaster
 * look like it was made of sandstone.
 */
(function () {
  'use strict';

  const SRC = 'city-highways';
  const L_DECK = 'highway-deck';
  const L_DECK_TOP = 'highway-deck-top';
  const L_PARAPET = 'highway-parapet';
  const L_PIER = 'highway-pier';

  // Taste block. Every number the look depends on, in one place.
  const HW = {
    minZoom: 13,
    opacity: 1.0,
    // day / golden / night. See the COLOUR note above for why these are close
    // together rather than spread across a sunset ramp.
    deck:   ['#9d9a95', '#a8988a', '#4a4a50'],
    // The wearing course on top of the slab — asphalt, not concrete, so it is
    // darker than the structure it sits on. This is the single cue that says
    // "road" rather than "wall" when the deck is seen from above.
    top:    ['#6f6c69', '#7a6f66', '#35353b'],
    pier:   ['#8e8b87', '#96897d', '#3f3f45'],
    // The parapet is fresh precast concrete against a weathered deck — the same
    // family, one step lighter. It has to be LIGHTER than the deck rather than
    // darker: the barrier catches the sky and the deck is in its own shadow, so
    // a darker parapet reads as a gap in the structure instead of a wall on it.
    parapet: ['#b4b0a9', '#c0ac99', '#54545c'],
  };

  function lerpHex(a, b, t) {
    const A = [1, 3, 5].map(i => parseInt(a.substr(i, 2), 16));
    const B = [1, 3, 5].map(i => parseInt(b.substr(i, 2), 16));
    return '#' + A.map((v, i) =>
      Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }

  /**
   * Three stops, not two. `p` is the app's time-of-day parameter: 0 = day,
   * 0.5 = golden, 1 = night, and the golden stop is a real measured middle
   * rather than the midpoint of day and night — interpolating straight from
   * day to night passes through a dead grey at exactly the moment the rest of
   * the scene is at its warmest.
   */
  function at(ramp, p) {
    p = Math.max(0, Math.min(1, p));
    return p <= 0.5 ? lerpHex(ramp[0], ramp[1], p * 2)
                    : lerpHex(ramp[1], ramp[2], (p - 0.5) * 2);
  }

  function currentP() {
    return (window.__todCurrentP != null) ? window.__todCurrentP : 0.3;
  }

  window.initHighways = function initHighways(map) {
    if (map.getSource(SRC)) return;

    // Under our own buildings but above the ground, same rule js/outer.js uses.
    // RECOMPUTED at call time rather than captured: the graphics preset can
    // remove `buildings-ao`, and addLayer against a missing `before` id THROWS,
    // which would take the whole deck network out.
    const beforeId = ['buildings-ao', 'buildings-3d', 'buildings-labels']
      .find(id => map.getLayer(id));

    map.addSource(SRC, {
      type: 'geojson',
      data: 'data/highways.geojson',
      // Same tiling knobs the rest of the scene uses. buffer:128 matters more
      // here than anywhere else: a deck is a long thin polygon that crosses
      // many tiles, and a small buffer makes it flicker at tile seams as the
      // camera moves along it.
      maxzoom: 16, tolerance: 0.4, buffer: 128,
    });

    const p = currentP();

    // The structure: slab plus piers, both in concrete.
    map.addLayer({
      id: L_PIER, type: 'fill-extrusion', source: SRC, minzoom: HW.minZoom + 1.5,
      filter: ['==', ['get', 'k'], 'pier'],
      paint: {
        'fill-extrusion-color': at(HW.pier, p),
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-opacity': HW.opacity,
        'fill-extrusion-vertical-gradient': true,
      },
    }, beforeId);

    map.addLayer({
      id: L_DECK, type: 'fill-extrusion', source: SRC, minzoom: HW.minZoom,
      filter: ['==', ['get', 'k'], 'deck'],
      paint: {
        'fill-extrusion-color': at(HW.deck, p),
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-opacity': HW.opacity,
        'fill-extrusion-vertical-gradient': true,
      },
    }, beforeId);

    // The wearing course: a 12 cm skin on top of the slab, so from above the
    // deck reads as a road rather than as the top of a wall. Drawn as its own
    // layer rather than as a second colour on the same one because a
    // fill-extrusion has exactly one colour.
    map.addLayer({
      id: L_DECK_TOP, type: 'fill-extrusion', source: SRC, minzoom: HW.minZoom,
      filter: ['==', ['get', 'k'], 'deck'],
      paint: {
        'fill-extrusion-color': at(HW.top, p),
        'fill-extrusion-base': ['get', 'h'],
        'fill-extrusion-height': ['+', ['get', 'h'], 0.12],
        'fill-extrusion-opacity': HW.opacity,
      },
    }, beforeId);

    // THE PARAPET IS THE WHOLE READ. A deck without one is a grey plank: from
    // above it is a stripe, from the side it is a slab, and from below it is a
    // ceiling. The barrier is what the eye actually uses to identify a highway
    // structure, and it costs one more layer over polygons the bake already
    // emitted. Drawn LAST of the structure layers so it wins the depth test
    // against the wearing course it stands on.
    map.addLayer({
      id: L_PARAPET, type: 'fill-extrusion', source: SRC, minzoom: HW.minZoom + 0.5,
      filter: ['==', ['get', 'k'], 'parapet'],
      paint: {
        'fill-extrusion-color': at(HW.parapet, p),
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-opacity': HW.opacity,
        'fill-extrusion-vertical-gradient': true,
      },
    }, beforeId);

    hookTimeOfDay();

    // Debug/status hook, the same shape as window.__fly and window.__sky.
    // COUNT THROUGH querySourceFeatures, NOT source._data.
    //
    // `_data` holds whatever was handed to addSource. This source is given a
    // URL string, so `_data` IS THE STRING 'data/highways.geojson' — and
    // `'data/highways.geojson'.features` is undefined, so the obvious version
    // of this hook reports null for a source that is loaded and drawing 2,213
    // features. It then makes the idle check below print "empty or missing" for
    // a working layer, which is worse than having no check at all.
    //
    // querySourceFeatures only sees features in TILES THAT ARE CURRENTLY
    // LOADED, so this is a count of what is on screen, not of what is in the
    // file. That is the right number for a debug hook — it answers "is this
    // drawing?" — but it is not the file's length and must not be read as one.
    const inView = () => map.querySourceFeatures(SRC);

    window.__highways = {
      on: true,
      countInView: () => inView().length,
      colours: () => ({ deck: at(HW.deck, currentP()), pier: at(HW.pier, currentP()) }),
      tune: HW,
    };

    map.once('idle', () => {
      const f = inView();
      if (!f.length) {
        console.warn('[highways] no features in the loaded tiles — either ' +
                     'data/highways.geojson is missing (run ' +
                     'scripts/bake_highways.py) or the camera is off the network');
        return;
      }
      const decks = f.filter(x => x.properties.k === 'deck');
      const top = decks.reduce((m, x) => Math.max(m, x.properties.h), 0);
      console.log('[highways] in view: %d slabs, %d piers, top deck %.1f m',
                  decks.length, f.length - decks.length, top);
    });
  };

  /**
   * Repaint on every time-of-day change by WRAPPING applyTimeOfDay, the same
   * way js/outer.js does. A `map.on('data')` listener was the first version and
   * it repainted on every tile that arrived, which is thousands of redundant
   * setPaintProperty calls during a flight.
   */
  function hookTimeOfDay() {
    if (typeof window.applyTimeOfDay !== 'function' ||
        window.applyTimeOfDay.__highways) return;
    const prev = window.applyTimeOfDay;
    const wrapped = function (map, p) {
      const r = prev.apply(this, arguments);
      try {
        if (map && map.getLayer(L_DECK)) {
          map.setPaintProperty(L_DECK, 'fill-extrusion-color', at(HW.deck, p));
          map.setPaintProperty(L_DECK_TOP, 'fill-extrusion-color', at(HW.top, p));
          map.setPaintProperty(L_PIER, 'fill-extrusion-color', at(HW.pier, p));
          map.setPaintProperty(L_PARAPET, 'fill-extrusion-color', at(HW.parapet, p));
        }
      } catch (e) { /* a missing layer is not worth taking the slider down for */ }
      return r;
    };
    wrapped.__highways = true;
    window.applyTimeOfDay = wrapped;
  }
})();
