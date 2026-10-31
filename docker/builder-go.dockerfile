############################################
# Build the healthcheck from source with the current Go toolchain.
############################################
FROM --platform=$BUILDPLATFORM golang:1.27.3-bookworm
WORKDIR /app
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
COPY ./extra/healthcheck.go ./extra/healthcheck.go
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOARM=${TARGETVARIANT#v} \
    go build -trimpath -ldflags="-s -w" -o ./extra/healthcheck ./extra/healthcheck.go
