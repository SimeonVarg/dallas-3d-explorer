#!/usr/bin/env python3
"""Rebuild data/manifest.json from what's actually on disk.

The front end reads this file to build the date picker (data.snapshots) and to
know which before/after change-animations are available (data.diffs). Run
after every pipeline run, once the new snapshot (and, if applicable, its diff
against the previous snapshot) has been written.
"""
import json
import os

DATA_DIR = "data"
SNAPSHOTS_DIR = os.path.join(DATA_DIR, "snapshots")
DIFFS_DIR = os.path.join(DATA_DIR, "diffs")
MANIFEST_PATH = os.path.join(DATA_DIR, "manifest.json")


# The front end fetches these directly; a snapshot missing either renders as
# an empty map, so it must not be published in the manifest.
REQUIRED_FILES = ("buildings.detailed.geojson", "parts.detailed.geojson")


def list_snapshots():
    if not os.path.isdir(SNAPSHOTS_DIR):
        return []
    snapshots = []
    for d in sorted(os.listdir(SNAPSHOTS_DIR)):
        path = os.path.join(SNAPSHOTS_DIR, d)
        if not os.path.isdir(path):
            continue
        missing = [f for f in REQUIRED_FILES if not os.path.isfile(os.path.join(path, f))]
        if missing:
            print(f"  [skip] {d}: missing {', '.join(missing)} — run bake_detail.py {d}")
            continue
        snapshots.append(d)
    return snapshots


def list_diffs():
    if not os.path.isdir(DIFFS_DIR):
        return []
    diffs = []
    for fname in sorted(os.listdir(DIFFS_DIR)):
        if not fname.endswith(".geojson") or "_to_" not in fname:
            continue
        from_date, to_date = fname[: -len(".geojson")].split("_to_")
        with open(os.path.join(DIFFS_DIR, fname)) as f:
            changed_count = len(json.load(f)["features"])
        diffs.append(
            {
                "from": from_date,
                "to": to_date,
                "file": f"diffs/{fname}",
                "changed_count": changed_count,
            }
        )
    return diffs


# Keys this script does NOT own. It rebuilds the manifest from disk, so anything
# written by another pass would be silently deleted on the next pipeline run —
# which is how a provenance record rots without anyone noticing. Carry them
# through instead.
FOREIGN_KEYS = ("outer_ring",)


def main():
    snapshots = list_snapshots()
    manifest = {
        "snapshots": snapshots,
        "latest": snapshots[-1] if snapshots else None,
        "diffs": list_diffs(),
    }
    carried = []
    if os.path.isfile(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH) as f:
                old = json.load(f)
            for k in FOREIGN_KEYS:
                if k in old:
                    manifest[k] = old[k]
                    carried.append(k)
        except Exception as exc:  # noqa: BLE001 -- a corrupt manifest is rebuilt
            print(f"  [warn] could not read the old manifest ({exc})")
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"manifest.json: {len(snapshots)} snapshot(s), {len(manifest['diffs'])} diff(s)"
          + (f", carried forward: {', '.join(carried)}" if carried else ""))


if __name__ == "__main__":
    main()
