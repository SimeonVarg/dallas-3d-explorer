#!/usr/bin/env python3
"""Compare two enriched building snapshots and write a diff GeoJSON.

Every pipeline run saves a new dated snapshot (see scripts/config.sh /
SNAPSHOT_DATE) instead of overwriting the last one. This script matches
buildings between two snapshots by their Overture id (stable across Overture
releases) and records what changed: a building appeared, disappeared, or its
height changed by more than HEIGHT_CHANGE_THRESHOLD_M.

The output is what the front end uses for the "what changed" view: fly to a
changed building and animate old_height -> new_height.

Usage:
    diff_snapshots.py <old_enriched.geojson> <new_enriched.geojson> <out.geojson>
"""
import json
import sys

HEIGHT_CHANGE_THRESHOLD_M = 1.0


def load_by_id(path):
    with open(path) as f:
        fc = json.load(f)
    return {feat["properties"]["id"]: feat for feat in fc["features"]}


def make_change(feat, change_type, old_height, new_height):
    return {
        "type": "Feature",
        "geometry": feat["geometry"],
        "properties": {
            "id": feat["properties"]["id"],
            "name": feat["properties"].get("name"),
            "change_type": change_type,   # "added" | "removed" | "height_changed"
            "old_height": old_height,
            "new_height": new_height,
        },
    }


def main():
    if len(sys.argv) != 4:
        sys.exit(f"usage: {sys.argv[0]} <old.geojson> <new.geojson> <out.geojson>")
    old_path, new_path, out_path = sys.argv[1:4]

    old = load_by_id(old_path)
    new = load_by_id(new_path)

    changes = []
    for bid, feat in new.items():
        if bid not in old:
            changes.append(make_change(feat, "added", None, feat["properties"]["final_height"]))
        else:
            old_h = old[bid]["properties"]["final_height"]
            new_h = feat["properties"]["final_height"]
            if abs(new_h - old_h) >= HEIGHT_CHANGE_THRESHOLD_M:
                changes.append(make_change(feat, "height_changed", old_h, new_h))

    for bid, feat in old.items():
        if bid not in new:
            changes.append(make_change(feat, "removed", feat["properties"]["final_height"], None))

    with open(out_path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": changes}, f)

    print(f"{len(changes)} changed building(s) -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
