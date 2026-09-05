/**
 * timeofday.js — Time-of-day system for Austin 3D Explorer (v3)
 *
 * Single value p (0 = day, 0.5 = golden hour, 1 = night) drives the scene.
 *
 * Walls are drawn with `fill-extrusion-pattern` (see facades.js), so the wall
 * colour for the hour lives inside the pattern image and is repainted there.
 * Everything the pattern can't carry — sky, fog, light, roof caps, ground,
 * roads, water, trees, shadows, signage — is keyframed here.
 *
 * Roof caps stay on baked per-feature colours (wd/wg/wn, rd/rg/rn from
 * scripts/bake_detail.py) and are blended with one `interpolate` expression
 * whose input is the constant p, so every feature keeps its own identity.
 *
 * Public (window) API:
 *   cleanupBasemap(map)            — strip Liberty clutter, categorise layers
 *   applyTimeOfDay(map, p)         — apply the mood for value p
 *   initTimeOfDayUI(map, defaultP) — wire the slider + play button
 *   TOD_DEFAULT_P                  — 0.12
 */

(function () {
  'use strict';

  // The opening hour. Golden hour is the best hour this app has — violet→rose→
  // orange sky, god rays, amber walls — and it used to open at 0.12, a pale flat
  // morning that hid all of it. 0.50 is peak golden (sun ~6° up in the WSW).
  // One-line taste override; 0.12 is the old late-morning look.
  const TOD_DEFAULT_P = 0.50;

  // ── Scene keyframes (everything not carried by the facade patterns) ──
  //
  // `fog` is the aerial-perspective colour, tinted toward the SKY rather than
  // the ground. It drove the #haze DOM band, which was REMOVED (it painted over
  // geometry — see the branch note in HANDOFF). The track is kept because it is
  // the right colour for anything that wants to fade the far field, and because
  // MapLibre's own `setSky` fog cannot do that job: sweeping fog-ground-blend
  // 0→1 leaves every ground pixel bit-identical, measured.
  const PRESETS = {
    day: {
      // sky/horizon/fog/skyBlend are OWNED BY `ROUTES` below — these values
      // are the p=0 anchors and must stay equal to the route's first key.
      sky: '#5d94cf', horizon: '#c8e0f0', fog: '#c4dcee',
      skyBlend: 0.72, horizonBlend: 0.92, fogGround: 0.08,
      lightColor: '#ffeeda', lightIntensity: 0.28, lightPosition: [1.15, 205, 32],
      // `ground` is the catch-all under everything OSM does not classify. It
      // used to be a pale sand (#ded3bc, luma 208) — brighter than a concrete
      // path, so the real walked paths in ground.geojson were invisible
      // against it (measured: 3.5 luma of separation at golden hour, which is
      // nothing). Dropped to a mid warm grey so pale paving reads light on it
      // and asphalt reads dark, which is what a campus actually looks like.
      ground: '#b0a898', park: '#a9c489', road: '#e2dac7', roadCasing: '#bfb49d',
      water: '#8fbccd',
      canopy: '#7d9a62', canopyLo: '#93ad70', canopyHi: '#5f7d4a', trunk: '#6b4f38',
      pitch: '#94b573', fountain: '#a5cbd8',
      signGlow: 0, labelHalo: 'rgba(24,14,5,0.9)', vignette: 0.10,
      exposure: 1.00, contrast: 1.03, saturation: 1.02,
    },
    golden: {
      sky: '#6a2a4a', horizon: '#ffb45e', fog: '#ffb45e',
      skyBlend: 0.86, horizonBlend: 0.94, fogGround: 0.06,
      lightColor: '#ffd7a8', lightIntensity: 0.30, lightPosition: [1.35, 252, 76],
      ground: '#b3936f', park: '#a9a866', road: '#e8c79a', roadCasing: '#b78c60',
      water: '#c9a184',
      canopy: '#8a935a', canopyLo: '#a3a468', canopyHi: '#6a7343', trunk: '#5f4632',
      pitch: '#a2a768', fountain: '#d4b894',
      signGlow: 0.42, labelHalo: 'rgba(46,18,0,0.88)', vignette: 0.26,
      exposure: 1.02, contrast: 1.07, saturation: 1.14,
    },
    night: {
      sky: '#040713', horizon: '#2c3a63', fog: '#3a4a72',
      skyBlend: 0.60, horizonBlend: 0.9, fogGround: 0.1,
      // Near-zero intensity on purpose. MapLibre's extrusion lighting washes
      // faces toward a warm mid-tone as intensity rises: at 0.3 the baked navy
      // roof #10121d renders #312c1b (measured), which put an olive tarp over
      // the whole night city. At ~0 the baked colours come through, and after
      // dark there's no sun to model anyway — the windows are the light source.
      lightColor: '#8fa0e0', lightIntensity: 0.04, lightPosition: [1.4, 300, 60],
      ground: '#090b12', park: '#0b120e', road: '#2a2519', roadCasing: '#0b0d13',
      water: '#070f1e',
      // "at night the trees are an ugly gray fix that." They were, and it is a
      // LUMA HEADROOM problem rather than a hue one, so the fix is to author
      // them brighter and not more saturated.
      //
      // The old values (#16211a / #0c130f / #100d0c) sit deep below the tone
      // curve's toe, where its slope flattens toward END_SLOPE — which squeezes
      // the inter-channel spread that IS the green-ness from about 4.3% down to
      // 3.3%, and then the night grade's saturate(0.88) takes another 12%. What
      // lands on screen is a 1-4% channel spread on values under 20/255, which
      // is below display quantisation. That is the definition of grey.
      //
      // These clear the toe with the green channel still dominant, so the curve
      // preserves the separation instead of crushing it. `canopy` is unused —
      // js/timeofday.js:393-395 only ever reads canopyLo/canopyHi — and is kept
      // only so the three presets stay the same shape.
      canopy: '#1a2a1e', canopyLo: '#1e3a24', canopyHi: '#162a1a', trunk: '#221a15',
      pitch: '#0d1512', fountain: '#0e1c30',
      signGlow: 1.0, labelHalo: 'rgba(4,4,12,0.92)', vignette: 0.38,
      exposure: 0.95, contrast: 1.08, saturation: 0.88,
    },
  };

  // ── Colour lerp helpers ───────────────────────────────────────────
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }
  function rgbToHex(r, g, b) {
    const c = n => Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0');
    return `#${c(r)}${c(g)}${c(b)}`;
  }
  function lerpNum(a, b, t) { return a + (b - a) * t; }
  function lerpHex(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex(lerpNum(A[0],B[0],t), lerpNum(A[1],B[1],t), lerpNum(A[2],B[2],t));
  }
  function lerpArr(a, b, t) { return a.map((v,i) => lerpNum(v, b[i], t)); }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // ── The sky route ─────────────────────────────────────────────────
  //
  // The sky cannot be a straight lerp between three presets. Interpolating
  // golden→night directly drags the highest-alpha layers through desaturated tan
  // and then dead-neutral grey; interpolating day→golden is worse, because
  // #21529f→#6a2a4a passes through PURPLE — measured, the rendered sky at p=0.30
  // was #4d3a6c, a dark violet, for the whole middle of the afternoon.
  //
  // So both halves are routed. The day half stays blue, pales, and only then
  // swings warm; the evening half goes orange → rose → violet → deep blue and
  // never loses saturation. Keys at p=0.00/0.50/1.00 equal the matching PRESETS
  // field exactly, so nothing can step at a boundary.
  //
  // Two things were also wrong with the DAY sky independent of the route.
  // Measured at the top of the visible band: #284e97 — S 58%, L 37%, against
  // roughly S 40-55% / L 55-70% for a real clear sky. Too dark and slightly too
  // saturated is exactly what reads as "deep blue, like I'm in space", so the
  // day zenith is lighter and a touch greener in hue (211° vs 226°, which was
  // drifting toward indigo). And `sky-horizon-blend` was 0.5, which kept the
  // pale horizon colour so low that at any flying pitch you saw almost pure
  // zenith; 0.72 spreads the pale band up into the part of the sky you can
  // actually see.
  const ROUTES = {
    sky: [
      [0.00, '#5d94cf'], [0.25, '#5a8ec6'], [0.40, '#5f7ba8'], [0.50, '#6a2a4a'],
      [0.60, '#3a1c48'], [0.72, '#10173a'], [1.00, '#040713'],
    ],
    horizon: [
      [0.00, '#c8e0f0'], [0.25, '#d8e3ec'], [0.40, '#f4d2a6'], [0.50, '#ffb45e'],
      [0.60, '#b0526a'], [0.72, '#3a4780'], [1.00, '#2c3a63'],
    ],
    fog: [
      [0.00, '#c4dcee'], [0.25, '#d4e0ea'], [0.40, '#f2cfa2'], [0.50, '#ffb45e'],
      [0.60, '#965460'], [0.72, '#33406e'], [1.00, '#3a4a72'],
    ],
    skyBlend: [[0.00, 0.72], [0.40, 0.80], [0.50, 0.86], [0.72, 0.70], [1.00, 0.60]],
  };
  function duskAt(keys, p) {
    if (p <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (p <= keys[i][0]) {
        const [pa, va] = keys[i - 1], [pb, vb] = keys[i];
        const t = (p - pa) / (pb - pa);
        return typeof va === 'number' ? lerpNum(va, vb, t) : lerpHex(va, vb, t);
      }
    }
    return keys[keys.length - 1][1];
  }

  function presetAt(p) {
    p = clamp01(p);
    let a, b, t;
    if (p <= 0.5) { a = PRESETS.day;    b = PRESETS.golden; t = p / 0.5; }
    else          { a = PRESETS.golden; b = PRESETS.night;  t = (p - 0.5) / 0.5; }
    const out = {};
    for (const k of Object.keys(a)) {
      const av = a[k], bv = b[k];
      if (typeof av === 'number')      out[k] = lerpNum(av, bv, t);
      else if (Array.isArray(av))      out[k] = lerpArr(av, bv, t);
      else if (av[0] === '#')          out[k] = lerpHex(av, bv, t);
      else                             out[k] = t < 0.5 ? av : bv; // rgba strings snap
    }
    // Routed fields win over the linear preset blend across the WHOLE range,
    // not just p > 0.5 as before.
    for (const k of Object.keys(ROUTES)) out[k] = duskAt(ROUTES[k], p);
    return out;
  }

  // Per-feature baked colour, blended for the current hour. The interpolate
  // input is the CONSTANT p — output still varies per feature via ['get'].
  function bakedColor(p, dayProp, goldenProp, nightProp) {
    p = clamp01(p);
    return ['interpolate', ['linear'], p,
      0,   ['to-color', ['get', dayProp],    '#888888'],
      0.5, ['to-color', ['get', goldenProp], '#888888'],
      1,   ['to-color', ['get', nightProp],  '#333344'],
    ];
  }

  // ── Pitched-roof facet shading ────────────────────────────────────
  // `fill-extrusion` tops are always horizontal, so MapLibre shades every tread
  // of a stepped hip roof identically and the roof comes back reading as a flat
  // plane with rings drawn on it. Each facet in `roofs.geojson` therefore
  // carries `az` — the compass direction that slope faces — plus the two ends of
  // its shade range (rd/rg bright, rdd/rgd dark), and the colour is picked
  // between them HERE, from the live sun.
  //
  // It has to happen here rather than in the bake: baking the tint into the
  // day/golden/night keys was tried, and `bakedColor`'s lerp averaged a
  // morning sun at az 98 against a golden one at az 256 into flat grey at
  // p=0.25. Shading baked at fixed hours cannot survive being interpolated.
  //
  // Same sun as the shadows, the disc and setLight (sky.js §1). The three
  // constants below must match ROOF_SHADE in scripts/bake_roofs.py.
  const ROOF_SHADE = { ambient: 0.35, lo: 0.70, hi: 1.28, tilt: 38 };

  function roofFacetColor(p) {
    const sun = (typeof window.skyBodies === 'function')
      ? window.skyBodies(clamp01(p)).sun : { az: 180, elev: 45 };
    const R = Math.PI / 180;
    const A = ROOF_SHADE.ambient;
    const sinT = Math.sin(ROOF_SHADE.tilt * R), cosT = Math.cos(ROOF_SHADE.tilt * R);
    const sinE = Math.sin(sun.elev * R),        cosE = Math.cos(sun.elev * R);
    // A flat cap is what rd/rg/rn were baked for, so a facet is only ever
    // brighter or darker than its own building by what its tilt earns.
    const flat = A + (1 - A) * Math.max(0, sinE);
    // dot(normal, sun) for a slope of `tilt` facing `az`, reduced to a single
    // cosine of the azimuth difference plus a constant.
    const k1 = sinT * cosE, k2 = cosT * sinE;
    const dot = ['+', ['*', k1, ['cos', ['*', R, ['-', ['get', 'az'], sun.az]]]], k2];
    const lit = ['+', A, ['*', 1 - A, ['max', 0, dot]]];
    // 0 at the dark end of the baked range, 1 at the bright end. `interpolate`
    // clamps outside its stops, so no clamp is needed here.
    const t = ['/', ['-', ['/', lit, Math.max(flat, 1e-4)], ROOF_SHADE.lo],
                    ROOF_SHADE.hi - ROOF_SHADE.lo];
    return ['interpolate', ['linear'], t,
      0, bakedColor(p, 'rdd', 'rgd', 'rn'),
      1, bakedColor(p, 'rd',  'rg',  'rn'),
    ];
  }

  // ── Basemap cleanup ───────────────────────────────────────────────
  let _bgLayers=[], _groundFills=[], _parkFills=[], _waterFills=[], _waterLines=[], _roadLines=[];
  let _cleaned = false;

  function isOurLayer(layer) {
    return layer.source === 'city-buildings' ||
           layer.source === 'city-parts'     ||
           layer.source === 'city-trees'     ||
           layer.source === 'city-landscape' ||
           layer.source === 'city-shadows'   ||
           layer.source === 'city-signs'     ||
           layer.id.startsWith('buildings-')   ||
           layer.id.startsWith('parts-')       ||
           layer.id.startsWith('trees-')       ||
           layer.id.startsWith('landscape-')   ||
           layer.id.startsWith('signs-');
  }

  function cleanupBasemap(map) {
    if (_cleaned) return;
    const style = map.getStyle();
    if (!style || !style.layers) return;
    const hidden = [], kept = [];
    for (const layer of style.layers) {
      if (isOurLayer(layer)) continue;
      const id   = layer.id;
      const idl  = id.toLowerCase();
      const src  = (layer['source-layer'] || '').toLowerCase();
      const type = layer.type;

      if (type === 'background') { _bgLayers.push(id); continue; }

      // All basemap symbol layers = labels/icons — hide the lot
      if (type === 'symbol') { hide(map, id); hidden.push(id); continue; }

      // Basemap fill-extrusion buildings — hide (we render our own)
      if (type === 'fill-extrusion') { hide(map, id); hidden.push(id); continue; }

      // Water fills / lines — keep, tinted
      if (src === 'water' || src === 'ocean' || idl === 'water' || idl === 'ocean') {
        (type === 'line' ? _waterLines : _waterFills).push(id); continue;
      }
      if (src === 'waterway') { _waterLines.push(id); continue; } // Waller Creek

      // Parks, grass, woods — the GREEN bucket (was ground-tinted before,
      // which flattened campus lawns into pavement colour)
      if (src === 'park' || src === 'landcover' || /park|grass|wood|forest|garden/.test(idl)) {
        if (type === 'fill') { _parkFills.push(id); } else { hide(map, id); hidden.push(id); }
        continue;
      }

      if (type === 'line') {
        if (isMajorRoad(idl, src)) { _roadLines.push(id); styleRoad(map, id, idl); }
        else                       { hide(map, id); hidden.push(id); }
        continue;
      }

      if (type === 'fill') {
        // Pattern fills (pedestrian plazas, wetland hatching) ignore
        // fill-color tints and glow white at night — hide them.
        const paint = layer.paint || {};
        if (paint['fill-pattern']) { hide(map, id); hidden.push(id); continue; }
        _groundFills.push(id); continue;
      }
    }
    console.log('[cleanupBasemap] hidden', hidden.length, 'layers; parks:', _parkFills.length,
                'ground:', _groundFills.length, 'roads:', _roadLines.length);
    _cleaned = true;
  }

  function isMajorRoad(idl, src) {
    if (src === 'transportation') {
      return /motorway|trunk|primary|secondary|tertiary|street|minor/.test(idl) &&
             !/path|pedestrian|service|track|footway|cycleway|rail|ferry|construction|tunnel/.test(idl);
    }
    return /motorway|trunk|primary|secondary|tertiary|street/.test(idl);
  }
  function hide(map, id) { try { map.setLayoutProperty(id,'visibility','none'); } catch(e){} }

  // Streets are the only structure the ground plane has. Liberty's defaults are
  // hairlines that vanish at flythrough pitch, so widen them into readable
  // ribbons — casings included, which is what makes the grid read as a grid.
  const _casings = new Set();
  function styleRoad(map, id, idl) {
    const casing = /casing|outline/.test(idl);
    if (casing) _casings.add(id);
    try {
      map.setPaintProperty(id, 'line-width', casing
        ? ['interpolate',['exponential',1.5],['zoom'],12,1.2,15,4.5,18,17,20,40]
        : ['interpolate',['exponential',1.5],['zoom'],12,0.8,15,3.2,18,13,20,32]);
      map.setPaintProperty(id, 'line-opacity', casing ? 0.55 : 1);
    } catch (e) {}
  }

  // ── Apply ─────────────────────────────────────────────────────────
  // The auto day/night cycle calls this on EVERY frame — ~1,920 times per 32 s
  // sweep — and the expensive half of it does not need that resolution. Each
  // call repaints the whole facade atlas (a 64x64 getImageData readback per
  // pattern, the slowest common canvas2d op on iOS, then a map.updateImage that
  // dirties the sprite atlas and re-renders every pattern-using tile), rebuilds
  // two interpolate expressions, and sweeps setPaintProperty across every
  // basemap layer. Quantising p to 1/128 (0.25 s of cycle time) cuts that from
  // 1,920 heavy passes per sweep to 128 with no visible stepping, while the
  // cheap half — the sky overlay, which has to track the camera — still runs
  // every frame.
  let _lastPq = null;
  // How finely the EXPENSIVE half of a retint is quantised. The cheap half (the
  // sky) always follows the raw p, so it stays smooth; this only decides how
  // often facades, ground, props, trees, shadows and the stadium recolour.
  //
  // 128 is right for a human dragging the slider. It is wrong for an automatic
  // sweep: crossing 1/128 about 1.6 times a second, with each heavy pass
  // costing hundreds of ms, is most of why sweeping the clock costs ~93% of the
  // frame rate (measured 56.5 -> 4.0 fps with the camera parked). ?sliderdemo=1
  // sets window.__todPQ coarser for the length of its sweep. Nothing else does,
  // and it is cleared afterwards.
  const PQ_DEFAULT = 128;
  const pqNow = () => (typeof window.__todPQ === 'number' && window.__todPQ > 0)
    ? window.__todPQ : PQ_DEFAULT;

  function applyTimeOfDay(map, p, force) {
    if (!map) return;
    const s = presetAt(p);
    window.__todCurrentP = p;

    const PQ = pqNow();
    const pq = Math.round(clamp01(p) * PQ) / PQ;
    const heavy = force === true || _lastPq === null || pq !== _lastPq;
    if (heavy) _lastPq = pq;

    if (!heavy) {
      // Cheap per-frame work only: the sky overlay is camera-dependent and must
      // not be quantised, and the grade is a handful of style writes.
      if (typeof updateSky === 'function') updateSky(map, p);
      applyGradeFor(s);
      return;
    }

    if (typeof map.setSky === 'function') {
      // Only three of the seven properties do anything here: fog-color,
      // horizon-fog-blend and fog-ground-blend are terrain-only (measured —
      // sweeping fog-ground-blend 0→1 left every pixel bit-identical), and
      // atmosphere-blend only matters on the globe projection.
      map.setSky({
        'sky-color': s.sky,
        'horizon-color': s.horizon,
        'sky-horizon-blend': s.skyBlend,
      });
    }

    if (typeof map.setLight === 'function') {
      // Position comes from the shared sun (sky.js), so the shading, the ground
      // shadows and the visible disc can never disagree. MapLibre's light
      // position is [radial, azimuthal-from-north, polar-from-straight-up], so
      // polar = 90 - elevation.
      let pos = s.lightPosition;
      if (typeof window.skyBodies === 'function') {
        const sun = window.skyBodies(p).sun;
        pos = [1.25, ((sun.az % 360) + 360) % 360, clamp01((90 - sun.elev) / 180) * 180];
      }
      map.setLight({ anchor:'map', color:s.lightColor, intensity:s.lightIntensity, position:pos });
    }

    // Walls carry their colour inside the facade pattern; repaint the atlas.
    if (!window.__debugActive && typeof updateFacades === 'function') updateFacades(map, p);
    // Roof caps stay on baked per-feature colours.
    if (!window.__debugActive) {
      safePaint(map, 'buildings-roof','fill-extrusion-color', bakedColor(p,'rd','rg','rn'));
      safePaint(map, 'parts-roof',    'fill-extrusion-color', bakedColor(p,'rd','rg','rn'));
      // Pitched roofs are per-FACET: same baked colours, picked between their
      // shaded ends by the direction each slope faces. See roofFacetColor.
      safePaint(map, 'roofs-pitched', 'fill-extrusion-color', roofFacetColor(p));
      if (typeof window.applyStadiumColors === 'function') window.applyStadiumColors(p);
    }

    if (typeof updateShadows === 'function') updateShadows(map, p);
    if (typeof window.applyGroundColors === 'function') window.applyGroundColors(map, p);
    if (typeof window.applyPropColors === 'function') window.applyPropColors(map, p);
    if (typeof window.applyCapitolColors === 'function') window.applyCapitolColors(map, p);

    // The crown gradient lives in js/app.js (window.TREE_SHADE and
    // treeCanopyColour) because that is the tree lane's file; this is the one
    // line that has to change here, and it is a call rather than an expression
    // so the two paint sites cannot drift apart. The expression it replaces
    // ramped on the tier's own TOP HEIGHT, which clamped 34% of tiers flat and
    // ran the wrong way — the lit top of a canopy came out darker than its
    // shaded underside. Falls back to the old expression if app.js has not
    // loaded, so a partial page still gets green trees.
    safePaint(map, 'trees-canopy', 'fill-extrusion-color',
      typeof window.treeCanopyColour === 'function'
        ? window.treeCanopyColour(s)
        : ['interpolate', ['linear'], ['get', 'h'], 6, s.canopyLo, 15, s.canopyHi]);
    safePaint(map, 'trees-trunk',  'fill-extrusion-color', s.trunk);
    safePaint(map, 'landscape-pitch',    'fill-color', s.pitch);
    safePaint(map, 'landscape-fountain', 'fill-color', s.fountain);

    for (const id of _bgLayers)    safePaint(map, id, 'background-color', s.ground);
    for (const id of _groundFills) safePaint(map, id, 'fill-color',       s.ground);
    for (const id of _parkFills)   safePaint(map, id, 'fill-color',       s.park);
    for (const id of _waterFills)  safePaint(map, id, 'fill-color',       s.water);
    for (const id of _waterLines)  safePaint(map, id, 'line-color',       s.water);
    for (const id of _roadLines)   safePaint(map, id, 'line-color', _casings.has(id) ? s.roadCasing : s.road);

    safePaint(map, 'buildings-labels', 'text-halo-color', s.labelHalo);
    // OSM labels recede after dark: the curated brand signage is the night
    // story, and the full-white names outshone the lit windows themselves.
    // Ramp stops mirror the layer definition in app.js (16.8 → 17.5).
    {
      const OSM_LABEL_NIGHT_DIM = 0.45;   // 0 = untouched, 1 = invisible at night
      const nightAmt = (typeof window.skyBodies === 'function') ? window.skyBodies(p).night : 0;
      const lblMax = 0.82 * (1 - OSM_LABEL_NIGHT_DIM * nightAmt);
      safePaint(map, 'buildings-labels', 'text-opacity',
        ['interpolate', ['linear'], ['zoom'], 16.8, 0, 17.5, +lblMax.toFixed(3)]);
    }

    // Curated branded landmark signs (signs.js) — glow + ground light pools.
    if (typeof applySignGlowLayer === 'function') applySignGlowLayer(map, s.signGlow, p);
    // Streetlights (night.js) — lamp pools fade up through dusk.
    if (typeof applyNightLayer === 'function') applyNightLayer(map, p);

    if (typeof updateSky === 'function') updateSky(map, p);

    applyGradeFor(s);
  }

  /**
   * Hand the hour's colour grade to graphics.js, which multiplies it by the
   * user's own exposure/contrast/saturation/vignette offsets. The vignette used
   * to be written straight to the element from here, so the graphics menu's
   * vignette slider was overwritten on the next time-of-day tick.
   */
  function applyGradeFor(s) {
    if (typeof window.setGrade === 'function') {
      window.setGrade({
        exposure: s.exposure, contrast: s.contrast,
        saturation: s.saturation, vignette: s.vignette,
      });
      return;
    }
    const vig = document.getElementById('vignette');
    if (vig) vig.style.opacity = String(s.vignette);
  }

  function safePaint(map, id, prop, val) {
    try { if (map.getLayer && !map.getLayer(id)) return; map.setPaintProperty(id, prop, val); } catch(e) {}
  }

  // ── UI ────────────────────────────────────────────────────────────
  let _autoRaf=null, _autoDir=1;
  const AUTO_PER_MS = 1/32000;

  /**
   * ALWAYS retint through window.applyTimeOfDay, never the local one.
   *
   * This is why "going from night to day takes forever to render". Five pass
   * modules — js/tower.js, js/arts.js, js/drag.js, js/moody.js, js/places.js —
   * each WRAP window.applyTimeOfDay at boot so their own bands, atlases and
   * baked colours retint with the rest of the scene. The slider handler and the
   * auto-play loop below called the bare, IIFE-local `applyTimeOfDay` instead,
   * which is the unwrapped original. So dragging the sun did retint the generic
   * city and did NOT retint the UT Tower, the Harry Ransom Center, the Drag,
   * Moody or the storefronts: they held whatever hour app.js last drove them to,
   * and only snapped when some unrelated event happened to call the window
   * property (js/app.js:1216 on a graphics change, for one).
   *
   * That is exactly the reported symptom — "the Ransom Center just became dark,
   * didn't do anything, night just took that long to render", "the tower just
   * became orange after having night on for like 5 minutes", "the black roofs
   * took 2 minutes to correct". Nothing was slow. The retint was never called.
   *
   * js/arts.js:376-378 documents the opposite belief in a comment, and it is
   * wrong. Route every UI path through the wrapper chain and there is no delay.
   */
  const retint = (map, p, force) =>
    (window.applyTimeOfDay || applyTimeOfDay)(map, p, force);

  function initTimeOfDayUI(map, defaultP) {
    const slider = document.getElementById('tod-slider');
    const play   = document.getElementById('tod-play');
    const p0 = defaultP != null ? defaultP : TOD_DEFAULT_P;
    if (slider) {
      slider.value = String(p0);
      slider.addEventListener('input', () => { stopAuto(play); retint(map, parseFloat(slider.value)); });
    }
    if (play) play.addEventListener('click', () => _autoRaf ? stopAuto(play) : startAuto(map, slider, play));
  }

  function startAuto(map, slider, play) {
    if (play) { play.textContent = '❚❚'; play.classList.add('playing'); }
    let last = performance.now();
    let p = slider ? parseFloat(slider.value) : (window.__todCurrentP ?? TOD_DEFAULT_P);
    _autoDir = 1;
    const step = now => {
      const dt = now - last; last = now;
      p += _autoDir * dt * AUTO_PER_MS;
      if (p >= 1) { p=1; _autoDir=-1; } else if (p <= 0) { p=0; _autoDir=1; }
      if (slider) slider.value = String(p);
      retint(map, p);
      _autoRaf = requestAnimationFrame(step);
    };
    _autoRaf = requestAnimationFrame(step);
  }

  function stopAuto(play) {
    if (_autoRaf) cancelAnimationFrame(_autoRaf);
    _autoRaf = null;
    if (play) { play.textContent = '▶'; play.classList.remove('playing'); }
  }

  window.TOD_DEFAULT_P   = TOD_DEFAULT_P;
  window.cleanupBasemap  = cleanupBasemap;
  window.applyTimeOfDay  = applyTimeOfDay;
  window.initTimeOfDayUI = initTimeOfDayUI;
})();
