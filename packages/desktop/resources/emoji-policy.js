// Fixed desktop-owned adapter for the shipped Emoji Mart 5.x element.
// Runs in the page world solely to use the element's update API, never Node/IPC.
(() => {
  if (window.__backspaceEmojiPolicy) return;
  window.__backspaceEmojiPolicy = true;
  const categories = ['frequent', 'people', 'nature'];
  const installed = new WeakSet();
  let timer = 0;
  let stopped = false;
  let retries = 0;
  const install = (picker) => {
    if (installed.has(picker)) return true;
    const data = picker.props?.data;
    if (!picker.component || typeof picker.update !== 'function' ||
        !data?.emojis || !Array.isArray(data.originalCategories)) return false;
    const allowed = new Set(data.originalCategories
      .filter((category) => category.id === 'people' || category.id === 'nature')
      .flatMap((category) => category.emojis));
    if (!allowed.size) return false;
    const exceptEmojis = Object.keys(data.emojis).filter((id) => !allowed.has(id));
    // SearchIndex caches emoji objects, so clear search strings on those same
    // objects as well as excluding them from the frequent/category grids.
    for (const id of exceptEmojis) data.emojis[id].search = '';
    data.originalCategories = data.originalCategories.filter((category) => categories.includes(category.id));
    const originalUpdate = picker.update.bind(picker);
    picker.update = (props = {}) => originalUpdate({ ...props, exceptEmojis, categories });
    picker.props.categories = categories;
    picker.props.exceptEmojis = exceptEmojis;
    picker.update({ categories, exceptEmojis });
    installed.add(picker);
    picker.dataset.backspaceEmojiPolicy = 'ready';
    return true;
  };
  const scan = () => {
    timer = 0;
    if (stopped || document.documentElement.dataset.theme !== 'aether-drift') return;
    let pending = false;
    for (const picker of document.querySelectorAll('.emoji-picker-wrapper em-emoji-picker')) {
      if (!install(picker)) pending = true;
    }
    if (pending && retries++ < 100) timer = setTimeout(scan, 50);
  };
  const observer = new MutationObserver(() => {
    retries = 0;
    if (!timer) timer = setTimeout(scan, 0);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(timer);
    observer.disconnect();
  }, { once: true });
})();
