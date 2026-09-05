/**
 * heroes-dallas.js — the five towers that are worth building by hand.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ANY OF THIS. Every other building in this scene is its OSM/Overture
 * footprint extruded to its LiDAR height, and for 2,215 of the 2,220 that is
 * exactly right — a downtown block is a box and drawing it as a box is not an
 * approximation, it is the building.
 *
 * It is wrong for five. Reunion Tower is a ball on a stick and its footprint is
 * the lobby, so extruded it is a 34 m cube 172 m tall — the single most
 * recognisable structure in Texas rendered as a filing cabinet. Fountain Place
 * is a cut prism whose footprint is its square base. Comerica has a barrel
 * vault. Renaissance has 40 m of mast above its roof. Bank of America Plaza
 * steps twice near the crown and wears two miles of green argon.
 *
 * The heights are NOT the problem and are not touched here. Overture's
 * LiDAR-derived heights for all five are within a metre of the published
 * figures — Bank of America Plaza comes back at 280.7 m against a real 280.7.
 * What is missing is SHAPE, and shape is what this file adds.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE METHOD, which is Austin's bake_heroes.py method moved into the browser.
 *
 * Each tower gets a FRAME: an origin at its own footprint centroid, and a
 * bearing taken from its own longest footprint edge. Every dimension below is a
 * metre coordinate in that frame. Nothing is a fraction of a bounding box and
 * nothing is eyeballed in screen pixels — a fraction-of-bbox massing silently
 * changes shape when the underlying data is re-baked, which is how a hero
 * survives one Overture release and is wrong after the next.
 *
 * The centroids and bearings below were measured off THIS repo's own
 * data/snapshots/<date>/buildings.detailed.geojson, not off a map. They are
 * printed by the measurement block at the foot of this comment so they can be
 * re-derived:
 *
 *   Renaissance Tower      -96.80198, 32.78126   69 x 69 m   edge 166 deg
 *   Bank of America Plaza  -96.80389, 32.78002   56 x 64 m   edge 167 deg
 *   Reunion Tower          -96.80894, 32.77537   34 x 34 m   edge 101 deg
 *   Fountain Place         -96.80258, 32.78475   87 x 86 m   edge 135 deg
 *   Comerica Bank Tower    -96.79658, 32.78158  100 x 82 m   edge  76 deg
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A fill-extrusion CAN AND CANNOT DO, because it decides the whole shape
 * of this file.
 *
 * It can draw a vertical prism between two heights. That is all. So every form
 * here is a STACK OF RINGS — a series of prisms whose plans change as they
 * rise. A sphere is rings of varying radius; a barrel vault is rings that
 * narrow on one axis only; a Pei prism is rings that shrink on one axis and not
 * the other. With enough rings the stepping is below the resolution the camera
 * ever sees it at.
 *
 * It CANNOT draw anything on a vertical face, and that is a real limit with a
 * real casualty: Renaissance Tower's white X-braces are the second thing anyone
 * names about that building and they are NOT MODELLED. A diagonal band on a
 * vertical wall is not a prism and no arrangement of prisms is honestly one.
 * The masts are here because they are the silhouette; the braces are absent and
 * this comment is where that is admitted rather than quietly skipped.
 *
 * Chase Tower's hole is missing for the same reason — a void through a crown
 * needs a hole in a polygon ring, which fill-extrusion does support, but the
 * crown around it also curves, and it did not make this pass. It is listed in
 * scripts/hero_overrides.json as a known omission.
 */
(function () {
  'use strict';

  const SRC = 'city-heroes';
  const L_MASS = 'hero-mass';
  const L_TRIM = 'hero-trim';
  const L_EDGE = 'hero-edge';

  const LAT0 = 32.7820;
  const MPD_LAT = 111132.0;
  const MPD_LON = 111320.0 * Math.cos(LAT0 * Math.PI / 180);

  // ── ring helpers ────────────────────────────────────────────────────
  /** A regular n-gon of radius r, in metres, in the tower's own frame. */
  function ngon(n, r, rot) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (rot || 0) + (i + 0.5) * 2 * Math.PI / n;
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return pts;
  }
  /** An axis-aligned rectangle a x b, in metres, in the tower's own frame. */
  function rect(a, b) {
    const x = a / 2, y = b / 2;
    return [[-x, -y], [x, -y], [x, y], [-x, y]];
  }
  /** A rectangle with its four corners cut back by `c` metres. */
  function chamfer(a, b, c) {
    const x = a / 2, y = b / 2;
    return [[-x + c, -y], [x - c, -y], [x, -y + c], [x, y - c],
            [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c]];
  }

  /**
   * Metre offsets -> a GeoJSON ring, rotated into the tower's frame.
   *
   * `bearing` is the compass bearing of the tower's longest footprint edge, so
   * the massing lines up with the building the data actually has rather than
   * with north. Getting this wrong is not subtle: Comerica's 60 x 46 m shaft
   * rotated to north instead of 76 degrees hangs 12 m off its own podium on two
   * sides and floats over the street.
   */
  function ringToGeo(pts, originLon, originLat, bearingDeg) {
    const t = (90 - (bearingDeg || 0)) * Math.PI / 180;
    const cos = Math.cos(t), sin = Math.sin(t);
    const out = pts.map(([x, y]) => {
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      return [+(originLon + rx / MPD_LON).toFixed(7),
              +(originLat + ry / MPD_LAT).toFixed(7)];
    });
    out.push(out[0]);
    return out;
  }

  /**
   * A vertical profile -> a stack of prisms.
   *
   * `profile` is [[height, ring], ...] bottom to top. Each consecutive PAIR
   * becomes one prism, and the prism takes the LOWER ring's plan. Taking the
   * upper ring's plan instead makes a taper widen before it narrows, which on
   * Reunion's ball produced a shape that bulged above its own equator.
   */
  function stack(profile, part) {
    const out = [];
    for (let i = 0; i < profile.length - 1; i++) {
      const [z0, ring] = profile[i];
      const z1 = profile[i + 1][0];
      if (z1 <= z0 || !ring || ring.length < 3) continue;
      out.push({ base: z0, top: z1, ring: ring, part: part });
    }
    return out;
  }

  /** Linear blend between two rings with the same vertex count. */
  function blend(a, b, t) {
    return a.map(([x, y], i) => [x + (b[i][0] - x) * t, y + (b[i][1] - y) * t]);
  }

  // ── THE FIVE ────────────────────────────────────────────────────────
  //
  // `part` picks the colour: 'wall' (the building's own body colour from
  // data/hero_designs.json), 'trim' (its lighter accent — copings, vaults,
  // masts) or 'edge' (the emissive outline; only two towers have one).
  const HEROES = [
    {
      name: 'Reunion Tower',
      lon: -96.80894, lat: 32.77537, bearing: 101,
      build() {
        const parts = [];
        // The lobby the footprint actually describes. Everything above it is
        // NOT in the data at any height, which is why this tower is here.
        parts.push(...stack([[0, ngon(16, 17)], [11, ngon(16, 17)]], 'wall'));
        // The shaft: one round concrete core, 10.7 m across. Drawn to 133 m,
        // where the ball's underside begins.
        parts.push(...stack([[11, ngon(16, 5.35)], [133, ngon(16, 5.35)]], 'wall'));
        // THE BALL. A sphere of radius 17.5 m centred at 150.5 m, sampled as
        // 14 rings. Radius at height z is r*sin(acos((z-c)/r)) — the actual
        // sphere equation, not a hand-drawn taper, because a hand-drawn one
        // reads as an egg and the whole point of this tower is that the ball
        // is round.
        const C = 150.5, R = 17.5, N = 14;
        const prof = [];
        for (let i = 0; i <= N; i++) {
          const z = C - R + (2 * R) * (i / N);
          const k = Math.max(0, 1 - Math.pow((z - C) / R, 2));
          prof.push([z, ngon(16, Math.max(1.2, R * Math.sqrt(k)))]);
        }
        parts.push(...stack(prof, 'trim'));
        // THE LAMP RING. 260 lamps run round the ball's widest course and they
        // are what this tower IS after dark — the whole structure exists to be
        // looked at, and half of that is the light show.
        //
        // Drawn as a thin band standing 0.6 m proud of the sphere at its
        // equator rather than by making the ball itself emissive. Making the
        // whole ball an `edge` part was the first version, and it works at
        // night and is badly wrong by day: the ball reads as a glowing orange
        // sphere at noon, when it is in fact a grey lattice. A band is
        // unobtrusive by day and is the only thing visible at night, which is
        // what the real one does.
        parts.push({ base: C - 1.6, top: C + 1.6, part: 'edge',
                     ring: ngon(16, R + 0.25) });
        // The mast above the ball, to the published 171.9 m.
        parts.push(...stack([[168, ngon(8, 1.1)], [171.9, ngon(8, 0.7)]], 'trim'));
        return parts;
      },
    },
    {
      name: 'Bank of America Plaza',
      lon: -96.80389, lat: 32.78002, bearing: 167,
      build() {
        const parts = [];
        parts.push(...stack([[0, rect(56, 64)], [17, rect(56, 64)]], 'wall'));
        // The shaft, corners cut back 7 m — the chamfer is what makes this
        // tower read as an octagon at distance rather than as a slab.
        parts.push(...stack([[17, chamfer(46, 58, 7)], [201, chamfer(46, 58, 7)]], 'wall'));
        // Two setbacks and a crown. Without them this is a 280 m rectangle and
        // it is the tallest rectangle in the frame, so it is the one the eye
        // goes to and the one that has to be right.
        parts.push(...stack([[201, chamfer(40, 50, 6)], [246, chamfer(40, 50, 6)]], 'wall'));
        parts.push(...stack([[246, chamfer(32, 40, 5)], [273, chamfer(32, 40, 5)]], 'wall'));
        parts.push(...stack([[273, chamfer(22, 28, 4)], [280.7, chamfer(22, 28, 4)]], 'trim'));
        // THE GREEN ARGON. Two miles of tube up every vertical corner, and the
        // only reason anyone can name this building at night. Drawn as four
        // slender pilasters at the chamfer faces rather than as a line, because
        // a line has no thickness at 280 m and vanishes.
        //
        // SIZE IT LIKE A TUBE, NOT LIKE A COLUMN. The first version drew these
        // 1.8 m square, which is the thickness of a structural pier — at that
        // size they stop reading as light on the corner of a building and start
        // reading as eight green columns bolted to it, present in every frame
        // at every hour. Reported as "so solid and big and on all the time".
        //
        // The real tube is about 5 cm of glass. 5 cm cannot be rendered at
        // 280 m — it is a fraction of a pixel and vanishes — so 0.45 m is the
        // smallest that survives the tile simplification, and the REST of the
        // fix is opacity, handled in applyShade().
        const R = chamfer(46.6, 58.6, 7);
        for (const [x, y] of R) {
          parts.push({ base: 17, top: 273, part: 'edge',
                       ring: [[x - 0.22, y - 0.22], [x + 0.22, y - 0.22],
                              [x + 0.22, y + 0.22], [x - 0.22, y + 0.22]] });
        }
        return parts;
      },
    },
    {
      name: 'Renaissance Tower',
      lon: -96.80198, lat: 32.78126, bearing: 166,
      build() {
        const parts = [];
        parts.push(...stack([[0, rect(69, 69)], [19, rect(69, 69)]], 'wall'));
        // The shaft stops at the ROOF, 230 m. hero_overrides.json pins the
        // building's data height at 270 because that is the mast tip; if this
        // prism were also drawn to 270 the masts would stand on 40 m of solid
        // tower that is not there.
        parts.push(...stack([[19, rect(57, 57)], [222, rect(57, 57)]], 'wall'));
        parts.push(...stack([[222, rect(59, 59)], [230, rect(59, 59)]], 'trim'));
        // FOUR MASTS to 270 m, at the corners of a 34 m square. These are the
        // silhouette — the reason this tower is identifiable from thirty miles
        // out at night. The X-braces that are the OTHER reason are not modelled;
        // see the file header for why.
        for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const cx = sx * 17, cy = sy * 17;
          parts.push(...stack([[230, ngon(6, 1.5).map(([x, y]) => [x + cx, y + cy])],
                               [262, ngon(6, 1.5).map(([x, y]) => [x + cx, y + cy])]], 'trim'));
          parts.push(...stack([[262, ngon(6, 0.8).map(([x, y]) => [x + cx, y + cy])],
                               [270, ngon(6, 0.8).map(([x, y]) => [x + cx, y + cy])]], 'edge'));
        }
        return parts;
      },
    },
    {
      name: 'Fountain Place',
      lon: -96.80258, lat: 32.78475, bearing: 135,
      build() {
        const parts = [];
        // I. M. Pei / Henry Cobb's cut prism. The plan starts as a 62 m square
        // on the diagonal and SHRINKS ON ONE AXIS ONLY as it rises, so the
        // square becomes a blade. That single asymmetry is the whole building:
        // shrink both axes and you get an obelisk, which is what every generic
        // tapering tower in this scene already is.
        const N = 16;
        const bottom = rect(62, 62);
        const top = rect(6, 46);
        parts.push(...stack([[0, rect(74, 74)], [14, rect(74, 74)]], 'wall'));
        const prof = [];
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          prof.push([14 + (219.5 - 14) * t, blend(bottom, top, t)]);
        }
        parts.push(...stack(prof, 'wall'));
        return parts;
      },
    },
    {
      name: 'Comerica Bank Tower',
      lon: -96.79658, lat: 32.78158, bearing: 76,
      build() {
        const parts = [];
        parts.push(...stack([[0, rect(100, 82)], [21, rect(100, 82)]], 'wall'));
        parts.push(...stack([[21, chamfer(60, 46, 8)], [199, chamfer(60, 46, 8)]], 'wall'));
        parts.push(...stack([[199, chamfer(52, 40, 6)], [227, chamfer(52, 40, 6)]], 'wall'));
        // THE BARREL VAULT. Rings that narrow on ONE axis while the other
        // holds — a half-cylinder lying along the tower's long axis. Same
        // sphere arithmetic as Reunion's ball, applied to a single dimension.
        const N = 9, W = 52, D = 40, Z0 = 227, H = 13;
        const prof = [];
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const k = Math.sqrt(Math.max(0, 1 - t * t));
          prof.push([Z0 + H * t, rect(W, Math.max(3, D * k))]);
        }
        parts.push(...stack(prof, 'trim'));
        return parts;
      },
    },
  ];

  const NAMES = HEROES.map(h => h.name);

  // ── colour ──────────────────────────────────────────────────────────
  // Read from data/hero_designs.json at runtime rather than duplicated here, so
  // there is ONE definition of what colour each tower is and it is the one the
  // rest of the scene already bakes from.
  let DESIGNS = null;
  const FALLBACK = { wall: '#8d9aa3', trim: '#b6c0c7', edge: '#cfd8de' };

  function colourFor(name, part) {
    const d = DESIGNS && DESIGNS.buildings && DESIGNS.buildings[name];
    if (!d) return FALLBACK[part] || FALLBACK.wall;
    if (part === 'edge') return d.edge_light || d.trim || FALLBACK.edge;
    return d[part] || d.wall || FALLBACK.wall;
  }

  function hex2rgb(h) {
    return [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));
  }
  function rgb2hex(a) {
    return '#' + a.map(v => Math.max(0, Math.min(255, Math.round(v)))
      .toString(16).padStart(2, '0')).join('');
  }
  /**
   * Time of day, applied the same way the rest of the scene does it: warm and
   * lift toward golden, cool and crush toward night. Edge lighting is EXEMPT —
   * an argon tube does not get dimmer at noon, it gets less visible against a
   * brighter sky, and the scene has no bloom budget to fake that with. So the
   * edge colour is left alone and only its OPACITY moves.
   */
  function shade(hex, p) {
    const [r, g, b] = hex2rgb(hex);
    if (p <= 0.5) {
      const t = p * 2;                       // day -> golden
      return rgb2hex([r + (18 * t), g + (2 * t), b - (16 * t)]);
    }
    const t = (p - 0.5) * 2;                 // golden -> night
    return rgb2hex([(r + 18) * (1 - 0.62 * t), (g + 2) * (1 - 0.60 * t),
                    (b - 16) * (1 - 0.42 * t) + 26 * t]);
  }

  function currentP() {
    return (window.__todCurrentP != null) ? window.__todCurrentP : 0.3;
  }

  // ── build ───────────────────────────────────────────────────────────
  function toFeatures() {
    const feats = [];
    for (const h of HEROES) {
      for (const part of h.build()) {
        feats.push({
          type: 'Feature',
          properties: {
            name: h.name,
            part: part.part,
            b: +part.base.toFixed(2),
            h: +part.top.toFixed(2),
            col: colourFor(h.name, part.part),
          },
          geometry: {
            type: 'Polygon',
            coordinates: [ringToGeo(part.ring, h.lon, h.lat, h.bearing)],
          },
        });
      }
    }
    return { type: 'FeatureCollection', features: feats };
  }

  /**
   * Hide the five data footprints by AMENDING THE LAYER FILTERS, not by
   * editing the source.
   *
   * Setting `has_parts` on the features and calling setData would also work and
   * is what the Austin repo does for OSM building:parts — but that path costs a
   * full re-tile of a 1.3 MB source at the exact moment the loader is trying to
   * finish, and it is not reversible without a second one. A filter is a style
   * change: no re-tile, and `?heroes=0` puts the boxes straight back.
   */
  function hideOriginals(map) {
    const notHero = ['!', ['in', ['get', 'name'], ['literal', NAMES]]];
    for (const id of ['buildings-3d', 'buildings-roof', 'buildings-ao',
                      'buildings-shadow']) {
      if (!map.getLayer(id)) continue;
      const f = map.getFilter(id);
      map.setFilter(id, f ? ['all', f, notHero] : notHero);
    }
  }

  window.initHeroesDallas = function initHeroesDallas(map, scene) {
    if (map.getSource(SRC)) return;
    if (/[?&]heroes=0\b/.test(location.search)) {
      console.log('[heroes] ?heroes=0 — the five stay as data extrusions');
      return;
    }

    // hero_designs.json is already fetched and parsed by the bake, but the
    // browser has never seen it. One small request, and the layers are added
    // from the callback so a failed fetch still produces the massing in the
    // fallback grey rather than no towers at all.
    fetch('data/hero_designs.json')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
      .then(d => {
        DESIGNS = d;
        add(map);
      });
  };

  function add(map) {
    const data = toFeatures();
    const p = currentP();

    map.addSource(SRC, { type: 'geojson', data: data, tolerance: 0.05, buffer: 128 });
    hideOriginals(map);

    // One layer per part rather than one layer with a match expression: the
    // edge needs its own opacity and its own vertical-gradient setting, and
    // those are layer properties, not data-driven ones.
    const common = {
      type: 'fill-extrusion', source: SRC, minzoom: 13,
    };
    map.addLayer({
      ...common, id: L_MASS, filter: ['==', ['get', 'part'], 'wall'],
      paint: {
        'fill-extrusion-color': ['case', ['has', 'col'],
          ['get', 'col'], FALLBACK.wall],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-opacity': 1,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    map.addLayer({
      ...common, id: L_TRIM, filter: ['==', ['get', 'part'], 'trim'],
      paint: {
        'fill-extrusion-color': ['get', 'col'],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-opacity': 1,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    map.addLayer({
      ...common, id: L_EDGE, filter: ['==', ['get', 'part'], 'edge'],
      paint: {
        'fill-extrusion-color': ['get', 'col'],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-height': ['get', 'h'],
        // Brighter at night, present but quiet by day. See shade()'s note.
        'fill-extrusion-opacity': 0.55,
        'fill-extrusion-vertical-gradient': false,
      },
    });

    applyShade(map, p);
    hookTimeOfDay();

    window.__heroes = {
      on: true,
      names: NAMES,
      parts: data.features.length,
      rebuild: () => map.getSource(SRC).setData(toFeatures()),
    };
    console.log('[heroes] %d hand-massed parts across %d towers: %s',
                data.features.length, NAMES.length, NAMES.join(', '));
  }

  /** Restamp every feature's baked colour for the current time of day. */
  function applyShade(map, p) {
    const src = map.getSource(SRC);
    if (!src) return;
    const d = toFeatures();
    for (const f of d.features) {
      f.properties.col = f.properties.part === 'edge'
        ? f.properties.col                       // argon does not take the sunset
        : shade(f.properties.col, p);
    }
    src.setData(d);
    if (map.getLayer(L_EDGE)) {
      // ARCHITECTURAL LIGHTING IS A NIGHT THING. The first version ran
      // 0.35 -> 0.95 across the day, so the tubes were plainly visible at noon
      // and the user's reaction was that they were "on all the time" — which
      // they were.
      //
      // A cubic ramp instead of a linear one, because the complaint is about
      // the DAY HALF and a linear fade spends half its range there. At p=0.25
      // (mid-morning) linear gives 0.50; this gives 0.02. It does not reach a
      // quarter opacity until p=0.62, which is after sunset, and that is when
      // building lighting actually comes on.
      //
      //   p     0     0.25   0.5    0.75   1.0
      //   old   0.35  0.50   0.65   0.80   0.95
      //   new   0.00  0.02   0.12   0.41   0.96
      map.setPaintProperty(L_EDGE, 'fill-extrusion-opacity',
                           +(0.96 * Math.pow(Math.max(0, Math.min(1, p)), 3)).toFixed(3));
    }
  }

  function hookTimeOfDay() {
    if (typeof window.applyTimeOfDay !== 'function' ||
        window.applyTimeOfDay.__heroes) return;
    const prev = window.applyTimeOfDay;
    const wrapped = function (map, p) {
      const r = prev.apply(this, arguments);
      try { applyShade(map, p); } catch (e) { /* never take the slider down */ }
      return r;
    };
    wrapped.__heroes = true;
    window.applyTimeOfDay = wrapped;
  }
})();
