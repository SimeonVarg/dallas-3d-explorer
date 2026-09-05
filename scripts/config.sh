#!/usr/bin/env bash
# Shared configuration for the data pipeline.
# Edit these values to change the modeled area or the Overture release used.

# Bounding box: downtown Dallas core.
#
# Chosen so the five hand-built landmarks and the elevated highway structure all
# fall inside one box, because a hero that sits on the edge gets its footprint
# clipped by the Overture bbox filter and arrives as half a building:
#
#   Reunion Tower            -96.8089, 32.7755   SW corner of the core
#   Dealey Plaza             -96.8081, 32.7787
#   Mixmaster (I-30/I-35E)   -96.8100, 32.7745   the lowest thing worth keeping
#   Bank of America Plaza    -96.8035, 32.7807
#   Fountain Place           -96.8025, 32.7855
#   Renaissance Tower        -96.7995, 32.7797
#   Comerica Bank Tower      -96.8012, 32.7823
#   Klyde Warren Park        -96.8013, 32.7893   deck over Woodall Rodgers
#   Deep Ellum edge          -96.7840, 32.7840   east backdrop
#
# That is ~3.3 km east-west and ~3.1 km north-south. Austin's box was 2.5 x 2.2
# km, so this is about 1.9x the area. Kept deliberately: downtown Dallas is a
# tight cluster of towers and cutting it smaller loses either Reunion Tower or
# Klyde Warren Park, and both are the reason to build this.
export BBOX_MIN_LON="-96.8150"
export BBOX_MIN_LAT="32.7700"
export BBOX_MAX_LON="-96.7800"
export BBOX_MAX_LAT="32.7980"

# Scene origin — the camera's home and the local metre frame's anchor. Set to
# the middle of the tower cluster rather than the bbox centre, so the default
# view opens on the skyline instead of on a parking lot.
export SCENE_CENTER_LON="-96.8010"
export SCENE_CENTER_LAT="32.7820"

# Overture Maps release to pull. Overture ships ~monthly under versioned S3
# folders. Default "latest" makes the extractor auto-detect the newest release
# that actually exists in the bucket, so this never breaks when an old release
# ages out. Pin a specific YYYY-MM-DD.N tag only if you want a fixed source.
export OVERTURE_RELEASE="${OVERTURE_RELEASE:-latest}"

# Verified-good release used if auto-detection can't reach the bucket. Bump this
# occasionally from https://docs.overturemaps.org/release/latest/
export OVERTURE_RELEASE_FALLBACK="2026-06-17.0"

# Public bucket (no credentials required).
export OVERTURE_BUCKET="s3://overturemaps-us-west-2/release"

# Every pipeline run produces a dated SNAPSHOT, never overwrites a previous one.
export SNAPSHOT_DATE="${SNAPSHOT_DATE:-$(date -u +%Y-%m-%d)}"

# Output locations.
export DATA_DIR="data"
export SNAPSHOT_DIR="${DATA_DIR}/snapshots/${SNAPSHOT_DATE}"
export BUILDINGS_GEOJSON="${SNAPSHOT_DIR}/buildings.geojson"
export BUILDINGS_ENRICHED="${SNAPSHOT_DIR}/buildings.enriched.geojson"
export BUILDINGS_PMTILES="${SNAPSHOT_DIR}/dallas.pmtiles"
export MANIFEST_JSON="${DATA_DIR}/manifest.json"
export DIFFS_DIR="${DATA_DIR}/diffs"

# Default storey height (metres) for the levels->height fallback.
#
# 3.2 m is Austin's number and it is a RESIDENTIAL floor. Downtown Dallas inside
# this box is commercial office almost everywhere, and an office floor is taller
# — 3.9 m slab-to-slab is the figure that reproduces the published heights of
# the towers here whose floor counts are known. Austin's own bake_heroes.py
# header records the same trap in reverse: three UT lab buildings came out at
# 55% of their real height because a residential 2.8 m was applied to them.
export METERS_PER_LEVEL="3.9"
