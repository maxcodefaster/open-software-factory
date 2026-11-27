FROM docker.io/library/node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
USER 0:0
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && test "$(id -u node)" = 1000 && test "$(id -g node)" = 1000
USER 1000:1000
