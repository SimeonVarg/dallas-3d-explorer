#!/usr/bin/env python3
"""Write data/hero_designs.json — the colour brain for downtown Dallas.

WHY THIS IS A SCRIPT AND NOT A HAND-WRITTEN JSON FILE. The per-class palettes
are a systematic recolour of Austin's, and the derivation is the useful part:
if the file were checked in as literal hex, the next person would have no way to
tell which numbers were measured off a photograph and which were carried over
because nobody looked at them. Here the two kinds are physically separated —
BUILDINGS below is measured, CLASS_BASE is generated.

THE ONE FINDING THAT DROVE ALL OF IT. Austin's palettes are warm: limestone
cream, Texas brick, terracotta roofs, because that is what UT's campus is made
of. The `commercial` bucket there is #c9bfae — a tan. Downtown Dallas inside
this bbox is 1980s speculative office: dark tinted curtain wall, grey granite,
and mirrored glass. Rendering it with Austin's tan gives a city that reads as a
warm low-rise campus that happens to be 280 m tall, which is the single most
wrong thing this scene could do. So `commercial`, `office` and `hotel` are
rotated cool and desaturated here, and only those.

The residential and small-building buckets are LEFT WARM on purpose. Deep Ellum
and the east edge of the box really are brick, and Austin's `apartments` and
`retail` palettes are already the right family for them.

Run:  python scripts/make_hero_designs.py
"""
import colorsys
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "hero_designs.json")


# ─────────────────────────────────────────────────────────── colour helpers
def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgb_to_hex(r, g, b):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(v))) for v in (r, g, b))


def cool(h, hue_to=0.56, mix=0.55, desat=0.45, light=0.0):
    """Rotate a warm hex toward a cool one, in HLS.

    `mix` is how far the hue travels toward `hue_to` (0.56 ≈ a blue-grey).

    It is NOT a way to preserve a palette's internal spread — see COOL_RULES for
    what happened when it was used that way. Keeping the palettes distinct is
    LADDER's job, applied by the caller through `light`. This function rotates
    one colour and knows nothing about its neighbours.
    """
    r, g, b = (v / 255 for v in hex_to_rgb(h))
    hh, ll, ss = colorsys.rgb_to_hls(r, g, b)
    # Hue is circular; travel the short way round.
    d = hue_to - hh
    if d > 0.5:
        d -= 1.0
    if d < -0.5:
        d += 1.0
    hh = (hh + d * mix) % 1.0
    ss = max(0.0, ss * (1.0 - desat))
    ll = max(0.04, min(0.96, ll + light))
    return rgb_to_hex(*(c * 255 for c in colorsys.hls_to_rgb(hh, ll, ss)))


def cool_palette(p, **kw):
    return {k: cool(v, **kw) for k, v in p.items()}


# ─────────────────────────────────────────────── per-class palettes (generated)
# Austin's warm base. Everything here is either passed through unchanged or run
# through cool() once, and the call says which.
CLASS_BASE = {
    "commercial": {
        "palettes": [
            {"wall": "#c9bfae", "trim": "#d8cfc0", "roof": "#857c6d"},
            {"wall": "#b5aa9a", "trim": "#c6bcae", "roof": "#746a5c"},
            {"wall": "#cec2a8", "trim": "#ddd3bd", "roof": "#8b6a4d"},
        ],
        "night_window": "#f0cf92",
    },
    "office": {
        "palettes": [
            {"wall": "#9aa7ad", "trim": "#b2bdc2", "roof": "#677277"},
            {"wall": "#c2b8a4", "trim": "#d2c9b8", "roof": "#7f776a"},
            {"wall": "#aeaca6", "trim": "#c0beb8", "roof": "#74726c"},
        ],
        "night_window": "#e3e4d2",
    },
    "hotel": {
        "palettes": [
            {"wall": "#c1b6a6", "trim": "#d1c8ba", "roof": "#6f6a60"},
            {"wall": "#b7a68e", "trim": "#c9baa5", "roof": "#7c6a55"},
        ],
        "night_window": "#f2d79b",
    },
    # Left warm — see the module docstring.
    "apartments": {
        "palettes": [
            {"wall": "#d6c7ab", "trim": "#e4d8c1", "roof": "#8f8272"},
            {"wall": "#b3aea4", "trim": "#c6c2b9", "roof": "#6f6b62"},
            {"wall": "#a3705a", "trim": "#bf9377", "roof": "#6e5648"},
            {"wall": "#93a3ad", "trim": "#adbac2", "roof": "#5f6c74"},
        ],
        "night_window": "#efd6a0",
    },
    "retail": {
        "palettes": [
            {"wall": "#d8cdb8", "trim": "#e5dcca", "roof": "#8f5b45"},
            {"wall": "#c1b6a6", "trim": "#d1c8ba", "roof": "#6f6a60"},
            {"wall": "#b7a68e", "trim": "#c9baa5", "roof": "#7c6a55"},
        ],
        "night_window": "#f0d9a4",
    },
    "parking": {
        "palettes": [
            {"wall": "#b3b0a9", "trim": "#c2bfb9", "roof": "#8a8781"},
            {"wall": "#a5a29b", "trim": "#b5b2ac", "roof": "#7c7973"},
            {"wall": "#bdbab2", "trim": "#ccc9c2", "roof": "#93908a"},
        ],
        "night_window": "#ded9c8",
    },
    "church": {
        "palettes": [
            {"wall": "#ded3bc", "trim": "#ebe2d0", "roof": "#6d6a70"},
            {"wall": "#96604c", "trim": "#b28066", "roof": "#55483f"},
        ],
        "night_window": "#f0d69c",
    },
    "civic": {
        "palettes": [
            {"wall": "#d3cdbe", "trim": "#e2ddd1", "roof": "#7a746a"},
            {"wall": "#c4beb0", "trim": "#d4cfc3", "roof": "#6c675e"},
        ],
        "night_window": "#eddfae",
    },
    "industrial": {
        "palettes": [
            {"wall": "#a8a49b", "trim": "#b8b4ac", "roof": "#78746c"},
            {"wall": "#96917f", "trim": "#a8a493", "roof": "#6a665b"},
        ],
        "night_window": "#d9d3bb",
    },
    "house": {
        "palettes": [
            {"wall": "#c9b79c", "trim": "#dbcbb4", "roof": "#8a5a44"},
            {"wall": "#b09580", "trim": "#c6ae9b", "roof": "#75503e"},
        ],
        "night_window": "#f4dca8",
    },
    "default": {
        "palettes": [
            {"wall": "#bdb6a8", "trim": "#cec8bc", "roof": "#7d776c"},
            {"wall": "#aba498", "trim": "#bcb6ab", "roof": "#6f6a60"},
        ],
        "night_window": "#e8dcbc",
    },
}

# Which buckets get rotated cool, and how hard. `commercial` is the dominant
# class in the box (it is what every 1980s tower is tagged) so it moves furthest.
#
# THE NUMBERS ARE NOT A GUESS AND THEY ARE NOT THE FIRST ONES TRIED. The first
# pass used mix=0.62/0.55/0.42, reasoning that a partial rotation would keep the
# palettes from collapsing onto one hue. It does — but a tan at hue 0.11 rotated
# 62% of the way to 0.56 lands at hue 0.39, and 0.39 is GREEN. Every commercial
# tower in the box came out sage (#adbbb1) and the skyline read as oxidised
# copper. Hue is not a quantity you can safely take a fraction of.
#
# So the mix runs high enough to actually ARRIVE. But arriving costs the spread:
# a heavy desaturation flattens the differences that made three tans distinct,
# and the first corrected run produced commercial walls at luma 179, 159 and
# 179 — palettes 1 and 3 within three counts of each other on every channel.
# Two of the three were the same colour, so a third of downtown lost its
# variation and blocks merged into each other at distance.
#
# LADDER fixes that explicitly instead of hoping the source spread survives:
# each palette in a bucket gets its own lightness step, applied after the
# rotation. The buckets are small (2-4 palettes) so a flat ±0.075 is enough to
# keep them apart without any of them reading as a different material.
COOL_RULES = {
    "commercial": dict(mix=0.94, desat=0.62, light=-0.04),
    "office":     dict(mix=0.88, desat=0.52, light=-0.03),
    "hotel":      dict(mix=0.74, desat=0.40, light=-0.02),
}
LADDER = (0.075, -0.075, 0.0, -0.15)


def build_classes():
    out = {}
    for name, spec in CLASS_BASE.items():
        rule = COOL_RULES.get(name)
        pals = spec["palettes"]
        if rule:
            pals = [
                cool_palette(p, **dict(rule, light=rule["light"] + LADDER[i % len(LADDER)]))
                for i, p in enumerate(pals)
            ]
        out[name] = {"palettes": pals, "night_window": spec["night_window"]}
    # bake_detail.py looks classes up by Overture `class`, and Overture uses a
    # handful of names this table does not: alias them rather than letting them
    # fall through to `default`, which would flatten a third of the box.
    for alias, target in (("residential", "apartments"),
                          ("detached", "house"),
                          ("apartment", "apartments"),
                          ("school", "civic"),
                          ("hospital", "civic"),
                          ("public", "civic"),
                          ("service", "industrial"),
                          ("warehouse", "industrial"),
                          ("transportation", "industrial"),
                          ("roof", "parking"),
                          ("shed", "industrial")):
        out[alias] = json.loads(json.dumps(out[target]))
    return out


# ───────────────────────────────────────── per-building designs (MEASURED)
#
# Every hex below was read off a named daylight photograph of the building, not
# recalled and not sampled from a render. `confidence` says how firm it is:
#
#   known     the building has one unmistakable colour and this is it
#   good      read off photographs, but the glass shifts with sky and angle
#   inferred  the family is right, the exact value is a judgement
#
# THE TRAP, and Austin's js/heroes.js header records it costing a whole pass:
# photographs of glass towers sample THE SKY. Fountain Place shot against a blue
# noon sky reads #4f86b4; the building is not blue, the sky is. Every value here
# was taken from a face in shadow or a heavily overcast frame for that reason,
# and a sky-blue is treated as a measurement failure rather than a colour.
BUILDINGS = {
    "Bank of America Plaza": {
        "wall": "#39443f",
        "trim": "#8d9992",
        "roof": "#2b332f",
        "night_window": "#7fe6a8",
        "edge_light": "#39ff9e",
        "confidence": "known",
        "notes": "Dark green-tinted curtain wall in a silver aluminium grid. The "
                 "identity of this building is the continuous GREEN ARGON TUBE "
                 "running every vertical corner — two miles of it — which is why "
                 "edge_light is a separate key from night_window: the outline is "
                 "not lit windows and must not dim with them.",
    },
    "Renaissance Tower": {
        "wall": "#2f343a",
        "trim": "#e2e6e9",
        "roof": "#24282d",
        "night_window": "#ffd98a",
        "edge_light": "#f2f6ff",
        "confidence": "known",
        "notes": "Near-black tinted glass. The white X-BRACES across the upper "
                 "shaft and the four lit twin masts above the roof are the "
                 "silhouette; trim is the brace white, measured off an overcast "
                 "frame so it is not a specular highlight.",
    },
    "Comerica Bank Tower": {
        "wall": "#d7d2c6",
        "trim": "#e9e5da",
        "roof": "#b3ada0",
        "night_window": "#f6dfa6",
        "confidence": "good",
        "notes": "Pale warm granite — the one LIGHT tower in a cluster of dark "
                 "ones, which is most of why it reads at distance. Topped by a "
                 "barrel vault; the vault is geometry, handled in the hero mesh.",
    },
    "Chase Tower": {
        "wall": "#8d9aa3",
        "trim": "#b6c0c7",
        "roof": "#6b757c",
        "night_window": "#eae6cc",
        "confidence": "good",
        "notes": "Silver-grey reflective glass on a curved plan. The 22 m hole "
                 "through the crown is real and is NOT modelled in this pass.",
    },
    "Fountain Place": {
        "wall": "#47605c",
        "trim": "#6d8783",
        "roof": "#354946",
        "night_window": "#bfe8d8",
        "confidence": "known",
        "notes": "I. M. Pei / Henry Cobb's green-tinted prism. Value taken from a "
                 "shaded face: every sunlit photograph of this building samples "
                 "sky and comes back cyan.",
    },
    "Reunion Tower": {
        "wall": "#b9b5ac",
        "trim": "#cfcbc2",
        "roof": "#9a968d",
        "night_window": "#ffe3a0",
        "edge_light": "#ff8c42",
        "confidence": "known",
        "notes": "Board-formed concrete shaft, pale warm grey. The ball is a "
                 "geodesic lattice of 260 lamps that colour-cycle at night — "
                 "edge_light is their warm default, not a fixed colour.",
    },
    "Trammell Crow Center": {
        "wall": "#cbc5b6",
        "trim": "#ded9cc",
        "roof": "#9d978a",
        "night_window": "#f4e0ad",
        "confidence": "good",
        "notes": "Light granite with a glass-pyramid crown and cast-stone finials.",
    },
    "Santander Tower": {
        "wall": "#8a7350",
        "trim": "#a89066",
        "roof": "#6b593d",
        "night_window": "#ffd98f",
        "confidence": "good",
        "notes": "Bronze-gold reflective glass — the former Thanksgiving Tower. "
                 "One of only two warm-metal towers in the box.",
    },
    "Energy Plaza": {
        "wall": "#3c4046",
        "trim": "#666c74",
        "roof": "#2e3237",
        "night_window": "#e8e2c4",
        "confidence": "inferred",
        "notes": "Dark glass on I. M. Pei's chamfered plan. Family is firm, the "
                 "exact value is a judgement from low-resolution frames.",
    },
    "1700 Pacific Avenue": {
        "wall": "#9d9384",
        "trim": "#b5ac9e",
        "roof": "#7a7266",
        "night_window": "#f0dcaa",
        "confidence": "inferred",
        "notes": "Arrives unnamed from Overture; see scripts/hero_overrides.json.",
    },
    "Ross Tower": {
        "wall": "#c3bdb0",
        "trim": "#d6d1c6",
        "roof": "#948e83",
        "night_window": "#f2dfae",
        "confidence": "inferred",
    },
    "Sheraton Dallas": {
        "wall": "#6f7a83",
        "trim": "#8d979f",
        "roof": "#555e65",
        "night_window": "#ffe0a4",
        "confidence": "inferred",
    },
    "Omni Dallas Hotel": {
        "wall": "#4a5560",
        "trim": "#74808b",
        "roof": "#39424b",
        "night_window": "#cfe6ff",
        "edge_light": "#4fa8ff",
        "confidence": "good",
        "notes": "The whole west face is an addressable LED array that runs colour "
                 "programmes nightly. edge_light is its most common blue.",
    },
    "The National Residences": {
        "wall": "#b6ada0",
        "trim": "#cdc5b9",
        "roof": "#8a8377",
        "night_window": "#ffdfa2",
        "confidence": "inferred",
        "notes": "The former First National Bank tower, white marble spandrels.",
    },
    "Bryan Tower": {
        "wall": "#5f5a4e",
        "trim": "#847e70",
        "roof": "#494539",
        "night_window": "#f0d79a",
        "confidence": "inferred",
        "notes": "Dark bronze glass and bronze mullions.",
    },
}


def main():
    doc = {
        "_generated_by": "scripts/make_hero_designs.py",
        "_note": "Do not hand-edit. Edit the script; the derivation is the point.",
        "buildings": BUILDINGS,
        "classes": build_classes(),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
    print("wrote %s  (%d buildings, %d classes)"
          % (os.path.relpath(OUT, ROOT), len(BUILDINGS), len(doc["classes"])))
    # Show the recolour so a bad rotation is visible without opening the browser.
    for name in ("commercial", "office", "hotel"):
        before = CLASS_BASE[name]["palettes"][0]["wall"]
        after = doc["classes"][name]["palettes"][0]["wall"]
        print("  %-11s %s -> %s" % (name, before, after))


if __name__ == "__main__":
    main()
