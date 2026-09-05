#!/usr/bin/env bash
# Step 3 of the data pipeline: pack the big scene layers into PMTiles archives
# the app loads directly from GitHub Pages (no server, no tile requests).
# Requires tippecanoe (>= 2.x, which writes .pmtiles natively).
#
# WHY THIS GREW BEYOND BUILDINGS.
#
# A first-time visitor downloads 28 MB across 26 files before the city appears,
# and every one of those files is the WHOLE CITY, fetched whether or not the
# camera can see it. That is the ceiling on how much detail this project can
# ever have: adding a nicer roofscape or more props makes the site slower for
# everyone. Tiles break that trade — the browser fetches only the tiles under
# the camera, so detail stops costing load time.
#
# The five layers below are 20 MB of the 28 and, crucially, they are the EASY
# 20 MB. Each is handed to MapLibre as a plain `addSource({type:'geojson',
# data:<url>})` with no JavaScript touching it first:
#
#     trees.geojson             9.13 MB   js/app.js
#     roads.geojson             3.70 MB   js/ground.js
#     outer_ring.geojson        2.59 MB   js/outer.js
#     roofscape.detail.geojson  2.27 MB   js/roofs.js
#     props.geojson             2.19 MB   js/props.js
#
# BUILDINGS ARE DELIBERATELY DIFFERENT AND STAY LAST. js/app.js runs passes over
# the whole building collection before it draws: quantiseFacades() clusters
# window colours across all ~3,000 buildings and elects the 14 most populous,
# mergeCapitolScene() splices in 604 more, applyUnion24() rewrites a footprint,
# and the label pass de-duplicates names globally. None of that survives being
# cut into tiles — a tile of West Campus and a tile of downtown would each elect
# their own 14 tones against one shared atlas. That work has to move into the
# Python bake first. It is also only 1.41 MB, five per cent of the payload, so
# it is the last thing worth doing, not the first.
#
# TWO SETTINGS THAT ARE NOT DEFAULTS AND MUST NOT BECOME THEM:
#
#   --maximum-zoom=16 caps every archive at z16. That cap is what fixed the
#   city-wide motion flicker (fill-extrusion-pattern is TILE-anchored and
#   cross-fades between zoom levels; window.PATTERN_TILING pins the GeoJSON
#   sources to the same 16). Lose it and the flicker comes back.
#
#   --simplification=1 --no-simplification-of-shared-nodes, because tippecanoe
#   SMOOTHS GEOMETRY AT LOW ZOOMS BY DEFAULT. That is a visual-quality change
#   hiding inside a delivery change, and it is the one thing here that could
#   make the city look worse — rounded-off corners on distant buildings. 1 is
#   tippecanoe's minimum, not its default.
#
#   -b0 (zero buffer) is NOT used. Extrusions crossing a tile seam need the
#   buffer or they get clipped mid-wall.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/config.sh

mkdir -p "$(dirname "${BUILDINGS_PMTILES}")"

# Shared flags. --no-feature-limit and --no-tile-size-limit because this is a
# dense city and tippecanoe's defaults would silently DROP features to hit a
# size target — a thinned city that looks fine in a screenshot and is missing
# a hundred trees is the worst possible failure here.
TIPPE_COMMON=(
  --force
  --minimum-zoom=13
  --maximum-zoom=16
  --no-feature-limit
  --no-tile-size-limit
  --preserve-input-order
  --simplification=1
  --no-simplification-of-shared-nodes
  --buffer=16
)

# DISTANT HORIZONS — and the two levers that turned out to be no-ops.
#
# Simeon asked for far-away things to be scaled down: "thats kinda what i had in
# mind with the distant horizons mod". Two obvious knobs were tried and MEASURED
# before this one, and both did exactly nothing:
#
#   --simplification=4/8/12   Built all three in CI. Byte-identical archives,
#                             "no tile changes" three times. It removes VERTICES
#                             and this geometry has none spare: trees and props
#                             are polygons of 8 points, the outer ring's bake
#                             already removed 85% of its vertices, and the
#                             far-field roads were simplified 5x harder at fetch.
#
#   --drop-rate / -B /        Changed the archive by TWELVE BYTES — the rate
#   --drop-densest-as-needed  recorded in the header. These drop POINTS, or drop
#                             only when a tile busts a limit, and this script
#                             sets --no-feature-limit --no-tile-size-limit on
#                             purpose. Nothing ever triggers them.
#
# What works is a zoom-conditional FEATURE FILTER on `d`, the keep-order the
# bake already writes on every tree and prop — biased so the big live oaks sort
# first. Everything is kept at z16 and closer; below that only the top KEEP
# fraction is even put in the tile.
#
#   trees   2.55 MB -> 1.71 MB      props   0.42 MB -> 0.26 MB     at KEEP=0.35
#
# Measured visually at z14.2 and at street level: 0.01% of pixels differ by more
# than 12/255 high up, and street level is untouched by construction. Part of why
# it is invisible is that js/lod.js has ALREADY dropped the canopy tier at that
# altitude — the two mechanisms agree, which is the point.
#
# Only trees and props. Roads, the outer ring and the roofscape are structure;
# dropping every third road is a hole in the city, not a level of detail.
SCATTER_KEEP="${SCATTER_KEEP:-0.35}"
scatter_filter () {   # $1 = layer name
  printf '{"%s":["any",[">=","$zoom",16],["<=","d",%s]]}' "$1" "${SCATTER_KEEP}"
}

tile_layer () {
  local src="$1" out="$2" layer="$3" extra=("${@:4}")
  if [ ! -f "${src}" ]; then
    echo "skip ${src} (not present)"
    return 0
  fi
  echo "Building ${out} from ${src}"
  # ${extra[@]+...} because set -u treats an empty array reference as unbound:
  # the layers that pass no extra flags aborted the whole script on line 1.
  tippecanoe -o "${out}" --layer="${layer}" "${TIPPE_COMMON[@]}" ${extra[@]+"${extra[@]}"} "${src}"
  ls -lh "${out}" | awk '{print "  ->", $5, $9}'
}

# 1. Buildings, into the snapshot, as before. Nothing loads this yet.
echo "== buildings =="
tile_layer "${BUILDINGS_ENRICHED}" "${BUILDINGS_PMTILES}" "buildings"

# 2. The five big scene layers, into data/tiles/ rather than the snapshot —
# they are not snapshot-dated, they are rebuilt from whatever is in data/.
echo
echo "== scene layers =="
mkdir -p "${DATA_DIR}/tiles"
tile_layer "${DATA_DIR}/trees.geojson"            "${DATA_DIR}/tiles/trees.pmtiles"      "trees" -j "$(scatter_filter trees)"
tile_layer "${DATA_DIR}/roads.geojson"            "${DATA_DIR}/tiles/roads.pmtiles"      "roads"
tile_layer "${DATA_DIR}/outer_ring.geojson"       "${DATA_DIR}/tiles/outer.pmtiles"      "outer"
tile_layer "${DATA_DIR}/roofscape.detail.geojson" "${DATA_DIR}/tiles/roofdetail.pmtiles" "roofdetail"
tile_layer "${DATA_DIR}/props.geojson"            "${DATA_DIR}/tiles/props.pmtiles"      "props" -j "$(scatter_filter props)"

echo
echo "Done. Totals:"
# `du` exits NON-ZERO on a missing path, and ${BUILDINGS_PMTILES} is missing on
# every run between 00:00 UTC and that day's first build-data.yml — config.sh
# dates the snapshot from `date -u`, so at 01:12 UTC it points at a directory
# that only `mkdir -p` has ever touched. With `set -euo pipefail` (line 50) and
# `2>/dev/null` hiding the reason, the LAST LINE of a completely successful
# tiling run failed the job, the Commit step never ran, and the archives that
# had just been built were thrown away. Two lanes lost a tile build to this on
# the night of 2026-08-02 before anyone read past "Done. Totals:".
#
# So: total only the files that are actually there, and let du's exit code
# mean something again.
shopt -s nullglob
_totals=("${DATA_DIR}/tiles"/*.pmtiles)
[ -f "${BUILDINGS_PMTILES}" ] && _totals+=("${BUILDINGS_PMTILES}")
if [ ${#_totals[@]} -gt 0 ]; then
  du -ch "${_totals[@]}" | tail -1
else
  echo "  (no archives built)"
fi
