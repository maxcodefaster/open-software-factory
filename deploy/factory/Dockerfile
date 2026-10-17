FROM docker.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun
FROM docker.io/library/docker:29.9.0-dind@sha256:0b6d18a4a222e71c88be6034926b4f6cde2fc33c2218643d03ccfddc65995470 AS docker
FROM registry.k8s.io/kubectl:v1.33.9@sha256:ca9eb7966d4cae76fe34deca5c3096970e1494decac445a1e04df9e05af70790 AS kubectl

FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tools
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates curl git util-linux \
  && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN case "$TARGETARCH" in \
    amd64) checksum=6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52 ;; \
    arm64) checksum=b98f2cc69fd9147fe4d405d859c57504571adec0d3611c3eefd04107c7ac00d0 ;; \
    *) exit 1 ;; esac \
  && curl --fail --location --retry 3 "https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-linux-${TARGETARCH}" -o /usr/local/bin/mkcert \
  && echo "$checksum  /usr/local/bin/mkcert" | sha256sum --check \
  && chmod 755 /usr/local/bin/mkcert

FROM tools AS build
WORKDIR /opt/factory
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN NODE_ENV=production bun run factory:build

FROM tools AS dependencies
WORKDIR /opt/factory
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM tools AS factory
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
WORKDIR /opt/factory
COPY --from=dependencies /opt/factory/node_modules ./node_modules
COPY package.json upstream.json LICENSE ./
COPY apps/factory/src ./apps/factory/src
COPY apps/factory/public ./apps/factory/public
COPY --from=build /opt/factory/apps/factory/dist ./apps/factory/dist
COPY packages ./packages
COPY scripts/factory ./scripts/factory
COPY deploy/local ./deploy/local
COPY deploy/factory/entrypoint.sh ./deploy/factory/entrypoint.sh
COPY deploy/metrics-server ./deploy/metrics-server
COPY templates ./templates
# Release builds embed the exact multi-architecture role references. Local
# source builds can instead reuse a complete published set in mounted state.
ARG FACTORY_RUNTIME_ARTIFACTS=null
RUN FACTORY_RUNTIME_ARTIFACTS="$FACTORY_RUNTIME_ARTIFACTS" bun -e 'await Bun.write("runtime-artifacts.json", process.env.FACTORY_RUNTIME_ARTIFACTS)'
ENV NODE_ENV=production
STOPSIGNAL SIGTERM
ENTRYPOINT ["sh", "deploy/factory/entrypoint.sh"]
