import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFavoriteMediaStore } from '../../stores/favoriteMediaStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';

interface FavoriteMediaPickerProps {
  onSelect: (file: File) => void;
  mobile?: boolean;
}

export function FavoriteMediaPicker({ onSelect, mobile = false }: FavoriteMediaPickerProps) {
  const { t } = useTranslation('chat');
  const items = useFavoriteMediaStore((state) => state.items);
  const loaded = useFavoriteMediaStore((state) => state.loaded);
  const load = useFavoriteMediaStore((state) => state.load);
  const urlFor = useFavoriteMediaStore((state) => state.urlFor);
  const remove = useFavoriteMediaStore((state) => state.remove);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number } | null>(null);
  const suppressClickRef = useRef<string | null>(null);

  const cancelLongPress = () => {
    if (longPressRef.current?.timer) clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  };

  const showRemove = (id: string, x: number, y: number) => {
    useContextMenuStore.getState().open(
      { x, y },
      [{ key: 'remove-favorite', type: 'action', label: t('favorites.remove'), danger: true, onClick: () => { void remove(id); } }],
    );
  };

  useEffect(() => () => {
    if (longPressRef.current?.timer) clearTimeout(longPressRef.current.timer);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true;
    for (const item of items) {
      if (urls[item.id]) continue;
      void urlFor(item.id).then((url) => {
        if (active && url) setUrls((current) => ({ ...current, [item.id]: url }));
      });
    }
    return () => { active = false; };
  }, [items, urlFor, urls]);

  if (loaded && items.length === 0) {
    return <div className="flex h-full min-h-[180px] items-center justify-center px-6 text-center text-sm text-txt-tertiary">{t('favorites.empty')}</div>;
  }

  return (
    <div data-backspace-favorite-picker="true" className={`overflow-y-auto p-2 ${mobile ? 'grid w-full grid-cols-4 gap-2' : 'grid w-full grid-cols-5 gap-2'}`}>
      {items.map((item) => (
        <div
          key={item.id}
          className="relative aspect-square min-w-0"
          data-context-menu
          onTouchStart={mobile ? (event) => {
            cancelLongPress();
            const touch = event.touches[0];
            if (!touch || event.touches.length !== 1) return;
            suppressClickRef.current = null;
            const x = touch.clientX;
            const y = touch.clientY;
            longPressRef.current = {
              x, y,
              timer: setTimeout(() => {
                suppressClickRef.current = item.id;
                showRemove(item.id, x, y);
              }, 500),
            };
            event.stopPropagation();
          } : undefined}
          onTouchMove={mobile ? (event) => {
            const press = longPressRef.current;
            const touch = event.touches[0];
            if (press && touch && Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 10) cancelLongPress();
          } : undefined}
          onTouchEnd={mobile ? (event) => {
            if (suppressClickRef.current === item.id) event.preventDefault();
            cancelLongPress();
          } : undefined}
          onTouchCancel={mobile ? cancelLongPress : undefined}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            showRemove(item.id, event.clientX, event.clientY);
          }}
        >
          <button
            type="button"
            className="h-full w-full overflow-hidden rounded-lg bg-interactive-hover hover:bg-interactive-selected"
            title={item.name}
            onClick={() => {
              if (suppressClickRef.current === item.id) {
                suppressClickRef.current = null;
                return;
              }
              const url = urls[item.id];
              if (!url) return;
              void fetch(url).then((response) => response.blob()).then((blob) => {
                onSelect(new File([blob], item.name, { type: item.mime }));
              });
            }}
          >
            {urls[item.id] && <img src={urls[item.id]} alt={item.name} className="h-full w-full object-contain" draggable={false} />}
          </button>
        </div>
      ))}
    </div>
  );
}
