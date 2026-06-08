#!/usr/bin/env python3
# ============================================================================
#  AI Ad Studio — local static dev server.
#  Projects/assets/chat now live in Supabase, so this server only needs to serve
#  the app's static files over HTTP (required for ESM modules, the iPhone .glb /
#  .exr, and un-tainted canvas video export). The AI runs in a Supabase Edge
#  Function called directly over HTTPS, so nothing here proxies it.
#  No external dependencies — just the Python standard library.
# ============================================================================
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        # Don't cache during development so edits show up on refresh.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


# Make sure the 3D model + HDRI are served with sensible content types.
Handler.extensions_map.update({
    ".glb": "model/gltf-binary",
    ".exr": "image/x-exr",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    httpd = ThreadingHTTPServer(("", port), Handler)
    print(f"AI Ad Studio -> http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()
