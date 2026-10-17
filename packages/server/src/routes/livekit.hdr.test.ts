import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { TrackSource, TrackType } from 'livekit-server-sdk';

const state = vi.hoisted(() => ({
  inRoom: true, streamAllowed: true, hdrEnabled: true, participant: null as any, fetched: vi.fn(),
  status: { isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false },
  broadcast: vi.fn(), removed: vi.fn(),
}));
vi.mock('../config.js', () => ({ config: { livekit: { apiKey: 'test-key', apiSecret: 'test-secret-at-least-32-characters', url: 'wss://voice.example', get nativeHdrEnabled() { return state.hdrEnabled; } } } }));
vi.mock('../utils/auth.js', () => ({ authenticate: async (request: any, reply: any) => {
  if (request.headers.authorization !== 'Bearer test') return reply.code(401).send({ error: 'unauthorized' });
  request.userId = 'alice'; request.username = 'Alice';
} }));
vi.mock('../utils/permissions.js', () => ({ getChannelSpaceId: () => 'space', hasPermission: (_user: unknown, _space: unknown, permission: bigint) => permission !== 2n || state.streamAllowed,
  computePermissions: () => state.streamAllowed ? 3n : 1n, isDmMember: () => false,
  PermissionBits: { SPEAK: 1n, STREAM: 2n, ADMINISTRATOR: 4n, CONNECT: 8n },
}));
vi.mock('../db/index.js', () => ({ getDb: () => ({}), schema: {} }));
vi.mock('../utils/voiceRecovery.js', () => ({ readVoiceServiceState: () => null }));
vi.mock('../ws/handler.js', () => ({ connectionManager: {
  getUserRoom: () => state.inRoom ? { roomId: 'channel', room: { roomType: 'space' } } : null,
  getVoiceUserStatus: () => state.status,
  setVoiceUserStatus: (_user: string, muted: boolean, deafened: boolean, camera: boolean, sharing: boolean) => {
    state.status = { isMuted: muted, isDeafened: deafened, isCameraOn: camera, isScreenSharing: sharing };
  }, sendToRoom: state.broadcast,
} }));
vi.mock('livekit-server-sdk', async original => ({ ...await original<typeof import('livekit-server-sdk')>(),
  RoomServiceClient: class {
    async listRooms() { return []; }
    async getParticipant() { state.fetched(); if (!state.participant) throw new Error('missing'); return state.participant; }
    removeParticipant = state.removed;
  },
}));

import { livekitRoutes } from './livekit.js';
import { hasNativeHdrPublication, stopNativeHdrSession, reconcileNativeHdrSessions } from '../utils/nativeHdr.js';
let app: FastifyInstance;
const identities: string[] = [];
beforeEach(async () => {
  state.inRoom = true; state.streamAllowed = true; state.hdrEnabled = true; state.participant = null; state.fetched.mockClear();
  state.status = { isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false };
  state.broadcast.mockClear(); state.removed.mockReset().mockResolvedValue(undefined);
  app = Fastify(); await app.register(livekitRoutes); await app.ready();
});

it('revokes a helper after STREAM permission is removed and retries an SFU outage without reannouncing HDR', async () => {
  const body = (await token({ role: 'publish' })).json(); const identity = body.nativeHdr.identity; identities.push(identity);
  state.participant = { tracks: [{ sid: 'video', name: 'backspace-screen-hdr-v1', type: TrackType.VIDEO, source: TrackSource.SCREEN_SHARE, muted: false, mimeType: 'video/h265', codecs: [] }] };
  const confirm = () => app.inject({ method: 'POST', url: '/api/livekit/hdr-publication', headers: { authorization: 'Bearer test' }, payload: { identity, trackSid: 'video' } });
  expect((await confirm()).statusCode).toBe(200);
  state.streamAllowed = false;
  state.removed.mockRejectedValueOnce(new Error('SFU temporarily unavailable'));
  await reconcileNativeHdrSessions();
  expect(hasNativeHdrPublication('alice', 'channel')).toBe(false);
  expect((await confirm()).statusCode).toBe(409);
  await reconcileNativeHdrSessions();
  expect(state.removed).toHaveBeenCalledTimes(2);
});
afterEach(async () => { for (const id of identities.splice(0)) await stopNativeHdrSession('alice', id); await app.close(); });
function token(nativeHdr?: unknown) { return app.inject({ method: 'POST', url: '/api/livekit/token', headers: { authorization: 'Bearer test' }, payload: { channelId: 'channel', ...(nativeHdr ? { nativeHdr } : {}) } }); }

it('does not advertise or authorize native HDR when the server gate is off, while ordinary voice remains available', async () => {
  state.hdrEnabled = false;
  const status = await app.inject({ method: 'GET', url: '/api/livekit/status', headers: { authorization: 'Bearer test' } });
  expect(status.json().nativeHdrProtocol).toBeUndefined();
  expect((await token({ role: 'publish' })).statusCode).toBe(503);
  expect((await token()).statusCode).toBe(200);
});

it('does not revive a stopped helper when an earlier publication confirmation arrives during an SFU outage', async () => {
  const body = (await token({ role: 'publish' })).json();
  const identity = body.nativeHdr.identity; identities.push(identity);
  let resolve!: (participant: unknown) => void;
  state.participant = new Promise(done => { resolve = done; });
  const confirming = app.inject({ method: 'POST', url: '/api/livekit/hdr-publication', headers: { authorization: 'Bearer test' }, payload: { identity, trackSid: 'video' } }).then(result => result);
  await vi.waitFor(() => expect(state.fetched).toHaveBeenCalled());
  state.removed.mockRejectedValueOnce(new Error('SFU temporarily unavailable'));
  await stopNativeHdrSession('alice', identity);
  resolve({ tracks: [{ sid: 'video', name: 'backspace-screen-hdr-v1', type: TrackType.VIDEO, source: TrackSource.SCREEN_SHARE, muted: false, mimeType: 'video/h265' }] });
  expect((await confirming).statusCode).toBe(409);
  expect(hasNativeHdrPublication('alice', 'channel')).toBe(false);
  expect(state.broadcast).not.toHaveBeenCalled();
});

it('keeps ordinary voice tokens compatible and scopes the native helper to its owner and screen sources', async () => {
  const legacy = (await token()).json();
  expect(legacy.nativeHdr).toBeUndefined();
  const response = await token({ role: 'publish' });
  expect(response.statusCode).toBe(200);
  const body = response.json(); identities.push(body.nativeHdr.identity);
  const jwt = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
  expect(jwt.sub).toContain('__backspace_hdr_v1__alice:publish:');
  expect(JSON.parse(jwt.metadata)).toMatchObject({ ownerId: 'alice', role: 'publish' });
  expect(jwt.video).toMatchObject({ room: 'channel', canPublish: true, canSubscribe: false, canPublishData: false });
  expect(jwt.video.canPublishSources).toEqual(['screen_share', 'screen_share_audio']);
  expect(hasNativeHdrPublication('alice', 'channel')).toBe(false);
});
it('refuses native publishing outside the human voice session or without STREAM permission', async () => {
  state.inRoom = false; expect((await token({ role: 'publish' })).statusCode).toBe(403);
  state.inRoom = true; state.streamAllowed = false; expect((await token({ role: 'publish' })).statusCode).toBe(403);
  expect((await token({ role: 'receive', targetIdentity: 'alice:Alice' })).statusCode).toBe(400);
});
it('announces HDR only after the exact live HEVC publication is confirmed, and clears it on stop', async () => {
  const body = (await token({ role: 'publish' })).json(); const identity = body.nativeHdr.identity; identities.push(identity);
  const confirm = (trackSid: string | null) => app.inject({ method: 'POST', url: '/api/livekit/hdr-publication', headers: { authorization: 'Bearer test' }, payload: { identity, trackSid } });
  state.participant = { tracks: [{ sid: 'video', name: 'SDR', type: TrackType.VIDEO, source: TrackSource.SCREEN_SHARE, muted: false, mimeType: 'video/h265', codecs: [] }] };
  expect((await confirm('video')).statusCode).toBe(409);
  expect(state.broadcast).not.toHaveBeenCalled();
  state.participant.tracks[0].name = 'backspace-screen-hdr-v1';
  state.participant.tracks[0].mimeType = '';
  state.participant.tracks[0].codecs = [{ mimeType: 'video/h265' }];
  expect((await confirm('video')).statusCode).toBe(409);
  state.participant.tracks[0].mimeType = 'video/h265';
  expect((await token({ role: 'receive', targetIdentity: identity })).statusCode).toBe(409);
  state.participant.tracks.push({ sid: 'audio', name: 'backspace-screen-hdr-audio-v1', type: TrackType.AUDIO, source: TrackSource.SCREEN_SHARE_AUDIO, muted: false });
  expect((await confirm('video')).statusCode).toBe(200);
  expect(hasNativeHdrPublication('alice', 'channel')).toBe(true);
  expect(state.broadcast).toHaveBeenLastCalledWith('channel', expect.objectContaining({ userId: 'alice', isScreenSharing: true, dynamicRange: 'hdr' }));
  const viewer = await token({ role: 'receive', targetIdentity: identity });
  expect(viewer.statusCode).toBe(200);
  identities.push(viewer.json().nativeHdr.identity);
  expect(viewer.json().nativeHdr.hasAudio).toBe(true);
  expect((await confirm(null)).statusCode).toBe(200);
  expect(hasNativeHdrPublication('alice', 'channel')).toBe(false);
  expect(state.broadcast).toHaveBeenLastCalledWith('channel', expect.objectContaining({ isScreenSharing: false }));
  expect((await confirm('video')).statusCode).toBe(409);
});
