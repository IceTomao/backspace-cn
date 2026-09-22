/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { ipcRenderer, webFrame } from 'electron';
import { createElement, Heart, Plus, Trash2 } from 'lucide';
import type { FavoriteImage } from './favoriteImages';

type Reply = {
  ok: boolean; error?: string; session?: string | null; items?: FavoriteImage[];
  item?: FavoriteImage; bytes?: Uint8Array; canceled?: boolean;
  added?: number; duplicates?: number; failures?: string[];
};
interface PickerView {
  picker: HTMLElement;
  panel: HTMLDivElement;
  grid: HTMLDivElement;
  heart: HTMLButtonElement;
  root: HTMLElement;
  scroll: HTMLElement;
  search: HTMLElement | null;
  navigation: HTMLElement | null;
  navigationClick: (event: Event) => void;
  emojiIndex: number;
  observer: MutationObserver;
  resize: ResizeObserver;
  images: IntersectionObserver;
  urls: Map<Element, string>;
  generation: number;
}

export function startDesktopFavorites(): void {
  if (process.platform !== 'win32' || !process.isMainFrame ||
      !['https:', 'http:'].includes(location.protocol)) return;
  const assets: unknown = ipcRenderer.sendSync('desktop-favorites-bootstrap');
  if (!assets || typeof assets !== 'object' || !('script' in assets) || typeof assets.script !== 'string' ||
      !('styles' in assets) || typeof assets.styles !== 'string') return;
  const favoriteStyles = assets.styles;
  const emojiPolicy = assets.script;
  webFrame.insertCSS(favoriteStyles, { cssOrigin: 'user' });
  void webFrame.executeJavaScript(emojiPolicy).catch(() => {
    console.warn('[favorites] Emoji policy unavailable; the original picker is unchanged.');
  });
  const views = new Map<HTMLElement, PickerView>();
  let token: string | null | undefined;
  let session: string | null = null;
  let sessionPending: Promise<string> | null = null;
  let epoch = 0;
  let stopped = false;
  let frame = 0;
  let noticeTimer = 0;
  let removeMenu: HTMLElement | null = null;
  let candidate: { url: string; epoch: number; at: number; image: HTMLImageElement } | null = null;
  const notice = document.createElement('div');
  notice.dataset.desktopFavorites = '';
  notice.className = 'desktop-favorites-notice';
  notice.setAttribute('role', 'status');

  const readToken = () => {
    try { return localStorage.getItem('backspace_token'); } catch { return null; }
  };
  const notify = (message: string) => {
    if (stopped) return;
    notice.textContent = message;
    document.body.append(notice);
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => notice.remove(), 7000);
  };
  const clearImages = (view: PickerView) => {
    view.generation++;
    view.images.disconnect();
    for (const url of view.urls.values()) URL.revokeObjectURL(url);
    view.urls.clear();
    view.grid.replaceChildren();
  };
  const closeRemove = () => { removeMenu?.remove(); removeMenu = null; };
  const showEmoji = (view: PickerView) => {
    view.panel.hidden = true;
    view.scroll.hidden = false;
    if (view.search) view.search.hidden = false;
    view.heart.removeAttribute('aria-selected');
    const nativeButtons = view.navigation
      ? [...view.navigation.querySelectorAll<HTMLButtonElement>(':scope > button')].filter((item) => item !== view.heart)
      : [];
    nativeButtons[view.emojiIndex]?.setAttribute('aria-selected', 'true');
    clearImages(view);
    closeRemove();
    window.requestAnimationFrame(() => updateNavigation(view));
  };
  const syncAccount = () => {
    const next = readToken();
    if (next === token) return;
    token = next;
    epoch++;
    session = null;
    sessionPending = null;
    candidate = null;
    notice.remove();
    closeRemove();
    for (const view of views.values()) showEmoji(view);
    document.querySelectorAll('[data-desktop-add-expression]').forEach((node) => node.remove());
    void ipcRenderer.invoke('desktop-favorite-images', { action: 'session', token: null }).catch(() => {});
  };
  const ensureSession = async (): Promise<string> => {
    syncAccount();
    if (!token) throw new Error('请先登录');
    if (session) return session;
    if (sessionPending) return sessionPending;
    const generation = epoch;
    sessionPending = (async () => {
      const result: Reply = await ipcRenderer.invoke('desktop-favorite-images', { action: 'session', token });
      if (stopped || generation !== epoch || readToken() !== token) throw new Error('账号已切换，操作已取消');
      if (!result.ok || !result.session) throw new Error(result.error || '无法读取当前账号');
      session = result.session;
      return session;
    })();
    try { return await sessionPending; } finally { if (generation === epoch) sessionPending = null; }
  };
  const request = async (action: string, extra: Record<string, unknown> = {}): Promise<Reply> => {
    const id = await ensureSession();
    const generation = epoch;
    const result: Reply = await ipcRenderer.invoke('desktop-favorite-images', { action, session: id, ...extra });
    syncAccount();
    if (stopped || generation !== epoch) throw new Error('账号已切换，操作已取消');
    if (!result.ok) throw new Error(result.error || '收藏操作失败');
    return result;
  };
  const run = (action: () => void | Promise<void>) => {
    const generation = epoch;
    void Promise.resolve().then(() => {
      syncAccount();
      if (generation !== epoch || stopped) return;
      return action();
    }).catch((error: unknown) => {
      syncAccount();
      if (generation === epoch) notify(error instanceof Error ? error.message : '收藏操作失败，请稍后重试');
    });
  };
  const button = (label: string, icon: typeof Heart | null, action: () => void | Promise<void>) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.title = label;
    element.setAttribute('aria-label', label);
    if (icon) {
      const svg = createElement(icon);
      svg.setAttribute('width', '20');
      svg.setAttribute('height', '20');
      svg.setAttribute('aria-hidden', 'true');
      element.append(svg);
    }
    const activate = (event: Event) => {
      if (!event.isTrusted || element.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      run(action);
    };
    element.addEventListener('click', activate);
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });
    return element;
  };
  const resultNotice = (result: Reply) => {
    if (result.canceled) return;
    const messages = [];
    if (result.added) messages.push(`已添加 ${result.added} 张表情`);
    if (result.duplicates) messages.push(`${result.duplicates} 张图片已在收藏中`);
    if (result.failures?.length) messages.push(...result.failures);
    if (messages.length) notify(messages.join('\n'));
  };
  const composer = () => {
    const nodes = [...document.querySelectorAll<HTMLElement>('[data-pip-obstacle="bottom"]')]
      .filter((node) => node.getClientRects().length && node.querySelector('textarea.input-embedded'));
    if (nodes.length !== 1) return null;
    const root = nodes[0]!;
    const files = root.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const text = root.querySelector<HTMLTextAreaElement>('textarea.input-embedded');
    if (files.length !== 1 || !text || text.disabled || text.readOnly) return null;
    const input = files[0]!;
    // The file input remains mounted without attach permission; its preceding
    // attach button does not. Require both before dispatching a native change.
    if (!(input.previousElementSibling instanceof HTMLButtonElement) ||
        input.previousElementSibling.disabled || input.disabled) return null;
    return { root, input, text };
  };
  const stage = async (view: PickerView, item: FavoriteImage) => {
    const target = composer();
    if (!target) throw new Error('当前会话不能添加附件');
    const href = location.href;
    const result = await request('read', { id: item.id });
    if (!view.panel.isConnected || view.panel.hidden || location.href !== href ||
        composer()?.input !== target.input || !result.bytes || !result.item) {
      throw new Error('会话已切换，请重新选择表情');
    }
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(result.bytes)], result.item.name, { type: result.item.mime }));
    target.input.files = transfer.files;
    target.input.dispatchEvent(new Event('change', { bubbles: true }));
    // Close the original popover through its normal outside-click listener.
    target.text.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.text.focus();
  };
  const placeMenu = (menu: HTMLElement, x: number, y: number) => {
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--interface-scale')) || 1;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8)) / scale}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8)) / scale}px`;
  };
  const refreshVisible = async () => {
    for (const view of views.values()) if (!view.panel.hidden) await load(view);
  };
  const showRemove = (view: PickerView, item: FavoriteImage, event: MouseEvent) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    closeRemove();
    const menu = document.createElement('div');
    menu.dataset.desktopFavorites = '';
    menu.className = 'desktop-favorites-remove';
    menu.setAttribute('role', 'menu');
    menu.addEventListener('mousedown', (event) => event.stopPropagation());
    const remove = button('移除收藏', Trash2, async () => {
      const generation = epoch;
      closeRemove();
      await request('remove', { id: item.id });
      if (generation === epoch && view.panel.isConnected) await refreshVisible();
    });
    remove.setAttribute('role', 'menuitem');
    remove.append(document.createTextNode('移除收藏'));
    menu.append(remove);
    document.body.append(menu);
    removeMenu = menu;
    placeMenu(menu, event.clientX, event.clientY);
    remove.focus();
  };
  const load = async (view: PickerView) => {
    clearImages(view);
    const generation = view.generation;
    const add = button('添加表情', Plus, async () => {
      add.disabled = true;
      try {
        const result = await request('import');
        resultNotice(result);
        await refreshVisible();
      } finally { add.disabled = false; }
    });
    add.className = 'desktop-favorites-tile desktop-favorites-add';
    view.grid.append(add);
    const result = await request('list');
    if (!view.panel.isConnected || view.panel.hidden || view.generation !== generation) return;
    for (const item of result.items ?? []) {
      const tile = button(item.name, null, async () => {
        tile.disabled = true;
        try { await stage(view, item); } finally { tile.disabled = false; }
      });
      tile.className = 'desktop-favorites-tile';
      tile.dataset.favoriteId = item.id;
      tile.addEventListener('contextmenu', (event) => showRemove(view, item, event));
      const image = document.createElement('img');
      image.alt = item.name;
      image.draggable = false;
      tile.append(image);
      view.grid.append(tile);
      view.images.observe(tile);
    }
  };
  const updateNavigation = (view: PickerView) => {
    const root = view.picker.shadowRoot?.querySelector<HTMLElement>('#root');
    const scroll = root?.querySelector<HTMLElement>(':scope > .scroll');
    const nav = root?.querySelector<HTMLElement>(':scope > #nav[data-position="bottom"]');
    const nativeTabs = nav?.firstElementChild as HTMLElement | null;
    const bar = nativeTabs?.querySelector<HTMLElement>(':scope > .bar');
    if (!root || !scroll || !nav || !nativeTabs || !bar) return;
    view.root = root;
    view.scroll = scroll;
    view.search = [...root.children]
      .find((item) => item !== scroll && item.querySelector('input[type="search"]')) as HTMLElement | undefined ?? null;
    if (view.panel.parentElement !== root) root.insertBefore(view.panel, nav);
    if (view.navigation !== nativeTabs) {
      view.navigation?.removeEventListener('click', view.navigationClick);
      view.navigation = nativeTabs;
      nativeTabs.addEventListener('click', view.navigationClick);
    }
    if (view.heart.parentElement !== nativeTabs || view.heart.nextElementSibling !== bar) {
      nativeTabs.insertBefore(view.heart, bar);
    }
    const nativeButtons = [...nativeTabs.querySelectorAll<HTMLButtonElement>(':scope > button')]
      .filter((item) => item !== view.heart);
    if (nativeButtons.length < 2 || nativeButtons.length > 3) return;
    bar.style.setProperty('width', `${100 / (nativeButtons.length + 1)}%`, 'important');
    if (!view.panel.hidden) {
      view.scroll.hidden = true;
      if (view.search) view.search.hidden = true;
      for (const item of nativeButtons) item.removeAttribute('aria-selected');
      view.heart.setAttribute('aria-selected', 'true');
      bar.style.setProperty('opacity', '1', 'important');
      bar.style.setProperty('transform', `translateX(${nativeButtons.length * 100}%)`, 'important');
      return;
    }
    view.heart.removeAttribute('aria-selected');
    const selectedIndex = nativeButtons.findIndex((item) => item.hasAttribute('aria-selected'));
    if (selectedIndex >= 0) view.emojiIndex = selectedIndex;
    bar.style.setProperty('opacity', selectedIndex < 0 ? '0' : '1', 'important');
    if (selectedIndex >= 0) {
      const transform = view.root.dir === 'rtl'
        ? `scaleX(-1) translateX(${selectedIndex * 100}%)`
        : `translateX(${selectedIndex * 100}%)`;
      bar.style.setProperty('transform', transform, 'important');
    }
  };
  const attach = (picker: HTMLElement) => {
    if (views.has(picker) || picker.dataset.backspaceEmojiPolicy !== 'ready') return;
    const floating = picker.closest('.fixed');
    if (!floating || (!floating.classList.contains('z-[300]') && !floating.classList.contains('z-[301]'))) return;
    if (!composer()) return;
    const wrapper = picker.closest<HTMLElement>('.emoji-picker-wrapper');
    const shadow = picker.shadowRoot;
    const root = shadow?.querySelector<HTMLElement>('#root');
    const scroll = root?.querySelector<HTMLElement>(':scope > .scroll');
    const nav = root?.querySelector<HTMLElement>(':scope > #nav[data-position="bottom"]');
    const nativeTabs = nav?.firstElementChild as HTMLElement | null;
    const bar = nativeTabs?.querySelector<HTMLElement>(':scope > .bar');
    const search = root
      ? [...root.children].find((item) => item !== scroll && item.querySelector('input[type="search"]')) as HTMLElement | undefined
      : undefined;
    if (!wrapper || !shadow || !root || !scroll || !nav || !nativeTabs || !bar) return;
    if (!shadow.querySelector('style[data-desktop-favorites-styles]')) {
      const style = document.createElement('style');
      style.dataset.desktopFavoritesStyles = '';
      style.textContent = favoriteStyles;
      shadow.append(style);
    }
    const panel = document.createElement('div');
    panel.dataset.desktopFavorites = '';
    panel.className = 'desktop-favorites-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-label', '我的收藏');
    const heading = document.createElement('h3');
    heading.className = 'desktop-favorites-heading';
    heading.textContent = '我的收藏';
    const grid = document.createElement('div');
    grid.className = 'desktop-favorites-grid';
    panel.append(heading, grid);
    root.insertBefore(panel, nav);
    const view = {} as PickerView;
    const heart = button('我的收藏', Heart, async () => {
      syncAccount();
      scroll.hidden = true;
      if (search) search.hidden = true;
      panel.hidden = false;
      updateNavigation(view);
      await load(view);
    });
    heart.className = 'flex flex-grow flex-center desktop-favorites-heart';
    const navigationClick = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest('button') : null;
      if (target && target !== heart && view.navigation?.contains(target)) {
        const nativeButtons = [...view.navigation.querySelectorAll<HTMLButtonElement>(':scope > button')]
          .filter((item) => item !== heart);
        const selectedIndex = nativeButtons.indexOf(target as HTMLButtonElement);
        if (selectedIndex >= 0) view.emojiIndex = selectedIndex;
        showEmoji(view);
      }
    };
    const observer = new MutationObserver(() => updateNavigation(view));
    const images = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const tile = entry.target as HTMLElement;
        const thumbnailRevision = String(Number(tile.dataset.thumbnailRevision || 0) + 1);
        tile.dataset.thumbnailRevision = thumbnailRevision;
        const oldUrl = view.urls.get(tile);
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        view.urls.delete(tile);
        tile.querySelector('img')?.removeAttribute('src');
        if (!entry.isIntersecting) continue;
        const generation = view.generation;
        run(async () => {
          const result = await request('read', { id: tile.dataset.favoriteId });
          if (generation !== view.generation || !tile.isConnected ||
              tile.dataset.thumbnailRevision !== thumbnailRevision || !result.bytes || !result.item) return;
          const url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.item.mime }));
          view.urls.set(tile, url);
          const image = tile.querySelector('img');
          if (image) image.src = url;
        });
      }
    }, { root: grid, rootMargin: '60px' });
    const resize = new ResizeObserver(() => {
      const available = wrapper.parentElement?.clientHeight;
      if (available && available >= 230) {
        const height = `${Math.min(435, available)}px`;
        if (picker.style.height !== height) picker.style.height = height;
      }
    });
    if (wrapper.parentElement) resize.observe(wrapper.parentElement);
    Object.assign(view, {
      picker, panel, grid, heart, root, scroll, search: search ?? null,
      navigation: null, navigationClick, emojiIndex: 0, observer, resize, images,
      urls: new Map<Element, string>(), generation: 0,
    });
    views.set(picker, view);
    observer.observe(picker.shadowRoot!, { childList: true, subtree: true });
    updateNavigation(view);
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        showEmoji(view);
        heart.focus();
      }
      event.stopPropagation();
    });
  };
  const originalImage = async (image: HTMLImageElement, fallback: string): Promise<string> => {
    // AttachmentRenderer displays a thumbnail but its click action opens the
    // original. Use that existing UI contract, never infer an original filename
    // or inspect React's private fiber objects.
    const attachment = image.classList.contains('max-w-[400px]') &&
      image.classList.contains('object-contain') && image.classList.contains('cursor-pointer');
    if (!attachment) return fallback;
    if (!image.isConnected || image.closest('a, button')) throw new Error('无法确认图片来源');
    const selector = 'div.fixed.inset-x-0.bottom-0:has(> img.object-contain.rounded.shadow-elevation-high)';
    if (document.querySelector(selector)) throw new Error('请先关闭图片预览');
    const generation = epoch;
    const css = await webFrame.insertCSS(`${selector}{visibility:hidden!important;pointer-events:none!important}`, { cssOrigin: 'user' });
    let preview: HTMLElement | null = null;
    try {
      if (generation !== epoch || !image.isConnected) throw new Error('会话已切换，操作已取消');
      return await new Promise<string>((resolve, reject) => {
        const finish = (error?: Error, url?: string) => {
          observer.disconnect();
          clearTimeout(timeout);
          if (error) reject(error); else resolve(url!);
        };
        const check = () => {
          preview = document.querySelector<HTMLElement>(selector);
          if (!preview) return;
          const original = preview.querySelector<HTMLImageElement>(':scope > img')?.src;
          if (generation !== epoch || !/^https?:\/\//i.test(original ?? '')) {
            finish(new Error('无法读取原图'));
          } else {
            finish(undefined, original);
          }
        };
        const observer = new MutationObserver(check);
        const timeout = window.setTimeout(() => finish(new Error('无法读取原图，请重新打开会话后重试')), 1500);
        observer.observe(document.body, { childList: true, subtree: true });
        image.click();
        check();
      });
    } finally {
      const opened = preview as HTMLElement | null;
      opened?.click();
      await webFrame.removeInsertedCSS(css);
    }
  };
  const captureImage = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    syncAccount();
    candidate = null;
    const image = event.target instanceof Element ? event.target.closest('img') : null;
    if (!token || !image || !image.closest('[id^="msg-"]') ||
        image.closest('[data-avatar], [data-embed-thumbnail], [data-desktop-favorites], button.group\\/vid')) return;
    const source = image.currentSrc || image.src;
    if (!/^https?:\/\//i.test(source)) return;
    candidate = { url: source, image, epoch, at: Date.now() };
    schedule();
  };
  const addImageMenu = () => {
    const target = candidate;
    if (!target || epoch !== target.epoch || Date.now() - target.at > 1500 || !target.image.isConnected) return;
    const menus = [...document.querySelectorAll<HTMLElement>('div[tabindex="-1"]')]
      .filter((node) => node.classList.contains('z-[200]') && node.classList.contains('fixed'));
    if (menus.length !== 1) return;
    const menu = menus[0]!;
    if (menu.querySelector('[data-desktop-add-expression]')) return;
    const first = menu.querySelector<HTMLButtonElement>('button');
    // Match the existing save action, not arbitrary context menus.
    if (!first || !['保存图像', '保存图片', 'Save Image', 'Save image', 'Bild speichern', 'Сохранить изображение']
      .includes(first.textContent?.trim() ?? '')) return;
    const add = button('添加到表情', Heart, async () => {
      if (epoch !== target.epoch) throw new Error('账号已切换，操作已取消');
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const url = await originalImage(target.image, target.url);
      syncAccount();
      if (epoch !== target.epoch) throw new Error('账号已切换，操作已取消');
      const result = await request('download', { url });
      resultNotice(result);
      await refreshVisible();
    });
    add.dataset.desktopAddExpression = '';
    add.className = first.className;
    add.style.cssText = first.style.cssText;
    const sourceIcon = first.querySelector('svg');
    const addIcon = add.querySelector('svg');
    if (sourceIcon && addIcon) {
      for (const attribute of ['width', 'height']) {
        const value = sourceIcon.getAttribute(attribute);
        if (value) addIcon.setAttribute(attribute, value);
      }
    }
    add.append(document.createTextNode('添加到表情'));
    menu.prepend(add);
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > innerHeight - 8) placeMenu(menu, rect.left, innerHeight - rect.height - 8);
    candidate = null;
  };
  const scan = () => {
    frame = 0;
    if (stopped) return;
    syncAccount();
    if (document.documentElement.dataset.theme !== 'aether-drift') return;
    for (const [picker, view] of views) {
      if (picker.isConnected) continue;
      clearImages(view);
      view.navigation?.removeEventListener('click', view.navigationClick);
      view.observer.disconnect();
      view.resize.disconnect();
      view.panel.remove();
      views.delete(picker);
    }
    if (token) document.querySelectorAll<HTMLElement>('.emoji-picker-wrapper em-emoji-picker').forEach(attach);
    addImageMenu();
  };
  function schedule() {
    if (!frame && !stopped) frame = window.requestAnimationFrame(scan);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['data-backspace-emoji-policy'],
  });
  const dismissRemove = (event: Event) => {
    if (!(event.target instanceof Node) || !removeMenu?.contains(event.target)) closeRemove();
  };
  const escapeRemove = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRemove(); };
  document.addEventListener('contextmenu', captureImage, true);
  document.addEventListener('mousedown', dismissRemove, true);
  document.addEventListener('keydown', escapeRemove, true);
  window.addEventListener('storage', schedule);
  window.addEventListener('resize', schedule);
  const interval = window.setInterval(syncAccount, 500);
  scan();
  window.addEventListener('pagehide', () => {
    stopped = true;
    epoch++;
    observer.disconnect();
    clearInterval(interval);
    clearTimeout(noticeTimer);
    cancelAnimationFrame(frame);
    closeRemove();
    notice.remove();
    document.removeEventListener('contextmenu', captureImage, true);
    document.removeEventListener('mousedown', dismissRemove, true);
    document.removeEventListener('keydown', escapeRemove, true);
    window.removeEventListener('storage', schedule);
    window.removeEventListener('resize', schedule);
    for (const view of views.values()) {
      clearImages(view);
      view.navigation?.removeEventListener('click', view.navigationClick);
      view.observer.disconnect();
      view.resize.disconnect();
    }
    views.clear();
    void ipcRenderer.invoke('desktop-favorite-images', { action: 'session', token: null }).catch(() => {});
  }, { once: true });
}
