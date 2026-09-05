# Dallas 3D Explorer

A browser-based, flyable low-poly recreation of downtown Dallas. No install, no
plugin, no account — open the link and fly.

Built by Simeon Varghese.

---

## What it is

Every building in a 3.3 × 3.1 km box over downtown Dallas, extruded to its real
LiDAR-derived height, on the real street grid, with the real park boundaries and
the real elevated highway network. 2220 buildings, 11529 trees, 13832 road ways,
1028 ground surfaces, and 1273 elevated deck slabs on 366 piers, the highest
deck standing 28.4 m up.

Two things get more attention than the rest:

**Five towers are massed by hand.** A footprint extruded to a height is exactly
right for 2,215 of the 2,220 buildings — a downtown block is a box. It is wrong
for five, and they happen to be the five the skyline is made of:

| Tower | Height | What the data alone gets wrong |
|---|---|---|
| Bank of America Plaza | 280.7 m | The stepped crown, and two miles of green argon up every corner |
| Renaissance Tower | 270.0 m | 40 m of mast above the roof |
| Comerica Bank Tower | 240.0 m | The barrel vault on top |
| Fountain Place | 219.5 m | It is a cut prism, not a box |
| Reunion Tower | 171.9 m | Its footprint is the lobby. Extruded, it is a filing cabinet |

Heights are *not* the problem — Overture's LiDAR heights for all five are within
a metre of the published figures. Shape is. See
[`js/heroes-dallas.js`](js/heroes-dallas.js), which also records honestly what is
*not* modelled (Renaissance's X-braces, Chase Tower's hole).

**The highways are elevated.** The Mixmaster, I-345, and Woodall Rodgers under
Klyde Warren Park are structure, not topography — decks on piers above a ground
plane that really is flat. There is no terrain in this scene and none is needed.
See [`scripts/bake_highways.py`](scripts/bake_highways.py) for how OSM's `layer`
ordering integer becomes a height in metres, and how far that can be trusted.

## Run it locally

```bash
python scripts/serve.py 8788
```

Then open <http://localhost:8788>. Use `scripts/serve.py`, not
`python -m http.server` — the stdlib server ignores `Range:` headers and sends
no cache headers, and both failures look like application bugs.

Controls: **WASD** move, drag to look, **Q/E** or wheel for altitude, **Shift**
boost, **R** reset, **P** photo, **T** tour.

Useful query flags: `?heroes=0` puts the five back as plain data extrusions,
`?clip=1` hides all chrome for capture, `?tour=1` starts the tracking shot.

## Rebuild the data

Each step writes one file and nothing else writes that file.

```bash
python scripts/extract.py            # Overture buildings -> snapshots/<date>/buildings.geojson
python scripts/enrich.py             # + OSM names, height fallback chain, hero overrides
python scripts/make_hero_designs.py  # -> data/hero_designs.json (the colour brain)
python scripts/bake_detail.py <date> # + baked day/golden/night colours
python scripts/fetch_roads.py        # OSM road network -> data/osm_cache/
python scripts/bake_roads.py         # -> data/roads.geojson
python scripts/bake_highways.py      # -> data/highways.geojson (elevated decks + piers)
python scripts/bake_ground.py        # -> data/ground.geojson (parks, water, lots)
python scripts/bake_trees.py         # -> data/trees.geojson
python scripts/update_manifest.py    # -> data/manifest.json
```

`enrich.py` and the three `bake_*` fetchers need `shapely`, `pyproj` and
`requests`; `extract.py` needs `duckdb`. The bounding box, the Overture release
and the snapshot date all live in [`scripts/config.sh`](scripts/config.sh) —
that file is the single definition of how much city this repo contains.

## Caching

`vercel.json` marks `data/snapshots/<date>/` immutable for a year and everything
else under `data/` one hour, revalidated. That split is deliberate: a snapshot's
path carries its bake date, so a re-bake writes a *new* path and can never need
to invalidate an old one. `data/roads.geojson`, `data/trees.geojson` and
`data/highways.geojson` are overwritten *in place* by their bake scripts, so
marking those immutable would mean a rebuild deploys correctly and then never
reaches anyone who had already visited — for a year, indistinguishable from a
cache miss.

## Performance

The roofscape was the one addition big enough to be worth an A/B, because it
roughly doubles the extrusion count in a downtown frame. Measured at z16.9 over
Pacific Place, seven interleaved reps, minimum of each (this repo's rule: never
trust one reading, and take the minimum of interleaved reps):

    roofscape + pitched roofs ON     45.4 ms
    the same four layers hidden      43.1 ms
    ------------------------------------------
    cost of the whole roofscape       2.3 ms   (~5%)

That is cheap for what it buys, and the tier split is why: the 8,682 small
clutter features are held back until z16.2 and are not fetched before then.

The ABSOLUTE figure above is not a frame rate. It was taken by driving
`map._render()` in a loop with the automation pane hidden, which has no vsync
and no compositor — only the DELTA between the two arms is meaningful. A real
interactive frame rate still wants measuring on a displayed window.

A visitor downloads 29 MB of GeoJSON, which is **4.0 MB on the wire** after
gzip — about 25,000 visits inside Vercel's free 100 GB. `trees.geojson` is 40%
of it and is the first place to look if that ever matters.

## Honesty notes

These are the places where the render is a claim rather than a measurement, in
one list so nobody has to go looking:

- **Highway deck heights are derived, not surveyed.** OSM's `layer` says which
  deck is on top, never how high. Heights come from a rule (AASHTO clearance +
  typical superstructure depth = 7.1 m per level). Individual decks may be a
  couple of metres out.
- **91% of the canopy is generated.** Dallas publishes no open street-tree
  inventory, so trees come from OSM's ~1,000 mapped trees plus a deterministic
  scatter inside *real, surveyed* park boundaries at an urban-park density. The
  boundaries are factual; the individual trees are not.
- **Ramps are flights of flat slabs.** A `fill-extrusion` cannot slope. At
  flying altitude this reads as a curve; nose to the pavement it reads as steps.
- **Renaissance Tower's X-braces are absent**, and so is Chase Tower's hole.
  Both need geometry a vertical prism cannot express.
- **Hero colours are read off photographs**, with a `confidence` field on each
  in [`data/hero_designs.json`](data/hero_designs.json) saying how firm it is.

## Credits

Buildings and heights: [Overture Maps](https://overturemaps.org) (LiDAR-derived).
Names, roads, parks, trees and the highway `layer` ordering:
[OpenStreetMap](https://www.openstreetmap.org) contributors, ODbL.
Basemap tiles: [OpenFreeMap](https://openfreemap.org).
Rendering: [MapLibre GL JS](https://maplibre.org).

The engine is ported from [austin-3d-explorer](https://github.com/SimeonVarg/austin-3d-explorer),
the same project built over UT Austin.
