import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseByteRange } from '../packages/server/src/utils/httpRange.ts';

// Real browser decoding with generated fixtures; this does not test Android hardware.
const root = path.resolve(import.meta.dirname, '..');
const web = path.join(root, 'packages/web');
process.chdir(web); // Tailwind's relative config lookup follows the package working directory.
const output = path.join(root, '.cache/video-checks');
const harness = path.join(web, '.cache/video-checks');
mkdirSync(output, { recursive: true }); mkdirSync(harness, { recursive: true });
assert(process.env.FFMPEG_PATH, 'Set FFMPEG_PATH to generate test-only H.264/AAC and HEVC fixtures');
for (const [name, codec] of [['clip.mp4', 'libx264'], ['hevc.mp4', 'libx265']]) {
  execFileSync(process.env.FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '4', '-c:v', codec, '-preset', 'ultrafast', ...(codec === 'libx265' ? ['-x265-params', 'log-level=error', '-tag:v', 'hvc1'] : ['-profile:v', 'baseline']),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(output, name)], { stdio: 'pipe', timeout: 60_000 });
}
writeFileSync(path.join(harness, 'index.html'), '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/.cache/video-checks/main.tsx"></script></body></html>');
writeFileSync(path.join(harness, 'main.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import i18n, { initI18n } from '/src/i18n';
import '/src/styles/globals.css';
import { AttachmentRenderer } from '/src/components/chat/AttachmentRenderer';
await initI18n({ previewLanguage: 'zh' }); await i18n.loadNamespaces('chat');
const items = ['clip', 'second', 'hevc', 'bad'];
createRoot(document.getElementById('root')!).render(<main style={{padding:16,maxWidth:720,margin:'auto'}}>
  <input aria-label="聊天草稿" defaultValue="未发送的草稿" />
  {items.map(name => <AttachmentRenderer key={name} attachment={{id:name,messageId:'fixture',originalName:name+'.MP4',filename:'/fixture/'+name+'.mp4',mimetype:'application/octet-stream',size:1000,playable:false,width:320,height:180,createdAt:1}} />)}
</main>);
`);
const { createServer } = await import(pathToFileURL(path.join(web, 'node_modules/vite/dist/node/index.js')));
const requests = [];
const server = await createServer({ root: web, configFile: path.join(web, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: true }, plugins: [{
  name: 'video-test-fixtures', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/fixture/')) return next();
      requests.push({ url: req.url, range: req.headers.range ?? null });
      const filename = req.url === '/fixture/hevc.mp4' ? 'hevc.mp4' : 'clip.mp4';
      const bytes = req.url === '/fixture/bad.mp4' ? Buffer.from('broken-video') : readFileSync(path.join(output, filename));
      const range = parseByteRange(req.headers.range, bytes.length);
      res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Accept-Ranges', 'bytes');
      if (range === 'unsatisfiable') { res.writeHead(416, { 'Content-Range': 'bytes */' + bytes.length }); return res.end(); }
      const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
      if (range) res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + bytes.length);
      res.setHeader('Content-Length', body.length); res.writeHead(range ? 206 : 200); res.end(body);
    });
  },
}] });
await server.listen();
const port = server.httpServer.address().port;
const { chromium } = process.env.PLAYWRIGHT_MODULE_PATH ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH)) : await import('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const results = [];
  for (const width of [360, 720]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto('http://127.0.0.1:' + port + '/.cache/video-checks/index.html');
    await page.getByRole('button', { name: '播放视频：clip.MP4' }).waitFor();
    const before = requests.length;
    await page.screenshot({ path: path.join(output, 'cards-' + width + '.png'), fullPage: true });
    assert.equal(requests.length, before, 'Cards must not preload video bytes');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow');
    await page.getByRole('button', { name: '播放视频：clip.MP4' }).click();
    await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.2);
    await page.evaluate(() => { document.querySelector('video').currentTime = 2.5; });
    await page.waitForFunction(() => document.querySelector('video')?.currentTime >= 2.5 && !document.querySelector('video').seeking);
    await page.screenshot({ path: path.join(output, 'playing-' + width + '.png'), fullPage: true });
    await page.getByRole('button', { name: '播放视频：second.MP4' }).click();
    await page.waitForFunction(() => document.querySelectorAll('video').length === 1 && document.querySelector('video').src.includes('second'));
    await page.getByRole('button', { name: '播放视频：bad.MP4' }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('button', { name: '下载视频' }).count(), 4);
    await page.getByRole('button', { name: '播放视频：hevc.MP4' }).click();
    await page.waitForFunction(() => document.querySelector('video[src*="hevc"]')?.currentTime > 0.2 || document.querySelectorAll('[role="alert"]').length === 2);
    const hevc = await page.locator('video[src*="hevc"]').count() ? 'decoded' : 'download-fallback';
    assert.equal(await page.getByRole('textbox', { name: '聊天草稿' }).inputValue(), '未发送的草稿');
    results.push({ width, h264Aac: 'played-and-seeked', hevc });
    await page.close();
  }
  writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ realBrowser: true, realAndroidDevice: false, results, requests }, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); await server.close(); }
