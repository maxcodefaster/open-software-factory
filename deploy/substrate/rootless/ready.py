"""Native wakeupProbe: current processes plus a real private Docker round trip."""
import http.server
import os
import subprocess
import sys

pids = [int(value) for value in sys.argv[1:]]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        healthy = False
        try:
            for pid in pids:
                os.kill(pid, 0)
            result = subprocess.run(["docker", "info"], capture_output=True, timeout=3)
            healthy = self.path == "/readyz" and result.returncode == 0
        except (ProcessLookupError, subprocess.TimeoutExpired):
            pass
        self.send_response(200 if healthy else 503)
        self.end_headers()

    def log_message(self, *_):
        pass


http.server.HTTPServer(("0.0.0.0", 18081), Handler).serve_forever()
