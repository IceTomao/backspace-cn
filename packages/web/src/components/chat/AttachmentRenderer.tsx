import { serverUrl } from '../../platform/android';
import React from 'react';
import { attachmentMimeType } from '@backspace/shared/src/media';
import { VideoAttachment } from './VideoAttachment';
import { useTranslation } from 'react-i18next';
import type { Attachment } from '@backspace/shared';
import { useUIStore } from '../../stores/uiStore';
import { useTransferStore } from '../../stores/transferStore';
import { Tooltip } from '../ui/Tooltip';
import { useFormatters } from '../../i18n/formatters';

interface AttachmentRendererProps {
  attachment: Attachment;
}

/**
 * Resolves the displayable URL for an attachment. Same logic used by inline
 * `<img>`/`<video>`/`<audio>` rendering and the file-card download button —
 * exported so right-click menus can use it without duplicating the rule.
 */
export function attUrlOf(filename: string): string {
  if (filename.startsWith('http') || filename.startsWith('/')) return serverUrl(filename);
  return serverUrl(`/api/uploads/${filename}`);
}

export function AttachmentRenderer({ attachment }: AttachmentRendererProps) {
  const { t } = useTranslation(['chat']);
  const { formatBytes } = useFormatters();
  const openImagePreview = useUIStore((s) => s.openImagePreview);
  const isMobile = useUIStore((s) => s.isMobile);
  const startDownload = useTransferStore((s) => s.startDownload);

  const attUrl = attUrlOf(attachment.filename);

  const thumbUrl = attachment.thumbnailFilename ? attUrlOf(attachment.thumbnailFilename) : null;
  const { originalName, size } = attachment;
  const mimetype = attachmentMimeType(attachment.mimetype, originalName, attachment.filename);

  // Federation status — build tooltip text
  const federationTooltip = (() => {
    if (!attachment.federationStatus) return null;

    if (attachment.federationStatus === 'remote') {
      let senderName: string | null = null;
      if (attachment.federationMeta) {
        try {
          const meta = JSON.parse(attachment.federationMeta);
          if (meta.sourceUsername) senderName = meta.sourceUsername;
        } catch { /* ignore */ }
      }
      const text = senderName
        ? t('chat:attachment.federation.remoteNamed', { sender: senderName })
        : t('chat:attachment.federation.remoteUnknown');
      return { text, type: 'remote' as const };
    }

    if (attachment.federationStatus === 'remote_partial') {
      let text = t('chat:attachment.federation.partialGeneric');
      if (attachment.federationMeta) {
        try {
          const meta: Array<{ username: string; limit: number }> = JSON.parse(attachment.federationMeta);
          if (meta.length > 0) {
            const parts = meta.map(u =>
              t('chat:attachment.federation.partialInstance', { username: u.username, limit: formatBytes(u.limit) }),
            );
            const instances = parts.reduce((first, second) =>
              t('chat:attachment.federation.listPair', { first, second }),
            );
            text = t('chat:attachment.federation.partialList', { instances });
          }
        } catch { /* ignore */ }
      }
      return { text, type: 'remote_partial' as const };
    }

    return null;
  })();

  // Inline badge — sits next to file size or below media, never absolute-positioned
  const federationInlineBadge = federationTooltip ? (
    <Tooltip content={federationTooltip.text} position="top">
      <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded glass-pill text-xs cursor-default ${federationTooltip.type === 'remote' ? 'text-txt-muted' : 'text-accent-amber'}`}>
        <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {federationTooltip.type === 'remote'
            ? <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
            : <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>
          }
        </svg>
      </div>
    </Tooltip>
  ) : null;

  if (mimetype.startsWith('image/')) {
    const { width, height } = attachment;
    return (
      <div className="mt-1 max-w-fit">
        <div
          className="relative rounded-lg overflow-hidden border border-white/[0.06]"
          style={width && height ? { aspectRatio: `${width}/${height}`, maxWidth: Math.min(width, 400), maxHeight: 300 } : undefined}
        >
          <img
            src={thumbUrl ?? attUrl}
            alt={originalName}
            role="button"
            tabIndex={0}
            draggable={false}
            className={`w-full h-full max-w-[400px] max-h-[300px] object-contain hover:brightness-95 transition-all ${isMobile ? 'cursor-pointer' : 'cursor-zoom-in'}`}
            onClick={() => {
              if (isMobile) openImagePreview(attUrl);
            }}
            onDoubleClick={() => {
              if (!isMobile) openImagePreview(attUrl);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              openImagePreview(attUrl);
            }}
            loading="lazy"
          />
        </div>
        {federationInlineBadge && <div className="mt-1">{federationInlineBadge}</div>}
      </div>
    );
  }

  if (mimetype.startsWith('video/')) {
    return (
      <VideoAttachment
        key={attUrl}
        attachment={{ ...attachment, mimetype }}
        attUrl={attUrl}
        thumbUrl={thumbUrl}
        federationInlineBadge={federationInlineBadge}
      />
    );
  }

  if (mimetype.startsWith('audio/')) {
    return (
      <div className="relative mt-1 flex flex-col p-3 bg-surface-channel/50 rounded-lg border border-border-hard max-w-[420px]">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-surface-base rounded text-txt-tertiary flex-shrink-0">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-txt-primary text-[14px] font-medium truncate">{originalName}</p>
            <div className="flex items-center gap-2">
              <p className="text-[12px] text-txt-tertiary">{formatBytes(size)}</p>
              {federationInlineBadge}
            </div>
          </div>
        </div>
        <audio controls preload="metadata" className="w-full mt-2 h-8">
          <source src={attUrl} type={mimetype} />
          {t('chat:attachment.audio.unsupportedBrowser')}
        </audio>
      </div>
    );
  }

  // Generic-file chip (PDF / .zip / .exe / unknown mimetypes).
  //
  // Width contract: the chip must fit inside the message column on every
  // viewport. We cap at 400 px on roomy layouts but `max-w-full` keeps it
  // inside narrow columns (mobile, narrow desktop window, threaded reply
  // contexts). `min-w-0` is the critical bit on the inner flex children — the
  // outer button is a flex container with a fixed-size icon and a flexible
  // text block; without `min-w-0` the long-filename child would refuse to
  // shrink (flex children's min-content size defaults to their intrinsic
  // content) and would push the entire chip past the parent's right edge.
  return (
    <button
      type="button"
      onClick={() => {
        void startDownload(attUrl, {
          filename: originalName,
          size,
          mimetype,
          tray: true,
        });
      }}
      className="mt-1 max-w-full desktop:max-w-[400px] flex items-center gap-3 p-4 bg-surface-channel/50 rounded-lg border border-border-hard hover:bg-interactive-hover transition-all group/att text-left w-full min-w-0"
    >
      <div className="p-2 bg-surface-base rounded text-txt-tertiary group-hover/att:text-txt-primary transition-colors flex-shrink-0">
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
          />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-txt-link text-[15px] font-medium truncate hover:underline">{originalName}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-[12px] text-txt-tertiary font-medium">{formatBytes(size)}</p>
          {federationInlineBadge}
        </div>
      </div>
    </button>
  );
}
