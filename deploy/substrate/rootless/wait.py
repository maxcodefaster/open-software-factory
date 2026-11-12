"""Bounded readiness for the private daemon; never treat process existence as health."""
import os
import subprocess
import sys
import time

kind, pid = sys.argv[1:]
command = (["docker", "info"] if kind == "docker" else
           ["ctr", "--address", "/run/user/1000/docker/containerd/containerd.sock",
            "--timeout", "2s", "version"])
deadline = time.monotonic() + 150
while time.monotonic() < deadline:
    os.kill(int(pid), 0)
    try:
        result = subprocess.run(command, capture_output=True, timeout=5)
        if result.returncode == 0 and (kind == "docker" or b"Server:" in result.stdout):
            break
    except subprocess.TimeoutExpired:
        pass
    time.sleep(0.25)
else:
    raise SystemExit("Private " + kind + " readiness deadline exceeded")
