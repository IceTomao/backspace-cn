// Explicit Windows developer build. Does not download, publish or grant acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '../..');
const native = path.join(desktop, 'native');
const runtime = path.join(repo, 'experiments/windows-hdr/.artifacts/runtime');
const destination = path.join(desktop, 'hdr-runtime');
const args = process.argv.slice(2);
const go = args.includes('--go') ? args[args.indexOf('--go') + 1] : 'go';
if (process.platform !== 'win32' || !go) throw new Error('Build on Windows x64 with Go 1.26.8 or newer');
const csc = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
async function run(command, args, cwd = desktop) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${code})`)));
  });
}
await fs.mkdir(destination, { recursive: true });
await run(process.execPath, [path.join(desktop, 'scripts/build-hdr-gpu.mjs'),
  ...(args.includes('--zig') ? ['--zig', args[args.indexOf('--zig') + 1]] : [])]);
const probe = path.join(repo, 'experiments/windows-hdr/DisplayProbe.cs');
await run(csc, ['/nologo', '/platform:x64', '/target:exe', `/out:${path.join(destination, 'DisplayProbe.exe')}`, probe]);
await run(csc, ['/nologo', '/platform:x64', '/target:exe', '/main:HdrPlayer', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  '/r:System.Web.Extensions.dll', `/out:${path.join(destination, 'HdrPlayer.exe')}`, path.join(native, 'HdrPlayer.cs'), probe]);
await run(csc, ['/nologo', '/platform:x64', '/target:exe', '/r:System.Web.Extensions.dll', `/out:${path.join(destination, 'HdrAudio.exe')}`, path.join(native, 'HdrAudio.cs')]);
await run(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(destination, 'hdr-bridge.exe'), '.'], path.join(native, 'hdr-bridge'));
await fs.copyFile(path.join(native, 'hdr-probe.hevc'), path.join(destination, 'hdr-probe.hevc'));
await fs.copyFile(path.join(native, 'acceptance.json'), path.join(destination, 'acceptance.json'));

if (args.includes('--assemble-runtime')) {
  // setup-runtime.mjs pins downloads by asset ID and SHA-256 before extraction.
  // Copy DLLs with their matching FFmpeg executable, never mix library versions.
  for (const [name, directory] of [['encoder', 'ffmpeg-8.0.1-full_build-shared']]) {
    const source = path.join(runtime, directory);
    await fs.mkdir(path.join(destination, name), { recursive: true });
    for (const file of await fs.readdir(path.join(source, 'bin'))) {
      if (file.endsWith('.dll') || file === 'ffmpeg.exe' || (name === 'encoder' && file === 'ffprobe.exe'))
        await fs.copyFile(path.join(source, 'bin', file), path.join(destination, name, file));
    }
    for (const file of ['LICENSE', 'README.txt']) await fs.copyFile(path.join(source, file), path.join(destination, name, file));
  }
  await fs.copyFile(path.join(runtime, 'player/libmpv-2.dll'), path.join(destination, 'libmpv-2.dll'));
  await fs.copyFile(path.join(native, 'THIRD_PARTY_NOTICES.md'), path.join(destination, 'THIRD_PARTY_NOTICES.md'));
  await run(path.join(destination, 'HdrPlayer.exe'), ['--check-runtime']);
}
console.log(`Native HDR build: ${destination}`);
console.log('HDR hardware acceptance remains false; experimental availability is controlled by acceptance.json.');
