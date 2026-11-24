/**
 * ANTIGRAVITY'S MODELS, AS THE RUNTIME ON THIS MAC REPORTS THEM (super/gemini-modeller).
 *
 * The picker, the Super's `## Tools on this Mac` and Settings > Models used to read T3's bundled
 * `model-manifest.json`: a list frozen when T3 was vendored (Gemini 3.8/3.7/3.6 Flash, 3.1 Pro).
 * The runtime itself answers differently, per Google account: on 2026-11-22 runtime 1.4.1 and
 * 1.5.0 both offered Gemini 3.8 Flash (thinking low/medium/high), Claude Sonnet 4.6, Claude Opus
 * 4.6 and GPT-OSS 120B, and no longer 3.7, 3.6 or 3.1 Pro. So the list is the runtime's answer:
 * one probe (start the agent, `initialize`, `authenticate`, `session/new`, read the catalogue,
 * kill it, remove the session's files; no prompt is ever sent), cached on disk and refreshed in
 * the background. A model Google adds shows up at the next refresh, with no dreamcontext release.
 *
 * Both id shapes are read: runtime 1.3 lists effort in the id (`gemini-3.8-flash-high`); 1.4+
 * lists the family (`gemini-3.8-flash`) with a separate `thought_level` option and still lists
 * the 1.3-style ids in `models.availableModels`, which the agent accepts (AntigravityAcpSupport
 * `legacyAntigravityFamily`). The picker and `super delegate --model` keep one id per choice.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { antigravityProfileDir, t3StateRoot } from './antigravity-accounts.js';
import { listInstanceAccounts } from './instance-accounts.js';

export interface AntigravityModel {
  readonly id: string;
  readonly label: string;
}

export interface AntigravityCatalog {
  readonly checkedAt: number;
  readonly version: string | null;
  /** The account that answered: the list is per Google account, so another account re-asks. */
  readonly account?: string;
  readonly defaultModel: string | null;
  readonly models: readonly AntigravityModel[];
}

/** A fresh list is trusted this long; after it the next read starts a background refresh. */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
/** A probe that failed is not retried before this. */
export const RETRY_MS = 30 * 60 * 1000;
/** The agent unpacks itself on start (~8 s measured); give up well before a stuck one matters. */
const PROBE_TIMEOUT_MS = 90_000;
/** A model id that may reach a prompt or a picker: one token, never a line of text. */
const SAFE_ID = /^[A-Za-z0-9._[\]-]{1,80}$/;
const MAX_MODELS = 64;

export const catalogFile = (home: string = homedir()): string => join(t3StateRoot(home), 'antigravity-models.json');

const clean = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

// ─── Reading the runtime's answer ────────────────────────────────────────────────────────

interface SelectEntry { value?: unknown; name?: unknown; options?: unknown }
interface ConfigOption { id?: unknown; category?: unknown; type?: unknown; currentValue?: unknown; options?: unknown }

function selectEntries(o: ConfigOption | undefined): { value: string; name: string }[] {
  if (!o || o.type !== 'select' || !Array.isArray(o.options)) return [];
  return (o.options as SelectEntry[]).flatMap((e) => ('value' in e ? [e] : Array.isArray(e.options) ? (e.options as SelectEntry[]) : []))
    .map((e) => ({ value: clean(e.value, 80), name: clean(e.name, 80) }))
    .filter((e) => e.value);
}

/**
 * The models a `session/new` answer offers, in the runtime's order, deduplicated. Pure: the tests
 * drive it with a 1.3 and a 1.4 answer. `models.availableModels` (the agent's own selectable ids,
 * 1.3-style effort ids included) comes first; a `model` option value it does not cover is added.
 * With no 1.3-style ids listed, the selected 1.4 family gets one id per `thought_level` level
 * (the shape the agent accepts); a family whose levels were not reported is listed as it is.
 */
export function catalogFromSession(result: unknown): { defaultModel: string | null; models: AntigravityModel[] } {
  const r = (result && typeof result === 'object' ? result : {}) as { configOptions?: unknown; models?: { availableModels?: unknown; currentModelId?: unknown } };
  const options = (Array.isArray(r.configOptions) ? r.configOptions : []) as ConfigOption[];
  const modelOpt = options.find((o) => o.id === 'model' || o.category === 'model');
  const thinking = options.find((o) => o.category === 'thought_level');
  const levels = selectEntries(thinking);
  const levelNames = [...new Set([...levels.map((l) => l.value), 'low', 'medium', 'high'])];
  const out: AntigravityModel[] = [];
  const seen = new Set<string>();
  const add = (id: string, label: string): void => {
    if (!SAFE_ID.test(id) || seen.has(id) || out.length >= MAX_MODELS) return;
    seen.add(id);
    out.push({ id, label: label || id });
  };
  const listed = Array.isArray(r.models?.availableModels) ? (r.models!.availableModels as Array<{ modelId?: unknown; name?: unknown }>) : [];
  for (const m of listed) add(clean(m.modelId, 80), clean(m.name, 80));
  for (const e of selectEntries(modelOpt)) {
    // Thinking levels are reported for the selected model only: only that family is expanded.
    const expanded = levels.length > 0 && !listed.length && e.value === modelOpt?.currentValue
      ? levels.map((l) => ({ id: `${e.value}-${l.value}`, label: `${e.name || e.value} (${l.name || l.value})` }))
      : [];
    // A family is covered by its own id or its 1.3-style level ids, never by any id it prefixes
    // (`claude-sonnet-4-6` is not covered by a `claude-sonnet-4-6-thinking`).
    const covered = seen.has(e.value) || levelNames.some((l) => seen.has(`${e.value}-${l}`));
    if (covered) continue;
    if (expanded.length) for (const x of expanded) add(x.id, x.label);
    else add(e.value, e.name);
  }
  const current = clean(r.models?.currentModelId, 80);
  const family = typeof modelOpt?.currentValue === 'string' ? clean(modelOpt.currentValue, 80) : '';
  const level = typeof thinking?.currentValue === 'string' ? clean(thinking.currentValue, 20) : '';
  const guess = [current, family && level ? `${family}-${level}` : '', family].find((id) => id && seen.has(id));
  return { defaultModel: guess ?? out[0]?.id ?? null, models: out };
}

// ─── The cache ───────────────────────────────────────────────────────────────────────────

/** The cached catalogue, or null when there is none or it does not parse. Never throws. */
export function readAntigravityCatalog(home: string = homedir()): AntigravityCatalog | null {
  try {
    const j = JSON.parse(readFileSync(catalogFile(home), 'utf-8')) as Partial<AntigravityCatalog>;
    if (typeof j.checkedAt !== 'number' || !Array.isArray(j.models)) return null;
    const models = j.models
      .map((m) => ({ id: clean((m as AntigravityModel).id, 80), label: clean((m as AntigravityModel).label, 80) }))
      .filter((m) => SAFE_ID.test(m.id))
      .slice(0, MAX_MODELS)
      .map((m) => ({ id: m.id, label: m.label || m.id }));
    if (!models.length) return null;
    const dflt = typeof j.defaultModel === 'string' && models.some((m) => m.id === j.defaultModel) ? j.defaultModel : models[0]!.id;
    return { checkedAt: j.checkedAt, version: typeof j.version === 'string' ? j.version.slice(0, 32) : null, ...(typeof j.account === 'string' ? { account: j.account.slice(0, 64) } : {}), defaultModel: dflt, models };
  } catch {
    return null;
  }
}

export function writeAntigravityCatalog(c: AntigravityCatalog, home: string = homedir()): void {
  const file = catalogFile(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// ─── The probe ───────────────────────────────────────────────────────────────────────────

export interface ManagedRuntime { readonly version: string | null; readonly executable: string; readonly harness: string }

/** T3's managed runtime on this Mac (`active.json` -> its version folder), or null. */
export function managedRuntime(home: string = homedir(), platform: string = process.platform, arch: string = process.arch): ManagedRuntime | null {
  try {
    const root = join(t3StateRoot(home), 'tools', 'antigravity-acp', `${platform}-${arch}`);
    const id = String((JSON.parse(readFileSync(join(root, 'active.json'), 'utf-8')) as { releaseId?: unknown }).releaseId ?? '');
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const dir = join(root, 'versions', id);
    const r = JSON.parse(readFileSync(join(dir, '.install-complete.json'), 'utf-8')) as { version?: unknown; executable?: { name?: unknown }; harness?: { name?: unknown } };
    const exe = r.executable?.name, harness = r.harness?.name;
    if (typeof exe !== 'string' || exe !== basename(exe) || typeof harness !== 'string' || harness !== basename(harness)) return null;
    return { version: typeof r.version === 'string' ? r.version.slice(0, 32) : null, executable: join(dir, exe), harness: join(dir, harness) };
  } catch {
    return null;
  }
}

export type Spawner = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

/** Keys T3 strips before it starts the agent (antigravityAuthSupport): a stray API key would win over the account. */
const DROPPED_ENV = new Set(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_HOME']);

/**
 * Ask the runtime once. Resolves the parsed answer, or null when the agent does not start, the
 * account is not signed in, or it does not answer in time. The temp workspace and the session's
 * files in the profile (matched by that workspace, as T3's `removeAntigravitySessionFiles` does)
 * are removed either way.
 */
export function probeAntigravity(i: { runtime: ManagedRuntime; profileDir: string; spawn?: Spawner; timeoutMs?: number; platform?: string }): Promise<{ defaultModel: string | null; models: AntigravityModel[] } | null> {
  const platform = i.platform ?? process.platform;
  const cwd = mkdtempSync(join(tmpdir(), PROBE_PREFIX));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROPPED_ENV.has(k.toUpperCase())) env[k] = v;
  Object.assign(env, {
    GEMINI_HOME: i.profileDir,
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    ANTIGRAVITY_HARNESS_PATH: i.runtime.harness,
    // Never a browser: the probe only runs on a signed-in account, and a sign-in is the owner's.
    BROWSER: platform === 'win32' ? 'rem' : '/usr/bin/true',
    PYTHONUNBUFFERED: '1',
    ELECTRON_RUN_AS_NODE: '1',
    ...(platform === 'win32' ? { TEMP: cwd, TMP: cwd } : { TMPDIR: cwd }),
  });
  // Linux: the agent's bundled Python may look for certificates where this distribution has none (T3 does the same).
  if (platform === 'linux' && env.SSL_CERT_FILE === undefined && env.SSL_CERT_DIR === undefined) {
    const ca = [env.NIX_SSL_CERT_FILE, '/etc/ssl/certs/ca-bundle.crt', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'].find((p) => p && existsSync(p));
    if (ca) env.SSL_CERT_FILE = ca;
  }
  const spawn: Spawner = i.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }));
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    let sessionId = '';
    let done = false;
    const finish = (v: { defaultModel: string | null; models: AntigravityModel[] } | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Asked to stop first, forced after a second (as T3 stops it), then what the probe made goes.
      try { child?.kill('SIGTERM'); } catch { /* gone */ }
      const force = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } }, 1000);
      setTimeout(() => {
        clearTimeout(force);
        try { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
        void removeProbeFiles(i.profileDir, sessionId, cwd).then(() => resolve(v));
      }, 1100);
    };
    const timer = setTimeout(() => finish(null), i.timeoutMs ?? PROBE_TIMEOUT_MS);
    try {
      child = spawn(i.runtime.executable, platform === 'linux' ? ['--uid='] : [], { cwd, env });
    } catch {
      finish(null);
      return;
    }
    const waiters = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
    let next = 0;
    let buf = '';
    const call = (method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> => new Promise((res) => {
      const id = ++next;
      waiters.set(id, res);
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); } catch { finish(null); }
    });
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stderr.on('data', () => { /* drained, never shown */ });
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf-8');
      if (buf.length > 8 * 1024 * 1024) { finish(null); return; }
      let n: number;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n);
        buf = buf.slice(n + 1);
        try {
          const m = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown; method?: unknown };
          if (typeof m.id === 'number' && waiters.has(m.id) && m.method === undefined) { waiters.get(m.id)!(m); waiters.delete(m.id); }
        } catch { /* not a frame */ }
      }
    });
    void (async () => {
      const init = await call('initialize', { protocolVersion: 1, clientInfo: { name: 'zed', version: '0.0.0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (init.error) return finish(null);
      const auth = await call('authenticate', { methodId: 'oauth-personal' });
      if (auth.error) return finish(null);
      const s = await call('session/new', { cwd, mcpServers: [] });
      if (s.error || !s.result) return finish(null);
      const sid = (s.result as { sessionId?: unknown }).sessionId;
      if (typeof sid === 'string') sessionId = sid;
      const parsed = catalogFromSession(s.result);
      finish(parsed.models.length ? parsed : null);
    })();
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The probe's temp workspace, and its session's files when their `.meta` names that workspace. */
export async function removeProbeFiles(profileDir: string, sessionId: string, cwd: string): Promise<void> {
  try {
    if (UUID.test(sessionId)) {
      const acp = join(profileDir, 'antigravity-acp');
      const base = join(acp, 'conversations', sessionId);
      const meta = JSON.parse(readFileSync(`${base}.meta`, 'utf-8')) as { cwd?: unknown };
      if (meta.cwd === cwd) {
        for (const s of ['.db', '.db-wal', '.db-shm', '.db-journal', '.meta']) rmSync(`${base}${s}`, { force: true });
        rmSync(join(acp, 'brain', sessionId), { recursive: true, force: true });
      }
    }
  } catch { /* no session files, or not ours */ }
  // The agent unpacks itself here (~1 GB): removed off the event loop.
  try { await rm(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
}

const PROBE_PREFIX = 'dc-agy-models-';
/** A probe workspace older than this was left by a server that died mid-probe. */
const STALE_PROBE_MS = 60 * 60 * 1000;

/** Remove probe workspaces a dead server left behind (never one younger than an hour). */
export async function sweepStaleProbes(dir: string = tmpdir(), now: number = Date.now()): Promise<void> {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.startsWith(PROBE_PREFIX)); } catch { return; }
  for (const n of names) {
    try {
      const p = join(dir, n);
      if (now - statSync(p).mtimeMs > STALE_PROBE_MS) await rm(p, { recursive: true, force: true });
    } catch { /* next */ }
  }
}

// ─── Refresh ─────────────────────────────────────────────────────────────────────────────

let inFlight: Promise<AntigravityCatalog | null> | null = null;
let failedAt = 0;

/** Tests only: forget the in-process refresh state. */
export function _resetAntigravityRefresh(): void { inFlight = null; failedAt = 0; }

/**
 * Re-ask the runtime when the cached list is missing or older than {@link CATALOG_TTL_MS} (or
 * `force`), at most one probe at a time, not again within {@link RETRY_MS} of a failure. Only a
 * signed-in account on T3's managed runtime is asked. Never throws; resolves what the cache holds after.
 */
export function refreshAntigravityModels(o: { home?: string; force?: boolean; now?: number; spawn?: Spawner; runtime?: ManagedRuntime | null } = {}): Promise<AntigravityCatalog | null> {
  const home = o.home ?? homedir();
  const now = o.now ?? Date.now();
  const cached = readAntigravityCatalog(home);
  const runtime = o.runtime === undefined ? managedRuntime(home) : o.runtime;
  const account = listInstanceAccounts('antigravity', home).find((a) => a.signedIn);
  // Stale = old, or answered by another account or another runtime than the one here now.
  const same = !!cached && (!account || cached.account === undefined || cached.account === account.id) && (!runtime || cached.version === runtime.version);
  if (!o.force && cached && same && now - cached.checkedAt < CATALOG_TTL_MS) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  if (!o.force && failedAt && now - failedAt < RETRY_MS) return Promise.resolve(cached);
  if (!runtime || !account) return Promise.resolve(cached);
  inFlight = (async () => {
    try {
      await sweepStaleProbes();
      const got = await probeAntigravity({ runtime, profileDir: antigravityProfileDir(account.id, home), ...(o.spawn ? { spawn: o.spawn } : {}) });
      if (!got) { failedAt = Date.now(); return cached; }
      const c: AntigravityCatalog = { checkedAt: Date.now(), version: runtime.version, account: account.id, defaultModel: got.defaultModel, models: got.models };
      writeAntigravityCatalog(c, home);
      failedAt = 0;
      return c;
    } catch {
      failedAt = Date.now();
      return cached;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
