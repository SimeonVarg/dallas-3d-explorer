/**
 * tiles.js — teach MapLibre to read the PMTiles archives, and say so out loud.
 *
 * WHY ANY OF THIS. A first-time visitor downloads ~28 MB across 26 files before
 * the city appears, and every file is the WHOLE city — fetched whether or not
 * the camera can see it. That is the ceiling on how much detail this project can
 * ever have: a nicer roofscape makes the site slower for everyone. Tiles remove
 * the trade, because the browser fetches only the tiles under the camera. Detail
 * stops costing load time.
 *
 * The five big layers (trees, roads, outer ring, roof detail, props — 20 MB of
 * the 28) are built by scripts/tile.sh into data/tiles/*.pmtiles. Buildings stay
 * GeoJSON on purpose; see the header of tile.sh for why, and note they are only
 * 1.41 MB of the payload.
 *
 * REGISTRATION IS A SIDE EFFECT AND ORDER MATTERS. `maplibregl.addProtocol` has
 * to be called before any map is constructed, so this file is a script tag in
 * index.html between the two libraries and everything else, not something app.js
 * calls. If it runs late the source silently 404s and the layer is simply
 * absent — no error, no missing-texture checkerboard, just no trees.
 *
 * IT FALLS BACK, AND THAT IS THE POINT OF THE FLAG BELOW. The tiles are built by
 * CI and committed; a fresh clone or a branch where the build has not run yet has
 * no data/tiles/ at all. Rather than render a city with no trees and no roads,
 * `window.TILES.on` goes false and every caller keeps its existing GeoJSON URL.
 * Slower, correct, and obvious — a blank city that looks deliberate is the worst
 * outcome available here.
 */
(function () {
  'use strict';

  /**
   * MAPLIBRE USES ONE WORKER, ON A SIXTEEN-CORE MACHINE.
   *
   * This is here rather than in a file of its own because `setWorkerCount` has
   * the same hard constraint as `addProtocol`: it must run before any Map is
   * constructed, and this file is already the thing that runs there.
   *
   * HOW IT WAS FOUND. boot.mjs now records when each source becomes usable.
   * Every one of our 22 sources finished between 3.8 s and 6.7 s — tiny ones
   * and huge ones alike, `city-buildings` sitting unremarkably in the middle.
   * Sources of wildly different sizes finishing together is not a size problem,
   * it is a QUEUE, and `maplibregl.getWorkerCount()` returned **1**.
   *
   * MEASURED, five interleaved reps, hardware GL, localhost:
   *
   *     workers=1   6747 6574 6539 6543 6358    min 6358 ms
   *     workers=4   5825 5507 6414 5736 6083    min 5507 ms
   *     workers=8   5871 6855                   worse than 4
   *
   * Four won all five reps. ~0.85 s at the minimum, ~0.7 s at the median. Eight
   * is worse than four — past the point where more threads help, the scheduling
   * costs more than it saves.
   *
   * SCALED, NOT FIXED AT FOUR. A phone with two cores handed four tile workers
   * spends its time context-switching, and the whole point of the load work is
   * the person on a phone. Half the cores, capped at four because four is where
   * the measurement stopped improving.
   */
  const MAP_WORKERS = {
    on: true,
    max: 4,                                   // measured ceiling; 8 was worse
    perCores: 2,                              // one worker per this many cores
  };
  window.MAP_WORKERS = MAP_WORKERS;

  if (MAP_WORKERS.on && typeof maplibregl !== 'undefined'
      && typeof maplibregl.setWorkerCount === 'function') {
    const cores = navigator.hardwareConcurrency || 2;
    const n = Math.max(1, Math.min(MAP_WORKERS.max,
                                   Math.floor(cores / MAP_WORKERS.perCores)));
    try {
      maplibregl.setWorkerCount(n);
      console.log('[tiles] tile workers: ' + n + ' (' + cores + ' cores)');
    } catch (e) {
      console.warn('[tiles] setWorkerCount failed:', e.message);
    }
  }

  // Taste/behaviour block — one edit to turn the whole thing off.
  const TILES = {
    // Master switch. `?tiles=0` forces it off for an A/B without editing code.
    on: new URLSearchParams(location.search).get('tiles') !== '0',
    dir: 'data/tiles',
    // Layer name inside each archive, set by --layer= in scripts/tile.sh. If
    // these two ever disagree the source loads and draws nothing, so they are
    // written down together rather than being spelled out at each call site.
    layers: {
      trees:      { file: 'trees.pmtiles',      layer: 'trees' },
      roads:      { file: 'roads.pmtiles',      layer: 'roads' },
      outer:      { file: 'outer.pmtiles',      layer: 'outer' },
      roofdetail: { file: 'roofdetail.pmtiles', layer: 'roofdetail' },
      props:      { file: 'props.pmtiles',      layer: 'props' },
    },
    // Must match --maximum-zoom in scripts/tile.sh. MapLibre needs to be told,
    // or it requests z17+ tiles that do not exist and the layer disappears when
    // you fly close — the exact failure that looks like "the trees vanish".
    maxzoom: 16,
  };
  window.TILES = TILES;

  if (!TILES.on) { console.log('[tiles] disabled by ?tiles=0'); return; }

  if (typeof pmtiles === 'undefined' || typeof maplibregl === 'undefined') {
    console.warn('[tiles] pmtiles or maplibre not loaded - falling back to GeoJSON');
    TILES.on = false;
    return;
  }

  try {
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
  } catch (e) {
    console.warn('[tiles] addProtocol failed:', e.message, '- falling back to GeoJSON');
    TILES.on = false;
    return;
  }

  /**
   * Probe once, up front, so a missing archive degrades on purpose instead of
   * per-layer at random. A HEAD is enough — pmtiles serves range requests off a
   * static host, so if the file is there at all it works.
   */
  TILES.ready = (async () => {
    try {
      const r = await fetch(TILES.dir + '/' + TILES.layers.trees.file, {
        method: 'HEAD',
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      console.log('[tiles] pmtiles available');
      return true;
    } catch (e) {
      console.warn('[tiles] no archives at ' + TILES.dir + ' (' + e.message +
                   ') - every layer stays on GeoJSON');
      TILES.on = false;
      return false;
    }
  })();

  /**
   * The one call sites make. Returns either a vector-source spec plus the
   * `source-layer` its layers need, or null — and null means "use your GeoJSON
   * URL exactly as before".
   *
   *   const t = window.tileSource('trees');
   *   map.addSource('city-trees', t ? t.source
   *                                   : { type:'geojson', data:'data/trees.geojson' });
   *   ...and spread t.layerProps into every layer on it.
   */
  window.tileSource = function tileSource(name) {
    if (!TILES.on) return null;
    const spec = TILES.layers[name];
    if (!spec) { console.warn('[tiles] unknown layer', name); return null; }
    return {
      source: {
        type: 'vector',
        url: 'pmtiles://' + TILES.dir + '/' + spec.file,
        // Belt and braces alongside the archive's own metadata.
        maxzoom: TILES.maxzoom,
      },
      layerProps: { 'source-layer': spec.layer },
    };
  };
})();
