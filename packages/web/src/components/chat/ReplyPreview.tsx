import type { MessageWithUser } from '@backspace/shared';
import { File, Image as ImageIcon, Link2, Music2, Paperclip, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { serverUrl } from '../../platform/android';
import { MentionBadge } from './MentionBadge';

const GIF_URL_REGEX = /^https:\/\/(?:media\.tenor\.com|static\.klipy\.com)\/.+$/;

function attachmentUrl(filename: string): string {
  if (filename.startsWith('http') || filename.startsWith('/')) return serverUrl(filename);
  return serverUrl(`/api/uploads/${filename}`);
}

export type ReplyPreviewKind = 'text' | 'gif' | 'image' | 'video' | 'audio' | 'file' | 'link' | 'unavailable';

export interface ReplyPreviewData {
  kind: ReplyPreviewKind;
  text?: string;
  thumbnailUrl?: string;
  attachmentCount: number;
}

function attachmentKind(mimetype: string): ReplyPreviewKind {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'file';
}

function renderInlineWithMentions(content: string) {
  return content.split(/(<@[a-zA-Z0-9_-]+>)/g).map((part, index) => {
    const match = /^<@([a-zA-Z0-9_-]+)>$/.exec(part);
    return match ? <MentionBadge key={index} userId={match[1]!} /> : part;
  });
}

export function getReplyPreviewData(message: MessageWithUser): ReplyPreviewData {
  const content = message.content?.trim() ?? '';
  const attachments = message.attachments ?? [];
  const embeds = message.embeds ?? [];
  const imageAttachment = attachments.find((attachment) => attachment.mimetype.startsWith('image/'));
  const attachmentThumbnail = imageAttachment
    ? attachmentUrl(imageAttachment.thumbnailFilename ?? imageAttachment.filename)
    : undefined;

  if (GIF_URL_REGEX.test(content)) {
    return { kind: 'gif', thumbnailUrl: content, attachmentCount: attachments.length };
  }

  const isSingleUrl = /^https?:\/\/\S+$/.test(content);
  const matchingEmbed = isSingleUrl ? embeds.find((embed) => embed.url === content) : undefined;
  if (matchingEmbed) {
    const isImage = matchingEmbed.embedType === 'image';
    return {
      kind: isImage ? 'image' : 'link',
      text: matchingEmbed.title ?? undefined,
      thumbnailUrl: isImage ? (matchingEmbed.image ?? matchingEmbed.url) : matchingEmbed.image ?? undefined,
      attachmentCount: attachments.length,
    };
  }

  if (content) {
    return {
      kind: 'text',
      text: content,
      thumbnailUrl: attachmentThumbnail,
      attachmentCount: attachments.length,
    };
  }

  const firstAttachment = attachments[0];
  if (firstAttachment) {
    const kind = attachmentKind(firstAttachment.mimetype);
    return {
      kind,
      text: kind === 'file' ? firstAttachment.originalName : undefined,
      thumbnailUrl: kind === 'image'
        ? attachmentUrl(firstAttachment.thumbnailFilename ?? firstAttachment.filename)
        : undefined,
      attachmentCount: attachments.length,
    };
  }

  const firstEmbed = embeds[0];
  if (firstEmbed) {
    const isImage = firstEmbed.embedType === 'image';
    return {
      kind: isImage ? 'image' : 'link',
      text: firstEmbed.title ?? undefined,
      thumbnailUrl: isImage ? (firstEmbed.image ?? firstEmbed.url) : firstEmbed.image ?? undefined,
      attachmentCount: 0,
    };
  }

  return { kind: 'unavailable', attachmentCount: 0 };
}

const ICONS: Partial<Record<ReplyPreviewKind, typeof File>> = {
  image: ImageIcon,
  video: Video,
  audio: Music2,
  file: File,
  link: Link2,
};

export function ReplyPreview({ message }: { message: MessageWithUser }) {
  const { t } = useTranslation('chat');
  const preview = getReplyPreviewData(message);
  const fallback = preview.kind === 'unavailable'
    ? t('reply.unavailable')
    : t(`reply.${preview.kind}`);
  const text = preview.text || fallback;
  const extraAttachments = preview.kind === 'text'
    ? preview.attachmentCount
    : Math.max(0, preview.attachmentCount - 1);
  const Icon = ICONS[preview.kind];

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {preview.thumbnailUrl && (
        <img
          src={preview.thumbnailUrl}
          alt=""
          className="h-6 w-6 shrink-0 rounded object-cover"
          loading="lazy"
        />
      )}
      {!preview.thumbnailUrl && preview.kind === 'gif' && (
        <span className="shrink-0 text-[10px] font-semibold" aria-hidden="true">GIF</span>
      )}
      {!preview.thumbnailUrl && Icon && (
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      {preview.kind === 'text' && preview.attachmentCount > 0 && !preview.thumbnailUrl && (
        <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">{renderInlineWithMentions(text)}</span>
      {extraAttachments > 0 && (
        <span className="shrink-0 text-txt-tertiary">
          {t('reply.moreAttachments', { count: extraAttachments })}
        </span>
      )}
    </span>
  );
}
