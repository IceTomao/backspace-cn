import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useFormatters } from '../../i18n/formatters';
import type { ContextMenuItem } from '../../stores/contextMenuStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getChannelOrigin } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { isAndroid } from '../../platform/android';
import {
  DEFAULT_PARTICIPANT_EQ,
  EQ_BANDS,
  EQ_GAIN_MAX,
  EQ_GAIN_MIN,
  type EqBandId,
  type EqPresetId,
} from '../../audio/participantEq';

/**
 * Build moderation context menu items for a voice user.
 * Called imperatively at right-click time (not during render).
 */
export function buildVoiceModMenuItems(targetUserId: string, channelId: string): ContextMenuItem[] {
  const { spacePermissions, channels, channelToSpaceMap } = useSpaceStore.getState();
  const { spaceMutedUserIds, spaceDeafenedUserIds } = useVoiceStore.getState();

  // Derive spaceId from the voice channel, NOT from UI navigation state.
  // On mobile, the user can navigate away from the space while still in voice.
  const derivedSpaceId = channelToSpaceMap.get(channelId);
  const myPerms = derivedSpaceId ? spacePermissions.get(derivedSpaceId) : undefined;
  const canMuteMembers = hasPermissionBit(myPerms, PermissionBits.MUTE_MEMBERS);
  const canDeafenMembers = hasPermissionBit(myPerms, PermissionBits.DEAFEN_MEMBERS);
  const canMoveMembers = hasPermissionBit(myPerms, PermissionBits.MOVE_MEMBERS);
  const canDisconnectMembers = hasPermissionBit(myPerms, PermissionBits.DISCONNECT_MEMBERS);

  if (!canMuteMembers && !canDeafenMembers && !canMoveMembers && !canDisconnectMembers) return [];

  const voiceOrigin = getChannelOrigin(channelId);
  const spaceId = derivedSpaceId;
  const isSpaceMuted = spaceMutedUserIds.has(`${spaceId}:${targetUserId}`);
  const isSpaceDeafened = spaceDeafenedUserIds.has(`${spaceId}:${targetUserId}`);
  const otherVoiceChannels = channels.filter(c => c.type === 'voice' && c.id !== channelId);

  const items: ContextMenuItem[] = [];

  if (canMuteMembers) {
    items.push({
      key: 'space-mute',
      type: 'action',
      label: isSpaceMuted ? i18n.t('voice:moderation.spaceUnmute') : i18n.t('voice:moderation.spaceMute'),
      icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
        React.createElement('path', { d: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z' }),
        React.createElement('path', { d: 'M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z' }),
        ...(isSpaceMuted
          ? [React.createElement('line', { key: 'slash', x1: 3, y1: 3, x2: 21, y2: 21, stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' })]
          : []),
      ),
      onClick: () => wsSend({ type: 'voice_space_mute', userId: targetUserId, muted: !isSpaceMuted }, voiceOrigin),
    });
  }

  if (canDeafenMembers) {
    items.push({
      key: 'space-deafen',
      type: 'action',
      label: isSpaceDeafened ? i18n.t('voice:moderation.spaceUndeafen') : i18n.t('voice:moderation.spaceDeafen'),
      icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
        React.createElement('path', { d: 'M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z' }),
        ...(isSpaceDeafened
          ? [React.createElement('line', { key: 'slash', x1: 3, y1: 3, x2: 21, y2: 21, stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' })]
          : []),
      ),
      onClick: () => wsSend({ type: 'voice_space_deafen', userId: targetUserId, deafened: !isSpaceDeafened }, voiceOrigin),
    });
  }

  if (canDisconnectMembers) {
    items.push({ key: 'mod-sep', type: 'separator' });
    items.push({
      key: 'disconnect',
      type: 'action',
      label: i18n.t('voice:moderation.disconnect'),
      danger: true,
      icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
        React.createElement('path', { d: 'M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 010-1.36C3.36 8.68 7.42 7 12 7s8.64 1.68 11.71 4.72c.18.18.29.44.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z' }),
      ),
      onClick: () => wsSend({ type: 'voice_disconnect', userId: targetUserId }, voiceOrigin),
    });
  }

  if (canMoveMembers && otherVoiceChannels.length > 0) {
    items.push({ key: 'move-sep', type: 'separator' });
    items.push({
      key: 'move-to',
      type: 'submenu',
      label: i18n.t('voice:moderation.moveTo'),
      icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
        React.createElement('path', { d: 'M14 4l2.29 2.29-2.88 2.88 1.42 1.42 2.88-2.88L20 10V4h-6zM10 4H4v6l2.29-2.29 4.71 4.7V20h2v-8.41l-5.29-5.3L10 4z' }),
      ),
      children: otherVoiceChannels.map(ch => ({
        key: ch.id,
        type: 'action' as const,
        label: ch.name,
        icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0 text-txt-tertiary' },
          React.createElement('path', { d: 'M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z' }),
        ),
        onClick: () => wsSend({ type: 'voice_move', userId: targetUserId, targetChannelId: ch.id }, voiceOrigin),
      })),
    });
  }

  return items;
}

// ── Shared custom menu item components ────────────────────────────────────

/**
 * The volume and sound-shaping controls every participant menu offers, in the
 * order they appear. Shared so the voice grid, the channel member list and the
 * mobile member list cannot drift apart.
 */
export function buildParticipantAudioMenuItems(targetUserId: string): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      key: 'volume',
      type: 'custom',
      render: () => React.createElement(VolumeSliderItem, { userId: targetUserId }),
    },
  ];

  // The Android app plays remote audio through the native voice bridge, not
  // through Web Audio, so an equalizer here would be a slider that does
  // nothing. Android's own volume control still reaches the store above.
  if (!isAndroid()) {
    items.push({
      key: 'eq',
      type: 'custom',
      render: () => React.createElement(ParticipantEqItem, { userId: targetUserId }),
    });
  }

  return items;
}

/**
 * Volume slider for a voice participant, used as a `custom` context menu item.
 * Must be a component (not a plain function) because it subscribes to store state.
 */
export function VolumeSliderItem({ userId }: { userId: string }) {
  const { t } = useTranslation(['voice', 'common']);
  const f = useFormatters();
  const volume = useVoiceStore((s) => s.participantVolumes.get(userId) ?? 100);
  const setParticipantVolume = useVoiceStore((s) => s.setParticipantVolume);

  return (
    <div className="p-3">
      <div className="text-xs text-txt-tertiary mb-2 font-medium uppercase tracking-wider">
        {t('voice:participantMenu.userVolume')}
      </div>
      <div className="flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary flex-shrink-0">
          <path d="M3 9v6h4l5 5V4L7 9H3z" />
        </svg>
        <input
          type="range"
          min="0"
          max="200"
          value={volume}
          onChange={(e) => setParticipantVolume(userId, parseInt(e.target.value))}
          className="flex-1 min-w-0 accent-accent-primary h-1"
        />
        <span className="text-xs text-txt-secondary min-w-[32px] flex-shrink-0 text-right">
          {f.formatPercent(volume)}
        </span>
      </div>
    </div>
  );
}

const EQ_PRESET_ORDER: readonly EqPresetId[] = ['flat', 'bass', 'vocal', 'custom'];

const EQ_PRESET_LABEL_KEYS = {
  flat: 'voice:participantMenu.eq.presetFlat',
  bass: 'voice:participantMenu.eq.presetBass',
  vocal: 'voice:participantMenu.eq.presetVocal',
  custom: 'voice:participantMenu.eq.presetCustom',
} as const;

/**
 * Five-band equalizer for one voice participant, used as a `custom` context
 * menu item.
 *
 * Presets apply a fixed curve; touching a slider flips the participant to
 * `custom` while keeping the other bands where they were, so a user can start
 * from "vocal" and only lift the low end. The gains of the last preset stay
 * visible in the sliders, which is what makes that edit discoverable.
 */
export function ParticipantEqItem({ userId }: { userId: string }) {
  const { t } = useTranslation(['voice', 'common']);
  const f = useFormatters();
  const eq = useVoiceStore((s) => s.participantEqs.get(userId)) ?? DEFAULT_PARTICIPANT_EQ;
  const setParticipantEqPreset = useVoiceStore((s) => s.setParticipantEqPreset);
  const setParticipantEqBand = useVoiceStore((s) => s.setParticipantEqBand);
  const resetParticipantEq = useVoiceStore((s) => s.resetParticipantEq);

  const bandLabels: Record<EqBandId, string> = {
    low: t('voice:participantMenu.eq.bands.low'),
    lowMid: t('voice:participantMenu.eq.bands.lowMid'),
    mid: t('voice:participantMenu.eq.bands.mid'),
    presence: t('voice:participantMenu.eq.bands.presence'),
    high: t('voice:participantMenu.eq.bands.high'),
  };

  return (
    <div className="p-3 w-[280px]">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs text-txt-tertiary font-medium uppercase tracking-wider">
          {t('voice:participantMenu.eq.title')}
        </div>
        <button
          type="button"
          onClick={() => resetParticipantEq(userId)}
          className="text-[11px] text-txt-tertiary hover:text-txt-primary transition-colors"
        >
          {t('voice:participantMenu.eq.reset')}
        </button>
      </div>

      <div className="flex gap-1 mb-3">
        {EQ_PRESET_ORDER.map((preset) => {
          const active = eq.preset === preset;
          return (
            <button
              key={preset}
              type="button"
              aria-pressed={active}
              onClick={() => setParticipantEqPreset(userId, preset)}
              className={`flex-1 min-w-0 truncate rounded-md px-1.5 py-1 text-[11px] transition-colors ${
                active
                  ? 'bg-white/[0.09] text-txt-primary'
                  : 'text-txt-tertiary hover:bg-white/[0.05] hover:text-txt-secondary'
              }`}
            >
              {t(EQ_PRESET_LABEL_KEYS[preset])}
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5">
        {EQ_BANDS.map((band) => {
          const gain = eq.gains[band.id];
          const label = bandLabels[band.id];
          return (
            <div key={band.id} className="flex items-center gap-2">
              <span className="w-14 shrink-0 truncate text-[11px] text-txt-tertiary" title={label}>
                {label}
              </span>
              <input
                type="range"
                min={EQ_GAIN_MIN}
                max={EQ_GAIN_MAX}
                step={1}
                value={gain}
                aria-label={label}
                onChange={(e) => setParticipantEqBand(userId, band.id, Number(e.target.value))}
                className="h-1 min-w-0 flex-1 accent-accent-primary"
              />
              <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-txt-secondary">
                {t('voice:participantMenu.eq.gainDb', {
                  value: `${gain > 0 ? '+' : ''}${f.formatNumber(gain)}`,
                })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
