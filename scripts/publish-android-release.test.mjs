import { test } from 'node:test';
import assert from 'node:assert/strict';
import { androidReleaseContract } from './publish-android-release.mjs';

test('Android releases use a separate tag and versioned signed APK', () => {
  const release = androidReleaseContract('1.3.22');
  assert.equal(release.tag, 'android-v1.3.22');
  assert.equal(release.apkName, 'Backspace-CN-1.3.22-android.apk');
  assert.deepEqual(release.assets, ['APK-VERIFICATION.txt', 'Backspace-CN-1.3.22-android.apk', 'Backspace-CN-1.3.22-android.apk.sha256']);
});
test('Unstable versions cannot be published to the Android stable channel', () => {
  for (const version of ['1.3.22-beta', 'v1.3.22', '01.3.22', '../1.3.22']) assert.throws(() => androidReleaseContract(version));
});
