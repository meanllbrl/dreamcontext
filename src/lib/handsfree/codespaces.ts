/**
 * GitHub Codespaces over REST — the ONE real {@link CloudProvider} (D1), plus the private
 * template repo `<owner>/dreamcontext-handsfree` ({@link TemplateRepo}).
 *
 * W0 item 8 proved create/start/stop/delete with a device-flow token of scopes `repo` +
 * `codespace`; the remaining quota is NOT readable without the `user` scope, so
 * {@link CodespacesProvider.remainingQuotaCoreMinutes} answers null and the laptop counts
 * uptime itself. W0: `idle_timeout_minutes` is fixed at creation (PATCH is ignored), so it
 * is set to the 240 maximum there (a backstop only, D15); retention is GitHub's own
 * `retention_expires_at` (AC22), never computed.
 *
 * `fetchImpl` is injectable: the tests run the whole surface with zero network. The token
 * is never logged and never put in an error message.
 */
import { gitBlobSha, ProviderError, ProviderQuotaError, type CloudProvider, type MachineInfo, type MachineState, type MachineType, type TemplateRepo } from './provider.js';

export const HANDSFREE_REPO_NAME = 'dreamcontext-handsfree';
export const DEFAULT_MACHINE = 'basicLinux32gb';
export const IDLE_TIMEOUT_MINUTES = 240;
export const RETENTION_PERIOD_MINUTES = 43_200;
export const DEVCONTAINER_PATH = '.devcontainer/devcontainer.json';
/** Codespaces' public port-forwarding domain (W0: `https://<name>-8080.app.github.dev`). */
export const PORT_FORWARDING_DOMAIN = 'app.github.dev';

type FetchImpl = typeof globalThis.fetch;

interface ApiCodespace {
  name?: string;
  state?: string;
  machine?: { name?: string } | null;
  web_url?: string;
  retention_expires_at?: string | null;
  last_used_at?: string | null;
}

function mapState(raw: string): MachineState {
  switch (raw) {
    case 'Available': return 'available';
    case 'Starting': case 'Queued': case 'Provisioning': case 'Awaiting': case 'Rebuilding': case 'Created': return 'starting';
    case 'ShuttingDown': return 'stopping';
    case 'Shutdown': return 'stopped';
    default: return 'other';
  }
}

/** First day of next month (UTC): when the free Codespaces quota resets for a personal account. */
export function nextQuotaReset(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export class GitHubApi {
  constructor(private readonly token: string, private readonly fetchImpl: FetchImpl = globalThis.fetch, private readonly base = 'https://api.github.com') {}

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ProviderError(`GitHub is unreachable (${(err as Error).name})`);
    }
    let json: unknown = null;
    const text = await res.text().catch(() => '');
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    return { status: res.status, json };
  }

  async login(): Promise<string> {
    const r = await this.call('GET', '/user');
    const login = (r.json as { login?: string } | null)?.login;
    if (r.status !== 200 || !login) throw new ProviderError(`GitHub /user failed (${r.status}); sign in again with \`dreamcontext handsfree setup\``, r.status);
    return login;
  }
}

function message(json: unknown): string {
  const m = (json as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m.slice(0, 300) : '';
}

/** 402, or a 403/422 whose message names billing, a spending limit or the quota. */
function isQuotaRefusal(status: number, json: unknown): boolean {
  if (status === 402) return true;
  return (status === 403 || status === 422) && /billing|spending limit|quota|payment/i.test(message(json));
}

export class CodespacesProvider implements CloudProvider, TemplateRepo {
  readonly kind = 'codespaces' as const;
  private readonly api: GitHubApi;
  private repoId: number | null = null;

  constructor(private readonly o: { token: string; owner: string; fetchImpl?: FetchImpl; repoName?: string; now?: () => Date }) {
    this.api = new GitHubApi(o.token, o.fetchImpl);
  }

  get repoFullName(): string {
    return `${this.o.owner}/${this.o.repoName ?? HANDSFREE_REPO_NAME}`;
  }

  private info(c: ApiCodespace): MachineInfo {
    const name = String(c.name ?? '');
    if (!/^[A-Za-z0-9-]{1,90}$/.test(name)) throw new ProviderError('GitHub returned a codespace without a usable name');
    const raw = String(c.state ?? 'Unknown');
    return {
      name,
      state: mapState(raw),
      rawState: raw,
      machine: c.machine?.name ?? DEFAULT_MACHINE,
      url: `https://${name}-8080.${PORT_FORWARDING_DOMAIN}`,
      webUrl: typeof c.web_url === 'string' ? c.web_url : `https://github.com/codespaces/${name}`,
      retentionExpiresAt: typeof c.retention_expires_at === 'string' ? c.retention_expires_at : null,
      lastUsedAt: typeof c.last_used_at === 'string' ? c.last_used_at : null,
    };
  }

  private quota(json: unknown): ProviderQuotaError {
    const reset = nextQuotaReset(this.o.now?.() ?? new Date());
    const why = message(json) || 'GitHub refused to start the codespace (quota or spending limit)';
    return new ProviderQuotaError(`${why}. The free quota resets around ${reset.slice(0, 10)}.`, reset);
  }

  async ensure(): Promise<string> {
    const full = this.repoFullName;
    const got = await this.api.call('GET', `/repos/${full}`);
    if (got.status === 200) {
      const j = got.json as { id?: number; private?: boolean };
      if (j.private !== true) throw new ProviderError(`${full} exists but is not private; hands-free mode refuses to use it`);
      this.repoId = typeof j.id === 'number' ? j.id : null;
      return full;
    }
    if (got.status !== 404) throw new ProviderError(`GitHub repo lookup failed (${got.status})`, got.status);
    const made = await this.api.call('POST', '/user/repos', {
      name: this.o.repoName ?? HANDSFREE_REPO_NAME,
      private: true,
      auto_init: true,
      description: 'dreamcontext hands-free mode: the devcontainer of your cloud machine (managed by dreamcontext).',
    });
    if (made.status !== 201) throw new ProviderError(`could not create ${full} (${made.status}): ${message(made.json)}`, made.status);
    this.repoId = (made.json as { id?: number }).id ?? null;
    return full;
  }

  private contentsPath(p: string): string {
    if (!/^[A-Za-z0-9._/-]+$/.test(p) || p.split('/').some((s) => s === '..' || s === '')) throw new ProviderError(`bad repo path ${p}`);
    return `/repos/${this.repoFullName}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
  }

  async blobShas(paths: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const p of paths) {
      const r = await this.api.call('GET', this.contentsPath(p));
      if (r.status === 404) { out[p] = null; continue; }
      if (r.status !== 200) throw new ProviderError(`reading ${p} from ${this.repoFullName} failed (${r.status})`, r.status);
      const sha = (r.json as { sha?: unknown }).sha;
      out[p] = typeof sha === 'string' ? sha : null;
    }
    return out;
  }

  async writeFiles(files: Record<string, Buffer>, msg: string): Promise<Record<string, string>> {
    const current = await this.blobShas(Object.keys(files));
    const out: Record<string, string> = {};
    for (const [p, bytes] of Object.entries(files)) {
      const want = gitBlobSha(bytes);
      if (current[p] !== want) {
        const r = await this.api.call('PUT', this.contentsPath(p), {
          message: msg,
          content: bytes.toString('base64'),
          ...(current[p] ? { sha: current[p] } : {}),
        });
        if (r.status !== 200 && r.status !== 201) throw new ProviderError(`writing ${p} to ${this.repoFullName} failed (${r.status}): ${message(r.json)}`, r.status);
      }
      out[p] = want;
    }
    return out;
  }

  async create(o: { machine: string }): Promise<MachineInfo> {
    if (this.repoId === null) await this.ensure();
    const r = await this.api.call('POST', '/user/codespaces', {
      repository_id: this.repoId,
      machine: o.machine,
      devcontainer_path: DEVCONTAINER_PATH,
      idle_timeout_minutes: IDLE_TIMEOUT_MINUTES,
      retention_period_minutes: RETENTION_PERIOD_MINUTES,
      display_name: 'dreamcontext hands-free',
    });
    if (isQuotaRefusal(r.status, r.json)) throw this.quota(r.json);
    if (r.status !== 201 && r.status !== 202) throw new ProviderError(`creating the codespace failed (${r.status}): ${message(r.json)}`, r.status);
    return this.info(r.json as ApiCodespace);
  }

  private path(name: string, suffix = ''): string {
    if (!/^[A-Za-z0-9-]{1,90}$/.test(name)) throw new ProviderError(`bad codespace name ${name}`);
    return `/user/codespaces/${name}${suffix}`;
  }

  async start(name: string): Promise<void> {
    const r = await this.api.call('POST', this.path(name, '/start'));
    if (isQuotaRefusal(r.status, r.json)) throw this.quota(r.json);
    // 409: already starting/available (GitHub refuses a start in a transitional state).
    if (r.status === 200 || r.status === 202 || r.status === 304 || r.status === 409) return;
    throw new ProviderError(`starting the codespace failed (${r.status}): ${message(r.json)}`, r.status);
  }

  async stop(name: string): Promise<void> {
    const r = await this.api.call('POST', this.path(name, '/stop'));
    if (r.status === 200 || r.status === 202 || r.status === 409 || r.status === 404) return;
    throw new ProviderError(`stopping the codespace failed (${r.status}): ${message(r.json)}`, r.status);
  }

  async delete(name: string): Promise<void> {
    const r = await this.api.call('DELETE', this.path(name));
    if (r.status === 202 || r.status === 204 || r.status === 404) return;
    throw new ProviderError(`deleting the codespace failed (${r.status}): ${message(r.json)}`, r.status);
  }

  async get(name: string): Promise<MachineInfo | null> {
    const r = await this.api.call('GET', this.path(name));
    if (r.status === 404) return null;
    if (r.status !== 200) throw new ProviderError(`reading the codespace failed (${r.status})`, r.status);
    return this.info(r.json as ApiCodespace);
  }

  async remainingQuotaCoreMinutes(): Promise<number | null> {
    return null; // W0 item 8: not readable with `repo` + `codespace`; the laptop counts uptime.
  }

  async machineTypes(): Promise<MachineType[]> {
    const r = await this.api.call('GET', `/repos/${this.repoFullName}/codespaces/machines`);
    if (r.status !== 200) return [];
    const list = (r.json as { machines?: Array<{ name?: string; cpus?: number; storage_in_bytes?: number }> }).machines ?? [];
    return list
      .filter((m) => typeof m.name === 'string')
      .map((m) => ({ name: m.name!, cpus: Number(m.cpus) || 0, storageBytes: Number(m.storage_in_bytes) || 0 }))
      .sort((a, b) => a.storageBytes - b.storageBytes || a.cpus - b.cpus);
  }
}
