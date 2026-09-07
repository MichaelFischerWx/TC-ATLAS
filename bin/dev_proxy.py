#!/usr/bin/env python3
"""Local dev server: static files from the repo root + a CORS-free API proxy.

The Cloud Run API only allows the http://localhost:8000 origin, and that
port is often taken by another project. This server listens on $PORT
(default 8092), serves the repo as static files, and forwards anything
under /__api/ to https://api.tcatlas.org (following its R2 redirects) so a
page can be tested against the live API from any local port. In the page,
rewrite fetch targets once from DevTools:

    const _f = window.fetch;
    window.fetch = (u, o) => _f(typeof u === 'string'
        ? u.replace('https://api.tcatlas.org', location.origin + '/__api') : u, o);

Registered in .claude/launch.json as "tc-atlas-dev-proxy".
"""
import os
import sys
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

API = "https://api.tcatlas.org"


class Handler(SimpleHTTPRequestHandler):
    # Vendor-path fallback: until assets/vendor/maplibre/maplibre-gl.js is
    # committed, serve it from unpkg in memory so the GL page can be tested.
    VENDOR_FALLBACK = {
        "/assets/vendor/maplibre/maplibre-gl.js": "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js",
    }

    def do_GET(self):
        bare = self.path.split("?")[0]
        if bare in self.VENDOR_FALLBACK and not os.path.exists(bare.lstrip("/")):
            url = self.VENDOR_FALLBACK[bare]
        elif not self.path.startswith("/__api/"):
            return super().do_GET()
        else:
            url = API + self.path[len("/__api"):]
        req = urllib.request.Request(url, headers={"User-Agent": "tc-atlas-dev-proxy",
                                                   "Accept-Encoding": "identity"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
                self.send_response(r.status)
                for h in ("Content-Type", "Cache-Control", "X-Cache"):
                    v = r.headers.get(h)
                    if v:
                        self.send_header(h, v)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:  # noqa: BLE001
            self.send_error(502, str(e))

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8092"))
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    print(f"dev proxy on http://localhost:{port}  (API via /__api/)", flush=True)
    ThreadingHTTPServer(("", port), Handler).serve_forever()
