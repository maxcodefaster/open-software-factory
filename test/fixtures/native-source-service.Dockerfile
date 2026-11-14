FROM docker.io/library/golang:1.27.2-alpine3.23@sha256:9e45f0eb4a63ed37ad6e604950407558b7c738e34e015ae77a5d4ad369cde079 AS build
WORKDIR /src
COPY services/runtime-connector/go.mod services/runtime-connector/go.sum ./
RUN go mod download
COPY services/runtime-connector ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o /connector ./cmd/factory-runtime-connector

FROM docker.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
COPY --from=build /connector /connector
COPY test/fixtures/native-source-service.ts /proof.ts
ENTRYPOINT ["bun", "/proof.ts"]
