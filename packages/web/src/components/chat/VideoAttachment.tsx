import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Attachment } from '@backspace/shared';
import { androidCall, isAndroid } from '../../platform/android';
import { useTransferStore } from '../../stores/transferStore';
import { useFormatters } from '../../i18n/formatters';

interface Props {
  attachment: Attachment;
  attUrl: string;
  thumbUrl: string | null;
  federationInlineBadge: ReactNode;
}
const PLAY_EVENT = 'backspace-chat-video-play';

export function VideoAttachment({ attachment, attUrl, thumbUrl, federationInlineBadge }: Props) {
  const { t } = useTranslation('chat');
  const { formatBytes } = useFormatters();
  const startDownload = useTransferStore(s => s.startDownload);
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<'network' | 'decode' | 'open' | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const position = useRef(0);
  const { originalName, mimetype, size, width, height } = attachment;
  const ratio = width && height && width > 0 && height > 0 ? `${width}/${height}` : '16/9';

  useEffect(() => {
    const player = video.current;
    if (!active || !player) return;
    const pause = () => { position.current = player.currentTime; player.pause(); setActive(false); setLoading(false); };
    const hidden = () => { if (document.hidden) pause(); };
    const otherPlaying = (event: Event) => { if ((event as CustomEvent).detail !== player) pause(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener(PLAY_EVENT, otherPlaying);
    void player.play().catch(() => setLoading(false)); // Controls remain usable if the browser requires another gesture.
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener(PLAY_EVENT, otherPlaying);
      player.pause(); player.removeAttribute('src'); player.load();
    };
  }, [active, attUrl]);

  const play = async () => {
    setError(null); setLoading(true);
    if (isAndroid()) {
      try { await androidCall('openVideo', { url: attUrl, title: originalName, mimetype }); }
      catch { setError('open'); }
      finally { setLoading(false); }
    } else setActive(true);
  };

  return <div className="mt-1 w-full max-w-[400px] rounded-lg overflow-hidden border border-border-soft bg-surface-channel/50">
    <div className="relative bg-black max-h-[300px]" style={{ aspectRatio: ratio }}>
      {active ? <video ref={video} src={attUrl} controls playsInline preload="none" poster={thumbUrl ?? undefined}
        className="w-full h-full max-h-[300px] object-contain"
        onLoadedMetadata={event => { if (position.current > 0) event.currentTarget.currentTime = position.current; }}
        onPlay={event => { window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: event.currentTarget })); }}
        onWaiting={() => setLoading(true)} onPlaying={() => setLoading(false)} onPause={() => setLoading(false)}
        onError={event => { position.current = event.currentTarget.currentTime; setError(event.currentTarget.error?.code === 2 ? 'network' : 'decode'); setActive(false); setLoading(false); }}
      /> : <button type="button" onClick={() => void play()} disabled={loading}
        aria-label={t('attachment.video.play', { name: originalName })}
        className="relative w-full h-full min-h-24 flex items-center justify-center text-white disabled:opacity-60">
        {thumbUrl && <img src={thumbUrl} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-contain" />}
        <span className="relative rounded-full bg-black/60 p-3 text-2xl" aria-hidden="true">▶</span>
      </button>}
    </div>
    <div className="p-3 space-y-2">
      <p className="text-sm text-txt-primary truncate" title={originalName}>{originalName}</p>
      <p className="text-xs text-txt-tertiary">{formatBytes(size)}</p>
      {attachment.playable === false && !error && <p className="text-xs text-txt-tertiary">{t('attachment.video.compatibility')}</p>}
      {loading && <p role="status" className="text-xs text-txt-secondary">{t('attachment.video.loading')}</p>}
      {error && <div role="alert" className="text-xs text-txt-secondary">
        <p>{t(`attachment.video.${error}Error`)}</p>
        <button type="button" className="mt-2 text-txt-link" onClick={() => void play()}>{t('attachment.video.retry')}</button>
      </div>}
      <button type="button" className="text-xs text-txt-link" onClick={() => void startDownload(attUrl, { filename: originalName, size, mimetype, tray: true })}>
        {t('attachment.video.download')}
      </button>
      {federationInlineBadge}
    </div>
  </div>;
}
