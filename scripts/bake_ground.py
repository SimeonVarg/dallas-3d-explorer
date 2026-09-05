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


# ── ROAD SURFACES ────────────────────────────────────────────────────────
#
# THE BUG THIS FIXES, and it is the largest single thing wrong with the render.
#
# js/ground.js draws the road network from THREE layers — ROAD_CASE, ROAD and
# CLOSE_ROAD — and all three filter on `k == 'roadarea'` against THIS file. The
# only layer that reads data/roads.geojson is ROAD_FAR, and that one is filtered
# to `far == 1`. Its own comment says so: "What is left on the line: the
# far-field armature only."
#
# So without roadarea polygons, EVERY NEAR-FIELD ROAD IN DOWNTOWN DALLAS IS NOT
# DRAWN. Not drawn thin, not drawn flat — not drawn. What reads as "the roads"
# in a frame is the far-field hairlines plus 526 asphalt parking lots, which is
# why the user's verdict was that the roads look horrible. They were looking at
# car parks.
#
# WHY POLYGONS AND NOT JUST A WIDER LINE. A MapLibre `line` is screen-space: it
# holds its pixel width regardless of pitch, so at pitch 74 a road running to the
# horizon stays the same width all the way and fans out instead of converging.
# A polygon is on the ground and obeys perspective. Austin's own note calls this
# out (scripts/verify/road-fan.mjs).
#
# ONE FEATURE PER (CLASS, SURFACE), NOT ONE PER ROAD. 4,711 near-field ways
# buffered individually is 4,711 polygons and about 8 MB. Unioned per drawn
# class it is a couple of dozen multipolygons and a tenth of that, and the
# rendering is identical because js/ground.js only ever branches on `c` and `s`.
# Everything else — name, lanes, oneway, the bike tags — is centreline business
# and stays in data/roads.geojson, which is untouched.
ROADAREA_ON = True
SIMPLIFY_M = 0.35        # ~1/3 of a lane line; below what the camera resolves


def widen_roads(near_only=True):
    """k:'road' LineStrings in data/roads.geojson -> k:'roadarea' Polygons."""
    if not ROADAREA_ON:
        return []
    src = os.path.join(ROOT, "data", "roads.geojson")
    if not os.path.exists(src):
        print("  [skip] data/roads.geojson not found — run bake_roads.py first")
        return []
    from shapely.geometry import LineString, mapping as _map
    from shapely.ops import unary_union, transform as _tf

    lat0 = 32.7820
    mlon = 111320.0 * math.cos(math.radians(lat0))
    mlat = 111132.0
    to_m = lambda x, y, z=None: ((x + 96.8010) * mlon, (y - lat0) * mlat)
    to_deg = lambda x, y, z=None: (x / mlon - 96.8010, y / mlat + lat0)

    with open(src, encoding="utf-8") as f:
        roads = json.load(f)["features"]

    groups = {}
    n_in = n_skip_far = n_skip_elev = 0
    for f in roads:
        p = f["properties"]
        if p.get("k") != "road" or f["geometry"]["type"] != "LineString":
            continue
        if near_only and p.get("far"):
            n_skip_far += 1
            continue
        # Elevated structure belongs to js/highways.js, which draws it as a deck
        # at its own height. Laying a ground-level slab under a viaduct as well
        # paints the freeway twice — once correctly in the air and once wrongly
        # on the dirt — and the ground copy is what you see through the gaps.
        if p.get("bridge") or (p.get("layer") or 0) > 0:
            n_skip_elev += 1
            continue
        coords = f["geometry"]["coordinates"]
        if len(coords) < 2:
            continue
        w = float(p.get("w") or 9.0)
        if w <= 0.2:
            continue
        try:
            line = LineString([to_m(*c) for c in coords])
            # Mitre joins here, unlike bake_highways.py's decks. A street grid
            # is straight lines meeting at right angles, so rounding the joins
            # buys nothing and costs a dozen vertices per junction across 4,700
            # ways. The decks curve; these do not.
            poly = line.buffer(w / 2.0, cap_style=2, join_style=2, mitre_limit=2.0)
        except Exception:       # noqa: BLE001 — one bad way is not fatal
            continue
        if poly.is_empty:
            continue
        groups.setdefault((p.get("c"), p.get("s")), []).append(poly)
        n_in += 1

    out = []
    for (cls, surf), polys in sorted(groups.items(), key=lambda kv: str(kv[0])):
        merged = unary_union(polys).simplify(SIMPLIFY_M, preserve_topology=True)
        if merged.is_empty:
            continue
        props = {"k": "roadarea", "s": surf or "asphalt"}
        if cls:
            props["c"] = cls
        out.append({"type": "Feature", "properties": props,
                    "geometry": _map(_tf(to_deg, merged))})
    print("  roadarea: %d ways -> %d merged surfaces "
          "(far left as line: %d, elevated left to highways.js: %d)"
          % (n_in, len(out), n_skip_far, n_skip_elev))
    return out


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
    #
    # Only the AREA features are sorted. The road surfaces appended below are
    # deliberately left at the end and in their own order: js/ground.js draws
    # them from separate layers (ROAD_CASE / ROAD / CLOSE_ROAD) that filter on
    # k=='roadarea', so their position among the k=='area' features never
    # decides what paints over what — the layer order does. Sorting them in by
    # size would only put a motorway behind a car park in the feature list and
    # change nothing on screen.
    feats.sort(key=lambda f: -abs(signed_area(f["geometry"]["coordinates"][0])))

    feats.extend(widen_roads())

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)

    kb = os.path.getsize(OUT) // 1024
    print("wrote data/ground.geojson  %d surfaces  (%d KB)" % (len(feats), kb))
    print("  " + ", ".join("%s=%d" % kv for kv in kinds.most_common()))
    print("  %d elements had no surface this renderer can paint (dropped)" % skipped)
    ra = sum(1 for f in feats if f["properties"]["k"] == "roadarea")
    print("  %d road surfaces (js/ground.js ROAD_CASE / ROAD / CLOSE_ROAD)" % ra)


if __name__ == "__main__":
    main()
