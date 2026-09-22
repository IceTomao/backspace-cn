import { execFile } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { app } from 'electron';
import type { ActivityProvider, DesktopActivity, DetectedActivity } from './activityTypes';
import { LeagueProvider } from './leagueProvider';
import { WindowsMediaProvider } from './windowsMediaProvider';

interface GameEntry { id: string; name: string; processes: string[]; type?: DesktopActivity['type']; }

const VALID_TYPES = new Set<DesktopActivity['type']>(['playing', 'listening', 'watching', 'streaming']);
const POLL_INTERVAL_MS = 3_000;
const REMOTE_URL = 'https://raw.githubusercontent.com/IceTomao/backspace-cn/master/packages/desktop/resources/games.json';

function parseGameEntry(input: unknown): GameEntry | null {
  if (!input || typeof input !== 'object') return null;
  const entry = input as Record<string, unknown>;
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string' || !Array.isArray(entry.processes) || !entry.processes.every((value) => typeof value === 'string')) return null;
  const type = typeof entry.type === 'string' && VALID_TYPES.has(entry.type as DesktopActivity['type']) ? entry.type as DesktopActivity['type'] : 'playing';
  return { id: entry.id, name: entry.name, processes: entry.processes as string[], type };
}

function parseDictionary(raw: string): { version: number; entries: GameEntry[] } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { games?: unknown }).games) ? (parsed as { games: unknown[] }).games : null;
    if (!values) return null;
    const entries = values.flatMap((item) => {
      const entry = parseGameEntry(item);
      return entry ? [entry] : [];
    });
    return entries.length ? { version: Array.isArray(parsed) ? 0 : Number((parsed as { version?: number }).version) || 0, entries } : null;
  } catch { return null; }
}

function processCommand(): { executable: string; args: string[] } {
  if (process.platform === 'win32') return { executable: 'tasklist', args: ['/fo', 'csv', '/nh'] };
  if (process.platform === 'darwin') return { executable: 'ps', args: ['-c', '-A', '-o', 'comm'] };
  return { executable: 'ps', args: ['-A', '-o', 'comm'] };
}

function parseProcessList(stdout: string): Set<string> {
  const processes = new Set<string>();
  for (const [index, line] of stdout.split('\n').entries()) {
    const match = process.platform === 'win32' ? /^"([^"]+)"/.exec(line)?.[1] : line.trim();
    if (!match || (index === 0 && (match === 'COMM' || match === 'COMMAND'))) continue;
    processes.add(match.toLowerCase());
  }
  return processes;
}

class ProcessGameProvider implements ActivityProvider {
  private entries: GameEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private activity: DetectedActivity | null = null;
  private running = false;

  start(onChange: () => void): void {
    if (this.timer) return;
    this.loadLocal();
    const poll = () => this.poll(onChange);
    poll();
    this.timer = setInterval(poll, POLL_INTERVAL_MS);
    void this.syncRemote();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.activity = null; }
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
    const read = (file: string) => { try { return parseDictionary(fs.readFileSync(file, 'utf8')); } catch { return null; } };
    const cached = read(cache);
    const bundled = read(seed);
    const chosen = cached && (!bundled || cached.version >= bundled.version) ? cached : bundled;
    this.entries = chosen?.entries ?? [];
  }

  private async syncRemote(): Promise<void> {
    const { cache, etag } = this.paths();
    const priorEtag = (() => { try { return fs.readFileSync(etag, 'utf8').trim(); } catch { return ''; } })();
    const response = await new Promise<{ status: number; body: string; etag?: string } | null>((resolve) => {
      const request = https.get(REMOTE_URL, { headers: priorEtag ? { 'If-None-Match': priorEtag } : {}, timeout: 10_000 }, (result) => {
        if (result.statusCode === 304) { result.resume(); resolve({ status: 304, body: '' }); return; }
        if (result.statusCode !== 200) { result.resume(); resolve(null); return; }
        const chunks: Buffer[] = []; result.on('data', (chunk: Buffer) => chunks.push(chunk)); result.on('end', () => resolve({ status: 200, body: Buffer.concat(chunks).toString('utf8'), etag: typeof result.headers.etag === 'string' ? result.headers.etag : undefined }));
      });
      request.on('error', () => resolve(null)); request.on('timeout', () => { request.destroy(); resolve(null); });
    });
    if (!response || response.status !== 200) return;
    const dictionary = parseDictionary(response.body);
    if (!dictionary || dictionary.entries.length < this.entries.length / 2) return;
    this.entries = dictionary.entries;
    try { fs.writeFileSync(cache, response.body, 'utf8'); if (response.etag) fs.writeFileSync(etag, response.etag, 'utf8'); } catch { /* cache is optional */ }
  }

  private poll(onChange: () => void): void {
    if (this.running || !this.entries.length) return;
    this.running = true;
    const { executable, args } = processCommand();
    execFile(executable, args, { maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      this.running = false;
      if (error) return;
      const processes = parseProcessList(stdout);
      // LOL and Spotify have dedicated providers. This provider retains all other dictionary entries.
      const entry = this.entries.find((candidate) => candidate.id !== 'lol' && candidate.id !== 'spotify' && candidate.processes.some((process) => processes.has(process.toLowerCase())));
      const existing = this.activity;
      const start = existing?.name === entry?.name ? existing?.timestamps?.start ?? Date.now() : Date.now();
      const next = entry ? { source: 'game' as const, type: entry.type ?? 'playing', name: entry.name, timestamps: { start } } : null;
      if (JSON.stringify(next) === JSON.stringify(this.activity)) return;
      this.activity = next;
      onChange();
    });
  }
}

let providers: ActivityProvider[] = [];
let currentActivities: DesktopActivity[] = [];
let callback: ((activities: DesktopActivity[]) => void) | null = null;

function emit(): void {
  const detected = providers.flatMap((provider) => provider.getActivities());
  // Provider order is intentional: League, other games, then music.
  const next = detected.slice(0, 5).map(({ source: _source, ...activity }) => activity);
  if (JSON.stringify(next) === JSON.stringify(currentActivities)) return;
  currentActivities = next;
  callback?.(next);
}

export function startActivityDetection(onActivitiesChange: (activities: DesktopActivity[]) => void): void {
  if (providers.length) return;
  callback = onActivitiesChange;
  providers = [new LeagueProvider(), new ProcessGameProvider(), new WindowsMediaProvider()];
  for (const provider of providers) provider.start(emit);
  emit();
}

export function stopActivityDetection(): void {
  for (const provider of providers) provider.stop();
  providers = [];
  callback = null;
  currentActivities = [];
}

export function getCurrentActivities(): DesktopActivity[] { return currentActivities; }
