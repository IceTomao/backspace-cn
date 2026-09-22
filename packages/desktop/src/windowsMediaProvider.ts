import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { ActivityProvider, DetectedActivity } from './activityTypes';
import { getMusicApp } from './musicApps';

interface MediaSnapshot {
  source?: string;
  title?: string;
  artist?: string;
  album?: string;
  status?: 'playing' | 'paused' | 'stopped';
}

const PAUSE_GRACE_MS = 120_000;

function helperSourcePath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'windows-media.cs');
  return path.join(__dirname, '..', 'resources', 'windows-media.cs');
}

function compileHelper(): string | null {
  if (process.platform !== 'win32') return null;
  const windows = process.env.WINDIR ?? 'C:\\Windows';
  const framework = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const metadata = path.join(windows, 'System32', 'WinMetadata');
  const source = helperSourcePath();
  const directory = path.join(app.getPath('userData'), 'windows-media-helper');
  const output = path.join(directory, 'windows-media-helper-v2.exe');
  const compiler = path.join(framework, 'csc.exe');
  if (!fs.existsSync(source) || !fs.existsSync(compiler)
    || !fs.existsSync(path.join(metadata, 'Windows.Foundation.winmd'))
    || !fs.existsSync(path.join(metadata, 'Windows.Media.winmd'))) return null;
  if (fs.existsSync(output)) return output;
  try {
    fs.mkdirSync(directory, { recursive: true });
    execFileSync(compiler, [
      '/nologo', '/target:exe', `/out:${output}`,
      `/r:${path.join(framework, 'System.Runtime.dll')}`,
      `/r:${path.join(framework, 'System.Runtime.WindowsRuntime.dll')}`,
      `/r:${path.join(metadata, 'Windows.Foundation.winmd')}`,
      `/r:${path.join(metadata, 'Windows.Media.winmd')}`,
      source,
    ], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
    return fs.existsSync(output) ? output : null;
  } catch {
    return null;
  }
}

/**
 * Listens to the Windows System Media Transport Controls through a bundled
 * helper. The helper publishes metadata only; it cannot control any player.
 */
export class WindowsMediaProvider implements ActivityProvider {
  private child: ChildProcessWithoutNullStreams | null = null;
  private activity: DetectedActivity | null = null;
  private pausedAt: number | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelay = 1_000;
  private stopped = false;
  private buffer = '';
  private onChange: (() => void) | null = null;

  start(onChange: () => void): void {
    if (process.platform !== 'win32' || this.child || this.stopped === false && this.onChange) return;
    this.stopped = false;
    this.onChange = onChange;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    this.onChange = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
    this.activity = null;
    this.pausedAt = null;
  }

  getActivities(): DetectedActivity[] { return this.activity ? [this.activity] : []; }

  private launch(): void {
    if (this.stopped || process.platform !== 'win32') return;
    const helper = compileHelper();
    if (!helper) return;
    this.child = spawn(helper, [], { windowsHide: true });
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk.toString('utf8')));
    this.child.on('error', () => this.scheduleRestart());
    this.child.on('exit', () => { this.child = null; this.scheduleRestart(); });
    this.restartDelay = 1_000;
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 60_000);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.launch(); }, delay);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { this.apply(JSON.parse(line) as MediaSnapshot); } catch { /* helper diagnostics are ignored */ }
    }
  }

  private apply(snapshot: MediaSnapshot): void {
    const player = getMusicApp(snapshot.source);
    if (!player || !snapshot.title) { this.clear(); return; }
    if (snapshot.status === 'stopped') { this.clear(); return; }

    const state = [snapshot.artist, snapshot.album].filter(Boolean).join(' · ');
    if (snapshot.status === 'paused') {
      if (!this.pausedAt) this.pausedAt = Date.now();
      if (Date.now() - this.pausedAt >= PAUSE_GRACE_MS) { this.clear(); return; }
    } else {
      this.pausedAt = null;
    }

    const next: DetectedActivity = {
      source: 'music', type: 'listening', name: player.name,
      details: snapshot.title,
      state: snapshot.status === 'paused' ? [state, '已暂停'].filter(Boolean).join(' · ') : state || undefined,
      assets: { largeImage: player.iconUrl, largeText: player.name },
    };
    if (JSON.stringify(next) === JSON.stringify(this.activity)) return;
    this.activity = next;
    this.onChange?.();

    if (this.pausedAt) {
      setTimeout(() => {
        if (this.pausedAt && Date.now() - this.pausedAt >= PAUSE_GRACE_MS) this.clear();
      }, PAUSE_GRACE_MS + 50);
    }
  }

  private clear(): void {
    this.pausedAt = null;
    if (!this.activity) return;
    this.activity = null;
    this.onChange?.();
  }
}
