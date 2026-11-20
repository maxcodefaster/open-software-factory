FROM docker.io/oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS bun
FROM registry.k8s.io/kubectl:v1.35.10@sha256:4e1d541a3d62f74637974e4c71f3cea91b9a36ffd059ab45e355648898783837 AS kubectl

FROM docker.io/library/golang:1.27.4-alpine3.23@sha256:f70850ef6ce341e8b6427f677049145d63c0b7ce002d4d7e3d464828b1b96dcd AS substrate-control
WORKDIR /src
COPY services/substrate-control/go.mod services/substrate-control/go.sum ./
RUN go mod download
COPY services/substrate-control ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /factory-substrate-control .

FROM substrate-control AS source-service
WORKDIR /src/source
COPY services/runtime-connector/go.mod services/runtime-connector/go.sum ./
RUN go mod download
COPY services/runtime-connector ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /factory-runtime-connector ./cmd/factory-runtime-connector

FROM docker.io/library/golang:1.27.4-alpine3.23@sha256:f70850ef6ce341e8b6427f677049145d63c0b7ce002d4d7e3d464828b1b96dcd AS sqlite-tools
ARG SQLITE_SOURCE=https://www.sqlite.org/2026/sqlite-autoconf-3540100.tar.gz
ARG SQLITE_SHA256=926ef8d3eab93fbf6e06011901273eec076b25594a4e1cdadd50c987f4f6d64e
RUN apk add --no-cache build-base
COPY scripts/factory/build-sqlite.sh /build-sqlite.sh
RUN sh /build-sqlite.sh "$SQLITE_SOURCE" "$SQLITE_SHA256" /factory-sqlite

FROM docker.io/library/node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS tools
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates git util-linux openssl \
  && rm -rf /var/lib/apt/lists/*

FROM tools AS build
WORKDIR /opt/factory
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .
RUN NODE_ENV=production bun run factory:build

FROM tools AS dependencies
WORKDIR /opt/factory
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --production --frozen-lockfile

FROM tools AS factory
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
COPY --from=substrate-control /factory-substrate-control /usr/local/bin/factory-substrate-control
COPY --from=source-service /factory-runtime-connector /usr/local/bin/factory-runtime-connector
COPY --from=sqlite-tools /factory-sqlite /usr/local/bin/factory-sqlite
WORKDIR /opt/factory
COPY --from=dependencies /opt/factory/node_modules ./node_modules
COPY package.json upstream.json LICENSE ./
COPY apps/factory/src ./apps/factory/src
COPY apps/factory/public ./apps/factory/public
COPY --from=build /opt/factory/apps/factory/dist ./apps/factory/dist
COPY packages ./packages
COPY deploy/substrate/pins.json ./deploy/substrate/pins.json
COPY scripts/factory/artifacts.ts scripts/factory/preflight.ts scripts/factory/forge-identity.ts scripts/factory/forge-logout.ts scripts/factory/readiness.ts scripts/factory/storage-readiness.ts scripts/factory/openbao-bootstrap.ts scripts/factory/native-installation.ts ./scripts/factory/
COPY scripts/kubernetes ./scripts/kubernetes
COPY templates ./templates
# COPY retains checkout modes. Keep public code readable to the non-root
# runtime even with umask 077, without making code writable or touching state.
RUN chmod -R u=rwX,go=rX apps packages scripts templates deploy package.json upstream.json LICENSE
# Every installed image embeds the exact runtime role references.
ARG FACTORY_RUNTIME_ARTIFACTS=null
RUN FACTORY_RUNTIME_ARTIFACTS="$FACTORY_RUNTIME_ARTIFACTS" bun -e 'await Bun.write("runtime-artifacts.json", process.env.FACTORY_RUNTIME_ARTIFACTS)'
ENV NODE_ENV=production
STOPSIGNAL SIGTERM
ENTRYPOINT ["flock", "--nonblock", "--no-fork", "/var/lib/factory/bootstrap.lock", "bun", "scripts/kubernetes/start.ts"]
