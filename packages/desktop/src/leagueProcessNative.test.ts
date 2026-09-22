import { describe, expect, it } from 'vitest';
import { NATIVE_PROCESS_SCAN_COMMAND, parseNativeProcessOutput } from './leagueProcessNative';

describe('Windows League native process reader', () => {
  it('uses limited-information NtQueryInformationProcess instead of WMI', () => {
    expect(NATIVE_PROCESS_SCAN_COMMAND).toContain('NtQueryInformationProcess');
    expect(NATIVE_PROCESS_SCAN_COMMAND).toContain('PROCESS_QUERY_LIMITED_INFORMATION');
    expect(NATIVE_PROCESS_SCAN_COMMAND).not.toContain('Get-CimInstance');
  });

  it('keeps a client process when command-line access is denied', () => {
    expect(parseNativeProcessOutput(JSON.stringify({
      name: 'LeagueClientUx.exe',
      commandLine: '',
      executablePath: null,
      startedAt: 1760000000123,
    }))).toEqual([{
      name: 'LeagueClientUx.exe',
      commandLine: '',
      executablePath: undefined,
      startedAt: 1760000000123,
    }]);
  });

  it('preserves native command-line credentials when available', () => {
    expect(parseNativeProcessOutput(JSON.stringify({
      name: 'LeagueClientUx.exe',
      commandLine: '--app-port=8773 --remoting-auth-token=native-token',
      executablePath: 'E:/LOL CN/LeagueClientUx.exe',
      startedAt: 1760000000123,
    }))[0]?.commandLine).toContain('--remoting-auth-token=native-token');
  });
});
