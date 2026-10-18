// Synthetic GPU frames only. Checks actual encoded pixels and frame-boundary
// control acknowledgements without capturing a desktop or accepting HDR output.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pqFromNits, PATCH_NITS, verifyHdrStream } from './pipeline.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const executable = path.resolve(root, '../../packages/desktop/hdr-runtime/HdrGpu.exe');
const bin = path.join(root, '.artifacts/runtime/ffmpeg-8.0.1-full_build-shared/bin');
const output = path.join(root, '.artifacts/gpu-color');
await fs.mkdir(output, { recursive: true });
const controls = [[0, 0], [10, 0], [-10, 0], [0, 50], [0, -50], [30, 50], [-30, -50], [0, 0]];
const width = 256, height = 128, frames = 240, fps = 60;
const encoded = [], acknowledgements = [];
let diagnostics = '', pending = '', sent = 0, timer, bytes = 0;
const child = spawn(executable, ['--synthetic', '--realtime', '--watch-parent', '--frames', String(frames),
  '--width', String(width), '--height', String(height), '--fps', String(fps), '--bitrate-kbps', '1000'],
  { windowsHide: true, stdio: 'pipe' });
function sendNext() {
  if (sent === controls.length) return;
  const [exposure, brightness] = controls[sent++];
  const packet = Buffer.alloc(16); packet.write('HDC1'); packet.writeUInt32LE(sent, 4);
  packet.writeInt32LE(exposure, 8); packet.writeInt32LE(brightness, 12);
  child.stdin.write(packet);
}
child.stdin.on('error', () => {});
child.stdout.on('data', chunk => { encoded.push(chunk); bytes += chunk.length; if (bytes > 8 * 1024 * 1024) child.kill(); });
child.stderr.on('data', chunk => {
  diagnostics += chunk; pending += chunk;
  for (;;) {
    const end = pending.indexOf('\n'); if (end < 0) break;
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (!line.startsWith('{')) continue;
    const event = JSON.parse(line);
    if (event.type === 'gpu-ready') timer = setTimeout(sendNext, 100);
    if (event.type === 'color-applied') {
      acknowledgements.push(event);
      timer = setTimeout(sendNext, 200);
    }
  }
});
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { child.kill(); reject(new Error('GPU color control timed out')); }, 20000);
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('close', code => { clearTimeout(timeout); clearTimeout(timer); code === 0 ? resolve() : reject(new Error(diagnostics)); });
});
if (acknowledgements.length !== controls.length) throw new Error(`Missing color acknowledgements: ${diagnostics}`);
const file = path.join(output, 'color.hevc'); await fs.writeFile(file, Buffer.concat(encoded));
const probe = JSON.parse(execFileSync(path.join(bin, 'ffprobe.exe'), ['-v', 'error', '-count_packets', '-show_streams', '-of', 'json', file], { windowsHide: true }));
const stream = verifyHdrStream(probe, { width, height, fps });
if (Number(stream.nb_read_packets) !== frames) throw new Error('Color change lost encoded frames');
const decoded = execFileSync(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-i', file, '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', 'pipe:1'],
  { windowsHide: true, maxBuffer: width * height * 3 * frames + 1024 });
const results = acknowledgements.map((ack, i) => {
  const [exposure, brightness] = controls[i];
  if (ack.revision !== i + 1 || ack.exposureTenths !== exposure || ack.brightness !== brightness) throw new Error('Mismatched color revision');
  const patches = PATCH_NITS.map((nits, patch) => {
    const exposed = nits * 2 ** (exposure / 10);
    const adjusted = exposed * (1 + brightness / 100 * (1 - Math.min(1, exposed / 1000)) ** 2);
    const expected = 64 + 876 * pqFromNits(adjusted);
    const x = patch * width / 4 + width / 8, y = height / 2;
    const actual = decoded.readUInt16LE(ack.frame * width * height * 3 + (y * width + x) * 2);
    if (Math.abs(actual - expected) > 8) throw new Error(`Wrong color pixels: ${JSON.stringify({ ack, nits, actual, expected })}`);
    return { nits, actual, expected: Math.round(expected) };
  });
  return { ...ack, patches };
});
const metrics = diagnostics.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(event => event.type === 'gpu-complete');
if (metrics?.videoEncoders !== 1 || metrics.pixelReadback !== false || metrics.frames !== frames) throw new Error('Color change altered the single GPU encoder');
const report = { createdAt: new Date().toISOString(), syntheticOnly: true, hardwareHdrDisplayVerified: false,
  frames, videoEncoders: 1, pixelReadback: false, results, metrics };
await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
