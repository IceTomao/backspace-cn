import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useTrackStats, AudioTrackStat, VideoTrackStat } from '../../hooks/useTrackStats';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import i18n from '../../i18n';
import { formatters } from '../../i18n/formatters';
import { VOICE_HEALTH, healthBand, type HealthBand } from '../../utils/voiceHealth';
import { useVoiceStore } from '../../stores/voiceStore';
import { getRequestedPublishedScreenShareCodec } from '../../utils/screenShare';
import { resolveEffectiveScreenShareCodec } from '../../utils/codecCapabilities';

interface ConnectionInfoPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

/** Whole kbps below 1 Mbps, one decimal up to 10 Mbps, whole Mbps above; the number itself goes through the locale. */
function formatBitrate(kbps: number): string {
  if (kbps < 1000) {
    return i18n.t('common:units.kbps', { value: formatters.formatNumber(Math.round(kbps)) });
  }
  const mbps = kbps >= 10000 ? Math.round(kbps / 1000) : Math.round(kbps / 100) / 10;
  return i18n.t('common:units.mbps', { value: formatters.formatNumber(mbps) });
}

function formatMilliseconds(ms: number): string {
  return i18n.t('common:units.ms', { value: formatters.formatNumber(ms) });
}

/** Packet loss keeps one decimal so a 0.3% loss does not read as 0%. */
function formatLossPercent(pct: number): string {
  return i18n.t('common:units.percent', { value: formatters.formatNumber(Math.round(pct * 10) / 10) });
}

const BAND_COLORS: Record<HealthBand, string> = {
  good: 'text-status-online',
  warn: 'text-status-idle',
  bad: 'text-txt-danger',
};

function pingColor(ms: number): string {
  return BAND_COLORS[healthBand(ms, VOICE_HEALTH.pingWarnMs, VOICE_HEALTH.pingBadMs)];
}

function lossColor(pct: number): string {
  return BAND_COLORS[healthBand(pct, VOICE_HEALTH.lossWarnPct, VOICE_HEALTH.lossBadPct)];
}

function jitterColor(ms: number): string {
  return BAND_COLORS[healthBand(ms, VOICE_HEALTH.jitterWarnMs, VOICE_HEALTH.jitterBadMs)];
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'microphone': return i18n.t('voice:connectionInfo.source.microphone');
    case 'camera': return i18n.t('voice:connectionInfo.source.camera');
    case 'screen_share': return i18n.t('voice:connectionInfo.source.screen');
    case 'screen_share_audio': return i18n.t('voice:connectionInfo.source.screenAudio');
    default: return i18n.t('voice:connectionInfo.source.unknown');
  }
}

function trackLabel(direction: 'send' | 'recv', source: string, participantName: string | null): string {
  const arrow = direction === 'send' ? '\u2191' : '\u2193';
  if (direction === 'send') {
    return `${sourceLabel(source)} ${arrow}`;
  }
  const name = participantName ?? i18n.t('voice:connectionInfo.remoteParticipant');
  return `${name} ${sourceLabel(source)} ${arrow}`;
}

const Row = ({ label, value, colorClass }: { label: string; value: string; colorClass?: string }) => (
  <div className="flex items-start justify-between gap-3 py-[3px]">
    <span className="text-[12px] text-txt-tertiary flex-shrink-0">{label}</span>
    <span className={`text-[12px] font-medium text-right ${colorClass ?? 'text-txt-secondary'}`}>{value}</span>
  </div>
);

const Divider = () => <div className="border-t border-border-soft my-1" />;

const SectionHeader = ({ title }: { title: string }) => (
  <div className="text-[10px] font-bold text-txt-tertiary uppercase tracking-wider pt-1 pb-[2px]">
    {title}
  </div>
);

function AudioTrackRow({ track }: { track: AudioTrackStat }) {
  const label = trackLabel(track.direction, track.source, track.participantName);
  return (
    <div className="flex items-center justify-between py-[3px]">
      <span className="text-[12px] text-txt-tertiary truncate mr-2">{label}</span>
      <span className="text-[12px] font-medium text-txt-secondary whitespace-nowrap">
        {formatBitrate(track.bitrate)}
        {track.codec && <span className="text-txt-tertiary ml-2">{track.codec}</span>}
      </span>
    </div>
  );
}

function VideoTrackRow({ track }: { track: VideoTrackStat }) {
  const label = trackLabel(track.direction, track.source, track.participantName);
  const resolution = (track.width && track.height) ? `${track.width}\u00d7${track.height}` : null;

  return (
    <div className="py-[3px]">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-txt-tertiary truncate mr-2">{label}</span>
        <span className="text-[12px] font-medium text-txt-secondary whitespace-nowrap">
          {formatBitrate(track.bitrate)}
          {track.codec && <span className="text-txt-tertiary ml-2">{track.codec}</span>}
        </span>
      </div>
      {(resolution || track.fps !== null || track.qualityLimitation || track.simulcastLayer || track.encoderImpl) && (
        <div className="flex items-center justify-between pl-3">
          <span className="text-[11px] text-txt-tertiary">
            {resolution && `${resolution}`}
            {track.fps !== null && ` @${track.fps}`}
          </span>
          <span className="text-[11px] text-txt-tertiary">
            {track.direction === 'send' && (() => {
              const parts: string[] = [];
              if (track.encoderImpl) parts.push(track.encoderImpl);
              if (track.qualityLimitation && track.qualityLimitation !== 'none') parts.push(track.qualityLimitation);
              return parts.join(' · ') || null;
            })()}
            {track.direction === 'recv' && track.simulcastLayer
              ? track.simulcastLayer
              : ''}
          </span>
        </div>
      )}
    </div>
  );
}

export function ConnectionInfoPopover({ open, onClose, anchorRef }: ConnectionInfoPopoverProps) {
  const { t } = useTranslation(['voice', 'common']);
  const popoverRef = useRef<HTMLDivElement>(null);
  const portalContainer = usePortalContainer();
  const stats = useTrackStats(open);
  const requestedCodec = useVoiceStore((s) => s.screenShareConfig.codec);
  const targetFps = useVoiceStore((s) => s.screenShareConfig.fps);

  const { style } = useFloatingPosition(anchorRef, popoverRef, {
    placement: 'top',
    offset: 12,
    enabled: open,
  });

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // The anchor owns its own toggle: closing here on its mousedown would
      // make the following click re-open the popover instead of closing it.
      if (anchorRef.current?.contains(target)) return;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const room = getActiveRoom();
  const outboundScreen = stats?.videoTracks.find((track) =>
    track.direction === 'send' && track.source === 'screen_share',
  );
  const publishedRequestedCodec = getRequestedPublishedScreenShareCodec();
  const effectiveRequestedCodec = requestedCodec === 'auto'
    ? (publishedRequestedCodec ?? resolveEffectiveScreenShareCodec('auto', false))
    : requestedCodec;
  const requestedCodecDisplay = requestedCodec === 'auto'
    ? `AUTO (${effectiveRequestedCodec.toUpperCase()})`
    : requestedCodec.toUpperCase();

  const negotiatedNorm = outboundScreen?.codec
    ? (outboundScreen.codec.toLowerCase().includes('hevc') ? 'h265' : outboundScreen.codec.toLowerCase())
    : null;
  const isSoftwareEncoder = Boolean(
    outboundScreen?.encoderImpl && /libvpx|libaom|ffmpeg|openh264/i.test(outboundScreen.encoderImpl),
  );
  const frameBudgetMs = targetFps > 0 ? 1000 / targetFps : 16.7;

  const bottleneck = outboundScreen ? (() => {
    if (isSoftwareEncoder) {
      return {
        text: t('voice:connectionInfo.video.bottleneckStatus.softwareEncoder'),
        colorClass: BAND_COLORS.bad,
      };
    }
    if (outboundScreen.qualityLimitation === 'bandwidth') {
      return {
        text: t('voice:connectionInfo.video.bottleneckStatus.bandwidth'),
        colorClass: BAND_COLORS.bad,
      };
    }
    if (
      outboundScreen.qualityLimitation === 'cpu' ||
      (outboundScreen.encodeTimeMs !== null && outboundScreen.encodeTimeMs > frameBudgetMs * 0.85)
    ) {
      return {
        text: t('voice:connectionInfo.video.bottleneckStatus.encoderOverload'),
        colorClass: BAND_COLORS.bad,
      };
    }
    if (outboundScreen.captureFps !== null && targetFps > 0 && outboundScreen.captureFps < Math.round(targetFps * 0.75)) {
      return {
        text: t('voice:connectionInfo.video.bottleneckStatus.captureStarved'),
        colorClass: BAND_COLORS.warn,
      };
    }
    if (negotiatedNorm && !negotiatedNorm.includes(effectiveRequestedCodec)) {
      return {
        text: t('voice:connectionInfo.video.bottleneckStatus.codecRegressed', {
          codec: outboundScreen.codec ?? negotiatedNorm.toUpperCase(),
        }),
        colorClass: BAND_COLORS.warn,
      };
    }
    return {
      text: t('voice:connectionInfo.video.bottleneckStatus.ok'),
      colorClass: BAND_COLORS.good,
    };
  })() : null;

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className="w-[320px] glass rounded-lg overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-border-hard">
        <span className="text-[14px] font-bold text-txt-primary">{t('voice:connectionInfo.title')}</span>
      </div>

      <div className="px-3 py-2 max-h-[calc(calc(100*var(--app-vh))-32px)] overflow-y-auto scrollbar-thin">
        {!room ? (
          <div className="text-[12px] text-txt-tertiary py-2 text-center">{t('voice:connectionInfo.notConnected')}</div>
        ) : !stats ? (
          <div className="text-[12px] text-txt-tertiary py-2 text-center">{t('voice:connectionInfo.gathering')}</div>
        ) : (
          <>
            {/* Network */}
            <SectionHeader title={t('voice:connectionInfo.section.network')} />
            <Row
              label={t('voice:connectionInfo.network.ping')}
              value={stats.network.ping !== null ? formatMilliseconds(stats.network.ping) : '\u2014'}
              colorClass={stats.network.ping !== null ? pingColor(stats.network.ping) : undefined}
            />
            <Row
              label={t('voice:connectionInfo.network.packetLoss')}
              value={stats.network.packetLoss !== null ? formatLossPercent(stats.network.packetLoss) : '\u2014'}
              colorClass={stats.network.packetLoss !== null ? lossColor(stats.network.packetLoss) : undefined}
            />
            <Row
              label={t('voice:connectionInfo.network.jitter')}
              value={stats.network.jitter !== null ? formatMilliseconds(stats.network.jitter) : '\u2014'}
              colorClass={stats.network.jitter !== null ? jitterColor(stats.network.jitter) : undefined}
            />
            <Row label={t('voice:connectionInfo.network.server')} value={stats.network.serverAddress ?? '\u2014'} />
            <Row
              label={t('voice:connectionInfo.network.protocol')}
              value={
                stats.network.protocol
                  ? `${stats.network.protocol}${stats.network.candidateType ? ` (${stats.network.candidateType})` : ''}`
                  : '\u2014'
              }
            />

            {/* Audio Tracks */}
            {stats.audioTracks.length > 0 && (
              <>
                <Divider />
                <SectionHeader title={t('voice:connectionInfo.section.audio')} />
                {stats.audioTracks.map((t) => (
                  <AudioTrackRow key={t.key} track={t} />
                ))}
              </>
            )}

            {/* Video Tracks */}
            {stats.videoTracks.length > 0 && (
              <>
                <Divider />
                <SectionHeader title={t('voice:connectionInfo.section.video')} />
                {outboundScreen && (
                  <>
                    {bottleneck && (
                      <Row
                        label={t('voice:connectionInfo.video.bottleneck')}
                        value={bottleneck.text}
                        colorClass={bottleneck.colorClass}
                      />
                    )}
                    <Row
                      label={t('voice:connectionInfo.video.captureFps')}
                      value={
                        outboundScreen.captureFps !== null
                          ? t('voice:connectionInfo.video.captureFpsValue', {
                              capture: formatters.formatNumber(outboundScreen.captureFps),
                              target: formatters.formatNumber(targetFps),
                            })
                          : '\u2014'
                      }
                      colorClass={
                        outboundScreen.captureFps !== null && targetFps > 0
                          ? (outboundScreen.captureFps < Math.round(targetFps * 0.75) ? BAND_COLORS.warn : BAND_COLORS.good)
                          : undefined
                      }
                    />
                    <Row
                      label={t('voice:connectionInfo.video.encodeFps')}
                      value={
                        outboundScreen.fps !== null
                          ? t('voice:connectionInfo.video.encodeFpsValue', {
                              fps: formatters.formatNumber(outboundScreen.fps),
                            })
                          : '\u2014'
                      }
                      colorClass={
                        outboundScreen.fps !== null && targetFps > 0
                          ? (outboundScreen.fps < Math.round(targetFps * 0.75) ? BAND_COLORS.warn : BAND_COLORS.good)
                          : undefined
                      }
                    />
                    <Row
                      label={t('voice:connectionInfo.video.encodeTime')}
                      value={
                        outboundScreen.encodeTimeMs !== null
                          ? (() => {
                              const hwState = isSoftwareEncoder || outboundScreen.powerEfficientEncoder === false
                                ? t('voice:connectionInfo.video.swFallback')
                                : outboundScreen.powerEfficientEncoder === true || outboundScreen.encoderImpl
                                  ? t('voice:connectionInfo.video.hwAccel')
                                  : null;
                              const msText = formatMilliseconds(outboundScreen.encodeTimeMs);
                              return hwState ? `${msText} (${hwState})` : msText;
                            })()
                          : '\u2014'
                      }
                      colorClass={
                        outboundScreen.encodeTimeMs !== null
                          ? (outboundScreen.encodeTimeMs > frameBudgetMs * 0.85 || isSoftwareEncoder ? BAND_COLORS.bad : BAND_COLORS.good)
                          : undefined
                      }
                    />
                    <Row label={t('voice:connectionInfo.video.requestedCodec')} value={requestedCodecDisplay} />
                    <Row label={t('voice:connectionInfo.video.negotiatedCodec')} value={outboundScreen.codec ?? '\u2014'} />
                    {outboundScreen.encoderImpl && (
                      <Row label={t('voice:connectionInfo.video.encoderImplementation')} value={outboundScreen.encoderImpl} />
                    )}
                    <Row
                      label={t('voice:connectionInfo.video.qpDelta')}
                      value={outboundScreen.qpSumDelta?.toString() ?? '\u2014'}
                    />
                    <Row
                      label={t('voice:connectionInfo.video.nackDelta')}
                      value={outboundScreen.nackCountDelta?.toString() ?? '\u2014'}
                    />
                    <Row
                      label={t('voice:connectionInfo.video.pliDelta')}
                      value={outboundScreen.pliCountDelta?.toString() ?? '\u2014'}
                    />
                  </>
                )}
                {stats.videoTracks.map((t) => (
                  <VideoTrackRow key={t.key} track={t} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>,
    portalContainer,
  );
}
