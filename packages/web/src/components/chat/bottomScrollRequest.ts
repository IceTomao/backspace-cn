export interface BottomScrollRequestTracker {
  channelId: string;
  marker: string | null;
}

export interface BottomScrollRequestResult {
  tracker: BottomScrollRequestTracker;
  shouldScroll: boolean;
}

export function consumeBottomScrollRequest(
  tracker: BottomScrollRequestTracker,
  channelId: string,
  marker: string | null,
): BottomScrollRequestResult {
  if (tracker.channelId !== channelId) {
    return { tracker: { channelId, marker }, shouldScroll: false };
  }
  if (!marker || tracker.marker === marker) {
    return { tracker, shouldScroll: false };
  }
  return { tracker: { channelId, marker }, shouldScroll: true };
}
