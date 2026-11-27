# Factory's immutable tools image is also the read-only native image volume
# used by Project entrypoints. Substrate starts each Project container directly.
ARG FACTORY_RUNTIME_HOST_IMAGE
FROM ${FACTORY_RUNTIME_HOST_IMAGE}
ARG FACTORY_RUNTIME_HOST_IMAGE
USER 0:0
RUN printf '%s\n' "$FACTORY_RUNTIME_HOST_IMAGE" \
      | grep -Eq '^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$' \
  && test -x /usr/local/bin/factory-runtime-connector \
  && test -x /usr/bin/git
ENTRYPOINT ["/usr/local/bin/factory-runtime-connector", "native-parent"]
