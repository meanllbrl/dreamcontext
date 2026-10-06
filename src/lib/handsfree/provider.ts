/**
 * The cloud machine behind hands-free mode, as the LAPTOP drives it.
 *
 * Exactly one real implementation exists: GitHub Codespaces (`codespaces.ts`, D1). The
 * {@link FakeCloudProvider} is the only other one: the round-trip verify script (wave 3
 * lane I) points it at a local cloud-mode server, and start/stop just flip its state.
 *
 * The provider never sees project content: it creates, starts, stops and deletes the
 * machine, reports its state and forwarded URL, and keeps the private template repo
 * (devcontainer + bootstrap verifiers) in the shape setup wrote it.
 */
import { createHash } from 'node:crypto';

export type MachineState = 'available' | 'starting' | 'stopping' | 'stopped' | 'other';

export interface MachineInfo {
  /** Provider-side name (the codespace name). */
  name: string;
  state: MachineState;
  /** Raw provider state, for messages. */
  rawState: string;
  /** Machine type (e.g. basicLinux32gb). */
  machine: string;
  /** Public origin of forwarded port 8080 (`https://<name>-8080.<domain>`), no trailing slash. */
  url: string;
  /** The provider's own page for the machine (the phone's Wake link starts it from there). */
  webUrl: string;
  /** When the provider deletes an unused machine (ISO), null when unknown (AC22). */
  retentionExpiresAt: string | null;
  lastUsedAt: string | null;
  /** The provider's last change of this machine (ISO; GitHub `updated_at`: a start or a stop). */
  updatedAt?: string | null;
}

export interface MachineType {
  name: string;
  cpus: number;
  storageBytes: number;
}

/** GitHub (or the fake) refused to start/create the machine for quota or billing reasons (AC23). */
export class ProviderQuotaError extends Error {
  constructor(message: string, readonly resetsAt: string | null) {
    super(message);
    this.name = 'ProviderQuotaError';
  }
}

export class ProviderError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface CloudProvider {
  readonly kind: 'codespaces' | 'fake';
  /** Create the machine from the template repo; the provider may start it right away. */
  create(o: { machine: string }): Promise<MachineInfo>;
  /** Start (no-op when already available/starting). Throws {@link ProviderQuotaError}. */
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Current state, or null when the provider no longer has it (GitHub deleted it). */
  get(name: string): Promise<MachineInfo | null>;
  /** Remaining quota in core-minutes, or null when the provider cannot tell (W0 item 8). */
  remainingQuotaCoreMinutes(): Promise<number | null>;
  /** Machine types the template repo may use (the disk-fit preflight names a bigger one). */
  machineTypes(): Promise<MachineType[]>;
}

/**
 * The private template repo (`<owner>/dreamcontext-handsfree`): the devcontainer files and
 * the bootstrap verifiers, written at setup and checked before every create/start (AC19).
 */
export interface TemplateRepo {
  /** Create the repo when missing; returns its full name (`owner/name`). */
  ensure(): Promise<string>;
  /** Write each file (repo path -> bytes) whose current blob differs; returns the git blob sha per path. */
  writeFiles(files: Record<string, Buffer>, message: string): Promise<Record<string, string>>;
  /** The repo's current blob sha per path (null = absent). */
  blobShas(paths: string[]): Promise<Record<string, string | null>>;
}

/** Cores per machine type, for the laptop's own uptime count when the quota is unreadable. */
export function coresFor(machine: string): number {
  const m = /^(?:basic|standard|premium|largePremium)Linux/i.exec(machine);
  if (!m) return 2;
  if (/^basic/i.test(machine)) return 2;
  if (/^standard/i.test(machine)) return 4;
  if (/^premium/i.test(machine)) return 8;
  return 16;
}

/**
 * In-memory provider for tests and the round-trip verify script. `url` is where the fake
 * cloud listens; `start`/`stop` flip the state and call the optional hooks (lane I starts
 * and stops its local cloud-mode server there).
 */
export class FakeCloudProvider implements CloudProvider, TemplateRepo {
  readonly kind = 'fake' as const;
  machines = new Map<string, MachineInfo>();
  repoFiles = new Map<string, Buffer>();
  /** Set to make the next start fail like GitHub's quota refusal. */
  quotaRefusal: ProviderQuotaError | null = null;
  quota: number | null = null;
  calls: string[] = [];
  private seq = 0;

  constructor(
    private readonly o: {
      url: string;
      onStart?: (name: string) => Promise<void> | void;
      onStop?: (name: string) => Promise<void> | void;
      types?: MachineType[];
    },
  ) {}

  async create(o: { machine: string }): Promise<MachineInfo> {
    this.calls.push(`create:${o.machine}`);
    if (this.quotaRefusal) throw this.quotaRefusal;
    const name = `fake-hf-${++this.seq}`;
    const info: MachineInfo = {
      name, state: 'stopped', rawState: 'Shutdown', machine: o.machine, url: this.o.url.replace(/\/+$/, ''),
      webUrl: `https://example.invalid/codespaces/${name}`, retentionExpiresAt: null, lastUsedAt: null, updatedAt: new Date().toISOString(),
    };
    this.machines.set(name, info);
    await this.start(name);
    return { ...this.machines.get(name)! };
  }

  async start(name: string): Promise<void> {
    this.calls.push(`start:${name}`);
    const m = this.machines.get(name);
    if (!m) throw new ProviderError(`no machine ${name}`, 404);
    if (this.quotaRefusal) throw this.quotaRefusal;
    if (m.state !== 'available') await this.o.onStart?.(name);
    m.state = 'available';
    m.rawState = 'Available';
    m.lastUsedAt = new Date().toISOString();
    m.updatedAt = m.lastUsedAt;
  }

  async stop(name: string): Promise<void> {
    this.calls.push(`stop:${name}`);
    const m = this.machines.get(name);
    if (!m) return;
    if (m.state === 'available') await this.o.onStop?.(name);
    m.state = 'stopped';
    m.rawState = 'Shutdown';
    m.updatedAt = new Date().toISOString();
  }

  async delete(name: string): Promise<void> {
    this.calls.push(`delete:${name}`);
    this.machines.delete(name);
  }

  async get(name: string): Promise<MachineInfo | null> {
    const m = this.machines.get(name);
    return m ? { ...m } : null;
  }

  async remainingQuotaCoreMinutes(): Promise<number | null> {
    return this.quota;
  }

  async machineTypes(): Promise<MachineType[]> {
    return this.o.types ?? [
      { name: 'basicLinux32gb', cpus: 2, storageBytes: 32 * 2 ** 30 },
      { name: 'standardLinux32gb', cpus: 4, storageBytes: 32 * 2 ** 30 },
      { name: 'premiumLinux', cpus: 8, storageBytes: 64 * 2 ** 30 },
    ];
  }

  async ensure(): Promise<string> {
    return 'fake/dreamcontext-handsfree';
  }

  async writeFiles(files: Record<string, Buffer>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [p, b] of Object.entries(files)) {
      this.repoFiles.set(p, b);
      out[p] = gitBlobSha(b);
    }
    return out;
  }

  async blobShas(paths: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const p of paths) {
      const b = this.repoFiles.get(p);
      out[p] = b ? gitBlobSha(b) : null;
    }
    return out;
  }
}

/** The git blob id (sha1) of `bytes`: what GitHub's contents API reports as `sha`. */
export function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
