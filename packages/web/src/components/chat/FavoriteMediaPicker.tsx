import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFavoriteMediaStore } from '../../stores/favoriteMediaStore';
import { X } from 'lucide-react';

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
        <div key={item.id} className="group relative aspect-square min-w-0">
          <button
            type="button"
            className="h-full w-full overflow-hidden rounded-lg bg-interactive-hover hover:bg-interactive-selected"
            title={item.name}
            onClick={() => {
              const url = urls[item.id];
              if (!url) return;
              void fetch(url).then((response) => response.blob()).then((blob) => {
                onSelect(new File([blob], item.name, { type: item.mime }));
              });
            }}
          >
            {urls[item.id] && <img src={urls[item.id]} alt={item.name} className="h-full w-full object-contain" draggable={false} />}
          </button>
          <button
            type="button"
            aria-label={t('favorites.remove')}
            title={t('favorites.remove')}
            className={`absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded bg-black/70 text-white hover:bg-black ${mobile ? '' : 'desktop:hidden desktop:group-hover:flex'}`}
            onClick={(event) => { event.stopPropagation(); void remove(item.id); }}
          ><X className="h-4 w-4" /></button>
        </div>
      ))}
    </div>
  );
}
