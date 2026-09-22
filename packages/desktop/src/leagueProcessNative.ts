import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseLeagueProcessRows, type LeagueProcessSnapshot } from './leagueConnection';

const execFileAsync = promisify(execFile);

/**
 * Read process command lines through the same limited-information NT API used
 * by LeagueAkari. WMI command-line access is privilege-sensitive on Windows;
 * NtQueryInformationProcess works for ordinary desktop processes without UAC.
 */
export const NATIVE_PROCESS_SCAN_COMMAND = String.raw`$source = @'
using System;
using System.Runtime.InteropServices;

public static class BackspaceLeagueProcessNative {
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int ProcessCommandLineInformation = 60;

    [StructLayout(LayoutKind.Sequential)]
    private struct UNICODE_STRING {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength);

    public static string GetCommandLine(int processId) {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)processId);
        if (process == IntPtr.Zero) return "";

        IntPtr buffer = IntPtr.Zero;
        try {
            uint length;
            NtQueryInformationProcess(process, ProcessCommandLineInformation, IntPtr.Zero, 0, out length);
            if (length == 0) return "";
            buffer = Marshal.AllocHGlobal((int)length);
            if (NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer, length, out length) < 0) return "";
            UNICODE_STRING commandLine = (UNICODE_STRING)Marshal.PtrToStructure(buffer, typeof(UNICODE_STRING));
            if (commandLine.Buffer == IntPtr.Zero || commandLine.Length == 0) return "";
            return Marshal.PtrToStringUni(commandLine.Buffer, commandLine.Length / 2) ?? "";
        } catch {
            return "";
        } finally {
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            CloseHandle(process);
        }
    }
}
'@
$nativeReady = $false
try {
    Add-Type -TypeDefinition $source -ErrorAction Stop
    $nativeReady = $true
} catch {}
$names = @('LeagueClient.exe', 'LeagueClientUx.exe', 'League of Legends.exe', 'LeagueofLegends.exe')
Get-Process | Where-Object { $names -contains ($_.ProcessName + '.exe') } | ForEach-Object {
    $startedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    try { $startedAt = ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch {}
    $executablePath = $null
    try { $executablePath = $_.MainModule.FileName } catch {}
    [PSCustomObject]@{
        name = $_.ProcessName + '.exe'
        commandLine = if ($nativeReady) { [BackspaceLeagueProcessNative]::GetCommandLine($_.Id) } else { '' }
        executablePath = $executablePath
        startedAt = $startedAt
    }
} | ConvertTo-Json -Compress`;

export function parseNativeProcessOutput(output: string): LeagueProcessSnapshot[] {
  return parseLeagueProcessRows(output);
}

export async function readLeagueProcessesNative(): Promise<LeagueProcessSnapshot[]> {
  if (process.platform !== 'win32') return [];
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', NATIVE_PROCESS_SCAN_COMMAND],
    { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 },
  );
  const output = stdout.trim();
  return output ? parseNativeProcessOutput(output) : [];
}
