import { androidCall, onAndroid, setAndroidServer, type AndroidPreferences } from './platform/android';
import { appStorage, hydrateAppStorage } from './platform/appStorage';
import desktopTheme from '../../desktop/resources/theme.css?raw';

interface AndroidInsets { top: number; right: number; bottom: number; left: number }

function applyInsets(insets: AndroidInsets): void {
  const root = document.documentElement;
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    root.style.setProperty(`--safe-${side}`, `calc(${insets[side]}px / var(--interface-scale))`);
  }
}

const themeStyle = document.createElement('style');
function applyTheme(settings: AndroidPreferences): void {
  document.documentElement.dataset.androidTheme = settings.dark ? 'dark' : 'light';
  document.documentElement.dataset.colorScheme = settings.dark ? 'dark' : 'light';
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    'content', settings.dark ? '#0b0b10' : '#f4f4f6',
  );
  themeStyle.textContent = desktopTheme;
}
async function boot(): Promise<void> {
  const state = await androidCall<{ settings: AndroidPreferences; storage: Record<string, string>; insets: AndroidInsets }>('bootstrap');
  document.documentElement.dataset.platform = 'android';
  applyInsets(state.insets);
  onAndroid<AndroidInsets>('insets', applyInsets);
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
