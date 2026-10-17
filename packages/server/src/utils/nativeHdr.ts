import { randomUUID } from 'node:crypto';
import { RoomServiceClient, TrackSource, TrackType } from 'livekit-server-sdk';
import { config } from '../config.js';
import { getChannelSpaceId, hasPermission, isDmMember, PermissionBits } from './permissions.js';

export const HDR_IDENTITY_PREFIX = '__backspace_hdr_v1__';
export const HDR_TRACK_NAME = 'backspace-screen-hdr-v1';

export function nativeHdrIdentity(userId: string, role: 'publish' | 'receive'): string {
  return `${HDR_IDENTITY_PREFIX}${userId}:${role}:${randomUUID()}`;
}

export function nativeHdrOwner(identity: unknown): string | null {
  if (typeof identity !== 'string' || !identity.startsWith(HDR_IDENTITY_PREFIX)) return null;
  const match = identity.slice(HDR_IDENTITY_PREFIX.length).match(/^([^:]{1,128}):publish:[0-9a-f-]{36}$/);
  return match?.[1] ?? null;
}

interface NativeSession {
  userId: string; roomId: string; livekitRoom: string; identity: string;
  role: 'publish' | 'receive'; issuedAt: number; joined: boolean; trackSid?: string; hasAudio?: boolean; revoked?: boolean;
}
const sessions = new Map<string, NativeSession>();
let lastOrphanSweep = 0;

export function registerNativeHdrSession(session: Omit<NativeSession, 'issuedAt' | 'joined'>): void {
  if (sessions.size >= 1024) throw new Error('Too many native HDR sessions');
  sessions.set(session.identity, { ...session, issuedAt: Date.now(), joined: false });
}
export function hasNativeHdrPublication(userId: string, roomId: string): boolean {
  return [...sessions.values()].some(s => s.userId === userId && s.roomId === roomId && s.role === 'publish' && !!s.trackSid);
}
export function getNativeHdrPublication(identity: string, roomId: string): { hasAudio: boolean } | null {
  const session = sessions.get(identity);
  return session?.roomId === roomId && session.role === 'publish' && session.trackSid ? { hasAudio: session.hasAudio === true } : null;
}
function roomService(): RoomServiceClient {
  return new RoomServiceClient((config.livekit.url ?? '').replace(/^ws/, 'http'), config.livekit.apiKey, config.livekit.apiSecret);
}
function ownerAllowed(session: NativeSession, owner: { roomId: string; room: { roomType: string } } | null | undefined): boolean {
  if (owner?.roomId !== session.roomId) return false;
  if (owner.room.roomType === 'dm') return isDmMember(session.roomId, session.userId);
  const spaceId = getChannelSpaceId(session.roomId);
  return !!spaceId && hasPermission(session.userId, spaceId, PermissionBits.CONNECT, session.roomId) &&
    (session.role !== 'publish' || hasPermission(session.userId, spaceId, PermissionBits.STREAM, session.roomId));
}
async function announce(session: NativeSession, sharing: boolean): Promise<void> {
  const { connectionManager } = await import('../ws/handler.js');
  if (connectionManager.getUserRoom(session.userId)?.roomId !== session.roomId) return;
  const status = connectionManager.getVoiceUserStatus(session.userId);
  if (!status) return;
  connectionManager.setVoiceUserStatus(session.userId, status.isMuted, status.isDeafened, status.isCameraOn, sharing, sharing ? 'hdr' : 'sdr');
  connectionManager.sendToRoom(session.roomId, { type: 'voice_status_update', userId: session.userId, channelId: session.roomId,
    isMuted: status.isMuted, isDeafened: status.isDeafened, isCameraOn: status.isCameraOn, isScreenSharing: sharing,
    ...(sharing ? { dynamicRange: 'hdr' as const } : {}) });
}

export async function confirmNativeHdrPublication(userId: string, identity: string, trackSid: string): Promise<boolean> {
  const session = sessions.get(identity);
  if (!session || session.revoked || session.userId !== userId || session.role !== 'publish') return false;
  const { connectionManager } = await import('../ws/handler.js');
  if (!ownerAllowed(session, connectionManager.getUserRoom(userId))) return false;
  const participant = await roomService().getParticipant(session.livekitRoom, identity);
  const video = participant.tracks.filter(track => track.type === TrackType.VIDEO);
  if (video.length !== 1 || video[0]!.sid !== trackSid || video[0]!.name !== HDR_TRACK_NAME ||
      video[0]!.source !== TrackSource.SCREEN_SHARE || video[0]!.muted ||
      video[0]!.mimeType.toLowerCase() !== 'video/h265') return false;
  // Recheck after the network round trip; an old start cannot reactivate a
  // stream after its owner left or explicitly stopped it.
  if (sessions.get(identity) !== session || session.revoked || !ownerAllowed(session, connectionManager.getUserRoom(userId))) return false;
  session.trackSid = trackSid;
  session.hasAudio = participant.tracks.some(track => track.type === TrackType.AUDIO && track.source === TrackSource.SCREEN_SHARE_AUDIO && track.name === 'backspace-screen-hdr-audio-v1' && !track.muted);
  session.joined = true;
  await announce(session, true);
  return true;
}

export async function stopNativeHdrSession(userId: string, identity: string): Promise<void> {
  const session = sessions.get(identity);
  if (!session || session.userId !== userId) return;
  const wasLive = !!session.trackSid;
  session.trackSid = undefined; session.revoked = true;
  if (wasLive && !hasNativeHdrPublication(userId, session.roomId)) await announce(session, false);
  try { await roomService().removeParticipant(session.livekitRoom, identity); sessions.delete(identity); }
  catch (error) {
    // Keep failed revocations queued: a temporary SFU outage must not leave
    // an untracked publisher sending after its human left or lost permission.
    if ((error as { code?: string })?.code === 'not_found') sessions.delete(identity);
  }
}

/** Reap crashed helpers and helpers whose human owner left the channel. */
export async function reconcileNativeHdrSessions(): Promise<void> {
  const { connectionManager } = await import('../ws/handler.js');
  for (const session of [...sessions.values()]) {
    const owner = connectionManager.getUserRoom(session.userId);
    if (session.revoked || !ownerAllowed(session, owner)) {
      await stopNativeHdrSession(session.userId, session.identity); continue;
    }
    try {
      const participant = await roomService().getParticipant(session.livekitRoom, session.identity);
      session.joined = true;
      if (session.trackSid && !participant.tracks.some(track => track.sid === session.trackSid && !track.muted)) {
        await stopNativeHdrSession(session.userId, session.identity);
      }
    } catch {
      if (session.joined || Date.now() - session.issuedAt > 30000) await stopNativeHdrSession(session.userId, session.identity);
    }
  }
  // After an application-server restart its in-memory leases are gone, but
  // the SFU can still have connected native processes. Disconnect those
  // reserved helpers so their owners restart with fresh, provable state.
  if (config.livekit.nativeHdrEnabled && Date.now() - lastOrphanSweep > 30000) {
    lastOrphanSweep = Date.now();
    const service = roomService();
    for (const room of await service.listRooms()) {
      for (const participant of await service.listParticipants(room.name)) {
        if (participant.identity.startsWith(HDR_IDENTITY_PREFIX) && !sessions.has(participant.identity)) {
          await service.removeParticipant(room.name, participant.identity);
        }
      }
    }
  }
}
