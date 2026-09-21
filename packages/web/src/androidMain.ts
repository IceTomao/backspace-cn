import { androidCall, onAndroid, setAndroidServer, type AndroidPreferences } from './platform/android';
import { appStorage, hydrateAppStorage } from './platform/appStorage';
import desktopTheme from '../../desktop/resources/theme.css?raw';

const themeStyle = document.createElement('style');
function applyTheme(settings: AndroidPreferences): void {
  document.documentElement.dataset.androidTheme = settings.dark ? 'dark' : 'light';
  themeStyle.textContent = desktopTheme
    .replace('@media (prefers-color-scheme: dark)', settings.dark ? '@media all' : '@media not all')
    .replace('@media (prefers-color-scheme: light)', settings.dark ? '@media not all' : '@media all');
}
async function boot(): Promise<void> {
  const state = await androidCall<{ settings: AndroidPreferences; storage: Record<string, string> }>('bootstrap');
  setAndroidServer(state.settings.server);
  hydrateAppStorage(state.storage);
  if (!appStorage.getItem('backspace-language')) appStorage.setItem('backspace-language', 'zh');
  // Only this fixed, bundled stylesheet is toggled. No arbitrary CSS crosses
  // the native bridge, and the renderer is never refreshed for a theme change.
  document.head.append(themeStyle);
  applyTheme(state.settings);
  onAndroid<AndroidPreferences>('preferences', applyTheme);
  await import('./main');
}
void boot().catch(() => {
  const root = document.getElementById('root');
  if (!root) return;
  const title = document.createElement('h1');
  title.textContent = '无法加载本地设置';
  const button = document.createElement('button');
  button.textContent = '重试';
  button.onclick = () => window.location.reload();
  root.replaceChildren(title, button);
});
