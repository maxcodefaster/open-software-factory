FROM docker.io/library/golang:1.27.2-alpine3.23@sha256:9e45f0eb4a63ed37ad6e604950407558b7c738e34e015ae77a5d4ad369cde079 AS build
WORKDIR /src/services/runtime-connector
COPY services/runtime-connector/go.mod services/runtime-connector/go.sum ./
RUN go mod download
COPY services/runtime-connector ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /factory-workspace-files ./cmd/factory-workspace-files
FROM docker.io/alpine/git:2.54.0@sha256:ce84fd6a057b4dc5cf5009da2dd832f1c6d096c1984bf50496cf3c256402264d
COPY --from=build /factory-workspace-files /factory-workspace-files
# Envbox 0.6.8 maps canonical checkout UID/GID 1000 to host UID/GID 101000.
USER 101000:101000
ENTRYPOINT ["/factory-workspace-files"]
