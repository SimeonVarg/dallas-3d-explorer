#!/usr/bin/env python3
"""Step 2 of the data pipeline: enrich Overture footprints.

Takes the raw Overture GeoJSON (footprints + LiDAR-derived heights) and produces
an enriched GeoJSON where every building has:

  - final_height : metres, from a documented fallback chain
  - name         : Overture name, else nearest OSM name, else None
  - source_height: which source the height came from (for QA)

Name/brand come from OpenStreetMap via Overpass (OSM is the gold standard for
labels). Heights prefer Overture (LiDAR-derived), then OSM tags, then
levels x METERS_PER_LEVEL, then a class default.

scripts/hero_overrides.json is an optional, pre-filled list of known corrections
(a name + a height number) for a few landmark buildings where the automatic
sources are wrong or missing. It's plain data, not a modeling step -- editing a
number in that file, or leaving it alone, is the only "manual" input this
pipeline ever needs.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from shapely.geometry import shape, Point  # pip install shapely
from shapely.strtree import STRtree

MPL = float(os.environ.get("METERS_PER_LEVEL", "3.2"))
BBOX = (
    float(os.environ["BBOX_MIN_LAT"]),
    float(os.environ["BBOX_MIN_LON"]),
    float(os.environ["BBOX_MAX_LAT"]),
    float(os.environ["BBOX_MAX_LON"]),
)
IN = os.environ["BUILDINGS_GEOJSON"]
OUT = os.environ["BUILDINGS_ENRICHED"]

# Sensible default heights (m) when a building has no height signal at all.
CLASS_DEFAULT = {
    "residential": 9.0,
    "apartments": 18.0,
    "commercial": 12.0,
    "retail": 6.0,
    "education": 12.0,
    "civic": 12.0,
    "industrial": 8.0,
}
FALLBACK_DEFAULT = 8.0


def overpass_buildings():
    """Fetch OSM buildings (name/brand/height/levels) for the bbox."""
    s, w, n, e = BBOX
    query = f"""
    [out:json][timeout:120];
    (way["building"]({s},{w},{n},{e});
     relation["building"]({s},{w},{n},{e}););
    out tags center;
    """
    # A User-Agent IS REQUIRED. Without one, urllib sends "Python-urllib/3.9"
    # and overpass-api.de answers 406 Not Acceptable — not 429, not 403, so it
    # does not read as a rate limit or a block, and enrich.py's own best-effort
    # handler swallows it and reports "continuing without OSM names". The whole
    # run then succeeds with 349 names instead of ~900 and nothing says why.
    # The OSM API usage policy asks for a contactable identifier; this is it.
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=b"data=" + urllib.parse.quote(query).encode(),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "dallas-3d-explorer/1.0 "
                          "(+https://github.com/SimeonVarg/dallas-3d-explorer)",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.load(r)

    pts, recs = [], []
    for el in data.get("elements", []):
        c = el.get("center") or {}
        if "lat" not in c:
            continue
        tags = el.get("tags", {})
        pts.append(Point(c["lon"], c["lat"]))
        recs.append(tags)
    return pts, recs


def osm_height(tags):
    for key in ("height", "building:height"):
        if key in tags:
            try:
                return float(str(tags[key]).split()[0]), "osm_height"
            except ValueError:
                pass
    for key in ("building:levels", "levels"):
        if key in tags:
            try:
                return float(tags[key]) * MPL, "osm_levels"
            except ValueError:
                pass
    return None, None


def main():
    with open(IN) as f:
        fc = json.load(f)

    heroes = {}
    hero_path = "scripts/hero_overrides.json"
    if os.path.exists(hero_path):
        with open(hero_path) as f:
            heroes = {h["match_name"].lower(): h for h in json.load(f)}

    # OSM names are enrichment, not essential (heights come from Overture), and
    # the public Overpass API is occasionally flaky/rate-limited. Don't let a
    # transient Overpass failure kill the whole pipeline -- fall back to no OSM
    # names and carry on with the Overture data we already have.
    print("Querying Overpass for OSM names/heights...", file=sys.stderr)
    try:
        osm_pts, osm_tags = overpass_buildings()
    except Exception as exc:  # noqa: BLE001 -- best-effort enrichment
        print(f"  WARNING: Overpass query failed ({exc}); "
              f"continuing without OSM names.", file=sys.stderr)
        osm_pts, osm_tags = [], []
    tree = STRtree(osm_pts) if osm_pts else None

    def nearest_osm(geom):
        if tree is None:
            return {}
        c = geom.centroid
        idx = tree.nearest(c)
        # STRtree.nearest returns an INDEX in shapely 2.x and a GEOMETRY in 1.x.
        #
        # The 2.x index is a numpy.int64, and `isinstance(numpy.int64, int)` is
        # False on Windows — so the original `if isinstance(idx, int)` test took
        # the 1.x branch and bound `pt` to the integer itself. The failure is
        # not a wrong name; it is `TypeError: One of the arguments is of
        # incorrect type` out of shapely.contains, several frames away from the
        # line that chose wrong.
        #
        # numbers.Integral covers both plain int and every numpy integer width,
        # so the version test is now on the RETURNED KIND rather than on a
        # concrete type. A geometry has `.geom_type`; an index does not.
        if hasattr(idx, "geom_type"):          # shapely 1.x — got a geometry
            pt = idx
            i = osm_pts.index(pt)
        else:                                  # shapely 2.x — got an index
            i = int(idx)
            pt = osm_pts[i]
        # Only trust the match if the OSM node sits inside/near this footprint.
        # 1e-4 degrees is ~11 m at this latitude: close enough that the node is
        # this building's, far enough to survive a centroid that sits in a
        # courtyard.
        if geom.contains(pt) or geom.distance(pt) < 1e-4:
            return osm_tags[i]
        return {}

    n_over = n_osm = n_levels = n_default = n_hero = 0
    for feat in fc["features"]:
        geom = shape(feat["geometry"])
        p = feat["properties"]
        tags = nearest_osm(geom)

        name = p.get("name") or tags.get("name") or tags.get("brand")

        # Height fallback chain.
        height = p.get("overture_height")
        source = "overture" if height else None
        if not height:
            h, src = osm_height(tags)
            if h:
                height, source = h, src
                n_osm += 1 if src == "osm_height" else 0
                n_levels += 1 if src == "osm_levels" else 0
        else:
            n_over += 1
        if not height and p.get("num_floors"):
            height, source = float(p["num_floors"]) * MPL, "overture_floors"
        if not height:
            height = CLASS_DEFAULT.get(p.get("building_class"), FALLBACK_DEFAULT)
            source = "class_default"
            n_default += 1

        # A known-correction override (scripts/hero_overrides.json) wins if present.
        if name and name.lower() in heroes:
            hero = heroes[name.lower()]
            height = hero.get("height", height)
            name = hero.get("display_name", name)
            source = "hero_override"
            n_hero += 1

        p.update(
            name=name,
            final_height=round(float(height), 1),
            source_height=source,
        )

    with open(OUT, "w") as f:
        json.dump(fc, f)

    print(
        f"Enriched {len(fc['features'])} buildings -> {OUT}\n"
        f"  heights: overture={n_over} osm_h={n_osm} osm_levels={n_levels} "
        f"default={n_default} hero_overrides={n_hero}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
