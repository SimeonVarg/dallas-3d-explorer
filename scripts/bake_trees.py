#!/usr/bin/env python3
"""bake_trees.py — the canopy, from OpenStreetMap.

WHY THIS REPLACES AUSTIN'S fetch_city_trees.py RATHER THAN PORTING IT. That
script reads the City of Austin Tree Inventory off Austin's Socrata portal
(data.austintexas.gov/resource/wrik-xasw), a surveyed record of ~200,000 street
trees with a measured trunk diameter on each one. It is a genuinely better input
than OSM and the allometry in that file is built around having a real diameter.

Dallas publishes no equivalent open street-tree inventory, so the diameter is
simply not available and the allometry has nothing to eat. Porting the script
would mean keeping its structure and feeding every tree the same invented
diameter, which produces a forest of identical trees wearing the costume of
measured data. This asks OSM for what it actually knows and says so.

WHAT IS FACTUAL HERE AND WHAT IS NOT — the same split Austin's file draws:

  POSITION  factual for OSM's own `natural=tree` nodes. GENERATED, but
            deterministically and inside real park boundaries, for the scatter.
  SIZE      generated. OSM rarely carries height or diameter downtown, so size
            comes from a seeded hash of the position — stable across runs, so
            a tree does not change size when the file is rebuilt.
  FORM      generative, as it is in Austin: an octagon canopy in three tiers
            over a box trunk.

THE SCATTER, and why it is not cheating. Downtown Dallas has roughly a hundred
mapped individual trees inside the bbox — nothing like the real canopy, because
nobody has walked downtown adding tree nodes. But the PARKS are mapped
accurately: Klyde Warren Park, Main Street Garden, Belo Garden, Pacific Plaza,
Dealey Plaza, the Trinity levee strip. Scattering inside a surveyed boundary at
a published density is a different claim from scattering across the map: the
boundary is real, the count is a reasonable density, and no tree lands in a
street or on a building. What it is not is a survey of where the trees are.

Usage:  python scripts/bake_trees.py [--refresh]
"""
import hashlib
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

from shapely.geometry import Polygon, Point, shape
from shapely.prepared import prep

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "osm_cache")
OUT = os.path.join(ROOT, "data", "trees.geojson")

# The camera fence (js/controls.js MODELLED), not the config bbox — the canopy
# has to reach the horizon or the modelled area ends in a visible bare ring.
BBOX = "32.765,-96.821,32.803,-96.774"
LAT0 = 32.7820

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "dallas-3d-explorer/1.0 (+https://github.com/SimeonVarg/dallas-3d-explorer)"

# Trees per hectare inside a mapped green polygon. An urban park canopy runs
# 80-150 stems/ha; 95 sits inside that and keeps the feature count sane. Raising
# this is the one knob for a denser city.
STEMS_PER_HA = 95.0
# Green polygons worth planting. Deliberately NOT `landuse=grass` on its own —
# that tag covers highway verges and median strips, and planting those puts a
# line of trees down the middle of Woodall Rodgers.
GREEN = {
    ("leisure", "park"), ("leisure", "garden"), ("leisure", "nature_reserve"),
    ("landuse", "forest"), ("natural", "wood"), ("landuse", "cemetery"),
    ("landuse", "recreation_ground"), ("leisure", "pitch"),
}

_MPD_LAT = 111132.0
_MPD_LON = 111320.0 * math.cos(math.radians(LAT0))


def fetch(query, tries=6):
    body = b"data=" + urllib.parse.quote(query).encode()
    last = None
    for i in range(tries):
        url = MIRRORS[i % len(MIRRORS)]
        try:
            req = urllib.request.Request(
                url, data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded",
                         "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except Exception as e:      # noqa: BLE001 — mirrors are flaky by nature
            last = e
            print("  %s failed (%s); retrying" % (url.split("/")[2], e))
            time.sleep(2 + 3 * i)
    raise RuntimeError("every Overpass mirror failed: %s" % last)


def cached(key, query, refresh=False):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, key + ".json")
    if os.path.exists(p) and not refresh:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    d = fetch(query)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f)
    print("  %s fetched %d elements (%.1f MB)"
          % (key, len(d.get("elements", [])), os.path.getsize(p) / 1e6))
    return d


def rnd01(*parts):
    """Deterministic 0..1 from any key. The SAME tree gets the same size on
    every rebuild, which is what stops a re-bake from reshuffling the canopy."""
    h = hashlib.md5("|".join(str(x) for x in parts).encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def octagon(lon, lat, r_m):
    """Canopy footprint. Eight sides is Austin's choice and it is kept: at the
    zoom a tree is legible, an octagon and a circle are the same picture, and an
    octagon is 8 vertices instead of 32 across ~12,000 trees."""
    ring = []
    for i in range(8):
        a = math.pi / 8 + i * math.pi / 4
        ring.append([round(lon + (r_m * math.cos(a)) / _MPD_LON, 6),
                     round(lat + (r_m * math.sin(a)) / _MPD_LAT, 6)])
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def box(lon, lat, w_m):
    r = w_m / 2.0
    ring = [[round(lon - r / _MPD_LON, 6), round(lat - r / _MPD_LAT, 6)],
            [round(lon + r / _MPD_LON, 6), round(lat - r / _MPD_LAT, 6)],
            [round(lon + r / _MPD_LON, 6), round(lat + r / _MPD_LAT, 6)],
            [round(lon - r / _MPD_LON, 6), round(lat + r / _MPD_LAT, 6)]]
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def tree_features(lon, lat, seed, out):
    """One tree: a trunk box and THREE canopy tiers.

    Three tiers, not one blob, for the reason Austin's app.js records in the
    `trees-canopy` paint block — a single extrusion with a vertical gradient
    darkens the bottom of the whole crown and reads as a cylinder. Stacked tiers
    of decreasing radius read as a crown, and the vertical gradient is turned
    off so each tier does not get its own shadow.
    """
    r = rnd01(seed, lon, lat)
    h = 6.0 + r * 11.0                       # 6-17 m, an urban street tree
    spread = 0.42 + rnd01(seed, "s", lon) * 0.22
    crown_r = h * spread
    trunk_h = h * (0.30 + rnd01(seed, "t", lat) * 0.10)
    d = rnd01(seed, "d", lon, lat)           # density tier for GFX.treeDensity

    out.append({"type": "Feature",
                "properties": {"kind": "trunk", "h": round(trunk_h, 1), "d": round(d, 3)},
                "geometry": box(lon, lat, max(0.35, h * 0.045))})
    tiers = ((1.00, 0.62), (0.80, 0.80), (0.50, 0.96))
    for i, (rf, hf) in enumerate(tiers):
        base = trunk_h + (h - trunk_h) * (0.0 if i == 0 else tiers[i - 1][1] - 0.10)
        out.append({"type": "Feature",
                    "properties": {"kind": "canopy",
                                   "base": round(base, 1),
                                   "h": round(trunk_h + (h - trunk_h) * hf, 1),
                                   "d": round(d, 3)},
                    "geometry": octagon(lon, lat, crown_r * rf)})


def main():
    refresh = "--refresh" in sys.argv
    s, w, n, e = BBOX.split(",")

    q_trees = ('[out:json][timeout:120];node["natural"="tree"](%s);out body;'
               % BBOX)
    q_green = ('[out:json][timeout:180];('
               'way["leisure"~"park|garden|nature_reserve|pitch"](%s);'
               'way["landuse"~"forest|cemetery|recreation_ground"](%s);'
               'way["natural"="wood"](%s);'
               'relation["leisure"="park"](%s););out geom;'
               % (BBOX, BBOX, BBOX, BBOX))

    print("Fetching OSM trees and green polygons for %s" % BBOX)
    d_trees = cached("trees_osm", q_trees, refresh)
    d_green = cached("green_osm", q_green, refresh)

    feats = []
    n_mapped = 0
    for el in d_trees.get("elements", []):
        if el.get("type") == "node":
            tree_features(el["lon"], el["lat"], "osm%d" % el["id"], feats)
            n_mapped += 1

    # ── the scatter ──────────────────────────────────────────────────────
    n_scatter = n_polys = 0
    for el in d_green.get("elements", []):
        geom = el.get("geometry")
        if not geom or len(geom) < 4:
            continue
        tags = el.get("tags", {})
        if not any((k, v) in GREEN for k, v in tags.items()):
            continue
        ring = [(p["lon"], p["lat"]) for p in geom]
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        try:
            poly = Polygon(ring)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty:
                continue
        except Exception:           # noqa: BLE001 — a malformed way is not fatal
            continue
        n_polys += 1

        # Area in m2 via the local scale factors, not poly.area (which is in
        # square DEGREES and out by a factor of ~10^10).
        area_m2 = poly.area * _MPD_LON * _MPD_LAT
        count = int(area_m2 / 10000.0 * STEMS_PER_HA)
        if count <= 0:
            continue
        pr = prep(poly)
        lo, la, hi, ha = poly.bounds
        tries = 0
        placed = 0
        # Rejection sampling against the real boundary, seeded off the way id so
        # the layout is stable between runs. Capped at 40x the target so a
        # pathological sliver polygon cannot spin here.
        while placed < count and tries < count * 40:
            u = rnd01(el["id"], tries, "x")
            v = rnd01(el["id"], tries, "y")
            lon = lo + (hi - lo) * u
            lat = la + (ha - la) * v
            tries += 1
            if pr.contains(Point(lon, lat)):
                tree_features(lon, lat, "%d-%d" % (el["id"], placed), feats)
                placed += 1
                n_scatter += 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)

    kb = os.path.getsize(OUT) // 1024
    trees = n_mapped + n_scatter
    print("wrote data/trees.geojson  %d trees -> %d features  (%d KB)"
          % (trees, len(feats), kb))
    print("  mapped by OSM: %d   scattered in %d green polygons: %d"
          % (n_mapped, n_polys, n_scatter))
    if trees:
        print("  %.0f%% of the canopy is generated, not surveyed"
              % (100.0 * n_scatter / trees))


if __name__ == "__main__":
    main()
