#!/bin/sh
set -eu
# Fixed Actor-private paths only. ROOTFS restores retain persistent Docker data;
# only transient process/socket state is removed before starting new processes.
test "$(id -u)" = 1000
test "$XDG_RUNTIME_DIR" = /run/user/1000
test "$DOCKER_HOST" = unix:///run/user/1000/docker.sock
test "$#" -gt 0
test -r /run/ate/egress-trust-bundle/trust-bundle.pem
export SSL_CERT_FILE=/run/ate/egress-trust-bundle/trust-bundle.pem
export NODE_EXTRA_CA_CERTS="$SSL_CERT_FILE"
export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE"
export CURL_CA_BUNDLE="$SSL_CERT_FILE"
export HTTP_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY"
export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1
mkdir -p "$XDG_RUNTIME_DIR"
for path in docker-direct docker; do
  test ! -L "$XDG_RUNTIME_DIR/$path"
  rm -rf "$XDG_RUNTIME_DIR/$path"
done
rm -f "$XDG_RUNTIME_DIR/docker.pid" "$XDG_RUNTIME_DIR/docker.sock"
export DOCKERD_ROOTLESSKIT_STATE_DIR="$XDG_RUNTIME_DIR/docker-direct"
rootlesskit --state-dir="$DOCKERD_ROOTLESSKIT_STATE_DIR" --net=slirp4netns \
  --mtu=1500 --disable-host-loopback --port-driver=builtin --copy-up=/etc --copy-up=/run \
  /opt/factory-rootless/child.sh &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true' EXIT
python3 /opt/factory-rootless/wait.py docker "$daemon"
# A cold restart does not replay a fixture initializer or old command queue.
# An adapter can pass its authenticated Connector launch as the explicit command.
"$@" &
application=$!
python3 /opt/factory-rootless/ready.py "$daemon" "$application" &
wait "$application"
