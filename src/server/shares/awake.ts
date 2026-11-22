/**
 * Live links keep the Mac awake (plan D12): ONE `caffeinate -i -w <serverPid>` child while any
 * share holds the awake hold, started at the first hold, stopped at the last release. No sudo;
 * `-w` ends it with the server even after a crash. It cannot cover a closed lid (the sheet says so).
 * Independent of Mac mode's own power hold (`armPower`, pmset): either ending leaves the other.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export type CaffeinateSpawn = (serverPid: number) => ChildProcess;

const defaultSpawn: CaffeinateSpawn = (serverPid) => spawn('/usr/bin/caffeinate', ['-i', '-w', String(serverPid)], {
  stdio: 'ignore', env: { PATH: '/usr/bin:/bin' },
});

export class AwakeHold {
  private holders = new Set<string>();
  private child: ChildProcess | null = null;

  constructor(private readonly opts: { serverPid?: number; spawnImpl?: CaffeinateSpawn; platform?: string } = {}) {}

  /** The share `id` holds the Mac awake (idempotent). */
  acquire(id: string): void {
    this.holders.add(id);
    this.ensure();
  }

  /** The share `id` lets go (idempotent); the last one stops caffeinate. */
  release(id: string): void {
    this.holders.delete(id);
    if (this.holders.size === 0) this.stop();
  }

  get held(): number { return this.holders.size; }
  get pid(): number | null { return this.child?.pid ?? null; }

  private ensure(): void {
    if (this.child || this.holders.size === 0) return;
    if ((this.opts.platform ?? process.platform) !== 'darwin' && !this.opts.spawnImpl) return;
    let child: ChildProcess;
    try { child = (this.opts.spawnImpl ?? defaultSpawn)(this.opts.serverPid ?? process.pid); } catch { return; }
    this.child = child;
    child.once('error', () => { if (this.child === child) this.child = null; });
    // It exited while shares are still open (killed by hand): start it again.
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      if (this.holders.size > 0) setTimeout(() => this.ensure(), 1000).unref?.();
    });
  }

  private stop(): void {
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null && c.signalCode === null) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  }
}
