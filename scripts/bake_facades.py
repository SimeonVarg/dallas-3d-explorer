# -*- coding: utf-8 -*-
"""The DOWNTOWN DALLAS facade palette, computed in the bake instead of the browser.

WHY THIS EXISTS, part one — the mechanical reason, carried over from Austin.
`js/facades.js`'s `quantiseFacades` elects the fourteen most populous window
tones across the WHOLE city and stamps a pattern id on every building at
runtime. A vector tile cannot be mutated after it is built, so buildings cannot
move onto tiles until that election happens offline. This half is not a speed
job — it is what makes tiling possible.

WHY THIS EXISTS, part two — AND THIS IS THE HALF THAT MOVED PIXELS. The brief
that started this pass said the missing bake was "very likely most of why the
walls read badly". IT IS NOT, and the finding is worth keeping so nobody spends
the afternoon again: a faithful bake is bit-identical to the browser election by
construction — `js/facades.js` says so itself ("the two paths are measured to
produce identical output ... a fallback is the same answer computed twice") —
so arming it moves nothing at all. `--check --raw` prints the election; compare
it against a `?bakedfacades=0` load if you doubt it.

WHAT IS ACTUALLY WRONG is what the election ELECTS, and it is a property of the
colour data rather than of the algorithm. Three measurements off the 2026-09-05
snapshot, all reproducible with `--check --raw`:

  1. NO VALUE RANGE, AND THE ELECTION MAKES IT WORSE. The scene's own `wd`
     spans luma 51..221 (sd 22.5). After quantisation the city is PAINTED
     136..214 (sd 18.8), and half of all buildings land in a 15-luma band,
     164..179. A skyline photograph's whole legibility is the value gap between
     black glass and pale precast; this one has a 15-luma interquartile doing
     that job, which is why the ordinary fabric behind the five heroes reads as
     one sheet of grey cardboard at every daytime hour.

  2. THE TEN DARKEST BUILDINGS ARE PAINTED MID TERRACOTTA. Only 10 of 2,220
     features have `wd` luma under 100, spread over four coarse keys (n1,
     5-1-0, 7-1-0, 0-1-1) — none of which is populous enough to win one of the
     fourteen buckets, so all four fold into `0-2-1`, `#a5806a`. The casualty
     list is the skyline:

         Renaissance Tower     #2f343a -> #a5806a   -85 luma
         Energy Plaza          #3c4046 -> #a5806a   -73
         Bank of America Plaza #39443f -> #a5806a   -72
         Omni Dallas Hotel     #4a5560 -> #a5806a   -53
         Fountain Place        #47605c -> #a5806a   -48
         Bryan Tower           #5f5a4e -> #a5806a   -46

     Mean fold error over the whole city is 9.2 luma and p99 is 27, so this is
     not the election being sloppy — it is the election being exactly right on
     2,211 buildings and catastrophically wrong on nine, because "most
     populous" cannot see a material that only nine buildings wear. Austin
     solved the same problem for the Capitol's granite with
     `window.FACADE_PROTECTED`; nothing registers that in this repo, so the
     equivalent is done here, from the data, by `reserve()`.

  3. IT IS AUSTIN'S TAN. 47% of buildings are painted from a hue-bin-1 bucket
     (30-60 degrees, khaki) and another 28% from a near-neutral one, at a
     population-weighted saturation of 0.146. `scripts/make_hero_designs.py`
     already convicts this in its own docstring — "Rendering it with Austin's
     tan gives a city that reads as a warm low-rise campus that happens to be
     280 m tall" — and rotates the `commercial`/`office`/`hotel` CLASS palettes
     cool. But 515 of these 2,220 buildings carry no class at all and 410 are
     `house`, so the class palettes never reach three quarters of the city and
     the default is still Austin's. `direct()` finishes that decision at the
     palette, which is the only surface a wall is actually painted with.

THE THREE PASSES ARE PHYSICALLY SEPARATE, because only the first is a
transcription and it has to stay auditable after the taste lands:

  elect()    a faithful port of window.quantiseFacades. THE ORACLE. If this and
             the browser ever disagree, this is wrong.
  reserve()  extra buckets for materials the population vote loses. Changes
             WHICH bucket a building lands in — for 10 buildings, measured.
  direct()   re-grades the colours the buckets are painted with. Changes no
             bucket, no index entry, no `wp`, no `wf`, no family, no pattern
             count. It is a colour edit and cannot be anything else.

WHY GRADE HERE AND NOT IN enrich.py. `wd` is consumed by the roof bake, the
night bake and the hero designs, and this pass owns none of them. And
`quantiseFacades` throws away all 1,044 distinct `wd` values and replaces them
with fourteen, so a building's `wd` after quantisation is decoration: grading
the fourteen IS grading the city, and grading 1,044 values upstream to reach
the same fourteen is the same edit with 1,030 extra chances to be wrong.

STAMPED AS `fb`, AN INERT ORDINAL, NOT AS `wp` — the trap Austin's port
documented at length. `wp` IS read by the renderer through
`['coalesce', ['get','wp'], 'mh00']`, so a baked `wp` naming an atlas image
nothing registered paints that building TRANSPARENT. Nothing reads `fb`.

PARITY, RUN RATHER THAN ASSERTED. `elect()` was checked against the live
`window.quantiseFacades` on a `?bakedfacades=0` load: fetch the same snapshot in
the page, call the real function on it, and hash the resulting `wp` string for
all 2,220 features in file order. Both sides come out
`sha256(...)[:16] == 2a224d1390fe8b9b`, 14 buckets, 64 patterns. Reproduce it
with, in the page console:

    const gj = await (await fetch('data/snapshots/<date>/buildings.detailed.geojson')).json();
    window.quantiseFacades(gj.features);
    // then SHA-256 of JSON.stringify(gj.features.map(f => f.properties.wp))

and, here:

    python - <<'EOF'
    import importlib.util, json, hashlib
    m = importlib.util.spec_from_file_location('bf', 'scripts/bake_facades.py')
    bf = importlib.util.module_from_spec(m); m.loader.exec_module(bf)
    _, feats = bf.load_scene()
    rows = bf.elect(feats)[3]
    s = json.dumps([r['wp'] for r in rows], separators=(',', ':'))
    print(hashlib.sha256(s.encode()).hexdigest()[:16])
    EOF

The separators matter: Python's default `json.dumps` puts a space after every
comma and JavaScript's does not, so the two hashes differ over an identical list
if you forget. That is a hash of the transcription, not of the taste — `reserve()`
and `direct()` run after it and are deliberately outside the compared range.

Idempotent: recomputes from `wd` every run.

Usage:  python scripts/bake_facades.py                  # write the palette
        python scripts/bake_facades.py --check          # print it, write nothing
        python scripts/bake_facades.py --check --raw    # the ungraded election
"""
import colorsys
import json
import math
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT_PALETTE = os.path.join(DATA, "facade_palette.json")

TARGET_BUCKETS = 14        # js/facades.js:31
CHECK = "--check" in sys.argv
RAW = "--raw" in sys.argv


# ---------------------------------------------------------------- colour --
def hex_to_rgb(h):
    h = h.replace("#", "")
    return [int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)]


def _js_round(n):
    """JavaScript Math.round: halves go UP, including negative halves.

    Python's round() is banker's rounding and would disagree with the browser on
    any bucket mean that lands exactly on .5. Carried over from the Austin port
    rather than re-derived: the whole point of a transcription is that it does
    not get to decide which of the original's details mattered.
    """
    return math.floor(n + 0.5)


def rgb_to_hex(r, g, b):
    c = lambda n: "%02x" % max(0, min(255, int(_js_round(n))))
    return "#" + c(r) + c(g) + c(b)


def rgb_to_hsl(r, g, b):
    r /= 255.0
    g /= 255.0
    b /= 255.0
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2
    if mx == mn:
        return 0.0, 0.0, l
    d = mx - mn
    s = d / (2 - mx - mn) if l > 0.5 else d / (mx + mn)
    if mx == r:
        h = ((g - b) / d) + (6 if g < b else 0)
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    return h / 6, s, l


def dist2(a, b):
    dr, dg, db = a[0] - b[0], a[1] - b[1], a[2] - b[2]
    return 2 * dr * dr + 4 * dg * dg + 3 * db * db


def coarse_key(rgb):
    """js/facades.js coarseKey() — the exact floor() boundaries, transcribed."""
    h, s, l = rgb_to_hsl(rgb[0], rgb[1], rgb[2])
    if s < 0.10:
        return "n%d" % math.floor(l * 5)
    return "%d-%d-%d" % (math.floor(h * 12), math.floor(l * 5), 0 if s < 0.22 else 1)


def luma(rgb):
    """Rec. 601 luma. Used for MEASUREMENT and for the fold-error rule, never to
    produce a colour — the grade works in HLS so hue survives a value move."""
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


# js/facades.js familyFor() — COPIED FROM THE REGEXES, character for character,
# and the Austin port's warning applies unchanged: `familyFor` tests the RAW
# `building_class`, so a port that helpfully lower-cased it would classify a
# building the renderer classifies differently. Faithful beats correct here; if
# the case-sensitivity is wrong it is wrong in js/facades.js.
GARAGE = re.compile(r"parking|garage|carport")
STADIUM = re.compile(r"stadium|arena|sports_centre|grandstand")
RESIDENTIAL = re.compile(r"apartment|dormitory|residential|hotel|condo")
PUNCHED = re.compile("|".join([
    "university", "college", "school", "kindergarten",
    "church", "chapel", "cathedral", "synagogue", "mosque", "temple",
    "hospital", "clinic", "civic", "public", "government",
    "library", "museum", "train_station", "transportation",
    "industrial", "manufacture", "warehouse", "utility", "service",
]))


def family_for(p):
    cls = p.get("building_class") or ""
    if GARAGE.search(cls):
        return "dk"
    if STADIUM.search(cls):
        return "st"
    h = p.get("final_height") or 0
    if h < 5:
        return "lo"
    if h < 12:
        return "mr"
    if h < 26:
        return "mh"
    if RESIDENTIAL.search(cls):
        return "tr"
    if PUNCHED.search(cls):
        return "mh" if h < 45 else "tr"
    return "tg"


# ----------------------------------------------------------- the scene in --
def snapshot_date():
    return json.load(open(os.path.join(DATA, "manifest.json"), encoding="utf-8"))["latest"]


def load_scene():
    """Rebuild exactly the feature list quantiseFacades is handed in the browser.

    THREE PASSES SHORTER THAN AUSTIN'S, and that is a fact about this repo
    rather than an omission. js/app.js's loadScene calls `mergeCapitolScene` and
    `applyUnion24` behind `typeof ... === 'function'` guards; neither
    js/capitol.js nor js/union24.js was ported, so both guards are false and the
    snapshot IS the feature list. js/heroes-dallas.js runs in the LAYER step,
    long after quantisation, and adds its own `city-heroes` source rather than
    editing this one — it only amends layer filters.

    Checked rather than assumed. If either module ever lands, this bake would
    quietly elect over a different city than the browser paints, so it refuses.
    """
    for js in ("capitol.js", "union24.js"):
        if os.path.exists(os.path.join(ROOT, "js", js)):
            raise SystemExit(
                "bake_facades: js/%s exists. js/app.js splices it into the "
                "feature list BEFORE quantiseFacades, so load_scene() must "
                "reproduce that pass or this bake elects over a different city "
                "than the browser paints. scripts/bake_facades.py in the "
                "austin-3d-explorer tree has the shape of it." % js)
    date = snapshot_date()
    path = os.path.join(DATA, "snapshots", date, "buildings.detailed.geojson")
    return date, json.load(open(path, encoding="utf-8"))["features"]


# ------------------------------------------------------------ the election --
def _group(features):
    """Coarse keys -> group means, in FIRST-SEEN order then by population.

    First-seen order matters: a JS `Map` and a Python dict agree on it, and
    `sort`/`sorted` are both stable, so ties keep it in both languages.
    """
    groups = {}
    for f in features:
        p = f.get("properties") or {}
        if not p.get("wd"):
            continue
        key = coarse_key(hex_to_rgb(p["wd"]))
        g = groups.get(key)
        if g is None:
            g = {"n": 0, "wd": [0.0] * 3, "wg": [0.0] * 3, "wn": [0.0] * 3}
            groups[key] = g
        g["n"] += 1
        for arr, hexv in (("wd", p["wd"]), ("wg", p.get("wg") or p["wd"]),
                          ("wn", p.get("wn") or p["wd"])):
            c = hex_to_rgb(hexv)
            for i in range(3):
                g[arr][i] += c[i]
    allg = [{"key": k, "n": g["n"],
             "wd": [v / g["n"] for v in g["wd"]],
             "wg": [v / g["n"] for v in g["wg"]],
             "wn": [v / g["n"] for v in g["wn"]]}
            for k, g in groups.items()]
    allg.sort(key=lambda g: -g["n"])
    return allg


def _fold(allg, kept):
    """Index every group onto its nearest surviving bucket.

    FIRST minimum on a tie, which a strict `<` gives and `<=` would not — the
    browser's `forEach` with `if (d < bestD)` does the same.
    """
    index = {k["key"]: i for i, k in enumerate(kept)}
    for g in allg:
        if g["key"] in index:
            continue
        best, best_d = 0, float("inf")
        for i, k in enumerate(kept):
            d = dist2(g["wd"], k["wd"])
            if d < best_d:
                best_d, best = d, i
        index[g["key"]] = best
    return index


def _stamp(features, kept, index):
    rows, combos = [], []
    for f in features:
        p = f.get("properties") or {}
        if not p.get("wd"):
            rows.append(None)
            continue
        b = index.get(coarse_key(hex_to_rgb(p["wd"])), 0)
        fam = family_for(p)
        wp = fam + str(b).zfill(2)
        rows.append({"fb": b, "wf": fam, "wp": wp})
        if wp not in combos:
            combos.append(wp)
    return rows, combos


def elect(features):
    """A transcription of window.quantiseFacades. THE ORACLE.

    `window.FACADE_PROTECTED` is empty in this repo — js/capitol.js is what
    registered it in Austin and it was not ported — so step 2b of the browser's
    election is a no-op here and is left out rather than carried as dead code
    nothing could exercise. `reserve()` below is what does that job instead, and
    it does it from the data rather than from a hand-written list.
    """
    allg = _group(features)
    kept = allg[:TARGET_BUCKETS]
    index = _fold(allg, kept)
    rows, combos = _stamp(features, kept, index)
    return allg, kept, index, rows, combos


# ------------------------------------------- buckets the vote always loses --
#
# THE RULE. A group whose mean is more than MAX_FOLD_LUMA away in luma from the
# bucket it folds into gets a bucket of its own, richest-in-error first, until
# the rule is satisfied or MAX_RESERVED is spent.
#
# WHY LUMA AND NOT `dist2`. `dist2` is the browser's nearest-survivor metric and
# is the right one for CHOOSING a survivor: it weights green 4x and blue 3x
# because that is roughly how much they matter to perceived difference. But it
# is a sum of squares over three channels, so a group can be 85 luma away and
# still not be the worst `dist2` in the list — Renaissance Tower's group is 85
# luma from `#a5806a` and a hue-only pair like `6-3-0` vs `n3` can score
# comparably in `dist2` while being visually fine. The defect being fixed is
# specifically that DARK BUILDINGS ARE PAINTED LIGHT, so the threshold is on the
# axis the defect lives on.
#
# 36 IS THE NUMBER, and it is chosen off the measured distribution rather than
# picked: the fold-error histogram on this snapshot is p50 8, p90 18, p99 27,
# then a gap, then nine buildings at 46..85. Any threshold in 28..45 selects
# exactly the same set. 36 sits in the middle of that gap, so a small change to
# the snapshot cannot flip a bucket in or out of existence.
MAX_FOLD_LUMA = 36.0
# A CEILING ON THE COST, because every reserved bucket is more atlas images.
# Each (family, bucket) combo costs two images (far tier + near tier) and every
# one is re-drawn on every time-of-day change. Measured on this snapshot: the
# election alone produces 64 combos, and the reserve adds 4 (68 total, +6%).
# Three is the most this rule has ever asked for here; the cap exists so a
# future snapshot with a scatter of one-off materials cannot quietly double the
# atlas.
MAX_RESERVED = 3


def reserve(allg, kept, index):
    """Give a bucket to any group the population vote folds too far.

    Returns (kept, index, notes). Groups are added in descending fold error so
    the first one added is always the worst — and the fold is recomputed after
    each addition, because rescuing the darkest group can pull a second dark
    group onto it and satisfy the rule without a second bucket. On this snapshot
    that is exactly what happens: four dark keys, two buckets.
    """
    notes = []
    for _ in range(MAX_RESERVED):
        worst, worst_e = None, MAX_FOLD_LUMA
        for g in allg:
            if any(k["key"] == g["key"] for k in kept):
                continue
            e = abs(luma(g["wd"]) - luma(kept[index[g["key"]]]["wd"]))
            # Weighted by nothing: a material worn by one building is still a
            # material, and the whole point is that population already had its
            # vote. Ordering is by error alone.
            if e > worst_e:
                worst, worst_e = g, e
        if worst is None:
            break
        notes.append("%s n=%d folded %+.0f luma -> own bucket %d"
                     % (worst["key"], worst["n"],
                        luma(worst["wd"]) - luma(kept[index[worst["key"]]]["wd"]),
                        len(kept)))
        kept = kept + [worst]
        index = _fold(allg, kept)
    return kept, index, notes


# ------------------------------------------------------- the art direction --
#
# TWO RULES, ONE NUMBER EACH, applied to the elected colours in HLS. Everything
# here is taste, but each rule is answering a measurement from the docstring.

# RULE 1 — VALUE GAIN, answering finding 1. Lightness is pushed away from the
# palette's own centre so the fourteen tones stop sitting on top of each other.
#
# 2.15 is bracketed rather than picked. The elected palette's HLS lightness runs
# 0.53..0.82 — a 0.29 spread doing the work of a skyline — and a gain of 2.15
# about the population-weighted centre takes it to 0.13..0.93 before clamping,
# which lands the palette's ends on the two clamps and nowhere past them. That
# is the useful ceiling: any higher and the outer buckets are pinned by L_MIN /
# L_MAX instead of by the data, so the gain stops separating them from each
# other and only flattens what is left in the middle.
VALUE_GAIN = 2.15
# A SMALL GLOBAL PULL DOWN, applied to the pivot rather than to the output so it
# cannot change the spread. The gain alone leaves the two biggest buckets — 1,006
# buildings, 45% of the city — exactly where they were, at luma 182, because
# they ARE the population-weighted centre it pivots about; the fabric then sits
# at the same value as the pale precast accents and the accents stop reading as
# accents. 0.03 of lightness is about 8 luma at this end of the range: enough
# that the cream towers separate from the block they stand in, small enough that
# the fabric does not go grey-flannel. Turning this down is the first thing to
# try if the city ever reads too heavy.
VALUE_SHIFT = -0.03
# Clamps. The floor is above zero because a wall at L 0 takes no shading from
# `js/graphics.js`'s lighting and reads as a hole; the ceiling is 0.86 because
# 0.90 put three buckets over luma 229, and `wg` sits ABOVE `wd` with the sky
# light added on top of both, so those three had nowhere left to go at the hour
# the scene is brightest.
L_MIN, L_MAX = 0.11, 0.86

# RULE 2 — TEMPERATURE, answering finding 3, and it is applied PER HUE FAMILY
# rather than globally. This is the whole of the argument with
# make_hero_designs.py, which cooled `commercial`/`office`/`hotel` and left
# `apartments` and `retail` warm ON PURPOSE ("Deep Ellum and the east edge of
# the box really are brick"). Cooling the palette globally would undo that
# decision at the last surface before the screen, and a downtown that is
# uniformly cool is the same mistake as one that is uniformly warm with the
# sign flipped.
#
# IT IS A DESATURATION PLUS A CHANNEL TINT, NOT A HUE ROTATION, and that is a
# correction rather than a preference. The first cut rotated hue toward a
# blue-grey the way make_hero_designs.py's `cool()` does, and every partial
# rotation landed IN GREEN: from hue 0.11 the short way round to 0.57 runs
# +0.46 through the greens, so a 0.8 mix stops at 0.48 and a 0.48 mix — which
# is what golden hour got — stops at 0.33, dead centre of green. The graded
# golden-hour palette came out `#bacbb9`, `#c3cfb6`, `#75836a`: an olive city.
# `cool()` gets away with it because it also desaturates by 45% and its inputs
# are far more saturated, so its greens land close enough to grey. These inputs
# are already near-neutral, so the hue path is the only thing you see.
#
# Desaturating first and then tinting the CHANNELS has no path to be wrong
# about: the result is grey plus a measured amount of blue.
#
# The coarse key already carries the classification, so the rule reads off it:
#   0-*    hue bin 0, 0-30 degrees — brick, terracotta. LEFT ALONE.
#   1-*-1  hue bin 1 AND saturated — warm precast, painted stucco. LEFT ALONE.
#   1-*-0  hue bin 1, near-neutral — THIS IS AUSTIN'S TAN, 47% of the city and
#          the thing make_hero_designs.py names. It is what grey concrete and
#          granite come out as when the default palette is a campus one, so it
#          is taken most of the way to neutral and given the cool tint.
#   n*     already neutral — a light cool cast, no more; overdoing it turns the
#          Dallas fabric into a blue city, which is a 1990s-videogame look.
#   5/6/7  green through blue — this is the tinted curtain wall, the material
#          downtown Dallas is actually made of. Kept saturated rather than
#          desaturated, because mirrored glass has a real colour, and given the
#          strongest tint.
#
# The tints are per-channel gains applied after the lightness is set, then the
# result is renormalised back to that lightness so a tint cannot smuggle in a
# value change. 1.06 on blue against 0.96 on red is about 4 units of RGB at
# mid-grey — enough to read as granite rather than as sand, small enough that it
# never reads as blue paint.
def temperature_for(key):
    """(sat_mul, (r, g, b) channel gains) for a coarse key. See RULE 2."""
    if key.startswith("0-"):
        # BRICK IS SATURATED UP, not left alone, and this is the one place the
        # "leave the warm family alone" rule is bent. Elected, `0-3-1` is
        # `#b79f8c` — a dusty rose at 13% saturation, which is what brick
        # averages to once a whole facade of it is meaned with its own mortar
        # and shadow. Rendered at 118 buildings it read as salmon stucco rather
        # than as brick. 1.2 puts it back at the saturation a brick wall
        # photographs at, without moving its hue or its value at all.
        return 1.20, (1.00, 1.00, 1.00)        # brick — warmer, not cooler
    if key.startswith("1-") and key.endswith("-1"):
        return 0.92, (1.00, 1.00, 1.00)        # warm precast — untouched
    if key.startswith("1-"):
        return 0.22, (0.975, 0.995, 1.04)      # Austin's tan -> granite
    if key.startswith("n"):
        return 0.70, (0.97, 0.995, 1.05)       # neutral -> a cool cast
    return 1.15, (0.955, 0.995, 1.06)          # green/cyan/blue -> tinted glass


def _regrade(hex_in, l_to, sat_mul, tint, tint_amount=1.0):
    r, g, b = (v / 255.0 for v in hex_to_rgb(hex_in))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    s = max(0.0, min(1.0, s * sat_mul))
    r, g, b = colorsys.hls_to_rgb(h, l_to, s)
    t = [1.0 + (v - 1.0) * tint_amount for v in tint]
    r, g, b = r * t[0], g * t[1], b * t[2]
    # Renormalise to the lightness that was asked for. Without this a tint on a
    # near-white bucket is a value change wearing a colour costume, and the
    # ladder's ordering — the one thing direct() is not allowed to break — could
    # move under it.
    l_got = colorsys.rgb_to_hls(min(1, max(0, r)), min(1, max(0, g)), min(1, max(0, b)))[1]
    if l_got > 0:
        k = l_to / l_got
        r, g, b = r * k, g * k, b * k
    return rgb_to_hex(*(min(1.0, max(0.0, c)) * 255 for c in (r, g, b)))


def direct(kept, rows):
    """Re-grade the elected colours. Buckets, index and stamps are untouched.

    `wg` (golden hour) and `wn` (night) take the SAME lightness move as `wd`,
    scaled, rather than being graded independently. That is not a nicety:
    js/facades.js repaints the same atlas image in place as the hour moves, so
    two buckets that swapped rank between times of day would make two buildings
    swap value with no camera motion to explain it.
    """
    pop = {}
    for r in rows:
        if r:
            pop[r["fb"]] = pop.get(r["fb"], 0) + 1
    total = sum(pop.values()) or 1
    # The centre the gain pivots about is POPULATION-WEIGHTED, so the tone most
    # of the city already wears stays where it is and the outliers travel. An
    # unweighted mean would move the 604-building bucket to make room for the
    # 8-building one, which is the whole city shifting to flatter one tail.
    centre = sum(pop.get(i, 0) * colorsys.rgb_to_hls(*[c / 255.0 for c in k["wd"]])[1]
                 for i, k in enumerate(kept)) / total

    out = []
    for i, k in enumerate(kept):
        sat_mul, tint = temperature_for(k["key"])
        l_day = colorsys.rgb_to_hls(*[c / 255.0 for c in k["wd"]])[1]
        l_day = max(L_MIN, min(L_MAX, centre + VALUE_SHIFT + VALUE_GAIN * (l_day - centre)))
        # GOLDEN HOUR keeps a little more light and a lot more warmth: the sun
        # is doing the warming, so the wall does not have to. The tint is cut to
        # 45% for that reason, and the +0.04 lift is what keeps the graded
        # fabric from going muddy beside the five heroes, which
        # js/heroes-dallas.js colours for TOD 0.50.
        l_gold = min(L_MAX, l_day + 0.04)
        # NIGHT is compressed toward black rather than graded, because an unlit
        # wall at night has no local value of its own — what varies is how much
        # skyglow it catches. Keeping 45% of the day's spread preserves the
        # ordering (see the docstring above) without reintroducing the thing
        # js/facades.js's own `wn` history block convicts: a wall brighter than
        # the sky behind it, which is a skyline with no silhouette.
        l_night = colorsys.rgb_to_hls(*[c / 255.0 for c in k["wn"]])[1]
        l_night = max(0.04, min(0.30, l_night * 0.55 + (l_day - centre) * 0.10))
        out.append({
            "wd": _regrade(rgb_to_hex(*k["wd"]), l_day, sat_mul, tint),
            # GOLDEN HOUR KEEPS ITS SATURATION, and this is the one place the
            # temperature rule is deliberately half-applied. Running the day's
            # `sat_mul` on `wg` too took the 604-building bucket's golden hour
            # from #c5b29b to #c1c1c4 — a neutral grey at the hour the whole
            # scene is warm — because the desaturation that makes a wall read as
            # granite at noon also strips the sunlight off it at six. So the
            # multiplier is lerped 45% back toward 1 for `wg` only. Buckets that
            # are being SATURATED rather than desaturated (the glass ones) are
            # left alone; there is nothing to give back.
            "wg": _regrade(rgb_to_hex(*k["wg"]), l_gold,
                           sat_mul + (1.0 - sat_mul) * 0.45 if sat_mul < 1 else sat_mul,
                           tint, 0.45),
            # Night goes further cool and flatter than day for the ordinary
            # Purkinje reason — an unlit surface at night reads blue — and
            # because after dark the WARM thing on a facade is the lit windows,
            # which js/facades.js draws from its own WINDOW_TONES.
            "wn": _regrade(rgb_to_hex(*k["wn"]), l_night, sat_mul * 0.8, tint, 1.6),
        })
    return out


# --------------------------------------------------------------------- main --
def report(kept, rows, palette):
    pop = {}
    for r in rows:
        if r:
            pop[r["fb"]] = pop.get(r["fb"], 0) + 1
    lines = []
    for i, k in enumerate(kept):
        el = rgb_to_hex(*k["wd"])
        if palette is None:
            lines.append("  %-7s n=%-5d %s  luma %3d   night %s"
                         % (k["key"], pop.get(i, 0), el, luma(hex_to_rgb(el)),
                            rgb_to_hex(*k["wn"])))
        else:
            lines.append("  %-7s n=%-5d %s (%3d)  ->  %s (%3d)   gold %s  night %s"
                         % (k["key"], pop.get(i, 0), el, luma(hex_to_rgb(el)),
                            palette[i]["wd"], luma(hex_to_rgb(palette[i]["wd"])),
                            palette[i]["wg"], palette[i]["wn"]))
    return "\n".join(lines)


def fold_stats(features, kept, rows):
    """Max/mean |luma| the palette moves a building from its own `wd`. The
    headline number this bake is judged on; see finding 2."""
    errs = [abs(luma(hex_to_rgb((f.get("properties") or {})["wd"])) - luma(kept[r["fb"]]["wd"]))
            for f, r in zip(features, rows) if r]
    errs.sort()
    n = len(errs)
    return {"mean": round(sum(errs) / n, 1), "p99": round(errs[int(0.99 * n)], 1),
            "max": round(errs[-1], 1), "over40": sum(1 for e in errs if e > 40)}


def main():
    date, feats = load_scene()
    allg, kept, index, rows, combos = elect(feats)

    if RAW:
        print("snapshot %s  features %d  groups %d  buckets %d  combos %d"
              "   [RAW — the browser election, unreserved and ungraded]"
              % (date, len(feats), len(index), len(kept), len(combos)))
        print(report(kept, rows, None))
        print("fold error vs own wd: %s" % json.dumps(fold_stats(feats, kept, rows)))
        return

    kept, index, notes = reserve(allg, kept, index)
    rows, combos = _stamp(feats, kept, index)
    palette = direct(kept, rows)

    if CHECK:
        print("snapshot %s  features %d  groups %d  buckets %d  combos %d"
              % (date, len(feats), len(index), len(kept), len(combos)))
        for n in notes:
            print("  reserved: %s" % n)
        print(report(kept, rows, palette))
        print("fold error vs own wd: %s" % json.dumps(fold_stats(feats, kept, rows)))
        return

    with open(OUT_PALETTE, "w", encoding="utf-8") as fh:
        json.dump({"snapshot": date, "palette": palette,
                   "buckets": {k: v for k, v in sorted(index.items())}},
                  fh, separators=(",", ":"))
    print(json.dumps({
        "snapshot": date,
        "groups": len(index),
        "palette_buckets": len(palette),
        "reserved": notes,
        "features_stamped": sum(1 for r in rows if r),
        "combos": len(combos),
        "fold_error": fold_stats(feats, kept, rows),
        "palette_kb": round(os.path.getsize(OUT_PALETTE) / 1024, 1),
        "note": "js/facades.js adopts this only when its snapshot matches "
                "manifest.latest, so THIS FILE MUST BE RE-BAKED WHENEVER THE "
                "SNAPSHOT ROLLS or the walls go quietly back to Austin's tans. "
                "`?bakedfacades=0` is the A/B.",
    }, indent=2))


if __name__ == "__main__":
    main()
