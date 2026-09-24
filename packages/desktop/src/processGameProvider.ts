import { execFile } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { app, nativeImage } from 'electron';
import type { ActivityProvider, DesktopActivity, DetectedActivity } from './activityTypes';
import type { ActivityAssetPublisher } from './activityAssetPublisher';
import { discoverInstalledGames, isPathInside, type InstalledGame } from './gameCatalog';
import { WindowsProcessScanner, type ProcessSnapshot, type RunningProcess } from './windowsProcessScanner';

export interface GameEntry {
  id: string;
  name: string;
  processes: string[];
  type?: DesktopActivity['type'];
  iconUrl?: string;
  platformIds?: Partial<Record<'steam' | 'epic' | 'gog' | 'xbox', string>>;
}

const VALID_TYPES = new Set<DesktopActivity['type']>(['playing', 'listening', 'watching', 'streaming']);
const POLL_INTERVAL_MS = 3_000;
const CATALOG_REFRESH_MS = 10 * 60_000;
const REMOTE_URL = 'https://raw.githubusercontent.com/IceTomao/backspace-cn/master/packages/desktop/resources/games.json';
const NON_GAME_PROCESS = /(?:launcher|crash(?:pad|report)?|unins|uninstall|setup|easyanticheat|battleye|redist|redistributable|helper|dedicated.?server)/i;

export function parseGameEntry(input: unknown): GameEntry | null {
  if (!input || typeof input !== 'object') return null;
  const entry = input as Record<string, unknown>;
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string' || !Array.isArray(entry.processes)
    || !entry.processes.every((value) => typeof value === 'string')) return null;
  const type = typeof entry.type === 'string' && VALID_TYPES.has(entry.type as DesktopActivity['type'])
    ? entry.type as DesktopActivity['type'] : 'playing';
  const iconUrl = typeof entry.iconUrl === 'string' && /^https:\/\//.test(entry.iconUrl) ? entry.iconUrl : undefined;
  const platformIds = entry.platformIds && typeof entry.platformIds === 'object'
    ? Object.fromEntries(Object.entries(entry.platformIds).filter(([key, value]) =>
      ['steam', 'epic', 'gog', 'xbox'].includes(key) && typeof value === 'string')) as GameEntry['platformIds']
    : undefined;
  return { id: entry.id, name: entry.name, processes: entry.processes as string[], type, iconUrl, platformIds };
}

export function parseGameDictionary(raw: string): { version: number; entries: GameEntry[] } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const values = Array.isArray(parsed) ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { games?: unknown }).games)
        ? (parsed as { games: unknown[] }).games : null;
    if (!values) return null;
    const entries = values.flatMap((item) => {
      const entry = parseGameEntry(item);
      return entry ? [entry] : [];
    });
    return entries.length ? {
      version: Array.isArray(parsed) ? 0 : Number((parsed as { version?: number }).version) || 0,
      entries,
    } : null;
  } catch { return null; }
}

interface GameCandidate {
  identity: string;
  name: string;
  type: DesktopActivity['type'];
  processes: RunningProcess[];
  iconUrl?: string;
  iconPath?: string;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, '');
}

function processCommand(): { executable: string; args: string[] } {
  if (process.platform === 'win32') return { executable: 'tasklist', args: ['/fo', 'csv', '/nh'] };
  if (process.platform === 'darwin') return { executable: 'ps', args: ['-c', '-A', '-o', 'comm'] };
  return { executable: 'ps', args: ['-A', '-o', 'comm'] };
}

export class ProcessGameProvider implements ActivityProvider {
  private entries: GameEntry[] = [];
  private installedGames: InstalledGame[] = [];
  private scanner: WindowsProcessScanner | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private catalogTimer: NodeJS.Timeout | null = null;
  private helperWatchdog: NodeJS.Timeout | null = null;
  private activity: DetectedActivity | null = null;
  private selectedIdentity: string | null = null;
  private selectedExecutable: string | null = null;
  private selectedPlatformIcon: string | null = null;
  private artworkKey: string | null = null;
  private onChange: (() => void) | null = null;
  private lastSnapshot: ProcessSnapshot = { processes: [] };
  private unsubscribePublisher: (() => void) | null = null;

  constructor(private readonly publisher?: ActivityAssetPublisher) {}

  start(onChange: () => void): void {
    if (this.onChange) return;
    this.onChange = onChange;
    this.loadLocal();
    this.refreshCatalog();
    if (process.platform === 'win32') {
      this.scanner = new WindowsProcessScanner();
      if (!this.scanner.start((snapshot) => this.applySnapshot(snapshot))) this.startFallback();
      else this.helperWatchdog = setTimeout(() => {
        this.helperWatchdog = null;
        if (this.lastSnapshot.processes.length) return;
        this.scanner?.stop();
        this.scanner = null;
        this.startFallback();
      }, 10_000);
    } else {
      this.startFallback();
    }
    this.catalogTimer = setInterval(() => this.refreshCatalog(), CATALOG_REFRESH_MS);
    this.unsubscribePublisher = this.publisher?.subscribe(() => {
      this.artworkKey = null;
      this.refreshArtwork();
    }) ?? null;
    void this.syncRemote();
  }

  stop(): void {
    this.scanner?.stop();
    this.scanner = null;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    if (this.catalogTimer) clearInterval(this.catalogTimer);
    if (this.helperWatchdog) clearTimeout(this.helperWatchdog);
    this.fallbackTimer = null;
    this.catalogTimer = null;
    this.helperWatchdog = null;
    this.unsubscribePublisher?.();
    this.unsubscribePublisher = null;
    this.activity = null;
    this.selectedIdentity = null;
    this.selectedExecutable = null;
    this.selectedPlatformIcon = null;
    this.onChange = null;
  }

  getActivities(): DetectedActivity[] { return this.activity ? [this.activity] : []; }

  private paths(): { cache: string; seed: string; etag: string } {
    return {
      cache: path.join(app.getPath('userData'), 'games-cache.json'),
      etag: path.join(app.getPath('userData'), 'games-cache-etag.txt'),
      seed: path.join(__dirname, '..', 'resources', 'games.json'),
    };
  }

  private loadLocal(): void {
    const { cache, seed } = this.paths();
    const read = (file: string) => { try { return parseGameDictionary(fs.readFileSync(file, 'utf8')); } catch { return null; } };
    const cached = read(cache);
    const bundled = read(seed);
    const chosen = cached && (!bundled || cached.version >= bundled.version) ? cached : bundled;
    this.entries = chosen?.entries ?? [];
  }

  private refreshCatalog(): void {
    try { this.installedGames = discoverInstalledGames(); } catch { this.installedGames = []; }
    if (this.lastSnapshot.processes.length) this.applySnapshot(this.lastSnapshot);
  }

  private startFallback(): void {
    const poll = () => {
      const { executable, args } = processCommand();
      execFile(executable, args, { maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return;
        const processes: RunningProcess[] = [];
        for (const [index, line] of stdout.split('\n').entries()) {
          const value = process.platform === 'win32' ? /^"([^"]+)"/.exec(line)?.[1] : line.trim();
          if (!value || (index === 0 && (value === 'COMM' || value === 'COMMAND'))) continue;
          processes.push({ pid: index + 1, name: value, hasWindow: false });
        }
        this.applySnapshot({ processes });
      });
    };
    poll();
    this.fallbackTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  private candidates(snapshot: ProcessSnapshot): GameCandidate[] {
    const candidates: GameCandidate[] = [];
    for (const entry of this.entries) {
      if (entry.id === 'lol' || entry.id === 'spotify') continue;
      const names = new Set(entry.processes.map(normalizeName));
      const matches = snapshot.processes.filter((running) => names.has(normalizeName(running.name)));
      if (matches.length) {
        const installed = this.installedGames.find((game) => {
          const expectedId = entry.platformIds?.[game.platform];
          return expectedId === game.id.split(':').slice(1).join(':')
            || matches.some((running) => running.path && isPathInside(running.path, game.installDir));
        });
        candidates.push({
          identity: `dictionary:${entry.id}`, name: entry.name, type: entry.type ?? 'playing',
          processes: matches, iconUrl: entry.iconUrl, iconPath: installed?.iconPath,
        });
      }
    }
    for (const game of this.installedGames) {
      const matches = snapshot.processes.filter((running) => running.path && isPathInside(running.path, game.installDir)
        && !NON_GAME_PROCESS.test(running.name));
      if (!matches.length) continue;
      const identity = `platform:${game.id}`;
      if (!matches.some((running) => running.hasWindow) && this.selectedIdentity !== identity) continue;
      const platformId = game.id.split(':').slice(1).join(':');
      const dictionary = this.entries.find((entry) => entry.platformIds?.[game.platform] === platformId);
      candidates.push({
        identity, name: dictionary?.name ?? game.name, type: dictionary?.type ?? 'playing',
        processes: matches, iconUrl: dictionary?.iconUrl, iconPath: game.iconPath,
      });
    }
    return candidates;
  }

  private applySnapshot(snapshot: ProcessSnapshot): void {
    if (this.helperWatchdog) {
      clearTimeout(this.helperWatchdog);
      this.helperWatchdog = null;
    }
    this.lastSnapshot = snapshot;
    const candidates = this.candidates(snapshot);
    const score = (candidate: GameCandidate): [number, number] => {
      const foreground = candidate.processes.some((running) => running.pid === snapshot.foregroundPid) ? 1 : 0;
      const latest = Math.max(...candidate.processes.map((running) => running.startedAt ?? 0));
      return [foreground, latest];
    };
    candidates.sort((a, b) => {
      const left = score(a); const right = score(b);
      return right[0] - left[0] || right[1] - left[1];
    });
    const selected = candidates[0];
    if (!selected) {
      if (!this.activity) return;
      this.activity = null;
      this.selectedIdentity = null;
      this.selectedExecutable = null;
      this.selectedPlatformIcon = null;
      this.artworkKey = null;
      this.onChange?.();
      return;
    }

    const started = selected.processes.map((running) => running.startedAt ?? 0).filter((value) => value > 0);
    const start = started.length ? Math.min(...started)
      : this.selectedIdentity === selected.identity ? this.activity?.timestamps?.start ?? Date.now() : Date.now();
    const executable = selected.processes.find((running) => running.pid === snapshot.foregroundPid && running.path)?.path
      ?? selected.processes.find((running) => running.hasWindow && running.path)?.path
      ?? selected.processes.find((running) => running.path)?.path
      ?? null;
    const existingImage = this.selectedIdentity === selected.identity ? this.activity?.assets?.largeImage : undefined;
    const image = selected.iconUrl ?? existingImage;
    const next: DetectedActivity = {
      source: 'game', type: selected.type, name: selected.name, timestamps: { start },
      ...(image ? { assets: { largeImage: image, largeText: selected.name } } : {}),
    };
    const changed = JSON.stringify(next) !== JSON.stringify(this.activity);
    this.activity = next;
    this.selectedIdentity = selected.identity;
    this.selectedExecutable = executable;
    this.selectedPlatformIcon = selected.iconPath && fs.existsSync(selected.iconPath) ? selected.iconPath : null;
    if (changed) this.onChange?.();
    if (!selected.iconUrl) this.refreshArtwork();
  }

  private refreshArtwork(): void {
    const identity = this.selectedIdentity;
    const executable = this.selectedExecutable;
    const platformIcon = this.selectedPlatformIcon;
    const source = platformIcon ?? executable;
    if (!identity || !source || !this.activity || !this.publisher?.canPublish()) return;
    const key = `${identity}\n${source}`;
    if (this.artworkKey === key) return;
    this.artworkKey = key;
    const loadIcon = platformIcon
      ? Promise.resolve(nativeImage.createFromPath(platformIcon))
      : app.getFileIcon(executable!, { size: 'large' });
    void loadIcon.then(async (icon) => {
      if (this.selectedIdentity !== identity || this.selectedExecutable !== executable
        || this.selectedPlatformIcon !== platformIcon || icon.isEmpty()) return;
      const url = await this.publisher!.publish(icon.toPNG());
      if (!url || this.selectedIdentity !== identity || this.selectedExecutable !== executable
        || this.selectedPlatformIcon !== platformIcon || !this.activity) return;
      const next = { ...this.activity, assets: { largeImage: url, largeText: this.activity.name } };
      if (JSON.stringify(next) === JSON.stringify(this.activity)) return;
      this.activity = next;
      this.onChange?.();
    }).catch(() => {});
  }

  private async syncRemote(): Promise<void> {
    const { cache, etag } = this.paths();
    const priorEtag = (() => { try { return fs.readFileSync(etag, 'utf8').trim(); } catch { return ''; } })();
    const response = await new Promise<{ status: number; body: string; etag?: string } | null>((resolve) => {
      const request = https.get(REMOTE_URL, { headers: priorEtag ? { 'If-None-Match': priorEtag } : {}, timeout: 10_000 }, (result) => {
        if (result.statusCode === 304) { result.resume(); resolve({ status: 304, body: '' }); return; }
        if (result.statusCode !== 200) { result.resume(); resolve(null); return; }
        const chunks: Buffer[] = []; result.on('data', (chunk: Buffer) => chunks.push(chunk));
        result.on('end', () => resolve({ status: 200, body: Buffer.concat(chunks).toString('utf8'), etag: typeof result.headers.etag === 'string' ? result.headers.etag : undefined }));
      });
      request.on('error', () => resolve(null)); request.on('timeout', () => { request.destroy(); resolve(null); });
    });
    if (!response || response.status !== 200) return;
    const dictionary = parseGameDictionary(response.body);
    if (!dictionary || dictionary.entries.length < this.entries.length / 2) return;
    this.entries = dictionary.entries;
    try { fs.writeFileSync(cache, response.body, 'utf8'); if (response.etag) fs.writeFileSync(etag, response.etag, 'utf8'); } catch { /* optional */ }
    if (this.lastSnapshot.processes.length) this.applySnapshot(this.lastSnapshot);
  }
}
