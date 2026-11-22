"""Native wakeupProbe: current processes and cold admission or private Docker."""
import http.server
import os
import subprocess
import sys
import threading
import time


class Readiness:
    def __init__(self, pids, mode):
        self.pids = pids
        self.mode = mode
        self.valid_until = 0
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.requested = threading.Event()
        self.thread = threading.Thread(target=self.check, daemon=True)

    def processes_alive(self):
        try:
            for pid in self.pids:
                os.kill(pid, 0)
            return True
        except OSError:
            return False

    def check(self):
        native = self.mode in ("input-stop", "bootstrap")
        command = (["/usr/local/bin/factory-runtime-connector", "native-bootstrap-mode"]
                   if native else ["docker", "info"])
        expected = b"input-stop" if self.mode == "input-stop" else b"docker"
        while True:
            self.requested.wait()
            if self.stopped.is_set():
                return
            self.requested.clear()
            healthy = False
            try:
                if self.processes_alive():
                    result = subprocess.run(command, capture_output=True, timeout=3)
                    healthy = (result.returncode == 0 and self.processes_alive() and
                               (not native or result.stdout.strip() == expected))
            except (OSError, subprocess.TimeoutExpired):
                pass
            with self.lock:
                # Cold start begins unready. A stuck next check must not keep
                # an old success alive, even within the command's 3s bound.
                self.valid_until = time.monotonic() + 1 if healthy else 0
                if healthy:
                    # The native worker stops polling after 200. Do not spend
                    # the Actor's execution budget checking an unused endpoint.
                    self.requested.clear()
            if self.stopped.wait(0.25):
                return

    def ready(self):
        if not self.processes_alive():
            return False
        with self.lock:
            healthy = time.monotonic() < self.valid_until
            if not healthy:
                self.requested.set()
            return healthy

    def close(self):
        self.stopped.set()
        self.requested.set()
        self.thread.join()


def main():
    mode = {"--input-stop": "input-stop", "--bootstrap": "bootstrap"}.get(sys.argv[1], "docker")
    pids = [int(value) for value in (sys.argv[2:] if mode != "docker" else sys.argv[1:])]
    health = Readiness(pids, mode)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            # The pinned native client's per-request deadline is 250ms.
            # Never spawn/wait for a Docker or mode CLI in its request path.
            healthy = self.path == "/readyz" and health.ready()
            self.send_response(200 if healthy else 503)
            self.end_headers()

        def log_message(self, *_):
            pass

    server = http.server.HTTPServer(("0.0.0.0", 18081), Handler)
    health.thread.start()
    try:
        server.serve_forever()
    finally:
        health.close()
        server.server_close()


if __name__ == "__main__":
    main()
