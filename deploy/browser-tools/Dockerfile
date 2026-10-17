FROM docker.io/library/golang:1.27.2-alpine3.23@sha256:9e45f0eb4a63ed37ad6e604950407558b7c738e34e015ae77a5d4ad369cde079 AS worker
WORKDIR /src/services/runtime-connector
COPY services/runtime-connector/go.mod services/runtime-connector/go.sum ./
RUN go mod download
COPY services/runtime-connector ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /factory-browser-worker ./cmd/factory-browser-worker
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /factory-browser-app-proxy ./cmd/factory-browser-app-proxy

FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS mcp
WORKDIR /opt/factory/browser-mcp
COPY upstream.json /tmp/upstream.json
RUN tarball="$(npm pack --silent --ignore-scripts chrome-devtools-mcp@1.10.1)" \
  && node -e "const fs=require('fs'),crypto=require('crypto');const expected=JSON.parse(fs.readFileSync('/tmp/upstream.json')).chromeDevToolsMcp.integrity;const actual='sha512-'+crypto.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64');if(actual!==expected)throw new Error('Browser MCP integrity mismatch')" "$tarball" \
  && tar -xzf "$tarball" --strip-components=1 \
  && rm "$tarball"

FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f AS browsers
# Copy the unmodified, digest-pinned Chromium distribution, not the upstream
# image's other browsers and development tools. Deleting inherited layers would
# not reduce downloads.
RUN chromium="$(find /ms-playwright -type f -path '/ms-playwright/chromium-*/chrome-linux*/chrome')" \
  && test -n "$chromium" && cp -a "$(dirname "$chromium")" /chromium

FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install --yes --no-install-recommends \
    ca-certificates fonts-liberation fonts-noto-color-emoji \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=browsers /chromium /opt/factory/chromium-bin
COPY --from=mcp /opt/factory/browser-mcp /opt/factory/browser-mcp
COPY --from=worker /factory-browser-worker /usr/local/bin/factory-browser-worker
COPY --from=worker /factory-browser-app-proxy /usr/local/bin/factory-browser-app-proxy
RUN ln -s /opt/factory/chromium-bin/chrome /opt/factory/chromium \
  && node --version \
  && /opt/factory/chromium --version \
  && test "$(/opt/factory/chromium --version | awk '{print $NF}' | cut -d . -f 1)" -ge 149
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/factory-browser-worker"]
