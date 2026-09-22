import { describe, expect, it } from 'vitest';
import { consumeBottomScrollRequest } from './bottomScrollRequest';

describe('consumeBottomScrollRequest', () => {
  it('ignores a missing or already consumed marker', () => {
    const tracker = { channelId: 'channel-a', marker: 'message:1' };

    expect(consumeBottomScrollRequest(tracker, 'channel-a', null).shouldScroll).toBe(false);
    expect(consumeBottomScrollRequest(tracker, 'channel-a', 'message:1').shouldScroll).toBe(false);
  });

  it('scrolls for each new local message or pending attachment marker', () => {
    const initial = { channelId: 'channel-a', marker: null };
    const message = consumeBottomScrollRequest(initial, 'channel-a', 'message:temp-1');
    const attachment = consumeBottomScrollRequest(message.tracker, 'channel-a', 'pending:upload-1');

    expect(message.shouldScroll).toBe(true);
    expect(attachment.shouldScroll).toBe(true);
  });

  it('seeds the current marker on channel changes without scrolling', () => {
    const switched = consumeBottomScrollRequest(
      { channelId: 'channel-a', marker: 'message:1' },
      'channel-b',
      'message:restored',
    );

    expect(switched.shouldScroll).toBe(false);
    expect(switched.tracker).toEqual({ channelId: 'channel-b', marker: 'message:restored' });
    expect(consumeBottomScrollRequest(
      switched.tracker,
      'channel-b',
      'message:new-local',
    ).shouldScroll).toBe(true);
  });
});
