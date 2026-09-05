#!/usr/bin/env python3
"""Step 1 of the data pipeline: pull Overture buildings for the bbox into GeoJSON.

WHY THIS IS PYTHON AND AUSTIN'S IS BASH. The Austin repo shells out to the
`duckdb` CLI (`scripts/extract.sh`). That binary is not on the Windows machine
this repo was started on, but the `duckdb` PYTHON package is, and it is the same
engine with the same spatial + httpfs extensions. So this script is a port, not
a rewrite: the SQL in scripts/extract_overture.sql is unchanged and is read from
disk, exactly as extract.sh reads it.

Keeping the SQL in its own file matters. It is the part that has to stay in step
with Overture's schema, and a schema change should show up as a diff to one file
rather than as a string edit inside a driver.

Usage:
    python scripts/extract.py                 # bbox + release from config.sh
    SNAPSHOT_DATE=2026-01-01 python scripts/extract.py
"""
import os
import re
import subprocess
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_PATH = os.path.join(REPO, "scripts", "extract_overture.sql")
CONFIG_SH = os.path.join(REPO, "scripts", "config.sh")

BUCKET_LIST_URL = (
    "https://overturemaps-us-west-2.s3.amazonaws.com/"
    "?list-type=2&prefix=release/&delimiter=/"
)


def load_config():
    """Read scripts/config.sh by sourcing it, so there is ONE definition of the
    bbox. Parsing the file with a regex was the first version and it silently
    dropped `${VAR:-default}` expansions, which is how SNAPSHOT_DATE came out as
    the literal string `${SNAPSHOT_DATE:-$(date -u +%Y-%m-%d)}` and every
    snapshot landed in a directory with a `$` in its name."""
    out = subprocess.run(
        ["bash", "-c", 'set -a; source "%s"; env' % CONFIG_SH.replace("\\", "/")],
        capture_output=True, text=True, check=True,
    ).stdout
    cfg = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            cfg[k] = v
    return cfg


def resolve_release(cfg):
    """'latest' -> newest release folder that actually exists in the bucket.

    Overture removes old releases. Pinning a tag in config.sh and forgetting it
    is how this breaks six months later with a 404 that reads like a network
    fault, so the default auto-detects and the pin is opt-in."""
    rel = cfg.get("OVERTURE_RELEASE", "latest")
    if rel != "latest":
        return rel
    try:
        with urllib.request.urlopen(BUCKET_LIST_URL, timeout=30) as r:
            body = r.read().decode("utf-8", "replace")
        found = sorted(set(re.findall(r"release/(\d{4}-\d{2}-\d{2}\.\d+)/", body)))
        if found:
            print("Auto-detected latest Overture release: %s" % found[-1])
            return found[-1]
    except Exception as e:
        print("Could not auto-detect release (%s)" % e)
    fb = cfg["OVERTURE_RELEASE_FALLBACK"]
    print("Using fallback release: %s" % fb)
    return fb


def main():
    cfg = load_config()
    release = resolve_release(cfg)

    snapshot_dir = os.path.join(REPO, cfg["SNAPSHOT_DIR"])
    os.makedirs(snapshot_dir, exist_ok=True)
    out_path = os.path.join(REPO, cfg["BUILDINGS_GEOJSON"])

    # The SQL reads the bbox and the S3 path through getenv(), the same way it
    # does under extract.sh. Set them in THIS process's environment before the
    # DuckDB connection is opened.
    os.environ["OVERTURE_S3"] = "%s/%s" % (cfg["OVERTURE_BUCKET"], release)
    for k in ("BBOX_MIN_LON", "BBOX_MIN_LAT", "BBOX_MAX_LON", "BBOX_MAX_LAT"):
        os.environ[k] = cfg[k]

    print("Extracting Overture buildings for bbox [%s,%s -> %s,%s]" % (
        cfg["BBOX_MIN_LON"], cfg["BBOX_MIN_LAT"],
        cfg["BBOX_MAX_LON"], cfg["BBOX_MAX_LAT"]))
    print("Release: %s  |  Snapshot date: %s" % (release, cfg["SNAPSHOT_DATE"]))

    sql = open(SQL_PATH, encoding="utf-8").read()
    # DuckDB's COPY ... TO needs a literal path, not an expression — same
    # substitution extract.sh does with sed.
    sql = sql.replace("__OUTPUT_PATH__", out_path.replace("\\", "/"))

    # getenv() IS NOT AVAILABLE IN THE PYTHON CLIENT. It ships only with the
    # DuckDB CLI — the Python API deliberately withholds it, because a library
    # embedded in a host program has no business reading that program's
    # environment. So the environment variables set above are what the SQL
    # *documents*, and this loop is what actually binds them: each
    # getenv('NAME') is replaced by the literal value, before execute().
    #
    # Substituting rather than rewriting the SQL to use parameters is
    # deliberate. `?` placeholders are not allowed everywhere getenv() appears
    # (the read_parquet path is a constant expression), and the point of
    # keeping extract_overture.sql byte-identical to Austin's is that a future
    # Overture schema change can be fixed in one file for both repos.
    def _sub(m):
        name = m.group(1)
        val = os.environ[name]
        return "'%s'" % val.replace("'", "''")
    sql, n_sub = re.subn(r"getenv\(\s*'([A-Z0-9_]+)'\s*\)", _sub, sql)
    if n_sub == 0:
        raise SystemExit(
            "extract_overture.sql contains no getenv() calls to bind. The SQL "
            "changed shape; check it still reads the bbox and OVERTURE_S3.")

    import duckdb
    con = duckdb.connect(":memory:")
    con.execute(sql)
    con.close()

    import json
    n = len(json.load(open(out_path, encoding="utf-8"))["features"])
    print("Wrote %d building footprints to %s" % (n, cfg["BUILDINGS_GEOJSON"]))
    if n == 0:
        print("\nZERO features. That is almost always the bbox, not the network:")
        print("the WHERE clause keeps only footprints CONTAINED by the box, so a")
        print("box drawn too tight around a single block can legitimately match")
        print("nothing. Check BBOX_* in scripts/config.sh.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
