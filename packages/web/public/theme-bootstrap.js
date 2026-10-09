(() => {
  try {
    if (window.backspace || window.Capacitor?.getPlatform?.() === 'android') return;
    const saved = window.localStorage.getItem('backspace-theme');
    const mode = ['system', 'light', 'dark'].includes(saved) ? saved : 'system';
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = mode === 'system' ? (dark ? 'dark' : 'light') : mode;
    document.documentElement.dataset.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f4f6' : '#0b0b10');
    document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content', theme === 'light' ? 'default' : 'black');
  } catch { /* Theme bootstrap must never prevent the app from loading. */ }
})();
