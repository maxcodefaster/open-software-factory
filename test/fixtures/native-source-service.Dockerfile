FROM docker.io/library/golang:1.27.4-alpine3.23@sha256:f70850ef6ce341e8b6427f677049145d63c0b7ce002d4d7e3d464828b1b96dcd AS build
WORKDIR /src
COPY services/runtime-connector/go.mod services/runtime-connector/go.sum ./
RUN go mod download
COPY services/runtime-connector ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o /connector ./cmd/factory-runtime-connector

FROM docker.io/oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18
COPY --from=build /connector /connector
COPY test/fixtures/native-source-service.ts /proof.ts
ENTRYPOINT ["bun", "/proof.ts"]
