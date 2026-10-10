const DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

export class VoiceReconnectController {
  private channel: string | null = null;
  private generation = 0;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private wakePending = false;

  constructor(
    private readonly owns: (channel: string) => boolean,
    private readonly attempt: (channel: string) => Promise<boolean>,
    private readonly online: () => boolean = () => navigator.onLine !== false,
  ) {}

  get retainedChannel(): string | null { return this.channel; }

  retain(channel: string): void {
    if (this.channel !== channel) this.cancel();
    this.channel = channel;
    this.attempts = 0;
    this.wakePending = false;
    this.clearTimers();
  }

  cancel(): void {
    this.generation++;
    this.channel = null;
    this.busy = false;
    this.wakePending = false;
    this.attempts = 0;
    this.clearTimers();
  }

  sdkReconnecting(): void {
    if (!this.channel || this.watchdog || this.busy) return;
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      this.schedule(0);
    }, 30_000);
  }

  schedule(delay?: number): void {
    const channel = this.channel;
    if (!channel || !this.owns(channel)) { this.cancel(); return; }
    if (this.busy) {
      if (delay === 0) this.wakePending = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
    const wait = delay ?? DELAYS[Math.min(this.attempts++, DELAYS.length - 1)] * (0.8 + Math.random() * 0.2);
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, wait);
  }

  private async run(): Promise<void> {
    const channel = this.channel;
    const generation = this.generation;
    if (!channel || !this.owns(channel)) { this.cancel(); return; }
    if (!this.online()) return;
    this.busy = true;
    let success = false;
    try { success = await this.attempt(channel); }
    catch { /* The hook owns error classification and UI state. */ }
    if (generation !== this.generation) return;
    this.busy = false;
    const wake = this.wakePending;
    this.wakePending = false;
    if (success) { this.attempts = 0; this.clearTimers(); }
    else this.schedule(wake ? 0 : undefined);
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.timer = undefined;
    this.watchdog = undefined;
  }
}
