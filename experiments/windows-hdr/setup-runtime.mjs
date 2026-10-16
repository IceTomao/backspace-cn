// Development runtime only; no download or installation occurs in the product.
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '.artifacts', 'runtime');
mkdirSync(root, { recursive: true });
// Gyan's FFmpeg 8.0.1 shared build. Newer binaries can require NVENC 13.1 /
// driver 610 even though the RTX 4070 SUPER supports Main10 encoding.
const capture = process.argv[2] === 'capture';
const asset = `https://api.github.com/repos/GyanD/codexffmpeg/releases/assets/${capture ? '459519331' : '318698433'}`;
const size = capture ? 59459100 : 55372118;
const sha256 = capture ? 'cba748035c21ce1431d0823c7a3a711f38616f89f87a265dceddf9b7f6749d2d' : '8030dc469fbde247b84cfc21a5c421f3965ffe779bc35de08d78966e0c4a272c';
const archive = path.join(root, capture ? 'ffmpeg-8.1.2.7z' : 'ffmpeg-8.0.1.7z');
function length(file) { try { return statSync(file).size; } catch { return 0; } }
async function checksum(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function main() {
  if (length(archive) !== size || await checksum(archive) !== sha256) {
    const response = await fetch(asset, { headers: { Accept: 'application/octet-stream' }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const url = response.headers.get('location');
    if (!url || new URL(url).hostname !== 'release-assets.githubusercontent.com') throw new Error('Unexpected release asset redirect');
    const count = 32, step = Math.ceil(size / count);
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const file = path.join(root, `${capture ? 'capture' : 'encoder'}-chunk-${index}`), start = index * step, end = Math.min(size - 1, start + step - 1);
      for (let attempt = 0; length(file) < end - start + 1 && attempt < 5; attempt++) {
        const offset = length(file);
        try {
          const part = await fetch(url, { headers: { Range: `bytes=${start + offset}-${end}` }, signal: AbortSignal.timeout(30000) });
          if (part.status !== 206 || part.headers.get('content-range') !== `bytes ${start + offset}-${end}/${size}`) throw new Error('Invalid release range response');
          await pipeline(Readable.fromWeb(part.body), createWriteStream(file, { flags: 'a' }));
        } catch (error) { if (attempt === 4) throw error; }
      }
      if (length(file) !== end - start + 1) throw new Error(`Incomplete runtime chunk ${index}`);
    }));
    const out = createWriteStream(archive);
    for (let index = 0; index < count; index++) for await (const chunk of createReadStream(path.join(root, `${capture ? 'capture' : 'encoder'}-chunk-${index}`))) {
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
    if (await checksum(archive) !== sha256) throw new Error('Runtime SHA-256 mismatch; refusing to execute');
  }
  const sevenZip = process.argv[3] ?? 'C:\\Program Files\\7-Zip\\7z.exe';
  execFileSync(sevenZip, ['x', archive, `-o${root}`, '-y'], { windowsHide: true, stdio: 'inherit' });
  console.log(`Verified FFmpeg runtime extracted to ${root}. Its licenses/source references are included in the archive.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
