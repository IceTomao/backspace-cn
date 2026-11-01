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

const defaultCurve = [50, 50, 100];
const controls = [
  { exposure: 0, all: defaultCurve, red: defaultCurve, green: defaultCurve, blue: defaultCurve, vibrance: 50, hue: 0 },
  { exposure: 10, all: defaultCurve, red: defaultCurve, green: defaultCurve, blue: defaultCurve, vibrance: 50, hue: 0 },
  { exposure: -10, all: defaultCurve, red: defaultCurve, green: defaultCurve, blue: defaultCurve, vibrance: 50, hue: 0 },
  { exposure: 0, all: [65, 50, 100], red: defaultCurve, green: defaultCurve, blue: defaultCurve, vibrance: 50, hue: 0 },
  { exposure: 0, all: [50, 65, 130], red: defaultCurve, green: defaultCurve, blue: defaultCurve, vibrance: 50, hue: 0 },
  { exposure: 0, all: defaultCurve, red: [70, 50, 100], green: defaultCurve, blue: defaultCurve, vibrance: 75, hue: 30 },
  { exposure: 15, all: [40, 55, 90], red: defaultCurve, green: defaultCurve, blue: defaultCurve, vibrance: 0, hue: 0 },
  { exposure: 0, all: defaultCurve, red: defaultCurve, green: defaultCurve, blue: defaultCurve, vibrance: 50, hue: 0 },
];

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function expectedLumaForPatch(nits, ctrl) {
  const exposed = nits * 2 ** (ctrl.exposure / 10);
  const pq = pqFromNits(exposed);
  const isDef = (c) => c[0] === 50 && c[1] === 50 && c[2] === 100;
  if (isDef(ctrl.all) && isDef(ctrl.red) && isDef(ctrl.green) && isDef(ctrl.blue) && ctrl.vibrance === 50 && ctrl.hue === 0) {
    return 64 + 876 * pq;
  }
  const chs = [ctrl.red, ctrl.green, ctrl.blue];
  const rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const contrast = (ctrl.all[1] / 50) * (chs[i][1] / 50);
    const offset = (ctrl.all[0] - 50) / 100 + (chs[i][0] - 50) / 100;
    const gamma = Math.min(7.84, Math.max(0.09, (ctrl.all[2] / 100) * (chs[i][2] / 100)));
    rgb[i] = Math.pow(clamp01((pq - 0.5) * contrast + 0.5 + offset), 1 / gamma);
  }
  const vib = (ctrl.vibrance - 50) / 50;
  if (vib !== 0) {
    const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const sat = Math.max(...rgb) - Math.min(...rgb);
    const scale = vib < 0 ? 1 + vib : 1 + vib * (2 - sat);
    for (let i = 0; i < 3; i++) rgb[i] = clamp01(luma + (rgb[i] - luma) * scale);
  }
  if (ctrl.hue !== 0) {
    const rad = (ctrl.hue * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const [r, g, b] = rgb;
    rgb[0] = clamp01((0.213 + 0.787 * c - 0.213 * s) * r + (0.715 - 0.715 * c - 0.715 * s) * g + (0.072 - 0.072 * c + 0.928 * s) * b);
    rgb[1] = clamp01((0.213 - 0.213 * c + 0.143 * s) * r + (0.715 + 0.285 * c + 0.140 * s) * g + (0.072 - 0.072 * c - 0.283 * s) * b);
    rgb[2] = clamp01((0.213 - 0.213 * c - 0.787 * s) * r + (0.715 - 0.715 * c + 0.715 * s) * g + (0.072 + 0.928 * c + 0.072 * s) * b);
  }
  const y = 0.2627 * rgb[0] + 0.6780 * rgb[1] + 0.0593 * rgb[2];
  return 64 + 876 * clamp01(y);
}

const width = 256, height = 128, frames = 240, fps = 60;
const encoded = [], acknowledgements = [];
let diagnostics = '', pending = '', sent = 0, timer, bytes = 0;
const child = spawn(executable, ['--synthetic', '--realtime', '--watch-parent', '--frames', String(frames),
  '--width', String(width), '--height', String(height), '--fps', String(fps), '--bitrate-kbps', '1000'],
  { windowsHide: true, stdio: 'pipe' });

function sendNext() {
  if (sent === controls.length) return;
  const ctrl = controls[sent++];
  const packet = Buffer.alloc(40);
  packet.write('HDC2', 0, 'ascii');
  packet.writeUInt32LE(sent, 4);
  packet.writeInt16LE(ctrl.exposure, 8);
  let offset = 10;
  for (const curve of [ctrl.all, ctrl.red, ctrl.green, ctrl.blue]) {
    packet.writeUInt16LE(curve[0], offset);
    packet.writeUInt16LE(curve[1], offset + 2);
    packet.writeUInt16LE(curve[2], offset + 4);
    offset += 6;
  }
  packet.writeUInt16LE(ctrl.vibrance, 34);
  packet.writeUInt16LE(ctrl.hue, 36);
  packet.writeUInt16LE(0, 38);
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
  const ctrl = controls[i];
  if (ack.revision !== i + 1 || ack.exposureTenths !== ctrl.exposure) throw new Error('Mismatched color revision');
  const patches = PATCH_NITS.map((nits, patch) => {
    const expected = expectedLumaForPatch(nits, ctrl);
    const x = patch * width / 4 + width / 8, y = height / 2;
    const actual = decoded.readUInt16LE(ack.frame * width * height * 3 + (y * width + x) * 2);
    if (Math.abs(actual - expected) > 10) throw new Error(`Wrong color pixels: ${JSON.stringify({ ack, nits, actual, expected })}`);
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
