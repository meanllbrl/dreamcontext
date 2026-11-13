import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLOUD_DISCLOSURE_VERSION, eligibleTypesHash } from './embeddings/egress-rules.js';
import { ensureSelfIgnoredDir } from './embeddings/ignored-dir.js';
import { readIndexStop } from './embeddings/index-stop.js';
import { spawnMarkerFromEnv } from './session-origin.js';
import { voiceApiKey } from './voice/config.js';

/**
 * Machine-level state of the cloud recall tiers, all under `~/.dreamcontext/` and never in a vault
 * (a vault can be team-synced; a key or a consent must not travel with it). Every function takes
 * an injectable `home` so tests never touch the real one.
 *
 *   recall-cloud.json         key + spend caps + per-vault consent          (0600)
 *   recall-cloud-usage.json   daily query counter, index spend, eval spend  (0600)
 *   recall-cloud-audit.log    one JSON line per grant/revoke/key event      (0600), never the key
 *
 * The recall key is its own secret. It is read from the file, then from DREAMCONTEXT_RECALL_OPENROUTER_KEY.
 * The Voice key and the generic OPENROUTER_API_KEY are never read implicitly; copying the Voice key is
 * an explicit action (`copyVoiceKeyToRecall`).
 */

export type CloudTier = 'cloud-index' | 'cloud';
export type RecallTier = 'local' | CloudTier;
export type RerankModel = 'voyageai/rerank-2.5' | 'voyageai/rerank-2.5-lite';
export type ConsentSurface = 'cli-tty' | 'dashboard';
export type KeySource = 'file' | 'env';
export type KeyOrigin = 'manual' | 'voice-copy' | 'env-copy';
export type UsageKind = 'index' | 'query' | 'rerank' | 'eval';

export const RECALL_KEY_ENV = 'DREAMCONTEXT_RECALL_OPENROUTER_KEY';
export const EVAL_MAX_USD_ENV = 'DREAMCONTEXT_EVAL_MAX_USD';
export const RERANK_MODELS: readonly RerankModel[] = ['voyageai/rerank-2.5', 'voyageai/rerank-2.5-lite'];
/** What a corrupt usage file reads as: spend "at the ceiling", so every cap trips (fail closed). */
export const AT_CEILING = Number.MAX_SAFE_INTEGER;
/** Consecutive churned automatic builds after which status and doctor REPORT churn (never a pause). */
export const CHURN_STRIKE_LIMIT = 3;
/**
 * The churn rule the meta's strikes were counted under. 2: docs are keyed uniquely (recall.ts `docKey`),
 * so a task's side files no longer evict each other. Strikes from rule 1 were that bug, not churn: a meta
 * without rule 2 starts at zero, and its first build (re-embedding what the collision evicted) is the
 * baseline, never a strike.
 */
export const CHURN_RULE = 2;
/** The cloud index's meta file (written by vector-store.ts; read here for status only). */
export const CLOUD_META_FILE = 'voyage-4.meta.json';

export interface VaultCloudConsent {
  tier: CloudTier;
  consentedAt: string;
  surface: ConsentSurface;
  embedModel: 'voyageai/voyage-4';
  rerankModel: RerankModel | null;
  disclosureVersion: number;
  eligibleTypesHash: string;
}

export interface RecallCloudSpend {
  maxIndexUsd: number;
  maxIndexUsd24h: number;
  maxQueriesPerDay: number;
  maxEvalUsd: number;
}

export interface RecallCloudConfig {
  openRouterKey?: string;
  keyOrigin?: KeyOrigin;
  keySetAt?: string;
  spend: RecallCloudSpend;
  vaults: Record<string, VaultCloudConsent>;
}

export interface RecallCloudUsage {
  day: string;
  /** One counter per vault. Unlocked read-modify-write: overshoot is at most the number of concurrent prompts. */
  queriesToday: Record<string, number>;
  indexSpend: Array<{ at: string; vault: string; usd: number; auto: boolean }>;
  evalSpentUsd: number;
  lifetimeUsd: number;
  /** Lifetime USD per vault key (additive to the pinned shape; feeds `status`). */
  vaultUsd?: Record<string, number>;
  /** The file exists but could not be read: every spend reads as at-ceiling and nothing is written. */
  corrupt?: true;
}

export const DEFAULT_SPEND: RecallCloudSpend = {
  maxIndexUsd: 1,
  maxIndexUsd24h: 2,
  maxQueriesPerDay: 1000,
  maxEvalUsd: 5,
};

const TIER_ORDER: Record<RecallTier, number> = { local: 0, 'cloud-index': 1, cloud: 2 };

/** The lower of two tiers (`local < cloud-index < cloud`). */
export function minTier(a: RecallTier, b: RecallTier): RecallTier {
  return TIER_ORDER[a] <= TIER_ORDER[b] ? a : b;
}

// ── paths ────────────────────────────────────────────────────────────────────

const dcDir = (home: string): string => join(home, '.dreamcontext');
export const recallCloudConfigPath = (home: string = homedir()): string => join(dcDir(home), 'recall-cloud.json');
const usagePath = (home: string): string => join(dcDir(home), 'recall-cloud-usage.json');
const auditPath = (home: string): string => join(dcDir(home), 'recall-cloud-audit.log');

/** Where eval snapshots live; the only roots `evalConsent` may ever apply to. */
export function evalFrozenDir(home: string = homedir()): string {
  return join(dcDir(home), 'eval-frozen');
}

/** Atomic 0600 write: temp file → rename, so a reader never sees a half file. */
function writeAtomic0600(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, filePath);
}

// ── config ───────────────────────────────────────────────────────────────────

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function parseConsent(raw: unknown): VaultCloudConsent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.tier !== 'cloud-index' && r.tier !== 'cloud') return null;
  if (typeof r.consentedAt !== 'string' || typeof r.eligibleTypesHash !== 'string') return null;
  if (typeof r.disclosureVersion !== 'number') return null;
  const rerank = RERANK_MODELS.includes(r.rerankModel as RerankModel) ? (r.rerankModel as RerankModel) : null;
  return {
    tier: r.tier,
    consentedAt: r.consentedAt,
    surface: r.surface === 'dashboard' ? 'dashboard' : 'cli-tty',
    embedModel: 'voyageai/voyage-4',
    rerankModel: r.tier === 'cloud-index' ? null : rerank,
    disclosureVersion: r.disclosureVersion,
    eligibleTypesHash: r.eligibleTypesHash,
  };
}

/** Read the config. Missing or corrupt → defaults (no key, no consent): a broken file must degrade to local. */
export function readRecallCloudConfig(home: string = homedir()): RecallCloudConfig {
  const empty: RecallCloudConfig = { spend: { ...DEFAULT_SPEND }, vaults: {} };
  const path = recallCloudConfigPath(home);
  if (!existsSync(path)) return empty;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const raw = parsed as Record<string, unknown>;
    const spendRaw = (raw.spend && typeof raw.spend === 'object' ? raw.spend : {}) as Record<string, unknown>;
    const cfg: RecallCloudConfig = {
      spend: {
        maxIndexUsd: num(spendRaw.maxIndexUsd, DEFAULT_SPEND.maxIndexUsd),
        maxIndexUsd24h: num(spendRaw.maxIndexUsd24h, DEFAULT_SPEND.maxIndexUsd24h),
        maxQueriesPerDay: num(spendRaw.maxQueriesPerDay, DEFAULT_SPEND.maxQueriesPerDay),
        maxEvalUsd: num(spendRaw.maxEvalUsd, DEFAULT_SPEND.maxEvalUsd),
      },
      vaults: {},
    };
    if (typeof raw.openRouterKey === 'string' && raw.openRouterKey.trim()) {
      cfg.openRouterKey = raw.openRouterKey.trim();
      if (raw.keyOrigin === 'manual' || raw.keyOrigin === 'voice-copy' || raw.keyOrigin === 'env-copy') cfg.keyOrigin = raw.keyOrigin;
      if (typeof raw.keySetAt === 'string') cfg.keySetAt = raw.keySetAt;
    }
    if (raw.vaults && typeof raw.vaults === 'object') {
      for (const [k, v] of Object.entries(raw.vaults as Record<string, unknown>)) {
        const consent = parseConsent(v);
        if (consent) cfg.vaults[k] = consent;
      }
    }
    return cfg;
  } catch {
    return empty;
  }
}

function writeConfig(cfg: RecallCloudConfig, home: string): void {
  writeAtomic0600(recallCloudConfigPath(home), `${JSON.stringify(cfg, null, 2)}\n`);
}

/**
 * The key, or null: the file first, then DREAMCONTEXT_RECALL_OPENROUTER_KEY. CALLED ONLY by
 * embeddings/openrouter.ts (an architecture test pins that); everything else uses
 * {@link recallCloudKeyInfo}. Neither OPENROUTER_API_KEY nor voice.json is ever read here.
 */
export function recallCloudApiKey(home: string = homedir()): { key: string; source: KeySource } | null {
  const stored = readRecallCloudConfig(home).openRouterKey;
  if (stored) return { key: stored, source: 'file' };
  const env = process.env[RECALL_KEY_ENV];
  return env && env.trim() ? { key: env.trim(), source: 'env' } : null;
}

/** What the rest of the product may know about the key: that it exists, and where it came from. */
export function recallCloudKeyInfo(home: string = homedir()): { present: boolean; source: KeySource | null; origin: KeyOrigin | null } {
  const cfg = readRecallCloudConfig(home);
  if (cfg.openRouterKey) return { present: true, source: 'file', origin: cfg.keyOrigin ?? 'manual' };
  const env = process.env[RECALL_KEY_ENV];
  if (env && env.trim()) return { present: true, source: 'env', origin: null };
  return { present: false, source: null, origin: null };
}

/** Store (or clear, with null) the recall key. Callers append the audit event with their own surface. */
export function setRecallCloudKey(key: string | null, origin: KeyOrigin, home: string = homedir()): void {
  const cfg = readRecallCloudConfig(home);
  if (key === null || !key.trim()) {
    delete cfg.openRouterKey;
    delete cfg.keyOrigin;
    delete cfg.keySetAt;
  } else {
    cfg.openRouterKey = key.trim();
    cfg.keyOrigin = origin;
    cfg.keySetAt = new Date().toISOString();
  }
  writeConfig(cfg, home);
}

/** Explicit copy of the Voice key into the recall key. False when there is no Voice key. */
export function copyVoiceKeyToRecall(home: string = homedir()): boolean {
  const key = voiceApiKey(home);
  if (!key) return false;
  setRecallCloudKey(key, 'voice-copy', home);
  return true;
}

// ── vault identity + consent ─────────────────────────────────────────────────

const VAULT_ID_FILE = '.vault-id';

/**
 * The consent key of a vault: its real path plus a random id kept in `.embeddings/.vault-id`
 * (self-ignored, so it never syncs). A copied or moved vault therefore never inherits consent.
 * Null when the root cannot be resolved or has no id and `create` is not set.
 */
export function vaultConsentKey(contextRoot: string, o: { create?: boolean } = {}): string | null {
  let real: string;
  try {
    real = realpathSync.native(contextRoot);
  } catch {
    return null;
  }
  const dir = join(real, '.embeddings');
  const idPath = join(dir, VAULT_ID_FILE);
  try {
    if (existsSync(idPath)) {
      const id = readFileSync(idPath, 'utf-8').trim();
      return /^[0-9a-f]{16,}$/.test(id) ? `${real}#${id}` : null;
    }
    if (!o.create) return null;
    ensureSelfIgnoredDir(dir);
    const id = randomBytes(16).toString('hex');
    writeFileSync(idPath, `${id}\n`, { mode: 0o600 });
    return `${real}#${id}`;
  } catch {
    return null;
  }
}

type RawConsent = { state: 'none' } | { state: 'stale' } | { state: 'valid'; consent: VaultCloudConsent };

function rawConsent(contextRoot: string, cfg: RecallCloudConfig): RawConsent {
  const key = vaultConsentKey(contextRoot);
  const entry = key ? cfg.vaults[key] : undefined;
  if (entry) {
    const ok = entry.disclosureVersion === CLOUD_DISCLOSURE_VERSION && entry.eligibleTypesHash === eligibleTypesHash();
    return ok ? { state: 'valid', consent: entry } : { state: 'stale' };
  }
  // A consent for this real path whose id marker is gone or different: the vault was recreated.
  try {
    const prefix = `${realpathSync.native(contextRoot)}#`;
    if (Object.keys(cfg.vaults).some((k) => k.startsWith(prefix))) return { state: 'stale' };
  } catch {
    /* unresolvable root has no consent */
  }
  return { state: 'none' };
}

/** The vault's consent when it is valid for THIS disclosure version and eligible-types hash, else null. */
export function readVaultConsent(contextRoot: string, home: string = homedir()): VaultCloudConsent | null {
  const raw = rawConsent(contextRoot, readRecallCloudConfig(home));
  return raw.state === 'valid' ? raw.consent : null;
}

export function appendCloudAudit(
  event: 'grant' | 'revoke' | 'key_set' | 'key_clear' | 'key_copy_voice',
  contextRoot: string | null,
  surface: ConsentSurface | 'cli',
  home: string = homedir(),
): void {
  let vault: string | null = null;
  if (contextRoot) {
    try {
      vault = realpathSync.native(contextRoot);
    } catch {
      vault = contextRoot;
    }
  }
  const line = JSON.stringify({ at: new Date().toISOString(), event, vault, surface });
  mkdirSync(dcDir(home), { recursive: true });
  appendFileSync(auditPath(home), `${line}\n`, { mode: 0o600 });
  chmodSync(auditPath(home), 0o600);
}

/** Record consent for this vault (creating its id marker). A `cloud-index` grant never carries a rerank model. */
export function grantVaultConsent(
  contextRoot: string,
  c: { tier: CloudTier; rerankModel: RerankModel | null; surface: ConsentSurface },
  home: string = homedir(),
): VaultCloudConsent {
  const key = vaultConsentKey(contextRoot, { create: true });
  if (!key) throw new Error('Cannot record consent: the vault root cannot be resolved.');
  const consent: VaultCloudConsent = {
    tier: c.tier,
    consentedAt: new Date().toISOString(),
    surface: c.surface,
    embedModel: 'voyageai/voyage-4',
    rerankModel: c.tier === 'cloud-index' ? null : c.rerankModel,
    disclosureVersion: CLOUD_DISCLOSURE_VERSION,
    eligibleTypesHash: eligibleTypesHash(),
  };
  const cfg = readRecallCloudConfig(home);
  cfg.vaults[key] = consent;
  writeConfig(cfg, home);
  appendCloudAudit('grant', contextRoot, c.surface, home);
  return consent;
}

export function revokeVaultConsent(contextRoot: string, home: string = homedir()): void {
  const cfg = readRecallCloudConfig(home);
  let real: string;
  try {
    real = realpathSync.native(contextRoot);
  } catch {
    return;
  }
  const prefix = `${real}#`;
  let removed = false;
  for (const k of Object.keys(cfg.vaults)) {
    if (k.startsWith(prefix)) {
      delete cfg.vaults[k];
      removed = true;
    }
  }
  if (removed) writeConfig(cfg, home);
  appendCloudAudit('revoke', contextRoot, 'cli', home);
}

/** `local` unless this vault holds a valid consent AND a key is present. */
export function readVaultTier(contextRoot: string, home: string = homedir()): RecallTier {
  const consent = readVaultConsent(contextRoot, home);
  if (!consent) return 'local';
  return recallCloudKeyInfo(home).present ? consent.tier : 'local';
}

// ── usage ────────────────────────────────────────────────────────────────────

const today = (): string => new Date().toISOString().slice(0, 10);
const emptyUsage = (): RecallCloudUsage => ({ day: today(), queriesToday: {}, indexSpend: [], evalSpentUsd: 0, lifetimeUsd: 0, vaultUsd: {} });

function corruptUsage(): RecallCloudUsage {
  return {
    day: today(),
    queriesToday: new Proxy({}, { get: () => AT_CEILING, has: () => true }) as Record<string, number>,
    indexSpend: [{ at: new Date().toISOString(), vault: '*', usd: AT_CEILING, auto: true }],
    evalSpentUsd: AT_CEILING,
    lifetimeUsd: AT_CEILING,
    vaultUsd: {},
    corrupt: true,
  };
}

/**
 * The usage ledger. A missing file is an empty ledger; a file that exists but cannot be read
 * reads as AT-CEILING for every spend (and is never overwritten), so damage can only make the
 * caps stricter, never let spend run on unmetered.
 */
export function readRecallCloudUsage(home: string = homedir()): RecallCloudUsage {
  const path = usagePath(home);
  if (!existsSync(path)) return emptyUsage();
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return corruptUsage();
    const r = raw as Record<string, unknown>;
    const spendList = Array.isArray(r.indexSpend) ? r.indexSpend : [];
    const indexSpend = spendList.flatMap((e) => {
      if (!e || typeof e !== 'object') return [];
      const x = e as Record<string, unknown>;
      return typeof x.at === 'string' && typeof x.usd === 'number' && Number.isFinite(x.usd)
        ? [{ at: x.at, vault: String(x.vault ?? ''), usd: x.usd, auto: x.auto === true }]
        : [];
    });
    const sameDay = r.day === today();
    return {
      day: today(),
      queriesToday: sameDay && r.queriesToday && typeof r.queriesToday === 'object' ? { ...(r.queriesToday as Record<string, number>) } : {},
      indexSpend,
      evalSpentUsd: num(r.evalSpentUsd, 0),
      lifetimeUsd: num(r.lifetimeUsd, 0),
      vaultUsd: r.vaultUsd && typeof r.vaultUsd === 'object' ? { ...(r.vaultUsd as Record<string, number>) } : {},
    };
  } catch {
    return corruptUsage();
  }
}

function usageVaultId(contextRoot: string): string {
  const key = vaultConsentKey(contextRoot);
  if (key) return key;
  try {
    return realpathSync.native(contextRoot);
  } catch {
    return contextRoot;
  }
}

/**
 * Charge one call to the ledger. `query` also bumps the vault's daily counter; `eval` charges the
 * eval ceiling; `index` is kept for the rolling 24 h cap. A corrupt ledger is left untouched (the
 * at-ceiling reading must survive), and a failed write is dropped: metering is best-effort once
 * the call has already been made, and the next read re-meters from what did land.
 */
export function recordCloudUsage(
  contextRoot: string,
  kind: UsageKind,
  usd: number,
  o: { auto?: boolean } = {},
  home: string = homedir(),
): void {
  const usage = readRecallCloudUsage(home);
  if (usage.corrupt) return;
  const vault = usageVaultId(contextRoot);
  const cost = Number.isFinite(usd) && usd > 0 ? usd : 0;
  if (kind === 'query') usage.queriesToday[vault] = (usage.queriesToday[vault] ?? 0) + 1;
  if (kind === 'index') usage.indexSpend.push({ at: new Date().toISOString(), vault, usd: cost, auto: o.auto === true });
  if (kind === 'eval') usage.evalSpentUsd += cost;
  usage.lifetimeUsd += cost;
  usage.vaultUsd = { ...(usage.vaultUsd ?? {}), [vault]: ((usage.vaultUsd ?? {})[vault] ?? 0) + cost };
  const cutoff = Date.now() - 48 * 3_600_000;
  usage.indexSpend = usage.indexSpend.filter((e) => Date.parse(e.at) >= cutoff);
  try {
    writeAtomic0600(usagePath(home), `${JSON.stringify(usage)}\n`);
  } catch {
    /* metering is best-effort after the call; see above */
  }
}

/** Index spend over the last 24 h across all vaults (`autoOnly` counts automatic builds only). */
export function rollingIndexSpendUsd(o: { autoOnly?: boolean } = {}, home: string = homedir()): number {
  const cutoff = Date.now() - 24 * 3_600_000;
  return readRecallCloudUsage(home).indexSpend
    .filter((e) => Date.parse(e.at) >= cutoff && (!o.autoOnly || e.auto))
    .reduce((sum, e) => sum + e.usd, 0);
}

/** The eval spend ceiling: the configured `maxEvalUsd`, which `DREAMCONTEXT_EVAL_MAX_USD` can only LOWER. */
export function evalSpendCeilingUsd(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): number {
  const configured = readRecallCloudConfig(home).spend.maxEvalUsd;
  const raw = env[EVAL_MAX_USD_ENV];
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(configured, parsed) : configured;
}

// ── per-prompt tier ──────────────────────────────────────────────────────────

/** Cloud queries this vault has made today (a corrupt ledger reads as at-ceiling). */
export function todayQueryCount(contextRoot: string, home: string = homedir()): number {
  const usage = readRecallCloudUsage(home);
  return usage.corrupt ? AT_CEILING : (usage.queriesToday[usageVaultId(contextRoot)] ?? 0);
}

/**
 * The tier ONE prompt may use. Only the hook and `memory recall` call this. `DREAMCONTEXT_RECALL_TIER=local`
 * forces local. A spawned session (automation, auto-sleep, Develop, peer, lab) and an exhausted daily
 * query cap downgrade `cloud` to `local`; `cloud-index` makes no query-time call, so it is unaffected.
 */
export function resolvePromptTier(
  contextRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { tier: RecallTier; downgraded: null | 'spawned_session' | 'daily_cap' | 'env_override' } {
  if (env.DREAMCONTEXT_RECALL_TIER === 'local') return { tier: 'local', downgraded: 'env_override' };
  const tier = readVaultTier(contextRoot, home);
  if (tier !== 'cloud') return { tier, downgraded: null };
  if (spawnMarkerFromEnv(env) !== null) return { tier: 'local', downgraded: 'spawned_session' };
  const cap = readRecallCloudConfig(home).spend.maxQueriesPerDay;
  if (todayQueryCount(contextRoot, home) >= cap) return { tier: 'local', downgraded: 'daily_cap' };
  return { tier, downgraded: null };
}

// ── status ───────────────────────────────────────────────────────────────────

export interface RecallCloudStatus {
  key: boolean;
  keySource: KeySource | null;
  keyOrigin: KeyOrigin | null;
  tier: RecallTier;
  consent: 'none' | 'valid' | 're-consent-required';
  consentedAt: string | null;
  consentSurface: ConsentSurface | null;
  rerankModel: RerankModel | null;
  spend: RecallCloudSpend & { vaultLifetimeUsd: number; todayQueries: number; indexSpend24hUsd: number; evalSpentUsd: number };
  /**
   * Report only: automatic builds kept re-embedding content embedded before (`strikes` in a row; the last
   * build embedded `embedded`, `reembedded` of them seen before). Builds go on; the spend caps hold money.
   */
  churn: { strikes: number; embedded: number | null; reembedded: number | null } | null;
  /** Automatic index updates are stopped (a spend cap, a failure): the meaning index is as of `asOf`. */
  indexStop: { reason: string; since: string; asOf: string | null; estUsd: number | null; error: string | null } | null;
}

function churnReport(contextRoot: string): RecallCloudStatus['churn'] {
  try {
    const meta = JSON.parse(readFileSync(join(contextRoot, '.embeddings', CLOUD_META_FILE), 'utf-8')) as {
      churnStrikes?: unknown; churnRule?: unknown; lastChurn?: { embedded?: unknown; reembedded?: unknown };
    };
    // Strikes from before the unique doc keys (rule 2) were the key collision, not churn.
    if (meta.churnRule !== CHURN_RULE || typeof meta.churnStrikes !== 'number' || meta.churnStrikes < CHURN_STRIKE_LIMIT) return null;
    const n = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    return { strikes: meta.churnStrikes, embedded: n(meta.lastChurn?.embedded), reembedded: n(meta.lastChurn?.reembedded) };
  } catch {
    return null;
  }
}

function indexStopReport(contextRoot: string): RecallCloudStatus['indexStop'] {
  const s = readIndexStop(contextRoot);
  return s ? { reason: s.reason, since: s.since, asOf: s.asOf, estUsd: s.estUsd, error: s.error } : null;
}

/** One plain sentence for a stopped index: since when it is stale and why (status and doctor). */
export function indexStopSentence(s: NonNullable<RecallCloudStatus['indexStop']>): string {
  const asOf = s.asOf ? s.asOf.slice(0, 10) : 'never built';
  const why = s.reason === 'daily_index_cap'
    ? 'the rolling 24 h index spend cap was reached'
    : s.reason === 'max_usd'
      ? `the update would cost about $${(s.estUsd ?? 0).toFixed(2)}, over the per-build cap`
      : `the last automatic update failed (${s.error ?? 'error'})`;
  return `automatic updates stopped on ${s.since.slice(0, 10)}, the meaning index is as of ${asOf}: ${why}. Update it with \`dreamcontext recall cloud index\` or the Update button.`;
}

/** The churn report (never a pause): how many builds in a row, and the last one's evidence. */
export function churnSentence(c: NonNullable<RecallCloudStatus['churn']>): string {
  const last = c.embedded !== null && c.reembedded !== null ? ` (the last embedded ${c.embedded}, ${c.reembedded} of them seen before)` : '';
  return `the last ${c.strikes} automatic builds mostly re-embedded content embedded before${last}. Builds continue; the spend caps hold the cost.`;
}

/** Everything Settings, `status` and `doctor` may show. The key itself is never part of it. */
export function recallCloudStatus(contextRoot: string, home: string = homedir()): RecallCloudStatus {
  const cfg = readRecallCloudConfig(home);
  const info = recallCloudKeyInfo(home);
  const raw = rawConsent(contextRoot, cfg);
  const usage = readRecallCloudUsage(home);
  const consent = raw.state === 'valid' ? raw.consent : null;
  const vault = usageVaultId(contextRoot);
  return {
    key: info.present,
    keySource: info.source,
    keyOrigin: info.origin,
    tier: consent && info.present ? consent.tier : 'local',
    consent: raw.state === 'valid' ? 'valid' : raw.state === 'stale' ? 're-consent-required' : 'none',
    consentedAt: consent?.consentedAt ?? null,
    consentSurface: consent?.surface ?? null,
    rerankModel: consent?.rerankModel ?? null,
    spend: {
      ...cfg.spend,
      vaultLifetimeUsd: usage.vaultUsd?.[vault] ?? (usage.corrupt ? AT_CEILING : 0),
      todayQueries: usage.queriesToday[vault] ?? 0,
      indexSpend24hUsd: rollingIndexSpendUsd({}, home),
      evalSpentUsd: usage.evalSpentUsd,
    },
    churn: churnReport(contextRoot),
    indexStop: indexStopReport(contextRoot),
  };
}

/** sha256 prefix of the key, for the circuit breaker's "auth failure until the key changes" (never the key). */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}
