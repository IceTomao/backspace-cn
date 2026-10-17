# Native HDR developer runtime

This is an unaccepted developer runtime. Do not distribute it as an accepted HDR release.

- LiveKit Go SDK 2.19.0: Apache-2.0; source and exact transitive versions in `hdr-bridge/go.mod` and `go.sum`. Source: https://github.com/livekit/server-sdk-go/tree/v2.19.0.
- Pion WebRTC/RTP: MIT; source https://github.com/pion/webrtc and https://github.com/pion/rtp. Dependency licenses must accompany distributed binaries.
- FFmpeg 8.0.1 and 8.1.2 Gyan full shared builds: GPL-3.0-or-later builds. Keep the bundled LICENSE and README.txt. Source https://github.com/FFmpeg/FFmpeg/tree/n8.0.1 and https://github.com/FFmpeg/FFmpeg/tree/n8.1.2; build configuration is printed by each bundled `ffmpeg -buildconf`. Build and dependency sources: https://www.gyan.dev/ffmpeg/builds/ and https://github.com/GyanD/codexffmpeg.
- libmpv `20261017-git-dde0671072`, shinchiro x86_64-v3: GPL-2.0-or-later (including enabled FFmpeg/libplacebo dependencies). Source https://github.com/mpv-player/mpv/tree/dde0671072; build and dependency recipes https://github.com/shinchiro/mpv-winbuild-cmake/tree/20261017.

The developer assembly script is not a source/redistribution compliance bundle. Before a public release, bundle the applicable license texts and corresponding complete build/dependency sources, record HDR hardware acceptance evidence, and update the release gate deliberately. A successful compile or synthetic transport test does not grant HDR hardware acceptance.

`hdr-probe.hevc` is an original synthetic float grey/highlight pattern encoded with NVENC. It contains no desktop recording and is covered by this repository's license.
