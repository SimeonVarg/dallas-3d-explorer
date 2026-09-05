/**
 * props.js — the small things that give a place scale and identity.
 *
 * Everything here comes from data/props.geojson (see scripts/bake_props.py).
 * Six kinds of feature, keyed by `k`:
 *
 *   art   UT's Landmarks collection — Clock Knot, Monochrome for Austin,
 *         Circle with Towers, The Torchbearers, Ellsworth Kelly's Austin…
 *         POSITION and NAME are factual, from OSM. The FORM IS NOT THE
 *         ARTWORK: we do not model di Suvero's steel or Rubins' aluminium
 *         boats. Each piece is a plinth-and-mass stand-in sized by its
 *         artwork_type; the NAME carries the identity, which is why the label
 *         matters more than the geometry here.
 *   furn  the low stuff — benches, bins, bike racks, bollards, planters,
 *         shelters, scooters, hydrants, post boxes. A bench is what tells you
 *         how big the building behind it is.
 *   lamp  the tall thin stuff — lamp posts, bus-stop poles, flagpoles, masts,
 *         blue-light emergency phones. Its own layer because a lamp RUN is
 *         what draws a street, and that reads from much further out than a bin
 *         does; this layer comes in a full zoom level earlier than `furn`.
 *   lit   Point features at the head of every lamp and every emergency phone.
 *         Drawn as the pool of light the thing actually throws, so what we add
 *         participates in night instead of going flat black beside the
 *         streetlights js/night.js samples off the road network.
 *   line  fences, walls, hedges, flowerbeds and garden beds, extruded low from
 *         their REAL OSM geometry — not a stand-in box at the centroid.
 *   cons  current construction sites (Mulva Hall, Villas on 24th…).
 *
 * WHAT IS FACT AND WHAT IS NOT. Every feature carries `src`:
 *   osm   POSITION from OpenStreetMap.
 *   city  POSITION from a City of Austin survey — the ATD bike-rack inventory,
 *         the MetroBike kiosks, the public art collection. Where one of these
 *         exists it also sets the drawn SIZE (a 13-rack corral really is 6.5 m,
 *         a 15-dock station really is 11 m), and it beats the procedural rule.
 *   proc  POSITION placed by the rule named in `rule` — always riding real
 *         geometry (OSM path centrelines from data/ground.geojson, baked
 *         building footprints, OSM plaza polygons).
 * FORM is generative throughout. docs/GROUND_LIFE.md has the full ledger.
 *
 * COLOUR is per-kind and that is the point: a bench, a bollard and a bike rack
 * must not be the same box in the same grey. Each feature carries a colour
 * class `c` (wood / steel / dark / stone / green / glass / sign / blue) and the
 * layer resolves it through one `match`, blended day→golden→night like every
 * other palette in the scene.
 *
 * DENSITY. Every furn/lamp/lit feature carries `d`, a QUANTILE in 0..1, and the
 * layers filter `d <= density`. So 0.6 draws 60% of them whatever the file
 * holds, and the thinning drops bins and scooters before it drops a lamp run.
 * The knob rides GFX.propDensity when the graphics menu defines one and is
 * otherwise derived from GFX.treeDensity, so the existing quality presets and
 * the ~30 fps auto-detect already move it. See wireDensity() at the bottom.
 *
 * Public (window) API:
 *   initProps(map)             — add source + layers
 *   applyPropColors(map, p)    — retint (and re-light) for time-of-day p
 *   applyPropDensity(map)      — re-read the density knob
 *   PROPS                      — the taste block
 */
(function () {
  'use strict';

  const PROPS = {
    on: true,
    artMinZoom: 15.5,       // sculptures are 1–3 m wide; below this they are noise
    artLabelZoom: 16.6,     // the name is the payoff — but only when you're close
    lampMinZoom: 15.8,      // a lamp run draws a street from further out than a bin
    furnMinZoom: 16.6,      // benches and bins earn their place lower still
    lineMinZoom: 15.4,      // hedges and fences are mass, not detail
    litMinZoom: 14.6,       // the glow is the cheapest thing here and the furthest-read
    consMinZoom: 15.0,
    labelSize: [16.6, 10, 18.5, 13],   // zoom, px, zoom, px

    // Lamp light. Deliberately TIGHTER and dimmer than night.js's road pools —
    // these are walkway lamps standing among them, not a second copy of the
    // street lighting. Radii are px at the listed zooms.
    litRadius: [14.5, 1.6, 16, 5, 17.5, 13, 19.5, 34],
    // ── AND THE NEAR FIELD, WHICH THE PX CURVE ABOVE CANNOT REACH ─────
    //
    // A MapLibre interpolate CLAMPS past its last stop, so above z19.5 that
    // 34 px stopped being a size and became a fixed pixel count — and a fixed
    // pixel count is a ground radius that halves with every zoom level:
    //
    //     z19.5   34 px x 0.1823 m/px  =  6.2 m
    //     z21.5   34 px x 0.0456 m/px  =  1.55 m   <- standing on the pavement
    //
    // z21.5 is `ZOOM_MAX`, i.e. exactly where the camera sits at walking
    // height, so the glow under every lamp post you can actually SEE had shrunk
    // to a 1.5 m dot. Same fault, same shape, as `POOL_GROUND_M` in js/night.js
    // (QUEUE Y2) — these two arrays are the whole of "the night street is
    // unlit".
    //
    // Authored in GROUND METRES here rather than px, because px is what hid the
    // fault: [zoom, ground radius m]. Converted at load. Nothing at or below
    // z19.5 is touched. Values stay under night.js's road pools on purpose —
    // a walk lamp is a 4 m mast, not a 9 m one.
    litGroundNear: [20.5, 7, 21.5, 8, 22.5, 9, 23.5, 9],
    // The lamp HEAD is capped in ground metres so it cannot ride that growth
    // and become a sun at arm's length. 1.49 m is exactly what it already is at
    // z19.5 (34 px x 0.24 x 0.1823), so this is a no-op below the near field.
    // ...and it only applies from `litCoreCapFromZ` up. A flat cap would shrink
    // the head at EVERY zoom (its ground radius is 2.2-2.5 m across the flying
    // stops), which quietly dims the aerial city — the same trap the night.js
    // cap fell into and was measured falling into.
    litCoreGroundCapM: 1.49,
    litCoreCapFromZ: 19.5,
    litOpacity: 0.42,
    litCoreOpacity: 0.85,
    litBlur: 0.9,
    nightStart: 0.58, nightFull: 0.85,   // same handover as night.js

    // propDensity = base + span·treeDensity when the graphics menu has no knob
    // of its own. At the cinematic preset (trees 1.0) this is 1.0; at the
    // performance preset (0.52) it is 0.69 — furniture thins later than trees
    // because there is less of it and it is what gives the ground its scale.
    densityFromTrees: [0.35, 0.65],
  };
  window.PROPS = PROPS;

  const SRC = 'city-props';
  const ART_SRC = 'city-art';
  const ART = 'props-art', FURN = 'props-furn', CONS = 'props-cons';
  const ARTPART = 'props-artpart';
  const LAMP = 'props-lamp', LINE = 'props-line';
  const LIT = 'props-lit', LIT_CORE = 'props-lit-core';
  const ART_LBL = 'props-art-label';

  // Ground metres per screen pixel at this scene's latitude. Only valid because
  // `circle-pitch-scale` is left at its default 'map', which makes a lit pool a
  // real disc lying on the ground — same constant, same reason, as js/night.js.
  const SCENE_LAT = 32.782;
  const mPerPx = z => 156543.03392 * Math.cos(SCENE_LAT * Math.PI / 180) / Math.pow(2, z);

  /**
   * The lit-pool radius curve: PROPS.litRadius (px, the flying half) followed
   * by PROPS.litGroundNear (ground metres, the walking half), converted here.
   *
   * The px→metres conversion and the head's ground cap are both resolved in JS
   * rather than in the expression, because a ['min'] wrapped around a zoom
   * interpolate is rejected by the style validator — and a rejected paint
   * property takes the WHOLE LAYER down without saying so.
   */
  /**
   * The lit pools land UNDER the pavement unless they are moved.
   *
   * `initProps` puts them in front of `buildings-shadow`, which in the built
   * style is index 124 — after `ground-road` (116) but before `ground-paths`
   * (144) and the rest of the ground extrusion stack. So a lamp's glow reached
   * the carriageway and was then painted out by the pavement slab it is
   * supposed to be lighting. Invisible from 18 m looking down at roofs,
   * half the frame at walking height. Same fault, same fix, as js/night.js.
   *
   * The anchor is the first PROPS layer, so the glow is under the bins and
   * benches standing in it and over every ground surface.
   */
  const STACK_AFTER_GROUND = ['props-cons', 'props-line', 'props-furn', 'props-lamp', 'props-art'];
  let _litStacked = false;
  function restackLit(map) {
    if (_litStacked) return true;
    const anchor = STACK_AFTER_GROUND.find(id => map.getLayer(id));
    if (!anchor) return false;
    try {
      for (const id of [LIT, LIT_CORE]) if (map.getLayer(id)) map.moveLayer(id, anchor);
      _litStacked = true;
    } catch (err) { console.warn('[props] lit restack failed:', err); return false; }
    return true;
  }

  function litRadiusExpr(k, capM) {
    const stops = [];
    const push = (z, px) => {
      const cap = (capM && z >= (PROPS.litCoreCapFromZ || 19.5)) ? capM : Infinity;
      stops.push(z, +Math.max(0.1, Math.min(px * k, cap / mPerPx(z))).toFixed(2));
    };
    for (let i = 0; i < PROPS.litRadius.length; i += 2) push(PROPS.litRadius[i], PROPS.litRadius[i + 1]);
    const near = PROPS.litGroundNear || [];
    for (let i = 0; i < near.length; i += 2) push(near[i], near[i + 1] / mPerPx(near[i]));
    return ['interpolate', ['exponential', 1.7], ['zoom'], ...stops];
  }

  // ── Palette. Day / golden / night, blended the same way as every other. ──
  // Muted on purpose: the protected palette is terracotta roofs over tan/olive
  // walls, and the buildings have to keep winning the frame. Nothing here is
  // more saturated than a roof.
  const COL = {
    art:   ['#8d8f96', '#8a7a6a', '#20222c'],   // weathered metal & stone
    cons:  ['#c8a44a', '#c19040', '#2a2418'],   // site hoarding yellow
    // colour classes carried on `c`
    wood:  ['#7a6046', '#7c583a', '#191b22'],
    steel: ['#8d9198', '#8a7a68', '#1b1e26'],
    dark:  ['#4e5058', '#4c4238', '#15171d'],
    stone: ['#c0b49c', '#c3a781', '#1e202a'],
    green: ['#6f8a52', '#71804a', '#101a13'],
    glass: ['#a6b8c0', '#b09a86', '#1d222c'],
    sign:  ['#b0562f', '#b05226', '#241820'],
    // UT's blue-light phones stay blue after dark — that is the whole point of
    // them, and it is the one accent on a night path that is not sodium.
    blue:  ['#3f6ea6', '#4a6c95', '#2b4a75'],
  };
  const CLASSES = ['wood', 'steel', 'dark', 'stone', 'green', 'glass', 'sign', 'blue'];

  /**
   * MATERIALS FOR THE AUTHORED ARTWORKS, keyed on `m` in data/art.geojson.
   *
   * Simeon: "an earlier pass was supposed to add monochrome for austin but it
   * added a gray box same for the clock knot ... diana the huntress is a gray
   * box ... austin building by ellsworth has chromatic circle of glass can you
   * add that with the colors."
   *
   * All 34 pieces were one extrusion of the footprint in one flat colour, so a
   * 7 m burst of welded aluminium canoes and a 4.2 m bronze armadillo were the
   * same block. scripts/bake_art.py now emits real parts; this is what colours
   * them. Kept in sync with MAT there — the bake is the authority on which names
   * exist, and a material missing here falls back to the old art grey rather
   * than painting the layer transparent.
   *
   * The six `g*` glass tones are the only saturated colours in this file, and
   * they exist for exactly one building: Ellsworth Kelly's "Austin". Everything
   * else stays under the roofs in saturation, which is the rule the rest of this
   * palette already follows.
   */
  const ARTMAT = {
    bronze:   ['#6d4a2c', '#7d5530', '#1b1518'],
    bronzed:  ['#4a3722', '#57401f', '#161217'],
    alum:     ['#b9bec6', '#c6b9a6', '#232630'],
    mirror:   ['#cdd8e0', '#dcc9b0', '#2a3038'],
    steelred: ['#a8351d', '#bb4423', '#241318'],
    corten:   ['#7a4326', '#8a4c26', '#1e1416'],
    limest:   ['#ded7c6', '#e6d2ad', '#242530'],
    white:    ['#eeeae1', '#f2e2c4', '#272833'],
    granite:  ['#8e8b86', '#95877a', '#1e1f28'],
    steel:    ['#8d9198', '#8a7a68', '#1b1e26'],
    wood:     ['#7a6046', '#7c583a', '#191b22'],
    gred:     ['#c8342c', '#d4452f', '#3a1418'],
    gorange:  ['#dd7a1e', '#e88c22', '#3c2210'],
    gyellow:  ['#e8c72a', '#f0d33a', '#3a3212'],
    ggreen:   ['#2f9a58', '#3aa862', '#12301f'],
    gblue:    ['#2b6fb5', '#3579bd', '#122238'],
    gviolet:  ['#7b4ba8', '#8657b2', '#1f1430'],
  };
  /** Names the bake has authored geometry for; the grey-box layer skips these. */
  let _authored = [];

  const hex2rgb = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const rgb2hex = (r,g,b) => '#' + [r,g,b].map(v =>
    Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
  function pick(triple, p) {
    const a = p <= 0.5 ? triple[0] : triple[1];
    const b = p <= 0.5 ? triple[1] : triple[2];
    const t = p <= 0.5 ? p / 0.5 : (p - 0.5) / 0.5;
    const A = hex2rgb(a), B = hex2rgb(b);
    return rgb2hex(A[0]+(B[0]-A[0])*t, A[1]+(B[1]-A[1])*t, A[2]+(B[2]-A[2])*t);
  }
  /** ['match', ['get','c'], 'wood', '#..', …, fallback] */
  function classMatch(p) {
    const e = ['match', ['get', 'c']];
    for (const k of CLASSES) e.push(k, pick(COL[k], p));
    e.push(pick(COL.steel, p));
    return e;
  }
  /** ['match', ['get','m'], 'bronze', '#..', …, fallback] */
  function matMatch(p) {
    const e = ['match', ['get', 'm']];
    for (const k of Object.keys(ARTMAT)) e.push(k, pick(ARTMAT[k], p));
    e.push(pick(COL.art, p));
    return e;
  }
  const clamp01 = v => Math.max(0, Math.min(1, v));

  // ── density ──────────────────────────────────────────────────────────
  function density() {
    const g = window.GFX;
    if (g && typeof g.propDensity === 'number') return clamp01(g.propDensity);
    const t = (g && typeof g.treeDensity === 'number') ? g.treeDensity : 1;
    return clamp01(PROPS.densityFromTrees[0] + PROPS.densityFromTrees[1] * t);
  }
  /** filter for one `k`, gated by the density quantile */
  function kFilter(k) {
    const d = density();
    // `coalesce` rather than a bare `['get','d']`: `all` short-circuits today,
    // so an art/line/cons feature never reaches the comparison — but a filter
    // that type-errors takes the whole layer down silently, and that is not a
    // failure worth leaving one refactor away.
    return d >= 1
      ? ['==', ['get', 'k'], k]
      : ['all', ['==', ['get', 'k'], k], ['<=', ['coalesce', ['get', 'd'], 0], d]];
  }

  window.applyPropDensity = function applyPropDensity(map) {
    if (!map || !map.getLayer) return;
    for (const [id, k] of [[FURN, 'furn'], [LAMP, 'lamp'], [LIT, 'lit'], [LIT_CORE, 'lit']]) {
      try { if (map.getLayer(id)) map.setFilter(id, kFilter(k)); } catch (e) {}
    }
  };

  // js/graphics.js owns the quality presets and the ~30 fps auto-detect, and it
  // calls window.applyTreeDensity on every settings change. Riding that call is
  // how the prop density knob moves with the presets WITHOUT editing graphics.js
  // or app.js, which this workstream does not own. If a `propDensity` entry is
  // ever added to the graphics SCHEMA (the snippet is in docs/GROUND_LIFE.md),
  // density() picks it up automatically and this wrapper keeps working.
  function wireDensity(map) {
    if (window.__propsDensityWired) return;
    window.__propsDensityWired = true;
    const prev = window.applyTreeDensity;
    window.applyTreeDensity = function (m) {
      if (typeof prev === 'function') prev(m);
      try { window.applyPropDensity(m || map); } catch (e) {}
    };
  }

  // ── layers ───────────────────────────────────────────────────────────
  window.initProps = function initProps(map) {
    if (!PROPS.on || map.getSource(SRC)) return;
    // Props stream as tiles when data/tiles/props.pmtiles is present, and fall
    // back to the whole 2.19 MB GeoJSON when it is not. Source and all EIGHT
    // layers are built inside initProps, so this can be a local — the roads
    // pass had them in different functions and a local threw out of scope,
    // taking the entire ground stage with it.
    const propTiles = window.tileSource && window.tileSource('props');
    const propLP = propTiles ? propTiles.layerProps : {};
    map.addSource(SRC, propTiles
      ? propTiles.source
      : { type: 'geojson', data: 'data/props.geojson' });
    const p = window.__todCurrentP != null ? window.__todCurrentP : 0.5;

    // The light pools go UNDER the building extrusions, so a tower occludes the
    // lamps behind it instead of glowing through — same rule night.js follows.
    const underBuildings = ['buildings-shadow', 'buildings-ao', 'buildings-3d']
      .find(id => map.getLayer(id));

    const radiusExpr = (k, cap) => litRadiusExpr(k, cap);

    if (!map.getLayer(LIT)) {
      map.addLayer({
        id: LIT, type: 'circle', source: SRC, ...propLP, minzoom: PROPS.litMinZoom,
        filter: kFilter('lit'),
        paint: {
          'circle-pitch-alignment': 'map',
          'circle-color': ['match', ['get', 'c'], 'blue', '#6fa8ff', '#ffc27a'],
          'circle-blur': PROPS.litBlur,
          'circle-radius': radiusExpr(1),
          'circle-opacity': 0,          // driven by applyPropColors
        },
      }, underBuildings);
    }
    if (!map.getLayer(LIT_CORE)) {
      map.addLayer({
        id: LIT_CORE, type: 'circle', source: SRC, ...propLP, minzoom: PROPS.litMinZoom + 1.2,
        filter: kFilter('lit'),
        paint: {
          'circle-pitch-alignment': 'map',
          'circle-color': ['match', ['get', 'c'], 'blue', '#bcd8ff', '#ffe6bd'],
          'circle-blur': 0.35,
          'circle-radius': radiusExpr(0.24, PROPS.litCoreGroundCapM),
          'circle-opacity': 0,
        },
      }, underBuildings);
    }

    if (!map.getLayer(CONS)) {
      map.addLayer({
        id: CONS, type: 'fill-extrusion', source: SRC, ...propLP, minzoom: PROPS.consMinZoom,
        filter: ['==', ['get', 'k'], 'cons'],
        paint: { 'fill-extrusion-color': pick(COL.cons, p),
                 'fill-extrusion-height': ['get', 'h'],
                 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.9 },
      });
    }
    // Fences, walls, hedges and flowerbeds: real geometry, drawn low. No
    // density filter — there are 142 of them and each one is a real edge.
    if (!map.getLayer(LINE)) {
      map.addLayer({
        id: LINE, type: 'fill-extrusion', source: SRC, ...propLP, minzoom: PROPS.lineMinZoom,
        filter: ['==', ['get', 'k'], 'line'],
        paint: { 'fill-extrusion-color': classMatch(p),
                 'fill-extrusion-height': ['get', 'h'],
                 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 1,
                 'fill-extrusion-vertical-gradient': true },
      });
    }
    if (!map.getLayer(FURN)) {
      map.addLayer({
        id: FURN, type: 'fill-extrusion', source: SRC, ...propLP, minzoom: PROPS.furnMinZoom,
        filter: kFilter('furn'),
        paint: { 'fill-extrusion-color': classMatch(p),
                 'fill-extrusion-height': ['get', 'h'],
                 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 1,
                 'fill-extrusion-vertical-gradient': true },
      });
    }
    if (!map.getLayer(LAMP)) {
      map.addLayer({
        id: LAMP, type: 'fill-extrusion', source: SRC, ...propLP, minzoom: PROPS.lampMinZoom,
        filter: kFilter('lamp'),
        paint: { 'fill-extrusion-color': classMatch(p),
                 'fill-extrusion-height': ['get', 'h'],
                 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 1,
                 'fill-extrusion-vertical-gradient': true },
      });
    }
    if (!map.getLayer(ART)) {
      map.addLayer({
        id: ART, type: 'fill-extrusion', source: SRC, ...propLP, minzoom: PROPS.artMinZoom,
        // The grey box is now the FALLBACK, not the treatment. Anything
        // data/art.geojson has authored geometry for is excluded here so the two
        // do not stack; the filter is replaced by loadArt() once that file
        // arrives, and until then this draws all 34 exactly as it always did.
        // A piece the bake fails on therefore degrades to a box rather than
        // vanishing, which is the failure mode worth having.
        filter: ['==', ['get', 'k'], 'art'],
        paint: { 'fill-extrusion-color': pick(COL.art, p),
                 'fill-extrusion-height': ['get', 'h'],
                 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 1,
                 'fill-extrusion-vertical-gradient': true },
      });
    }

    /**
     * THE AUTHORED ARTWORKS. Their own source, because their geometry has no
     * relationship to the prop footprints: one piece becomes anywhere from 6 to
     * 60 parts, each with its own base, height and material.
     *
     * Loaded with fetch rather than handed to MapLibre as a URL because the
     * `authored` list at the top of the file is what tells the grey-box layer
     * which pieces to stand down on, and a GeoJSON source does not hand its
     * body back. It is 94 KB.
     */
    fetch('data/art.geojson').then(r => r.json()).then(gj => {
      _authored = Array.isArray(gj.authored) ? gj.authored : [];
      if (map.getSource(ART_SRC)) return;
      map.addSource(ART_SRC, { type: 'geojson', data: gj });
      map.addLayer({
        id: ARTPART, type: 'fill-extrusion', source: ART_SRC, minzoom: PROPS.artMinZoom,
        paint: {
          'fill-extrusion-color': matMatch(window.__todCurrentP != null ? window.__todCurrentP : p),
          'fill-extrusion-base': ['get', 'b'],
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-opacity': 1,
          // OFF. These are 0.3-1.5 m parts and the gradient darkens the bottom
          // of every extrusion, so a stacked dome would come out as a stack of
          // black rings — the same reason bake_tower.py's bands turn it off.
          'fill-extrusion-vertical-gradient': false,
        },
      }, map.getLayer(ART_LBL) ? ART_LBL : undefined);
      // Now the box layer can stand down for the pieces we drew properly.
      try {
        map.setFilter(ART, ['all', ['==', ['get', 'k'], 'art'],
          ['!', ['in', ['get', 'name'], ['literal', _authored]]]]);
      } catch (e) {}
      console.log('[props] art:', _authored.length, 'pieces authored,',
                  gj.features.length, 'parts');
    }).catch(e => console.warn('[props] art.geojson not loaded:', e.message));
    if (!map.getLayer(ART_LBL)) {
      map.addLayer({
        id: ART_LBL, type: 'symbol', source: SRC, ...propLP, minzoom: PROPS.artLabelZoom,
        filter: ['==', ['get', 'k'], 'art'],
        layout: {
          'text-field': ['get', 'name'],
          // Only Noto Sans Regular/Bold/Italic exist on OpenFreeMap's glyph
          // server; a missing fontstack 404s and drops the whole tile.
          'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'],
            PROPS.labelSize[0], PROPS.labelSize[1], PROPS.labelSize[2], PROPS.labelSize[3]],
          'text-anchor': 'bottom', 'text-offset': [0, -0.5],
          'text-max-width': 9, 'text-padding': 8, 'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#f6ead2', 'text-halo-color': 'rgba(20,12,4,0.92)',
          'text-halo-width': 1.4, 'text-halo-blur': 0.4,
          'text-opacity': ['interpolate', ['linear'], ['zoom'],
            PROPS.artLabelZoom, 0, PROPS.artLabelZoom + 0.5, 0.9],
        },
      });
    }

    wireDensity(map);
    window.applyPropColors(map, p);
  };

  window.applyPropColors = function applyPropColors(map, p) {
    if (!map || !map.getLayer || !map.getLayer(ART)) return;
    // The ground stack may not exist yet when initProps runs; this no-ops once
    // it has succeeded.
    restackLit(map);
    const set = (id, prop, v) => { try { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); } catch (e) {} };
    const cm = classMatch(p);
    set(ART, 'fill-extrusion-color', pick(COL.art, p));
    set(ARTPART, 'fill-extrusion-color', matMatch(p));
    set(CONS, 'fill-extrusion-color', pick(COL.cons, p));
    set(FURN, 'fill-extrusion-color', cm);
    set(LAMP, 'fill-extrusion-color', cm);
    set(LINE, 'fill-extrusion-color', cm);

    // Lamps come on through dusk on the same ramp as night.js's streetlights,
    // so the two tiers arrive together rather than in two visible waves.
    const t = clamp01((p - PROPS.nightStart) / (PROPS.nightFull - PROPS.nightStart));
    set(LIT, 'circle-opacity', PROPS.litOpacity * t);
    set(LIT_CORE, 'circle-opacity', PROPS.litCoreOpacity * t);
  };

  /**
   * Re-derive the lit pools from PROPS after a live edit, so a taste value can
   * be tried — or a before/after shot — without a reload, and therefore in ONE
   * browser rather than two. `window.PROPS` was already public; this is what
   * makes editing it actually do something.
   *
   *   window.PROPS.litGroundNear = []; window.propsRetune(map);   // the old look
   */
  window.propsRetune = function propsRetune(map) {
    if (!map || !map.getLayer) return false;
    const set = (id, prop, v) => { try { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); } catch (e) {} };
    set(LIT, 'circle-radius', litRadiusExpr(1));
    set(LIT, 'circle-blur', PROPS.litBlur);
    set(LIT_CORE, 'circle-radius', litRadiusExpr(0.24, PROPS.litCoreGroundCapM));
    try { window.applyPropColors(map, window.__todCurrentP != null ? window.__todCurrentP : 0.9); } catch (e) {}
    return true;
  };
})();
