#!/usr/bin/env python3
"""bake_ground.py — the ground plane: parks, water, plazas, lots, pitches.

WHY THIS IS 250 LINES AND AUSTIN'S IS 3,000. That file's bulk is not the ground
plane; it is Waller Creek. It carves a channel, reconciles the creek's culverts
against its bridges, decks the campus walkways, surveys the ledges under the
23rd Street bridge, and widens the roads into polygons. All of it is about one
watercourse running through one campus, and none of it applies here.

What this repo needs from the ground plane is the part that generalises: every
mapped surface that is NOT a building and NOT a road, painted with the right
material so downtown does not sit on undifferentiated tan.

THE SURFACE VOCABULARY IS NOT MINE TO INVENT. js/ground.js owns it — `SURF.day`
lists every key it can paint, and a key that is not in that table renders with
the fallback and reads as a surface that should not be there. So SURFACE below
maps OSM tags onto THAT vocabulary and nothing else, and anything unrecognised
is dropped rather than guessed at.

ONE DALLAS-SPECIFIC DECISION. The Trinity River is the west edge of the box and
it is not a river in the way `water` implies — for most of the year it is a
narrow channel inside an enormous mown floodway between two levees. Painting the
whole mapped riverbank polygon lake-blue puts a quarter-kilometre of open water
where there is grass. So `waterway=riverbank` on the Trinity is painted `creek`
(the darker, shaded channel colour) and the floodway around it comes through as
`grass` from its own landuse tags, which is what it actually looks like from the
air.

Inputs:   OSM via Overpass, cached in data/osm_cache/
Outputs:  data/ground.geojson

Usage:  python scripts/bake_ground.py [--refresh]
"""
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "osm_cache")
OUT = os.path.join(ROOT, "data", "ground.geojson")

BBOX = "32.765,-96.821,32.803,-96.774"
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "dallas-3d-explorer/1.0 (+https://github.com/SimeonVarg/dallas-3d-explorer)"

# OSM tag -> a key js/ground.js's SURF table can actually paint.
# Order matters: the first rule that matches a way wins, so the specific tags
# sit above the general ones.
SURFACE = [
    (("natural", "water"), "water"),
    (("waterway", "riverbank"), "creek"),      # see the Trinity note above
    (("natural", "wetland"), "creek"),
    (("landuse", "reservoir"), "pond"),
    (("leisure", "swimming_pool"), "pond"),

    (("natural", "wood"), "wood"),
    (("landuse", "forest"), "wood"),
    (("leisure", "nature_reserve"), "wood"),

    (("leisure", "pitch"), "turf"),
    (("landuse", "grass"), "grass"),
    (("leisure", "park"), "grass"),
    (("leisure", "garden"), "grass"),
    (("landuse", "cemetery"), "grass"),
    (("landuse", "recreation_ground"), "grass"),
    (("landuse", "village_green"), "grass"),
    (("natural", "scrub"), "wood"),
    (("natural", "sand"), "sand"),
    (("natural", "beach"), "sand"),

    (("amenity", "parking"), "asphalt"),
    (("landuse", "railway"), "gravel"),
    (("landuse", "industrial"), "concrete"),
    (("landuse", "construction"), "dirt"),
    (("landuse", "brownfield"), "dirt"),

    (("highway", "pedestrian"), "paving"),
    (("place", "square"), "paving"),
    (("man_made", "bridge"), "concrete"),
]

# `surface=` overrides the landuse guess when OSM actually states the material.
EXPLICIT = {
    "asphalt": "asphalt", "concrete": "concrete", "concrete:plates": "concrete",
    "paving_stones": "paving", "sett": "paving", "cobblestone": "paving",
    "bricks": "brick", "brick": "brick", "gravel": "gravel",
    "fine_gravel": "gravel", "compacted": "gravel", "dirt": "dirt",
    "ground": "dirt", "earth": "dirt", "grass": "grass", "sand": "sand",
    "wood": "wood",
}


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
            with urllib.request.urlopen(req, timeout=240) as r:
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


def surface_of(tags):
    s = EXPLICIT.get(tags.get("surface"))
    if s:
        return s
    for (k, v), out in SURFACE:
        if tags.get(k) == v:
            return out
    return None


def ring_of(el):
    g = el.get("geometry")
    if not g or len(g) < 4:
        return None
    ring = [[round(p["lon"], 6), round(p["lat"], 6)] for p in g]
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring if len(ring) >= 4 else None


def signed_area(ring):
    """Shoelace, in degrees squared. Only the SIGN and the relative size are
    used, so no projection is needed — but it is not an area in m2 and must not
    be reported as one."""
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return a / 2.0


def main():
    refresh = "--refresh" in sys.argv

    q = ('[out:json][timeout:240];('
         'way["natural"~"water|wood|scrub|sand|beach|wetland"](%(b)s);'
         'way["landuse"~"grass|forest|cemetery|recreation_ground|village_green|'
         'reservoir|railway|industrial|construction|brownfield"](%(b)s);'
         'way["leisure"~"park|garden|pitch|nature_reserve|swimming_pool"](%(b)s);'
         'way["amenity"="parking"](%(b)s);'
         'way["highway"="pedestrian"][area=yes](%(b)s);'
         'way["place"="square"](%(b)s);'
         'way["waterway"="riverbank"](%(b)s);'
         'relation["natural"="water"](%(b)s);'
         'relation["leisure"="park"](%(b)s););out geom;' % {"b": BBOX})

    print("Fetching OSM ground surfaces for %s" % BBOX)
    d = cached("ground_osm", q, refresh)

    feats = []
    from collections import Counter
    kinds = Counter()
    skipped = 0
    for el in d.get("elements", []):
        tags = el.get("tags", {})
        s = surface_of(tags)
        if not s:
            skipped += 1
            continue
        if el.get("type") == "way":
            ring = ring_of(el)
            if not ring:
                continue
            rings = [ring]
        elif el.get("type") == "relation":
            # Multipolygon: outer rings only. Holes are dropped, and that is a
            # real simplification — a park with a lake in it paints grass under
            # the lake. It is invisible because the lake is drawn on top from
            # its own way, and carrying holes would need full ring assembly for
            # the six relations in this box that have any.
            rings = []
            for m in el.get("members", []):
                if m.get("role") not in ("outer", ""):
                    continue
                r = ring_of(m)
                if r:
                    rings.append(r)
            if not rings:
                continue
        else:
            continue

        for ring in rings:
            feats.append({
                "type": "Feature",
                "properties": {"k": "area", "s": s,
                               **({"name": tags["name"]} if tags.get("name") else {})},
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            })
            kinds[s] += 1

    # Biggest first. MapLibre draws a source's features in order, so a small
    # plaza inside a large park has to come AFTER the park or the park paints
    # over it. Sorting by descending magnitude is the whole fix and it is one
    # line; without it Klyde Warren's paving disappears under its own lawn.
    feats.sort(key=lambda f: -abs(signed_area(f["geometry"]["coordinates"][0])))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)

    kb = os.path.getsize(OUT) // 1024
    print("wrote data/ground.geojson  %d surfaces  (%d KB)" % (len(feats), kb))
    print("  " + ", ".join("%s=%d" % kv for kv in kinds.most_common()))
    print("  %d elements had no surface this renderer can paint (dropped)" % skipped)


if __name__ == "__main__":
    main()
