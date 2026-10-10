#!/usr/bin/env sh
set -eu

# Build the modified Chinese client image and export it for Portainer's image
# import screen. Run from the repository root on a Linux machine with Docker.

IMAGE_NAME="${IMAGE_NAME:-backspace-cn:1.4.5}"
ARCHIVE_PATH="${ARCHIVE_PATH:-./backspace-cn_1.4.5.tar}"
LIVEKIT_IMAGE="${LIVEKIT_IMAGE:-backspace-livekit:1.13.7-recovery}"
LIVEKIT_ARCHIVE_PATH="${LIVEKIT_ARCHIVE_PATH:-./backspace-livekit_1.13.7-recovery.tar}"
BUILD_COMMIT="${BACKSPACE_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || true)}"

docker build \
  --pull \
  --build-arg "BACKSPACE_COMMIT=${BUILD_COMMIT}" \
  --tag "${IMAGE_NAME}" \
  .

docker save --output "${ARCHIVE_PATH}" "${IMAGE_NAME}"
docker build --pull --file deploy/livekit-supervisor/Dockerfile --tag "${LIVEKIT_IMAGE}" .
docker save --output "${LIVEKIT_ARCHIVE_PATH}" "${LIVEKIT_IMAGE}"

printf 'Created %s\n' "${ARCHIVE_PATH}"
printf 'Created %s\n' "${LIVEKIT_ARCHIVE_PATH}"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${ARCHIVE_PATH}"
  sha256sum "${LIVEKIT_ARCHIVE_PATH}"
fi
