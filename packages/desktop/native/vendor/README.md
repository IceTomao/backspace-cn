# NVENC interface header

`nvEncodeAPI.h` is unmodified from FFmpeg/nv-codec-headers tag `n13.0.19.0`:
https://github.com/FFmpeg/nv-codec-headers/blob/n13.0.19.0/include/ffnvcodec/nvEncodeAPI.h

LF-normalized SHA-256: `4fe4094541ef0f8a13249d97a8692dc5f835a6e9dd42eeadb3e2f7321d54dc7e`.
The build checks this hash. NVIDIA's MIT permission/copyright notice remains
at the top of the header; no NVIDIA driver binary is bundled. The encoder
loads the system driver DLL from System32 and rejects unsupported hardware.

API 13.0 matches the RTX 4070 SUPER / 596.21 development driver. This is a
build interface version, not proof of HDR capture, viewing or release acceptance.
