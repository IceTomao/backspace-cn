/**
 * Voice-session reconciliation helpers.
 *
 * The server keeps a voice room membership alive for a reconnect grace window
 * after the owning WebSocket closes, so a network handover does not produce a
 * visible leave/join cycle. That same window is what makes a freshly started
 * client — quit, crashed or reloaded while in a call — still appear to sit in
 * the channel on every client until the grace expires.
 *
 * These helpers detect that state on the `ready` snapshot; the caller then asks
 * the server to confirm with `voice_session_probe` instead of trusting what the
 * snapshot says.
 */

/** Minimal slice of the voice store needed to decide whether we own a session. */
export interface LocalVoiceSessionSnapshot {
  currentVoiceChannelId: string | null;
  activeDmCallChannelId: string | null;
  isLiveKitConnected: boolean;
}

/** Reply shape of `voice_session_state`. */
export interface VoiceSessionState {
  inVoice: boolean;
  channelId: string | null;
}

/**
 * First channel in a `ready`/`space_voice_state` snapshot that lists `userId`.
 *
 * Channel IDs are globally unique, so the first match is also the only one.
 */
export function findVoiceChannelForUser(
  voiceStates: Record<string, string[]> | undefined,
  userId: string,
): string | null {
  if (!voiceStates) return null;
  for (const [channelId, userIds] of Object.entries(voiceStates)) {
    if (Array.isArray(userIds) && userIds.includes(userId)) return channelId;
  }
  return null;
}

/**
 * True when this client owns no voice session at all: no channel, no DM call
 * and no LiveKit connection. Only such a client is entitled to claim a
 * remaining membership as stale.
 */
export function isLocalVoiceSessionIdle(session: LocalVoiceSessionSnapshot): boolean {
  return session.currentVoiceChannelId === null
    && session.activeDmCallChannelId === null
    && !session.isLiveKitConnected;
}

/**
 * Whether the `ready` snapshot should trigger a `voice_session_probe`.
 *
 * The snapshot's membership is only acted upon when this client has nothing to
 * resume, so an active session never races its own registration on reconnect.
 */
export function shouldProbeVoiceSession(
  voiceStates: Record<string, string[]> | undefined,
  userId: string,
  session: LocalVoiceSessionSnapshot,
): boolean {
  if (!isLocalVoiceSessionIdle(session)) return false;
  return findVoiceChannelForUser(voiceStates, userId) !== null;
}

/**
 * Whether a `voice_session_state` reply should also be mirrored into the local
 * store. The server raised the leave broadcast for every other client; this
 * client applies it directly so the sidebar cannot paint the ghost in the
 * window between the reply and that broadcast.
 */
export function shouldMirrorStaleLeave(state: VoiceSessionState, myUserId: string | null): boolean {
  return !state.inVoice && state.channelId !== null && myUserId !== null;
}

/**
 * Whether the page should tell the server it is leaving voice while unloading.
 *
 * Closing the window is an explicit end of the session, so it must not wait for
 * the reconnect grace: other clients would keep rendering the participant for
 * up to a minute. Hiding to the tray does not unload the page, so a minimized
 * window keeps its call.
 */
export function shouldLeaveVoiceOnUnload(session: LocalVoiceSessionSnapshot): boolean {
  return session.currentVoiceChannelId !== null
    || session.activeDmCallChannelId !== null
    || session.isLiveKitConnected;
}
