import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { readSleepState, writeSleepState } from '../../cli/commands/sleep.js';
import type { CorpusDoc } from '../../lib/recall.js';
import { buildCorpusCached } from '../../lib/recall-corpus-cache.js';
import {
  RERANK_MODELS,
  appendCloudAudit,
  copyVoiceKeyToRecall,
  grantVaultConsent,
  readVaultTier,
  recallCloudKeyInfo,
  recallCloudStatus,
  revokeVaultConsent,
  setRecallCloudKey,
  type CloudTier,
  type RecallCloudStatus,
  type RerankModel,
} from '../../lib/recall-cloud-config.js';
import { renderDisclosure, type CloudIndexPlan } from '../../lib/recall-cloud-disclosure.js';
import { DEFAULT_RERANK_MODEL } from '../../lib/embeddings/fusion-config.js';
import { CLOUD_DISCLOSURE_VERSION } from '../../lib/embeddings/egress-rules.js';
import { CloudRecallError } from '../../lib/embeddings/openrouter.js';
import {
  buildCloudIndex,
  cloudIndexReady,
  planCloudIndex,
  readVectorMeta,
} from '../../lib/embeddings/vector-store.js';
import { voiceStatus } from '../../lib/voice/config.js';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isLoopback } from './agent-spawn-shared.js';

/**
 * `/api/recall/cloud/*` — Settings' hands on the opt-in cloud recall tiers: status, the key, consent,
 * and the index build. The CLI (`dreamcontext recall cloud`) stays the stricter door (it needs a TTY
 * and refuses a spawned session); this one exists so the owner can do the same from the app, and it
 * is therefore guarded much harder than the rest of the local API (see {@link requireLocalDashboardWrite}).
 *
 * Nothing here ever returns the key: status carries a boolean and a source, and no error path
 * formats a caught error's message into a response.
 */

const VOYAGE = 'voyage-4' as const;
const MAX_KEY_LENGTH = 512;
const MIN_KEY_LENGTH = 8;

/** `localhost`, `127.0.0.1` or `[::1]` WITH a port — a Host without one is not what the dashboard sends. */
const LOOPBACK_HOST_WITH_PORT = /^(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/i;
/** A printable key: no whitespace and no control characters anywhere. */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

function lowerHeader(req: Pick<IncomingMessage, 'headers'>, name: 'host' | 'origin'): string | null {
  const v = req.headers[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : null;
}

function hostRuleHolds(req: Pick<IncomingMessage, 'headers'>): string | null {
  const host = lowerHeader(req, 'host');
  return host !== null && LOOPBACK_HOST_WITH_PORT.test(host) ? host : null;
}

/**
 * The guard of every route that CHANGES something. All of these must hold:
 *  - `Host` is a loopback name with a port (a DNS-rebound page arrives under its own name);
 *  - `Origin` is present and is exactly `http://<Host>` — a rebound page sends `Origin == Host ==
 *    evil.example:port`, which passes a "same origin" check but fails the loopback one above, and a
 *    foreign page fails the equality;
 *  - the socket's peer is loopback.
 */
export function requireLocalDashboardWrite(req: IncomingMessage): boolean {
  const host = hostRuleHolds(req);
  if (host === null) return false;
  if (lowerHeader(req, 'origin') !== `http://${host}`) return false;
  return isLoopback(req);
}

/**
 * The guard of the read-only routes: the same Host rule. A same-origin
 * GET carries no `Origin`, so it is not demanded — but one that does carry a foreign `Origin` is refused.
 */
export function requireLocalDashboardRead(req: IncomingMessage): boolean {
  const host = hostRuleHolds(req);
  if (host === null) return false;
  const origin = lowerHeader(req, 'origin');
  return origin === null || origin === `http://${host}`;
}

function refuse(res: ServerResponse): void {
  sendError(res, 403, 'forbidden', 'Cloud recall settings can only be changed from the dashboard on this computer.');
}

// ── index runs ───────────────────────────────────────────────────────────────

type IndexState = 'not_built' | 'building' | 'ready' | 'error';

interface IndexRun {
  state: 'building' | 'ready' | 'error';
  done: number;
  total: number;
  spentUsd: number;
  /** A machine code the card translates: an abort reason, `cloud_<kind>`, or `unexpected`. Never a message. */
  error: string | null;
  startedAt: number;
}

export interface RecallCloudRouteDeps {
  home?: string;
  loadCorpus: (root: string) => CorpusDoc[];
  build: typeof buildCloudIndex;
  setHybrid: (root: string) => void;
}

const defaultDeps = (): RecallCloudRouteDeps => ({
  loadCorpus: (root) => buildCorpusCached(root),
  build: buildCloudIndex,
  setHybrid: (root) => {
    const state = readSleepState(root);
    state.recall_mode = 'hybrid';
    writeSleepState(root, state);
  },
});

/** What a log line may say about a failure: its class and system code, never its message. */
function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return 'unexpected error';
  const code = (err as NodeJS.ErrnoException).code;
  return `${err.name}${typeof code === 'string' ? ` (${code})` : ''}`;
}

function errorCode(err: unknown): string {
  return err instanceof CloudRecallError ? `cloud_${err.kind}` : 'unexpected';
}

export interface RecallCloudRoutes {
  status: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>;
  setKey: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>;
  copyVoiceKey: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>;
  enable: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>;
  disable: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>;
  startIndex: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>;
  indexStatus: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>;
  /** Test-only: forget every build run. */
  reset: () => void;
}

/** The handlers over injectable dependencies; the server registers {@link recallCloudRoutes}. */
export function createRecallCloudRoutes(overrides: Partial<RecallCloudRouteDeps> = {}): RecallCloudRoutes {
  const deps = (): RecallCloudRouteDeps => ({ ...defaultDeps(), ...overrides });
  const homeOf = (): string => deps().home ?? homedir();
  const runs = new Map<string, IndexRun>();

  const indexSnapshot = (root: string) => {
    const run = runs.get(root);
    const ready = cloudIndexReady(root, VOYAGE);
    const meta = readVectorMeta(root, VOYAGE);
    let state: IndexState;
    if (run?.state === 'building') state = 'building';
    else if (run?.state === 'ready') state = 'ready';
    else if (run?.state === 'error' && !ready) state = 'error';
    else state = ready ? 'ready' : 'not_built';
    const progress = state === 'ready' ? 100
      : state === 'building' && run && run.total > 0 ? Math.min(99, Math.round((run.done / run.total) * 100))
        : 0;
    return {
      state,
      progress,
      done: run?.done ?? 0,
      total: run?.total ?? 0,
      spentUsd: run?.spentUsd ?? 0,
      error: state === 'error' ? (run?.error ?? 'unexpected') : null,
      coverage: meta ? { coveredDocs: meta.coveredDocs, eligibleTotal: meta.eligibleTotal } : null,
    };
  };

  /** Everything the card shows. The key is a boolean plus where it came from; the key itself has no path here. */
  const fullStatus = (root: string) => {
    const d = deps();
    const home = homeOf();
    const status: RecallCloudStatus = recallCloudStatus(root, home);
    let plan: CloudIndexPlan | null = null;
    try {
      plan = planCloudIndex(root, VOYAGE, d.loadCorpus(root));
    } catch {
      plan = null; // the card then cannot offer to enable: it has nothing honest to disclose
    }
    const rerank = DEFAULT_RERANK_MODEL;
    const meta = readVectorMeta(root, VOYAGE);
    return {
      ...status,
      indexReady: cloudIndexReady(root, VOYAGE),
      indexCoverage: meta ? { coveredDocs: meta.coveredDocs, eligibleTotal: meta.eligibleTotal } : null,
      voiceKeyAvailable: voiceStatus(home).key,
      plan,
      rerankModels: RERANK_MODELS,
      defaultRerankModel: rerank,
      disclosure: plan === null ? null : {
        version: CLOUD_DISCLOSURE_VERSION,
        lines: {
          'cloud-index': renderDisclosure('cloud-index', plan, status, null),
          cloud: renderDisclosure('cloud', plan, status, rerank),
        },
      },
    };
  };

  const status: RecallCloudRoutes['status'] = async (req, res, _params, root) => {
    if (!requireLocalDashboardRead(req)) { refuse(res); return; }
    if (!root) { sendError(res, 400, 'no_vault', 'No vault selected.'); return; }
    sendJson(res, 200, fullStatus(root));
  };

  const setKey: RecallCloudRoutes['setKey'] = async (req, res, _params, root) => {
    if (!requireLocalDashboardWrite(req)) { refuse(res); return; }
    if (!root) { sendError(res, 400, 'no_vault', 'No vault selected.'); return; }
    const body = await parseJsonBody(req);
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !KEY_SHAPE.test(key)) {
      sendError(res, 400, 'invalid_key', 'That does not look like an API key.');
      return;
    }
    setRecallCloudKey(key, 'manual', homeOf());
    appendCloudAudit('key_set', root, 'dashboard', homeOf());
    sendJson(res, 200, { ok: true, ...fullStatus(root) });
  };

  const copyVoiceKey: RecallCloudRoutes['copyVoiceKey'] = async (req, res, _params, root) => {
    if (!requireLocalDashboardWrite(req)) { refuse(res); return; }
    if (!root) { sendError(res, 400, 'no_vault', 'No vault selected.'); return; }
    // The card asks in an in-app confirm first; the route insists the answer was yes, so a stray
    // request that merely passes the origin guard cannot move the Voice key.
    const body = await parseJsonBody(req);
    if (body?.confirmed !== true) {
      sendError(res, 400, 'confirmation_required', 'Copying the Voice key needs an explicit confirmation.');
      return;
    }
    if (!copyVoiceKeyToRecall(homeOf())) {
      sendError(res, 409, 'no_voice_key', 'There is no Voice key to copy.');
      return;
    }
    appendCloudAudit('key_copy_voice', root, 'dashboard', homeOf());
    sendJson(res, 200, { ok: true, ...fullStatus(root) });
  };

  const enable: RecallCloudRoutes['enable'] = async (req, res, _params, root) => {
    if (!requireLocalDashboardWrite(req)) { refuse(res); return; }
    if (!root) { sendError(res, 400, 'no_vault', 'No vault selected.'); return; }
    const body = await parseJsonBody(req);
    if (body?.consent !== true) {
      sendError(res, 400, 'consent_required', 'Cloud recall needs your explicit consent.');
      return;
    }
    if (body.disclosureVersion !== CLOUD_DISCLOSURE_VERSION) {
      sendError(res, 400, 'disclosure_mismatch', 'The disclosure you accepted is out of date. Reload and read it again.');
      return;
    }
    if (body.tier !== 'cloud-index' && body.tier !== 'cloud') {
      sendError(res, 400, 'invalid_tier', 'Tier must be "cloud-index" or "cloud".');
      return;
    }
    const tier: CloudTier = body.tier;
    let rerankModel: RerankModel | null = null;
    if (tier === 'cloud') {
      const raw = body.rerankModel;
      if (raw === undefined) rerankModel = DEFAULT_RERANK_MODEL;
      else if (raw === null) rerankModel = null;
      else if (typeof raw === 'string' && (RERANK_MODELS as readonly string[]).includes(raw)) rerankModel = raw as RerankModel;
      else { sendError(res, 400, 'invalid_rerank_model', 'Unknown rerank model.'); return; }
    }
    if (!recallCloudKeyInfo(homeOf()).present) {
      sendError(res, 409, 'no_key', 'Set a recall key first.');
      return;
    }
    try {
      // grantVaultConsent writes the audit line itself, with the surface it is given.
      grantVaultConsent(root, { tier, rerankModel, surface: 'dashboard' }, homeOf());
      deps().setHybrid(root);
    } catch (err) {
      console.error(`[recall-cloud] enable failed: ${describeFailure(err)}`);
      sendError(res, 500, 'enable_failed', 'Could not enable cloud recall.');
      return;
    }
    sendJson(res, 200, { ok: true, ...fullStatus(root) });
  };

  const disable: RecallCloudRoutes['disable'] = async (req, res, _params, root) => {
    if (!requireLocalDashboardWrite(req)) { refuse(res); return; }
    if (!root) { sendError(res, 400, 'no_vault', 'No vault selected.'); return; }
    try {
      revokeVaultConsent(root, homeOf());
      // revokeVaultConsent records the event as a CLI one; this line says it came from the dashboard.
      appendCloudAudit('revoke', root, 'dashboard', homeOf());
    } catch (err) {
      console.error(`[recall-cloud] disable failed: ${describeFailure(err)}`);
      sendError(res, 500, 'disable_failed', 'Could not disable cloud recall.');
      return;
    }
    sendJson(res, 200, { ok: true, ...fullStatus(root) });
  };

  const startIndex: RecallCloudRoutes['startIndex'] = async (req, res, _params, root) => {
    if (!requireLocalDashboardWrite(req)) { refuse(res); return; }
    if (!root) { sendError(res, 400, 'no_vault', 'No vault selected.'); return; }
    if (readVaultTier(root, homeOf()) === 'local') {
      sendError(res, 409, 'not_consented', 'Enable a cloud tier (with a key) before building the cloud index.');
      return;
    }
    // Single flight per vault: a second press while a build runs joins it.
    if (runs.get(root)?.state !== 'building') {
      const d = deps();
      const run: IndexRun = { state: 'building', done: 0, total: 0, spentUsd: 0, error: null, startedAt: Date.now() };
      runs.set(root, run);
      void (async () => {
        try {
          const result = await d.build(root, VOYAGE, d.loadCorpus(root), {
            trigger: 'explicit',
            home: homeOf(),
            onProgress: (done, total, spentUsd) => { run.done = done; run.total = total; run.spentUsd = spentUsd; },
          });
          run.spentUsd = result.spentUsd;
          run.state = result.aborted === null ? 'ready' : 'error';
          run.error = result.aborted;
        } catch (err) {
          console.error(`[recall-cloud] index build failed: ${describeFailure(err)}`);
          run.state = 'error';
          run.error = errorCode(err);
        }
      })();
    }
    sendJson(res, 200, { ok: true, ...indexSnapshot(root) });
  };

  const indexStatus: RecallCloudRoutes['indexStatus'] = async (req, res, _params, root) => {
    if (!requireLocalDashboardRead(req)) { refuse(res); return; }
    if (!root) { sendError(res, 400, 'no_vault', 'No vault selected.'); return; }
    sendJson(res, 200, indexSnapshot(root));
  };

  return { status, setKey, copyVoiceKey, enable, disable, startIndex, indexStatus, reset: () => { runs.clear(); } };
}

export const recallCloudRoutes = createRecallCloudRoutes();
