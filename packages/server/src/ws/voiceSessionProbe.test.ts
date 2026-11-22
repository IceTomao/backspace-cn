import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { connectionManager } from './handler.js';
import { handleClientEvent } from './events.js';

/**
 * A client that was quit or reloaded while in voice leaves the room membership
 * behind until the reconnect grace expires. When it comes back it must be able
 * to ask "am I still in there?" and have the server release the ghost — but
 * only when no live socket still owns the session.
 */

function socket(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

function sentEvents(ws: WebSocket): Array<Record<string, unknown>> {
  const send = ws.send as unknown as { mock: { calls: unknown[][] } };
  return send.mock.calls.map(([payload]) => JSON.parse(String(payload)) as Record<string, unknown>);
}

/** Runs the probe and returns only its reply, ignoring the leave broadcast. */
function probe(userId: string, ws: WebSocket): Array<Record<string, unknown>> {
  handleClientEvent({ type: 'voice_session_probe' }, userId, 'tester', ws, false);
  return sentEvents(ws).filter((event) => event.type === 'voice_session_state');
}

function joinSpace(userId: string, roomId: string, ws: WebSocket, spaceId = `space-${roomId}`): void {
  connectionManager.createRoom(roomId, 'space', { type: 'space', spaceId });
  connectionManager.joinRoom(roomId, userId);
  connectionManager.addConnection(userId, ws);
  connectionManager.setVoiceWs(userId, ws);
  connectionManager.setUserSpaces(userId, [spaceId]);
}

describe('voice session probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports a live session without disturbing it', () => {
    const ws = socket();
    joinSpace('probe-live-user', 'probe-live-room', ws);

    const replies = probe('probe-live-user', ws);

    expect(replies).toEqual([
      { type: 'voice_session_state', inVoice: true, channelId: 'probe-live-room' },
    ]);
    expect([...connectionManager.getRoomParticipants('probe-live-room')]).toContain('probe-live-user');
    connectionManager.destroyRoom('probe-live-room');
  });

  it('releases a membership whose owning socket already closed', () => {
    const ws = socket();
    joinSpace('probe-ghost-user', 'probe-ghost-room', ws);
    // The app quits: its socket closes and the room is held by the grace timer.
    connectionManager.removeConnection(ws);

    const reconnected = socket();
    connectionManager.addConnection('probe-ghost-user', reconnected);

    const replies = probe('probe-ghost-user', reconnected);

    expect(replies).toEqual([
      { type: 'voice_session_state', inVoice: false, channelId: 'probe-ghost-room' },
    ]);
    // The same socket gets the leave broadcast too: it is a member of the space.
    expect(sentEvents(reconnected)).toContainEqual({
      type: 'voice_state_update', channelId: 'probe-ghost-room', userId: 'probe-ghost-user', action: 'leave',
    });
    expect(connectionManager.getUserRoom('probe-ghost-user')).toBeNull();
    expect([...connectionManager.getRoomParticipants('probe-ghost-room')]).not.toContain('probe-ghost-user');
    connectionManager.destroyRoom('probe-ghost-room');
  });

  it('broadcasts a leave so other clients drop the ghost', () => {
    const ownerWs = socket();
    const watcherWs = socket();
    joinSpace('probe-owner', 'probe-broadcast-room', ownerWs, 'probe-broadcast-space');
    connectionManager.addConnection('probe-watcher', watcherWs);
    connectionManager.setUserSpaces('probe-watcher', ['probe-broadcast-space']);

    connectionManager.removeConnection(ownerWs);

    const reconnected = socket();
    connectionManager.addConnection('probe-owner', reconnected);
    probe('probe-owner', reconnected);

    expect(sentEvents(watcherWs)).toEqual([
      { type: 'voice_state_update', channelId: 'probe-broadcast-room', userId: 'probe-owner', action: 'leave' },
    ]);
    connectionManager.removeConnection(watcherWs);
    connectionManager.destroyRoom('probe-broadcast-room');
  });

  it('answers with a null channel when the user is not in any room', () => {
    const ws = socket();
    connectionManager.addConnection('probe-idle-user', ws);

    const replies = probe('probe-idle-user', ws);

    expect(replies).toEqual([{ type: 'voice_session_state', inVoice: false, channelId: null }]);
    expect(connectionManager.getUserRoom('probe-idle-user')).toBeNull();
    connectionManager.removeConnection(ws);
  });

  it('keeps a session that another tab still owns', () => {
    const tabA = socket();
    const tabB = socket();
    joinSpace('probe-multitab', 'probe-multitab-room', tabA);
    connectionManager.addConnection('probe-multitab', tabB);

    const replies = probe('probe-multitab', tabB);

    expect(replies).toEqual([
      { type: 'voice_session_state', inVoice: true, channelId: 'probe-multitab-room' },
    ]);
    expect([...connectionManager.getRoomParticipants('probe-multitab-room')]).toContain('probe-multitab');
    connectionManager.destroyRoom('probe-multitab-room');
  });
});
