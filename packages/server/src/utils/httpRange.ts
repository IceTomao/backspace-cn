export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/** Single byte ranges; unsupported units/multipart ranges fall back to a full response. */
export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (!header || !/^bytes=/i.test(header) || header.includes(',')) return null;
  const match = /^(\d*)-(\d*)$/.exec(header.slice(6).trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return 'unsatisfiable';
  const length = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]!);
    if (suffix === 0n) return 'unsatisfiable';
    return { start: Number(suffix >= length ? 0n : length - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : length - 1n;
  if (start >= length || end < start) return 'unsatisfiable';
  return { start: Number(start), end: Number(end >= length ? length - 1n : end) };
}
