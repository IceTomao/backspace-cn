// packages/web/src/utils/hwOverdrive.ts
//
// Negotiation-scoped SDP overdrive for screen-share publishing:
// 1. Upgrades H.264 Constrained Baseline (42e01f/42c01f) → High Profile Level 5.0 (4d0032)
//    to unlock hardware 1080p60 / 1440p60 / 4K60 NVENC / AMF / QSV encoding.
// 2. Injects `x-google-start-bitrate` and `x-google-min-bitrate` on the screen-share
//    video media section so WebRTC's GCC congestion controller starts crisp and never
//    collapses to ~300 kbps slow-start on transient cross-ISP jitter.

export interface SdpOverdriveOptions {
  codec?: 'h264' | 'vp9' | 'h265';
  targetBitrateBps?: number;
  trackId?: string;
}

let _active = false;
let _currentOptions: SdpOverdriveOptions = { codec: 'h264' };
let _originalCreateOffer: typeof RTCPeerConnection.prototype.createOffer | null = null;

function matchesCodecName(rtpCodec: string, target: 'h264' | 'vp9' | 'h265'): boolean {
  const upper = rtpCodec.toUpperCase();
  if (target === 'h264') return upper === 'H264';
  if (target === 'vp9') return upper === 'VP9';
  return upper === 'H265' || upper === 'HEVC';
}

export function computeBitrateBoundsKbps(targetBitrateBps: number): {
  startKbps: number;
  minKbps: number;
} {
  const targetKbps = Math.max(500, Math.round(targetBitrateBps / 1000));
  const startKbps = Math.min(targetKbps, Math.max(500, Math.round(targetKbps * 0.75)));
  const desiredFloor = Math.max(Math.round(targetKbps * 0.35), Math.min(1200, Math.round(targetKbps * 0.5)));
  const minKbps = Math.min(desiredFloor, 4500, startKbps);
  return { startKbps, minKbps };
}

function upsertFmtpParam(params: string, key: string, value: number): string {
  const re = new RegExp(`(^|;\\s*)${key}=\\d+`, 'i');
  if (re.test(params)) {
    return params.replace(re, `$1${key}=${value}`);
  }
  const trimmed = params.trim();
  return trimmed.length > 0 ? `${trimmed};${key}=${value}` : `${key}=${value}`;
}

export function rewriteScreenShareSdp(sdp: string, options: SdpOverdriveOptions): string {
  const codec = options.codec ?? 'h264';
  const lineBreak = sdp.includes('\r\n') ? '\r\n' : '\n';
  const rawLines = sdp.split(/\r?\n/);

  // Split SDP into session header + media sections (`m=...`)
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of rawLines) {
    if (line.startsWith('m=') && current.length > 0) {
      sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current);

  const hasAnyMatchingTrackId = Boolean(
    options.trackId &&
    sections.some(
      (sec) =>
        sec[0]?.startsWith('m=video ') &&
        sec.some((l) => l.startsWith('a=msid:') && l.includes(options.trackId!)),
    ),
  );

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const sec = sections[sIdx]!;
    if (!sec[0]?.startsWith('m=video ')) continue;

    if (
      hasAnyMatchingTrackId &&
      options.trackId &&
      !sec.some((l) => l.startsWith('a=msid:') && l.includes(options.trackId!))
    ) {
      continue;
    }

    if (codec === 'h264') {
      for (let i = 0; i < sec.length; i++) {
        sec[i] = sec[i]!.replace(/profile-level-id=(42e01f|42c01f)/gi, 'profile-level-id=4d0032');
      }
    }

    if (options.targetBitrateBps && options.targetBitrateBps > 0) {
      const { startKbps, minKbps } = computeBitrateBoundsKbps(options.targetBitrateBps);
      const matchingPayloads = new Set<string>();

      for (const line of sec) {
        const match = /^a=rtpmap:(\d+)\s+([^/\s]+)\/\d+/i.exec(line);
        if (match && matchesCodecName(match[2]!, codec)) {
          matchingPayloads.add(match[1]!);
        }
      }

      if (matchingPayloads.size > 0) {
        const seenFmtpPayloads = new Set<string>();
        for (let i = 0; i < sec.length; i++) {
          const fmtpMatch = /^a=fmtp:(\d+)\s+(.*)$/i.exec(sec[i]!);
          if (fmtpMatch && matchingPayloads.has(fmtpMatch[1]!)) {
            const pt = fmtpMatch[1]!;
            seenFmtpPayloads.add(pt);
            let updated = upsertFmtpParam(fmtpMatch[2]!, 'x-google-start-bitrate', startKbps);
            updated = upsertFmtpParam(updated, 'x-google-min-bitrate', minKbps);
            sec[i] = `a=fmtp:${pt} ${updated}`;
          }
        }

        // Insert a=fmtp immediately after a=rtpmap for codecs without an existing fmtp line
        for (const pt of matchingPayloads) {
          if (seenFmtpPayloads.has(pt)) continue;
          const rtpmapIdx = sec.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
          if (rtpmapIdx !== -1) {
            sec.splice(
              rtpmapIdx + 1,
              0,
              `a=fmtp:${pt} x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps}`,
            );
          }
        }
      }
    }
  }

  return sections.map((sec) => sec.join(lineBreak)).join(lineBreak);
}

/**
 * Activate the negotiation-scoped SDP override for screen-share publishing.
 * Updates options in place if already active.
 */
export function activate(options?: SdpOverdriveOptions): void {
  _currentOptions = options ? { ...options } : { codec: 'h264' };
  if (_active) return;

  _originalCreateOffer = RTCPeerConnection.prototype.createOffer;
  _active = true;

  const patched: typeof RTCPeerConnection.prototype.createOffer = async function (
    this: RTCPeerConnection,
    offerOptions?: RTCOfferOptions,
  ): Promise<RTCSessionDescriptionInit> {
    const offer = await (
      _originalCreateOffer as (opts?: RTCOfferOptions) => Promise<RTCSessionDescriptionInit>
    ).call(this, offerOptions);
    if (_active && offer.sdp) {
      return { type: offer.type, sdp: rewriteScreenShareSdp(offer.sdp, _currentOptions) };
    }
    return offer;
  } as unknown as typeof RTCPeerConnection.prototype.createOffer;

  RTCPeerConnection.prototype.createOffer = patched;
}

/**
 * Deactivate the SDP override and restore `RTCPeerConnection.prototype.createOffer`.
 */
export function deactivate(): void {
  if (!_active) return;
  if (_originalCreateOffer) {
    RTCPeerConnection.prototype.createOffer = _originalCreateOffer;
    _originalCreateOffer = null;
  }
  _active = false;
  _currentOptions = { codec: 'h264' };
}

/** Check if the SDP override is currently active. */
export function isActive(): boolean {
  return _active;
}
