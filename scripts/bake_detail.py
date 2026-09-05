#!/usr/bin/env python3
"""
bake_detail.py - merge every detail source into render-ready GeoJSON.

Inputs (repo-relative):
  data/snapshots/<date>/buildings.enriched.geojson  base buildings (id, name,
                                                    building_class, final_height)
  data/parts.geojson          OSM building:part volumes (height_m, min_height_m,
                              colour, roof_colour, material)     [optional]
  data/building_tags.geojson  OSM colour/material tags as centroid points [optional]
  data/hero_designs.json      curated per-landmark + per-class palettes
  data/signs.json             sign labels + coordinates (hero location matching)

Outputs:
  data/snapshots/<date>/buildings.detailed.geojson  buildings + baked colours:
      wd/wg/wn  wall colour at day/golden/night
      rd/rg/rn  roof-cap colour at day/golden/night
      has_parts 1 if OSM parts replace this volume (client filters it out)
  data/snapshots/<date>/parts.detailed.geojson      parts + h, base, same colours

Colour strategy: everything is baked here so the client only interpolates
between per-feature day/golden/night colours with the time-of-day slider.
Priority per building: hero design (name or sign location match) >
OSM building:colour tag > building_class palette variant (deterministic pick).
"""
import json
import math
import colorsys
import hashlib
import sys
import os

DATE = sys.argv[1] if len(sys.argv) > 1 else '2026-07-10'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP = os.path.join(ROOT, 'data', 'snapshots', DATE)


def load(path, default=None):
    p = os.path.join(ROOT, path)
    if not os.path.exists(p):
        print(f'  [skip] {path} not found')
        return default
    with open(p, encoding='utf-8') as f:
        return json.load(f)


# ---------------------------------------------------------------- colour utils
def hex_to_rgb(h):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgb_to_hex(r, g, b):
    return '#%02x%02x%02x' % (max(0, min(255, round(r))),
                              max(0, min(255, round(g))),
                              max(0, min(255, round(b))))


def lerp_hex(a, b, t):
    A, B = hex_to_rgb(a), hex_to_rgb(b)
    return rgb_to_hex(*(A[i] + (B[i] - A[i]) * t for i in range(3)))


def adjust_light(h, dl):
    """Shift lightness by dl (-1..1) in HLS space."""
    r, g, b = (v / 255 for v in hex_to_rgb(h))
    hh, ll, ss = colorsys.rgb_to_hls(r, g, b)
    ll = max(0.05, min(0.95, ll + dl))
    r, g, b = colorsys.hls_to_rgb(hh, ll, ss)
    return rgb_to_hex(r * 255, g * 255, b * 255)


def stable01(key):
    """Deterministic 0..1 from a string key."""
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


# Time-of-day transforms applied to a base (day) colour.
GOLDEN_TINT = '#ffb26a'


def night_wall(day_hex):
    """day -> night WALL colour: strongly darkened and shifted cool.

    This used to mix 30% of the warm `night_window` tint straight into the wall
    (`wn = lerp(dark, night_window, 0.30)`), on the theory that a flat prism had
    to imply its own lighting. The measured result was a city of mid olive-khaki
    walls after dark — #63615b, #7b6d53 — sitting BRIGHTER than the night sky
    behind them, so the skyline had no silhouette at all.

    The facade patterns now carry lit windows (js/facades.js), so the wall is
    free to go properly dark and give those windows something to read against.
    Keep this formula in sync with nothing — js/facades.js consumes `wn`
    directly, and this is the single definition.

    THE SECOND CORRECTION, and the opposite failure. Simeon: "PCL and Tower and
    some buildings on Guad and Ransom center are all more visible in the night
    due to their color... but PCL, Greg walls, and guad buildings + union walls
    are standouts so make everything else like that too." The pass-authored
    buildings keep their material after dark; the other 2,453 do not.

    Measured on the old constants (darken 0.24, blend 0.50 toward (17,22,42)):

        wn luma   mean 32.9   stdev 3.4   min 20.4   max 40.0
        max saturation 0.273

    A stdev of 3.4 across brick, limestone, glass and painted concrete is not a
    city at night, it is one colour. Blending HALF of every wall into a single
    fixed triplet is what does it: a 200-luma limestone hall and an 80-luma
    brick block both arrive within a few points of the same navy.

    Darkening less and blending less keeps the day identity legible without
    going back to the olive-khaki disaster above. New constants land at

        wn luma   mean 49.7   stdev 6.7   max 63.4

    — twice the spread, and still far below the ~90-100 that made the skyline
    stop silhouetting against the sky. Both are taste knobs; lower DARKEN for a
    blacker city, raise BLEND to pull everything back toward the same navy.
    """
    DARKEN = 0.34     # how much of the day colour survives
    BLEND = 0.30      # how far toward the fixed cool triplet everything goes
    r, g, b = hex_to_rgb(day_hex)
    dark = (r * DARKEN, g * DARKEN, b * DARKEN)
    cool = (17, 22, 42)
    return rgb_to_hex(*(dark[i] + (cool[i] - dark[i]) * BLEND for i in range(3)))


def make_tod_colors(day_hex, night_window_hex):
    """day -> (wd, wg, wn) wall colours for day / golden hour / night."""
    # Golden: warm cast but keep each building's identity readable.
    wg = lerp_hex(day_hex, GOLDEN_TINT, 0.16)
    return day_hex, wg, night_wall(day_hex)


def make_roof_colors(roof_hex):
    rg = lerp_hex(roof_hex, GOLDEN_TINT, 0.22)
    rn = lerp_hex(adjust_light(roof_hex, -0.38), '#10152a', 0.6)
    return roof_hex, rg, rn


# ---------------------------------------------------------------- geometry
def rings_of(geom):
    if geom['type'] == 'Polygon':
        return [geom['coordinates']]
    if geom['type'] == 'MultiPolygon':
        return geom['coordinates']
    return []


def outer_ring(geom):
    r = rings_of(geom)
    return r[0][0] if r else []


def centroid(geom):
    ring = outer_ring(geom)
    if not ring:
        return None
    x = sum(p[0] for p in ring) / len(ring)
    y = sum(p[1] for p in ring) / len(ring)
    return (x, y)


def bbox(geom):
    ring = outer_ring(geom)
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return (min(xs), min(ys), max(xs), max(ys))


def point_in_poly(pt, geom):
    """Ray-cast against the outer ring of each polygon."""
    x, y = pt
    for poly in rings_of(geom):
        ring = poly[0]
        inside = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        if inside:
            return True
    return False


# ---------------------------------------------------------------- load inputs
print(f'Baking detail for snapshot {DATE}')
buildings = load(f'data/snapshots/{DATE}/buildings.enriched.geojson')
if not buildings:
    sys.exit('base buildings missing')
parts = load('data/parts.geojson', {'features': []})
btags = load('data/building_tags.geojson', {'features': []})
designs = load('data/hero_designs.json', {'buildings': {}, 'classes': {}})
signs = load('data/signs.json', {'features': []})

def norm_name(s):
    """Normalize for fuzzy matching: casefold, strip 'the ', ' austin', punct."""
    s = s.casefold().strip()
    for ch in '.,–—-':
        s = s.replace(ch, ' ')
    s = ' '.join(s.split())
    if s.startswith('the '):
        s = s[4:]
    if s.endswith(' austin'):
        s = s[:-7]
    return s


hero_by_name = {k.casefold(): v for k, v in designs.get('buildings', {}).items()}
hero_by_norm = {norm_name(k): v for k, v in designs.get('buildings', {}).items()}


def hero_for_name(name):
    """Exact, then normalized, then containment (≥5 chars) match."""
    if not name:
        return None
    d = hero_by_name.get(name.casefold())
    if d:
        return d
    n = norm_name(name)
    d = hero_by_norm.get(n)
    if d:
        return d
    for key, v in hero_by_norm.items():
        if len(key) >= 5 and (key in n or n in key):
            return v
    return None
classes = designs.get('classes', {})
default_class = classes.get('default') or {
    'palettes': [{'wall': '#d8c09a', 'trim': '#e8d8b8', 'roof': '#a08868'}],
    'night_window': '#ffd9a0',
}

# Sign label -> coordinates, to locate heroes whose OSM name differs.
sign_pts = []
for f in signs.get('features', []):
    lbl = (f.get('properties') or {}).get('label')
    if lbl and f.get('geometry', {}).get('type') == 'Point':
        sign_pts.append((lbl, f['geometry']['coordinates']))

# ---------------------------------------------------------------- index buildings
feats = buildings['features']
bboxes = [bbox(f['geometry']) for f in feats]

# ------------------------------------------------------- QUEUE J2/J3 height fix
#
# HANDOFF #68 (2026-08-04, `acer/j2-j4-churches-trucks`) diagnosed both of
# these and could not fix either: "[height] lives in the snapshot -- outside
# this lane's files. One `data/building_overrides.json` entry fixes it" (J3),
# and for J2 "Left for whoever owns `building_overrides.json`: the tower is
# the SW corner of the ring, the nave the rest, and the nave wants about
# 16 m." `building_overrides.json` is `bake_roofs.py`'s file (roof_run_m,
# roof_colour, deck_colour, loggia -- no height field, per HANDOFF #78's "there
# is still no way to override a building HEIGHT"). `final_height` is written
# HERE, by this bake, into buildings.detailed.geojson -- so the fix belongs in
# this file, not that one. Hand-editing the OUTPUT geojson was explicitly
# rejected in HANDOFF #7166's note ("the next bake silently wipes it"); this
# is a durable override that survives every re-bake.
#
# J2 -- University Christian Church. Overture's 37.0 m applied uniformly
# across the whole ~42x43 m footprint reads as a 9-storey office slab
# (confirmed on screen: `shots/r/buildings/before-christian-air2.png`).
# SOURCED, not guessed: "Places of worship around UT" (Design Decadence,
# 2012) says the Sanctuary "rises 62 feet [18.9 m] above University Avenue"
# and is a tower-like Gothic structure that "distinguishes the building along
# the streetscape" -- i.e. the real building is a low nave plus ONE tall
# tower, not one uniform height. Nave dropped to 16.5 m, close to the Aug-4
# lane's own "~16 m" estimate; the tower is added separately as a synthetic
# part below rather than re-drawing the whole 28-point ring from a guess.
#
# J3 -- University Catholic Center. 7.4 m is Overture's raw figure for a
# building the source describes as housing "a large chapel, a smaller...
# chapel, a conference room, kitchen, library, and several offices and
# classrooms" on an already-reasonable 42x45 m footprint (HANDOFF #68
# confirms the OUTLINE -- only the height is wrong; the surrounding bare
# plaza that reads as "construction" is `data/ground.geojson`, a different
# lane's file, not this building). No sourced height exists for this one, so
# unlike J2 this is a documented ESTIMATE: 12.8 m crosses `js/facades.js`'s
# `familyFor()` 12 m line from 'mr' ("2-3 storey walk-ups, shops") into 'mh'
# ("4-7 storey campus halls") -- the family a multi-program university
# building should read as, instead of a shop. One number, overrulable in one
# line, per CLAUDE.md's "parameterise every taste value."
HEIGHT_OVERRIDES = {
    '5d85b423-9d29-416b-98f6-fa5b991736ca': 16.5,   # University Christian Church (was 37.0)
    '826faac8-c25d-4770-b955-8f13385022e3': 12.8,   # University Catholic Center (was 7.4)
}
for _f in feats:
    _p = _f['properties']
    _bid = _p.get('id')
    if _bid in HEIGHT_OVERRIDES:
        _old = _p.get('final_height')
        _p['final_height'] = HEIGHT_OVERRIDES[_bid]
        print(f'  [J2/J3 height override] {_p.get("name")}: {_old} -> {_p["final_height"]} m')

# J2 roof colour: the source names "copper roof and trim" specifically, so the
# generic church-class roof (a dull brownish-grey) is swapped for a weathered
# green-patina copper. Wall colour is left alone -- the class palette's cream
# already reads close enough to the "Cordova cream cut limestone" the same
# source names, and the height fix above is doing the load-bearing work.
ROOF_OVERRIDES = {
    '5d85b423-9d29-416b-98f6-fa5b991736ca': '#5f8a76',   # University Christian Church: oxidised copper
}


def find_building(pt, want_height=None):
    """All containing footprints; if want_height given, pick the closest in
    height (sign points can sit inside an overlapping garage/podium too)."""
    hits = []
    for i, f in enumerate(feats):
        bx = bboxes[i]
        if bx[0] <= pt[0] <= bx[2] and bx[1] <= pt[1] <= bx[3]:
            if point_in_poly(pt, f['geometry']):
                hits.append(i)
    if not hits:
        return None
    if want_height is None or len(hits) == 1:
        return hits[0]
    return min(hits, key=lambda i: abs((feats[i]['properties'].get('final_height') or 0) - want_height))


# heroes located by sign position (disambiguated by the sign's height)
sign_heights = {f['properties']['label']: f['properties'].get('height')
                for f in signs.get('features', [])}
hero_at = {}
for lbl, coords in sign_pts:
    d = hero_by_name.get(lbl.casefold())
    if not d:
        continue
    i = find_building(tuple(coords), want_height=sign_heights.get(lbl))
    if i is not None:
        hero_at[i] = (lbl, d)
        nm = feats[i]['properties'].get('name') or '(unnamed)'
        h = feats[i]['properties'].get('final_height')
        print(f'  sign "{lbl}" -> {nm} ({h} m)')

# OSM colour tags located by centroid
tag_at = {}
for f in btags.get('features', []):
    g = f.get('geometry') or {}
    if g.get('type') != 'Point':
        continue
    i = find_building(tuple(g['coordinates']))
    if i is not None:
        tag_at[i] = f.get('properties') or {}

# parts grouped under their parent building
#
# has_parts is a DESTRUCTIVE flag: js/app.js filters the building out of
# buildings-3d/-roof entirely and trusts the parts to stand in for it. That is
# only safe if the parts actually COVER the footprint, and a bare
# centroid-in-footprint test never checked. Measured coverage on 2026-08-01:
#
#   Jesse H. Jones Comm A 100.0%   Bush 94.4%   Sutton 90.1%   LBJ 66.2%
#   Hampton Inn 47.6%   UT Tower 25.7%   Dobie Twenty21 17.4%
#   William B. Travis 2.9%   University Ave Church of Christ 2.6%
#
# So the William B. Travis Building — 3,746 m2, twelve storeys — was rendering
# as a single 110 m2, 3.2 m pad, with its full-height contact shadow still drawn
# around it. An empty lot with a shadow. Below the gate the parts are DROPPED and
# the base extrudes normally, which is strictly better than a spike on 3% of the
# plan. Do NOT "fix" this by scaling the tallest part up to final_height: on
# Travis that puts a 38 m tower on a 110 m2 pad, which is worse than either.
#
# Dobie Twenty21 and UT Tower also fall below the gate, and that is the intended
# outcome for them too: both are replaced by an authored pass (bake_westcampus /
# bake_tower) that hides the base by id, so dropping their raw OSM parts removes
# a second, differently-sized prism standing inside the authored massing.
PART_COVERAGE_MIN = 0.85

_M = (111320.0 * math.cos(math.radians(30.285)), 111320.0)


def _planar(geom):
    """Footprint in metres, for an area comparison. Local equirectangular is
    accurate to well under 1% over a 6 km campus and needs no projection dep."""
    from shapely.geometry import shape
    from shapely.ops import transform
    g = shape(geom)
    if not g.is_valid:
        g = g.buffer(0)
    return transform(lambda x, y, z=None: (x * _M[0], y * _M[1]), g)


part_parent = []
_by_parent = {}
for pf in parts.get('features', []):
    c = centroid(pf['geometry'])
    i = find_building(c) if c else None
    part_parent.append(i)
    if i is not None:
        _by_parent.setdefault(i, []).append(pf['geometry'])

has_parts = set()
part_coverage = {}
if _by_parent:
    from shapely.ops import unary_union
    for i, geoms in _by_parent.items():
        foot = _planar(feats[i]['geometry'])
        if foot.area <= 0:
            continue
        cov = unary_union([_planar(g) for g in geoms]).intersection(foot).area / foot.area
        part_coverage[i] = cov
        if cov >= PART_COVERAGE_MIN:
            has_parts.add(i)

# ---------------------------------------------------------------- bake buildings
matched_heroes, tagged, class_hits = 0, 0, 0
for i, f in enumerate(feats):
    p = f['properties']
    name = (p.get('name') or '')
    cls = p.get('building_class')
    if not cls:
        # Unclassed + tall in this bbox ≈ West Campus apartment block; give it
        # the apartment variety instead of the (muted) default palette.
        cls = 'apartments' if (p.get('final_height') or 0) >= 16 else 'default'
    key = p.get('id') or name or str(i)
    jitter = (stable01(key) - 0.5) * 0.14          # +-7% lightness variety

    hero = hero_at[i][1] if i in hero_at else hero_for_name(name)

    if hero:
        wall = hero['wall']
        roof = hero.get('roof') or adjust_light(wall, -0.12)
        nightw = hero.get('night_window') or '#ffd9a0'
        matched_heroes += 1
    elif i in tag_at and tag_at[i].get('colour'):
        wall = tag_at[i]['colour']
        roof = tag_at[i].get('roof_colour') or adjust_light(wall, -0.12)
        nightw = (classes.get(cls) or default_class).get('night_window', '#ffd9a0')
        tagged += 1
    else:
        cd = classes.get(cls) or default_class
        pals = cd.get('palettes') or default_class['palettes']
        pal = pals[int(stable01(key + ':v') * len(pals)) % len(pals)]
        wall = adjust_light(pal['wall'], jitter)
        roof = adjust_light(pal.get('roof') or adjust_light(wall, -0.12), jitter * 0.6)
        nightw = cd.get('night_window', '#ffd9a0')
        class_hits += 1

    if p.get('id') in ROOF_OVERRIDES:
        roof = ROOF_OVERRIDES[p['id']]

    wd, wg, wn = make_tod_colors(wall, nightw)
    rd, rg, rn = make_roof_colors(roof)
    p.update(wd=wd, wg=wg, wn=wn, rd=rd, rg=rg, rn=rn)
    if i in has_parts:
        p['has_parts'] = 1
    # keep payload lean
    p.pop('overture_height', None)

# ---------------------------------------------------------------- bake parts
part_feats = []
dropped_parts = 0
for pf, parent in zip(parts.get('features', []), part_parent):
    pp = pf.get('properties') or {}
    h = pp.get('height_m')
    if h is None:
        continue
    # The parent kept its own volume (coverage gate above), so this part would
    # be a second prism standing inside a building that is still being drawn.
    if parent is not None and parent not in has_parts:
        dropped_parts += 1
        continue
    base = pp.get('min_height_m') or 0
    if parent is not None:
        bp = feats[parent]['properties']
        wall_src = pp.get('colour')
        if wall_src:
            nightw = '#ffd9a0'
            wd, wg, wn = make_tod_colors(wall_src, nightw)
        else:
            wd, wg, wn = bp['wd'], bp['wg'], bp['wn']
        roof_src = pp.get('roof_colour')
        if roof_src:
            rd, rg, rn = make_roof_colors(roof_src)
        else:
            rd, rg, rn = bp['rd'], bp['rg'], bp['rn']
    else:
        wall = pp.get('colour') or '#d8c09a'
        wd, wg, wn = make_tod_colors(wall, '#ffd9a0')
        rd, rg, rn = make_roof_colors(pp.get('roof_colour') or adjust_light(wall, -0.12))
    # `pid` is the parent building's id. It was computed here all along and
    # thrown away, which is why every consumer had to identify a part by its WALL
    # COLOUR instead: js/tower.js:291-299 filters parts-3d on `wd == "#e5dbc2"`
    # and says in its own comment that this is unique "across all five snapshots
    # on disk (checked)". That is true and it is a time bomb — the moment a
    # building is recoloured, an authored pass starts drawing on top of a raw OSM
    # prism it can no longer see. With `pid` a pass filters parts the same way it
    # filters buildings: by id.
    props = {'h': round(float(h), 1), 'base': round(float(base), 1),
             'wd': wd, 'wg': wg, 'wn': wn,
             'rd': rd, 'rg': rg, 'rn': rn}
    if parent is not None:
        pid = feats[parent]['properties'].get('id')
        if pid:
            props['pid'] = pid
    part_feats.append({
        'type': 'Feature',
        'geometry': pf['geometry'],
        'properties': props,
    })

# --------------------------------------------------- QUEUE J2: a hand-authored tower
#
# No OSM/Overture `building:part` exists for University Christian Church (0 of
# 23 records in data/parts.geojson fall anywhere near it), so there is no real
# sub-massing to adopt -- the church's own base volume above (16.5 m, the nave)
# is the only geometry this snapshot has. HANDOFF #68 places the real tower "in
# the SW corner of the ring"; that corner is confirmed against the actual
# footprint below (an 8x8 m square, inset 1.5 m from the two SW-facing edges,
# checked point-in-polygon against every corner so it stands on the church's
# own walls rather than floating past them). Height is the SOURCED figure --
# "rises 62 feet [18.9 m] above University Avenue" -- not a guess. `has_parts`
# is deliberately NOT set on the church: this tower stands ALONGSIDE the base
# volume, not instead of it, so buildings-3d keeps drawing the nave.
CHURCH_ID = '5d85b423-9d29-416b-98f6-fa5b991736ca'
_church = next((f for f in feats if f['properties'].get('id') == CHURCH_ID), None)
if _church:
    _tower_ring = [
        [-97.7394744, 30.2831555], [-97.7393912, 30.2831555],
        [-97.7393912, 30.2832273], [-97.7394744, 30.2832273],
        [-97.7394744, 30.2831555],
    ]
    _cp = _church['properties']
    # Wall matches the church's own baked stone colour exactly (same material,
    # same tower) -- only the small cap gets its own copper tone.
    _trd, _trg, _trn = make_roof_colors(adjust_light(ROOF_OVERRIDES[CHURCH_ID], -0.15))
    part_feats.append({
        'type': 'Feature',
        'geometry': {'type': 'Polygon', 'coordinates': [_tower_ring]},
        'properties': {
            'h': 18.9, 'base': 0.0,
            'wd': _cp['wd'], 'wg': _cp['wg'], 'wn': _cp['wn'],
            'rd': _trd, 'rg': _trg, 'rn': _trn,
            'pid': CHURCH_ID,
        },
    })
    print(f'  [J2 tower] added synthetic 8x8 m tower part at 18.9 m for {_cp.get("name")}')

# ---------------------------------------------------------------- write
out_b = os.path.join(SNAP, 'buildings.detailed.geojson')
with open(out_b, 'w', encoding='utf-8') as f:
    json.dump(buildings, f, separators=(',', ':'))
out_p = os.path.join(SNAP, 'parts.detailed.geojson')
with open(out_p, 'w', encoding='utf-8') as f:
    json.dump({'type': 'FeatureCollection', 'features': part_feats}, f,
              separators=(',', ':'))

print(f'  buildings: {len(feats)}  heroes matched: {matched_heroes}  '
      f'osm-tagged: {tagged}  class-palette: {class_hits}')
print(f'  buildings with parts (hidden base): {len(has_parts)}')
for i, cov in sorted(part_coverage.items(), key=lambda kv: kv[1]):
    nm = feats[i]['properties'].get('name') or feats[i]['properties'].get('id', '')[:8]
    print(f'    {"keep " if i in has_parts else "DROP "}{cov * 100:5.1f}%  {nm}')
print(f'  parts baked: {len(part_feats)}  (dropped below the coverage gate: {dropped_parts})')
print(f'  wrote {out_b} ({os.path.getsize(out_b)//1024} KB)')
print(f'  wrote {out_p} ({os.path.getsize(out_p)//1024} KB)')
