#!/usr/bin/env python3
"""DL-TerrainMapper — a static file server, and deliberately nothing more.

⚠️ THIS SERVER CANNOT RECEIVE ANYTHING, AND THAT IS THE POINT. It answers GET
and HEAD for files inside this folder and refuses every other method. There is
no upload route, no API and no database, so the claim the interface makes — that
a raster or a field photograph never leaves the machine — is a property of the
architecture rather than a promise somebody has to keep. Adding a POST handler
here would quietly break the GDPR position the photograph reader is built on;
see the note at the top of static/exif.js.

Run:  python launcher.py              first free port from 8990, opens a browser
      python launcher.py --port 9100  bind that port exactly, or fail
      python launcher.py --no-browser
Or from the folder above:  start.bat
"""
from __future__ import annotations

import argparse
import http.server
import os
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_PORT = 8990
PORT_TRIES = 20


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        # ES modules are served with the right type or the browser refuses them,
        # and nothing here may be cached across an edit while the tool is moving.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):        # noqa: N802
        self.send_error(405, "This tool has no upload path, by design")

    do_PUT = do_POST
    do_DELETE = do_POST
    do_PATCH = do_POST

    def log_message(self, fmt, *args):
        # One line per real request; the default logs every 304 and buries errors.
        if args and isinstance(args[0], str) and " /" in args[0]:
            sys.stderr.write("  %s\n" % (args[0],))


class Server(socketserver.ThreadingTCPServer):
    # ⚠️ SO_REUSEADDR MUST BE OFF ON WINDOWS, AND THE REASON IS THE OPPOSITE OF
    # WHAT THE NAME SUGGESTS. On Unix it only permits rebinding a socket left in
    # TIME_WAIT, which is what you want. On Windows it permits binding a port
    # ANOTHER LIVE PROCESS IS ALREADY LISTENING ON — the two servers then split
    # incoming connections unpredictably. With it set, the port scan below could
    # never fail, so it always "found" the port already in use and handed back a
    # second server fighting the first for requests. Windows already refuses
    # genuine conflicts by default, which is the behaviour wanted here.
    allow_reuse_address = os.name != "nt"
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None,
                    help=f"bind this port exactly; omit to take the first free one from {DEFAULT_PORT}")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if not (ROOT / "index.html").exists():
        print("index.html is missing - run this from the project folder", file=sys.stderr)
        return 2

    Handler.extensions_map.update({".js": "text/javascript", ".mjs": "text/javascript"})

    # ⚠️ AN EXPLICIT --port IS BINDING; NO PORT AT ALL MEANS "FIND ME ONE".
    # The two callers want opposite things and both are right. A tool launched
    # from start.bat must simply start, and refusing because a stale window from
    # ten minutes ago still holds 8990 is a failure the user cannot act on. The
    # editor's launch.json, by contrast, has already told the browser which port
    # to open — silently landing on 8991 there would leave it pointing at
    # nothing. So: given a port, bind it or fail loudly; given none, walk up.
    ports = [args.port] if args.port is not None else range(DEFAULT_PORT, DEFAULT_PORT + PORT_TRIES)
    httpd = None
    last = None
    for p in ports:
        try:
            httpd = Server(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError as e:
            last = e
    if httpd is None:
        if args.port is not None:
            print(f"cannot bind 127.0.0.1:{args.port} - {last}", file=sys.stderr)
            print("  something is already using it; omit --port to take the next free one",
                  file=sys.stderr)
        else:
            print(f"no free port between {DEFAULT_PORT} and {DEFAULT_PORT + PORT_TRIES - 1} "
                  f"- {last}", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{port}/"
    # ⚠️ ASCII ONLY IN THE STARTUP LINES. A Windows console is cp850 or cp1252,
    # not UTF-8, and the middle dot this used to print arrived as a replacement
    # character in the one message a user reads before anything else works.
    print(f"DL-TerrainMapper  -  {url}")
    print(f"  serving {ROOT}")
    print("  no upload path: this server only reads from disk")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
