const VIDEO_EXTENSIONS: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

/** Infer only missing/generic MIME types; explicit file types remain authoritative. */
export function attachmentMimeType(mimetype: string | null | undefined, originalName: string, filename = ''): string {
  const normalized = (mimetype ?? '').split(';')[0]!.trim().toLowerCase();
  if (normalized && !['application/octet-stream', 'binary/octet-stream', 'application/x-download'].includes(normalized)) return normalized;
  for (const name of [originalName, filename]) {
    const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1]?.toLowerCase();
    if (extension && VIDEO_EXTENSIONS[extension]) return VIDEO_EXTENSIONS[extension]!;
  }
  return normalized || 'application/octet-stream';
}
