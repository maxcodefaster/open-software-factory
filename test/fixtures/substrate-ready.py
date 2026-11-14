"""Exercise the shipped HTTP handler against a healthy but slow private check."""
import http.client
import http.server
import json
import os
import runpy
import subprocess
import sys
import threading
import time

script, mode = sys.argv[1:]
original_server = http.server.HTTPServer
original_kill = os.kill
created = threading.Event()
errors = []
state = {"alive": True, "success": True, "hang": False, "output": b"input-stop", "calls": 0}
server = None


class OwnedServer(original_server):
    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if not isinstance(error, (BrokenPipeError, ConnectionResetError)):
            errors.append(str(error))


def create_server(address, handler):
    global server
    assert address == ("0.0.0.0", 18081)
    server = OwnedServer(("127.0.0.1", 0), handler)
    created.set()
    return server


def check(command, **options):
    expected = (["docker", "info"] if mode == "docker" else
                ["/usr/local/bin/factory-runtime-connector", "native-bootstrap-mode"])
    assert command == expected, command
    assert options == {"capture_output": True, "timeout": 3}, options
    state["calls"] += 1
    hang, success, output = state["hang"], state["success"], state["output"]
    time.sleep(1.6 if hang else 0.65)
    if hang:
        raise subprocess.TimeoutExpired(command, 3)
    return subprocess.CompletedProcess(command, 0 if success else 1, output, b"")


def current_process(pid, signal):
    assert signal == 0
    if pid != os.getpid():
        return original_kill(pid, signal)
    if not state["alive"]:
        raise ProcessLookupError()


def run():
    try:
        sys.argv = [script, *(["--input-stop"] if mode == "input-stop" else []), str(os.getpid())]
        runpy.run_path(script, run_name="__main__")
    except BaseException as error:
        errors.append(str(error))
        created.set()


def response(path="/readyz"):
    client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=0.25)
    try:
        client.request("GET", path)
        reply = client.getresponse()
        reply.read()
        return reply.status
    finally:
        client.close()


def eventually(status, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if response() == status:
            return
        time.sleep(0.03)
    raise AssertionError(f"readiness never reported {status}")


http.server.HTTPServer = create_server
subprocess.run = check
os.kill = current_process
thread = threading.Thread(target=run, daemon=True)
thread.start()
try:
    assert created.wait(3) and server is not None, errors
    # Substrate's official v1.0.0 client allows 250ms for each HTTP request.
    # A slow check must not block that request or skip the first real check.
    try:
        assert response() == 503
    except TimeoutError as error:
        raise AssertionError("wakeup HTTP handler blocked beyond Substrate's 250ms request deadline") from error
    eventually(200)
    assert state["calls"] > 0
    checks_after_wakeup = state["calls"]
    time.sleep(1.2)
    assert state["calls"] == checks_after_wakeup, "wakeup checks keep running without an HTTP consumer"
    eventually(200)
    assert response("/other") == 503
    state["alive"] = False
    assert response() == 503, "a live cached result must not admit a dead current process"
    state["alive"] = True
    state["success"] = False
    eventually(503)
    state["success"] = True
    eventually(200)
    if mode == "input-stop":
        state["output"] = b"docker"
        eventually(503)
        state["output"] = b"input-stop"
        eventually(200)
    # A previously successful Docker/mode read cannot remain valid while the
    # next read is stuck. HTTP still has its unchanged 250ms deadline.
    state["hang"] = True
    eventually(503)
    assert not errors, errors
    print(json.dumps({"mode": mode, "realChecks": state["calls"], "requestDeadlineMS": 250,
                      "initiallyUnready": True, "slowHealthyCheck": True,
                      "deadProcessRefused": True, "failedAndStaleChecksRefused": True}))
finally:
    if server is not None:
        server.shutdown()
        server.server_close()
    thread.join(5)
    assert not thread.is_alive(), "owned readiness server did not stop"
