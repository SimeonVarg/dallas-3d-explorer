-- Extract building footprints + LiDAR-derived heights from Overture Maps for the
-- project bounding box, and write GeoJSON. Run via DuckDB with variables bound by
-- extract.sh (bbox + release path). See scripts/extract.sh.
--
-- Height accuracy comes from Overture's `height` (inferred from USGS 3DEP LiDAR).
-- We keep num_floors and class so the app can build a fallback chain and colorize.

INSTALL spatial;  LOAD spatial;
INSTALL httpfs;   LOAD httpfs;
SET s3_region = 'us-west-2';

COPY (
    SELECT
        id,                                                -- Overture GERS id: stable
                                                             -- across releases, used to
                                                             -- match buildings between
                                                             -- snapshots for the diff/
                                                             -- change-animation feature.
        names.primary               AS name,
        height                      AS overture_height,   -- metres, LiDAR-derived (may be NULL)
        num_floors                  AS num_floors,        -- may be NULL
        class                       AS building_class,
        -- Current Overture releases, read with the spatial extension loaded,
        -- already decode this column to a native GEOMETRY in CRS84 (lon/lat),
        -- so no ST_GeomFromWKB conversion is needed -- pass it straight through.
        -- (CRS84 is lon/lat order, exactly what GeoJSON/RFC7946 wants.)
        geometry                    AS geometry
    FROM read_parquet(
        getenv('OVERTURE_S3') || '/theme=buildings/type=building/*.parquet',
        hive_partitioning = 1
    )
    -- Overture rows carry a precomputed bbox struct; filtering on it prunes S3
    -- reads so only the tiles overlapping our area are scanned.
    WHERE bbox.xmin >= CAST(getenv('BBOX_MIN_LON') AS DOUBLE)
      AND bbox.xmax <= CAST(getenv('BBOX_MAX_LON') AS DOUBLE)
      AND bbox.ymin >= CAST(getenv('BBOX_MIN_LAT') AS DOUBLE)
      AND bbox.ymax <= CAST(getenv('BBOX_MAX_LAT') AS DOUBLE)
)
TO '__OUTPUT_PATH__'
WITH (FORMAT gdal, DRIVER 'GeoJSON', LAYER_CREATION_OPTIONS 'RFC7946=YES');
