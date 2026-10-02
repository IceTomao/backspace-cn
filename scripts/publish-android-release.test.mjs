import { test } from 'node:test';
import assert from 'node:assert/strict';
import { androidReleaseContract, findAndroidRelease } from './publish-android-release.mjs';

test('Android releases use a separate tag and versioned signed APK', () => {
  const release = androidReleaseContract('1.3.22');
  assert.equal(release.tag, 'android-v1.3.22');
  assert.equal(release.apkName, 'Backspace-CN-1.3.22-android.apk');
  assert.deepEqual(release.assets, ['APK-VERIFICATION.txt', 'Backspace-CN-1.3.22-android.apk', 'Backspace-CN-1.3.22-android.apk.sha256']);
});
test('Unstable versions cannot be published to the Android stable channel', () => {
  for (const version of ['1.3.22-beta', 'v1.3.22', '01.3.22', '../1.3.22']) assert.throws(() => androidReleaseContract(version));
});
test('Resumes an unpublished Android draft through paginated release lists', async () => {
  const draft = { tag_name: 'android-v1.3.22', draft: true, assets: [] };
  const pages = [];
  const found = await findAndroidRelease(draft.tag_name, async page => {
    pages.push(page);
    return page === 1 ? Array.from({ length: 100 }, (_, index) => ({ tag_name: `v${index}` })) : [draft];
  });
  assert.equal(found, draft);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(await findAndroidRelease(draft.tag_name, async () => []), null);
});
test('Rejects malformed or duplicate release lists before publishing', async () => {
  await assert.rejects(findAndroidRelease('android-v1.3.22', async () => ({})));
  await assert.rejects(findAndroidRelease('android-v1.3.22', async () => [
    { tag_name: 'android-v1.3.22', draft: true }, { tag_name: 'android-v1.3.22', draft: false },
  ]));
});
