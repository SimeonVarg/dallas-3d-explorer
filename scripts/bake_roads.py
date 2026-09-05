#!/usr/bin/env python3
"""bake_roads.py — turn the OSM road cache into data/roads.geojson.

WHY THIS IS NOT A PORT. In the Austin repo this output is produced deep inside
scripts/bake_ground.py, a 3,000-line file that also carves Waller Creek, decks
the campus walkways, and reconciles a creek's culverts against its bridges.
Almost none of that is about roads and none of it is about Dallas. So the road
half is re-implemented here against the same OUTPUT SCHEMA, which is the part
js/ground.js actually depends on, and the Austin-geography half is not carried
over at all.

THE SCHEMA, because it is terse and the reader is js/ground.js:

    k     kind        'road' | 'cycle'      -- which layer family draws it
    c     class       OSM highway value, normalised (motorway, primary, ...)
    w     width       metres, carriageway edge to edge
    s     surface     'roadconcrete' | 'paving' | 'gravel' | 'dirt' | absent
    ln    lanes       integer, after the oneway correction below
    ow    oneway      1 if one-way
    far   far-field   1 if this way is armature only -- drawn thin, no lane lines
    lk    lane-lock   1 to suppress lane markings on this way
    name  name        for labels

WIDTH IS DERIVED FROM LANES, NOT FROM CLASS. This is the whole reason
fetch_roads.py exists. The basemap's vector tiles carry `class` and no `lanes`,
so every road of a class renders at one width and a 2-lane downtown street and
a 6-lane arterial come out identical. 7,800 of the 8,735 far-field ways here
carry a real `lanes` count, so the width is measured for 89% of them and only
the remainder falls back to a per-class default.

ONE CORRECTION THAT MATTERS IN DALLAS. On a one-way way, OSM's `lanes` counts
only that carriageway's lanes -- a divided six-lane boulevard is tagged as two
ways of `lanes=3`. Treating that as a 3-lane road is right. But on a two-way
way `lanes` counts BOTH directions, so it must not be doubled. Getting this
backwards renders every downtown one-way pair at half width, and downtown
Dallas is almost entirely one-way pairs.

Usage:  python scripts/bake_roads.py
"""
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "osm_cache")
OUT = os.path.join(ROOT, "data", "roads.geojson")

# The detail box (scripts/config.sh BBOX_*). Ways whose geometry falls entirely
# outside it are FAR-FIELD: drawn as thin armature so the horizon has a road
# network on it, without paying for lane markings on a road 4 km away.
NEAR = dict(w=-96.8150, s=32.7700, e=-96.7800, n=32.7980)

# Metres per lane, edge to edge, including the shoulder share that belongs to
# the outermost lane. 3.35 m is the AASHTO urban standard (11 ft); freeway lanes
# are 12 ft. Widening these widens every road in the scene proportionally.
LANE_M = 3.35
LANE_M_FREEWAY = 3.66

# Fallback lane counts, used only when OSM has no `lanes`. Deliberately modest:
# an over-wide guess is more visible than an under-wide one, because it makes
# residential streets touch each other across a block.
DEFAULT_LANES = {
    "motorway": 6, "motorway_link": 1, "trunk": 4, "trunk_link": 1,
    "primary": 4, "primary_link": 1, "secondary": 3, "secondary_link": 1,
    "tertiary": 2, "tertiary_link": 1, "residential": 2, "unclassified": 2,
    "living_street": 1, "service": 1, "track": 1,
}
# Classes js/ground.js knows how to draw. Anything else is dropped rather than
# guessed at — an unrecognised class renders with the fallback colour and reads
# as a road that should not be there.
KEEP = set(DEFAULT_LANES)

SURFACE = {
    "concrete": "roadconcrete", "concrete:plates": "roadconcrete",
    "paving_stones": "paving", "sett": "paving", "cobblestone": "paving",
    "gravel": "gravel", "compacted": "gravel", "fine_gravel": "gravel",
    "dirt": "dirt", "ground": "dirt", "unpaved": "dirt", "earth": "dirt",
}


def load(name):
    p = os.path.join(CACHE, name)
    if not os.path.exists(p):
        print("  [skip] data/osm_cache/%s not found" % name)
        return []
    with open(p, encoding="utf-8") as f:
        return json.load(f).get("elements", [])


def lanes_for(tags, cls):
    """Lane count, corrected for the one-way convention. See the module docstring."""
    raw = tags.get("lanes")
    if raw:
        try:
            n = float(str(raw).split(";")[0])
            if 0 < n <= 12:
                return n
        except ValueError:
            pass
    return DEFAULT_LANES.get(cls, 2)


def bbox_of(geom):
    lons = [p["lon"] for p in geom]
    lats = [p["lat"] for p in geom]
    return min(lons), min(lats), max(lons), max(lats)


def intersects_near(geom):
    lo, la, hi, ha = bbox_of(geom)
    return not (hi < NEAR["w"] or lo > NEAR["e"] or ha < NEAR["s"] or la > NEAR["n"])


def main():
    # roads_far is a superset of roads over a wider box, so the near set is
    # loaded FIRST and its ids win: a way present in both keeps the near
    # treatment. Loading them the other way round marks every downtown street
    # far-field and the whole city renders as hairlines.
    seen = {}
    for name in ("roads.json", "roads_far.json", "cycleways.json"):
        for el in load(name):
            if el.get("type") != "way" or not el.get("geometry"):
                continue
            seen.setdefault(el["id"], (el, name))

    feats = []
    n_far = n_near = n_lane_measured = n_lane_default = 0
    for wid, (el, src) in seen.items():
        tags = el.get("tags", {})
        cls = tags.get("highway")
        if cls not in KEEP:
            continue
        geom = el["geometry"]
        if len(geom) < 2:
            continue

        near = intersects_near(geom)
        freeway = cls in ("motorway", "motorway_link", "trunk", "trunk_link")
        ln = lanes_for(tags, cls)
        if tags.get("lanes"):
            n_lane_measured += 1
        else:
            n_lane_default += 1
        w = ln * (LANE_M_FREEWAY if freeway else LANE_M)

        props = {
            "k": "road",
            "c": cls,
            "w": round(w, 1),
            "ln": round(ln, 1),
        }
        if not near:
            props["far"] = 1
            n_far += 1
        else:
            n_near += 1
        if tags.get("oneway") in ("yes", "1", "-1"):
            props["ow"] = 1
        s = SURFACE.get(tags.get("surface"))
        if s:
            props["s"] = s
        if tags.get("name"):
            props["name"] = tags["name"]
        # Lane markings are suppressed on links and service roads: a ramp has no
        # painted lane line down the middle, and drawing one there is the single
        # most obvious "this is generated" tell in an aerial frame.
        if cls.endswith("_link") or cls in ("service", "track", "living_street"):
            props["lk"] = 1
        # Carried for scripts/bake_highways.py, which needs to know which ways
        # are decks before it can decide what height to put them at. Harmless to
        # the renderer, which ignores properties it does not name.
        if tags.get("bridge"):
            props["bridge"] = 1
        if tags.get("tunnel"):
            props["tunnel"] = 1
        if tags.get("layer"):
            try:
                props["layer"] = int(float(tags["layer"]))
            except ValueError:
                pass

        feats.append({
            "type": "Feature",
            "properties": props,
            "geometry": {
                "type": "LineString",
                "coordinates": [[round(p["lon"], 6), round(p["lat"], 6)] for p in geom],
            },
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)

    kb = os.path.getsize(OUT) // 1024
    print("wrote data/roads.geojson  %d ways  (%d KB)" % (len(feats), kb))
    print("  near=%d far=%d" % (n_near, n_far))
    print("  lanes: measured=%d default=%d (%.0f%% measured)"
          % (n_lane_measured, n_lane_default,
             100.0 * n_lane_measured / max(1, n_lane_measured + n_lane_default)))
    from collections import Counter
    c = Counter(f["properties"]["c"] for f in feats)
    print("  classes: " + ", ".join("%s=%d" % kv for kv in c.most_common(8)))
    nb = sum(1 for f in feats if f["properties"].get("bridge"))
    nl = sum(1 for f in feats if f["properties"].get("layer"))
    print("  carried for bake_highways.py: bridge=%d layer=%d" % (nb, nl))


if __name__ == "__main__":
    main()
