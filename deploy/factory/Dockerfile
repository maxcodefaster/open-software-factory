FROM docker.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun
FROM registry.k8s.io/kubectl:v1.35.6@sha256:4d8c68e8c2bf360b1808927c4d39fb13998c106cac903622d127a2275c844126 AS kubectl

FROM docker.io/library/golang:1.27.2-alpine3.23@sha256:9e45f0eb4a63ed37ad6e604950407558b7c738e34e015ae77a5d4ad369cde079 AS substrate-control
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

FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tools
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates git util-linux \
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
WORKDIR /opt/factory
COPY --from=dependencies /opt/factory/node_modules ./node_modules
COPY package.json upstream.json LICENSE ./
COPY apps/factory/src ./apps/factory/src
COPY apps/factory/public ./apps/factory/public
COPY --from=build /opt/factory/apps/factory/dist ./apps/factory/dist
COPY packages ./packages
COPY deploy/substrate/pins.json ./deploy/substrate/pins.json
COPY scripts/factory/artifacts.ts scripts/factory/preflight.ts scripts/factory/forge-identity.ts scripts/factory/forge-logout.ts scripts/factory/readiness.ts scripts/factory/storage-readiness.ts scripts/factory/openbao-bootstrap.ts ./scripts/factory/
COPY scripts/kubernetes ./scripts/kubernetes
COPY templates ./templates
# Every installed image embeds the exact runtime role references.
ARG FACTORY_RUNTIME_ARTIFACTS=null
RUN FACTORY_RUNTIME_ARTIFACTS="$FACTORY_RUNTIME_ARTIFACTS" bun -e 'await Bun.write("runtime-artifacts.json", process.env.FACTORY_RUNTIME_ARTIFACTS)'
ENV NODE_ENV=production
STOPSIGNAL SIGTERM
ENTRYPOINT ["flock", "--nonblock", "--no-fork", "/var/lib/factory/bootstrap.lock", "bun", "scripts/kubernetes/start.ts"]
