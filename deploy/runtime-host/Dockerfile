FROM docker.io/library/golang:1.27.2-alpine3.23@sha256:9e45f0eb4a63ed37ad6e604950407558b7c738e34e015ae77a5d4ad369cde079 AS connector

WORKDIR /src/services/runtime-connector
COPY services/runtime-connector/go.mod services/runtime-connector/go.sum ./
RUN go mod download
COPY services/runtime-connector ./
RUN --mount=type=cache,id=factory-connector-go-build,target=/root/.cache/go-build CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /factory-runtime-connector ./cmd/factory-runtime-connector
RUN --mount=type=cache,id=factory-connector-go-build,target=/root/.cache/go-build CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /factory-project-prebuild ./cmd/factory-project-prebuild

FROM docker.io/library/node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS node

FROM node AS language-node-musl
RUN mkdir -p /opt/node-runtime/lib \
  && cp -L /usr/local/bin/node /opt/node-runtime/node \
  && cp -L /usr/lib/libstdc++.so.6 /opt/node-runtime/lib/libstdc++.so.6 \
  && cp -L /usr/lib/libgcc_s.so.1 /opt/node-runtime/lib/libgcc_s.so.1

FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS language-node-glibc
RUN mkdir -p /opt/node-runtime/lib \
  && cp -L /usr/local/bin/node /opt/node-runtime/node \
  && cp -L "$(find /usr/lib -name libstdc++.so.6 -print -quit)" /opt/node-runtime/lib/libstdc++.so.6 \
  && cp -L "$(find /usr/lib -name libgcc_s.so.1 -print -quit)" /opt/node-runtime/lib/libgcc_s.so.1

FROM node AS build-tool
ARG TARGETARCH
COPY upstream.json /tmp/upstream.json
RUN opencode_package="$(node -e "const value=JSON.parse(require('fs').readFileSync('/tmp/upstream.json')).openCode.packages[process.argv[1]];if(!value)throw new Error('Unsupported OpenCode architecture');process.stdout.write(value.name)" "$TARGETARCH")" \
  && opencode_version="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/tmp/upstream.json')).openCode.version)")" \
  && opencode_tarball="$(npm pack --ignore-scripts "$opencode_package@$opencode_version")" \
  && node -e "const fs=require('fs'),crypto=require('crypto');const expected=JSON.parse(fs.readFileSync('/tmp/upstream.json')).openCode.packages[process.argv[2]].integrity;const actual='sha512-'+crypto.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64');if(actual!==expected)throw new Error('OpenCode integrity mismatch')" "$opencode_tarball" "$TARGETARCH" \
  && mkdir -p /opt/factory/opencode \
  && tar -xzf "$opencode_tarball" -C /opt/factory/opencode --strip-components=2 package/bin/opencode \
  && chmod 0555 /opt/factory/opencode/opencode
RUN opencode_package="$(node -e "const value=JSON.parse(require('fs').readFileSync('/tmp/upstream.json')).openCode.glibcPackages[process.argv[1]];if(!value)throw new Error('Unsupported OpenCode architecture');process.stdout.write(value.name)" "$TARGETARCH")" \
  && opencode_version="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/tmp/upstream.json')).openCode.version)")" \
  && opencode_tarball="$(npm pack --ignore-scripts "$opencode_package@$opencode_version")" \
  && node -e "const fs=require('fs'),crypto=require('crypto');const expected=JSON.parse(fs.readFileSync('/tmp/upstream.json')).openCode.glibcPackages[process.argv[2]].integrity;const actual='sha512-'+crypto.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64');if(actual!==expected)throw new Error('OpenCode integrity mismatch')" "$opencode_tarball" "$TARGETARCH" \
  && mkdir -p /opt/factory/opencode/glibc \
  && tar -xzf "$opencode_tarball" -C /opt/factory/opencode/glibc --strip-components=2 package/bin/opencode \
  && chmod 0555 /opt/factory/opencode/glibc/opencode

FROM docker.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS opencode-server
ARG TARGETARCH
WORKDIR /opt/factory/opencode/server
COPY deploy/opencode-server/package.json deploy/opencode-server/bun.lock ./
# Keep upstream dynamic native assets intact for both glibc and musl containers.
RUN cpu=x64; if [ "$TARGETARCH" = arm64 ]; then cpu=arm64; fi; bun install --frozen-lockfile --ignore-scripts --production --os='*' --cpu="$cpu"
COPY deploy/opencode-server/server.mjs deploy/opencode-server/retained-events.mjs deploy/opencode-server/install-skills.mjs ./
COPY deploy/opencode-server/config ./config
RUN chmod 0555 config && chmod 0444 config/opencode.json config/AGENTS.md

FROM node AS bun-tool
ARG TARGETARCH
WORKDIR /opt/factory/opencode/server
COPY upstream.json /tmp/upstream.json
RUN node -e 'const fs=require("fs");const child=require("child_process");const crypto=require("crypto");const pins=JSON.parse(fs.readFileSync("/tmp/upstream.json")).openCodeServer.bun[process.argv[1]];for(const [libc,pin] of Object.entries(pins)){const tar=child.execFileSync("npm",["pack","--ignore-scripts",pin.name+"@1.4.3"]).toString().trim();if("sha512-"+crypto.createHash("sha512").update(fs.readFileSync(tar)).digest("base64")!==pin.integrity)throw new Error("Bun integrity mismatch");fs.mkdirSync("../"+libc,{recursive:true});child.execFileSync("tar",["-xzf",tar,"-C","../"+libc,"--strip-components=2","package/bin/bun"]);fs.chmodSync("../"+libc+"/bun",0o555);fs.unlinkSync(tar)}' "$TARGETARCH"

FROM node AS language-tools
WORKDIR /opt/factory/language-tools
COPY deploy/language-tools/package.json deploy/language-tools/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund

FROM node AS verification-tool
ARG TARGETARCH
COPY upstream.json /tmp/upstream.json
RUN runner_arch="$(node -e "process.stdout.write(process.argv[1] === 'arm64' ? 'arm64' : 'amd64')" "$TARGETARCH")" \
  && runner_version="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/tmp/upstream.json')).forgejoRunner.version)")" \
  && runner_sha="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/tmp/upstream.json')).forgejoRunner.sha256[process.argv[1]])" "$runner_arch")" \
  && wget -q -O /usr/local/bin/forgejo-runner "https://code.forgejo.org/forgejo/runner/releases/download/v$runner_version/forgejo-runner-$runner_version-linux-$runner_arch" \
  && echo "$runner_sha  /usr/local/bin/forgejo-runner" | sha256sum -c - \
  && chmod 0555 /usr/local/bin/forgejo-runner \
  && test "$(forgejo-runner --version | awk '{print $3}')" = "v$runner_version"

FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS theia

ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /src/deploy/theia-ide
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY deploy/theia-ide/package.json deploy/theia-ide/package-lock.json ./
COPY deploy/theia-ide/browser-app/package.json ./browser-app/package.json
COPY deploy/theia-ide/factory-ide-extension/package.json ./factory-ide-extension/package.json
RUN npm ci --no-audit --no-fund
COPY deploy/theia-ide/factory-ide-extension ./factory-ide-extension
RUN npm run build

FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS developer-ide
COPY --from=theia /src/deploy/theia-ide/browser-app/lib /opt/factory/theia/lib
COPY --from=theia /src/deploy/theia-ide/browser-app/package.json /opt/factory/theia/package.json
USER 1000:1000
ENV XDG_CONFIG_HOME=/home/node/.factory-theia
ENV THEIA_CONFIG_DIR=/home/node/.factory-theia
ENTRYPOINT ["node", "/opt/factory/theia/lib/backend/main.js", "--hostname", "0.0.0.0", "--port", "4400", "--session-preference", "security.workspace.trust.enabled=false"]

FROM docker.io/library/docker:29.9.0-dind@sha256:0b6d18a4a222e71c88be6034926b4f6cde2fc33c2218643d03ccfddc65995470 AS runtime-host-base

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=connector /factory-runtime-connector /usr/local/bin/factory-runtime-connector
COPY --from=connector /factory-project-prebuild /usr/local/bin/factory-project-prebuild
COPY upstream.json /tmp/upstream.json
RUN apk add --no-cache git libgcc libstdc++ \
  && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && cli_tarball="$(npm pack --ignore-scripts @devcontainers/cli@0.89.0)" \
  && node -e "const fs=require('fs'),crypto=require('crypto');const expected=JSON.parse(fs.readFileSync('/tmp/upstream.json')).devcontainersCli.integrity;const actual='sha512-'+crypto.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64');if(actual!==expected)throw new Error('Dev Containers CLI integrity mismatch')" "$cli_tarball" \
  && npm install --global --ignore-scripts --no-audit --no-fund "./$cli_tarball" \
  && test "$(devcontainer --version)" = "0.89.0" \
  && factory-runtime-connector 2>&1 | grep -q 'usage: factory-runtime-connector' \
  && rm -f "$cli_tarball" /tmp/upstream.json \
  && npm cache clean --force

LABEL org.opencontainers.image.source="https://github.com/open-software-factory/open-software-factory"
LABEL org.opencontainers.image.version="0.1.0"

ENTRYPOINT ["dockerd-entrypoint.sh"]

FROM runtime-host-base AS runtime-host
COPY --from=language-tools /opt/factory/language-tools/node_modules /opt/factory/language-tools/node_modules
COPY --from=language-node-glibc /opt/node-runtime /opt/factory/language-tools/glibc
COPY --from=language-node-musl /opt/node-runtime /opt/factory/language-tools/musl
COPY --from=build-tool /opt/factory/opencode/opencode /opt/factory/opencode/opencode
COPY --from=build-tool /opt/factory/opencode/glibc/opencode /opt/factory/opencode/glibc/opencode
COPY --from=opencode-server /opt/factory/opencode/server /opt/factory/opencode/server
COPY --from=bun-tool /opt/factory/opencode/glibc/bun /opt/factory/opencode/glibc/bun
COPY --from=bun-tool /opt/factory/opencode/musl/bun /opt/factory/opencode/musl/bun
COPY --from=verification-tool /usr/local/bin/forgejo-runner /usr/local/bin/forgejo-runner

FROM runtime-host AS runtime
