import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'packages/desktop');
const manifest = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const name = `Backspace-CN-${manifest.version}-win-x64`;
const output = path.join(root, 'installers', name);
const unpacked = path.join(desktop, 'dist-electron/win-unpacked');
const archive = path.join(unpacked, 'resources/app.asar');
const requireDesktop = createRequire(path.join(desktop, 'package.json'));
const requireBuilder = createRequire(requireDesktop.resolve('electron-builder'));
const requireLib = createRequire(requireBuilder.resolve('app-builder-lib'));
const asar = requireLib('@electron/asar');
const files = asar.listPackage(archive).map((file) => file.replaceAll('\\', '/'));
const forbidden = files.filter((file) =>
  /(^|\/)\.env(?:$|\.)|\.db$|\.test\.(js|d\.ts)(\.map)?$|app-update\.yml$/.test(file));
assert.deepEqual(forbidden, [], 'Private data or test files must not enter the client');
assert(files.includes('/build/icon.png'), 'Window icon is missing');
assert(!existsSync(path.join(unpacked, 'resources/app-update.yml')), 'Upstream update feed must not ship');
const config = asar.extractFile(archive, 'dist/buildConfig.js').toString();
assert(config.includes("defaultInstanceUrl: 'https://chat.kevz.me:2096'"));
assert(config.includes("defaultLanguage: 'zh'"));
assert(config.includes('updatesEnabled: false'));
const nativePath = 'node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node';
const packagedNative = path.join(unpacked, 'resources/app.asar.unpacked', nativePath);
assert(existsSync(packagedNative), 'Windows x64 native module is missing');
assert(readFileSync(packagedNative).equals(readFileSync(path.join(desktop, nativePath))),
  'Packaged native module differs from the verified dependency');
const { getCurrentFuseWire, FuseV1Options, FuseState } =
  await import(pathToFileURL(requireDesktop.resolve('@electron/fuses')).href);
const fuses = await getCurrentFuseWire(path.join(unpacked, 'Backspace.exe'));
assert.equal(fuses[FuseV1Options.RunAsNode], FuseState.DISABLE);
assert.equal(fuses[FuseV1Options.EnableNodeCliInspectArguments], FuseState.DISABLE);
assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], FuseState.ENABLE);

// Archive the working source, including uncommitted implementation files, never
// the whole directory: ignored credentials, databases and build output stay out.
const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean).sort();
assert(sourceFiles.length > 0);
for (const file of sourceFiles) {
  assert(!/[\r\n]/.test(file), 'Unsupported newline in source path');
  assert(!/(^|\/)(node_modules|data|dist|dist-electron|installers|\.git)\//.test(file), `Unexpected source path: ${file}`);
  assert(!/(^|\/)\.env($|\.)/.test(file) || file.endsWith('.env.example'), `Private config: ${file}`);
  assert(!/\.(db|pem|key|pfx|p12)$/.test(file), `Private data: ${file}`);
}
mkdirSync(output, { recursive: true });
copyFileSync(path.join(desktop, `dist-electron/${name}.exe`), path.join(output, `${name}.exe`));
copyFileSync(path.join(root, 'docs/WINDOWS_CN_DELIVERY.md'), path.join(output, 'README.md'));
const sourceName = `Backspace-CN-${manifest.version}-source.zip`;
execFileSync('tar', ['-a', '-cf', path.join(output, sourceName), '-T', '-'], {
  cwd: root, input: sourceFiles.join('\n') + '\n', timeout: 120_000,
});
const hashes = [`${name}.exe`, sourceName, 'README.md'].map((file) => {
  const digest = createHash('sha256').update(readFileSync(path.join(output, file))).digest('hex');
  return `${digest}  ${file}`;
});
writeFileSync(path.join(output, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
console.log(`Verified native module, defaults, private-file exclusions and Electron fuses.\nDelivery: ${output}\n${hashes.join('\n')}`);
