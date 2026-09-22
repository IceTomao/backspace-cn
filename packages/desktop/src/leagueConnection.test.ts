import { describe, expect, it } from 'vitest';
import {
  parseLeagueLockfile,
  parseLeagueProcessRows,
  parseLcuCommandLine,
  resolveLcuConnection,
} from './leagueConnection';

describe('League LCU connection discovery', () => {
  it('parses standard LeagueClient command-line credentials', () => {
    expect(parseLcuCommandLine('--app-port=8773 --remoting-auth-token=secret-token --no-crashpad')).toEqual({
      port: 8773,
      token: 'secret-token',
    });
  });

  it('accepts quoted command-line values', () => {
    expect(parseLcuCommandLine('--app-port="8773" --remoting-auth-token="secret token"')).toEqual({
      port: 8773,
      token: 'secret token',
    });
  });

  it('accepts Tencent LeagueClientUx arguments quoted as a whole', () => {
    expect(parseLcuCommandLine('"--remoting-auth-token=native-token" "--app-port=3611"')).toEqual({
      port: 3611,
      token: 'native-token',
    });
  });

  it('rejects incomplete or out-of-range command-line credentials', () => {
    expect(parseLcuCommandLine('--app-port=8773')).toBeNull();
    expect(parseLcuCommandLine('--app-port=70000 --remoting-auth-token=secret')).toBeNull();
  });

  it('parses only a complete LeagueClient lockfile', () => {
    expect(parseLeagueLockfile('LeagueClient:1234:8773:secret-token:https')).toEqual({
      port: 8773,
      token: 'secret-token',
    });
    expect(parseLeagueLockfile('')).toBeNull();
    expect(parseLeagueLockfile('LeagueClient:1234:not-a-port:secret:https')).toBeNull();
    expect(parseLeagueLockfile('LeagueClient:1234:8773::https')).toBeNull();
    expect(parseLeagueLockfile('Riot Client:1234:8773:riot-token:https')).toBeNull();
    expect(parseLeagueLockfile('LeagueClient:1234:8773:secret:http')).toBeNull();
  });

  it('prefers process credentials over a lockfile', () => {
    expect(resolveLcuConnection(
      '--app-port=8773 --remoting-auth-token=process-token',
      'C:/Games/LeagueClient.exe',
    )).toEqual({ port: 8773, token: 'process-token' });
  });

  it('normalizes a single PowerShell process row and preserves its timestamp', () => {
    expect(parseLeagueProcessRows(JSON.stringify({
      name: 'LeagueClient.exe',
      commandLine: '',
      executablePath: 'E:/LOL CN/LeagueClient.exe',
      startedAt: 1760000000123,
    }))).toEqual([{
      name: 'LeagueClient.exe',
      commandLine: '',
      executablePath: 'E:/LOL CN/LeagueClient.exe',
      startedAt: 1760000000123,
    }]);
  });
});
