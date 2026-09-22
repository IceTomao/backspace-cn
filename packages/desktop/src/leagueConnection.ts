import fs from 'fs';
import path from 'path';

export interface LcuConnection {
  port: number;
  token: string;
}

export interface LeagueProcessSnapshot {
  name: string;
  commandLine: string;
  startedAt: number;
  executablePath?: string;
}

/** Parse the credentials exposed on LeagueClient's command line. */
export function parseLcuCommandLine(commandLine: string): LcuConnection | null {
  const port = /(?:^|\s)--app-port=(?:"([0-9]+)"|([^\s"]+))/i.exec(commandLine);
  const token = /(?:^|\s)--remoting-auth-token=(?:"([^"]+)"|([^\s"]+))/i.exec(commandLine);
  const portValue = port?.[1] ?? port?.[2];
  const tokenValue = token?.[1] ?? token?.[2];
  if (!portValue || !tokenValue) return null;
  const portNumber = Number(portValue);
  return Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535
    ? { port: portNumber, token: tokenValue }
    : null;
}

/** LeagueClient lockfiles are five colon-separated fields and never Riot Client lockfiles. */
export function parseLeagueLockfile(raw: string): LcuConnection | null {
  const fields = raw.trim().split(':');
  if (fields.length !== 5 || fields[0] !== 'LeagueClient' || fields[4] !== 'https') return null;
  const port = Number(fields[2]);
  const token = fields[3];
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) return null;
  return { port, token };
}

export function lockfileCandidates(executablePath?: string): string[] {
  const candidates: string[] = [];
  if (executablePath) {
    const clientDir = path.dirname(executablePath);
    candidates.push(path.join(clientDir, 'lockfile'), path.join(clientDir, '..', 'lockfile'));
  }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[];
  for (const root of roots) {
    candidates.push(
      path.join(root, 'Riot Games', 'League of Legends', 'lockfile'),
      path.join(root, 'Riot Games', 'League of Legends', 'LeagueClient', 'lockfile'),
    );
  }
  return [...new Set(candidates)];
}

export function readLeagueLockfile(executablePath?: string): LcuConnection | null {
  for (const file of lockfileCandidates(executablePath)) {
    try {
      const connection = parseLeagueLockfile(fs.readFileSync(file, 'utf8'));
      if (connection) return connection;
    } catch {
      // The lockfile is optional and may disappear during a client relaunch.
    }
  }
  return null;
}

export function resolveLcuConnection(commandLine: string, executablePath?: string): LcuConnection | null {
  return parseLcuCommandLine(commandLine) ?? readLeagueLockfile(executablePath);
}

/** Normalize the JSON emitted by PowerShell, including its single-row shape. */
export function parseLeagueProcessRows(output: string): LeagueProcessSnapshot[] {
  const parsed: unknown = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    if (typeof row.name !== 'string') return [];
    return [{
      name: row.name,
      commandLine: typeof row.commandLine === 'string' ? row.commandLine : '',
      startedAt: typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) ? row.startedAt : Date.now(),
      executablePath: typeof row.executablePath === 'string' && row.executablePath ? row.executablePath : undefined,
    }];
  });
}
