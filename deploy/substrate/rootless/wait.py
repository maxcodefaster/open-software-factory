"""Bounded readiness for the private daemon; never treat process existence as health."""
import os
import subprocess
import sys
import time

kind, pid = sys.argv[1:]
command = (["/usr/local/bin/factory-runtime-connector",
            "native-bootstrap-mode"] if kind == "bootstrap" else ["docker", "info"] if kind == "docker" else
           ["ctr", "--address", "/run/user/1000/docker/containerd/containerd.sock",
            "--timeout", "2s", "version"])
# Cold admission includes the verified Source import before Docker may start.
# It must not kill that import before the pinned worker's five-minute wakeup
# window. The native worker still owns the overall deadline; Docker's ordinary
# private readiness check retains its shorter existing bound.
deadline = time.monotonic() + (300 if kind == "bootstrap" else 150)
while time.monotonic() < deadline:
    os.kill(int(pid), 0)
    try:
        result = subprocess.run(command, capture_output=True, timeout=5)
        if kind == "bootstrap" and result.returncode == 0:
            mode = result.stdout.decode().strip()
            if mode not in ("docker", "input-stop"):
                raise SystemExit("Native cold mode is invalid")
            print(mode)
            break
        if kind != "bootstrap" and result.returncode == 0 and (kind == "docker" or b"Server:" in result.stdout):
            break
    except subprocess.TimeoutExpired:
        pass
    time.sleep(0.25)
else:
    raise SystemExit("Private " + kind + " readiness deadline exceeded")
