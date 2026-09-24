import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type GamePlatform = 'steam' | 'epic' | 'gog' | 'xbox';

export interface InstalledGame {
  id: string;
  name: string;
  installDir: string;
  platform: GamePlatform;
  iconPath?: string;
}

function unescapeVdf(value: string): string {
  return value.replace(/\\\\/g, '\\');
}

export function parseSteamLibraryFolders(raw: string): string[] {
  return [...raw.matchAll(/"path"\s+"([^"]+)"/gi)].map((match) => unescapeVdf(match[1]!));
}

export function parseSteamAppManifest(raw: string, steamAppsDir: string): InstalledGame | null {
  const field = (name: string) => new RegExp(`"${name}"\\s+"([^"]+)"`, 'i').exec(raw)?.[1];
  const appId = field('appid');
  const name = field('name');
  const installDir = field('installdir');
  const clientIcon = field('clienticon');
  if (!appId || !name || !installDir) return null;
  return {
    id: `steam:${appId}`,
    name,
    installDir: path.win32.join(steamAppsDir, 'common', unescapeVdf(installDir)),
    platform: 'steam',
    ...(clientIcon ? { iconPath: path.win32.join(path.win32.dirname(steamAppsDir), 'steam', 'games', `${clientIcon}.ico`) } : {}),
  };
}

export function parseEpicManifest(raw: string): InstalledGame | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const installDir = typeof value.InstallLocation === 'string' ? value.InstallLocation : '';
    const name = typeof value.DisplayName === 'string' ? value.DisplayName : '';
    const appId = typeof value.CatalogItemId === 'string' && value.CatalogItemId
      ? value.CatalogItemId
      : typeof value.AppName === 'string' ? value.AppName : '';
    const launchExecutable = typeof value.LaunchExecutable === 'string' ? value.LaunchExecutable : '';
    if (!installDir || !name || !appId) return null;
    return {
      id: `epic:${appId}`, name, installDir, platform: 'epic',
      ...(launchExecutable ? { iconPath: path.win32.join(installDir, launchExecutable) } : {}),
    };
  } catch { return null; }
}

export function parseGogRegistry(raw: string): InstalledGame[] {
  const games: InstalledGame[] = [];
  for (const block of raw.split(/\r?\n(?=HKEY_)/i)) {
    const key = /^HKEY[^\r\n]+\\([^\\\r\n]+)\s*$/im.exec(block)?.[1];
    const value = (name: string) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, 'im').exec(block)?.[1]?.trim();
    const gameName = value('gameName');
    const installDir = value('path');
    const iconPath = value('icon');
    if (key && gameName && installDir) games.push({
      id: `gog:${key}`, name: gameName, installDir, platform: 'gog', ...(iconPath ? { iconPath } : {}),
    });
  }
  return games;
}

export function parseMicrosoftGameConfig(raw: string, installDir: string): InstalledGame | null {
  const identity = /<Identity\b[^>]*\bName="([^"]+)"/i.exec(raw)?.[1];
  let name = /<ShellVisuals\b[^>]*\bDefaultDisplayName="([^"]+)"/i.exec(raw)?.[1];
  const logo = /<ShellVisuals\b[^>]*\bSquare150x150Logo="([^"]+)"/i.exec(raw)?.[1];
  if (!identity) return null;
  if (!name || /^ms-resource:/i.test(name)) name = path.win32.basename(path.win32.dirname(installDir));
  return {
    id: `xbox:${identity}`, name, installDir, platform: 'xbox',
    ...(logo ? { iconPath: path.win32.join(installDir, logo) } : {}),
  };
}

export function parseGamingRoot(raw: Buffer): string | null {
  if (raw.length <= 4) return null;
  const payload = raw.subarray(4);
  const looksUtf16 = payload[0] === 0xff && payload[1] === 0xfe
    || [...payload.subarray(1, Math.min(payload.length, 32)).filter((_, index) => index % 2 === 0)]
      .filter((byte) => byte === 0).length >= 3;
  const candidates = looksUtf16 ? [payload.toString('utf16le')] : [payload.toString('utf8')];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/\0/g, '').trim().replace(/[\\/]+$/, '');
    if (cleaned && !/[\x00-\x1f]/.test(cleaned)) return cleaned;
  }
  return null;
}

function registryValue(key: string, name: string): string | null {
  try {
    const raw = execFileSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    return new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, 'im').exec(raw)?.[1]?.trim() ?? null;
  } catch { return null; }
}

function readSteamGames(): InstalledGame[] {
  const roots = new Set<string>();
  const registryRoot = registryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (registryRoot) roots.add(registryRoot.replace(/\//g, '\\'));
  const programFiles = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles;
  if (programFiles) roots.add(path.win32.join(programFiles, 'Steam'));
  for (const root of [...roots]) {
    try {
      const raw = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const library of parseSteamLibraryFolders(raw)) roots.add(library);
    } catch { /* optional library */ }
  }
  const games: InstalledGame[] = [];
  for (const root of roots) {
    const steamApps = path.join(root, 'steamapps');
    try {
      for (const file of fs.readdirSync(steamApps)) {
        if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
        const game = parseSteamAppManifest(fs.readFileSync(path.join(steamApps, file), 'utf8'), steamApps);
        if (game) games.push(game);
      }
    } catch { /* inaccessible library */ }
  }
  return games;
}

function readEpicGames(): InstalledGame[] {
  const root = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  try {
    return fs.readdirSync(root).filter((file) => file.endsWith('.item')).flatMap((file) => {
      try {
        const game = parseEpicManifest(fs.readFileSync(path.join(root, file), 'utf8'));
        return game ? [game] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

function readGogGames(): InstalledGame[] {
  const keys = ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', 'HKLM\\SOFTWARE\\GOG.com\\Games'];
  for (const key of keys) {
    try {
      const raw = execFileSync('reg.exe', ['query', key, '/s'], { encoding: 'utf8', windowsHide: true, timeout: 8_000 });
      const games = parseGogRegistry(raw);
      if (games.length) return games;
    } catch { /* try next view */ }
  }
  return [];
}

function xboxRoots(): string[] {
  const roots: string[] = [];
  for (let code = 67; code <= 90; code++) {
    const drive = `${String.fromCharCode(code)}:\\`;
    const conventional = path.join(drive, 'XboxGames');
    if (fs.existsSync(conventional)) roots.push(conventional);
    try {
      const configured = parseGamingRoot(fs.readFileSync(path.join(drive, '.GamingRoot')));
      if (configured) {
        const resolved = path.win32.isAbsolute(configured) ? configured : path.win32.join(drive, configured);
        if (fs.existsSync(resolved)) roots.push(resolved);
      }
    } catch { /* drive has no Xbox gaming root */ }
  }
  return [...new Set(roots.map((root) => path.win32.resolve(root)))];
}

function readXboxGames(): InstalledGame[] {
  const games: InstalledGame[] = [];
  for (const root of xboxRoots()) {
    let folders: fs.Dirent[] = [];
    try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const content = path.join(root, folder.name, 'Content');
      const config = path.join(content, 'MicrosoftGame.Config');
      try {
        const game = parseMicrosoftGameConfig(fs.readFileSync(config, 'utf8'), content);
        if (game) games.push(game);
      } catch { /* protected or incomplete install */ }
    }
  }
  return games;
}

export function discoverInstalledGames(): InstalledGame[] {
  if (process.platform !== 'win32') return [];
  const unique = new Map<string, InstalledGame>();
  for (const game of [...readSteamGames(), ...readEpicGames(), ...readGogGames(), ...readXboxGames()]) {
    if (fs.existsSync(game.installDir)) unique.set(game.id, game);
  }
  return [...unique.values()];
}

export function isPathInside(candidate: string, directory: string): boolean {
  const child = path.win32.resolve(candidate).toLowerCase();
  const parent = path.win32.resolve(directory).replace(/[\\/]+$/, '').toLowerCase();
  return child === parent || child.startsWith(`${parent}\\`);
}
