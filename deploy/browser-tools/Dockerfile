FROM docker.io/library/golang:1.27.4-alpine3.23@sha256:f70850ef6ce341e8b6427f677049145d63c0b7ce002d4d7e3d464828b1b96dcd AS worker
WORKDIR /src/services/runtime-connector
COPY services/runtime-connector/go.mod services/runtime-connector/go.sum ./
RUN go mod download
COPY services/runtime-connector ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /factory-browser-worker ./cmd/factory-browser-worker
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /factory-browser-app-proxy ./cmd/factory-browser-app-proxy
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /factory-recording-encoder ./cmd/factory-recording-encoder

FROM docker.io/library/node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS mcp
WORKDIR /opt/factory/browser-mcp
COPY upstream.json /tmp/upstream.json
RUN tarball="$(npm pack --silent --ignore-scripts chrome-devtools-mcp@1.13.0)" \
  && node -e "const fs=require('fs'),crypto=require('crypto');const expected=JSON.parse(fs.readFileSync('/tmp/upstream.json')).chromeDevToolsMcp.integrity;const actual='sha512-'+crypto.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64');if(actual!==expected)throw new Error('Browser MCP integrity mismatch')" "$tarball" \
  && tar -xzf "$tarball" --strip-components=1 \
  && rm "$tarball"

FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579 AS browsers
# Copy the unmodified, digest-pinned Chromium distribution, not the upstream
# image's other browsers and development tools. Deleting inherited layers would
# not reduce downloads.
RUN chromium="$(find /ms-playwright -type f -path '/ms-playwright/chromium-*/chrome-linux*/chrome')" \
  && test -n "$chromium" && cp -a "$(dirname "$chromium")" /chromium

FROM docker.io/library/node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
# Playwright's minimal encoder cannot decode Puppeteer's PNG frames. Use the
# exact Debian FFmpeg package, without changing Chromium or the MCP upstream.
RUN apt-get update && apt-get install --yes --no-install-recommends \
    ca-certificates fonts-liberation fonts-noto-color-emoji ffmpeg=7:5.1.9-0+deb12u1 \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=browsers /chromium /opt/factory/chromium-bin
COPY --from=mcp /opt/factory/browser-mcp /opt/factory/browser-mcp
COPY --from=worker /factory-browser-worker /usr/local/bin/factory-browser-worker
COPY --from=worker /factory-browser-app-proxy /usr/local/bin/factory-browser-app-proxy
COPY --from=worker /factory-recording-encoder /usr/local/bin/factory-recording-encoder
RUN ln -s /opt/factory/chromium-bin/chrome /opt/factory/chromium \
  && ln -s /usr/bin/ffmpeg /usr/local/bin/ffmpeg \
  && node --version \
  && /opt/factory/chromium --version \
  && test "$(/opt/factory/chromium --version | awk '{print $NF}' | cut -d . -f 1)" -ge 149
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/factory-browser-worker"]
