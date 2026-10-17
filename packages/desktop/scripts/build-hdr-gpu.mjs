// Native GPU encoder; embeds the reviewed shader, with no runtime shader path.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(desktop, 'native');
const repo = path.resolve(desktop, '../..');
const destination = path.join(desktop, 'hdr-runtime');
const generated = path.join(repo, 'experiments/windows-hdr/.artifacts/gpu-build');
const args = process.argv.slice(2);
const zig = args.includes('--zig') ? args[args.indexOf('--zig') + 1] :
  path.join(repo, 'experiments/windows-hdr/.artifacts/tools/zig-x86_64-windows-0.15.2/zig.exe');
if (process.platform !== 'win32' || !zig) throw new Error('Windows x64 and the pinned Zig compiler are required');
const header = await fs.readFile(path.join(native, 'vendor/nvEncodeAPI.h'));
// Git normalizes text line endings; hash the upstream LF form on all hosts.
const hash = createHash('sha256').update(header.toString().replaceAll('\r\n', '\n')).digest('hex');
if (hash !== '4fe4094541ef0f8a13249d97a8692dc5f835a6e9dd42eeadb3e2f7321d54dc7e') throw new Error('Unexpected NVENC API header');
await fs.mkdir(destination, { recursive: true });
await fs.mkdir(generated, { recursive: true });
const shader = (await fs.readFile(path.join(native, 'HdrGpuShader.hlsl'), 'utf8')).replaceAll('\r\n', '\n');
if (shader.includes(')HDR"')) throw new Error('Shader delimiter collision');
await fs.writeFile(path.join(generated, 'HdrGpuShader.h'), `static constexpr const char* HdrGpuShader = R"HDR(${shader})HDR";\n`);
await new Promise((resolve, reject) => {
  const child = spawn(zig, ['c++', '-std=c++17', '-O2', '-fms-extensions', `-I${generated}`, path.join(native, 'HdrGpu.cpp'),
    '-ld3d11', '-ldxgi', '-lole32', '-luuid', '-lapi-ms-win-core-winrt-l1-1-0', '-lapi-ms-win-core-winrt-string-l1-1-0',
    '-o', path.join(destination, 'HdrGpu.exe')], { windowsHide: true, stdio: 'inherit' });
  child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Native GPU build failed (${code})`)));
});
const licenses = path.join(destination, 'gpu-licenses');
await fs.mkdir(licenses, { recursive: true });
for (const [source, target] of [
  ['LICENSE', 'Zig-MIT.txt'], ['lib/libcxx/LICENSE.TXT', 'libcxx.txt'],
  ['lib/libcxxabi/LICENSE.TXT', 'libcxxabi.txt'], ['lib/libunwind/LICENSE.TXT', 'libunwind.txt'],
  ['lib/libc/mingw/COPYING', 'mingw-w64.txt'],
]) await fs.copyFile(path.join(path.dirname(zig), source), path.join(licenses, target));
await fs.writeFile(path.join(licenses, 'NVENC-MIT.txt'), header.toString().slice(0, header.toString().indexOf('*/') + 2) + '\n');
console.log(`Native GPU encoder: ${path.join(destination, 'HdrGpu.exe')}`);
