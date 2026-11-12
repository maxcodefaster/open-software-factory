# Both inputs must be immutable digests. The qualified rootless bootstrap keeps
# its namespaces; the normal Factory bundle supplies the EXACT current tools,
# including Docker 29.9.0 (not the bootstrap base's earlier 29.0.0 daemon).
ARG FACTORY_RUNTIME_HOST_IMAGE
ARG FACTORY_SUBSTRATE_BOOTSTRAP_IMAGE
FROM ${FACTORY_RUNTIME_HOST_IMAGE} AS tools
FROM tools AS containerd
# Docker 29.9 supplies the matching v2.4.1 shim but not the standalone daemon.
# Never retain the bootstrap's v2.1.5 daemon alongside that new shim API.
ADD --checksum=sha256:02ad3a7e80d7d2c018c7134d5eca7e301283db6895f100b957fb52ad8e5a30fd https://github.com/containerd/containerd/releases/download/v2.4.1/containerd-static-2.4.1-linux-amd64.tar.gz /tmp/containerd.tar.gz
RUN tar -xzf /tmp/containerd.tar.gz -C /tmp bin/containerd \
  && test "$(/tmp/bin/containerd --version | awk '{print $3}')" = v2.4.1 \
  && test "$(/tmp/bin/containerd --version | awk '{print $4}')" = f2551031d7276a770f65f98c9b52e57e7dad07e8
FROM ${FACTORY_SUBSTRATE_BOOTSTRAP_IMAGE}
ARG FACTORY_RUNTIME_HOST_IMAGE
ARG FACTORY_SUBSTRATE_BOOTSTRAP_IMAGE
USER root
RUN for image in "$FACTORY_RUNTIME_HOST_IMAGE" "$FACTORY_SUBSTRATE_BOOTSTRAP_IMAGE"; do \
      printf '%s\n' "$image" | grep -Eq '^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$' || exit 1; \
    done
COPY --from=tools /usr/local/bin/ /usr/local/bin/
COPY --from=containerd /tmp/bin/containerd /usr/local/bin/containerd
COPY --from=tools /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=tools /usr/local/libexec/docker/ /usr/local/libexec/docker/
COPY --from=tools /opt/factory/ /opt/factory/
RUN apk add --no-cache git libgcc libstdc++ \
  && test "$(docker --version | cut -d' ' -f3 | tr -d ,)" = 29.9.0 \
  && test "$(dockerd --version | cut -d' ' -f3 | tr -d ,)" = 29.9.0 \
  && test "$(docker compose version --short)" = 5.7.0-dev.1e1c577 \
  && test "$(node --version)" = v24.21.0 \
  && test "$(devcontainer --version)" = 0.89.0
RUN test "$(containerd --version | awk '{print $3}')" = v2.4.1
COPY deploy/substrate/rootless/ /opt/factory-rootless/
COPY deploy/substrate/rootless/runtime-child.sh /opt/factory-rootless/child.sh
RUN chmod 0555 /opt/factory-rootless/*.sh
USER rootless
ENTRYPOINT ["/opt/factory-rootless/start.sh", "/opt/factory-rootless/connector.sh", "/usr/local/bin/factory-runtime-connector", "native-parent"]
