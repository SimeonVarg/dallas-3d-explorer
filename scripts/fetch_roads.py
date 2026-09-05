# -*- coding: utf-8 -*-
"""Fetch the drivable + cyclable road network from OSM, with the tags the
basemap's vector tiles throw away.

WHY THIS EXISTS. Every road in the scene currently comes from the Liberty
basemap's OpenMapTiles `transportation` source-layer. That layer carries
`class`, `subclass`, `oneway`, `ramp` and `brunnel` and NOTHING ELSE. In
particular it carries:

  - no `lanes`            -> road width has to be guessed per class
  - no `cycleway*`        -> bike lanes cannot exist at all
  - no `name`             -> Speedway cannot be told from San Jacinto
  - no `surface`          -> Speedway's paving cannot be drawn

So the bike-lane ask is not implementable on top of the tiles. This asks OSM
directly, for the same area the outer ring covers (which is roughly what the
camera can see from 900 m), and caches it like every other survey in this repo.

Usage:  python scripts/fetch_roads.py [--refresh]
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter

# The outer-ring bbox, not the detailed one. The camera flies at 200-900 m and
# sees several km out; clipping roads to the 2.9 x 2.2 km detail bbox would end
# every arterial at a hard edge in mid-frame.
# DALLAS. The fence in js/controls.js, not the config bbox: the camera flies at
# 200-900 m and sees several km out, so clipping roads to the 3.3 x 3.1 km
# detail box would end every arterial at a hard edge in mid-frame. Order is
# Overpass's: south,west,north,east.
BBOX = "32.765,-96.821,32.803,-96.774"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "osm_cache")

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

QUERIES = {
    # Everything drivable. `_link` ramps included -- they are what makes an
    # interchange read as an interchange.
    "roads": '(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|'
             'unclassified|residential|living_street|service|road|busway|'
             'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]({b});)',
    # Separate cycle infrastructure: its own ways, not a tag on a road.
    # `path`/`footway` are included ONLY when they carry bicycle=designated,
    # which is how a shared-use trail is tagged here.
    "cycleways": '(way["highway"="cycleway"]({b});'
                 'way["highway"~"^(path|footway|pedestrian)$"]["bicycle"~"^(designated|yes)$"]({b});)',
}

# The FAR FIELD. Taking the roads off the basemap took them off the whole world,
# and the basemap had global coverage: a wide establishing shot used to show the
# grid running to the horizon and came back with the far third of the frame blank
# tan, reading as a city on a plate. That is a real regression and it is visible
# in shots/before-wide-day.png next to shots/roads-wide-day.png.
#
# The fix is proportionate rather than total: only the ARTERIAL ARMATURE, over a
# box about four times the outer ring. At 5+ km out a residential street is
# sub-pixel and contributes nothing; the motorways and the primaries are the
# whole read.
# The far ring: arterials and freeways that read on the horizon. Wide enough
# to carry I-30, I-35E, US-75 and I-345 well past the fence in every direction.
FAR_BBOX = "32.720,-96.900,32.860,-96.700"
FAR_QUERY = ('(way["highway"~"^(motorway|trunk|primary|secondary|'
             'motorway_link|trunk_link|primary_link)$"]({b});)')


def fetch(body, tries=8, bbox=BBOX):
    """Same politeness contract as survey_ground.fetch -- Overpass punishes loops."""
    q = "[out:json][timeout:180];%s;\nout body geom;" % body.format(b=bbox)
    payload = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt in range(tries):
        url = MIRRORS[attempt % len(MIRRORS)]
        try:
            req = urllib.request.Request(url, data=payload, headers={
                "User-Agent": "austin-3d-explorer/1.0 (educational low-poly map)"})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read().decode())
        except Exception as e:                                    # noqa: BLE001
            code = getattr(e, "code", None)
            last = "%s: %s" % (type(e).__name__, e)
            sys.stderr.write("  attempt %d (%s) failed: %s\n"
                             % (attempt + 1, url.split("/")[2], last))
            if attempt < tries - 1:
                time.sleep(45 if code == 429 else min(90, 10 * (attempt + 1)))
    raise RuntimeError("all attempts failed: %s" % last)


# The tags this pass actually reads. Printed as a histogram so the bake is
# written against what the data HAS, not against what the wiki says it might.
REPORT_KEYS = [
    "highway", "lanes", "oneway", "surface", "bicycle", "cycleway",
    "cycleway:left", "cycleway:right", "cycleway:both",
    "cycleway:left:lane", "cycleway:right:lane", "cycleway:both:lane",
    "cycleway:buffer", "cycleway:left:buffer", "cycleway:right:buffer",
    "bicycle:lanes", "segregated", "foot", "motor_vehicle", "access",
    "bridge", "tunnel", "layer", "width", "maxspeed", "service",
]


def main():
    refresh = "--refresh" in sys.argv
    os.makedirs(CACHE, exist_ok=True)
    todo = list(QUERIES.items()) + [("roads_far", FAR_QUERY)]
    for key, body in todo:
        path = os.path.join(CACHE, key + ".json")
        if os.path.exists(path) and not refresh:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            src = "cached"
        else:
            sys.stderr.write("fetching %s...\n" % key)
            data = fetch(body, bbox=FAR_BBOX if key == "roads_far" else BBOX)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"))
            src = "fetched"
            time.sleep(12)
        els = data.get("elements", [])
        print("\n%-10s %-8s %5d ways  (%.1f MB)"
              % (key, src, len(els), os.path.getsize(path) / 1048576))
        tally = {}
        for el in els:
            t = el.get("tags", {}) or {}
            for k in REPORT_KEYS:
                if k in t:
                    tally.setdefault(k, Counter())[t[k]] += 1
        for k in REPORT_KEYS:
            if k not in tally:
                continue
            top = tally[k].most_common(12)
            n = sum(tally[k].values())
            print("    %-22s n=%-5d %s" % (k, n, ", ".join("%s=%d" % (v, c) for v, c in top)))


if __name__ == "__main__":
    main()
