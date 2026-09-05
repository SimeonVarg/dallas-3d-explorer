/**
 * shadows.js — ground shadows for Austin 3D Explorer
 *
 * MapLibre has no shadow casting (and no ambient occlusion — that's Mapbox v3),
 * which is why the buildings read as cardboard cut-outs pasted on a flat plane.
 * A `fill` layer can't be offset per feature either: `fill-translate` is not
 * data-driven, so every building would cast the same shadow regardless of how
 * tall it is.
 *
 * So the shadows are built as real geometry: for each footprint, offset a copy
 * by (height / tan(sun elevation)) in the anti-sun direction and take the
 * convex hull of the original plus the copy. That is the swept silhouette — it
 * stays attached to the building base and grows with height, which is what
 * sells the volume. Convex hulls slightly over-fill concave footprints; at
 * this scale, in a stylised scene, it reads correctly.
 *
 * Everything is derived on the client from the buildings GeoJSON that's already
 * being downloaded, so this costs zero extra payload, and the sun can swing
 * with the time-of-day slider.
 *
 * Public (window) API:
 *   initShadows(map, features)      — add the source + layer
 *   updateShadows(map, p)           — re-cast for time-of-day p (throttled)
 */
(function () {
  'use strict';

  const SRC = 'city-shadows', LAYER = 'buildings-shadow';
  const MIN_HEIGHT = 3;      // sheds don't earn a shadow
  const MAX_LENGTH = 2.4;    // cap the golden-hour stretch, in building heights
  const RING_BOTTOM = 'outer-3d'; // js/outer.js L_FLAT — the ring's lowest layer
  const TUCK_POLL_MS = 250;       // outer's layers arrive after a network fetch
  const TUCK_TRIES = 240;         // ~60 s, then give up (?outer=0 has no ring)

  let _feats = null, _map = null, _lastP = null, _timer = null;

  // The sun comes from sky.js — ONE arc shared by the shadows, MapLibre's light
  // and the visible disc. This file used to walk its own (az 150→245) while
  // setLight walked another (az 205→252), so the shadows pointed 55° away from
  // where the scene was lit from.
  function sunAt(p) {
    if (typeof window.skyBodies === 'function') return window.skyBodies(p).sun;
    return { az: 150 + 106 * Math.min(1, p / 0.5), elev: 64 - 58 * Math.min(1, p / 0.5) };
  }

  // Firm when the sun is high, softer as it drops, gone once it sets — driven by
  // the real solar elevation rather than a hardcoded p, so it can never
  // disagree with where the sun visibly is.
  function shadowOpacity(p) {
    const elev = sunAt(p).elev;
    if (elev <= 0) return 0;
    return 0.10 + 0.20 * Math.min(1, elev / 45);
  }

  function ringsOf(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return [geom.coordinates[0]];
    if (geom.type === 'MultiPolygon') return geom.coordinates.map(poly => poly[0]);
    return [];
  }

  /** Andrew's monotone chain. */
  function hull(pts) {
    if (pts.length < 4) return pts;
    const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
    const lower = [];
    for (const p of s) {
      while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = s.length - 1; i >= 0; i--) {
      const p = s[i];
      while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    const h = lower.concat(upper);
    h.push(h[0]);
    return h;
  }

  function build(p) {
    const { az, elev } = sunAt(p);
    if (elev <= 0) return { type: 'FeatureCollection', features: [] };
    const rad = az * Math.PI / 180;
    // Shadow points away from the sun.
    const ux = -Math.sin(rad), uy = -Math.cos(rad);
    const reach = Math.min(MAX_LENGTH, 1 / Math.tan(elev * Math.PI / 180));

    const out = [];
    for (const f of _feats) {
      const h = f.properties && (f.properties.final_height || f.properties.h);
      if (!h || h < MIN_HEIGHT) continue;
      const metres = h * reach;
      for (const ring of ringsOf(f.geometry)) {
        if (ring.length < 4) continue;
        // Local metres→degrees at this ring's latitude.
        const lat = ring[0][1];
        const dLat = (metres * uy) / 111320;
        const dLon = (metres * ux) / (111320 * Math.cos(lat * Math.PI / 180));
        const pts = [];
        for (const c of ring) { pts.push(c); pts.push([c[0] + dLon, c[1] + dLat]); }
        const hl = hull(pts);
        if (hl.length >= 4) out.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [hl] } });
      }
    }
    return { type: 'FeatureCollection', features: out };
  }

  window.initShadows = function initShadows(map, features, p) {
    _map = map;
    _feats = features;
    _lastP = p;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: build(p) });
    if (!map.getLayer(LAYER)) {
      // Below the buildings but above roads/ground, so shadows fall on the
      // street the way they should.
      const before = map.getLayer('buildings-shadow-anchor') ? 'buildings-shadow-anchor'
                   : map.getLayer(RING_BOTTOM) ? RING_BOTTOM
                   : map.getLayer('buildings-3d') ? 'buildings-3d' : undefined;
      map.addLayer({
        id: LAYER, type: 'fill', source: SRC, minzoom: 13.5,
        paint: {
          'fill-color': '#2b2013',
          'fill-opacity': shadowOpacity(p),
          'fill-antialias': true,
        },
      }, before);
      // THE OPENING SMEAR (QUEUE "THE OPENING SMEAR", diagnosed 2026-08-22,
      // acer/f-smear). This layer is a 2D fill: it never depth-tests, it
      // paints over every pixel drawn before it. js/outer.js adds the
      // downtown ring later (network) and anchors it below `buildings-ao`,
      // i.e. BELOW this fill — so at INTRO.start (pitch 78) the campus
      // shadows, compressed into the horizon band, painted their dark hulls
      // straight across the downtown towers for ~2 s after the title card
      // lifts. Ground shadows belong under every extrusion: once the ring's
      // lowest layer exists, tuck this fill beneath it. Proof:
      // shots/f/smear/fix-A-before.jpg vs fix-B-after.jpg.
      let tuckTries = 0;
      (function tuck() {
        if (!_map || !_map.getLayer(LAYER)) return;
        if (_map.getLayer(RING_BOTTOM)) {
          try { _map.moveLayer(LAYER, RING_BOTTOM); } catch (e) {}
          return;
        }
        if (++tuckTries < TUCK_TRIES) setTimeout(tuck, TUCK_POLL_MS);
      })();
    }
  };

  // Re-casting 2.4k hulls costs a few ms; debounce so dragging the slider (or
  // the auto day/night cycle) stays smooth and only settles on a new sun.
  window.updateShadows = function updateShadows(map, p) {
    if (!_feats || !map.getLayer(LAYER)) return;
    try { map.setPaintProperty(LAYER, 'fill-opacity', shadowOpacity(p)); } catch (e) {}
    if (_lastP != null && Math.abs(p - _lastP) < 0.04) return;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => {
      _timer = null;
      _lastP = p;
      const src = map.getSource(SRC);
      if (src) src.setData(build(p));
    }, 140);
  };
})();
