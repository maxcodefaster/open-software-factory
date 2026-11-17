"""Networkless component proof of quiet, verified TLS through packaged Tinyproxy."""
import hashlib
import http.client
import http.server
import json
import pathlib
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time

root = pathlib.Path("/fixture")
cancel = threading.Event()
body = b"owned-response"
record = {
    "passed": False,
    "quietResponseSeconds": 35,
    "tlsValidationDisabled": False,
    "productionConfigurationSHA256": hashlib.sha256(
        (root / "production.conf").read_bytes()
    ).hexdigest(),
}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        # Send no response bytes or keepalives while the tool would be running.
        if self.path == "/quiet" and cancel.wait(35):
            return
        try:
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass

    def log_message(self, *_):
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = False


def connection(context, host="127.0.0.1"):
    client = http.client.HTTPSConnection("127.0.0.1", 8888, context=context, timeout=45)
    client.set_tunnel(host, 443)
    return client


def refuse(context, host, code):
    client = connection(context, host)
    try:
        client.request("GET", "/control")
        client.getresponse()
    except ssl.SSLCertVerificationError as error:
        assert error.verify_code == code, error
    else:
        raise AssertionError("Invalid TLS peer was accepted")
    finally:
        client.close()


def interrupted(*_):
    raise SystemExit("Proxy component proof interrupted")


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
server = worker = proxy = None
try:
    record["proxyVersion"] = subprocess.check_output(
        ["tinyproxy", "-v"], text=True
    ).strip()
    assert record["proxyVersion"] == "tinyproxy 1.11.2", "Exact packaged proxy required"
    server = Server(("0.0.0.0", 443), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(root / "tls.crt", root / "tls.key")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    worker = threading.Thread(target=server.serve_forever)
    worker.start()
    proxy = subprocess.Popen(
        ["tinyproxy", "-d", "-c", str(root / "production.conf")],
        stdout=sys.stderr,
        stderr=sys.stderr,
    )
    deadline = time.monotonic() + 5
    while True:
        assert proxy.poll() is None, "Packaged proxy exited during startup"
        try:
            with socket.create_connection(("127.0.0.1", 8888), timeout=0.2):
                break
        except OSError:
            if time.monotonic() >= deadline:
                raise TimeoutError("Packaged proxy did not listen")
            time.sleep(0.05)

    trusted = ssl.create_default_context(cafile=str(root / "tls.crt"))
    control = connection(trusted)
    try:
        control.request("GET", "/control")
        response = control.getresponse()
        assert response.status == 200 and response.read() == body
        record["trustedControlPassed"] = True
    finally:
        control.close()
    refuse(ssl.create_default_context(cafile=str(root / "wrong-ca.crt")), "127.0.0.1", 18)
    record["wrongCARefused"] = True
    # The server also listens on this loopback address, absent from its IP SAN.
    refuse(trusted, "127.0.0.2", 64)
    record["wrongHostRefused"] = True

    quiet = connection(trusted)
    start = time.monotonic()
    try:
        quiet.request("GET", "/quiet")
        response = quiet.getresponse()
        record.update(status=response.status, bodyMatched=response.read() == body)
        assert record["status"] == 200 and record["bodyMatched"]
        record["elapsedSeconds"] = time.monotonic() - start
        assert record["elapsedSeconds"] >= 35, "Quiet wait was not exercised"
        record["passed"] = True
    finally:
        record["elapsedSeconds"] = time.monotonic() - start
        quiet.close()
except BaseException as error:
    record.update(passed=False, errorType=type(error).__name__, error=str(error)[:500])
finally:
    cancel.set()
    if proxy is not None:
        proxy.terminate()
        try:
            proxy.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proxy.kill()
            proxy.wait()
    if server is not None:
        if worker is not None:
            server.shutdown()
        server.server_close()
    if worker is not None:
        worker.join()
    record["proxyAndServerJoined"] = (
        proxy is not None and proxy.poll() is not None
        and worker is not None and not worker.is_alive()
    )
    print(json.dumps(record), flush=True)
sys.exit(0 if record["passed"] else 1)
