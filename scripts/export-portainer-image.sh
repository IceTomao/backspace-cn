#!/usr/bin/env sh
set -eu

# Build the modified Chinese client image and export it for Portainer's image
# import screen. Run from the repository root on a Linux machine with Docker.

IMAGE_NAME="${IMAGE_NAME:-backspace-cn:1.3.0}"
ARCHIVE_PATH="${ARCHIVE_PATH:-./backspace-cn_1.3.0.tar}"
BUILD_COMMIT="${BACKSPACE_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || true)}"

docker build \
  --pull \
  --build-arg "BACKSPACE_COMMIT=${BUILD_COMMIT}" \
  --tag "${IMAGE_NAME}" \
  .

docker save --output "${ARCHIVE_PATH}" "${IMAGE_NAME}"

printf 'Created %s\n' "${ARCHIVE_PATH}"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${ARCHIVE_PATH}"
fi
