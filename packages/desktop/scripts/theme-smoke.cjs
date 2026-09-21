// Run after build:ts with Electron, never with the installed user's profile.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { ThemeManager, registerThemeStyles } = require('../dist/theme');

const desktop = path.resolve(__dirname, '..');
const output = path.join(desktop, 'dist-electron', 'theme-qa');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
app.commandLine.appendSwitch('disable-background-networking');
const results = [];
let win;
let server;
let manager;
let cleanup;

const fixture = `<!doctype html><html data-theme="aether-drift"><head>
<meta charset="utf-8"><style>
:root { --bg-base:11 11 16; --text-message:216 216 222; --bg-elevated:37 37 48; }
body { background:rgb(var(--bg-base)); color:rgb(var(--text-message)); font:16px sans-serif; margin:32px; }
.row { display:flex; gap:24px; align-items:start; }
pre { padding:16px; } .glass-modal { padding:20px; background:rgb(var(--bg-elevated)); }
img { width:80px; height:80px; } iframe { width:160px; height:100px; }
.emoji-picker-wrapper em-emoji-picker {
 --em-rgb-background:20,20,26; --em-rgb-input:17,17,24; --em-rgb-color:216,216,222;
 --em-color-border:rgba(255,255,255,.07); --em-color-border-over:rgba(255,255,255,.12);
}
</style></head><body>
<h1>Backspace theme fixture</h1>
<p id="msg-fixture"><span class="font-semibold" style="color: rgb(216, 216, 222);">Default name</span>
<span id="role" style="color:rgb(200,50,180)">Custom role color</span></p>
<div class="row"><div><div class="glass-modal">Dialog <input placeholder="Message"></div>
<pre class="font-mono"><span class="token keyword" style="color:rgb(198,120,221)">const</span>
<span class="token string" style="color:rgb(152,195,121)">"hello"</span></pre>
<img id="media" alt="Color sample"><video id="video"></video>
<iframe src="/frame"></iframe></div><div class="emoji-picker-wrapper"></div></div>
<script src="/emoji.js"></script><script>
window.loadMarker = Math.random();
window.firstFrame = null;
requestAnimationFrame(() => {
  window.firstFrame = { background: getComputedStyle(document.body).backgroundColor,
    dark: matchMedia('(prefers-color-scheme: dark)').matches };
});
const canvas = document.createElement('canvas'); canvas.width=80; canvas.height=80;
const ctx=canvas.getContext('2d'); ctx.fillStyle='#e33366';ctx.fillRect(0,0,40,80);
ctx.fillStyle='#33aa77';ctx.fillRect(40,0,40,80);document.querySelector('#media').src=canvas.toDataURL();
fetch('/emoji.json').then(r=>r.json()).then(data=>{
 document.querySelector('.emoji-picker-wrapper').appendChild(new EmojiMart.Picker({
  data, theme:'dark', set:'native', previewPosition:'none', perLine:8
 }));
});
</script></body></html>`;

async function inspect() {
  return win.webContents.executeJavaScript(`({
    background:getComputedStyle(document.body).backgroundColor,
    text:getComputedStyle(document.body).color,
    dark:matchMedia('(prefers-color-scheme: dark)').matches,
    marker:window.loadMarker,
    firstFrame:window.firstFrame,
    language:localStorage.getItem('backspace-language'),
    keyword:document.querySelector('.token.keyword') && getComputedStyle(document.querySelector('.token.keyword')).color,
    nameBacking:document.querySelector('#msg-fixture .font-semibold') &&
      getComputedStyle(document.querySelector('#msg-fixture .font-semibold')).backgroundColor,
    role:document.querySelector('#role') && getComputedStyle(document.querySelector('#role')).color,
    media:document.querySelector('#media') && getComputedStyle(document.querySelector('#media')).filter,
    video:document.querySelector('#video') && getComputedStyle(document.querySelector('#video')).filter,
    child:document.querySelector('iframe') && getComputedStyle(document.querySelector('iframe').contentDocument.body).backgroundColor,
    emoji:document.querySelector('em-emoji-picker')?.shadowRoot?.querySelector('section') &&
      getComputedStyle(document.querySelector('em-emoji-picker').shadowRoot.querySelector('section')).backgroundColor
  })`);
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

async function snapshot(name) {
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const samples = await win.webContents.executeJavaScript(`(() => {
    const samples = [{x:10,y:50,color:getComputedStyle(document.body).backgroundColor}];
    const picker = document.querySelector('em-emoji-picker');
    if (picker?.shadowRoot?.querySelector('section')) {
      const rect=picker.getBoundingClientRect();
      samples.push({x:Math.round(rect.left+4),y:Math.round(rect.top+30),
        color:getComputedStyle(picker.shadowRoot.querySelector('section')).backgroundColor});
    }
    return samples;
  })()`);
  let image;
  await waitFor(async () => {
    win.webContents.invalidate();
    image = await win.webContents.capturePage();
    if (image.isEmpty()) return false;
    return samples.every(({ x, y, color }) => {
      const expected = color.match(/\d+/g)?.map(Number);
      const pixel = image.crop({ x, y, width: 1, height: 1 }).toBitmap();
      return expected && pixel[0] === expected[2] && pixel[1] === expected[1] && pixel[2] === expected[0];
    });
  }, `painted pixels for ${name}`);
  assert(!image.isEmpty(), 'Screenshot must not be empty');
  const bitmap = image.toBitmap();
  assert(bitmap.some((byte, i) => i % 4 !== 3 && byte !== bitmap[i % 4]), 'Screenshot must not be blank');
  fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG());
}

app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32');
  const emojiReact = require.resolve('@emoji-mart/react', { paths: [path.join(desktop, '../web')] });
  const emojiMain = require.resolve('emoji-mart', { paths: [path.dirname(emojiReact)] });
  const emojiData = require.resolve('@emoji-mart/data', { paths: [path.join(desktop, '../web')] });
  server = http.createServer((req, res) => {
    if (req.url === '/emoji.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(fs.readFileSync(path.join(path.dirname(emojiMain), 'browser.js')));
    } else if (req.url === '/emoji.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(fs.readFileSync(emojiData));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.url === '/frame'
        ? '<html data-theme="aether-drift"><body style="background:rgb(20,30,40);color:white">Unstyled frame</body></html>'
        : req.url === '/third-party' ? fixture.replace('data-theme="aether-drift"', '') : fixture);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const picker = path.join(desktop, 'resources/instance-picker.html');
  const recovery = path.join(desktop, 'resources/recovery.html');
  const config = path.join(app.getPath('userData'), 'theme.json');
  manager = new ThemeManager(nativeTheme, config);
  manager.setMode('light');
  cleanup = registerThemeStyles(ipcMain, () => win, fs.readFileSync(path.join(desktop, 'resources/theme.css'), 'utf8'),
    new Set([pathToFileURL(picker).href, pathToFileURL(recovery).href]));
  ipcMain.handle('get-app-version', () => '1.3.1');
  ipcMain.handle('get-instance-url', () => null);
  ipcMain.handle('get-recovery-state', () => ({
    reason: { code: 'load-failed', detail: 'test fixture' },
    updateState: 'idle', updatesEnabled: false,
  }));
  win = new BrowserWindow({
    width: 1200, height: 820, show: false, backgroundColor: '#f3f4f6',
    webPreferences: {
      preload: path.join(desktop, 'dist/preload.js'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, offscreen: true,
      additionalArguments: ['--backspace-default-language=zh'],
    },
  });
  win.webContents.on('preload-error', (_event, _file, error) => { throw error; });
  await win.loadURL(url);
  await waitFor(async () => (await inspect()).emoji, 'Emoji Mart render');
  const light = await inspect();
  assert.equal(light.background, 'rgb(243, 244, 246)');
  assert.equal(light.keyword, 'rgb(117, 66, 143)');
  assert.equal(light.nameBacking, 'rgb(52, 52, 62)');
  assert.equal(light.role, 'rgb(200, 50, 180)');
  assert.equal(light.media, 'none');
  assert.equal(light.video, 'none');
  assert.equal(light.child, 'rgb(20, 30, 40)');
  assert.equal(light.emoji, 'rgb(255, 255, 255)');
  assert.equal(light.language, 'zh');
  assert.equal(light.firstFrame.background, light.background);
  await snapshot('fixture-light');
  await win.webContents.executeJavaScript(`localStorage.setItem('theme-smoke-session', 'preserved')`);
  manager.setMode('dark');
  await waitFor(async () => (await inspect()).dark, 'live dark switch');
  const dark = await inspect();
  assert.equal(dark.background, 'rgb(11, 11, 16)');
  assert.equal(dark.marker, light.marker);
  assert.equal(dark.role, light.role);
  assert.equal(dark.media, light.media);
  assert.equal(await win.webContents.executeJavaScript(`localStorage.getItem('theme-smoke-session')`), 'preserved');
  await snapshot('fixture-dark');
  manager.dispose();
  manager = new ThemeManager(nativeTheme, config);
  assert.equal(manager.getMode(), 'dark');
  manager.setMode('light');
  await new Promise(resolve => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.reload();
  });
  await waitFor(async () => (await inspect()).firstFrame, 'refreshed first frame');
  assert.equal((await inspect()).firstFrame.background, light.background);
  assert.equal(await win.webContents.executeJavaScript(`localStorage.getItem('theme-smoke-session')`), 'preserved');
  await win.loadURL(`${url}third-party`);
  assert.equal((await inspect()).background, 'rgb(11, 11, 16)', 'Unidentified page must not be styled');
  results.push('Fixture: early paint, live switch without reload, persistence, real Emoji Mart, Prism, media and frame scoping passed');

  for (const [name, file] of [['picker', picker], ['recovery', recovery]]) {
    for (const mode of ['light', 'dark']) {
      manager.setMode(mode);
      await win.loadFile(file, { query: { lang: 'zh' } });
      const style = await inspect();
      const expectedDark = name === 'recovery' ? 'rgb(19, 19, 26)' : 'rgb(11, 11, 16)';
      assert.equal(style.background, mode === 'light' ? 'rgb(243, 244, 246)' : expectedDark);
      await snapshot(`${name}-${mode}`);
    }
  }
  results.push('Bundled Chinese picker and recovery: light/dark rendered');
  // Chromium media emulation is confined to this disposable renderer, not OS settings.
  manager.setMode('light');
  await win.loadURL(url);
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  const highContrast = await win.webContents.executeJavaScript(`({
    forced:matchMedia('(forced-colors: active)').matches,
    token:getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()
  })`);
  assert.equal(highContrast.forced, true);
  assert.equal(highContrast.token, '11 11 16', 'Custom light tokens must be disabled in high contrast');
  win.webContents.debugger.detach();
  results.push('Forced colors: custom theme tokens disabled');

  if (process.argv.includes('--online')) {
    for (const mode of ['light', 'dark']) {
      manager.setMode(mode);
      await win.loadURL('https://chat.kevz.me:2096');
      await waitFor(() => win.webContents.executeJavaScript(`!!document.querySelector('input[type="password"]')`), 'public login page');
      const state = await inspect();
      assert.equal(state.background, mode === 'light' ? 'rgb(243, 244, 246)' : 'rgb(11, 11, 16)');
      await snapshot(`login-${mode}`);
    }
    results.push('Public online login page: light/dark loaded without signing in');
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(results.join('\n'));
  cleanup();
  manager.dispose();
  win.destroy();
  server.close();
  app.exit(0);
}).catch(error => {
  console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  if (server) server.close();
  app.exit(1);
});
