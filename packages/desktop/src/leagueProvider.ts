import { execFile } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { app } from 'electron';
import type { ActivityProvider, DetectedActivity } from './activityTypes';
import { updateLeagueMatchContext, type LeagueChampionPresence, type LeagueMatchContext } from './leagueMatchContext';
import { parseLeagueProcessRows, resolveLcuConnection, type LcuConnection, type LeagueProcessSnapshot } from './leagueConnection';

interface ChampionRecord { key: string; name: string; image?: { full?: string } }

const CLIENT_PROCESSES = new Set(['leagueclient.exe', 'leagueclientux.exe']);
const GAME_PROCESSES = new Set(['league of legends.exe', 'leagueoflegends.exe']);
const POLL_INTERVAL_MS = 3_000;
let processScanWarned = false;
let connectionWarned = false;
let noProcessWarned = false;
const lcuFailureWarned = new Set<string>();
const QUEUES: Record<number, string> = {
  0: '自定义模式', 400: '匹配模式', 420: '排位单人/双人', 430: '普通征召',
  440: '排位灵活组排', 450: '极地大乱斗', 490: '快速模式', 700: '冠军杯赛',
  830: '人机入门', 840: '人机简单', 850: '人机一般', 900: '无限火力',
  1020: '无限火力', 1300: '终极魔典', 1400: '终极魔典', 1700: '斗魂竞技场',
  1710: '斗魂竞技场', 1810: '斗魂竞技场', 1900: '极限闪击', 2000: '训练模式',
};

function execPowerShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

async function readProcesses(): Promise<{ clients: LeagueProcessSnapshot[]; hasGame: boolean }> {
  if (process.platform !== 'win32') return { clients: [], hasGame: false };
  // Get-CimInstance already exposes CreationDate as a DateTime. The old code
  // passed it through ManagementDateTimeConverter (which expects a DMTF string)
  // and consequently threw on every matching League process.
  const command = "$n=@('LeagueClient.exe','LeagueClientUx.exe','League of Legends.exe','LeagueofLegends.exe'); Get-CimInstance Win32_Process | Where-Object {$n -contains $_.Name} | ForEach-Object {[PSCustomObject]@{name=$_.Name;commandLine=$_.CommandLine;executablePath=$_.ExecutablePath;startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress";
  try {
    const output = (await execPowerShell(command)).trim();
    if (!output) return { clients: [], hasGame: false };
    const rows = parseLeagueProcessRows(output);
    processScanWarned = false;
    const clients = rows.filter((row) => CLIENT_PROCESSES.has(row.name.toLowerCase()));
    return { clients, hasGame: rows.some((row) => GAME_PROCESSES.has(row.name.toLowerCase())) };
  } catch (error) {
    if (!processScanWarned) {
      processScanWarned = true;
      console.warn('[league] process scan failed:', error instanceof Error ? error.message : String(error));
    }
    return { clients: [], hasGame: false };
  }
}

function lcuRequest<T>(connection: LcuConnection, endpoint: string): Promise<T | null> {
  return new Promise((resolve) => {
    const request = https.request({ hostname: '127.0.0.1', port: connection.port, path: endpoint, method: 'GET', rejectUnauthorized: false, auth: `riot:${connection.token}`, timeout: 2_000 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        warnLcuFailure(endpoint, `HTTP ${response.statusCode ?? 'unknown'}`);
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
        catch { warnLcuFailure(endpoint, 'invalid JSON response'); resolve(null); }
      });
    });
    request.on('timeout', () => { request.destroy(); warnLcuFailure(endpoint, 'request timed out'); resolve(null); });
    request.on('error', (error) => { warnLcuFailure(endpoint, error.message); resolve(null); });
    request.end();
  });
}

function warnLcuFailure(endpoint: string, reason: string): void {
  if (lcuFailureWarned.has(endpoint)) return;
  lcuFailureWarned.add(endpoint);
  console.warn(`[league] LCU request failed for ${endpoint}: ${reason}`);
}

export function createLeagueActivity(start: number): DetectedActivity {
  return { source: 'game', type: 'playing', name: 'League of Legends', timestamps: { start } };
}

function phaseLabel(phase: unknown): string | undefined {
  switch (phase) {
    case 'None': return '客户端已启动';
    case 'Lobby': return '大厅中';
    case 'Matchmaking': return '匹配中';
    case 'ReadyCheck': return '等待确认';
    case 'ChampSelect': return '正在选择英雄';
    case 'PreEndOfGame': return '加载中';
    case 'InProgress': return '游戏中';
    case 'EndOfGame': return '结算中';
    default: return undefined;
  }
}

export class LeagueProvider implements ActivityProvider {
  private timer: NodeJS.Timeout | null = null;
  private activity: DetectedActivity | null = null;
  private champions = new Map<number, ChampionRecord>();
  private championVersion: string | null = null;
  private matchContext: LeagueMatchContext = {};

  start(onChange: () => void): void {
    if (this.timer || process.platform !== 'win32') return;
    const poll = () => void this.refresh(onChange);
    poll();
    this.timer = setInterval(poll, POLL_INTERVAL_MS);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.activity = null; this.matchContext = {}; }
  getActivities(): DetectedActivity[] { return this.activity ? [this.activity] : []; }

  private async refresh(onChange: () => void): Promise<void> {
    const { clients, hasGame } = await readProcesses();
    const client = clients.sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!client && !hasGame) {
      if (!noProcessWarned) {
        noProcessWarned = true;
        console.info('[league] no LeagueClient or League of Legends process detected');
      }
      if (this.activity) { this.activity = null; onChange(); }
      return;
    }
    noProcessWarned = false;

    const start = client?.startedAt ?? this.activity?.timestamps?.start ?? Date.now();
    const next = createLeagueActivity(start);
    const connection = clients
      .map((candidate) => resolveLcuConnection(candidate.commandLine, candidate.executablePath))
      .find((candidate): candidate is LcuConnection => candidate !== null) ?? null;
    if (connection) connectionWarned = false;
    if ((client || hasGame) && !connection && !connectionWarned) {
      connectionWarned = true;
      console.warn('[league] LOL detected, but no LCU connection was found; game phase and champion details will be unavailable. Run the desktop client at the same privilege level as League or expose the LeagueClient lockfile.');
    }
    if (connection) await this.enrich(next, connection);
    this.publish(next, onChange);
  }

  private async enrich(activity: DetectedActivity, connection: LcuConnection): Promise<void> {
    const [phase, session, champSelect] = await Promise.all([
      lcuRequest<string>(connection, '/lol-gameflow/v1/gameflow-phase'),
      lcuRequest<Record<string, unknown>>(connection, '/lol-gameflow/v1/session'),
      lcuRequest<Record<string, unknown>>(connection, '/lol-champ-select/v1/session'),
    ]);
    const gameData = session?.gameData as Record<string, unknown> | undefined;
    const queue = gameData?.queue as Record<string, unknown> | undefined;
    const queueId = typeof queue?.id === 'number' ? queue.id : undefined;
    const mode = queueId === undefined ? undefined : (QUEUES[queueId] ?? '特殊模式');

    const localCell = typeof champSelect?.localPlayerCellId === 'number' ? champSelect.localPlayerCellId : null;
    const team = Array.isArray(champSelect?.myTeam) ? champSelect.myTeam as Array<Record<string, unknown>> : [];
    const me = localCell === null ? undefined : team.find((member) => member.cellId === localCell);
    const championId = typeof me?.championId === 'number' && me.championId > 0 ? me.championId : undefined;
    let championPresence: LeagueChampionPresence | undefined;
    if (championId) {
      const champion = await this.getChampion(connection, championId);
      if (champion?.image?.full && this.championVersion) {
        championPresence = {
          name: champion.name,
          imageUrl: `https://ddragon.leagueoflegends.com/cdn/${this.championVersion}/img/champion/${champion.image.full}`,
        };
      } else {
        championPresence = champion ? { name: champion.name } : {};
      }
    }

    if (phase !== null && phase !== undefined) {
      this.matchContext = updateLeagueMatchContext(this.matchContext, phase, mode, championPresence);
    }
    const phaseText = phaseLabel(phase);
    activity.state = [this.matchContext.mode, phaseText].filter(Boolean).join(' · ') || undefined;
    if (this.matchContext.champion) {
      activity.details = this.matchContext.champion.name ? `使用：${this.matchContext.champion.name}` : '已选择英雄';
      if (this.matchContext.champion.imageUrl) {
        activity.assets = { largeImage: this.matchContext.champion.imageUrl, largeText: this.matchContext.champion.name };
      }
    } else if (phase === 'ChampSelect') {
      activity.details = '正在选择英雄';
    }
  }

  private async getChampion(connection: LcuConnection, championId: number): Promise<ChampionRecord | undefined> {
    if (this.champions.has(championId)) return this.champions.get(championId);
    const version = await lcuRequest<string>(connection, '/lol-patch/v1/game-version');
    if (!version || version === this.championVersion) return this.champions.get(championId);
    const file = path.join(app.getPath('userData'), `ddragon-champions-${version}.json`);
    let raw: string | null = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* cache miss */ }
    if (!raw) raw = await new Promise<string | null>((resolve) => {
      const request = https.get(`https://ddragon.leagueoflegends.com/cdn/${version}/data/zh_CN/champion.json`, { timeout: 5_000 }, (response) => {
        if (response.statusCode !== 200) { response.resume(); resolve(null); return; }
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      request.on('error', () => resolve(null));
      request.on('timeout', () => { request.destroy(); resolve(null); });
    });
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { data?: Record<string, ChampionRecord> };
      this.champions = new Map(Object.values(parsed.data ?? {}).flatMap((champion) => Number(champion.key) ? [[Number(champion.key), champion] as const] : []));
      this.championVersion = version;
      try { fs.writeFileSync(file, raw, 'utf8'); } catch { /* cache is optional */ }
    } catch { return undefined; }
    return this.champions.get(championId);
  }

  private publish(next: DetectedActivity, onChange: () => void): void {
    if (JSON.stringify(this.activity) === JSON.stringify(next)) return;
    this.activity = next;
    onChange();
  }
}
