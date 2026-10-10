FROM golang:1.26.7-alpine3.24 AS builder
ARG TARGETARCH
WORKDIR /src
COPY deploy/livekit-supervisor/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -trimpath -o /supervisor .

FROM livekit/livekit-server:v1.13.7
RUN apk add --no-cache ca-certificates
COPY --from=builder /supervisor /supervisor
ENTRYPOINT ["/supervisor"]
CMD ["--config", "/etc/livekit.yaml"]
