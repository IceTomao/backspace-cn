import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// This is a browser-only layout test with a simulated native bridge, not an
// Android device, permission, audio, foreground-service or network acceptance.
const require = createRequire(import.meta.url);
const playwright = process.env.PLAYWRIGHT_MODULE_PATH
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH))
  : require('playwright');
const root = path.resolve(import.meta.dirname, '..');
const web = path.join(root, 'packages/web/dist-android');
const output = path.join(root, '.cache/android-checks');
await fs.mkdir(output, { recursive: true });
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(web, `.${pathname}`);
    if (!file.startsWith(web + path.sep)) throw new Error('path');
    let body;
    let extension = path.extname(file);
    try { body = await fs.readFile(file); }
    catch { body = await fs.readFile(path.join(web, 'index.html')); extension = '.html'; }
    res.setHeader('Content-Type', mime[extension] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [360, 412]) {
    const page = await browser.newPage({ viewport: { width, height: 820 }, locale: 'en-US', isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(base)) return route.continue();
      if (route.request().url().endsWith('/api/instance/info')) return route.fulfill({
        contentType: 'application/json', body: JSON.stringify({ name: 'Backspace', version: '1.3.0', registrationEnabled: true }),
      });
      return route.abort();
    });
    await page.addInitScript(() => {
      const listeners = new Map();
      const stored = {};
      const settings = { server: 'https://chat.kevz.me:2096', theme: 'system', dark: false, background: false };
      window.androidBridge = {};
      window.__theme = dark => {
        settings.dark = dark;
        for (const entry of listeners.values()) if (entry.event === 'preferences') entry.callback({ ...settings });
      };
      window.Capacitor = {
        PluginHeaders: [{
          name: 'BackspaceNative', methods: [
            { name: 'execute', rtype: 'promise' }, { name: 'addListener', rtype: 'callback' },
            { name: 'removeListener', rtype: 'promise' },
          ],
        }],
        nativeCallback(_plugin, _method, options, callback) {
          const id = String(Math.random());
          listeners.set(id, { event: options.eventName, callback });
          return id;
        },
        async nativePromise(_plugin, method, options) {
          if (method === 'removeListener') { listeners.delete(options.callbackId); return {}; }
          const { action, data } = options;
          if (action === 'bootstrap') return { settings, storage: stored };
          if (action === 'preferences') return settings;
          if (action === 'storage') { stored[data.key] = data.value; return {}; }
          return {};
        },
      };
    });
    await page.goto(`${base}/login`);
    await page.getByRole('button', { name: '登录', exact: true }).waitFor();
    await page.getByText('服务器设置', { exact: true }).click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => window.__theme(dark), theme === 'dark');
      await page.waitForFunction(theme => document.documentElement.dataset.androidTheme === theme, theme);
      await page.waitForFunction(color => getComputedStyle(document.body).backgroundColor === color,
        theme === 'light' ? 'rgb(243, 244, 246)' : 'rgb(11, 11, 16)');
      await page.waitForFunction(color => getComputedStyle(document.querySelector('input[type="url"]')).backgroundColor === color,
        theme === 'light' ? 'rgb(245, 246, 248)' : 'rgb(17, 17, 24)');
      const measurements = await page.evaluate(() => ({
        language: document.documentElement.lang,
        background: getComputedStyle(document.body).backgroundColor,
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
        workers: 'serviceWorker' in navigator ? navigator.serviceWorker.controller !== null : false,
      }));
      assert.equal(measurements.language, 'zh');
      assert(measurements.width <= measurements.viewport, 'Horizontal overflow');
      assert(!measurements.workers, 'Unexpected service worker');
      assert.equal(measurements.background, theme === 'light' ? 'rgb(243, 244, 246)' : 'rgb(11, 11, 16)');
      await page.screenshot({ path: path.join(output, `login-${theme}-${width}.png`), fullPage: true });
      results.push({ width, theme, ...measurements });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  await fs.writeFile(path.join(output, 'ui-smoke.json'), JSON.stringify({ simulatedNativeBridge: true, results }, null, 2));
  console.log(`Mocked Android UI: ${results.length} viewport/theme checks passed; no real accounts or messages used.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
