#!/usr/bin/env python3
"""serve.py — a local server that behaves like GitHub Pages.

DO NOT USE `python -m http.server` TO TEST THIS SITE. It gets two things wrong
that matter, and both fail in ways that look like application bugs.

1. NO RANGE REQUESTS. SimpleHTTPRequestHandler ignores the `Range:` header and
   returns 200 with the whole file. PMTiles archives are read by asking for a
   few hundred bytes at a time out of a multi-megabyte file, so against that
   server the library receives a whole archive where it expected a slice,
   quietly gives up, and the layer renders NOTHING. No console error, no missing
   texture — the trees simply are not there, which reads as "vector tiles do not
   work" rather than "the test server is wrong". That cost a debugging round on
   2026-08-01.

2. NO CACHE HEADERS. GitHub Pages sends `Cache-Control: max-age=600`; the stdlib
   server sends none, so Chrome falls back to heuristic freshness and re-fetches
   things it would have reused in production. Any measurement of what a visitor
   downloads is wrong by however much that changes.

Both are fixed here, so a local measurement means something.

    python scripts/serve.py 8123
"""
import functools
import http.server
import os
import re
import sys

CACHE_CONTROL = "max-age=600"          # what GitHub Pages sends for this repo


class Handler(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.1, NOT the stdlib's HTTP/1.0 default, and this is not cosmetic.
    #
    # Under 1.0 there is no keep-alive, so every request opens a new TCP
    # connection. PMTiles makes one request per tile, so on a throttled
    # connection each of those pays a fresh handshake. Measured with an 85 ms
    # simulated latency, that made the tiled build look THREE TIMES SLOWER than
    # the un-tiled one — a completely artificial result, since GitHub Pages
    # serves HTTP/2 with multiplexing over a single connection.
    #
    # A test server that gets this wrong does not just add noise; it inverts the
    # conclusion and would have argued for reverting the tiling work.
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        self.send_header("Cache-Control", CACHE_CONTROL)
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_GET(self):
        rng = self.headers.get("Range")
        if not rng:
            return super().do_GET()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_GET()

        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        if not m:
            return super().do_GET()

        size = os.path.getsize(path)
        first, last = m.group(1), m.group(2)
        if first == "":
            # "last N bytes" form. PMTiles does not use it, but a browser may.
            length = int(last or 0)
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(first)
            end = int(last) if last else size - 1
        end = min(end, size - 1)

        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.end_headers()
            return

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = fh.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def log_message(self, *a):
        pass


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
root = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))
print("serving %s on http://127.0.0.1:%d  (ranges + cache headers)" % (root, port))

# ThreadingHTTPServer IS REQUIRED, NOT AN OPTIMISATION. Plain HTTPServer is
# single-threaded; combined with the HTTP/1.1 keep-alive above, the first
# browser connection stays open and every other request queues behind it
# forever. The page then never finishes loading and every verify script times
# out at its watchdog, which looks exactly like the app being broken. That is
# how the previous ten minutes were spent.
http.server.ThreadingHTTPServer(
    ("127.0.0.1", port),
    functools.partial(Handler, directory=root),
).serve_forever()
