// Laboratory pipeline only. Never use browser getDisplayMedia as an HDR source.
export const HDR_UNSUPPORTED = '该直播间为 HDR 直播间，本机设备暂不支持查看';

export function validateOptions({ width = 1920, height = 1080, fps = 60, bitrateKbps = 16000, seconds = 10 } = {}) {
  for (const [key, value] of Object.entries({ width, height, fps, bitrateKbps, seconds })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${key}`);
  }
  if (width < 256 || height < 128 || width > 7680 || height > 4320 || width % 2 || height % 2)
    throw new Error('Expected even video dimensions between 256x128 and 7680x4320');
  if (fps > 120 || seconds > 60 || bitrateKbps < 500 || bitrateKbps > 200000)
    throw new Error('Capture exceeds laboratory limits');
  return { width, height, fps, bitrateKbps, seconds };
}

export function requireHdrDisplay(snapshot, gdiName) {
  if (snapshot?.schemaVersion !== 2 || !Array.isArray(snapshot.displays)) throw new Error('Cannot confirm Windows HDR state');
  const matches = snapshot.displays.filter(d => d.gdiName === gdiName);
  if (matches.length !== 1) throw new Error('Selected display is missing or mirrored; select an independent display');
  const display = matches[0];
  if (display.hdrActive !== true) throw new Error('Selected display has HDR disabled or its HDR state cannot be confirmed');
  if (typeof display.hmonitor !== 'string' || !/^[1-9][0-9]*$/.test(display.hmonitor)) throw new Error('Cannot identify the selected capture monitor');
  return display;
}

// WGC supplies linear BT.709 scRGB, with 1.0 = 80 cd/m². Preserve floats
// through the primary/transfer conversion; an integer RGB intermediate would
// clamp HDR highlights before PQ encoding. This reference path uses CPU
// zscale after D3D11 readback, so it is NOT a production performance promise.
export const SCRGB_TO_PQ = [
  'format=gbrpf32le',
  'zscale=primariesin=bt709:transferin=linear:matrixin=gbr:rangein=full:primaries=bt2020:transfer=smpte2084:matrix=bt2020nc:range=limited:npl=80:dither=error_diffusion',
  'format=p010le',
].join(',');

// libplacebo's linear hook uses its 203-nit reference white. Normalize WGC's
// 80-nit scRGB white before the GPU primary/PQ transform, preserving highlights.
const referenceWhiteShader = `//!HOOK LINEAR
//!BIND HOOKED
//!DESC WGC scRGB reference white
vec4 hook() {
    vec4 pixel = HOOKED_tex(HOOKED_pos);
    pixel.rgb *= 80.0 / 203.0;
    return pixel;
}
`;
export const GPU_SCRGB_TO_PQ = [
  'format=gbrpf32le',
  'setparams=range=full:color_primaries=bt709:color_trc=linear:colorspace=gbr',
  'hwupload',
  `libplacebo=format=p010le:colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv:tonemapping=clip:peak_detect=0:custom_shader_bin=${Buffer.from(referenceWhiteShader).toString('hex')}`,
  'hwdownload', 'format=p010le',
].join(',');

const GPU_DEVICE_ARGS = ['-init_hw_device', 'vulkan=gpu:0', '-filter_hw_device', 'gpu'];

export function encodeArgs(options) {
  const { fps, bitrateKbps } = validateOptions(options);
  return [
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-c:v', 'hevc_nvenc', '-profile:v', 'main10', '-pix_fmt', 'p010le',
    '-preset', 'p4', '-tune', 'ull', '-rc', 'cbr',
    '-b:v', `${bitrateKbps}k`, '-maxrate:v', `${bitrateKbps}k`, '-bufsize:v', `${Math.ceil(bitrateKbps / 4)}k`,
    '-bf', '0', '-rc-lookahead', '0', '-g', String(fps * 2),
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv',
  ];
}

export function captureArgs(display, options, output, { gpuConversion = false } = {}) {
  const { width, height, fps, seconds } = validateOptions(options);
  if (!display || display.hdrActive !== true || !/^[1-9][0-9]*$/.test(display.hmonitor))
    throw new Error('HDR capture requires a confirmed native HDR monitor');
  return [
    '-hide_banner', '-nostdin', '-n', '-benchmark',
    ...(gpuConversion ? GPU_DEVICE_ARGS : []),
    '-f', 'lavfi', '-i', `gfxcapture=hmonitor=${display.hmonitor}:output_fmt=rgbaf16:max_framerate=${fps}:width=${width}:height=${height}:resize_mode=scale_aspect:display_border=1`,
    '-vf', `hwdownload,format=rgbaf16le,${gpuConversion ? GPU_SCRGB_TO_PQ : SCRGB_TO_PQ}`,
    ...encodeArgs(options), '-t', String(seconds), '-r', String(fps), '-fps_mode', 'cfr',
    '-progress', 'pipe:1', '-f', 'matroska', output,
  ];
}

/** WGC-only producer for drivers supported by an older NVENC runtime. This
 * pipe carries floating-point HDR pixels locally, never a second upload. */
export function captureFramesArgs(display, options) {
  const { width, height, fps, seconds } = validateOptions(options);
  if (!display || display.hdrActive !== true || !/^[1-9][0-9]*$/.test(display.hmonitor)) throw new Error('HDR capture requires a confirmed native HDR monitor');
  return [
    '-hide_banner', '-nostdin', '-f', 'lavfi', '-i',
    `gfxcapture=hmonitor=${display.hmonitor}:output_fmt=rgbaf16:max_framerate=${fps}:width=${width}:height=${height}:resize_mode=scale_aspect:display_border=1`,
    '-map', '0:v:0', '-an', '-vf', 'hwdownload,format=rgbaf16le,format=gbrpf32le',
    '-t', String(seconds), '-r', String(fps), '-fps_mode', 'cfr', '-f', 'rawvideo', 'pipe:1',
  ];
}

export function rawHdrEncodeArgs(options, output, { gpuConversion = false } = {}) {
  const { width, height, fps, seconds } = validateOptions(options);
  return [
    '-hide_banner', '-nostdin', '-n', '-benchmark', ...(gpuConversion ? GPU_DEVICE_ARGS : []), '-f', 'rawvideo', '-pixel_format', 'gbrpf32le',
    '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
    '-vf', gpuConversion ? GPU_SCRGB_TO_PQ : SCRGB_TO_PQ, ...encodeArgs(options), '-frames:v', String(fps * seconds),
    '-progress', 'pipe:1', '-f', 'matroska', output,
  ];
}

export function verifyHdrStream(probe, expected) {
  const streams = probe?.streams;
  if (!Array.isArray(streams) || streams.length !== 1 || streams[0].codec_type !== 'video')
    throw new Error('Expected exactly one video stream and no SDR/audio fallback');
  const stream = streams[0];
  const required = { codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', color_range: 'tv' };
  for (const [key, value] of Object.entries(required)) {
    if (stream[key] !== value) throw new Error(`HDR bitstream mismatch: ${key}=${stream[key] ?? 'unknown'}, expected ${value}`);
  }
  if (expected && (stream.width !== expected.width || stream.height !== expected.height)) throw new Error('Encoded dimensions differ from request');
  if (expected?.fps && expected?.seconds && Number(stream.nb_read_packets) !== expected.fps * expected.seconds)
    throw new Error('Encoded frame count differs from request');
  if (expected?.fps) {
    const [numerator, denominator] = (stream.r_frame_rate ?? '').split('/').map(Number);
    if (!denominator || numerator / denominator !== expected.fps) throw new Error('Encoded frame rate differs from request');
  }
  return stream;
}

// ST 2084 reference values used to inspect decoded synthetic luminance patches.
export function pqFromNits(nits) {
  const x = Math.max(0, Math.min(10000, nits)) / 10000;
  const p = x ** (2610 / 16384);
  return ((3424 / 4096 + (2413 / 128) * p) / (1 + (2392 / 128) * p)) ** (2523 / 32);
}

export const PATCH_NITS = [0, 80, 200, 1000];

/** Planar float RGB: no 8-bit test source can establish highlight preservation. */
export function syntheticFrame(width, height) {
  const frame = Buffer.alloc(width * height * 3 * 4);
  for (let plane = 0; plane < 3; plane++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const scRgb = PATCH_NITS[Math.min(3, Math.floor(x * 4 / width))] / 80;
        frame.writeFloatLE(scRgb, ((plane * height + y) * width + x) * 4);
      }
    }
  }
  return frame;
}

export function verifyHighlightPatches(decoded, width, height) {
  if (decoded.length < width * height * 2) throw new Error('Incomplete decoded 10-bit luma plane');
  const levels = PATCH_NITS.map((nits, index) => {
    const x = Math.floor(width * (index + 0.5) / 4), y = Math.floor(height / 2);
    const actual = decoded.readUInt16LE((y * width + x) * 2);
    const expected = 64 + 876 * pqFromNits(nits);
    if (Math.abs(actual - expected) > 8) throw new Error(`Luminance patch ${nits} nits: decoded ${actual}, expected ${expected.toFixed(1)}; float highlights may have been clipped`);
    return { nits, actual, expected: Math.round(expected) };
  });
  return levels;
}
