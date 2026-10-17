import type { FastifyInstance } from 'fastify';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { config } from '../config.js';
import { getChannelSpaceId, hasPermission, computePermissions, isDmMember, PermissionBits } from '../utils/permissions.js';
import type { LiveKitTokenRequest, LiveKitTokenResponse, NativeHdrTokenOptions } from '@backspace/shared';
import { nativeHdrIdentity, nativeHdrOwner, registerNativeHdrSession, confirmNativeHdrPublication, stopNativeHdrSession, reconcileNativeHdrSessions, getNativeHdrPublication } from '../utils/nativeHdr.js';
import { getDb, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { readVoiceServiceState } from '../utils/voiceRecovery.js';

/**
 * Generate a LiveKit token for a federated call participant.
 * Uses homeUserId as identity (stable across instances).
 * Short TTL (5 min) — must join quickly.
 */
export async function generateFederatedCallToken(
  roomName: string,
  homeUserId: string,
  displayName: string,
): Promise<string> {
  const token = new AccessToken(config.livekit.apiKey!, config.livekit.apiSecret!, {
    identity: `${homeUserId}:${displayName}`,
    ttl: '5m',
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [
      TrackSource.MICROPHONE,
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    ],
    canSubscribe: true,
    canPublishData: true,
  });

  return token.toJwt();
}

export async function livekitRoutes(app: FastifyInstance): Promise<void> {
  let reconciling = false;
  const hdrTimer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void reconcileNativeHdrSessions().catch(error => app.log.warn({ err: error }, 'HDR session reconciliation failed'))
      .finally(() => { reconciling = false; });
  }, 2000);
  hdrTimer.unref();
  app.addHook('onClose', async () => { clearInterval(hdrTimer); });
  app.post<{ Body: { identity?: string; trackSid?: string | null } }>('/api/livekit/hdr-publication', { preHandler: authenticate }, async (request, reply) => {
    const { identity, trackSid } = request.body ?? {};
    if (typeof identity !== 'string' || !identity.startsWith('__backspace_hdr_v1__') || identity.length > 256 ||
        (trackSid !== null && (typeof trackSid !== 'string' || trackSid.length > 128))) return sendError(reply, 400, 'validation_failed');
    if (trackSid === null) { await stopNativeHdrSession(request.userId, identity); return { ok: true }; }
    try {
      if (!await confirmNativeHdrPublication(request.userId, identity, trackSid)) return sendError(reply, 409, 'forbidden');
      return { ok: true };
    } catch { return sendError(reply, 503, 'voice_disabled'); }
  });
  app.get('/api/livekit/status', { preHandler: authenticate }, async (_request, reply) => {
    return reply.header('Cache-Control', 'no-store').send({ state: readVoiceServiceState(),
      ...(config.livekit.nativeHdrEnabled && config.livekit.apiKey && config.livekit.apiSecret ? { nativeHdrProtocol: 1 } : {}) });
  });
  if (config.livekit.recoveryStatePath) {
    const { connectionManager } = await import('../ws/handler.js');
    let previous = JSON.stringify(readVoiceServiceState());
    const timer = setInterval(() => {
      const state = readVoiceServiceState();
      const serialized = JSON.stringify(state);
      if (previous === serialized) return;
      previous = serialized;
      connectionManager.sendToAll({ type: 'voice_service_state', state });
    }, 2000);
    timer.unref();
    app.addHook('onClose', async () => { clearInterval(timer); });
  }
  app.post<{ Body: LiveKitTokenRequest & { dmChannelId?: string; nativeHdr?: NativeHdrTokenOptions } }>('/api/livekit/token', {
    preHandler: authenticate,
  }, async (request, reply) => {
    if (!config.livekit.apiKey || !config.livekit.apiSecret) {
      return sendError(reply, 503, 'voice_disabled');
    }

    const { channelId, dmChannelId } = request.body as { channelId?: string; dmChannelId?: string };

    // Determine room name based on channel type
    let roomName: string;

    // Default: full publish (DM calls always get full permissions)
    let canSpeak = true;
    let canStream = true;

    if (dmChannelId && typeof dmChannelId === 'string') {
      // DM call token
      if (!isDmMember(dmChannelId, request.userId)) {
        return sendError(reply, 403, 'not_dm_member');
      }

      // Federated DMs use federatedId as room name (cross-instance stable).
      // Local-only DMs use dm-{dmChannelId}.
      const db = getDb();
      const channel = db.select({ federatedId: schema.dmChannels.federatedId })
        .from(schema.dmChannels)
        .where(eq(schema.dmChannels.id, dmChannelId))
        .get();

      roomName = channel?.federatedId ? channel.federatedId : `dm-${dmChannelId}`;
    } else if (channelId && typeof channelId === 'string') {
      // Space voice channel token
      const spaceId = getChannelSpaceId(channelId);
      if (!spaceId) {
        return sendError(reply, 404, 'channel_not_found');
      }
      if (!hasPermission(request.userId, spaceId, PermissionBits.CONNECT, channelId)) {
        return sendError(reply, 403, 'voice_connect_forbidden');
      }
      // Check SPEAK and STREAM permissions for granular token grants
      const perms = computePermissions(request.userId, spaceId, channelId);
      canSpeak = (perms & PermissionBits.SPEAK) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
      canStream = (perms & PermissionBits.STREAM) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
      roomName = channelId;
    } else {
      return sendError(reply, 400, 'validation_failed');
    }

    const native = request.body.nativeHdr;
    let hdrAudio = false;
    if (native !== undefined) {
      if (!config.livekit.nativeHdrEnabled) return sendError(reply, 503, 'voice_disabled');
      if (!native || !['publish', 'receive'].includes(native.role) ||
          (native.role === 'receive' && !nativeHdrOwner(native.targetIdentity))) {
        return sendError(reply, 400, 'validation_failed');
      }
      const { connectionManager } = await import('../ws/handler.js');
      const current = connectionManager.getUserRoom(request.userId);
      // A helper belongs to an existing voice session. Joining it never creates
      // a second voice member and cannot bypass channel or STREAM permissions.
      if (!current || current.roomId !== (channelId ?? dmChannelId)) {
        return sendError(reply, 403, 'voice_connect_forbidden');
      }
      if (native.role === 'publish' && !canStream) return sendError(reply, 403, 'forbidden');
      if (native.role === 'receive') {
        const owner = connectionManager.getUserRoom(nativeHdrOwner(native.targetIdentity)!);
        if (!owner || owner.roomId !== current.roomId) return sendError(reply, 403, 'voice_connect_forbidden');
        const publication = getNativeHdrPublication(native.targetIdentity!, current.roomId);
        if (!publication) return sendError(reply, 409, 'forbidden');
        hdrAudio = publication.hasAudio;
      }
    }
    const identity = native ? nativeHdrIdentity(request.userId, native.role) : `${request.userId}:${request.username}`;

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity,
      ttl: native ? '5m' : '1h',
      ...(native ? { metadata: JSON.stringify({ kind: 'backspace-native-hdr', protocol: 1, ownerId: request.userId, role: native.role }) } : {}),
    });

    // Build canPublishSources based on permissions
    const canPublishSources: TrackSource[] = [];
    if (canSpeak) {
      canPublishSources.push(TrackSource.MICROPHONE);
      canPublishSources.push(TrackSource.CAMERA);
    }
    if (canStream) {
      canPublishSources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
    }

    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: native ? native.role === 'publish' : canSpeak || canStream,
      canPublishSources: native ? (native.role === 'publish' ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []) : canPublishSources,
      canSubscribe: native ? native.role === 'receive' : true,
      canPublishData: !native,
    });

    const jwt = await token.toJwt();
    if (native) registerNativeHdrSession({ identity, userId: request.userId, roomId: channelId ?? dmChannelId!, livekitRoom: roomName, role: native.role });

    const livekitUrl = config.livekit.url ?? '';

    const response: LiveKitTokenResponse = {
      token: jwt,
      url: livekitUrl,
      ...(native ? { nativeHdr: { protocol: 1 as const, identity, ownerId: request.userId, role: native.role, ...(native.role === 'receive' ? { hasAudio: hdrAudio } : {}) } } : {}),
    };
    return reply.code(200).send(response);
  });
}
