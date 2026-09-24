import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface RunningProcess {
  pid: number;
  name: string;
  path?: string;
  startedAt?: number;
  hasWindow: boolean;
}

export interface ProcessSnapshot {
  foregroundPid?: number;
  processes: RunningProcess[];
}

function sourcePath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'windows-processes.cs');
  return path.join(__dirname, '..', 'resources', 'windows-processes.cs');
}

function compileHelper(): string | null {
  if (process.platform !== 'win32') return null;
  const windows = process.env.WINDIR ?? 'C:\\Windows';
  const compiler = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const source = sourcePath();
  const directory = path.join(app.getPath('userData'), 'windows-process-helper');
  const output = path.join(directory, 'windows-process-helper-v2.exe');
  if (!fs.existsSync(compiler) || !fs.existsSync(source)) return null;
  if (fs.existsSync(output)) return output;
  try {
    fs.mkdirSync(directory, { recursive: true });
    execFileSync(compiler, ['/nologo', '/target:exe', `/out:${output}`, source], {
      windowsHide: true, stdio: 'ignore', timeout: 15_000,
    });
    return fs.existsSync(output) ? output : null;
  } catch { return null; }
}

export class WindowsProcessScanner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelay = 1_000;
  private pending: ProcessSnapshot | null = null;

  start(onSnapshot: (snapshot: ProcessSnapshot) => void): boolean {
    const helper = compileHelper();
    if (!helper) return false;
    this.stopped = false;
    this.launch(helper, onSnapshot);
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
  }

  private launch(helper: string, onSnapshot: (snapshot: ProcessSnapshot) => void): void {
    if (this.stopped) return;
    this.buffer = '';
    this.pending = null;
    const child = spawn(helper, [], { windowsHide: true });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type === 'begin') {
            this.pending = {
              foregroundPid: typeof parsed.foregroundPid === 'number' ? parsed.foregroundPid : undefined,
              processes: [],
            };
          } else if (parsed.type === 'process' && this.pending
            && typeof parsed.pid === 'number' && typeof parsed.name === 'string') {
            this.pending.processes.push({
              pid: parsed.pid,
              name: parsed.name,
              path: typeof parsed.path === 'string' && parsed.path ? parsed.path : undefined,
              startedAt: typeof parsed.startedAt === 'number' && parsed.startedAt > 0 ? parsed.startedAt : undefined,
              hasWindow: parsed.hasWindow === true,
            });
          } else if (parsed.type === 'end' && this.pending) {
            const snapshot = this.pending;
            this.pending = null;
            this.restartDelay = 1_000;
            onSnapshot(snapshot);
          }
        } catch { /* wait for the next complete snapshot */ }
      }
    });
    const restart = () => {
      if (this.child === child) this.child = null;
      if (this.stopped || this.restartTimer) return;
      const delay = this.restartDelay;
      this.restartDelay = Math.min(this.restartDelay * 2, 60_000);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.launch(helper, onSnapshot);
      }, delay);
    };
    child.on('error', restart);
    child.on('exit', restart);
  }
}
