import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('loads the app audio module without AudioWorkletNode', async () => {
  vi.stubGlobal('AudioWorkletNode', undefined);
  const { AudioManager } = await import('./AudioManager');

  const manager = AudioManager.getInstance();
  await expect(manager.setRnnoiseEnabled(true)).resolves.toBeUndefined();
  expect(manager.isRnnoiseEnabled()).toBe(false);
});
