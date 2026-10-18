// These run before GPU initialization, including on CI without NVIDIA hardware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../../packages/desktop/hdr-runtime/HdrGpu.exe', import.meta.url));
test('native GPU rejects invalid modes, dimensions and injected arguments before capture', { skip: process.platform !== 'win32' }, () => {
  const synthetic = ['--synthetic', '--frames', '1'];
  const cases = [[], ['--monitor', '0'], [...synthetic, '--monitor', '1'],
    [...synthetic, '--width', '3839'], [...synthetic, '--height', '0'], [...synthetic, '--fps', '121'],
    [...synthetic, '--bitrate-kbps', '200001'], [...synthetic, '--frames', '7201'],
    [...synthetic, '--exposure-tenths', '31'], [...synthetic, '--exposure-tenths', '-31'],
    [...synthetic, '--exposure-tenths', 'NaN'], [...synthetic, '--exposure-tenths', '1.5'],
    [...synthetic, '--brightness', '51'], [...synthetic, '--brightness', '-51'],
    [...synthetic, '--brightness', '0;anything'],
    ['--synthetic', '--frames', '0'], [...synthetic, '--pattern', '3'],
    ['--monitor', '18446744073709551616'], ['--monitor', '1:window_title=other'],
    [...synthetic, '--source-width', '512'], [...synthetic, '--source-width', '16385', '--source-height', '128'],
    ['--monitor', '1', '--source-width', '512', '--source-height', '128'],
    [...synthetic, '--width', '-1'], [...synthetic, '--output', 'anything'], [...synthetic, '--width']];
  for (const args of cases) {
    const result = spawnSync(executable, args, { windowsHide: true, timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout.length, 0);
    const event = JSON.parse(result.stderr.toString());
    assert.equal(event.type, 'failed');
    assert.match(event.reason, /^(invalid_|unknown_argument|missing_argument|argument_exceeds_limit)/);
  }
});
