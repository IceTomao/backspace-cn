import { create } from 'zustand';
import { api, type FavoriteMediaItem } from '../api/client';

interface FavoriteMediaState {
  items: FavoriteMediaItem[];
  urls: Map<string, string>;
  legacySession: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  urlFor: (id: string) => Promise<string | null>;
  add: (file: File) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reset: () => void;
}

export const useFavoriteMediaStore = create<FavoriteMediaState>((set, get) => ({
  items: [],
  urls: new Map(),
  legacySession: null,
  loaded: false,
  load: async () => {
    const loadLegacy = async (token: string): Promise<{ session: string; items: FavoriteMediaItem[] } | null> => {
      if (window.backspace?.platform !== 'win32' || !window.backspace.favoriteImages) return null;
      try {
        const session = await window.backspace.favoriteImages({ action: 'session', token }) as { ok?: boolean; session?: string };
        if (!session.ok || !session.session) return null;
        const listing = await window.backspace.favoriteImages({ action: 'list', session: session.session }) as {
          items?: Array<{ id: string; name: string; mime: string; size?: number; addedAt?: number }>;
        };
        return {
          session: session.session,
          items: (listing.items ?? []).map((item) => ({
            id: item.id,
            name: item.name,
            mime: item.mime,
            size: item.size ?? 0,
            addedAt: item.addedAt ?? Date.now(),
          })),
        };
      } catch {
        return null;
      }
    };

    try {
      const result = await api.favoriteMedia.list();
      let items = result.items;
      // Migrate the pre-1.3.12 Windows-only collection once per instance. The
      // old IPC store remains available only as an offline migration source.
      if (window.backspace?.platform === 'win32' && window.backspace.favoriteImages) {
        const token = localStorage.getItem('backspace_token');
        const marker = `backspace-favorite-media-migrated:${location.origin}:${token?.slice(-16) ?? 'signed-out'}`;
        if (!localStorage.getItem(marker)) {
          if (token) {
            const legacy = await loadLegacy(token);
            if (legacy) {
              let migrationFailed = false;
              for (const item of legacy.items) {
                const read = await window.backspace.favoriteImages!({ action: 'read', session: legacy.session, id: item.id }) as { bytes?: Uint8Array; item?: { name: string; mime: string } };
                if (read.bytes && read.item) {
                  try { await api.favoriteMedia.add(read.item.name, new Uint8Array(read.bytes)); } catch { migrationFailed = true; }
                } else {
                  migrationFailed = true;
                }
              }
              if (!migrationFailed) localStorage.setItem(marker, '1');
              const serverItems = (await api.favoriteMedia.list()).items;
              const serverIds = new Set(serverItems.map((item) => item.id));
              const localOnly = legacy.items.filter((item) => !serverIds.has(item.id));
              // Keep any files that could not be uploaded (for example while
              // the server was briefly offline) visible through the legacy IPC
              // reader until a later migration attempt succeeds.
              items = [...serverItems, ...localOnly];
              if (localOnly.length > 0) set({ legacySession: legacy.session });
            }
          }
        }
      }
      set({ items, loaded: true });
    } catch {
      const token = localStorage.getItem('backspace_token');
      const legacy = token ? await loadLegacy(token) : null;
      set({ items: legacy?.items ?? [], legacySession: legacy?.session ?? null, loaded: true });
    }
  },
  urlFor: async (id) => {
    const cached = get().urls.get(id);
    if (cached) return cached;
    try {
      const blob = await api.favoriteMedia.read(id);
      const url = URL.createObjectURL(blob);
      set((state) => {
        const urls = new Map(state.urls);
        urls.set(id, url);
        return { urls };
      });
      return url;
    } catch {
      const session = get().legacySession;
      if (!session || !window.backspace?.favoriteImages) return null;
      try {
        const result = await window.backspace.favoriteImages({ action: 'read', session, id }) as { bytes?: Uint8Array };
        if (!result.bytes) return null;
        const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)]));
        set((state) => {
          const urls = new Map(state.urls);
          urls.set(id, url);
          return { urls };
        });
        return url;
      } catch {
        return null;
      }
    }
  },
  add: async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await api.favoriteMedia.add(file.name, bytes);
    set((state) => ({
      items: state.items.some((item) => item.id === result.item.id)
        ? state.items
        : [result.item, ...state.items],
    }));
  },
  remove: async (id) => {
    await api.favoriteMedia.remove(id);
    const url = get().urls.get(id);
    if (url) URL.revokeObjectURL(url);
    set((state) => {
      const urls = new Map(state.urls);
      urls.delete(id);
      return { items: state.items.filter((item) => item.id !== id), urls };
    });
  },
  reset: () => {
    for (const url of get().urls.values()) URL.revokeObjectURL(url);
    set({ items: [], urls: new Map(), legacySession: null, loaded: false });
  },
}));
