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
const packageOnly = process.argv.includes('--package-only');

function verifyUpdateFeed() {
  const updateConfigPath = path.join(unpacked, 'resources/app-update.yml');
  assert(existsSync(updateConfigPath), 'Packaged GitHub update feed is missing');
  const updateConfig = readFileSync(updateConfigPath, 'utf8');
  for (const [key, value] of Object.entries({
    provider: 'github',
    owner: 'IceTomao',
    repo: 'backspace-cn',
  })) {
    assert(new RegExp(`^${key}:\\s*["']?${value}["']?\\s*$`, 'm').test(updateConfig),
      `Packaged update feed must contain ${key}: ${value}`);
  }

  const latestPath = path.join(desktop, 'dist-electron/latest.yml');
  assert(existsSync(latestPath), 'Windows latest.yml is missing');
  const latest = readFileSync(latestPath, 'utf8');
  assert(new RegExp(`^version:\\s*["']?${manifest.version}["']?\\s*$`, 'm').test(latest),
    'latest.yml version differs from source');
  assert(latest.includes(`${name}.exe`), 'latest.yml does not reference the Windows x64 installer');
}

async function verifyPackagedApp() {
const requireDesktop = createRequire(path.join(desktop, 'package.json'));
const requireBuilder = createRequire(requireDesktop.resolve('electron-builder'));
const requireLib = createRequire(requireBuilder.resolve('app-builder-lib'));
const asar = requireLib('@electron/asar');
const files = asar.listPackage(archive).map((file) => file.replaceAll('\\', '/'));
const forbidden = files.filter((file) =>
  /(^|\/)\.env(?:$|\.)|\.db$|\.test\.(js|d\.ts)(\.map)?$|app-update\.yml$/.test(file));
assert.deepEqual(forbidden, [], 'Private data or test files must not enter the client');
assert(files.includes('/build/icon.png'), 'Window icon is missing');
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json').toString()).version, manifest.version,
  'Installer application version differs from source');
assert(files.includes('/dist/theme.js'), 'Theme manager is missing');
assert(asar.extractFile(archive, 'resources/theme.css').equals(
  readFileSync(path.join(desktop, 'resources/theme.css'))), 'Bundled theme stylesheet differs from source');
const preload = asar.extractFile(archive, 'dist/preload.js').toString();
assert(preload.includes('desktop-theme-styles') && preload.includes('insertCSS'), 'Theme bootstrap is missing');
assert(files.includes('/dist/favoriteImages.js'), 'Favorite image storage is missing');
assert(preload.includes('desktop-favorite-images') && !preload.includes('require("./favoritesPreload")'),
  'Favorite image preload must be bundled for the sandbox');
for (const resource of ['emoji-policy.js', 'favorites.css', 'lucide-LICENSE.txt']) {
  assert(asar.extractFile(archive, `resources/${resource}`).equals(
    readFileSync(path.join(desktop, 'resources', resource))), `Bundled ${resource} differs from source`);
}
const requireSharp = createRequire(requireDesktop.resolve('sharp'));
const sharpEntry = requireSharp.resolve('@img/sharp-win32-x64/package');
const sharpRoot = path.dirname(sharpEntry);
const sharpManifest = JSON.parse(readFileSync(path.join(sharpRoot, 'package.json'), 'utf8'));
for (const file of [`sharp-win32-x64-${sharpManifest.version}.node`, 'libvips-42.dll', 'libvips-cpp-8.18.6.dll']) {
  const relative = `node_modules/@img/sharp-win32-x64/lib/${file}`;
  assert(readFileSync(path.join(unpacked, 'resources/app.asar.unpacked', relative)).equals(
    readFileSync(path.join(sharpRoot, 'lib', file))), `Sharp runtime file differs: ${file}`);
}
const config = asar.extractFile(archive, 'dist/buildConfig.js').toString();
assert(config.includes("defaultInstanceUrl: 'https://chat.kevz.me:2096'"));
assert(config.includes("defaultLanguage: 'zh'"));
assert(config.includes('updatesEnabled: true'));
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
}
verifyUpdateFeed();
if (!packageOnly) await verifyPackagedApp();

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
const updaterFiles = [`${name}.exe`, `${name}.exe.blockmap`, 'latest.yml'];
for (const file of updaterFiles) {
  const source = path.join(desktop, 'dist-electron', file);
  assert(existsSync(source), `Missing updater artifact: ${file}`);
  copyFileSync(source, path.join(output, file));
}
copyFileSync(path.join(root, 'docs/WINDOWS_CN_DELIVERY.md'), path.join(output, 'README.md'));
const sourceName = `Backspace-CN-${manifest.version}-source.zip`;
execFileSync('tar', ['-a', '-cf', path.join(output, sourceName), '-T', '-'], {
  cwd: root, input: sourceFiles.join('\n') + '\n', timeout: 120_000,
});
const hashes = [...updaterFiles, sourceName, 'README.md'].map((file) => {
  const digest = createHash('sha256').update(readFileSync(path.join(output, file))).digest('hex');
  return `${digest}  ${file}`;
});
writeFileSync(path.join(output, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
console.log(`${packageOnly ? 'Package-only: packaged-app verification skipped.' : 'Verified updater source, native module, defaults, private-file exclusions and Electron fuses.'}\nDelivery: ${output}\n${hashes.join('\n')}`);
