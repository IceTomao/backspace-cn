import { create } from 'zustand';
import { getApiForOrigin } from './spaceStore';

interface ChannelVisit {
  userId: string;
  origin: string;
  spaceId: string;
  channelId: string;
}

interface MediaPrivacyState {
  visit: ChannelVisit | null;
  enabled: boolean | null;
  showAll: boolean;
  revealed: ReadonlySet<string>;
  reveal: (item: string) => void;
  toggleAll: () => void;
}

const defaultView = { showAll: false, revealed: new Set<string>() };

export const useMediaPrivacyStore = create<MediaPrivacyState>((set) => ({
  visit: null,
  enabled: null,
  ...defaultView,
  reveal: (item) => set((state) => state.enabled === true
    ? { revealed: new Set(state.revealed).add(item) }
    : state),
  toggleAll: () => set((state) => state.enabled === true
    ? state.showAll ? defaultView : { showAll: true }
    : state),
}));

let request = 0;
let foreground = true;

export function setMediaPrivacyVisit(visit: ChannelVisit | null): void {
  const previous = useMediaPrivacyStore.getState().visit;
  if (previous?.userId === visit?.userId && previous?.origin === visit?.origin
    && previous?.spaceId === visit?.spaceId && previous?.channelId === visit?.channelId) return;
  request++;
  useMediaPrivacyStore.setState({ visit, enabled: null, ...defaultView });
  void refreshMediaPrivacy();
}

export function setMediaPrivacyForeground(visible: boolean): void {
  if (visible === foreground) return;
  foreground = visible;
  request++;
  useMediaPrivacyStore.setState({ enabled: null });
  if (visible) void refreshMediaPrivacy();
}

// Events invalidate the current read. The REST snapshot is authoritative even
// when Android delivers older settings events from its background backlog.
export async function refreshMediaPrivacy(origin?: string, channelId?: string, changedValue?: boolean): Promise<void> {
  const { visit, enabled } = useMediaPrivacyStore.getState();
  if (!visit || !foreground || (origin !== undefined && origin !== visit.origin)
    || (channelId !== undefined && channelId !== visit.channelId)
    || (changedValue !== undefined && changedValue === enabled)) return;

  const current = ++request;
  useMediaPrivacyStore.setState(changedValue === false ? { enabled: null, ...defaultView } : { enabled: null });
  try {
    const channels = await getApiForOrigin(visit.origin).channels.list(visit.spaceId);
    if (current !== request) return;
    const channel = channels.find((item) => item.id === visit.channelId);
    if (!channel) return;
    const enabled = channel.mediaPrivacyMask === true;
    useMediaPrivacyStore.setState(enabled ? { enabled } : { enabled, ...defaultView });
  } catch {
    // Keep media masked until the next successful read.
  }
}

export function invalidateMediaPrivacy(origin: string): void {
  if (useMediaPrivacyStore.getState().visit?.origin !== origin) return;
  request++;
  useMediaPrivacyStore.setState({ enabled: null });
}
