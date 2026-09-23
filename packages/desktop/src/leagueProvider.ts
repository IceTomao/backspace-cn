import fs from 'fs';
import https from 'https';
import path from 'path';
import { app } from 'electron';
import type { ActivityProvider, DetectedActivity } from './activityTypes';
import { updateLeagueMatchContext, type LeagueChampionPresence, type LeagueMatchContext } from './leagueMatchContext';
import { resolveLcuConnection, type LcuConnection, type LeagueProcessSnapshot } from './leagueConnection';
import { readLeagueProcessesNative } from './leagueProcessNative';

interface ChampionRecord {
  key: string;
  name: string;
  image?: { full?: string };
}

export interface LeagueQueueRecord {
  id?: number;
  name?: string;
  shortName?: string;
  gameMode?: string;
  gameSelectModeGroup?: string;
  mapId?: number;
}

const CLIENT_PROCESSES = new Set(['leagueclient.exe', 'leagueclientux.exe']);
const GAME_PROCESSES = new Set(['league of legends.exe', 'leagueoflegends.exe']);
const POLL_INTERVAL_MS = 3_000;
let processScanWarned = false;
let connectionWarned = false;
let noProcessWarned = false;
let gameClientWarned = false;
const lcuFailureWarned = new Set<string>();
const QUEUES: Record<number, string> = {
  0: '自定义模式', 400: '匹配模式', 420: '排位单人/双人', 430: '普通征召',
  440: '排位灵活组排', 450: '极地大乱斗', 490: '快速模式', 700: '冠军杯赛',
  830: '人机入门', 840: '人机简单', 850: '人机一般', 900: '无限火力',
  1020: '无限火力', 1300: '终极魔典', 1400: '终极魔典', 1700: '斗魂竞技场',
  1710: '斗魂竞技场', 1810: '斗魂竞技场', 1900: '极限闪击', 2000: '训练模式',
};

const MODE_ALIASES: Array<[RegExp, string]> = [
  [/practice|training|训练/i, '训练模式'],
  [/teamfight tactics|tft|云顶/i, '云顶之弈'],
  [/hextech.*aram|海克斯.*大乱斗/i, '海克斯大乱斗'],
  [/aram|all random all mid|极地|map12/i, '极地大乱斗'],
  [/cherry|arena|斗魂/i, '斗魂竞技场'],
  [/classic|召唤师峡谷|map11/i, '经典模式'],
  [/swiftplay|快速/i, '快速模式'],
  [/ultra rapid fire|urf|无限火力/i, '无限火力'],
  [/ultimate spellbook|ultbook|终极魔典/i, '终极魔典'],
  [/nexus blitz|极限闪击/i, '极限闪击'],
  [/one for all|克隆大作战/i, '克隆大作战'],
  [/doom bots|末日人机/i, '末日人机'],
];

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Convert LCU's localized or internal mode name into a stable Chinese label. */
export function normalizeLeagueMode(...values: unknown[]): string | undefined {
  const text = values.map(textValue).filter(Boolean).join(' · ');
  if (!text) return undefined;
  for (const [pattern, label] of MODE_ALIASES) {
    if (pattern.test(text)) return label;
  }
  return text;
}

export function parseQueueCatalog(value: unknown): Map<number, LeagueQueueRecord> {
  const records = Array.isArray(value) ? value : Object.values((value && typeof value === 'object') ? value : {});
  const catalog = new Map<number, LeagueQueueRecord>();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const item = record as Record<string, unknown>;
    const id = numberValue(item.id);
    if (id === undefined) continue;
    catalog.set(id, {
      id,
      name: textValue(item.name),
      shortName: textValue(item.shortName),
      gameMode: textValue(item.gameMode),
      gameSelectModeGroup: textValue(item.gameSelectModeGroup),
      mapId: numberValue(item.mapId),
    });
  }
  return catalog;
}

export function resolveLeagueMode(
  queue: Record<string, unknown> | undefined,
  gameData: Record<string, unknown> | undefined,
  catalog: Map<number, LeagueQueueRecord> = new Map(),
): string | undefined {
  const queueId = numberValue(queue?.id);
  const catalogEntry = queueId === undefined ? undefined : catalog.get(queueId);
  if (queueId !== undefined && QUEUES[queueId]) return QUEUES[queueId];
  const mapId = numberValue(queue?.mapId) ?? numberValue(catalogEntry?.mapId) ?? numberValue(gameData?.mapId);
  const queueMode = normalizeLeagueMode(
    queue?.name,
    queue?.shortName,
    queue?.type,
    catalogEntry?.name,
    catalogEntry?.shortName,
    queue?.gameMode,
    catalogEntry?.gameMode,
    catalogEntry?.gameSelectModeGroup,
    mapId === undefined ? undefined : `Map${mapId}`,
    gameData?.gameMode,
    gameData?.gameType,
  );
  if (queueMode) return queueMode;
  if (queueId !== undefined) return '特殊模式';
  return undefined;
}

async function readProcesses(): Promise<{ clients: LeagueProcessSnapshot[]; hasGame: boolean }> {
  if (process.platform !== 'win32') return { clients: [], hasGame: false };
  try {
    const rows = await readLeagueProcessesNative();
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

interface LiveGameData {
  activePlayer?: { summonerName?: string; championName?: string };
  gameData?: { gameMode?: string; gameType?: string; mapName?: string };
  allPlayers?: Array<{
    summonerName?: string;
    riotIdGameName?: string;
    championName?: string;
    rawChampionName?: string;
  }>;
  playerList?: Array<{
    summonerName?: string;
    riotIdGameName?: string;
    championName?: string;
    rawChampionName?: string;
  }>;
}

interface LeagueSummonerIdentity {
  puuid?: string;
  summonerId?: string | number;
  summonerName?: string;
  gameName?: string;
  displayName?: string;
}

interface LeaguePresenceInput {
  phase?: unknown;
  session?: Record<string, unknown> | null;
  champSelect?: Record<string, unknown> | null;
  currentSummoner?: LeagueSummonerIdentity | null;
  queueCatalog?: Map<number, LeagueQueueRecord>;
}

export interface LeagueLcuPresence {
  mode?: string;
  championId?: number;
  gameId?: string;
}

function hasIdentity(member: Record<string, unknown>, current: LeagueSummonerIdentity | null | undefined): boolean {
  if (!current) return false;
  const memberPuuid = textValue(member.puuid);
  const memberSummonerId = textValue(member.summonerId) ?? numberValue(member.summonerId)?.toString();
  const memberNames = [member.summonerName, member.gameName, member.displayName]
    .map(textValue)
    .filter(Boolean);
  const currentNames = [current.summonerName, current.gameName, current.displayName]
    .map(textValue)
    .filter(Boolean);
  return Boolean(
    (current.puuid && memberPuuid && current.puuid === memberPuuid)
    || (current.summonerId !== undefined && memberSummonerId && String(current.summonerId) === memberSummonerId)
    || memberNames.some((name) => currentNames.includes(name)),
  );
}

function championIdFromMember(member: Record<string, unknown> | undefined): number | undefined {
  const championId = numberValue(member?.championId);
  return championId && championId > 0 ? championId : undefined;
}

function findLocalChampionId(
  gameData: Record<string, unknown> | undefined,
  champSelect: Record<string, unknown> | null | undefined,
  currentSummoner: LeagueSummonerIdentity | null | undefined,
): number | undefined {
  const selections = Array.isArray(gameData?.playerChampionSelections)
    ? gameData?.playerChampionSelections as Array<Record<string, unknown>>
    : [];
  const teams = [
    ...(Array.isArray(gameData?.teamOne) ? gameData.teamOne as Array<Record<string, unknown>> : []),
    ...(Array.isArray(gameData?.teamTwo) ? gameData.teamTwo as Array<Record<string, unknown>> : []),
  ];
  const gameMember = [...selections, ...teams].find((member) => hasIdentity(member, currentSummoner))
    ?? [...selections, ...teams].find((member) => member.isCurrentPlayer === true || member.isLocalPlayer === true);
  const gameChampion = championIdFromMember(gameMember);
  if (gameChampion) return gameChampion;

  const localCell = numberValue(champSelect?.localPlayerCellId);
  const champTeam = Array.isArray(champSelect?.myTeam)
    ? champSelect?.myTeam as Array<Record<string, unknown>>
    : [];
  const champMember = localCell === undefined
    ? champTeam.find((member) => hasIdentity(member, currentSummoner))
    : champTeam.find((member) => numberValue(member.cellId) === localCell);
  return championIdFromMember(champMember);
}

export function parseLcuPresence(input: LeaguePresenceInput): LeagueLcuPresence {
  const gameData = input.session?.gameData as Record<string, unknown> | undefined;
  const queue = gameData?.queue as Record<string, unknown> | undefined;
  const gameId = textValue(gameData?.gameId) ?? numberValue(gameData?.gameId)?.toString();
  return {
    mode: resolveLeagueMode(queue, gameData, input.queueCatalog),
    championId: findLocalChampionId(gameData, input.champSelect, input.currentSummoner),
    gameId,
  };
}

export interface LiveGamePresence {
  championName?: string;
  mode?: string;
}

/** Extract the local champion and a readable mode from Riot's in-game API. */
export function parseLiveGamePresence(data: LiveGameData): LiveGamePresence {
  const activeName = data.activePlayer?.summonerName;
  const players = data.allPlayers ?? data.playerList ?? [];
  const player = players.find((candidate) => (
    candidate.summonerName === activeName || ('riotIdGameName' in candidate && candidate.riotIdGameName === activeName)
  ));
  const game = data.gameData;
  const mode = normalizeLeagueMode(game?.gameType, game?.gameMode, game?.mapName);
  return { championName: player?.championName ?? player?.rawChampionName ?? data.activePlayer?.championName, mode };
}

function liveGameRequest<T>(endpoint: string): Promise<T | null> {
  return new Promise((resolve) => {
    const request = https.request({
      hostname: '127.0.0.1', port: 2999, path: endpoint, method: 'GET',
      rejectUnauthorized: false, timeout: 1_500,
    }, (response) => {
      if (response.statusCode !== 200) { response.resume(); resolve(null); return; }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); }
        catch { resolve(null); }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
    request.end();
  });
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
    case 'GameStart': return '游戏开始';
    case 'Reconnect': return '重新连接';
    case 'PreEndOfGame': return '加载中';
    case 'InProgress': return '游戏中';
    case 'WaitingForStats': return '等待统计';
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
  private queueCatalog = new Map<number, LeagueQueueRecord>();
  private queueCatalogLoaded = false;

  start(onChange: () => void): void {
    if (this.timer || process.platform !== 'win32') return;
    const poll = () => void this.refresh(onChange);
    poll();
    this.timer = setInterval(poll, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.activity = null;
    this.matchContext = {};
    this.queueCatalog = new Map();
    this.queueCatalogLoaded = false;
  }
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
    if (connection) {
      await this.enrich(next, connection, hasGame);
    } else if (hasGame) {
      await this.enrichFromLiveGame(next);
    }
    this.publish(next, onChange);
  }

  private async enrichFromLiveGame(activity: DetectedActivity, phase?: unknown): Promise<boolean> {
    const data = await liveGameRequest<LiveGameData>('/liveclientdata/allgamedata');
    if (!data) {
      if (!gameClientWarned) {
        gameClientWarned = true;
        console.warn('[league] in-game API unavailable on 127.0.0.1:2999; publishing base League activity');
      }
      return false;
    }
    gameClientWarned = false;
    const presence = parseLiveGamePresence(data);
    this.matchContext = updateLeagueMatchContext(
      this.matchContext,
      'InProgress',
      this.matchContext.mode ?? presence.mode,
      presence.championName ? { ...this.matchContext.champion, name: presence.championName } : undefined,
    );
    activity.state = [this.matchContext.mode, phaseLabel(phase) ?? '游戏中'].filter(Boolean).join(' · ') || undefined;
    if (this.matchContext.champion?.name) activity.details = `使用：${this.matchContext.champion.name}`;
    return true;
  }

  private async enrich(activity: DetectedActivity, connection: LcuConnection, hasGame: boolean): Promise<void> {
    const [phase, session, champSelect, currentSummoner] = await Promise.all([
      lcuRequest<string>(connection, '/lol-gameflow/v1/gameflow-phase'),
      lcuRequest<Record<string, unknown>>(connection, '/lol-gameflow/v1/session'),
      lcuRequest<Record<string, unknown>>(connection, '/lol-champ-select/v1/session'),
      lcuRequest<LeagueSummonerIdentity>(connection, '/lol-summoner/v1/current-summoner'),
    ]);
    if (!this.queueCatalogLoaded) {
      const catalog = await lcuRequest<unknown>(connection, '/lol-game-data/assets/v1/queues');
      if (catalog !== null) {
        this.queueCatalog = parseQueueCatalog(catalog);
        this.queueCatalogLoaded = true;
      }
    }
    const presence = parseLcuPresence({
      phase,
      session,
      champSelect,
      currentSummoner,
      queueCatalog: this.queueCatalog,
    });
    let championPresence: LeagueChampionPresence | undefined;
    if (presence.championId) {
      const champion = await this.getChampion(connection, presence.championId);
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
      this.matchContext = updateLeagueMatchContext(
        this.matchContext,
        phase,
        presence.mode,
        championPresence,
        presence.gameId,
      );
    }
    if (hasGame) await this.enrichFromLiveGame(activity, phase);
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
    const lcuChampion = await lcuRequest<Record<string, unknown>>(
      connection,
      `/lol-game-data/assets/v1/champions/${championId}`,
    );
    const lcuName = textValue(lcuChampion?.name);
    if (lcuName) {
      const champion: ChampionRecord = { key: String(championId), name: lcuName };
      this.champions.set(championId, champion);
      // Keep the name immediately available even when Data Dragon is offline.
      await this.loadChampionImages(connection);
      return this.champions.get(championId) ?? champion;
    }
    return this.getChampionFromDataDragon(connection, championId);
  }

  private async loadChampionImages(connection: LcuConnection): Promise<void> {
    const version = await lcuRequest<string>(connection, '/lol-patch/v1/game-version');
    if (!version || version === this.championVersion) return;
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
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { data?: Record<string, ChampionRecord> };
      const imageRecords = Object.values(parsed.data ?? {}).flatMap((champion) => Number(champion.key) ? [[Number(champion.key), champion] as const] : []);
      for (const [id, champion] of imageRecords) {
        const existing = this.champions.get(id);
        this.champions.set(id, existing ? { ...existing, image: champion.image, name: existing.name || champion.name } : champion);
      }
      this.championVersion = version;
      try { fs.writeFileSync(file, raw, 'utf8'); } catch { /* cache is optional */ }
    } catch { /* invalid cache/data response */ }
  }

  private async getChampionFromDataDragon(connection: LcuConnection, championId: number): Promise<ChampionRecord | undefined> {
    await this.loadChampionImages(connection);
    return this.champions.get(championId);
  }

  private publish(next: DetectedActivity, onChange: () => void): void {
    if (JSON.stringify(this.activity) === JSON.stringify(next)) return;
    this.activity = next;
    onChange();
  }
}
