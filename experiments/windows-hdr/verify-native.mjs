// Real local SFU roundtrip + elementary bitstream/decode checks. No desktop
// capture or HDR output is exercised; a passing report never grants acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { verifyHdrStream, verifyHighlightPatches } from './pipeline.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '../..');
const artifacts = path.join(root, '.artifacts');
const encoder = path.join(artifacts, 'runtime/ffmpeg-8.0.1-full_build-shared/bin');
const output = path.join(artifacts, 'livekit-received.hevc');
const args = process.argv.slice(2);
const go = args.includes('--go') ? args[args.indexOf('--go') + 1] : 'go';
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', options.capture ? 'pipe' : 'inherit', 'inherit'], ...options });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Native verification timed out')); }, 60000);
    child.stdout?.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); code === 0 && size <= 4 * 1024 * 1024 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${path.basename(command)} failed (${code})`)); });
  });
}
await run(go, ['test', '-count=1', '-v', '-timeout', '60s', './...'], {
  cwd: path.join(repo, 'packages/desktop/native/hdr-bridge'),
  env: { ...process.env,
    HDR_TEST_LIVEKIT: path.join(artifacts, 'runtime/livekit/livekit-server.exe'),
    HDR_TEST_BRIDGE: path.join(repo, 'packages/desktop/hdr-runtime/hdr-bridge.exe'),
    HDR_TEST_FIXTURE: path.join(repo, 'packages/desktop/native/hdr-probe.hevc'),
    HDR_TEST_OUTPUT: output,
    HDR_TEST_FFMPEG: path.join(encoder, 'ffmpeg.exe'),
  },
});
const probe = async file => JSON.parse((await run(path.join(encoder, 'ffprobe.exe'), ['-v', 'error', '-show_streams', '-of', 'json', file], { capture: true })).toString());
const video = verifyHdrStream(await probe(output), { width: 256, height: 128, fps: 60 });
const decoded = await run(path.join(encoder, 'ffmpeg.exe'), ['-v', 'error', '-i', output, '-frames:v', '1', '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', 'pipe:1'], { capture: true });
const highlights = verifyHighlightPatches(decoded, 256, 128);
// Exercise the native viewer's stream-copy framing, including a short stream:
// probing must preserve its first IDR and its Main10/PQ parameters.
const remuxed = `${output}.ts`;
await run(path.join(encoder, 'ffmpeg.exe'), ['-v', 'error', '-nostdin', '-y', '-fflags', '+genpts',
  '-probesize', '65536', '-analyzeduration', '1', '-fpsprobesize', '0', '-f', 'hevc', '-i', output,
  '-map', '0:v:0', '-an', '-c:v', 'copy', '-bsf:v', 'setts=pts=N*DURATION:dts=N*DURATION',
  '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-f', 'mpegts', remuxed]);
verifyHdrStream(await probe(remuxed), { width: 256, height: 128, fps: 60 });
const remuxDecoded = await run(path.join(encoder, 'ffmpeg.exe'), ['-v', 'error', '-i', remuxed,
  '-frames:v', '1', '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', 'pipe:1'], { capture: true });
verifyHighlightPatches(remuxDecoded, 256, 128);
const audio = (await probe(`${output}.ogg`)).streams;
if (audio.length !== 1 || audio[0].codec_name !== 'opus' || audio[0].sample_rate !== '48000' || audio[0].channels !== 2) throw new Error('Invalid received system-audio stream');
await run(path.join(encoder, 'ffmpeg.exe'), ['-v', 'error', '-i', `${output}.ogg`, '-f', 'null', '-']);
const report = { transportVerified: true, viewerRemuxVerified: true, endToEndVerified: false, hardwareHdrDisplayVerified: false,
  video: { codec: video.codec_name, profile: video.profile, pixFmt: video.pix_fmt, primaries: video.color_primaries, transfer: video.color_transfer },
  highlights, audio: { codec: 'opus', sampleRate: 48000, channels: 2 } };
await fs.writeFile(path.join(artifacts, 'native-transport-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
