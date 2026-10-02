import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function androidReleaseContract(version) {
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), 'Expected a stable release version');
  const tag = `android-v${version}`;
  const apkName = `Backspace-CN-${version}-android.apk`;
  return { tag, apkName, assets: [apkName, `${apkName}.sha256`, 'APK-VERIFICATION.txt'].sort() };
}

// The tag endpoint excludes unpublished drafts; authenticated release lists
// include them. Paginate so an older failed draft can also be resumed.
export async function findAndroidRelease(tag, loadPage) {
  for (let page = 1; ; page++) {
    const releases = await loadPage(page);
    assert(Array.isArray(releases), 'Expected a release list');
    const matches = releases.filter(release => release.tag_name === tag);
    assert(matches.length <= 1, 'Multiple releases use the Android version tag');
    if (matches.length) return matches[0];
    if (releases.length < 100) return null;
  }
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const repo = process.env.GITHUB_REPOSITORY || 'IceTomao/backspace-cn';
  assert(repo === 'IceTomao/backspace-cn', 'Android update releases belong to IceTomao/backspace-cn');
  assert(process.env.GH_TOKEN, 'Set GH_TOKEN for release publishing');
  const gh = (...args) => execFileSync('gh', args, { cwd: root, stdio: 'inherit' });
  // Publishing always checks the signed package, including on workflow reruns.
  execFileSync(process.execPath, ['scripts/verify-android-apk.mjs'], { cwd: root, stdio: 'inherit' });
  const version = JSON.parse(readFileSync(path.join(root, 'packages/android/package.json'), 'utf8')).version;
  const { tag, apkName, assets } = androidReleaseContract(version);
  const output = path.join(root, 'packages/android/android/app/build/outputs/apk/release');
  const apk = path.join(output, apkName);
  copyFileSync(path.join(output, 'app-release.apk'), apk);
  const hash = createHash('sha256').update(readFileSync(apk)).digest('hex');
  writeFileSync(`${apk}.sha256`, `${hash}  ${apkName}\n`);
  const notes = path.join(output, 'ANDROID-RELEASE-NOTES.md');
  const releaseNotes = path.join(root, 'docs/releases', `android-${version}.md`);
  writeFileSync(notes, existsSync(releaseNotes) ? readFileSync(releaseNotes, 'utf8') :
    `Backspace Android ${version}\n\n固定签名的安卓客户端。下载 APK 后按安卓系统提示安装；使用同一发行签名的旧版可以覆盖更新。\n`);
  const readRelease = () => findAndroidRelease(tag, async page => {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `Release lookup failed (${response.status})`);
    return response.json();
  });
  let release = await readRelease();
  const validateAssets = (value) => {
    const actual = value.assets.filter(asset => asset.state === 'uploaded' && asset.size > 0).map(asset => asset.name).sort();
    assert.deepEqual(actual, assets, 'Published Android release has missing or unexpected assets');
    assert(!value.prerelease, 'Android updater uses stable releases only');
  };
  if (release && !release.draft) {
    validateAssets(release);
    console.log(`${tag} is already published; keeping the existing APK. Bump the version to publish changes.`);
    return;
  }
  const target = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!release) {
    gh('release', 'create', tag, '--repo', repo, '--target', target, '--draft', '--latest=false', '--title', `Android ${version}`, '--notes-file', notes);
  }
  gh('release', 'upload', tag, '--repo', repo, apk, `${apk}.sha256`, path.join(output, 'APK-VERIFICATION.txt'), '--clobber');
  release = await readRelease();
  assert(release?.draft, 'Validate the draft before publishing');
  validateAssets(release);
  gh('release', 'edit', tag, '--repo', repo, '--target', target, '--draft=false', '--latest=false');
  console.log(`Published Android update: https://github.com/${repo}/releases/tag/${tag}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
