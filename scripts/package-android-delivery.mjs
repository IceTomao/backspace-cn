import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const name = 'Backspace-CN-1.0.0-android';
const output = path.join(root, 'installers', name);
const apk = path.join(root, 'packages/android/android/app/build/outputs/apk/release/app-release.apk');
const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA, 'Android/Sdk');
const tools = path.join(sdk, 'build-tools/36.0.0');
assert(existsSync(apk), 'Build the signed release first');
const signature = execFileSync(path.join(process.env.JAVA_HOME, 'bin/java.exe'),
  ['-jar', path.join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', apk], { encoding: 'utf8' });
assert(signature.includes('Verified using v2 scheme (APK Signature Scheme v2): true'), 'APK v2 signature is required');
const badging = execFileSync(path.join(tools, 'aapt.exe'), ['dump', 'badging', apk], { encoding: 'utf8' });
assert(badging.includes("package: name='me.kevz.backspace' versionCode='1' versionName='1.0.0'"));
assert(badging.includes("sdkVersion:'31'") && badging.includes("targetSdkVersion:'36'"));
assert(badging.includes("'arm64-v8a'") && badging.includes("'armeabi-v7a'"), 'Both ARM ABIs are required');
const permissions = execFileSync(path.join(tools, 'aapt.exe'), ['dump', 'permissions', apk], { encoding: 'utf8' });
assert(!/CAMERA|MEDIA_PROJECTION|READ_CONTACTS|READ_SMS|MANAGE_EXTERNAL_STORAGE|REQUEST_INSTALL_PACKAGES/.test(permissions));
assert(!badging.includes('application-debuggable'), 'Do not distribute a debuggable APK');
const entries = execFileSync('tar.exe', ['-tf', apk], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const privateValues = [];
function collectLocalSecrets(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!/^(node_modules|\.git|\.cache|\.gradle|dist.*|build|installers|data)$/.test(entry.name)) collectLocalSecrets(file);
    } else if (/^\.env($|\.)/.test(entry.name) && !entry.name.endsWith('.example')) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^(?:JWT_SECRET|LIVEKIT_API_SECRET|LIVEKIT_API_KEY)\s*=\s*["']?([^"'\r\n]+)["']?$/);
        if (match?.[1]?.length >= 16) privateValues.push(Buffer.from(match[1].trim()));
      }
    }
  }
}
collectLocalSecrets(root);
const signingFile = path.join(process.env.LOCALAPPDATA, 'BackspaceAndroidSigning/signing.json');
if (existsSync(signingFile)) privateValues.push(Buffer.from(JSON.parse(readFileSync(signingFile, 'utf8').replace(/^\uFEFF/, '')).password));
function assertNoSecrets(bytes, label) {
  assert(!privateValues.some(secret => bytes.includes(secret)), `Private value found in ${label}`);
}
assert(!entries.some(file => /(^|\/)(\.env|signing\.json)|\.(jks|keystore|p12|db|sqlite)$/.test(file)));
assert(!entries.some(file => /(^|\/)(sw\.js|workbox-[^/]+\.js)$/.test(file)), 'No Service Worker in APK');
assert(entries.some(file => file.startsWith('lib/arm64-v8a/') && file.endsWith('.so')));
assert(entries.some(file => file.startsWith('lib/armeabi-v7a/') && file.endsWith('.so')));
const config = execFileSync('tar.exe', ['-xOf', apk, 'assets/capacitor.config.json'], { encoding: 'utf8' });
assert(!JSON.parse(config).server.url, 'Only bundled pages may use the native bridge');
for (const entry of entries.filter(file => /\.(dex|js|json|html|css|xml|txt)$/.test(file))) {
  const bytes = execFileSync('tar.exe', ['-xOf', apk, entry], { maxBuffer: 64 * 1024 * 1024 });
  assertNoSecrets(bytes, `APK ${entry}`);
}
const files = execFileSync('git.exe', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean).filter(file =>
  !/(^|\/)(node_modules|\.cache|\.gradle|\.git|data|dist(?:-android|-electron)?|installers)\//.test(file) &&
  !/^packages\/android\/android\/(?:app\/)?build\//.test(file) &&
  !/^packages\/android\/android\/app\/src\/main\/assets\//.test(file));
for (const file of files) {
  assert(!/[\r\n]/.test(file));
  assert(!/(^|\/)\.env(?:$|\.)/.test(file) || file.endsWith('.env.example'), `Private environment: ${file}`);
  assert(!/\.(db|sqlite|pem|key|pfx|p12|jks|keystore)$|(^|\/)(signing\.json|local\.properties)$/.test(file), `Private data: ${file}`);
  assertNoSecrets(readFileSync(path.join(root, file)), `source ${file}`);
}
mkdirSync(output, { recursive: true });
copyFileSync(apk, path.join(output, `${name}.apk`));
copyFileSync(path.join(root, 'docs/ANDROID_CN_DELIVERY.md'), path.join(output, 'README.md'));
const sourceName = 'Backspace-CN-1.0.0-android-source.zip';
execFileSync('tar.exe', ['-a', '-cf', path.join(output, sourceName), '-T', '-'], {
  cwd: root, input: files.sort().join('\n') + '\n', timeout: 180000,
});
writeFileSync(path.join(output, 'APK-VERIFICATION.txt'), `${signature}\n${badging}\n${permissions}\n`);
const hashes = [`${name}.apk`, sourceName, 'README.md', 'APK-VERIFICATION.txt'].map(file =>
  `${createHash('sha256').update(readFileSync(path.join(output, file))).digest('hex')}  ${file}`);
writeFileSync(path.join(output, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
console.log(`Verified signed Android release: ${output}\n${hashes.join('\n')}`);
