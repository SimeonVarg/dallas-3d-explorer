# -*- coding: utf-8 -*-
"""bake_roofs.py — the nadir survey, the pitched roofs, and the parapet caps.

THE PROBLEM, MEASURED. This repo shipped with NO roof data at all. All four of
the files the front end asks for 404 on every load:

    data/roofs.geojson  data/roofscape.geojson
    data/roofscape.detail.geojson  data/roof_survey.json

The layers are there and correct — `roofs-pitched` in js/app.js and
`roofscape-deck` / `-major` / `-minor` in js/roofs.js all exist in the style at
runtime, with their sources attached — they were simply being handed nothing.
So all 2,220 buildings render as bare flat prisms whose top face is `rd`, which
bake_detail.py derives as the building's own wall 12% darker. From the air, and
this app is a flyover, that is a field of brown lids. Screenshotted before this
pass at zoom 16.9 over Pacific Place: eight mid-rise blocks, every one of them a
featureless grey-brown quad, and the roofs were the largest surfaces in frame.

WHAT THIS FILE DOES, AND WHY IT IS THE ONE THAT TOUCHES THE IMAGERY. Two bakes
need the same nadir photograph — this one for pitch, bake_roofscape.py for deck
colour and rooftop plant — so the tile cache, the sampler and the per-building
SURVEY live here and bake_roofscape.py imports them. Austin's pair duplicated
the geometry helpers into both files with a note that importing was impossible
because the other file "is a script with a main()"; it is not, both have the
`__main__` guard, and the copies had already drifted (two `inset()`s, one of
which had the degenerate-ring check the other lacked).

DALLAS IS NOT AUSTIN, and three things changed because of it:

  1. Z IS 20, NOT 19. Austin ran pitch detection off z19 and the roofscape off
     z20, so the cache held both. 6,630 z20 tiles cover every footprint in this
     bbox; adding z19 would have been 1,981 more downloads for a second copy of
     the same photograph at half the resolution. z20 at 32.78 N is 0.126 m/px.

  2. THE PITCH TEST IS NOT A COLOUR TEST, and in the end it is not a per-roof
     measurement at all. Austin asked "what fraction of this offset ring reads
     TERRACOTTA?", because UT's hips are Spanish clay tile. Downtown Dallas has
     essentially none. What it has is 604 houses and townhomes in State-Thomas
     and the near-north, roofed in asphalt shingle — grey-brown, low saturation,
     the same family of colours as the street beside them. A hue test cannot see
     that, and neither, it turns out, can the obvious replacement. See WHICH
     BUILDINGS GET A PITCH below for what was tried, what the numbers said, and
     what is shipped instead.

  3. TOWER SHADOW IS THE OBVIOUS DALLAS PROBLEM AND IT DID NOT NEED FIXING.
     Austin's tallest building is 94 m; Bank of America Plaza is 280.7 m and
     eleven more here clear 150 m, so a lot of this low-rise is photographed in
     something's shade. The standard blue-cast correction was written and then
     deleted, because the survey says this imagery has no blue cast to correct.
     See "Tower shadow, and the correction that was NOT needed".

  4. THE CAP COLOUR IS DERIVED HERE, NOT READ BACK FROM THE OTHER BAKE. Austin's
     bake_roofs.py opens data/roofscape.geojson to copy each deck's colour into
     its `caps` table, which makes the two bakes order-dependent: roofscape must
     run first or the caps are stale, and nothing enforces it. Both files now
     call the same `deck_colour()` on the same survey row, so they cannot
     disagree and can run in either order.

WHAT IS FACTUAL AND WHAT IS NOT (the same contract bake_roofscape.py states):

    MEASURED    which buildings are pitched, the deck colour of every building,
                the position/size/orientation/colour of every rooftop unit.
    GENERATIVE  the SHAPE of a pitch (stepped inset facets), its PITCH ANGLE,
                and the height of any rooftop object — a nadir photo cannot
                measure height, and it cannot see the underside of an eave.

Usage:
    python scripts/bake_roofs.py --fetch        # fill data/imagery_cache (~6,630 tiles, 70 MB)
    python scripts/bake_roofs.py --remeasure    # re-read the imagery into data/roof_survey.json
    python scripts/bake_roofs.py                # geometry only, from the cached survey
    python scripts/bake_roofs.py --report       # ...and print what was found
    python scripts/bake_roofs.py --calibrate    # score the slope-split test against OSM roof:shape
    python scripts/bake_roofs.py --refresh-osm  # re-pull the roof:* tags from Overpass
"""
import io
import json
import math
import os
import sys
import threading
import urllib.request
from collections import Counter, OrderedDict
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPDIR = os.path.join(ROOT, "data", "snapshots")
TILES = os.path.join(ROOT, "data", "imagery_cache")
SURVEY = os.path.join(ROOT, "data", "roof_survey.json")
OUT = os.path.join(ROOT, "data", "roofs.geojson")
ROOF_TAGS = os.path.join(ROOT, "data", "osm_cache", "roof_tags.json")

ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
# Overpass returns 406, not 429, to a request with no User-Agent, and the Esri
# tile server returns an HTML error page. Both are silent failures that look
# like "the bbox has no data". Same string scripts/bake_ground.py uses.
UA = "dallas-3d-explorer/1.0 (+https://github.com/SimeonVarg/dallas-3d-explorer)"

Z = 20
M_LAT = 111320.0
RES_M = 0.13          # z20 at 32.78 N is 0.126 m/px; sample at native resolution
RES_BIG = 0.26        # ...except on the roofs over BIG_M2, where it is 4x the grid
BIG_M2 = 8000.0

MIN_H = 3.0           # a 2 m shed has no roofscape
MIN_AREA = 60.0       # below this the deck is smaller than the parapet inset
PARAPET_IN = 1.1      # the deck sits this far inside the wall, so the cap reads as a rim
MIN_SAMPLES = 40      # fewer pixels than this and the median is not a measurement

# Building classes that are not a roof at all. `roof` in Overture is an open
# canopy — a gas-station forecourt, a bus shelter, a stadium concourse cover —
# and `carport` is the same thing over a driveway. 59 of them here. Giving one a
# membrane deck and a condenser bank puts rooftop plant on a structure that has
# no roof surface, which is worse than leaving it alone.
NO_ROOF_CLASSES = {"roof", "carport"}

# ── The five hand-built towers own their own roofs ────────────────────
# js/heroes-dallas.js replaces these five with authored massing and hides the
# snapshot original by NAME FILTER on `buildings-3d` / `buildings-roof`. The
# roofscape layers are a different source with no such filter, so a deck baked
# from the snapshot footprint would hang in the air over the hero: Bank of
# America Plaza's snapshot footprint is the 56x64 m podium and its authored
# crown at 280.7 m is a 22x28 m chamfer, so the deck would be a slab three
# times the crown's width floating at the tip of the tower. Read from the
# heroes file rather than retyped, so adding a sixth hero cannot silently
# reintroduce this.
def hero_names():
    p = os.path.join(ROOT, "js", "heroes-dallas.js")
    try:
        src = open(p, encoding="utf-8").read()
    except Exception:
        return set()
    import re
    return set(re.findall(r"^\s*name:\s*'([^']+)',\s*$", src, re.M))


# ── WHICH BUILDINGS GET A PITCH ───────────────────────────────────────
#
# WHAT WAS TRIED FIRST AND FAILED, because it is the obvious idea and someone
# will try it again. A gable photographed from directly above is two rectangles
# meeting at a ridge: one faces the sun and one faces away, so the luma should
# step ACROSS the ridge and not ALONG it. The survey measures exactly that (`sp`
# in data/roof_survey.json — the split is still recorded, it is just not used)
# and `--calibrate` scores it against the 66 OSM ways in this bbox that carry
# `roof:shape`:
#
#     shape       n   across   along   across-along
#     flat       54    0.376   0.227        0.149
#     gabled      5    0.277   0.223        0.054
#     hipped      2    0.661   0.094        0.567
#     skillion    2    0.392   0.298        0.093
#
# The tagged FLAT roofs split harder than the tagged gables. Of course they do:
# they are big downtown roofs covered in equipment and cut across by the shadow
# of the next tower, while the shingle roofs are small and photographed under
# haze. The signal is real on the two hipped roofs and swamped everywhere else,
# and a threshold fitted to it selected 329 buildings essentially at random.
#
# WHAT ACTUALLY WORKS is not a per-roof measurement at all, and it is stated as
# a rule rather than dressed up as one. Downtown Dallas has two kinds of small
# residential building and they are different eras:
#
#   * the traditional house and townhome — median footprint 155 m2, 8-11 m tall,
#     asphalt shingle, hipped or gabled;
#   * the 2010s urban townhome stack — 70 m2, 12.8 m tall, FLAT white membrane
#     with a roof deck on it.
#
# `height / sqrt(footprint)` separates them cleanly and is bimodal over the 604
# residential buildings here: 496 below 1.15, 108 above, with the trough almost
# empty. Every one of the 44 OSM ways tagged `roof:shape=flat` on a `house` in
# this box sits in the upper mode (median 12.8 m over 73 m2, ratio 1.50), and a
# 24-crop contact sheet of each mode read off the nadir imagery is unambiguous:
# the lower mode is shingle hips and gables, the upper is parapets and decks.
#
# So: the SELECTION is a rule validated against 44 tagged buildings and 48
# inspected crops. The roof's COLOUR, and the eave-to-ridge span it is drawn
# over, are measured per building. That distinction is the honest one.
PITCH_CLASSES = {"house", "terrace", "semidetached_house", "detached"}
PITCH_RATIO_MAX = 1.15    # height / sqrt(area); see the bimodal split above
PITCH_MAX_AREA = 900.0
PITCH_MAX_H = 20.0
PITCH_MIN_AREA = 45.0
# ...and one veto that IS a measurement. A roof the photograph reads as
# brilliant white is single-ply membrane, not asphalt shingle, whatever the
# footprint ratio says. 48 of the 496 candidates measure over 190 luma and this
# throws out the top of that tail; asphalt shingle in this imagery runs 85-190
# (p10-p90 over the candidates, median 124).
PITCH_MAX_LUMA = 205.0

# OSM `roof:shape` values that mean "not flat". These override the split test in
# BOTH directions — a tagged `flat` is never given a pitch no matter what the
# photograph's shadows say, and a tagged `gabled` is always given one.
OSM_PITCHED = {"gabled", "hipped", "half-hipped", "pyramidal", "gambrel",
               "mansard", "round", "dome", "cone", "skillion", "saltbox",
               "hip-and-gable", "double_saltbox"}
OSM_GABLED = {"gabled", "half-hipped", "gambrel", "saltbox", "double_saltbox"}

# ── the shape (generative, and labelled as such) ──────────────────────
# A pitch is approximated by STEPPED INSET FACETS: the footprint offset inward
# in equal steps, each sitting higher than the last. From flying altitude the
# steps read as a slope; from the street they read as steps, and that is stated
# rather than hidden.
#
# PITCH is 0.50 — 6:12, 26.6 deg. Austin used 0.42 (5:12) because Spanish clay
# tile sits at the bottom of its allowed range. These are asphalt shingle on
# 1990s-2010s Dallas townhomes, where 6:12 to 8:12 is the norm and 4:12 is the
# code minimum for shingle. Picking the bottom of the range would have made
# every one of these read as a very shallow hip, which is the shape that looks
# most like the flat prism it is replacing.
PITCH = 0.50
RISE_MAX = 6.5        # a townhome's roof, not a steeple
# Aim for a step about this deep — more steps is a smoother slope and a bigger
# file, and this one is fetched in loadScene's Promise.all so it is on the
# critical path. A 155 m2 townhome has a ~6 m run, so 1.4 m gives four steps and
# 1.9 gives three: 8,586 facets / 2.70 MB against 6,284 / 2.02 MB, for a
# difference that is under a pixel at the altitude these are seen from. The
# extra step is worth having on a bigger roof, which is what STEPS_MAX is for.
STEP_TARGET_M = 1.9
STEPS_MIN, STEPS_MAX = 2, 5
EAVE_OUT_M = 0.4      # roofs overhang their walls; so does this one
SIMPLIFY_M = 0.9      # wall jogs smaller than this are not roof features

# ── Facet shading: the two ends of each slope's range ─────────────────
#
# `fill-extrusion` tops are always horizontal, so MapLibre shades every tread of
# a stepped hip identically and the roof comes back reading as a flat plane with
# rings drawn on it. Each facet therefore carries `az` — the compass direction
# its slope faces — plus the two ends of its own shade range, and
# js/timeofday.js's roofFacetColor() picks the point between them from the LIVE
# sun. Baking the tint into rd/rg/rn at the three fixed hours was tried in the
# Austin build and cannot work: bakedColor LERPS those three, and a morning sun
# at az 98 averaged against a golden one at az 256 lands on flat grey at p=0.25.
#
# THESE THREE MUST MATCH `ROOF_SHADE` IN js/timeofday.js. `lit/flat` there runs
# from SHADE_LO to SHADE_HI, and a facet lying flat sits at 1.0 — so shipping
# `rd * SHADE_HI` as the bright end and `rd * SHADE_LO` as the dark end makes a
# flat facet render at exactly the measured `rd`, and the slopes spread either
# side of it. Austin shipped the measured value AS the bright end, which renders
# a hip 22% darker than the colour that was measured off it; here `rd` is a
# measured mean of both slopes, so it has to land in the middle.
SHADE_LO, SHADE_HI = 0.70, 1.28
SHADE_TILT = 38.0     # ...and the shading is done as though the slope were this
                      # steep. The geometry stays at the real 6:12 or the
                      # townhomes grow spires, but at 26.6 deg under a 55 deg sun
                      # the four slopes of a hip differ by about 20%, which is
                      # too little for the hip lines to read from the air. The
                      # one deliberately non-physical number in this file.

# ── Deck colour: the photograph, brought into this scene's exposure ───
#
# Both this file and bake_roofscape.py paint from `deck_colour()` below — the
# parapet cap and the membrane inside it are the same surface and must be the
# same colour, which is the whole point of the `caps` table.
#
# SRC_LO/SRC_HI is what the PHOTOGRAPH spans and DST_LO/DST_HI is what this
# SCENE spans; the map between them preserves order and spread, and clamps at
# both ends. Both measured over the 2,014 surveyed roofs rather than copied
# from Austin, and they had to be:
#
#   photograph  luma p10 = 91, p50 = 147, p90 = 252, p95 = 254. That top end is
#               CLIPPED, not bright: over a tenth of downtown Dallas's roofs are
#               white single-ply membrane and the sensor blew them out. Austin's
#               numbers were 112..250 for the same percentiles, so this city
#               photographs both darker in the middle and harder at the top.
#   scene       building `rd` luma p5..p95 = 79 .. 137, walls 130 .. 204,
#               ground concrete 217. A roof may go brighter than the roofs
#               already in the scene — real membrane is bright — but must not
#               out-shine the pavement, or the city reads as lit from below.
#
# SRC_LO sits at the photograph's p10 rather than its p5 on purpose: see the
# shadow note below.
SRC_LO, SRC_HI = 85.0, 250.0
DST_LO, DST_HI = 76.0, 190.0
DECK_DESAT = 0.25     # a nadir photo is more colourful than this scene
DECK_TOWARD = 0.04    # a trace of the building's own roof, so it belongs to it
# ...and entered COOL to land neutral: an extrusion's TOP face picks up the sun
# tint, so it renders warmer than the value typed here. Same correction, and the
# same reason, as the seating deck in Austin's bake_stadium.py.
DECK_COOL = 0.10
# ── ...and NO ROOF IS GREEN ───────────────────────────────────────────
# The first bake put a field of dark olive-green lids over the Plaza of the
# Americas block, and the imagery is where they came from. Over the 2,014
# surveyed roofs the channel means are R 163.4, G 164.9, B 146.8 — near-neutral.
# Over the DARKEST 15% they are R 73.2, G 83.1, B 68.3: green sits 10 levels
# above the mean of the other two. Deep shade in this imagery is green, from
# overhanging canopy, JPEG chroma at low luma, or both.
#
# So this is not a global white balance — a global gain of 0.94 on G would tint
# the 85% of roofs that are already neutral to fix the 15% that are not. It is a
# MATERIAL CONSTRAINT stated as one: nothing a roof is made of is green, so a
# measured colour may sit at most GREEN_CAP above the mean of its red and blue.
# Roofs that are only slightly green keep their difference; the olive ones lose
# the cast and keep their luma, which is the part that was measured well.
GREEN_CAP = 4.0
# Which pixels count as "the deck". A straight median measures whatever shadow
# falls across the roof; a straight max measures a specular hot spot. The median
# of the 55th-90th luma percentile band excludes both by construction.
LUMA_LO_PCT, LUMA_HI_PCT = 55, 90

# ── Tower shadow, and the correction that was NOT needed ──────────────
#
# The Dallas-specific worry, and the one that would have justified a whole
# machinery: Austin's tallest building is 94 m, Bank of America Plaza is 280.7 m
# and eleven more here clear 150 m, so a lot of this bbox's low-rise is
# photographed inside something's shadow. The standard fix is to detect a
# shadowed surface as one that is both DARK and BLUE — a shaded surface is lit
# by the sky, not the sun, so it loses its warmth — and lift it back.
#
# THAT PREMISE IS FALSE FOR THIS IMAGERY, and the survey says so. Over 2,014
# roofs the median B-R is -15, i.e. Esri's World Imagery is colour-processed
# warm throughout and shadows do not come back blue: only 21 roofs in the whole
# box have B-R above +12, and only 8 are both that blue and below 78 luma. A
# lift keyed on it would have fired on eight buildings, which is not a
# correction, it is noise with a constant attached.
#
# What the darkness costs is instead handled by where SRC_LO sits. 129 roofs
# measure below 74 luma; putting SRC_LO at the photograph's p10 (85) rather than
# its p5 clamps all of them to DST_LO together, so a roof in deep shade renders
# as a dark roof rather than as a black hole, and no roof is invented brighter
# than the photograph. If the imagery is ever re-fetched from a source that does
# preserve the blue cast, this is the paragraph to reopen.

# ── tiles ─────────────────────────────────────────────────────────────
_cache = OrderedDict()
_CACHE_MAX = 320          # 320 * 256*256*3 = 63 MB; the whole set would be 1.3 GB


def tile_xy_f(lon, lat, z=Z):
    n = 2.0 ** z
    return ((lon + 180.0) / 360.0 * n,
            (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)


def tile(xt, yt):
    k = (xt, yt)
    if k in _cache:
        _cache.move_to_end(k)
        return _cache[k]
    p = os.path.join(TILES, "%d_%d_%d.jpg" % (Z, xt, yt))
    a = np.asarray(Image.open(p).convert("RGB")) if os.path.exists(p) else None
    _cache[k] = a
    if len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)
    return a


def sample(lons, lats):
    """Vectorised nadir sample. Returns (RGB uint8 array, ok mask)."""
    n = 2.0 ** Z
    xf = (lons + 180.0) / 360.0 * n
    yf = (1.0 - np.arcsinh(np.tan(np.radians(lats))) / np.pi) / 2.0 * n
    xt = np.floor(xf).astype(np.int64)
    yt = np.floor(yf).astype(np.int64)
    px = np.clip(((xf - xt) * 256).astype(np.int64), 0, 255)
    py = np.clip(((yf - yt) * 256).astype(np.int64), 0, 255)
    out = np.zeros(lons.shape + (3,), np.uint8)
    ok = np.zeros(lons.shape, bool)
    # np.unique on a packed key rather than set(zip(...tolist())): the latter
    # builds millions of Python ints for one large roof and looks like a hang.
    key = xt.astype(np.int64) * (1 << 22) + yt.astype(np.int64)
    for k in np.unique(key):
        a = int(k >> 22); b = int(k & ((1 << 22) - 1))
        arr = tile(a, b)
        if arr is None:
            continue
        m = key == k
        out[m] = arr[py[m], px[m]]
        ok[m] = True
    return out, ok


def snapshot_path():
    date = sorted(d for d in os.listdir(SNAPDIR)
                  if os.path.isdir(os.path.join(SNAPDIR, d)))[-1]
    return date, os.path.join(SNAPDIR, date, "buildings.detailed.geojson")


def fetch_imagery(workers=12):
    """Fill the cache with exactly the tiles this bbox's footprints cover.

    Derived from the footprints, not from the bbox corners: the bbox is 3.3 x
    3.1 km, which is 11,900 z20 tiles, and only 6,630 of them have a building
    on them. The rest would be download and disk for pixels no bake reads.
    """
    _, snap = snapshot_path()
    need = set()
    for f in json.load(open(snap, encoding="utf-8"))["features"]:
        if (f["properties"].get("final_height") or 0) < MIN_H:
            continue
        g = f["geometry"]
        rings = ([g["coordinates"][0]] if g["type"] == "Polygon"
                 else [p[0] for p in g["coordinates"]])
        for r in rings:
            lons = [p[0] for p in r]; lats = [p[1] for p in r]
            x0, y0 = tile_xy_f(min(lons), max(lats))
            x1, y1 = tile_xy_f(max(lons), min(lats))
            for xt in range(int(x0), int(x1) + 1):
                for yt in range(int(y0), int(y1) + 1):
                    need.add((xt, yt))

    os.makedirs(TILES, exist_ok=True)
    todo = [t for t in sorted(need)
            if not os.path.exists(os.path.join(TILES, "%d_%d_%d.jpg" % (Z, t[0], t[1])))]
    print("z%d tiles needed %d, cached %d, fetching %d"
          % (Z, len(need), len(need) - len(todo), len(todo)), flush=True)
    lock = threading.Lock()
    st = {"ok": 0, "fail": 0}

    def get(t):
        xt, yt = t
        path = os.path.join(TILES, "%d_%d_%d.jpg" % (Z, xt, yt))
        for _ in range(3):
            try:
                req = urllib.request.Request(ESRI.format(z=Z, y=yt, x=xt),
                                             headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=30) as r:
                    body = r.read()
                # An error page is HTML and small; a real z20 tile is 5-30 KB.
                if len(body) > 500:
                    Image.open(io.BytesIO(body)).convert("RGB").save(path, quality=92)
                    with lock:
                        st["ok"] += 1
                        n = st["ok"] + st["fail"]
                    if n % 500 == 0:
                        print("  %d/%d" % (n, len(todo)), flush=True)
                    return
            except Exception:
                pass
        with lock:
            st["fail"] += 1

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(get, todo))
    print(json.dumps({"fetched": st["ok"], "failed": st["fail"]}))


# ── geometry ──────────────────────────────────────────────────────────
def to_m(ring, lat0):
    k = math.cos(math.radians(lat0))
    return [(p[0] * M_LAT * k, p[1] * M_LAT) for p in ring]


def to_ll(pts, lat0):
    k = math.cos(math.radians(lat0))
    return [[round(x / (M_LAT * k), 6), round(y / M_LAT, 6)] for (x, y) in pts]


def signed_area(pts):
    a = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        a += x0 * y1 - x1 * y0
    return a * 0.5


def clean(pts):
    p = pts[:-1] if pts and pts[0] == pts[-1] else pts[:]
    out = []
    for q in p:
        if not out or math.hypot(q[0] - out[-1][0], q[1] - out[-1][1]) > 0.05:
            out.append(q)
    if len(out) > 2 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= 0.05:
        out.pop()
    return out


def ccw(pts):
    p = pts[:-1] if pts and pts[0] == pts[-1] else pts[:]
    return p if signed_area(p + [p[0]]) >= 0 else p[::-1]


def simplify(pts, tol):
    """Drop vertices whose removal moves the ring by less than tol.

    A jog smaller than a metre is a survey artefact in the footprint, not a
    feature of the roof, and every one of them becomes an extra facet quad on
    every step of a pitch — 588 houses x 5 steps is where the byte count goes.
    """
    p = pts[:]
    changed = True
    while changed and len(p) > 4:
        changed = False
        for i in range(len(p)):
            a, b, c = p[i - 1], p[i], p[(i + 1) % len(p)]
            dx, dy = c[0] - a[0], c[1] - a[1]
            L = math.hypot(dx, dy)
            if L < 1e-9:
                continue
            d = abs((b[0] - a[0]) * dy - (b[1] - a[1]) * dx) / L
            if d < tol:
                p.pop(i)
                changed = True
                break
    return p


def inset(pts, d, ridge=None):
    """Offset a closed ring inward by d metres. None when it degenerates.

    `ridge`, when given, is an azimuth in radians and makes the offset
    DIRECTIONAL: each edge moves inward by `d * |cos(edge - ridge)|`, so edges
    that run along the ridge move the full distance and edges that cross it do
    not move at all. Insetting uniformly turns every footprint into a hip, and a
    square-ish house then reads as a pyramid — which is fine for a hip and wrong
    for the 11 OSM-tagged gables in this box, whose gable ends are vertical
    walls that must stay where the footprint puts them.
    """
    p = ccw(pts)
    n = len(p)
    if n < 3:
        return None
    lines = []
    for i in range(n):
        x0, y0 = p[i]
        x1, y1 = p[(i + 1) % n]
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy)
        if L < 1e-9:
            return None
        w = 1.0 if ridge is None else abs(math.cos(math.atan2(dy, dx) - ridge))
        di = d * w
        nx, ny = dy / L, -dx / L
        lines.append((x0 - nx * di, y0 - ny * di, dx, dy))
    out = []
    for i in range(n):
        ax, ay, adx, ady = lines[i - 1]
        bx, by, bdx, bdy = lines[i]
        den = adx * bdy - ady * bdx
        if abs(den) < 1e-9:
            return None
        t = ((bx - ax) * bdy - (by - ay) * bdx) / den
        out.append((ax + adx * t, ay + ady * t))
    if signed_area(out + [out[0]]) <= 1.0:
        return None
    # A concave ring can fold through itself long before its area goes negative,
    # and the fold renders as a spike shooting off the roof. A vertex that has
    # travelled more than a few times the offset distance is that fold.
    for (x, y), (x0, y0) in zip(out, p):
        if math.hypot(x - x0, y - y0) > abs(d) * 6 + 3:
            return None
    return out


def poly_mask(ring, X, Y):
    """Vectorised even-odd point-in-polygon over a grid.

    Scans by ROW rather than by cell: a 700x1000 grid against a 300-vertex
    footprint is 210 million cell tests the naive way, which is what made the
    first run of this look like it had hung.
    """
    ys = Y[:, 0]
    xs = X[0, :]
    inside = np.zeros((ys.size, xs.size), bool)
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        if y0 == y1:
            continue
        cond = (y0 > ys) != (y1 > ys)
        if not cond.any():
            continue
        xint = x0 + (ys - y0) / (y1 - y0) * (x1 - x0)
        inside[cond] ^= xs[None, :] < xint[cond, None]
    return inside


def dominant_axis(ring):
    """Azimuth of the longest edge, in radians, folded into one quadrant.

    Roof plant is laid out square to the building, never to north, so every box
    bake_roofscape.py places is placed in this frame.
    """
    best, th = 0.0, 0.0
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        L = math.hypot(x1 - x0, y1 - y0)
        if L > best:
            best, th = L, math.atan2(y1 - y0, x1 - x0)
    return th % (math.pi / 2)      # a rectangle's four edges are one frame


def ridge_axis(ring, th):
    """Which of the frame's two axes the ridge runs along, as a full azimuth.

    `dominant_axis` folds into a quadrant, which loses the difference between
    the long side of a building and its short side — and a gable's ridge runs
    along the LONG one. So measure the oriented extent in that frame and return
    whichever axis is longer, plus the two extents.
    """
    ct, st = math.cos(-th), math.sin(-th)
    u = [p[0] * ct - p[1] * st for p in ring]
    v = [p[0] * st + p[1] * ct for p in ring]
    du = max(u) - min(u)
    dv = max(v) - min(v)
    return (th, du, dv) if du >= dv else (th + math.pi / 2, dv, du)


def clearance(p, poly):
    def seg(pt, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 < 1e-12 else max(0.0, min(1.0, ((pt[0]-a[0])*dx + (pt[1]-a[1])*dy) / L2))
        return math.hypot(pt[0] - (a[0] + dx*t), pt[1] - (a[1] + dy*t))
    return min(seg(p, a, b) for a, b in zip(poly, poly[1:] + poly[:1]))


def box(cx, cy, w, l, th):
    ct, st = math.cos(th), math.sin(th)
    hw, hl = w / 2.0, l / 2.0
    pts = [(-hw, -hl), (hw, -hl), (hw, hl), (-hw, hl)]
    r = [(cx + x * ct - y * st, cy + x * st + y * ct) for (x, y) in pts]
    return r + [r[0]]


def h32(s):
    """Stable small hash. A generated feature must land in the same place on
    every bake, or a re-bake looks like the roofs moved."""
    v = 2166136261
    for ch in str(s).encode("utf-8"):
        v = ((v ^ ch) * 16777619) & 0xFFFFFFFF
    return v


# ── colour ────────────────────────────────────────────────────────────
def hex_of(rgb):
    return "#" + "".join("%02x" % int(round(max(0, min(255, c)))) for c in rgb)


def temper(rgb, parent, toward=DECK_TOWARD, dst=(DST_LO, DST_HI), cool=DECK_COOL):
    """Bring a photographed colour into this scene's exposure. See DECK_* above.

    Order matters: rescale LUMA first, so the range map is not fighting the
    desaturation, then pull the chroma in, then the cool bias, then the trace of
    the parent. Desaturating first re-compresses the bright end.
    """
    c = np.asarray(rgb, dtype=float)
    # See GREEN_CAP. Done first, on the raw measurement, so the luma rescale
    # below is computed on the colour that will actually be shipped.
    c[1] = min(c[1], (c[0] + c[2]) / 2.0 + GREEN_CAP)
    lum = float(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2])
    t = min(1.0, max(0.0, (lum - SRC_LO) / (SRC_HI - SRC_LO)))
    tgt = dst[0] + (dst[1] - dst[0]) * t
    c = c * (tgt / max(lum, 1e-3))
    g = float(c.mean())
    c = c + (g - c) * DECK_DESAT
    if cool:
        c = c * np.array([1.0 - cool * 0.55, 1.0, 1.0 + cool])
    if parent and len(parent) == 7 and toward > 0:
        pc = np.array([int(parent[i:i+2], 16) for i in (1, 3, 5)], dtype=float)
        c = c * (1 - toward) + pc * toward
    return hex_of(np.clip(c, 0, 255))


def like(hexcol, src, dst, lo=0.05, hi=1.8):
    """Move a colour the way the building's own roof colour moves between hours.

    This is what stops a measured deck from drifting out of the palette the rest
    of the scene lives in at golden hour, without inventing a second and third
    measurement of a photograph taken at one time of day.
    """
    if not (hexcol and src and dst) or len(hexcol) != 7 or len(src) != 7 or len(dst) != 7:
        return hexcol
    out = []
    for i in (1, 3, 5):
        c = int(hexcol[i:i+2], 16)
        s = max(1, int(src[i:i+2], 16))
        d = int(dst[i:i+2], 16)
        out.append(max(0, min(255, int(round(c * max(lo, min(hi, d / s)))))))
    return "#" + "".join("%02x" % c for c in out)


def night_of(deck_hex, parent_rn):
    """A roof at night is NOT a bright roof scaled down.

    `like()` works for golden hour, where the two ends are a similar brightness.
    At night it does not: the day->night ratio gets applied to a deck that may be
    twice as bright as the `rd` the ratio came from, so the brighter the roof the
    brighter it stays — and that ratio's strongest channel is blue. Austin's
    first cut of this shipped a field of glowing blue lids that out-shone the
    walls under them, which is the inverted-silhouette failure.

    An unlit membrane roof at night is dark. So the night colour is the
    building's own already-tuned `rn`, modulated only mildly by how bright the
    deck is in daylight; the sqrt compresses a 2.5x daylight range to about 1.3x.
    """
    if not (parent_rn and len(parent_rn) == 7 and deck_hex and len(deck_hex) == 7):
        return parent_rn or deck_hex
    d = [int(deck_hex[i:i + 2], 16) for i in (1, 3, 5)]
    n = np.array([int(parent_rn[i:i + 2], 16) for i in (1, 3, 5)], dtype=float)
    dl = 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]
    rel = min(1.30, max(0.80, math.sqrt(max(dl, 1.0) / ((DST_LO + DST_HI) / 2.0))))
    return hex_of(np.clip(n * rel, 0, 255))


def deck_colour(s, props):
    """The one definition of what colour a roof surface is.

    Called by BOTH bakes — this file for the parapet cap, bake_roofscape.py for
    the membrane inside it — because they are the same surface. Austin derived
    the cap by reading data/roofscape.geojson back in, which made the two bakes
    order-dependent with nothing to enforce the order; a stale roofscape.geojson
    silently produced caps for the previous run's colours.
    """
    rd = temper(s["col"], props.get("rd"))
    return rd, like(rd, props.get("rd"), props.get("rg")), night_of(rd, props.get("rn"))


# ── the survey: read one roof off the photograph ──────────────────────
# Detection constants for the equipment pass. bake_roofscape.py turns these
# blobs into geometry; they are measured here because this is the file that
# holds the imagery.
BG_M = 4.2            # local window: bigger than any unit, smaller than a roof
DEV_K = 2.9           # robust threshold, in MADs of the local deviation
DEV_FLOOR = 9.0       # ...but never less sensitive than this many luma levels
# ...and never MORE sensitive than this, which fixes a real feedback loop: the
# threshold adapts to each roof's own MAD, so a roof densely carpeted in plant —
# exactly the roof this pass exists for — raises its own threshold and detects
# the least.
DEV_CEIL = 26.0
VEG_SAT = 0.13        # a green, saturated blob overhanging an eave is a tree
MIN_BLOB_M2 = 0.6
SURVEY_KEEP = 130     # far more than any roof draws; the drawn cap is geometry-stage


def survey(ring_ll, lat0, is_parking):
    """Measure one footprint. Returns None when the imagery cannot answer.

    Everything returned is in metres relative to the deck's own centroid, in the
    building's own axis frame, so the geometry stage can be re-run against a
    different pitch or height without re-reading a tile. Reading 2,200 roofs off
    z20 takes ~12 minutes; the geometry takes seconds, and the geometry is what
    needs iterating against renders.
    """
    pm = clean(to_m(ring_ll, lat0))
    if len(pm) < 3:
        return None
    poly = ccw(pm)
    area = abs(signed_area(poly + [poly[0]]))
    if area < MIN_AREA:
        return None
    deck = inset(pm, PARAPET_IN) or inset(pm, 0.55)
    if deck is None:
        return None
    deck = ccw(deck)

    cx = sum(p[0] for p in deck) / len(deck)
    cy = sum(p[1] for p in deck) / len(deck)
    xs = [p[0] for p in deck]; ys = [p[1] for p in deck]
    res = RES_M if area < BIG_M2 else RES_BIG
    gx = np.arange(min(xs), max(xs) + res, res)
    gy = np.arange(min(ys), max(ys) + res, res)
    if gx.size < 4 or gy.size < 4 or gx.size * gy.size > 6_000_000:
        return None
    X, Y = np.meshgrid(gx, gy)
    inside = poly_mask(deck, X, Y)
    if inside.sum() < MIN_SAMPLES:
        return None

    k = math.cos(math.radians(lat0))
    rgb, ok = sample(X / (M_LAT * k), Y / M_LAT)
    good = inside & ok
    if good.sum() < MIN_SAMPLES:
        return None

    f = rgb.astype(np.float32)
    luma = 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]

    # ── deck colour ───────────────────────────────────────────────────
    lv = luma[good]
    lo, hi = np.percentile(lv, [LUMA_LO_PCT, LUMA_HI_PCT])
    band = good & (luma >= lo) & (luma <= hi)
    if band.sum() < 12:
        band = good
    col = np.median(f[band], axis=0)
    tex = float(np.std(lv) / 255.0)      # gravel ballast is rough, membrane is smooth

    th = dominant_axis(poly)
    rth, span_long, span_short = ridge_axis(poly, th)

    # ── slope split ───────────────────────────────────────────────────
    # See the SLOPE SPLIT block above. Measured on the DECK, so a bright parapet
    # coping on one side of the building does not read as a lit slope.
    ct, st = math.cos(-rth), math.sin(-rth)
    U = X * ct - Y * st          # along the ridge
    V = X * st + Y * ct          # across it
    def split(A):
        m = np.median(A[good])
        a = A > m
        la = luma[good & a]; lb = luma[good & ~a]
        if la.size < 12 or lb.size < 12:
            return 0.0
        ma, mb = float(np.median(la)), float(np.median(lb))
        return abs(ma - mb) / max((ma + mb) / 2.0, 1e-3)
    across = split(V)
    along = split(U)

    out = {"col": [round(float(c), 1) for c in col], "tex": round(tex, 4),
           "n": int(good.sum()), "area": round(area, 1),
           "c": [round(cx, 2), round(cy, 2)],
           "theta": round(th, 5), "rth": round(rth, 5),
           "sl": [round(span_long, 2), round(span_short, 2)],
           "sp": [round(across, 4), round(along, 4)],
           "blobs": []}

    # ── equipment ─────────────────────────────────────────────────────
    # A roof unit is a LOCAL deviation, not an absolute brightness: a dark
    # condenser on white membrane and a white AHU on black tar are the same
    # event. Subtract a local background wider than any unit and threshold what
    # is left, in MADs, so a smooth membrane and a rough gravel deck get the same
    # sensitivity without a per-roof constant.
    #
    # The background is a CLIPPED local MEAN, not a local median. A median over a
    # 32 px window is O(n*k^2) and scipy's is not separable; two separable
    # uniform filters — mean, then mean again over only the pixels the first pass
    # called background — cost O(n) and reject the units' own contribution to
    # their own background, which is the only property the median was there for.
    w = max(3, int(round(BG_M / res)) | 1)
    lz = np.where(good, luma, float(np.median(lv))).astype(np.float32)
    bg = ndimage.uniform_filter(lz, size=w, mode="nearest")
    s0 = np.abs(lz - bg)
    keep = s0 < max(DEV_FLOOR, 2.2 * float(np.median(s0[good])))
    num = ndimage.uniform_filter(np.where(keep, lz, 0.0).astype(np.float32), size=w, mode="nearest")
    den = ndimage.uniform_filter(keep.astype(np.float32), size=w, mode="nearest")
    bg = np.where(den > 0.15, num / np.maximum(den, 1e-6), bg)
    dev = lz - bg
    dv = dev[good]
    mad = float(np.median(np.abs(dv - np.median(dv)))) * 1.4826
    thr = min(DEV_CEIL, max(DEV_FLOOR, DEV_K * mad))
    eq = good & (np.abs(dev) > thr)
    # A blob is a thing plus its own shadow and both matter for reading it, but
    # one pixel of noise is not a condenser. Close first, then open.
    eq = ndimage.binary_closing(eq, np.ones((3, 3)), border_value=0)
    eq = ndimage.binary_opening(eq, np.ones((2, 2)), border_value=0)
    eq &= good

    mx = f.max(axis=-1); mn = f.min(axis=-1)
    sat = np.where(mx > 1, (mx - mn) / np.maximum(mx, 1), 0.0)
    veg = (f[..., 1] >= f[..., 0]) & (f[..., 1] > f[..., 2]) & (sat > VEG_SAT)

    # Water. The mask here is deliberately permissive — "blue" is not a water
    # test in aerial imagery, because a shadow is lit by the sky and therefore
    # also has B > R. The decision is made in bake_roofscape.py against what the
    # blobs turned out to be, where it costs seconds to re-decide.
    water = good & (f[..., 2] > f[..., 0] + 10) & (f[..., 1] > f[..., 0] + 4) & \
        (sat > 0.14) & (luma > 55)
    water = ndimage.binary_opening(water, np.ones((3, 3)), border_value=0)

    ct2, st2 = math.cos(-th), math.sin(-th)
    cell = res * res

    def blobs_from(mask, forced=None):
        lab, nlab = ndimage.label(mask)
        if nlab == 0:
            return []
        got = []
        for sl, i in zip(ndimage.find_objects(lab), range(1, nlab + 1)):
            m = (lab[sl] == i)
            n = int(m.sum())
            a = n * cell
            if a < MIN_BLOB_M2 or a > 2600:
                continue
            px = X[sl][m]; py = Y[sl][m]
            if forced is None and veg[sl][m].mean() > 0.45:
                continue
            # Oriented extent in the BUILDING's frame, not in north-up pixels.
            u = px * ct2 - py * st2
            v = px * st2 + py * ct2
            wdt = float(u.max() - u.min()) + res
            lng = float(v.max() - v.min()) + res
            if wdt < 0.35 or lng < 0.35:
                continue
            fill = a / max(wdt * lng, 1e-6)
            bl = f[sl][m]
            med = np.median(bl, axis=0)
            lm = float(0.299*med[0] + 0.587*med[1] + 0.114*med[2])
            ucx = float(u.mean()); vcy = float(v.mean())
            wx = ucx * ct2 + vcy * st2
            wy = -ucx * st2 + vcy * ct2
            asp = max(wdt, lng) / max(0.4, min(wdt, lng))
            if forced:
                kind = forced
            elif asp >= 4.5 and min(wdt, lng) <= 2.6 and a >= 3.0:
                kind = "duct"
            elif a < 5.5 and max(wdt, lng) < 3.8:
                kind = "cond"
            elif a <= 30 and abs(wdt - lng) / max(wdt, lng) < 0.28 and fill > 0.68:
                kind = "fan"
            elif a < 34:
                kind = "unit"
            elif fill >= 0.60 and lm >= 100:
                kind = "phouse"
            else:
                kind = "plant"
            got.append({"k": kind, "x": round(wx - cx, 2), "y": round(wy - cy, 2),
                        "w": round(min(wdt, 44.0), 2), "l": round(min(lng, 44.0), 2),
                        "a": round(a, 1),
                        "c": [round(float(c), 1) for c in med], "lm": round(lm, 1)})
        return got

    got = blobs_from(eq)
    pools = blobs_from(water, forced="pool")
    for p in pools:
        got = [b for b in got
               if abs(b["x"] - p["x"]) > (b["w"] + p["w"]) * 0.4 or
                  abs(b["y"] - p["y"]) > (b["l"] + p["l"]) * 0.4]
    got += pools

    # A parking deck's "equipment" is parked cars. There is no colour rule that
    # separates a white sedan from a white AHU, so a deck's clutter is thrown
    # away wholesale and it gets stair cores by rule instead, which is what a
    # parking structure actually has on it. 79 buildings here are class
    # `parking` and the top deck of every one of them is open.
    if is_parking:
        got = [b for b in got if b["k"] == "phouse" and b["a"] >= 25]

    got.sort(key=lambda b: -b["a"])
    out["blobs"] = got[:SURVEY_KEEP]
    out["drop"] = max(0, len(got) - SURVEY_KEEP)
    return out


# ── OSM ground truth ──────────────────────────────────────────────────
def osm_roof_tags():
    """{(lon,lat): tags} for every OSM way in the bbox carrying a roof:* tag.

    89 ways, of which 66 carry roof:shape. Fetched by --refresh-osm into
    data/osm_cache/roof_tags.json (gitignored, like every other Overpass
    response in this repo). Matched to snapshot buildings by centroid because
    Overture ids and OSM ids do not correspond.
    """
    try:
        d = json.load(open(ROOF_TAGS, encoding="utf-8"))
    except Exception:
        return []
    out = []
    for e in d.get("elements", []):
        c = e.get("center") or {}
        if "lon" in c and "lat" in c:
            out.append((c["lon"], c["lat"], e.get("tags") or {}))
    return out


def fetch_osm_roof_tags():
    import time
    import urllib.parse
    bbox = "32.7700,-96.8150,32.7980,-96.7800"
    q = ("[out:json][timeout:180];(" +
         "".join('way["building"]["%s"](%s);' % (k, bbox) for k in
                 ("roof:shape", "roof:colour", "roof:material", "roof:levels", "roof:height")) +
         'way["building:part"]["roof:shape"](%s);' % bbox +
         ");out tags center;")
    mirrors = ["https://overpass-api.de/api/interpreter",
               "https://overpass.kumi.systems/api/interpreter",
               "https://overpass.private.coffee/api/interpreter"]
    body = b"data=" + urllib.parse.quote(q).encode()
    for i in range(6):
        url = mirrors[i % len(mirrors)]
        try:
            req = urllib.request.Request(
                url, data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded",
                         "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=240) as r:
                d = json.load(r)
            os.makedirs(os.path.dirname(ROOF_TAGS), exist_ok=True)
            json.dump(d, open(ROOF_TAGS, "w", encoding="utf-8"))
            print("osm roof tags:", len(d.get("elements", [])))
            return
        except Exception as e:      # noqa: BLE001 — mirrors are flaky by nature
            print("  %s failed (%s); retrying" % (url.split("/")[2], e))
            time.sleep(2 + 3 * i)
    raise RuntimeError("every Overpass mirror failed")


def index_osm(tags, feats):
    """id -> osm tags, by nearest centroid within 25 m."""
    out = {}
    for f in feats:
        g = f["geometry"]
        r = (g["coordinates"][0] if g["type"] == "Polygon" else g["coordinates"][0][0])
        lon = sum(p[0] for p in r) / len(r)
        lat = sum(p[1] for p in r) / len(r)
        best, bt = 25.0, None
        for (ol, oa, t) in tags:
            d = math.hypot((ol - lon) * 93700.0, (oa - lat) * M_LAT)
            if d < best:
                best, bt = d, t
        if bt:
            out[f["properties"]["id"]] = bt
    return out


# ── the pitched roof ──────────────────────────────────────────────────
def pitched(props, s, osm):
    """Decide whether this building gets a pitch, and which kind.

    Returns None, or (run_m, gabled_bool, why). `run` is the eave-to-ridge
    distance and is HALF THE MEASURED SHORT SPAN of the footprint, in the
    footprint's own frame — not half its bounding box, and not a constant.
    Unlike Austin's campus halls, which are a tiled band around a flat central
    deck and needed the run measured ring by ring, a 155 m2 townhome has no
    central deck for the slope to stop at: it runs to the ridge. The 12 OSM-
    tagged pitched roofs in this box are all of that kind.
    """
    shape = (osm or {}).get("roof:shape")
    area = s["area"]
    run = s["sl"][1] / 2.0
    if run < 1.6:
        return None
    if shape in OSM_PITCHED:
        return run, shape in OSM_GABLED, "osm:" + shape
    if shape:                       # tagged flat, or tagged something unhandled
        return None
    if props.get("building_class") not in PITCH_CLASSES:
        return None
    h = props.get("final_height") or 0
    if not (PITCH_MIN_AREA <= area <= PITCH_MAX_AREA) or h > PITCH_MAX_H:
        return None
    if h / math.sqrt(max(area, 1.0)) >= PITCH_RATIO_MAX:
        return None
    c = s["col"]
    if 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > PITCH_MAX_LUMA:
        return None
    # A ridge runs along the long axis; a footprint that is nearly square has no
    # long axis worth the name, so it gets a hip and its ridge collapses to a
    # point on its own.
    gabled = s["sl"][0] / max(s["sl"][1], 1e-3) >= 1.45
    return run, gabled, "class+ratio"


def facets(ring_m, lat0, base_h, run, gabled, rth, rd, rg, rn):
    """Stepped inset facets, one quad per edge per step, each carrying its `az`.

    ONE QUAD PER EDGE, not one ring per step, because MapLibre shades every
    horizontal top face identically: concentric rings render as a flat plane
    with stripes on it. js/timeofday.js's roofFacetColor() picks each facet's
    colour between `rd`/`rg` (the lit end) and `rdd`/`rgd` (the shaded end) from
    the live sun azimuth and the facet's own `az`, which is what makes the
    stepping read as a slope instead of as contour lines.

    Whatever the slope encloses is always filled at the TOP. Leaving it on the
    wall cap was a real bug in Austin's first cut: the band climbed while the
    middle stayed down, so the steps floated over a flat plane.
    """
    p = simplify(ccw(clean(ring_m)), SIMPLIFY_M)
    if len(p) < 3:
        return []
    outer = inset(p, -EAVE_OUT_M) or p
    rise = min(RISE_MAX, run * PITCH)
    steps = max(STEPS_MIN, min(STEPS_MAX, int(round(run / STEP_TARGET_M))))
    ridge = rth if gabled else None

    out = []
    prev, prev_h = ccw(outer), base_h
    for i in range(1, steps + 1):
        t = i / steps
        nxt = inset(outer, run * t, ridge)
        top = base_h + rise * t
        if nxt is None:
            break
        nxt = ccw(nxt)
        if len(nxt) != len(prev):
            break
        for j in range(len(prev)):
            a, b = prev[j], prev[(j + 1) % len(prev)]
            c, d = nxt[(j + 1) % len(nxt)], nxt[j]
            quad = [a, b, c, d, a]
            if abs(signed_area(quad)) < 0.15:
                continue        # a gable end's facet has no width, by construction
            # Compass azimuth of the outward normal of this edge: 0 = north.
            az = int(round(math.degrees(math.atan2(b[0] - a[0], -(b[1] - a[1])))) % 360)
            out.append({"type": "Feature",
                        "geometry": {"type": "Polygon",
                                     "coordinates": [to_ll(quad, lat0)]},
                        "properties": {"b": round(prev_h, 2), "h": round(top, 2),
                                       "az": az,
                                       "rd": shade(rd, SHADE_HI), "rdd": shade(rd, SHADE_LO),
                                       "rg": shade(rg, SHADE_HI), "rgd": shade(rg, SHADE_LO),
                                       "rn": rn}})
        prev, prev_h = nxt, top
    # Cap whatever the slope encloses, flat, at the top of the run. Its two shade
    # ends are equal so it renders at the measured colour regardless of the sun —
    # a ridge cap is horizontal, and giving it an `az` would tint it as though it
    # were a slope facing that way.
    if prev and len(prev) >= 3 and abs(signed_area(prev + [prev[0]])) > 0.4:
        out.append({"type": "Feature",
                    "geometry": {"type": "Polygon",
                                 "coordinates": [to_ll(prev + [prev[0]], lat0)]},
                    "properties": {"b": round(prev_h - 0.05, 2), "h": round(prev_h, 2),
                                   "az": 0, "rd": rd, "rdd": rd,
                                   "rg": rg, "rgd": rg, "rn": rn}})
    return out


def shade(hexcol, k):
    if not hexcol or len(hexcol) != 7:
        return hexcol
    return "#" + "".join("%02x" % max(0, min(255, int(round(int(hexcol[i:i+2], 16) * k))))
                         for i in (1, 3, 5))


# ── main ──────────────────────────────────────────────────────────────
def load_survey():
    try:
        return json.load(open(SURVEY, encoding="utf-8"))
    except Exception:
        return {}


def is_parking_class(props):
    name = (props.get("name") or "").lower()
    return (props.get("building_class") == "parking" or
            "garage" in name or "parking" in name)


def measure_all(feats, cache, heroes, force=False):
    """Fill `cache` with one survey row per building. ~12 minutes cold."""
    done = 0
    for fi, f in enumerate(feats):
        if fi and fi % 200 == 0:
            print("  measured %d/%d" % (fi, len(feats)), flush=True)
            with open(SURVEY, "w", encoding="utf-8") as fh:
                json.dump(cache, fh, separators=(",", ":"), sort_keys=True)
        p = f["properties"]
        bid = str(p.get("id"))
        if not force and bid in cache:
            continue
        if (p.get("final_height") or 0) < MIN_H:
            continue
        if p.get("building_class") in NO_ROOF_CLASSES:
            continue
        if (p.get("name") or "") in heroes:
            continue
        g = f["geometry"]
        rings = ([g["coordinates"][0]] if g["type"] == "Polygon"
                 else [q[0] for q in g["coordinates"]])
        ring = max(rings, key=len)
        if len(ring) < 4:
            continue
        lat0 = sum(q[1] for q in ring) / len(ring)
        cache[bid] = survey(ring, lat0, is_parking_class(p))
        done += 1
    with open(SURVEY, "w", encoding="utf-8") as fh:
        json.dump(cache, fh, separators=(",", ":"), sort_keys=True)
    return done


def main():
    if "--fetch" in sys.argv:
        fetch_imagery()
        return
    if "--refresh-osm" in sys.argv:
        fetch_osm_roof_tags()
        return

    date, snap = snapshot_path()
    feats = json.load(open(snap, encoding="utf-8"))["features"]
    heroes = hero_names()
    cache = load_survey()
    remeasure = "--remeasure" in sys.argv or not cache
    if remeasure:
        n = measure_all(feats, {} if "--remeasure" in sys.argv else cache, heroes,
                        force="--remeasure" in sys.argv)
        cache = load_survey()
        print("surveyed %d roofs" % n, flush=True)

    osm = index_osm(osm_roof_tags(), feats)

    if "--calibrate" in sys.argv:
        rows = {}
        for f in feats:
            p = f["properties"]
            s = cache.get(str(p.get("id")))
            t = osm.get(p.get("id"))
            if not s or not t or "roof:shape" not in t:
                continue
            rows.setdefault(t["roof:shape"], []).append(s["sp"])
        print("shape       n   across   along   across-along")
        for k, v in sorted(rows.items(), key=lambda kv: -len(kv[1])):
            a = np.array(v)
            print("%-10s %3d   %6.3f  %6.3f   %6.3f"
                  % (k, len(v), a[:, 0].mean(), a[:, 1].mean(),
                     (a[:, 0] - a[:, 1]).mean()))
        return

    out = []
    caps = {}
    stats = Counter()
    why = Counter()
    for f in feats:
        p = f["properties"]
        bid = p.get("id")
        s = cache.get(str(bid))
        if not s:
            stats["no_survey"] += 1
            continue
        rd, rg, rn = deck_colour(s, p)

        # The parapet cap. `buildings-roof` re-extrudes the top ~1 m of every
        # building in the building's own `rd`, and `rd` is its wall 12% darker —
        # so every flat roof in the scene gets a warm brown rim round a grey
        # membrane deck. Measured on the Austin build with a magenta mask: the
        # cap owned 9,543 px of rgb(173,88,51) around 81,414 px of
        # rgb(151,138,114) of deck, and it read as a selection highlight.
        #
        # js/app.js's loadScene reads this table onto the FEATURE before
        # `city-buildings` is added, which is why it is a side table and not a
        # paint expression: js/timeofday.js re-paints that layer from rd/rg/rn
        # at every hour, so an expression set at load would be gone on the first
        # move of the time slider, while the data is read by whatever it sets.
        #
        # PITCHED ROOFS GET ONE TOO, unlike Austin's, which excluded them on the
        # grounds that "their cap sits under the eave of a hip and terracotta is
        # right there". That reasoning is about clay tile on a limestone campus.
        # A Dallas townhome's cap is the fascia under a grey shingle eave and
        # `rd` there is the brick wall 12% darker, i.e. brown — so it showed as
        # a brown collar under every pitched roof in the first render of this.
        caps[bid] = [rd, rg, rn]

        pit = pitched(p, s, osm.get(bid))
        if not pit:
            stats["flat"] += 1
            continue

        run, gabled, reason = pit
        why[reason] += 1
        g = f["geometry"]
        rings = ([g["coordinates"][0]] if g["type"] == "Polygon"
                 else [q[0] for q in g["coordinates"]])
        ring = max(rings, key=len)
        lat0 = sum(q[1] for q in ring) / len(ring)
        h = p.get("final_height") or 0
        # The eave sits on TOP of the cap js/app.js draws, not at the wall head.
        # The cap is `max(1.0, 0.015*h)` metres tall and is drawn whatever this
        # bake does, so an eave at the wall head leaves that 1 m lip poking up
        # through the first facet all the way round the house. Starting above it
        # turns the cap into the fascia the eave overhangs, which is what it is.
        fs = facets(to_m(ring, lat0), lat0, h + max(1.0, 0.015 * h),
                    run, gabled, s["rth"], rd, rg, rn)
        if not fs:
            stats["pitch_degenerate"] += 1
            continue
        out.extend(fs)
        stats["pitched_" + ("gabled" if gabled else "hipped")] += 1

    doc = {"type": "FeatureCollection", "features": out, "caps": caps,
           "_provenance": {
               "which buildings are pitched":
                   "MEASURED - OSM roof:shape where tagged (66 ways), otherwise the "
                   "across-ridge minus along-ridge luma split of the z20 nadir",
               "cap / deck colour":
                   "MEASURED - median of the 55-90th luma percentile inside the "
                   "parapet, tempered to scene exposure, shadow-corrected where "
                   "the surface is both dark and blue",
               "pitch shape, angle and rise": "GENERATIVE - stepped inset facets at 6:12",
           }}
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, separators=(",", ":"))

    print(json.dumps({
        "snapshot": date, "z": Z,
        "surveyed": sum(1 for v in cache.values() if v),
        "facets": len(out), "caps": len(caps),
        "counts": dict(sorted(stats.items())),
        "pitched_because": dict(why),
        "kb": round(os.path.getsize(OUT) / 1024, 1),
    }, indent=2))

    if "--report" in sys.argv:
        rows = []
        for f in feats:
            p = f["properties"]
            s = cache.get(str(p.get("id")))
            if not s:
                continue
            rows.append((s["sp"][0] - s["sp"][1], s["area"], p.get("building_class"),
                         p.get("name") or "(unnamed)"))
        rows.sort(reverse=True)
        print("\n  split  area  class                name")
        for d, a, c, n in rows[:40]:
            print("  %5.3f %5.0f  %-18s  %s" % (d, a, str(c)[:18], n[:40]))


if __name__ == "__main__":
    main()
