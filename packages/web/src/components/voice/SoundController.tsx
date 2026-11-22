import { useEffect, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore, isDmChannel, getChannelOrigin, getMyUserIdForOrigin } from '../../stores/spaceStore';
import { AudioManager } from '../../audio/AudioManager';
import { shouldPlayMessageSound } from '../../utils/notificationFilters';
import { selectVoiceStateSound } from '../../utils/voiceSoundTransitions';
import { getJoinSoundPreset, getJoinSoundVolume, getSfxVolume } from '../../utils/sfx';
import { useChannelNotificationStore } from '../../stores/channelNotificationStore';
import type { JoinCueDirection } from '../../audio/joinCues';
import type { ParticipantInfo } from '../../hooks/useLiveKit';

/**
 * Grace period after the local user connects before roster changes are treated
 * as real.
 *
 * `useLiveKit` flips `isLiveKitConnected` and only then calls
 * `updateParticipants()`, so the connect tick always observes an empty or stale
 * participant list and the roster arrives in the immediately following store
 * notification. Without a settle window that second tick reports every
 * pre-existing member as a fresh arrival — the "double join sound" bug. The
 * window is wall-clock rather than tick-counted so a slow hydration path still
 * gets absorbed, and it is short enough that a genuine arrival right after
 * joining is the only deliberate casualty.
 */
const PARTICIPANT_BASELINE_SETTLE_MS = 1500;

/**
 * A second cue for the same participant and direction inside this window is
 * treated as the same event. Guards reconnect replays and the identity churn
 * that federated calls produce when `userId` resolves from one alias to another
 * (that case collapses to one identity via {@link ParticipantCueGate.selfIds},
 * but a remote peer can flap too).
 */
const PARTICIPANT_CUE_DEDUPE_MS = 1500;

/**
 * Delay before the local "you left the channel" cue plays.
 *
 * Switching channels leaves one LiveKit room and joins the next, so the self
 * disconnect cue fired on every switch and overlapped the join chime — the local
 * user hears two cues for one action they initiated. The cue is therefore held
 * briefly and dropped if a reconnect lands first; a real hang-up still plays it
 * once the grace window expires.
 */
const SELF_DISCONNECT_GRACE_MS = 1200;

/**
 * Mutable state for participant cue decisions. Kept outside React state on
 * purpose: every field is a transition baseline, not render output, and the
 * store subscriber must be able to update it synchronously.
 */
interface ParticipantCueGate {
  /**
   * Every id known to belong to the local user. Seeded from the auth store and
   * grown from `ParticipantInfo.isLocal`, which is authoritative even when a
   * federated call remaps `userId` to another local alias. Never shrinks: an id
   * learned as self must stay self so the departure tick cannot fire a leave
   * cue for it.
   */
  selfIds: Set<string>;
  /** `${direction}:${userId}` → timestamp of the last emitted cue. */
  recentCues: Map<string, number>;
  /** Wall-clock deadline until which roster diffs are baseline hydration. */
  baselineSettlesUntil: number;
}

function rememberSelfParticipants(
  gate: ParticipantCueGate,
  participants: readonly ParticipantInfo[],
): void {
  for (const participant of participants) {
    if (!participant.isLocal) continue;
    if (participant.userId) gate.selfIds.add(participant.userId);
    if (participant.homeUserId) gate.selfIds.add(participant.homeUserId);
  }
}

/**
 * Records a cue of `direction` for `userId` and reports whether it may play.
 * Expired entries are pruned on the way through so the map stays proportional
 * to the number of participants that changed inside one window.
 */
function shouldPlayParticipantCue(
  gate: ParticipantCueGate,
  direction: JoinCueDirection,
  userId: string,
  now: number,
): boolean {
  for (const [key, playedAt] of gate.recentCues) {
    if (now - playedAt >= PARTICIPANT_CUE_DEDUPE_MS) gate.recentCues.delete(key);
  }
  const key = `${direction}:${userId}`;
  const lastPlayed = gate.recentCues.get(key);
  if (lastPlayed !== undefined && now - lastPlayed < PARTICIPANT_CUE_DEDUPE_MS) return false;
  gate.recentCues.set(key, now);
  return true;
}

/**
 * Replicates the `useLiveKit` effective-mute formula on demand. Returns whether
 * the local user is currently muted/deafened by ANY mechanism (self toggle,
 * moderator space-mute, or permission-mute).
 */
function computeEffectiveSelfState(state: ReturnType<typeof useVoiceStore.getState>): {
  muted: boolean;
  deafened: boolean;
} {
  const cvId = state.currentVoiceChannelId;
  if (!cvId) return { muted: state.isMuted, deafened: state.isDeafened };
  const origin = getChannelOrigin(cvId);
  const myId = getMyUserIdForOrigin(origin);
  const spaceId = useSpaceStore.getState().channelToSpaceMap.get(cvId);
  const key = spaceId && myId ? `${spaceId}:${myId}` : '';
  const muted =
    state.isMuted ||
    state.spaceMutedUserIds.has(key) ||
    state.permissionMutedUserIds.has(key);
  const deafened = state.isDeafened || state.spaceDeafenedUserIds.has(key);
  return { muted, deafened };
}

export function SoundController() {
  const audioManager = AudioManager.getInstance();
  const currentUser = useAuthStore((s) => s.user);
  // Federation-aware self-check: in federated calls, the participant userId
  // can flip between localSnowflake (when activeDmCall resolves identity) and
  // homeUserId (when activeDmCall is cleared during disconnect). We must
  // recognize BOTH as "self" to prevent phantom join/leave sounds, and the gate
  // below also learns every id LiveKit flagged as local.
  const myIds = new Set<string>();
  if (currentUser?.id) myIds.add(currentUser.id);
  if (currentUser?.homeUserId) myIds.add(currentUser.homeUserId);

  // Participant cue bookkeeping lives outside React state: it is a transition
  // baseline, not render output.
  const cueGate = useRef<ParticipantCueGate>({
    selfIds: new Set(myIds),
    recentCues: new Map<string, number>(),
    baselineSettlesUntil: 0,
  });
  const isSelf = (id: string) => cueGate.current.selfIds.has(id);

  const isInitialMount = useRef(true);
  const initialState = useVoiceStore.getState();
  const initialEff = computeEffectiveSelfState(initialState);

  // All previous-sample state lives in one ref so the subscriber callback updates atomically.
  const prev = useRef({
    effectiveMuted: initialEff.muted,
    effectiveDeafened: initialEff.deafened,
    isCameraOn: initialState.isCameraOn,
    isLiveKitConnected: initialState.isLiveKitConnected,
    participantIds: new Set(initialState.participants.map((p) => p.userId)),
    screenShareUserIds: new Set(
      initialState.participants.filter((p) => p.isScreenSharing).map((p) => p.userId),
    ),
    selfWatchers: new Set<string>(),
  });

  const incomingCallLoop = useRef<AudioBufferSourceNode | null>(null);
  /** Pending self disconnect cue; cancelled when a channel switch reconnects. */
  const selfDisconnectCue = useRef<ReturnType<typeof setTimeout> | null>(null);
  const incomingCallLoading = useRef(false);
  const outgoingCallLoop = useRef<AudioBufferSourceNode | null>(null);
  const outgoingCallLoading = useRef(false);

  useEffect(() => {
    // The effect re-runs when the signed-in identity changes; keep every alias
    // learned so far and add the current ones.
    myIds.forEach((id) => cueGate.current.selfIds.add(id));

    const timer = setTimeout(() => {
      isInitialMount.current = false;
    }, 1000);

    const unsubscribeVoice = useVoiceStore.subscribe((state) => {
      if (isInitialMount.current) return;

      const sfxOpts = { volume: getSfxVolume() };
      // The join cue has its own preset and volume so it can be made quieter
      // (or silenced) without touching every other interface sound.
      const joinOpts = { volume: getJoinSoundVolume() };
      const joinPreset = getJoinSoundPreset();
      const now = Date.now();
      // Learn every alias of the local user before any diff runs: the departure
      // tick no longer contains the local participant, so a self id discovered
      // here is the only way to stay silent for it.
      rememberSelfParticipants(cueGate.current, state.participants);

      // -------- Effective mute / deafen --------
      // Only play on transitions where BOTH prev and current samples were taken
      // while LK-connected. On the connect/disconnect boundary we snapshot the
      // current effective state without firing.
      const eff = computeEffectiveSelfState(state);
      if (state.isLiveKitConnected && prev.current.isLiveKitConnected) {
        // Deafen toggles mute as an atomic side effect (see
        // selectVoiceStateSound) — pick the single correct cue so deafening
        // doesn't play the mute sound on top of the deafen sound.
        const sound = selectVoiceStateSound(
          { muted: prev.current.effectiveMuted, deafened: prev.current.effectiveDeafened },
          { muted: eff.muted, deafened: eff.deafened },
        );
        if (sound) audioManager.playSound(sound, sfxOpts);
      }
      prev.current.effectiveMuted = eff.muted;
      prev.current.effectiveDeafened = eff.deafened;

      // -------- Camera Toggle (self) --------
      if (state.isCameraOn !== prev.current.isCameraOn) {
        audioManager.playSound(state.isCameraOn ? 'camera_on' : 'camera_off', sfxOpts);
        prev.current.isCameraOn = state.isCameraOn;
      }

      // -------- Self connect / disconnect --------
      const justDisconnected = prev.current.isLiveKitConnected && !state.isLiveKitConnected;
      const justConnected = !prev.current.isLiveKitConnected && state.isLiveKitConnected;

      if (justDisconnected) {
        // Leaving a channel (or switching to another one) is part of the same
        // "you moved between channels" cue as the join chime, so it follows the
        // dedicated join-sound volume instead of the general SFX slider. The
        // cue is deferred: a channel switch reconnects within the grace window
        // and cancels it, so only a real hang-up is audible.
        if (selfDisconnectCue.current !== null) clearTimeout(selfDisconnectCue.current);
        selfDisconnectCue.current = setTimeout(() => {
          selfDisconnectCue.current = null;
          void audioManager.playSound('disconnect', joinOpts);
        }, SELF_DISCONNECT_GRACE_MS);
      }
      if (justConnected) {
        // Reconnecting inside the grace window means the user switched
        // channels, not left the call: drop the pending leave cue.
        if (selfDisconnectCue.current !== null) {
          clearTimeout(selfDisconnectCue.current);
          selfDisconnectCue.current = null;
        }
        void audioManager.playJoinSound('join', joinPreset, joinOpts);
        // Treat the roster that LiveKit publishes right after this tick as the
        // baseline instead of a batch of arrivals.
        cueGate.current.baselineSettlesUntil = now + PARTICIPANT_BASELINE_SETTLE_MS;
      }
      prev.current.isLiveKitConnected = state.isLiveKitConnected;

      // -------- Participant set diff --------
      const currentParticipantIds = new Set(state.participants.map((p) => p.userId));
      const currentScreenShareUserIds = new Set(
        state.participants.filter((p) => p.isScreenSharing).map((p) => p.userId),
      );

      const myStreamerId = currentUser?.id;
      const selfIsSharing = myStreamerId ? currentScreenShareUserIds.has(myStreamerId) : false;
      const selfStreamJustStarted =
        !!myStreamerId &&
        currentScreenShareUserIds.has(myStreamerId) &&
        !prev.current.screenShareUserIds.has(myStreamerId);
      const selfStreamJustEnded =
        !!myStreamerId &&
        !currentScreenShareUserIds.has(myStreamerId) &&
        prev.current.screenShareUserIds.has(myStreamerId);

      // Suppress join/leave + stream sounds on the connect tick and for the
      // baseline settle window that follows it. `useLiveKit` marks itself
      // connected before it publishes the roster, so the first populated
      // participant list is hydration, not a wave of arrivals: snapshot it as
      // the new baseline and let sounds come from real future transitions.
      const baselineSettling = now < cueGate.current.baselineSettlesUntil;
      if (
        state.isLiveKitConnected &&
        !justDisconnected &&
        !justConnected &&
        !baselineSettling
      ) {
        // user_join (others)
        state.participants.forEach((p) => {
          if (p.isLocal || isSelf(p.userId)) return;
          if (prev.current.participantIds.has(p.userId)) return;
          if (!shouldPlayParticipantCue(cueGate.current, 'join', p.userId, now)) return;
          void audioManager.playJoinSound('join', joinPreset, joinOpts);
        });
        // user_leave (others) — the same preset's leave direction, never the
        // bundled sample directly, so every preset distinguishes the two.
        prev.current.participantIds.forEach((userId) => {
          if (currentParticipantIds.has(userId)) return;
          if (isSelf(userId)) return;
          if (!shouldPlayParticipantCue(cueGate.current, 'leave', userId, now)) return;
          void audioManager.playJoinSound('leave', joinPreset, joinOpts);
        });
        // stream_started — ANY participant (incl. self), audible to all
        state.participants.forEach((p) => {
          if (p.isScreenSharing && !prev.current.screenShareUserIds.has(p.userId)) {
            audioManager.playSound('stream_started', sfxOpts);
          }
        });
        // stream_ended — ANY participant, audible to all
        prev.current.screenShareUserIds.forEach((userId) => {
          if (!currentScreenShareUserIds.has(userId)) {
            audioManager.playSound('stream_ended', sfxOpts);
          }
        });
      }

      prev.current.participantIds = currentParticipantIds;
      prev.current.screenShareUserIds = currentScreenShareUserIds;

      // -------- Viewer tracking — streamer-side only (§3.2) --------
      // The full diff is gated on `selfIsSharing`. When self isn't sharing,
      // both prev and current are forced to ∅ — no sounds fire even if a late
      // ping mutates the store. On both stream-start and stream-end transitions
      // for self, eagerly call clearStreamWatchers; the gate makes the
      // re-entered subscriber tick silent. This eliminates the race where a
      // late "Stop Watching" ping arriving between a deferred clear's schedule
      // and execution would fire phantom stream_user_joined / left.
      if (myStreamerId && (selfStreamJustStarted || selfStreamJustEnded)) {
        useVoiceStore.getState().clearStreamWatchers(myStreamerId);
      }

      if (myStreamerId && state.isLiveKitConnected && !justDisconnected && selfIsSharing) {
        const live = new Set(state.streamWatchers.get(myStreamerId) ?? []);
        const past = prev.current.selfWatchers;

        live.forEach((identity) => {
          if (!past.has(identity)) audioManager.playSound('stream_user_joined', sfxOpts);
        });
        past.forEach((identity) => {
          if (!live.has(identity)) audioManager.playSound('stream_user_left', sfxOpts);
        });
        prev.current.selfWatchers = live;
      } else {
        prev.current.selfWatchers = new Set();
      }

      // -------- Incoming Call (Ringing) --------
      if (state.incomingCall && !incomingCallLoop.current && !incomingCallLoading.current) {
        incomingCallLoading.current = true;
        audioManager
          .playSound('call_ringing', { loop: true, volume: getSfxVolume() })
          .then((source) => {
            if (!useVoiceStore.getState().incomingCall) {
              source?.stop();
            } else {
              incomingCallLoop.current = source;
            }
            incomingCallLoading.current = false;
          });
      } else if (!state.incomingCall) {
        if (incomingCallLoop.current) {
          incomingCallLoop.current.stop();
          incomingCallLoop.current = null;
        }
        incomingCallLoading.current = false;
      }

      // -------- Outgoing Call (Calling) --------
      if (state.outgoingCall && !outgoingCallLoop.current && !outgoingCallLoading.current) {
        outgoingCallLoading.current = true;
        audioManager
          .playSound('call_calling', { loop: true, volume: getSfxVolume() })
          .then((source) => {
            if (!useVoiceStore.getState().outgoingCall) {
              source?.stop();
            } else {
              outgoingCallLoop.current = source;
            }
            outgoingCallLoading.current = false;
          });
      } else if (!state.outgoingCall) {
        if (outgoingCallLoop.current) {
          outgoingCallLoop.current.stop();
          outgoingCallLoop.current = null;
        }
        outgoingCallLoading.current = false;
      }
    });

    // -------- Chat: message sound (DM + mention default, federation-aware) --------
    const unsubscribeChat = useChatStore.subscribe((state, prevState) => {
      if (isInitialMount.current) return;

      if (state.realtimeMessageEvents.length > prevState.realtimeMessageEvents.length) {
        const newEvents = state.realtimeMessageEvents.slice(prevState.realtimeMessageEvents.length);
        const allChannels = useVoiceStore.getState().messageSoundAllChannels;
        // Use the wrapper-level channelId from RealtimeMessageEvent — set by
        // addRealtimeMessage(channelId, message). It's authoritative for both
        // space and DM messages. Avoids reaching into the heterogeneous Message
        // shape (where DM messages may carry dmChannelId at runtime).
        for (const { channelId, message } of newEvents) {
          if (!channelId) continue;
          if (useChannelNotificationStore.getState().isMuted(channelId)) continue;
          const isDm = isDmChannel(channelId);
          if (
            shouldPlayMessageSound({
              authorUserId: message.userId,
              myIds,
              isDmChannel: isDm,
              content: message.content,
              allChannels,
            })
          ) {
            audioManager.playSound('message', { volume: getSfxVolume() });
            break;
          }
        }
      }
    });

    return () => {
      clearTimeout(timer);
      if (selfDisconnectCue.current !== null) {
        clearTimeout(selfDisconnectCue.current);
        selfDisconnectCue.current = null;
      }
      unsubscribeVoice();
      unsubscribeChat();
      if (incomingCallLoop.current) incomingCallLoop.current.stop();
      if (outgoingCallLoop.current) outgoingCallLoop.current.stop();
    };
  }, [currentUser?.id, currentUser?.homeUserId]);

  return null;
}
