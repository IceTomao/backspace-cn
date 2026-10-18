// Preserve native sources, dependency notices and upstream source locations
// alongside the exact binaries used by the experimental Windows distribution.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '../..');
const cache = path.join(repo, 'experiments/windows-hdr/.artifacts/release-sources');
const runtime = path.join(desktop, 'hdr-runtime');
const version = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'))).version;
const sources = [
  ['ffmpeg-encoder', 'FFmpeg/FFmpeg', '894da5ca7d742e4429ffb2af534fcda0103ef593'],
  ['ffmpeg-player', 'FFmpeg/FFmpeg', '2d49d0e62438507f40409a4d5ca978563202dcf3'],
  ['mpv', 'mpv-player/mpv', 'dde0671072723c311df874a32dc4e48b5197ca62'],
  ['mpv-build', 'shinchiro/mpv-winbuild-cmake', '1f8d2e76255abc48f0456d9be99b4cab9c6566e6'],
];
await fs.mkdir(cache, { recursive: true });
function run(file, args, cwd = repo) {
  const result = spawnSync(file, args, { cwd, windowsHide: true, stdio: 'inherit', timeout: 180000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${file} failed (${result.status})`);
}
const sourceIndex = [];
for (const [name, repository, revision] of sources) {
  const archive = path.join(cache, `${name}-${revision}.tar.gz`);
  console.log(`Preserving source: ${name} ${revision}`);
  try {
    if ((await fs.stat(archive)).size < 10000 || spawnSync('tar.exe', ['-tf', archive], { windowsHide: true, stdio: 'ignore', timeout: 30000 }).status !== 0)
      throw new Error('Incomplete source cache');
  } catch {
    const response = await fetch(`https://api.github.com/repos/${repository}/tarball/${revision}`,
      { headers: { 'User-Agent': 'Backspace-HDR-release' }, signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Source download failed: ${name} ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    // A JSON/HTML error page must never become a source archive.
    if (bytes.length < 10000 || bytes[0] !== 31 || bytes[1] !== 139) throw new Error(`Invalid source archive: ${name}`);
    await fs.writeFile(`${archive}.partial`, bytes);
    if (spawnSync('tar.exe', ['-tf', `${archive}.partial`], { windowsHide: true, stdio: 'ignore', timeout: 30000 }).status !== 0)
      throw new Error(`Corrupt source archive: ${name}`);
    await fs.rename(`${archive}.partial`, archive);
  }
  const bytes = await fs.readFile(archive);
  sourceIndex.push({ name, repository, revision, archive: path.basename(archive), sha256: createHash('sha256').update(bytes).digest('hex') });
}
const native = path.join(cache, 'backspace-native');
await fs.cp(path.join(desktop, 'native'), native, { recursive: true, filter: source => !source.endsWith('.exe') && !source.includes(`${path.sep}.git${path.sep}`) });
await fs.cp(path.join(desktop, 'scripts'), path.join(cache, 'desktop-build-scripts'), { recursive: true });
await fs.cp(path.join(repo, 'experiments/windows-hdr/DisplayProbe.cs'), path.join(cache, 'DisplayProbe.cs'));
await fs.copyFile(path.join(repo, 'LICENSE'), path.join(cache, 'BACKSPACE-LICENSE'));
const go = process.argv.includes('--go') ? process.argv[process.argv.indexOf('--go') + 1] : 'go';
run(go, ['mod', 'vendor'], path.join(native, 'hdr-bridge'));
// go mod vendor retains module licenses, including parent-module notices for
// imported subpackages. Copy these to the installer, not just the source asset.
const licenses = path.join(runtime, 'dependency-licenses');
async function copyLicenses(directory, relative = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name), name = path.join(relative, entry.name);
    if (entry.isDirectory()) await copyLicenses(child, name);
    else if (/^(licen[cs]e|copying|notice|authors|copyright)([.-]|$)/i.test(entry.name)) {
      await fs.mkdir(path.dirname(path.join(licenses, name)), { recursive: true });
      await fs.copyFile(child, path.join(licenses, name));
    }
  }
}
await copyLicenses(path.join(native, 'hdr-bridge/vendor'));
run('tar.exe', ['-xf', path.join(cache, sourceIndex.find(source => source.name === 'mpv').archive), '-C', cache]);
const mpv = (await fs.readdir(cache)).find(name => name.startsWith('mpv-player-mpv-'));
if (!mpv) throw new Error('mpv source missing');
await fs.cp(path.join(cache, mpv, 'Copyright'), path.join(runtime, 'MPV-Copyright'));
await fs.cp(path.join(cache, mpv, 'LICENSE.GPL'), path.join(runtime, 'MPV-LICENSE.GPL'));
await fs.cp(path.join(runtime, 'encoder/README.txt'), path.join(cache, 'FFmpeg-build-configuration.txt'));
await fs.cp(path.join(runtime, 'THIRD_PARTY_NOTICES.md'), path.join(cache, 'THIRD_PARTY_NOTICES.md'));
await fs.writeFile(path.join(cache, 'source-index.json'), JSON.stringify({ version, sources: sourceIndex }, null, 2) + '\n');
await fs.copyFile(path.join(cache, 'source-index.json'), path.join(runtime, 'source-index.json'));
await fs.writeFile(path.join(runtime, 'SOURCES.txt'), `Backspace native sources and vendored Go dependencies:\nhttps://github.com/IceTomao/backspace-cn/releases/download/v${version}/Backspace-CN-${version}-HDR-sources.zip\n\nExact upstream source revisions are recorded in source-index.json.\nAdditional upstream-enabled library source repositories and build patches:\nhttps://github.com/shinchiro/mpv-winbuild-cmake/tree/1f8d2e76255abc48f0456d9be99b4cab9c6566e6/packages\nhttps://www.gyan.dev/ffmpeg/builds/\n`);
const out = path.join(desktop, 'dist-electron'); await fs.mkdir(out, { recursive: true });
run('C:/Program Files/7-Zip/7z.exe', ['a', '-tzip', '-mx=5', path.join(out, `Backspace-CN-${version}-HDR-sources.zip`), ...sourceIndex.map(source => source.archive),
  'backspace-native', 'desktop-build-scripts', 'DisplayProbe.cs', 'BACKSPACE-LICENSE', 'FFmpeg-build-configuration.txt', 'THIRD_PARTY_NOTICES.md', 'source-index.json'], cache);
console.log('Native source asset and bundled dependency notices prepared.');
