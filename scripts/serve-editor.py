#!/usr/bin/env python3
"""Static server for the built EffectCraft editor dist (target/web/dist).

Sends the same headers as `cargo xtask web --serve`: COOP/COEP so the page is
cross-origin isolated, and `application/wasm` for .wasm. Localhost only.

Usage: python3 scripts/serve-editor.py [port]   (default 8765)
"""
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
DIST = os.path.join(os.path.dirname(__file__), "..", "editor", "target", "web", "dist")


class EditorHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST, **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def guess_mime(self, path):
        if path.endswith(".wasm"):
            return "application/wasm"
        return None

    def translate_path(self, path):
        # strip query flags like `?empty`
        p = super().translate_path(path)
        return p

    def log_message(self, fmt, *args):
        sys.stderr.write("[editor] %s\n" % (fmt % args))


def extensions_map_extra():
    return {".wasm": "application/wasm"}


if __name__ == "__main__":
    EditorHandler.extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **extensions_map_extra()}
    print(f"[editor] serving {os.path.abspath(DIST)} on http://127.0.0.1:{PORT}")
    server = HTTPServer(("127.0.0.1", PORT), EditorHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
