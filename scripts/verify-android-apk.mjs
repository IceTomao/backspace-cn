import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const apk = path.join(root, 'packages/android/android/app/build/outputs/apk/release/app-release.apk');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
assert(sdk && process.env.JAVA_HOME, 'Set ANDROID_HOME and JAVA_HOME');
assert(existsSync(apk), 'Build the signed release APK first');
const suffix = process.platform === 'win32' ? '.exe' : '';
const tools = path.join(sdk, 'build-tools/36.0.0');
const signature = execFileSync(path.join(process.env.JAVA_HOME, `bin/java${suffix}`), [
  '-jar', path.join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', apk,
], { encoding: 'utf8' });
assert(signature.includes('Verified using v2 scheme (APK Signature Scheme v2): true'), 'APK v2 signature required');
const actual = signature.match(/Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)/)?.[1]?.toLowerCase();
const expected = readFileSync(path.join(root, 'packages/android/signing-certificate.sha256'), 'utf8').trim().toLowerCase();
assert(/^[a-f0-9]{64}$/.test(expected) && actual === expected, 'APK signing certificate differs from the fixed release certificate');
const badging = execFileSync(path.join(tools, `aapt2${suffix}`), ['dump', 'badging', apk], { encoding: 'utf8' });
const version = JSON.parse(readFileSync(path.join(root, 'packages/android/package.json'), 'utf8')).version;
const [major, minor, patch] = version.split('.').map(Number);
assert(badging.includes(`package: name='me.kevz.backspace' versionCode='${major * 1000000 + minor * 1000 + patch}' versionName='${version}'`));
assert(!badging.includes('application-debuggable'), 'Release APK must not be debuggable');
assert(badging.includes("'arm64-v8a'") && badging.includes("'armeabi-v7a'"), 'Both ARM ABIs required');
assert(!/uses-permission: name='android.permission.(?:CAMERA|READ_CONTACTS|READ_SMS|MANAGE_EXTERNAL_STORAGE|REQUEST_INSTALL_PACKAGES)'/.test(badging));
const hash = createHash('sha256').update(readFileSync(apk)).digest('hex');
writeFileSync(path.join(path.dirname(apk), 'APK-VERIFICATION.txt'), `${signature}\n${badging}`);
writeFileSync(path.join(path.dirname(apk), 'SHA256SUMS.txt'), `${hash}  app-release.apk\n`);
console.log(`Verified fixed release certificate: ${actual}\nAPK SHA-256: ${hash}`);
