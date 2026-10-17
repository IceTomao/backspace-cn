// Explicit developer download. Installs a pinned compiler inside ignored lab
// artifacts, without modifying the system/toolchain or product runtime.
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 required');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '.artifacts/tools');
const name = 'zig-x86_64-windows-0.15.2';
const archive = path.join(root, 'zig-0.15.2.zip');
const expected = '3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c';
const digest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
await fs.mkdir(root, { recursive: true });
let cached = false;
try { cached = (await fs.stat(archive)).size === 92614574 && await digest(archive) === expected; } catch { /* first run */ }
if (!cached) {
  const response = await fetch(`https://ziglang.org/download/0.15.2/${name}.zip`, { signal: AbortSignal.timeout(180000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Compiler download failed');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  if ((await fs.stat(archive)).size !== 92614574 || await digest(archive) !== expected) throw new Error('Compiler SHA-256 mismatch');
}
execFileSync(process.argv[2] ?? 'C:/Program Files/7-Zip/7z.exe', ['x', archive, `-o${root}`, '-y'], { windowsHide: true, stdio: 'inherit' });
console.log(`Verified developer compiler: ${path.join(root, name, 'zig.exe')}`);
