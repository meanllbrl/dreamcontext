import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireFileLockWithin, releaseFileLock } from '../file-lock.js';
import { docKey, type CorpusDoc } from '../recall.js';
import {
  CHURN_RULE,
  CLOUD_META_FILE,
  readRecallCloudConfig,
  readVaultTier,
  rollingIndexSpendUsd,
} from '../recall-cloud-config.js';
import type { CloudIndexPlan } from '../recall-cloud-disclosure.js';
import type { Chunk } from './chunker.js';
import { buildEgressPayload, effectiveTier, isUnderEvalFrozenDir } from './egress.js';
import { CLOUD_DISCLOSURE_VERSION, eligibleTypesHash, isCloudEligibleChunk, isCloudEligibleDoc, type WithheldRule } from './egress-rules.js';
import { ensureSelfIgnoredDir } from './ignored-dir.js';
import { clearIndexStop, noteIndexStop } from './index-stop.js';
import { CloudRecallError, openRouterEmbed } from './openrouter.js';
import { VOYAGE_4_PROFILE, type CloudProfileId } from './profiles.js';
import type { DenseIndex, IndexedChunk } from './store.js';

/**
 * The cloud profile's vector store, under `<root>/.embeddings/` (self-ignored, never committed or
 * packed): `voyage-4.f32` (row-major float32 rows), `voyage-4.json` (row → chunk hash, doc → chunk
 * hashes) and `voyage-4.meta.json` (coverage + versions, what `cloudIndexReady` reads WITHOUT
 * touching the large files). Writes are tmp + rename, so a killed build never leaves a torn index;
 * a build checkpoints as it goes and resumes from whatever landed.
 */

export interface VectorMeta {
  version: 1;
  profile: CloudProfileId;
  model: string;
  dims: number;
  disclosureVersion: number;
  eligibleTypesHash: string;
  eligibleTotal: number;
  coveredDocs: number;
  spentUsd: number;
  updatedAt: string;
  lastAutoStartAt: string | null;
  /**
   * Consecutive automatic builds that mostly re-embedded content embedded before. A REPORT only
   * (status and doctor show it with `lastChurn`); it never pauses a build (owner, 2026-11-12).
   */
  churnStrikes: number;
  /** The churn rule `churnStrikes` was counted under; an older or missing one restarts the count. */
  churnRule?: number;
  /** The last build's evidence: how many it embedded, and how many of those were embedded before. */
  lastChurn?: { embedded: number; reembedded: number; at: string };
}


export interface BuildCloudIndexOpts {
  /** A label. Automatic builds are additionally throttled, churn-guarded and held to the rolling 24 h cap. */
  trigger: 'explicit' | 'auto' | 'eval';
  /** Governs the consent bypass; honoured only for a root under the eval-frozen dir. */
  evalConsent?: boolean;
  home?: string;
  maxUsd?: number;
  prune?: boolean;
  batchSize?: number;
  checkpointEvery?: number;
  /** hash → vector. Honoured only under evalConsent (seeds an eval index from earlier spike vectors). */
  seedVectors?: Map<string, Float32Array>;
  onProgress?: (done: number, total: number, spentUsd: number) => void;
  /** Delay between retries of a transient failure. Default 1000 ms; tests pass 0. */
  retryDelayMs?: number;
}

export interface BuildCloudIndexResult {
  embedded: number;
  reused: number;
  evicted: number;
  spentUsd: number;
  aborted: null | 'not_consented' | 'tier_local' | 'max_usd' | 'eval_cap' | 'daily_index_cap' | 'lock_busy' | 'throttled';
}

export const AUTO_THROTTLE_MS = 30 * 60_000;
const COVERAGE_MIN = 0.8;
const BUILD_LOCK_STALE_MS = 30 * 60_000;
const EVER_EMBEDDED_CAP = 100_000;
const EMBED_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

const embeddingsDir = (root: string): string => join(root, '.embeddings');
const metaPath = (root: string): string => join(embeddingsDir(root), CLOUD_META_FILE);
const manifestPath = (root: string, p: CloudProfileId): string => join(embeddingsDir(root), `${p}.json`);
const dataPath = (root: string, p: CloudProfileId): string => join(embeddingsDir(root), `${p}.f32`);
const lockPath = (root: string, p: CloudProfileId): string => join(embeddingsDir(root), `${p}.build.lock`);

interface Manifest {
  version: 1;
  dims: number;
  /** Chunk hash of each row of the .f32 file, in order. */
  rows: string[];
  /** docKey → the chunk hashes (in seq order) that have a row. */
  docs: Record<string, string[]>;
  /** Hashes embedded at any time (survives pruning): the churn report's memory. */
  everEmbedded: string[];
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function readVectorMeta(contextRoot: string, profile: CloudProfileId): VectorMeta | null {
  try {
    const m = JSON.parse(readFileSync(metaPath(contextRoot), 'utf-8')) as VectorMeta;
    return m && m.version === 1 && m.profile === profile ? m : null;
  } catch {
    return null;
  }
}

/** Synchronous and meta-only: enough of the eligible corpus is covered, under the current model and rules. */
export function cloudIndexReady(contextRoot: string, profile: CloudProfileId): boolean {
  const m = readVectorMeta(contextRoot, profile);
  return m !== null
    && m.model === VOYAGE_4_PROFILE.docModel
    && m.dims === VOYAGE_4_PROFILE.dims
    && m.disclosureVersion === CLOUD_DISCLOSURE_VERSION
    && m.eligibleTypesHash === eligibleTypesHash()
    && m.eligibleTotal > 0
    && m.coveredDocs / m.eligibleTotal >= COVERAGE_MIN;
}

function readManifest(root: string, profile: CloudProfileId): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(manifestPath(root, profile), 'utf-8')) as Manifest;
    return m && m.version === 1 && Array.isArray(m.rows) && m.docs && typeof m.docs === 'object' ? m : null;
  } catch {
    return null;
  }
}

function readRows(root: string, profile: CloudProfileId, manifest: Manifest): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!existsSync(dataPath(root, profile))) return out;
  const buf = readFileSync(dataPath(root, profile));
  // Copy into an aligned ArrayBuffer: a pooled Buffer's byteOffset need not be a multiple of 4.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const all = new Float32Array(ab);
  if (all.length < manifest.rows.length * manifest.dims) return out;
  manifest.rows.forEach((hash, i) => out.set(hash, all.subarray(i * manifest.dims, (i + 1) * manifest.dims)));
  return out;
}

/**
 * The last index each process loaded, per root and profile, valid while the manifest and the vector file keep
 * their mtime, size and inode. The dashboard server answers every prompt's recall, so it must not re-read
 * ~100 MB of vectors per prompt; a one-shot hook loads once either way. Callers only read the index.
 */
const indexMemo = new Map<string, { sig: string; index: DenseIndex }>();

function indexSignature(root: string, profile: CloudProfileId): string | null {
  try {
    const m = statSync(manifestPath(root, profile));
    const d = existsSync(dataPath(root, profile)) ? statSync(dataPath(root, profile)) : null;
    return `${m.mtimeMs}:${m.size}:${m.ino}|${d ? `${d.mtimeMs}:${d.size}:${d.ino}` : '-'}`;
  } catch {
    return null;
  }
}

/** The dense index of the cloud profile, or null when none was built. */
export function loadVectorIndex(contextRoot: string, profile: CloudProfileId): DenseIndex | null {
  const key = `${contextRoot}\u0000${profile}`;
  const sig = indexSignature(contextRoot, profile);
  const memo = indexMemo.get(key);
  if (sig !== null && memo && memo.sig === sig) return memo.index;
  const index = readVectorIndex(contextRoot, profile);
  if (sig !== null && index !== null) indexMemo.set(key, { sig, index });
  else indexMemo.delete(key);
  return index;
}

function readVectorIndex(contextRoot: string, profile: CloudProfileId): DenseIndex | null {
  const manifest = readManifest(contextRoot, profile);
  if (manifest === null) return null;
  const rows = readRows(contextRoot, profile, manifest);
  const chunks: IndexedChunk[] = [];
  for (const [key, hashes] of Object.entries(manifest.docs)) {
    hashes.forEach((hash, seq) => {
      const vector = rows.get(hash);
      if (vector) chunks.push({ docKey: key, seq, hash, vector });
    });
  }
  return { dims: manifest.dims, chunks };
}

// ── planning ─────────────────────────────────────────────────────────────────

interface EligibleDoc { doc: CorpusDoc; key: string; chunks: Chunk[] }
interface Survey { docs: EligibleDoc[]; withheld: Partial<Record<WithheldRule, number>>; byType: Record<string, number> }

const bump = (m: Partial<Record<WithheldRule, number>>, rule: WithheldRule): void => { m[rule] = (m[rule] ?? 0) + 1; };

/** The eligible docs (with their eligible chunks) of a corpus, and what was withheld and why. */
function survey(root: string, corpus: CorpusDoc[]): Survey {
  const docs: EligibleDoc[] = [];
  const withheld: Partial<Record<WithheldRule, number>> = {};
  const byType: Record<string, number> = {};
  for (const doc of corpus) {
    const docRule = isCloudEligibleDoc(doc, root);
    if (docRule) { bump(withheld, docRule); continue; }
    const chunks: Chunk[] = [];
    for (const chunk of VOYAGE_4_PROFILE.chunk(doc)) {
      const rule = chunk.text.trim() === '' ? 'empty' : isCloudEligibleChunk(chunk.text);
      if (rule) bump(withheld, rule); else chunks.push(chunk);
    }
    if (chunks.length === 0) continue;
    docs.push({ doc, key: docKey(doc), chunks });
    byType[doc.type] = (byType[doc.type] ?? 0) + 1;
  }
  return { docs, withheld, byType };
}

/** What a build would send, for the disclosure. No network, no writes. */
export function planCloudIndex(contextRoot: string, profile: CloudProfileId, corpus: CorpusDoc[]): CloudIndexPlan {
  const s = survey(contextRoot, corpus);
  const have = new Set(readManifest(contextRoot, profile)?.rows ?? []);
  const missing = new Map<string, number>();
  const all = new Set<string>();
  for (const d of s.docs) for (const c of d.chunks) {
    all.add(c.hash);
    if (!have.has(c.hash) && !missing.has(c.hash)) missing.set(c.hash, c.text.length);
  }
  const estTokens = Math.ceil([...missing.values()].reduce((a, b) => a + b, 0) / 4);
  return { toEmbed: missing.size, total: all.size, estTokens, estUsd: (estTokens * 0.06) / 1e6, byType: s.byType, withheld: s.withheld };
}

// ── building ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => { setTimeout(r, ms); }) : Promise.resolve());
const TRANSIENT = new Set(['timeout', 'network', 'rate_limit']);

function persist(
  root: string,
  profile: CloudProfileId,
  s: Survey,
  vectors: Map<string, Float32Array>,
  prior: Manifest | null,
  ever: Set<string>,
  prune: boolean,
  meta: Omit<VectorMeta, 'eligibleTotal' | 'coveredDocs' | 'updatedAt'>,
): { evicted: number; meta: VectorMeta } {
  const docs: Record<string, string[]> = prune ? {} : { ...(prior?.docs ?? {}) };
  let covered = 0;
  for (const d of s.docs) {
    const present = d.chunks.map((c) => c.hash).filter((h) => vectors.has(h));
    docs[d.key] = present;
    if (present.length === d.chunks.length) covered++;
  }
  const keep = new Set(Object.values(docs).flat());
  const rows = [...vectors.keys()].filter((h) => keep.has(h));
  const evicted = vectors.size - rows.length;
  const dims = VOYAGE_4_PROFILE.dims;
  const data = new Float32Array(rows.length * dims);
  rows.forEach((h, i) => data.set(vectors.get(h) as Float32Array, i * dims));
  ensureSelfIgnoredDir(embeddingsDir(root));
  writeAtomic(dataPath(root, profile), new Uint8Array(data.buffer));
  const manifest: Manifest = { version: 1, dims, rows, docs, everEmbedded: [...ever].slice(-EVER_EMBEDDED_CAP) };
  writeAtomic(manifestPath(root, profile), JSON.stringify(manifest));
  const full: VectorMeta = { ...meta, eligibleTotal: s.docs.length, coveredDocs: covered, updatedAt: new Date().toISOString() };
  writeAtomic(metaPath(root), JSON.stringify(full));
  return { evicted, meta: full };
}

/**
 * Build or resume the cloud index of a vault. Every batch goes through the egress layer, so a vault
 * without consent embeds nothing (`not_consented`, zero fetches), the tier is re-read before each
 * batch (a `disable` mid-build aborts it), and spend is held to the per-build cap, the rolling 24 h
 * cap for automatic builds, and — under evalConsent — the eval ceiling. A transient failure is
 * retried; a permanent one (auth, policy, no key) is thrown after what landed is checkpointed.
 */
export async function buildCloudIndex(
  contextRoot: string,
  profile: CloudProfileId,
  corpus: CorpusDoc[],
  o: BuildCloudIndexOpts,
): Promise<BuildCloudIndexResult> {
  const home = o.home ?? homedir();
  const evalActive = o.evalConsent === true && isUnderEvalFrozenDir(contextRoot, home);
  const result: BuildCloudIndexResult = { embedded: 0, reused: 0, evicted: 0, spentUsd: 0, aborted: null };

  if (effectiveTier(contextRoot, 'cloud', o.evalConsent, home) === 'local') return { ...result, aborted: 'not_consented' };

  ensureSelfIgnoredDir(embeddingsDir(contextRoot));
  const held = await acquireFileLockWithin(lockPath(contextRoot, profile), { waitMs: 0, staleMs: BUILD_LOCK_STALE_MS, verifyPidLiveness: true });
  if (!held) return { ...result, aborted: 'lock_busy' };
  try {
    const cfg = readRecallCloudConfig(home);
    const prior = readManifest(contextRoot, profile);
    const priorMeta = readVectorMeta(contextRoot, profile);
    const auto = o.trigger === 'auto' && !evalActive;

    if (auto) {
      // No churn gate: the index never stops on its own judgement; spend is held by the two caps below.
      const last = priorMeta?.lastAutoStartAt ? Date.parse(priorMeta.lastAutoStartAt) : NaN;
      if (Number.isFinite(last) && Date.now() - last < AUTO_THROTTLE_MS) return { ...result, aborted: 'throttled' };
      if (rollingIndexSpendUsd({}, home) >= cfg.spend.maxIndexUsd24h) {
        noteIndexStop(contextRoot, { reason: 'daily_index_cap', asOf: priorMeta?.updatedAt ?? null }, home);
        return { ...result, aborted: 'daily_index_cap' };
      }
    }

    const s = survey(contextRoot, corpus);
    const vectors = readRowsOrEmpty(contextRoot, profile, prior);
    if (evalActive && o.seedVectors) {
      for (const [h, v] of o.seedVectors) if (!vectors.has(h) && v.length === VOYAGE_4_PROFILE.dims) vectors.set(h, v);
    }
    const ever = new Set(prior?.everEmbedded ?? []);
    const recreated = priorMeta !== null && priorMeta.coveredDocs > 0 && prior === null;

    const todo = new Map<string, { doc: CorpusDoc; chunk: Chunk }>();
    const wanted = new Set<string>();
    for (const d of s.docs) for (const chunk of d.chunks) {
      wanted.add(chunk.hash);
      if (!vectors.has(chunk.hash) && !todo.has(chunk.hash)) todo.set(chunk.hash, { doc: d.doc, chunk });
    }
    result.reused = [...wanted].filter((h) => vectors.has(h)).length;

    const maxUsd = o.maxUsd ?? cfg.spend.maxIndexUsd;
    const estUsd = (Math.ceil([...todo.values()].reduce((n, t) => n + t.chunk.text.length, 0) / 4) * 0.06) / 1e6;
    if (estUsd > maxUsd) {
      if (auto) noteIndexStop(contextRoot, { reason: 'max_usd', estUsd, asOf: priorMeta?.updatedAt ?? null }, home);
      return { ...result, aborted: 'max_usd' };
    }

    const startedAt = new Date().toISOString();
    const meta = (strikes: number, lastChurn?: VectorMeta['lastChurn']): Omit<VectorMeta, 'eligibleTotal' | 'coveredDocs' | 'updatedAt'> => ({
      version: 1, profile, model: VOYAGE_4_PROFILE.docModel, dims: VOYAGE_4_PROFILE.dims,
      disclosureVersion: CLOUD_DISCLOSURE_VERSION, eligibleTypesHash: eligibleTypesHash(),
      spentUsd: (priorMeta?.spentUsd ?? 0) + result.spentUsd,
      lastAutoStartAt: auto ? startedAt : (priorMeta?.lastAutoStartAt ?? null),
      churnStrikes: strikes,
      churnRule: CHURN_RULE,
      ...(lastChurn ?? priorMeta?.lastChurn ? { lastChurn: lastChurn ?? priorMeta?.lastChurn } : {}),
    });
    const baseline = priorMeta !== null && priorMeta.churnRule !== CHURN_RULE;
    const strikesNow = (o.trigger === 'explicit' && !evalActive) || baseline ? 0 : (priorMeta?.churnStrikes ?? 0);

    const batchSize = Math.max(1, o.batchSize ?? 64);
    const checkpointEvery = Math.max(1, o.checkpointEvery ?? 10);
    const entries = [...todo.values()];
    let alreadyEmbeddedBefore = 0;
    let batches = 0;
    let failure: CloudRecallError | null = null;

    for (let i = 0; i < entries.length && result.aborted === null && failure === null; i += batchSize) {
      if (!evalActive && readVaultTier(contextRoot, home) === 'local') { result.aborted = 'tier_local'; break; }
      if (result.spentUsd >= maxUsd) { result.aborted = 'max_usd'; break; }
      const items = entries.slice(i, i + batchSize);
      const { payload } = buildEgressPayload({ kind: 'index', contextRoot, tier: 'cloud', evalConsent: o.evalConsent, home, profile, items });
      if (payload === null) continue; // every item withheld: nothing to send, nothing to retry
      let attempt = 0;
      for (;;) {
        try {
          const { vectors: got, costUsd } = await openRouterEmbed(payload, { timeoutMs: EMBED_TIMEOUT_MS });
          payload.itemKeys.forEach((hash, k) => {
            vectors.set(hash, got[k]);
            if (ever.has(hash) || recreated) alreadyEmbeddedBefore++;
            ever.add(hash);
          });
          result.embedded += payload.itemKeys.length;
          result.spentUsd += costUsd;
          o.onProgress?.(result.embedded, entries.length, result.spentUsd);
          break;
        } catch (err) {
          if (!(err instanceof CloudRecallError)) throw err;
          if (err.kind === 'eval_cap') { result.aborted = 'eval_cap'; break; }
          if (TRANSIENT.has(err.kind) && ++attempt < MAX_ATTEMPTS) { await sleep((o.retryDelayMs ?? 1000) * attempt); continue; }
          failure = err;
          break;
        }
      }
      if (++batches % checkpointEvery === 0) persist(contextRoot, profile, s, vectors, prior, ever, false, meta(strikesNow));
    }

    const churned = !baseline && result.embedded > 0 && alreadyEmbeddedBefore / result.embedded > 0.5;
    const strikes = churned ? strikesNow + 1 : result.embedded > 0 ? 0 : strikesNow;
    const lastChurn = result.embedded > 0 ? { embedded: result.embedded, reembedded: alreadyEmbeddedBefore, at: new Date().toISOString() } : undefined;
    const done = persist(contextRoot, profile, s, vectors, prior, ever, o.prune === true && result.aborted === null && failure === null, meta(strikes, lastChurn));
    result.evicted = done.evicted;
    if (!evalActive) {
      // `persist` above stamped a fresh updatedAt even on a stopped build: the stop is as of the PRIOR landing.
      const asOf = priorMeta?.updatedAt ?? null;
      if (failure) noteIndexStop(contextRoot, { reason: 'failed', error: failure.kind, asOf }, home);
      else if (result.aborted === null) clearIndexStop(contextRoot, home);
      else if (result.aborted === 'max_usd') noteIndexStop(contextRoot, { reason: 'max_usd', estUsd, asOf }, home);
    }
    if (failure) throw failure;
    return result;
  } finally {
    releaseFileLock(lockPath(contextRoot, profile));
  }
}

function readRowsOrEmpty(root: string, profile: CloudProfileId, manifest: Manifest | null): Map<string, Float32Array> {
  if (manifest === null) return new Map();
  // Copies: the build mutates this map and rewrites the file, so views over the old buffer would alias.
  return new Map([...readRows(root, profile, manifest)].map(([h, v]) => [h, Float32Array.from(v)]));
}
