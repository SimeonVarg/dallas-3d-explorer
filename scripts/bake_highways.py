#!/usr/bin/env python3
"""bake_highways.py — the elevated highway network, as extrudable slabs.

THE PROBLEM THIS SOLVES, stated honestly.

Downtown Dallas is defined as much by its concrete as by its towers: the
Mixmaster where I-30 and I-35E cross in five levels, the elevated run of I-345
along the east side of downtown, and Woodall Rodgers with Klyde Warren Park
decked over the top of it. Drawn flat on the ground, as every road in this scene
was before this file existed, none of that exists. You get a wide grey ribbon
where a five-level stack should be.

The scene has NO TERRAIN. js/app.js:448 records that MapLibre terrain was turned
off deliberately in the Austin repo because it culled buildings, and this repo
inherits that. That turns out not to matter here, and the reason is worth
stating: Dallas's dramatic road geometry is not topography. It is STRUCTURE —
decks on piers, above a ground plane that really is close to flat. A deck at a
height is something this renderer can already draw. A hill is not.

WHAT OSM GIVES, AND WHAT IT DOES NOT.

`layer` is an ORDERING INTEGER, not a height. It says a way tagged layer=2
passes above one tagged layer=1; it does not say by how much, and nothing in
OSM does. So the heights below are DERIVED, and the derivation is the honest
part of this file:

    AASHTO minimum vertical clearance over a highway  16 ft 6 in   5.03 m
    typical highway bridge superstructure depth       6-8 ft       ~2.1 m
    ------------------------------------------------------------------
    one level of separation                                        ~7.1 m

DECK_M below is that figure, applied per level. It is a rule, not a measurement:
the real Mixmaster's top deck is about 30 m and this puts layer 4 at 28.4 m,
which is close, but that agreement is a check on the rule and not a survey. Any
individual deck here may be a couple of metres out. If a survey-accurate profile
is ever wanted it has to come from TxDOT bridge records, one structure at a
time, and DECK_M becomes a fallback rather than the source.

HOW THE RAMPS CURVE. A fill-extrusion has ONE base and ONE height per feature,
so a single polygon cannot slope. A ramp is therefore SEGMENTED: split into
short pieces, each flat, each one step higher than the last, with the step small
enough that the join is not visible at flying altitude. STEP_M is that budget.

The heights come from a node graph, not from the ramp's own tags — a ramp is
almost never tagged with anything that says where it ends up. Ways that share an
endpoint coordinate share a node; each node takes the height of the highest
elevated way that touches it; and each ramp then interpolates between its two
endpoint heights. That is what makes a ramp leave the ground at the ground and
arrive at the deck at the deck, without either height being written down
anywhere.

ONE GUARD, and it is load-bearing. Only LINKS and BRIDGES are allowed to leave
the ground. Without that rule, any surface street that happens to share a node
with a ramp gets lifted, and a downtown block ends up with one street climbing
seven metres for no reason. Ramps do the vertical work, which is also what they
do in the real world.

Inputs:   data/roads.geojson          (scripts/bake_roads.py)
Outputs:  data/highways.geojson       decks + piers, as extrudable polygons

Usage:  python scripts/bake_highways.py
"""
import json
import math
import os
from collections import defaultdict

from shapely.geometry import LineString, mapping
from shapely.ops import transform as shapely_transform

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IN = os.path.join(ROOT, "data", "roads.geojson")
OUT = os.path.join(ROOT, "data", "highways.geojson")

# Scene latitude — the anchor for the local metre frame. Must match
# SCENE_CENTER_LAT in scripts/config.sh.
LAT0 = 32.7820
LON0 = -96.8010

# One level of vertical separation. See the module docstring for the derivation.
DECK_M = 7.1
# A bridge tagged `bridge=yes` with NO `layer`. It is still above whatever it
# crosses, but there is no evidence for a full level, so it gets a low deck: a
# freeway flyover reads as elevated, a street bridge over a creek barely lifts.
BRIDGE_NO_LAYER = {"motorway": 6.2, "motorway_link": 6.2, "trunk": 5.4,
                   "trunk_link": 5.4, "primary": 3.2, "primary_link": 3.2}
BRIDGE_DEFAULT = 2.4
# Below this, a deck is not worth drawing as a separate structure — it is a kerb
# on a creek bridge, and drawing it puts a 1 m step in an otherwise flat street.
MIN_DECK_M = 2.0
# Vertical step budget per segment on a ramp. 1.1 m over a segment that is at
# least 12 m long is a gradient under 10%, which reads as a smooth climb rather
# than a staircase at any altitude the camera actually flies at.
STEP_M = 1.1
# Deck slab thickness — the visible depth of the structure under the road.
SLAB_M = 1.5

# Piers. Only under decks high enough that the gap beneath is legible.
PIER_MIN_H = 8.0
PIER_SPACING_M = 38.0
PIER_W = 2.2

LINKS = {"motorway_link", "trunk_link", "primary_link", "secondary_link",
         "tertiary_link"}


# ── local metre frame ────────────────────────────────────────────────────
_MPD_LAT = 111132.0
_MPD_LON = 111320.0 * math.cos(math.radians(LAT0))


def to_m(lon, lat):
    return ((lon - LON0) * _MPD_LON, (lat - LAT0) * _MPD_LAT)


def to_deg(x, y):
    return (LON0 + x / _MPD_LON, LAT0 + y / _MPD_LAT)


def deck_height(p):
    """The height this way's deck sits at, in metres above the ground plane."""
    if p.get("tunnel"):
        layer = p.get("layer", -1)
        return min(-2.5, layer * DECK_M) if layer else -2.5
    layer = p.get("layer")
    if layer and layer > 0:
        return layer * DECK_M
    if p.get("bridge"):
        return BRIDGE_NO_LAYER.get(p.get("c"), BRIDGE_DEFAULT)
    return 0.0


def main():
    with open(IN, encoding="utf-8") as f:
        roads = json.load(f)["features"]

    # ── 1. per-way deck height ───────────────────────────────────────────
    ways = []
    for f in roads:
        p = f["properties"]
        if f["geometry"]["type"] != "LineString":
            continue
        coords = f["geometry"]["coordinates"]
        if len(coords) < 2:
            continue
        ways.append({"p": p, "co": coords, "h": deck_height(p)})

    # ── 2. node heights ──────────────────────────────────────────────────
    # Ways share a node when they share an exact coordinate — OSM emits the
    # identical lon/lat for a shared node, and bake_roads.py rounds both to the
    # same 6 decimal places (~0.11 m), so an exact tuple match is safe here and
    # a distance tolerance is not needed.
    node_h = defaultdict(float)
    for w in ways:
        if w["h"] <= 0:
            continue
        for c in (w["co"][0], w["co"][-1]):
            k = (c[0], c[1])
            node_h[k] = max(node_h[k], w["h"])

    # ── 3. vertex heights per way ────────────────────────────────────────
    out = []
    n_deck = n_ramp = n_pier = 0
    for w in ways:
        p, coords = w["p"], w["co"]
        is_link = p.get("c") in LINKS
        elevated = w["h"] >= MIN_DECK_M

        if elevated:
            # A real deck: flat at its own height for its whole length.
            heights = [w["h"]] * len(coords)
        elif is_link:
            # A ramp: interpolate between whatever its two ends are attached to.
            h0 = node_h.get((coords[0][0], coords[0][1]), 0.0)
            h1 = node_h.get((coords[-1][0], coords[-1][1]), 0.0)
            if max(h0, h1) < MIN_DECK_M:
                continue                      # ramp between two ground roads
            heights = interp_along(coords, h0, h1)
            n_ramp += 1
        else:
            # THE GUARD. A surface street never leaves the ground, however many
            # elevated ways it touches.
            continue

        if elevated:
            n_deck += 1

        width = max(4.0, float(p.get("w", 7.0)))
        for seg, h in segment(coords, heights):
            poly = slab(seg, width)
            if poly is None:
                continue
            out.append({
                "type": "Feature",
                "properties": {
                    "k": "deck",
                    "c": p.get("c", "motorway"),
                    "b": round(max(0.0, h - SLAB_M), 2),
                    "h": round(h, 2),
                    "lk": 1 if is_link else 0,
                },
                "geometry": mapping(poly),
            })
            if h >= PIER_MIN_H:
                for pier in piers(seg, h):
                    out.append(pier)
                    n_pier += 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": out}, f)

    kb = os.path.getsize(OUT) // 1024
    decks = [f for f in out if f["properties"]["k"] == "deck"]
    hs = sorted(f["properties"]["h"] for f in decks)
    print("wrote data/highways.geojson  %d features  (%d KB)" % (len(out), kb))
    print("  source ways: %d decks, %d ramps" % (n_deck, n_ramp))
    print("  slabs: %d   piers: %d" % (len(decks), n_pier))
    if hs:
        print("  deck heights: min %.1f  median %.1f  max %.1f m"
              % (hs[0], hs[len(hs) // 2], hs[-1]))
        import collections
        band = collections.Counter(int(h // DECK_M) for h in hs)
        print("  by level: " + ", ".join(
            "L%d=%d" % (k, v) for k, v in sorted(band.items())))


def interp_along(coords, h0, h1):
    """Vertex heights blended along the way by CUMULATIVE DISTANCE.

    By vertex index was the first version and it is wrong on exactly the
    geometry this file exists for: a ramp is digitised with its vertices bunched
    in the curve and sparse on the straight, so an index blend does most of its
    climbing inside the bend and then runs level. Distance puts the gradient
    where the length is.
    """
    pts = [to_m(*c) for c in coords]
    d = [0.0]
    for i in range(1, len(pts)):
        d.append(d[-1] + math.hypot(pts[i][0] - pts[i - 1][0],
                                    pts[i][1] - pts[i - 1][1]))
    total = d[-1] or 1.0
    return [h0 + (h1 - h0) * (x / total) for x in d]


def segment(coords, heights):
    """Split into runs whose height varies by less than STEP_M.

    Yields (coords, height) with height the run's mean, so a ramp becomes a
    short flight of flat slabs and a deck stays one piece.
    """
    runs = []
    start = 0
    for i in range(1, len(coords)):
        lo = min(heights[start:i + 1])
        hi = max(heights[start:i + 1])
        if hi - lo > STEP_M:
            runs.append((coords[start:i + 1], sum(heights[start:i + 1]) / (i + 1 - start)))
            start = i
    runs.append((coords[start:], sum(heights[start:]) / max(1, len(coords) - start)))
    return [r for r in runs if len(r[0]) >= 2]


def slab(coords, width_m):
    """Buffer a line to a rectangle-ish deck polygon, in the local metre frame.

    Buffering in DEGREES was the first version and it produces a deck that is
    40% narrower north-south than east-west at this latitude, because a degree
    of longitude here is 93.6 km and a degree of latitude is 111.1 km. The
    error is invisible on a north-south road and obvious on a diagonal ramp,
    which is most of the Mixmaster.
    """
    pts = [to_m(*c) for c in coords]
    # Drop consecutive duplicates; shapely refuses a zero-length segment.
    ded = [pts[0]]
    for q in pts[1:]:
        if abs(q[0] - ded[-1][0]) > 1e-6 or abs(q[1] - ded[-1][1]) > 1e-6:
            ded.append(q)
    if len(ded) < 2:
        return None
    poly = LineString(ded).buffer(width_m / 2.0, cap_style=2, join_style=2)
    if poly.is_empty:
        return None
    return shapely_transform(lambda x, y, z=None: to_deg(x, y), poly)


def piers(coords, h):
    """Square columns under a deck, every PIER_SPACING_M along it."""
    pts = [to_m(*c) for c in coords]
    acc, out = 0.0, []
    for i in range(1, len(pts)):
        ax, ay = pts[i - 1]
        bx, by = pts[i]
        seg = math.hypot(bx - ax, by - ay)
        if seg <= 0:
            continue
        while acc + seg >= PIER_SPACING_M:
            need = PIER_SPACING_M - acc
            t = need / seg
            cx, cy = ax + (bx - ax) * t, ay + (by - ay) * t
            r = PIER_W / 2.0
            ring = [to_deg(cx - r, cy - r), to_deg(cx + r, cy - r),
                    to_deg(cx + r, cy + r), to_deg(cx - r, cy + r)]
            ring.append(ring[0])
            out.append({
                "type": "Feature",
                "properties": {"k": "pier", "b": 0.0, "h": round(h - SLAB_M, 2)},
                "geometry": {"type": "Polygon",
                             "coordinates": [[[round(x, 6), round(y, 6)] for x, y in ring]]},
            })
            ax, ay = cx, cy
            seg -= need
            acc = 0.0
        acc += seg
    return out


if __name__ == "__main__":
    main()
