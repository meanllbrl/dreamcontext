/**
 * Hands-free LAPTOP orchestration: setup, go, return, resume, roll back, abandon, the D12
 * recovery, take-over, teardown, password / revoke-all and status. The CLI
 * (`src/cli/commands/handsfree.ts`) and the laptop routes (`src/server/routes/handsfree.ts`)
 * call these same functions with a {@link HandsfreeEnv}; tests pass an in-memory cloud.
 *
 * Invariants (task: Go, Return, Journal):
 *  - go LOCKS FIRST (`beginGoing`) after the preflight, then waits for / cuts in-scope turns
 *    and re-runs the git preflight; both sides are snapshotted ONCE and the go journal is
 *    persisted before anything is sent;
 *  - return downloads its WHOLE payload into `trips/<trip>/` and persists the return journal
 *    before the first laptop write; the cloud is finalized (wipe-secrets, seal, stop) after
 *    the local apply, and queued for the next contact when it cannot be reached;
 *  - every laptop destination comes from the laptop's own go manifest by root id (AC10);
 *  - a quota refusal never wedges (AC23): go ends at home, an away trip can be abandoned.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { generatePassphrase, hashPassphrase, sha256Hex, type VerifierPush } from '../../server/handsfree-auth.js';
import { fetchAuthenticatedLogin, HANDSFREE_OAUTH_SCOPE, pollDeviceFlow, resolveBrainOAuthClientId, startDeviceFlow, type FetchImpl } from '../git-sync/oauth.js';
import {
  applyPack, BackupStore, DELETED_IN_CLOUD_REASON, fileOpHandlers, filesApplyParams, planNonGitReturn, resweepRootWithBackups, type Conflict,
  type NonGitPlan,
} from './apply.js';
import { CloudError, CloudUnreachableError, manifestDigest, PortPrivateError, type CloudClient, type CloudHealth, type SnapshotReply, type SnapshotRoot } from './cloud-client.js';
import { addWorktreeNoCheckout, baseTips, gitOpHandlers, parkRefFor, planRepoApply, planWorktree, setBaseRefs, verifyIncoming, type RepoApplyPlan } from './git-apply.js';
import {
  BundlePrerequisiteError, createBundle, emptyTree, fetchBundle, git, GitError, gitOut, gitPreflight, HandsfreeRefusal, incomingRefFor, isAllowedRef,
  isWellFormedRef, lsTree, parseRepoSnapshot, snapRefPrefix, snapshotBundleRefs, snapshotId, snapshotRepo, snapStashRef, type PreflightProblem,
  type ProcessRunner, type RepoSnapshot,
} from './git-snapshot.js';
import { stageGlobalSet, vaultNameForPath } from './global-set.js';
import { addVault, listVaults, VaultError } from '../vaults.js';
import {
  acquireTripRunLock, createJournal, journalPath, journalStatus, loadJournal, rollbackJournal, runJournal, tripDir as tripDirOf, type Journal,
  type JournalOp, type OpHandlers, backupDir, conflictsDir,
} from './journal.js';
import {
  countUptime, ensureTransferSecret, readConfig, readCredentials, RETURN_RESERVE_MINUTES, updateConfig, updateCredentials, usedCoreMinutes,
  type HandsfreeConfig,
} from './local-store.js';
import {
  allowedNewWorktreePath, buildManifest, encodeProjectDir, isSecretClass, manifestFromJSON, manifestToJSON, rootFor, rootIdFor, sameContent, selectNonGitEntries, walk,
  type GoManifest, type Manifest, type ManifestEntry, type RootSpec,
} from './manifest.js';
import { NpmPinError, PIN_PATH, pinFile, registryPin, type VersionPin } from './npm-pin.js';
import { readPack, writePack } from './pack.js';
import { atomicWriteFile, checkRelPath } from './paths.js';
import { coresFor, gitBlobSha, ProviderError, ProviderQuotaError, type CloudProvider, type MachineInfo, type TemplateRepo } from './provider.js';
import { computeScope, dirBytes, estimateRepoBytes, goManifestFor, type TripScope } from './scope.js';
import { isSessionStatePath, ROSTER_REL, SESSION_MAP_REL, sessionMergeHandlers, TITLES_REL, type RosterIO, type RosterMergeReport } from './session-merge.js';
import { beginGoing, handsfreeDir, readTripState, setPhase, updateTripState, type TripState } from './trip-state.js';
import { UNKNOWN_WORK_ID, type RunningWork, type TurnControl } from './turns.js';

// ---------------------------------------------------------------- environment + errors

export interface HandsfreeEnv {
  /** Laptop HOME (tests: a scratch dir; never the real ~/.dreamcontext in tests). */
  home: string;
  run: ProcessRunner;
  provider: CloudProvider;
  repo: TemplateRepo;
  /** A transfer client for the machine's forwarded origin. */
  connect(origin: string, secret: string): CloudClient;
  turns: TurnControl;
  roster: RosterIO;
  /** The devcontainer files for the template repo (repo path -> bytes), without the verifiers. */
  templateFiles(): Record<string, Buffer>;
  /** This laptop's dreamcontext version: the exact version the cloud must run (D25, AC18). */
  localVersion(): string;
  /** The npm registry lookup (D25). Tests and the round trip inject a fake: never the network. */
  registryFetch: typeof globalThis.fetch;
  claudeProjectsDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a go/return waits for running turns before giving up (default 2 h). */
  waitTimeoutMs?: number;
  /** How long to wait for the cloud's health after a start (default 5 min). */
  healthTimeoutMs?: number;
  /** Tests only (fault injection): runs before every go/return journal op's handler. */
  beforeOp?: (op: JournalOp) => void | Promise<void>;
}

export type HandsfreeErrorCode =
  | 'not_setup' | 'not_home' | 'not_away' | 'busy' | 'preflight' | 'disk' | 'quota' | 'port_private' | 'tampered' | 'ownership'
  | 'confirm_take_over' | 'superseded' | 'turns_running' | 'equality' | 'parity' | 'cloud_preflight' | 'trip_lost' | 'write_started' | 'cloud_content'
  | 'nothing_to_resume' | 'nothing_to_roll_back' | 'needs_recovery' | 'unreadable_state' | 'cloud' | 'not_published' | 'registry';

export class HandsfreeError extends Error {
  constructor(readonly code: HandsfreeErrorCode, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HandsfreeError';
  }
}

export type Progress = (e: { step: string; detail?: string; running?: RunningWork[] }) => void;

const BOOTSTRAP_VERIFIERS = '.devcontainer/bootstrap/verifiers.json';
const verifiersFile = (push: VerifierPush) => Buffer.from(JSON.stringify(push, null, 2) + '\n');
/** How long go waits for the cloud to come back on the pinned version (an npm install + restart). */
const PARITY_WAIT_MS = 10 * 60_000;
/** The package's `cloud/` files copied verbatim into the repo's `.devcontainer/` (and blob-sha checked). */
export const TEMPLATE_FILE_NAMES = ['devcontainer.json', 'Dockerfile', 'entrypoint.sh', 'poststart.sh', 'stop-helper.sh', 'supervisor.mjs'];
/** Wire v1.1: cap on each `.git/info/` file sent with git/receive. */
const GIT_INFO_MAX_BYTES = 256 * 1024;
/** How long `POST trip` keeps retrying `503 mirror_pending` (the supervisor bind-mounts the mirror after a fresh start). */
const MIRROR_PENDING_WAIT_MS = 5 * 60_000;
/** Space the image and the system take on the machine's disk (W0: ~11 GB free of 32 GB). */
const IMAGE_OVERHEAD_BYTES = 21 * 2 ** 30;
const MAX_RETURN_PASSES = 3;
const DAY = 24 * 60 * 60_000;

const nowOf = (env: HandsfreeEnv) => (env.now ?? Date.now)();
const sleepOf = (env: HandsfreeEnv) => env.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
const projectsDir = (env: HandsfreeEnv) => env.claudeProjectsDir ?? join(env.home, '.claude', 'projects');
const tripDirFor = (env: HandsfreeEnv, trip: string) => tripDirOf(handsfreeDir(env.home), trip);

function writeJson(path: string, data: unknown): void {
  atomicWriteFile(path, JSON.stringify(data, null, 2) + '\n', 0o600);
}
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function newTripId(now: number): string {
  const d = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  return `t-${d}-${randomBytes(4).toString('hex')}`;
}

function requireConfig(env: HandsfreeEnv): HandsfreeConfig & { codespace: NonNullable<HandsfreeConfig['codespace']> } {
  const cfg = readConfig(env.home, nowOf(env));
  if (!cfg?.codespace || !cfg.repo) throw new HandsfreeError('not_setup', 'hands-free mode is not set up: run `dreamcontext handsfree setup` first');
  return cfg as HandsfreeConfig & { codespace: NonNullable<HandsfreeConfig['codespace']> };
}

function requireState(env: HandsfreeEnv): TripState {
  const st = readTripState(env.home);
  if (st.unreadable) throw new HandsfreeError('unreadable_state', st.unreadable);
  return st;
}

// ---------------------------------------------------------------- GitHub login (setup)

/** The device flow with scopes `repo codespace` (AC1). `onCode` shows the user code. */
export async function githubDeviceLogin(o: {
  onCode: (c: { userCode: string; verificationUri: string; expiresIn: number }) => void;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ token: string; login: string }> {
  const clientId = resolveBrainOAuthClientId();
  const start = await startDeviceFlow(clientId, o.fetchImpl, HANDSFREE_OAUTH_SCOPE);
  o.onCode({ userCode: start.userCode, verificationUri: start.verificationUri, expiresIn: start.expiresIn });
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let interval = start.interval;
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const r = await pollDeviceFlow(clientId, start.deviceCode, o.fetchImpl);
    if (r.status === 'authorized') {
      const login = await fetchAuthenticatedLogin(r.token, o.fetchImpl);
      if (!login) throw new HandsfreeError('not_setup', 'GitHub did not accept the new token');
      return { token: r.token, login };
    }
    if (r.status === 'slow_down') interval = r.interval;
    else if (r.status !== 'pending') throw new HandsfreeError('not_setup', `GitHub sign-in ${r.status}${r.status === 'error' ? `: ${r.message}` : ''}`);
  }
  throw new HandsfreeError('not_setup', 'the GitHub sign-in code expired; run setup again');
}

// ---------------------------------------------------------------- machine lifecycle

interface Running { client: CloudClient; info: MachineInfo; recreated: boolean; startedByUs: boolean }

/** AC19: the repo's devcontainer + verifier blob shas must equal what this laptop wrote. */
async function checkTemplateRepo(env: HandsfreeEnv, cfg: HandsfreeConfig): Promise<void> {
  const want = cfg.repo?.fileShas ?? {};
  const got = await env.repo.blobShas(Object.keys(want));
  const bad = Object.keys(want).filter((p) => got[p] !== want[p]);
  if (bad.length) {
    throw new HandsfreeError('tampered', `the private repo ${cfg.repo?.fullName} changed since this laptop wrote it (${bad.join(', ')}); nothing was started. Run \`dreamcontext handsfree setup\` to rewrite it after checking who changed it.`, { files: bad });
  }
}

/**
 * D25: this laptop's exact version on npm, with the registry's integrity. Refuses (nothing
 * written, nothing locked) when the version is not published or the registry cannot answer:
 * the cloud only ever installs a published version, so there is no fallback.
 */
async function lookupPin(env: HandsfreeEnv, verb: 'go' | 'setup'): Promise<VersionPin> {
  const v = env.localVersion();
  try {
    return await registryPin(v, env.registryFetch);
  } catch (err) {
    if (err instanceof NpmPinError && (err.kind === 'not_published' || err.kind === 'bad_version')) {
      throw new HandsfreeError('not_published', `this laptop runs dreamcontext ${v}, which is not on npm yet. Publish it (or update this laptop to a published version), then run ${verb} again.`, { version: v });
    }
    throw new HandsfreeError('registry', `the npm registry could not confirm dreamcontext ${v} (${(err as Error).message}); nothing was written or started. Run ${verb} again once npm answers.`, { version: v });
  }
}

/**
 * D25: the version pin in the private repo (`.devcontainer/bootstrap/version.json`), the
 * supervisor's first-boot install. Rewritten only when this laptop's record or the repo's blob
 * differs from the pin (a repo deleted or changed on GitHub is rewritten); its blob sha joins
 * fileShas, so AC19 checks it before every start/create. The go runs it after its own AC19
 * check, so a tampered repo is reported, never overwritten.
 */
async function ensurePin(env: HandsfreeEnv, pin: VersionPin, onProgress?: Progress): Promise<void> {
  const cfg = readConfig(env.home);
  if (!cfg?.repo) return;
  const bytes = pinFile(pin);
  const want = gitBlobSha(bytes);
  if (cfg.repo.fileShas[PIN_PATH] === want && (await env.repo.blobShas([PIN_PATH]))[PIN_PATH] === want) return;
  onProgress?.({ step: 'pin', detail: `pinning dreamcontext ${pin.version} for the cloud machine` });
  const shas = await env.repo.writeFiles({ [PIN_PATH]: bytes }, `dreamcontext handsfree: pin dreamcontext ${pin.version}`);
  await updateConfig(env.home, (c) => (c.repo ? { ...c, repo: { ...c.repo, fileShas: { ...c.repo.fileShas, ...shas } } } : c));
}

/** GitHub's own start of a stopped codespace: ~20 s to ~5 min seen (smoke #4); never longer than this. */
const START_WAIT_MS = 15 * 60_000;
const START_POLL_MS = 5000;
/** Right after a start is accepted GitHub may still report Shutdown for a moment. */
const START_ACCEPT_GRACE_MS = 60_000;

/** GitHub states that end a start for good. Every other unmapped state (Unknown, Updating,
 *  Exporting, Unavailable, Archived, Moved) may still turn into a running machine. */
const START_TERMINAL_STATES = new Set(['Failed', 'Deleted']);

/**
 * After a start (or a create): poll GitHub until the machine is `available`. Only then does the
 * server's 5-minute health deadline begin, so a slow cold start is never reported as a dead
 * server. Never judged on the reading taken BEFORE the start: the first check is a fresh read.
 * A terminal state (Failed, Deleted, the machine gone) or a machine back to stopped once it was
 * starting (or still stopped a minute after the start) fails at once; any other state counts as
 * still starting until the 15-minute deadline. At most one progress line a minute.
 */
async function waitAvailable(env: HandsfreeEnv, name: string, onProgress?: Progress): Promise<MachineInfo> {
  const t0 = nowOf(env);
  const deadline = t0 + START_WAIT_MS;
  let lastNote = t0;
  let seenStarting = false;
  const read = async (): Promise<MachineInfo> => {
    const got = await env.provider.get(name);
    if (!got) throw new HandsfreeError('cloud', 'the codespace disappeared on GitHub while it was starting. Run the same command again (a go re-creates it).', { phase: 'start', neverRan: true });
    return got;
  };
  let info = await read();
  for (;;) {
    if (info.state === 'available') return info;
    if (info.state === 'starting') seenStarting = true;
    const stoppedAgain = (info.state === 'stopped' || info.state === 'stopping') && (seenStarting || nowOf(env) - t0 >= START_ACCEPT_GRACE_MS);
    if ((info.state === 'other' && START_TERMINAL_STATES.has(info.rawState)) || stoppedAgain) {
      throw new HandsfreeError('cloud', `GitHub stopped starting the machine (it is ${info.rawState}). Run the same command again; if it keeps failing, open ${info.webUrl}.`, { phase: 'start', state: info.rawState, neverRan: true });
    }
    if (nowOf(env) >= deadline) {
      throw new HandsfreeError('cloud', `GitHub did not finish starting the machine within 15 minutes (it is still ${info.rawState}). It keeps starting: run the same command again.`, { phase: 'start', state: info.rawState });
    }
    await sleepOf(env)(START_POLL_MS);
    const now = nowOf(env);
    if (now - lastNote >= 60_000) {
      lastNote = now;
      onProgress?.({ step: 'start', detail: `GitHub is still starting the machine (${Math.floor((now - t0) / 60_000)} min)…` });
    }
    info = await read();
  }
}

async function waitHealthy(env: HandsfreeEnv, client: CloudClient): Promise<void> {
  const deadline = nowOf(env) + (env.healthTimeoutMs ?? 5 * 60_000);
  for (;;) {
    try {
      await client.publicHealth();
      return;
    } catch (err) {
      // A sign-in redirect past the client's 30 s grace may still be a slow boot (W0: ~22 s
      // start-to-health, longer on a loaded machine): only waitHealthy's own deadline makes it
      // port_private.
      if (nowOf(env) > deadline) {
        if (err instanceof PortPrivateError) throw new HandsfreeError('port_private', err.message);
        throw new HandsfreeError('cloud', `the machine started but its server did not answer within 5 minutes (${(err as Error).message}). It keeps running: run the same command again.`, { phase: 'health' });
      }
      await sleepOf(env)(5000);
    }
  }
}

/**
 * Bring the machine up: blob-sha check, re-create when GitHub deleted it (a full first
 * trip, new URL), the quota check against `needCoreMinutes` (AC23), start over REST, and
 * wait for /api/health on the forwarded URL (a GitHub sign-in redirect = port_private).
 */
async function ensureRunning(env: HandsfreeEnv, o: { needCoreMinutes?: number; allowCreate: boolean; onProgress?: Progress }): Promise<Running> {
  let cfg = requireConfig(env);
  await checkTemplateRepo(env, cfg);
  let info = await env.provider.get(cfg.codespace.name);
  let recreated = false;
  if (!info) {
    if (!o.allowCreate) throw new HandsfreeError('cloud', 'the codespace no longer exists on GitHub; the next go re-creates it');
    o.onProgress?.({ step: 'recreate', detail: 'GitHub deleted the codespace; creating a new one (new URL: re-add the app on the phone)' });
    try {
      info = await env.provider.create({ machine: cfg.codespace.machine });
    } catch (err) {
      if (err instanceof ProviderQuotaError) throw new HandsfreeError('quota', err.message, { resetsAt: err.resetsAt });
      throw err;
    }
    recreated = true;
    const fresh = info;
    cfg = (await updateConfig(env.home, (c) => ({ ...c, codespace: { name: fresh.name, machine: fresh.machine, url: fresh.url, webUrl: fresh.webUrl, retentionExpiresAt: fresh.retentionExpiresAt }, lastTrip: null }))) as typeof cfg;
  }
  cfg = ((await reconcileUptime(env, info)) ?? cfg) as typeof cfg;
  const cores = coresFor(info.machine);
  if (info.state !== 'available' && o.needCoreMinutes !== undefined) {
    const remote = await env.provider.remainingQuotaCoreMinutes();
    const remaining = remote ?? cfg.budgetCoreMinutes - usedCoreMinutes(cfg, cores, nowOf(env));
    if (remaining < o.needCoreMinutes) {
      throw new HandsfreeError('quota', `about ${Math.max(0, Math.floor(remaining / cores / 60))} h of Codespaces quota remain this month, below this trip's estimate plus a Return reserve (${Math.ceil(o.needCoreMinutes / cores / 60)} h). Nothing was started.`, { remainingCoreMinutes: remaining, needCoreMinutes: o.needCoreMinutes });
    }
  }
  let startedByUs = false;
  // GitHub refuses a start while the machine is still shutting down (409): let it finish first.
  for (let waited = 0; info.state === 'stopping' && waited < 2 * 60_000; waited += START_POLL_MS) {
    await sleepOf(env)(START_POLL_MS);
    info = (await env.provider.get(info.name)) ?? info;
  }
  if (info.state !== 'available') {
    o.onProgress?.({ step: 'start', detail: `starting ${info.name}` });
    try {
      await env.provider.start(info.name);
    } catch (err) {
      if (err instanceof ProviderQuotaError) throw new HandsfreeError('quota', err.message, { resetsAt: err.resetsAt, canAbandon: true });
      throw err;
    }
    startedByUs = true;
    await updateConfig(env.home, (c) => countUptime(c, true, cores, nowOf(env)));
  }
  if (info.state !== 'available') {
    // GitHub's own start first (its cold start alone took ~5 min in smoke #4); the server's
    // health deadline starts only once GitHub says the machine is available.
    try {
      info = await waitAvailable(env, info.name, o.onProgress);
    } catch (err) {
      // A machine that never came up does not run: close the count (a timeout keeps it open,
      // the machine keeps starting and the next observation reconciles it).
      if (err instanceof HandsfreeError && err.detail.neverRan === true) {
        await updateConfig(env.home, (c) => countUptime(c, false, cores, nowOf(env)));
      }
      throw err;
    }
  }
  const secret = await ensureTransferSecret(env.home);
  const client = env.connect(info.url, secret);
  if (startedByUs || recreated) client.markStarted(nowOf(env));
  o.onProgress?.({ step: 'health', detail: info.url });
  await waitHealthy(env, client);
  if (!cfg.codespace.healthyAt || info.name !== cfg.codespace.name) {
    const at = new Date(nowOf(env)).toISOString();
    const name = info.name;
    await updateConfig(env.home, (c) => (c.codespace?.name === name && !c.codespace.healthyAt ? { ...c, codespace: { ...c.codespace, healthyAt: at } } : c));
  }
  if (info.retentionExpiresAt !== cfg.codespace.retentionExpiresAt) {
    const r = info.retentionExpiresAt;
    await updateConfig(env.home, (c) => (c.codespace ? { ...c, codespace: { ...c.codespace, retentionExpiresAt: r } } : c));
  }
  return { client, info, recreated, startedByUs };
}

/**
 * AC23: fold what GitHub says into the laptop's own uptime count, for runs the laptop did not
 * start or did not watch stop. A stopped machine with an open count stopped itself (D15) or was
 * stopped elsewhere: close the count at GitHub's latest change after its start (`updated_at` is
 * the state change; `last_used_at` alone stays near the start for a REST-driven codespace), or
 * now when GitHub has nothing later. A running machine with no open count was started elsewhere
 * (the phone's Wake, a manual start): open it at GitHub's `updated_at`, else now.
 */
async function reconcileUptime(env: HandsfreeEnv, info: MachineInfo): Promise<HandsfreeConfig | null> {
  const now = nowOf(env);
  const ts = [info.updatedAt, info.lastUsedAt].map((x) => (x ? Date.parse(x) : NaN)).filter((t) => Number.isFinite(t) && t <= now);
  const cores = coresFor(info.machine);
  const cfg = readConfig(env.home, now);
  if (!cfg) return null;
  if ((info.state === 'stopped' || info.state === 'stopping') && cfg.uptime.runningSince !== null) {
    const since = cfg.uptime.runningSince;
    const later = ts.filter((t) => t >= since);
    const at = later.length ? Math.max(...later) : now;
    return updateConfig(env.home, (c) => countUptime(c, false, cores, at));
  }
  if (info.state === 'available' && cfg.uptime.runningSince === null) {
    const up = info.updatedAt ? Date.parse(info.updatedAt) : NaN;
    const at = Number.isFinite(up) && up <= now ? up : now;
    return updateConfig(env.home, (c) => countUptime(c, true, cores, at));
  }
  return cfg;
}

async function stopMachine(env: HandsfreeEnv, name: string): Promise<void> {
  await env.provider.stop(name);
  const cfg = readConfig(env.home);
  await updateConfig(env.home, (c) => countUptime(c, false, coresFor(cfg?.codespace?.machine ?? 'basicLinux32gb'), nowOf(env)));
}

/** Push a verifier change the cloud has not confirmed yet (AC3: pending until confirmed). */
async function deliverVerifiers(env: HandsfreeEnv, client: CloudClient, health: CloudHealth | null): Promise<boolean> {
  const cfg = readConfig(env.home);
  const v = cfg?.verifier;
  if (!v) return true;
  const needed = !!v.pending || (health !== null && health.verifierGeneration < v.push.generation);
  if (!needed) return true;
  // revoke-all only bumps the generation; when the cloud may lack the current passphrase
  // verifier, the full push (a higher generation signs every device out too) is sent instead.
  const r = v.pending?.kind === 'revoke' && v.confirmed === v.push.generation - 1
    ? await client.revokeAll(v.push.generation)
    : await client.verifiers(v.push);
  if (!r.ok && r.error !== 'stale_generation') throw new HandsfreeError('cloud', `the cloud refused the verifiers (${r.error})`);
  const gen = r.generation;
  await updateConfig(env.home, (c) => (c.verifier ? { ...c, verifier: { ...c.verifier, confirmed: Math.max(c.verifier.confirmed, gen), pending: c.verifier.pending && gen >= c.verifier.pending.generation ? null : c.verifier.pending } } : c));
  return true;
}

// ---------------------------------------------------------------- D21 finalization

/** What the cloud's health says about finalizing `trip` at `epoch` (D21 c). */
export type FinalizeObservation = 'sealed' | 'delta' | 'recover' | 'other' | 'unknown' | 'pending';

export async function observeFinalization(client: CloudClient, trip: string, epoch: number): Promise<FinalizeObservation> {
  let h: CloudHealth;
  try { h = await client.health(); } catch { return 'unknown'; }
  if (h.tripId !== trip) return 'other';
  // Sealed at our epoch: wipe + seal are done (every seal wipes the secret class first).
  if (h.phase === 'sealed') return h.sealedEpoch === epoch ? 'sealed' : 'recover';
  // The same trip went on after our snapshot (the phone woke it): a delta pass takes the rest.
  if (h.epoch > epoch) return 'delta';
  return 'pending';
}

export type EnsureSealedOutcome =
  | { kind: 'sealed' }
  | { kind: 'delta' }
  /** Sealed under another epoch: work after our snapshot may be there; the next go recovers it (D12). */
  | { kind: 'recover' }
  /** The cloud holds another trip (or none): nothing of ours is left to finalize there. */
  | { kind: 'other' }
  /** Unreachable, or the step failed while the cloud still waits at our epoch: queue the rest. */
  | { kind: 'queue'; remaining: Array<'wipe-secrets' | 'seal'> };

/**
 * D21: wipe-secrets then seal as idempotent ensure-operations. Any answer other than success
 * is never rethrown: the cloud's observed state decides (sealed at our epoch = done; same trip
 * at a newer epoch = delta pass; sealed at another epoch = recover; another trip = nothing
 * left; unreachable = queue the remaining steps).
 */
export async function ensureCloudSealed(client: CloudClient, trip: string, epoch: number, onProgress?: Progress): Promise<EnsureSealedOutcome> {
  const steps: Array<'wipe-secrets' | 'seal'> = ['wipe-secrets', 'seal'];
  for (let i = 0; i < steps.length; i++) {
    onProgress?.({ step: steps[i] });
    try {
      if (steps[i] === 'wipe-secrets') await client.wipeSecrets(epoch);
      else await client.seal(epoch);
    } catch (err) {
      if (!isReachabilityError(err)) throw err; // a local fault (a crash): Resume retries
      const obs = await observeFinalization(client, trip, epoch);
      if (obs === 'sealed' || obs === 'delta' || obs === 'recover' || obs === 'other') return { kind: obs };
      return { kind: 'queue', remaining: steps.slice(i) };
    }
  }
  return { kind: 'sealed' };
}

async function markLastTripOf(env: HandsfreeEnv, tripId: string, patch: Partial<NonNullable<HandsfreeConfig['lastTrip']>>): Promise<void> {
  // Never touches the record of a different trip (round-2 Minor 3).
  await updateConfig(env.home, (c) => (c.lastTrip?.tripId === tripId ? { ...c, lastTrip: { ...c.lastTrip, ...patch } } : c));
}

/**
 * Queued finalization of an earlier Return, at the next contact. Steps carry their trip id:
 * they are dropped when the observed state already satisfies them or the cloud's trip is
 * another one. Never throws; an unreachable cloud keeps the queue.
 */
async function runQueued(env: HandsfreeEnv, client: CloudClient, machineName: string, o: { stop: boolean }): Promise<string[]> {
  const q = readConfig(env.home)?.queued;
  if (!q) return [];
  const clear = () => updateConfig(env.home, (c) => (c.queued?.tripId === q.tripId ? { ...c, queued: null } : c));
  const done: string[] = [];
  const cloudSteps = q.steps.filter((s): s is 'wipe-secrets' | 'seal' => s !== 'stop');
  if (cloudSteps.length) {
    const obs = await observeFinalization(client, q.tripId, q.epoch);
    if (obs === 'unknown') return [];
    if (obs === 'other') { await clear(); return ['dropped']; }
    if (obs === 'delta' || obs === 'recover') {
      // The phone kept working after our snapshot: the next go recovers that work (D12).
      await markLastTripOf(env, q.tripId, { status: 'abandoned', recovered: false });
      await clear();
      return ['dropped'];
    }
    if (obs === 'pending') {
      const r = await ensureCloudSealed(client, q.tripId, q.epoch);
      if (r.kind === 'queue') return [];
      if (r.kind !== 'sealed') {
        if (r.kind !== 'other') await markLastTripOf(env, q.tripId, { status: 'abandoned', recovered: false });
        await clear();
        return ['dropped'];
      }
    }
    done.push(...cloudSteps);
  }
  if (q.steps.includes('stop') && o.stop) {
    try { await stopMachine(env, machineName); done.push('stop'); } catch {
      await updateConfig(env.home, (c) => (c.queued?.tripId === q.tripId ? { ...c, queued: { ...q, steps: ['stop'] } } : c));
      return done;
    }
  }
  await clear();
  return done;
}

// ---------------------------------------------------------------- setup

export interface SetupResult {
  passphrase: string | null;
  repo: string;
  codespace: MachineInfo;
  created: boolean;
}

export async function setup(env: HandsfreeEnv, o: { token?: string; login?: string; machine?: string; onProgress?: Progress } = {}): Promise<SetupResult> {
  const st = requireState(env);
  if (st.phase !== 'home') throw new HandsfreeError('not_home', `setup runs only while the laptop is home (now ${st.phase})`);
  if (o.token && o.login) {
    const { token, login } = o;
    await updateCredentials(env.home, (c) => ({ ...c, githubToken: token, githubLogin: login }));
  }
  if (!readCredentials(env.home).githubToken && !o.token) throw new HandsfreeError('not_setup', 'sign in to GitHub first (device flow, scopes repo + codespace)');
  // D25: the cloud installs this exact version from npm; an unpublished one refuses here,
  // before anything is written to the repo or a machine is created.
  const pin = await lookupPin(env, 'setup');
  const secret = await ensureTransferSecret(env.home);
  let cfg = await updateConfig(env.home, (c) => ({ ...c, owner: o.login ?? c.owner, machine: o.machine ?? c.codespace?.machine ?? c.machine }));
  let passphrase: string | null = null;
  if (!cfg.verifier) {
    passphrase = generatePassphrase();
    const push: VerifierPush = { generation: 1, passphrase: await hashPassphrase(passphrase), transferSha256: sha256Hex(secret) };
    cfg = await updateConfig(env.home, (c) => ({ ...c, verifier: { push, confirmed: 0, pending: { kind: 'password', generation: 1, since: new Date(nowOf(env)).toISOString() } } }));
  }
  let step: SetupStep = 'repo';
  let machineName: string | null = null;
  try {
    o.onProgress?.({ step: 'repo' });
    const full = await env.repo.ensure();
    const files = { ...env.templateFiles(), [BOOTSTRAP_VERIFIERS]: verifiersFile(cfg.verifier!.push), [PIN_PATH]: pinFile(pin) };
    const shas = await env.repo.writeFiles(files, 'dreamcontext handsfree setup');
    cfg = await updateConfig(env.home, (c) => ({ ...c, repo: { fullName: full, fileShas: shas } }));

    step = 'codespace';
    cfg = readConfig(env.home)!;
    let info = cfg.codespace ? await env.provider.get(cfg.codespace.name) : null;
    let created = false;
    // D24: a codespace's image (its /opt/dc-hf supervisor and poststart) is built ONCE, at
    // creation; it never sees a later repo change. One that never answered health and never
    // held a trip holds nothing, so it is re-created from the current repo. A codespace that
    // ever became healthy or held a trip is never deleted here.
    if (info && !cfg.codespace?.healthyAt && !cfg.lastTrip && !cfg.queued) {
      o.onProgress?.({ step: 'recreate', detail: `${info.name} never became healthy and never held a trip; re-creating it so it boots this laptop's build` });
      await env.provider.delete(info.name);
      info = null;
    }
    if (info && o.machine && info.machine !== o.machine) {
      throw new HandsfreeError('cloud', `the codespace runs on ${info.machine}; a different --machine needs \`dreamcontext handsfree teardown\` first (the idle timeout is fixed at creation)`);
    }
    if (info) machineName = info.name;
    else {
      o.onProgress?.({ step: 'create', detail: cfg.machine });
      try {
        info = await env.provider.create({ machine: cfg.machine });
      } catch (err) {
        if (err instanceof ProviderQuotaError) throw new HandsfreeError('quota', err.message, { resetsAt: err.resetsAt });
        throw err;
      }
      created = true;
      const fresh = info;
      machineName = fresh.name;
      await updateConfig(env.home, (c) => ({ ...c, codespace: { name: fresh.name, machine: fresh.machine, url: fresh.url, webUrl: fresh.webUrl, retentionExpiresAt: fresh.retentionExpiresAt } }));
    }
    // Start once (the in-codespace gh makes 8080 public), push the verifiers, leave it stopped.
    step = 'start';
    const up = await ensureRunning(env, { allowCreate: true, onProgress: o.onProgress });
    machineName = up.info.name;
    step = 'verifiers';
    const health = await up.client.health();
    assertOwnership(readConfig(env.home)!, health, {});
    await deliverVerifiers(env, up.client, health);
    step = 'stop';
    if (readTripState(env.home).phase === 'home') await stopMachine(env, up.info.name);
    return { passphrase, repo: full, codespace: up.info, created };
  } catch (err) {
    throw await setupFailed(env, err, step, machineName);
  }
}

type SetupStep = 'repo' | 'codespace' | 'start' | 'verifiers' | 'stop';

const SETUP_STEP_TEXT: Record<SetupStep, string> = {
  repo: 'writing the private repo',
  codespace: 'creating the codespace',
  start: 'starting the codespace and waiting for its health',
  verifiers: 'delivering the phone passphrase to the codespace',
  stop: 'stopping the codespace',
};

/**
 * D24: setup never leaves a running machine behind. The codespace is stopped (except when it
 * runs another laptop's live trip), and the error names the failed step and the next step.
 */
async function setupFailed(env: HandsfreeEnv, err: unknown, step: SetupStep, machineName: string | null): Promise<HandsfreeError> {
  const code: HandsfreeErrorCode = err instanceof HandsfreeError ? err.code : 'cloud';
  const why = ((err as Error)?.message ?? String(err)).replace(/\.$/, '');
  let machine = '';
  let stopped = false;
  if (machineName && code !== 'ownership' && code !== 'superseded' && readTripState(env.home).phase === 'home') {
    try {
      await stopMachine(env, machineName);
      stopped = true;
      machine = ` The codespace ${machineName} was stopped (no machine is left running).`;
    } catch (e) {
      machine = ` Stopping the codespace ${machineName} failed too (${(e as Error).message}): stop it at https://github.com/codespaces.`;
    }
  }
  const webUrl = readConfig(env.home)?.codespace?.webUrl;
  let next = 'fix the cause above, then run `dreamcontext handsfree setup` again.';
  if (code === 'quota') next = 'wait for the quota reset (above) or raise the Codespaces spending limit, then run `dreamcontext handsfree setup` again.';
  else if (code === 'tampered') next = 'check who changed the private repo, then run `dreamcontext handsfree setup` again to rewrite it.';
  else if (code === 'ownership' || code === 'superseded') next = 'see above: the machine belongs to another laptop\'s trip.';
  else if (step === 'start') next = `run \`dreamcontext handsfree setup\` again: a codespace that never became healthy and never held a trip is re-created and installs the pinned dreamcontext version from npm. If it fails again, open ${webUrl ?? 'the codespace'} and read /workspaces/dc-runtime/supervisor.log (sudo) and /tmp/dc-poststart.log.`;
  const detail = err instanceof HandsfreeError ? err.detail : {};
  return new HandsfreeError(code, `setup failed while ${SETUP_STEP_TEXT[step]}: ${why}.${machine} Next: ${next}`, { ...detail, step, stopped });
}

/** AC24: a live trip of another laptop refuses go/setup/teardown unless taken over. */
function assertOwnership(cfg: HandsfreeConfig, health: CloudHealth, o: { takeOver?: boolean; confirmLive?: boolean }): void {
  if (health.supersededLaptopIds.includes(cfg.laptopId)) {
    throw new HandsfreeError('superseded', 'another laptop took this cloud machine over; this laptop is no longer its owner');
  }
  if (!health.laptopId || health.laptopId === cfg.laptopId) return;
  const live = health.phase !== 'sealed';
  if (!o.takeOver) {
    if (live) throw new HandsfreeError('ownership', `the cloud machine is on a live trip started by another laptop (${health.laptopId}); use \`handsfree go --take-over\` only if that laptop is lost`);
    return;
  }
  if (live && !o.confirmLive) throw new HandsfreeError('confirm_take_over', 'the trip of the other laptop is still live: confirm the take-over twice (its cloud work is recovered here first)');
}

// ---------------------------------------------------------------- password / revoke-all (AC3)

async function deliverNow(env: HandsfreeEnv): Promise<{ confirmed: boolean; error?: string }> {
  const st = readTripState(env.home);
  try {
    const up = await ensureRunning(env, { allowCreate: false });
    let health: CloudHealth | null = null;
    try { health = await up.client.health(); } catch { health = null; }
    await deliverVerifiers(env, up.client, health);
    if (up.startedByUs && st.phase === 'home') await stopMachine(env, up.info.name);
    return { confirmed: !readConfig(env.home)?.verifier?.pending };
  } catch (err) {
    return { confirmed: false, error: (err as Error).message };
  }
}

async function bumpVerifiers(env: HandsfreeEnv, kind: 'password' | 'revoke'): Promise<{ passphrase: string | null; generation: number }> {
  const cfg = requireConfig(env);
  if (!cfg.verifier) throw new HandsfreeError('not_setup', 'no verifiers yet: run setup');
  const generation = Math.max(cfg.verifier.push.generation, cfg.verifier.confirmed) + 1;
  let passphrase: string | null = null;
  let push: VerifierPush = { ...cfg.verifier.push, generation };
  if (kind === 'password') {
    passphrase = generatePassphrase();
    push = { ...push, passphrase: await hashPassphrase(passphrase) };
  }
  await updateConfig(env.home, (c) => ({ ...c, verifier: { push, confirmed: c.verifier!.confirmed, pending: { kind, generation, since: new Date(nowOf(env)).toISOString() } } }));
  // The bootstrap copy in the repo follows, so a rebuild never installs an older generation.
  const shas = await env.repo.writeFiles({ [BOOTSTRAP_VERIFIERS]: verifiersFile(push) }, `dreamcontext handsfree ${kind}`);
  await updateConfig(env.home, (c) => (c.repo ? { ...c, repo: { ...c.repo, fileShas: { ...c.repo.fileShas, ...shas } } } : c));
  return { passphrase, generation };
}

/** `handsfree password`: a new generated passphrase (shown once); pending until the cloud confirms. */
export async function changePassword(env: HandsfreeEnv): Promise<{ passphrase: string; generation: number; confirmed: boolean; error?: string }> {
  const b = await bumpVerifiers(env, 'password');
  return { passphrase: b.passphrase!, generation: b.generation, ...(await deliverNow(env)) };
}

/** `handsfree devices revoke --all`: every device signs out; pending until the cloud confirms. */
export async function revokeAllDevices(env: HandsfreeEnv): Promise<{ generation: number; confirmed: boolean; error?: string }> {
  const b = await bumpVerifiers(env, 'revoke');
  return { generation: b.generation, ...(await deliverNow(env)) };
}

// ---------------------------------------------------------------- go

export interface GoResult {
  tripId: string;
  url: string;
  webUrl: string;
  recreated: boolean;
  /** Paths that stay on the laptop (D19) per root. */
  staysHome: Array<{ rootId: string; path: string; reason: string }>;
  /** Paths the cloud refused at files/receive. */
  cloudRefused: Array<{ rootId: string; path: string; reason: string }>;
  signedOutAccounts: string[];
  recovery: RecoveryReport | null;
  warnings: string[];
}

/**
 * `shouldCut` is the live twin of `cutRunning`: read on every wait round, so the owner can choose
 * Cut while a go/return is already waiting (the dashboard's `POST jobs/current/cut`).
 */
interface GoOpts { contextRoot: string; cutRunning?: boolean; shouldCut?: () => boolean; takeOver?: boolean; confirmTakeOverLive?: boolean; onProgress?: Progress }

async function preflightAll(env: HandsfreeEnv, scope: TripScope): Promise<Array<PreflightProblem & { repo: string }>> {
  const out: Array<PreflightProblem & { repo: string }> = [];
  for (const r of scope.roots.filter((x) => x.kind === 'repo' || x.kind === 'worktree')) {
    for (const p of await gitPreflight(env.run, r.absPath, { side: 'laptop' })) out.push({ ...p, repo: r.absPath });
  }
  return out;
}

/** How the owner resolves each refusal (AC9: name the repository, the path, and the fix). */
const PREFLIGHT_FIX: Partial<Record<PreflightProblem['kind'], (path: string | undefined) => string>> = {
  submodule: (p) => (p ? `"${p}" is a nested git repository (submodule or nested clone): add "${p}/" to .gitignore (or .git/info/exclude), or remove it, then try again` : 'submodules do not travel: remove .gitmodules or the submodules, then try again'),
  unmerged: () => 'finish or abort the merge (git merge --abort / commit the resolution), then try again',
  in_progress: () => 'finish or abort it (e.g. git rebase --abort, git merge --abort, git cherry-pick --abort, git bisect reset), then try again',
  lock: (p) => `${p ?? 'a git lock file'} is held: close the program using git there, or delete the stale lock if no git process runs, then try again`,
  bad_path: (p) => `"${p ?? '?'}" cannot travel (a .git segment or a refused spelling): rename or remove it, then try again`,
  filter: (p) => `${p ?? 'a filter driver'}: custom filter drivers do not travel; remove the filter= attribute, then try again`,
  lfs: () => 'Git LFS does not travel in hands-free mode v1',
  shallow: () => 'unshallow the clone (git fetch --unshallow), then try again',
  partial: () => 'partial clones do not travel: fetch every object (git fetch --refetch), then try again',
};

function preflightError(problems: Array<PreflightProblem & { repo: string }>): HandsfreeError {
  const lines = problems.map((p) => {
    const where = p.path && !p.detail.includes(p.path) ? ` (${p.path})` : '';
    const fix = PREFLIGHT_FIX[p.kind]?.(p.path);
    return `${p.repo}: ${p.detail}${where}${fix && !p.detail.includes('try again') ? ` — ${fix}` : ''}`;
  });
  return new HandsfreeError('preflight', `cannot go hands-free yet:\n  ${lines.join('\n  ')}`, { problems });
}

async function estimateTripBytes(env: HandsfreeEnv, scope: TripScope): Promise<number> {
  let total = 0;
  for (const r of scope.roots) {
    if (r.kind === 'repo') total += await estimateRepoBytes(env.run, r.absPath);
    else if (r.kind === 'transcripts') total += dirBytes(r.absPath);
    else if (r.kind === 'vault') total += dirBytes(join(r.absPath, '_dream_context'));
  }
  return total;
}

/** AC22: refuse a go whose estimated size does not fit the machine's disk; name a bigger --machine. */
async function diskFit(env: HandsfreeEnv, scope: TripScope, machine: string): Promise<void> {
  const types = await env.provider.machineTypes();
  const cur = types.find((t) => t.name === machine);
  if (!cur || !cur.storageBytes) return;
  const need = Math.ceil((await estimateTripBytes(env, scope)) * 1.3);
  const free = cur.storageBytes - IMAGE_OVERHEAD_BYTES;
  if (need <= free) return;
  const bigger = types.find((t) => t.storageBytes - IMAGE_OVERHEAD_BYTES >= need);
  throw new HandsfreeError('disk', `this trip needs about ${(need / 2 ** 30).toFixed(1)} GB but ${machine} has about ${(free / 2 ** 30).toFixed(1)} GB free.${bigger ? ` Re-create the machine bigger: \`dreamcontext handsfree teardown\` then \`dreamcontext handsfree setup --machine ${bigger.name}\`.` : ' No machine type is big enough: exclude large folders first.'}`, { needBytes: need, freeBytes: free, biggerMachine: bigger?.name ?? null });
}

/** Wait for (or cut) running work in the roots; idle chats are cut without asking. */
async function settleTurns(env: HandsfreeEnv, roots: string[], cutRunning: boolean, onProgress?: Progress, shouldCut?: () => boolean): Promise<number> {
  const deadline = nowOf(env) + (env.waitTimeoutMs ?? 2 * 60 * 60_000);
  let cut = 0;
  for (;;) {
    const work = await env.turns.list(roots);
    if (work.some((w) => !w.busy)) cut += await env.turns.cut(roots, { all: false });
    const busy = work.filter((w) => w.busy);
    if (busy.length === 0) return cut;
    if (cutRunning || shouldCut?.()) {
      // A failed process scan cannot be cut: refuse instead of looping (fail closed).
      if (busy.some((w) => w.id === UNKNOWN_WORK_ID)) throw new HandsfreeError('turns_running', 'running work in the project could not be checked (the process scan failed); try again', { running: busy });
      cut += await env.turns.cut(roots, { all: true });
      continue;
    }
    if (nowOf(env) > deadline) throw new HandsfreeError('turns_running', `${busy.length} turn(s) are still running in the project; wait for them or use Cut (--cut-running)`, { running: busy });
    onProgress?.({ step: 'waiting', detail: `${busy.length} running`, running: busy });
    await sleepOf(env)(2000);
  }
}

/** Checkout ids are the root ids of their (laptop) realpaths. */
function checkoutIdFor(abs: string): string {
  return rootIdFor(realpathOr(abs));
}
function realpathOr(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

function underHome(home: string) {
  const h = realpathOr(home);
  return (p: string) => p.startsWith(h + sep);
}

/** Non-git set of one root, walked on the laptop (D19 'stays on the laptop' excluded). */
async function laptopManifest(env: HandsfreeEnv, root: RootSpec, include: string[], previous?: Manifest): Promise<{ manifest: Manifest; refused: Array<{ path: string; reason: string }> }> {
  const sel = root.kind === 'transcripts'
    ? walk(root.absPath, [''], { side: 'laptop' })
    : await selectNonGitEntries(env.run, root.absPath, { isGitRepo: root.kind === 'repo' || root.kind === 'worktree', include, side: 'laptop' });
  const refused = [...sel.refused];
  const manifest = await buildManifest(root.absPath, sel.entries, previous, refused);
  return { manifest, refused };
}

function readManifestFile(path: string): Manifest | null {
  try { return manifestFromJSON(readJson<{ manifest: unknown }>(path).manifest); } catch { return null; }
}

const agreedGlobalPath = (env: HandsfreeEnv, rootId: string) => join(handsfreeDir(env.home), 'agreed', `${rootId}.files.json`);

function copySessionState(root: string, dest: string): void {
  for (const rel of [ROSTER_REL, TITLES_REL]) {
    const src = join(root, ...rel.split('/'));
    if (existsSync(src)) { mkdirSync(dirname(join(dest, ...rel.split('/'))), { recursive: true }); copyFileSync(src, join(dest, ...rel.split('/'))); }
  }
  const mapSrc = join(root, ...SESSION_MAP_REL.split('/'));
  let names: string[] = [];
  try { names = readdirSync(mapSrc).filter((n) => n.endsWith('.json')); } catch { /* none */ }
  if (names.length) mkdirSync(join(dest, ...SESSION_MAP_REL.split('/')), { recursive: true });
  for (const n of names) copyFileSync(join(mapSrc, n), join(dest, ...SESSION_MAP_REL.split('/'), n));
}

async function packFile(path: string, root: string, entries: Iterable<ManifestEntry>, deletions: string[] = []): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await writePack(createWriteStream(path, { mode: 0o600 }), { root, entries, deletions });
}

/**
 * A remote URL without userinfo (wire v1.1): `https://user:tok@host/x` -> `https://host/x`,
 * scp-like `git@host:x` -> `host:x`. The cloud never fetches or pushes; it only shows them.
 */
export function stripUserinfo(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      u.username = '';
      u.password = '';
      return u.toString();
    } catch {
      return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
    }
  }
  const scp = /^[^/@:]+@([^/:]+:.*)$/.exec(url);
  return scp ? scp[1] : url;
}

const REMOTE_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** The laptop's `.git/info/exclude` + `attributes` and its remotes (userinfo stripped), for git/receive. */
export async function gitInfoFor(run: ProcessRunner, repo: string): Promise<{ info: { exclude?: string; attributes?: string }; remotes: Array<{ name: string; url: string }> }> {
  const common = (await gitOut(run, repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const info: { exclude?: string; attributes?: string } = {};
  for (const k of ['exclude', 'attributes'] as const) {
    const p = join(common, 'info', k);
    let size: number;
    try { size = statSync(p).size; } catch { continue; }
    if (size > GIT_INFO_MAX_BYTES) throw new HandsfreeError('preflight', `${p} is larger than 256 KiB; hands-free mode cannot carry it`);
    info[k] = readFileSync(p, 'utf8');
  }
  const remotes: Array<{ name: string; url: string }> = [];
  const r = await git(run, repo, ['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true });
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const m = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
    if (m && REMOTE_NAME_RE.test(m[1])) remotes.push({ name: m[1], url: stripUserinfo(m[2]) });
  }
  return { info, remotes };
}

/** The bundle base refs the laptop keeps for a repo (last agreed snapshot), named t<n>. */
function baseRefsFor(oids: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  [...new Set(oids)].sort().forEach((oid, i) => { out[`refs/handsfree/base/t${i}`] = oid; });
  return out;
}

function goHandlers(env: HandsfreeEnv, client: CloudClient, go: GoManifest): OpHandlers {
  type P = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    'go.trip': {
      apply: async (op) => {
        const p = op.params as P;
        try {
          const deadline = nowOf(env) + MIRROR_PENDING_WAIT_MS;
          for (;;) {
            try {
              await client.trip({ tripId: p.tripId, laptopId: p.laptopId, go, ...(p.takeOver ? { takeOver: true } : {}), includes: p.includes ?? {} });
              break;
            } catch (err) {
              // The mirror is not mounted yet after a fresh start: retryable, bounded.
              const pending = (err instanceof CloudUnreachableError && err.lastCode === 'mirror_pending') || (err instanceof CloudError && err.code === 'mirror_pending');
              if (!pending || nowOf(env) > deadline) throw err;
              await sleepOf(env)(5000);
            }
          }
        } catch (err) {
          // A replay after a crash: the cloud already holds this trip.
          if (err instanceof CloudError && err.code === 'not_sealed') {
            const h = await client.health();
            if (h.tripId === p.tripId && h.laptopId === p.laptopId) return;
          }
          throw err;
        }
      },
    },
    'go.git': {
      apply: async (op) => {
        const p = op.params as P;
        const snap = readJson<RepoSnapshot>(p.snapshotPath);
        const uploadId = p.bundlePath && existsSync(p.bundlePath) ? await client.uploadFile(p.bundlePath) : undefined;
        const r = await client.gitReceive({ tripId: go.tripId, rootId: p.rootId, ...(uploadId ? { uploadId } : {}), snapshot: snap, info: p.info ?? {}, remotes: p.remotes ?? [] });
        if (r.snapshotId !== p.expectedId) {
          throw new HandsfreeError('equality', `the cloud's copy of ${snap.repoPath} does not equal the laptop's after go (AC2); nothing was activated`, { rootId: p.rootId });
        }
        const oids = [...Object.values(snap.refs), ...snap.stash.map((s) => s.oid)];
        const snapRefs = await gitOut(env.run, snap.repoPath, ['for-each-ref', '--format=%(objectname)', snapRefPrefix(go.tripId) + '/']);
        oids.push(...snapRefs.split('\n').filter(Boolean));
        await setBaseRefs(env.run, snap.repoPath, baseRefsFor(oids));
        return { snapshotId: r.snapshotId };
      },
    },
    'go.files': {
      apply: async (op) => {
        const p = op.params as P;
        const expected = readJson<{ manifest: ManifestEntry[] }>(p.manifestPath).manifest;
        const send = async (packPath: string) => {
          const uploadId = await client.uploadFile(packPath);
          return client.filesReceive({ tripId: go.tripId, rootId: p.rootId, uploadId, expected });
        };
        const want = (refused: Array<{ path: string }>) => manifestDigest(expected.filter((e) => !refused.some((r) => r.path === e.path)));
        let r = await send(p.packPath);
        if (r.digest !== want(r.refused)) {
          // The cloud lacked something we thought it had: send everything once.
          const full = p.packPath.replace(/\.pack$/, '.full.pack');
          await packFile(full, p.root, expected);
          r = await send(full);
          if (r.digest !== want(r.refused)) throw new HandsfreeError('equality', `the cloud's files of ${p.root} do not equal the laptop's after go (AC2)`, { rootId: p.rootId });
        }
        return { refused: r.refused };
      },
    },
    'go.global': {
      apply: async (op) => {
        const p = op.params as P;
        await client.global(await client.uploadFile(p.packPath));
      },
    },
    'go.activate': {
      apply: async (op) => { await client.activate((op.params as P).tripId); },
    },
  };
}

export async function go(env: HandsfreeEnv, o: GoOpts): Promise<GoResult> {
  const st = requireState(env);
  if (st.phase !== 'home') throw new HandsfreeError('not_home', `a trip is already ${st.phase} (${st.tripId}); return, resume or abandon it first`);
  const cfg = requireConfig(env);
  const scope = await computeScope({ run: env.run, home: env.home, contextRoot: o.contextRoot, claudeProjectsDir: projectsDir(env) });
  // Step 1: preflight (setup, scope + size vs the machine's disk, git preflight).
  o.onProgress?.({ step: 'preflight' });
  const problems = await preflightAll(env, scope);
  if (problems.length) throw preflightError(problems);
  await diskFit(env, scope, cfg.codespace.machine);
  // D25: this exact version on npm (refused before anything is written or locked), the AC19
  // check, then the version pin in the repo (after the check: a tampered repo is reported,
  // never overwritten). It touches no local folder.
  const pin = await lookupPin(env, 'go');
  await checkTemplateRepo(env, cfg);
  await ensurePin(env, pin, o.onProgress);
  // Step 2: LOCK FIRST.
  const tripId = newTripId(nowOf(env));
  await beginGoing(tripId, scope.roots.filter((r) => r.kind !== 'transcripts').map((r) => ({ rootId: r.rootId, path: r.absPath })), env.home);
  const dir = tripDirFor(env, tripId);
  mkdirSync(dir, { recursive: true });
  const lock = acquireTripRunLock(dir);
  if (!lock) throw new HandsfreeError('busy', 'another go or return is running for this trip');
  let up: Running | null = null;
  try {
    return await goAfterLock(env, o, scope, tripId, dir, pin, (r) => { up = r; });
  } catch (err) {
    // Before the go journal exists nothing was sent: unlock (home). After it: resume/abandon,
    // except a failed verification, which can never succeed on retry: back home (below).
    if (!existsSync(journalPath(dir, 'go'))) {
      await transition(env, tripId, 'home').catch(() => {});
      const u = up as Running | null;
      if (err instanceof HandsfreeError && err.code === 'trip_lost') await stopOrQueue(env, tripId).catch(() => {});
      else if (u?.startedByUs) await stopMachine(env, u.info.name).catch(() => {});
    } else await abortGoOnVerification(env, tripId, dir, err);
    throw err;
  } finally {
    lock.release();
  }
}

/**
 * A go whose cloud copy does not verify (AC2 equality) after the lock: a retry would fail the
 * same way, so the trip is dropped and the laptop goes home through the guarded transition
 * (the cloud never activated; the next go mirrors again). The go journal is archived, the
 * machine stopped (queued when GitHub is unreachable). Any other failure stays resumable.
 */
/**
 * A recovery the cloud cannot run (its trip marker is missing and its folders are not on disk:
 * `mirror_absent`; or an older cloud's `trip_lost`): NEVER seal or wipe. The trip stays
 * abandoned + unrecovered (the next go retries the recovery and refuses meanwhile), with the
 * owner's explicit way out. Any other error is returned unchanged.
 */
async function lostTripRefusal(env: HandsfreeEnv, err: unknown, oldTrip: string, report: RecoveryReport): Promise<unknown> {
  if (!(err instanceof CloudError && (err.code === 'trip_lost' || err.code === 'mirror_absent'))) return err;
  report.lost = true;
  await markLastTrip(env, oldTrip, { status: 'abandoned', recovered: false });
  const why = err.code === 'mirror_absent'
    ? 'its trip marker is missing and its folders are not on the cloud machine (is the mirror mounted?)'
    : 'its trip marker is missing and this cloud cannot snapshot it';
  return new HandsfreeError(
    'needs_recovery',
    `the cloud machine cannot recover trip ${oldTrip}: ${why}. Nothing was sealed or wiped, and nothing will be mirrored over that work. Try again once the machine has its folders back (the next go retries the recovery first), or discard that work explicitly: \`dreamcontext handsfree teardown --discard-abandoned-work\`.`,
    { oldTrip, cause: err.code },
  );
}

/** The go manifest's roots as a recovery scope (destinations stay the laptop's own, AC10). */
function scopeFromGo(goM: GoManifest): TripScope {
  const inside = (parent: string, child: string) => child !== parent && child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  return {
    vaultRoot: goM.roots.find((r) => r.kind === 'vault' || r.kind === 'repo')?.absPath ?? goM.home,
    roots: goM.roots,
    repos: goM.roots.filter((r) => r.kind === 'repo').map((r) => ({
      rootId: r.rootId, path: r.absPath,
      nested: goM.roots.filter((x) => x !== r && x.kind !== 'worktree' && x.kind !== 'transcripts' && inside(r.absPath, x.absPath)).map((x) => x.absPath),
    })),
    include: [],
  };
}

/**
 * A Return that met `trip_lost`: run the full D12 recovery of this trip (recovery quiesce ->
 * cut -> tolerant snapshot -> park into refs/handsfree/<trip>/* and trips/<trip>/orphaned/ ->
 * seal). Returns what happened, for the owner's message; never seals without the snapshot.
 */
async function recoverLostOnReturn(env: HandsfreeEnv, getClient: () => Promise<CloudClient>, trip: string, dir: string): Promise<{ recovered: boolean; message: string }> {
  const goM = readJson<GoManifest>(join(dir, 'go-manifest.json'));
  try {
    const rep = await recoverTrip(env, await getClient(), trip, scopeFromGo(goM));
    return { recovered: true, message: `the cloud lost this trip's marker; its work was recovered into refs/handsfree/${trip}/* and trips/${trip}/orphaned/ (${rep.parked.length} repo(s), ${rep.orphaned.reduce((n, o) => n + o.files, 0)} file(s)), then the cloud was sealed` };
  } catch (err) {
    if (err instanceof HandsfreeError && err.code === 'needs_recovery') return { recovered: false, message: err.message };
    if (!isReachabilityError(err)) throw err;
    await markLastTrip(env, trip, { status: 'abandoned', recovered: false });
    return { recovered: false, message: `the cloud lost this trip's marker and could not be recovered now (${(err as Error).message}); nothing was sealed or wiped: the next go recovers it first, or \`dreamcontext handsfree teardown --discard-abandoned-work\` discards it` };
  }
}

/** Stop the machine now, or queue the stop with its trip id when GitHub cannot be reached. */
async function stopOrQueue(env: HandsfreeEnv, tripId: string): Promise<void> {
  const name = readConfig(env.home)?.codespace?.name;
  if (!name) return;
  try { await stopMachine(env, name); } catch (e) {
    if (!isReachabilityError(e)) throw e;
    await updateConfig(env.home, (c) => ({ ...c, queued: { tripId, epoch: 0, steps: ['stop'], since: new Date(nowOf(env)).toISOString() } }));
  }
}

async function abortGoOnVerification(env: HandsfreeEnv, tripId: string, dir: string, err: unknown): Promise<boolean> {
  if (!(err instanceof HandsfreeError && err.code === 'equality')) return false;
  if (existsSync(journalPath(dir, 'go'))) renameSync(journalPath(dir, 'go'), join(dir, `go-journal.failed-${nowOf(env)}.json`));
  await transition(env, tripId, 'home');
  await stopOrQueue(env, tripId);
  return true;
}

/**
 * AC3: register the trip's project (the go manifest's first root, which the cloud's login
 * redirect looks up) in this laptop's vault registry exactly as Add Project does (`addVault`),
 * unless a vault already points at it. Idempotent; the folder name is kept (a taken name gets
 * `-2`, `-3`, ...). Never fails the go: an unregistrable project only loses the redirect.
 */
function ensureProjectRegistered(env: HandsfreeEnv, scope: TripScope, onProgress?: Progress): void {
  const root = scope.roots.find((r) => r.kind !== 'worktree' && r.kind !== 'transcripts');
  if (!root) return;
  const want = resolve(root.absPath);
  if (listVaults(env.home).some((v) => resolve(v.path) === want)) return;
  const base = vaultNameForPath(want);
  for (const name of [base, ...Array.from({ length: 20 }, (_, i) => `${base}-${i + 2}`)]) {
    try {
      addVault(name, want, env.home);
      onProgress?.({ step: 'register', detail: `registered ${name} so the phone opens its chat` });
      return;
    } catch (err) {
      if (!(err instanceof VaultError && /already registered/i.test(err.message) && /named/i.test(err.message))) return;
    }
  }
}

async function goAfterLock(env: HandsfreeEnv, o: GoOpts, scope: TripScope, tripId: string, dir: string, pin: VersionPin, onUp: (r: Running) => void): Promise<GoResult> {
  const warnings: string[] = [];
  // Step 3: wait for or cut in-scope turns; re-run the git preflight after a cut.
  const codeRoots = scope.roots.filter((r) => r.kind !== 'transcripts').map((r) => r.absPath);
  const cut = await settleTurns(env, codeRoots, !!o.cutRunning, o.onProgress, o.shouldCut);
  if (cut > 0) {
    const again = await preflightAll(env, scope);
    if (again.length) throw preflightError(again);
  }
  // Step 4: ownership, quota, blob shas, start, health, recovery, parity, verifiers, accounts.
  const cfg = requireConfig(env);
  const cores = coresFor(cfg.codespace.machine);
  const need = cores * (cfg.tripEstimateHours * 60 + RETURN_RESERVE_MINUTES);
  const up = await ensureRunning(env, { needCoreMinutes: need, allowCreate: true, onProgress: o.onProgress });
  onUp(up);
  const client = up.client;
  let health = await client.health();
  assertOwnership(cfg, health, { takeOver: o.takeOver, confirmLive: o.confirmTakeOverLive });
  if ((await runQueued(env, client, up.info.name, { stop: false })).length) health = await client.health();
  let recovery: RecoveryReport | null = null;
  const fresh = readConfig(env.home)!;
  const foreign = !!health.laptopId && health.laptopId !== fresh.laptopId;
  const ours = !foreign && health.tripId && fresh.lastTrip?.tripId === health.tripId;
  const needsRecovery = !!health.tripId && (health.phase !== 'sealed' || (ours && fresh.lastTrip?.status !== 'sealed' && !fresh.lastTrip?.recovered));
  if (needsRecovery) {
    o.onProgress?.({ step: 'recovery', detail: health.tripId! });
    recovery = await recoverTrip(env, client, health.tripId!, scope, o.onProgress);
    health = await client.health();
    if (recovery.lost && health.phase !== 'sealed') {
      // The cloud lost the old trip's marker and refuses to quiesce it, so it can never be sealed
      // from here, and POST trip needs a sealed cloud. Nothing was sent: home, machine stopped.
      throw new HandsfreeError('trip_lost', `the cloud machine lost the marker of trip ${recovery.oldTrip} and is still ${health.phase}; it cannot be sealed from this laptop, so a new trip cannot start. Everything on this laptop was kept. The cloud side must be able to quiesce and seal a lost-marker trip (or \`dreamcontext handsfree teardown --discard-abandoned-work\` re-creates the machine).`, { oldTrip: recovery.oldTrip, phase: health.phase });
    }
  }
  // Version parity (AC18, D25): the cloud runs this laptop's exact version, from npm. The
  // request carries only {version, integrity}; the root supervisor fetches and verifies it.
  if (health.version !== pin.version) {
    o.onProgress?.({ step: 'parity', detail: `installing dreamcontext ${pin.version} on the cloud machine (it runs ${health.version})` });
    await client.runtime(pin);
    client.markStarted(nowOf(env));
    const deadline = nowOf(env) + PARITY_WAIT_MS;
    for (;;) {
      await sleepOf(env)(3000);
      const h = await client.publicHealth().catch(() => null);
      if (h?.version === pin.version) break;
      if (nowOf(env) > deadline) {
        throw new HandsfreeError('parity', `the cloud machine did not come back on dreamcontext ${pin.version} within 10 minutes (it reports ${h?.version ?? 'nothing'}); it keeps its last good build. Nothing was sent: run go again.`, { version: pin.version });
      }
    }
    health = await client.health();
  }
  await deliverVerifiers(env, client, health);
  const accounts = await client.accounts().catch(() => []);
  const signedOutAccounts = accounts.filter((a) => !a.signedIn).map((a) => a.id);

  // Step 5: snapshot both sides ONCE, persist, then the go journal.
  o.onProgress?.({ step: 'snapshot' });
  const goM = goManifestFor(scope, { tripId, laptopId: cfg.laptopId, home: env.home, now: new Date(nowOf(env)) });
  writeJson(join(dir, 'go-manifest.json'), goM);
  writeJson(join(dir, 'scope.json'), { include: scope.include });
  const ops: Array<Pick<JournalOp, 'id' | 'kind' | 'params' | 'writes'>> = [
    {
      id: 'trip', kind: 'go.trip', writes: false,
      params: { tripId, laptopId: cfg.laptopId, takeOver: !!o.takeOver, includes: Object.fromEntries(scope.roots.filter((r) => r.kind !== 'transcripts').map((r) => [r.rootId, scope.include])) },
    },
  ];
  const inHome = underHome(env.home);
  for (const repo of scope.repos) {
    const s = await snapshotRepo(env.run, repo.path, {
      trip: tripId, side: 'laptop', includeRemotes: true, checkoutIdFor, checkoutFilter: inHome, extraNestedRoots: repo.nested,
    });
    const snapshotPath = join(dir, 'start', `${repo.rootId}.git.json`);
    writeJson(snapshotPath, s);
    writeJson(join(dir, 'agreed', `${repo.rootId}.git.json`), s);
    const state = await client.state(repo.rootId).catch(() => null);
    const known = state?.kind === 'repo' ? state.baseTips : [];
    const bundlePath = join(dir, 'go', `${repo.rootId}.bundle`);
    mkdirSync(dirname(bundlePath), { recursive: true });
    const b = await createBundle(env.run, repo.path, { refs: snapshotBundleRefs(s), knownTips: known, out: bundlePath });
    const { info, remotes } = await gitInfoFor(env.run, repo.path);
    ops.push({ id: `git:${repo.rootId}`, kind: 'go.git', writes: false, params: { rootId: repo.rootId, snapshotPath, bundlePath: b.created ? bundlePath : null, expectedId: snapshotId(s), info, remotes } });
  }
  const staysHome: GoResult['staysHome'] = [];
  for (const root of scope.roots) {
    const agreedPrev = readManifestFile(agreedGlobalPath(env, root.rootId));
    const { manifest, refused } = await laptopManifest(env, root, scope.include, agreedPrev ?? undefined);
    for (const r of refused) staysHome.push({ rootId: root.rootId, path: r.path, reason: r.reason });
    const manifestPath = join(dir, 'start', `${root.rootId}.files.json`);
    writeJson(manifestPath, { manifest: manifestToJSON(manifest), refused });
    writeJson(join(dir, 'agreed', `${root.rootId}.files.json`), { manifest: manifestToJSON(manifest), refused });
    copySessionState(root.absPath, join(dir, 'start', 'session', root.rootId));
    // Delta against what the cloud holds: its own manifest for a files root, the last agreed one otherwise.
    const state = await client.state(root.rootId).catch(() => null);
    const cloudHas: Manifest | null = state?.kind === 'files' ? manifestFromJSON(state.manifest) : agreedPrev;
    const entries = [...manifest.values()].filter((e) => !cloudHas || !sameContent(cloudHas.get(e.path), e));
    const deletions = cloudHas ? [...cloudHas.keys()].filter((p) => !manifest.has(p)) : [];
    const packPath = join(dir, 'go', `${root.rootId}.pack`);
    await packFile(packPath, root.absPath, entries, deletions);
    ops.push({ id: `files:${root.rootId}`, kind: 'go.files', writes: false, params: { rootId: root.rootId, root: root.absPath, packPath, manifestPath } });
  }
  // Step 6: the one-way global set. AC3 first: the cloud opens the trip's chat by the project's
  // REGISTERED name, and a project taken with the CLI may never have been added in the app.
  ensureProjectRegistered(env, scope, o.onProgress);
  const staging = join(dir, 'go', 'global');
  await stageGlobalSet({ home: env.home, staging, run: env.run });
  const gm = await buildManifest(staging, walk(staging, [''], { side: 'laptop' }).entries);
  const globalPack = join(dir, 'go', 'global.pack');
  await packFile(globalPack, staging, gm.values());
  ops.push({ id: 'global', kind: 'go.global', writes: false, params: { packPath: globalPack } });
  // Step 7 runs in the cloud on activate (lockfile install); step 8: active.
  ops.push({ id: 'activate', kind: 'go.activate', writes: false, params: { tripId } });
  createJournal(journalPath(dir, 'go'), { trip: tripId, direction: 'go', ops });
  return finishGo(env, client, up, goM, dir, { staysHome, signedOutAccounts, recovery, warnings, onProgress: o.onProgress });
}

async function finishGo(
  env: HandsfreeEnv, client: CloudClient, up: Running, goM: GoManifest, dir: string,
  extra: Pick<GoResult, 'staysHome' | 'signedOutAccounts' | 'recovery' | 'warnings'> & { onProgress?: Progress },
): Promise<GoResult> {
  const j = await runJournal(journalPath(dir, 'go'), goHandlers(env, client, goM), { onOp: (op) => extra.onProgress?.({ step: op.kind, detail: op.id }), beforeOp: env.beforeOp });
  const cloudRefused: GoResult['cloudRefused'] = [];
  for (const op of j.ops) {
    if (op.kind !== 'go.files') continue;
    for (const r of ((op.result as { refused?: Array<{ path: string; reason: string }> } | undefined)?.refused ?? [])) cloudRefused.push({ rootId: (op.params as { rootId: string }).rootId, ...r });
  }
  await transition(env, goM.tripId, 'away');
  await updateConfig(env.home, (c) => ({ ...c, lastTrip: { tripId: goM.tripId, status: 'away', at: new Date(nowOf(env)).toISOString() } }));
  writeJson(join(dir, 'go-result.json'), { url: up.info.url, staysHome: extra.staysHome, cloudRefused, signedOutAccounts: extra.signedOutAccounts });
  return { tripId: goM.tripId, url: up.info.url, webUrl: up.info.webUrl, recreated: up.recreated, cloudRefused, ...extra };
}

// ---------------------------------------------------------------- D12 recovery

export interface RecoveryReport {
  oldTrip: string;
  lost: boolean;
  parked: Array<{ rootId: string; refs: Record<string, string> }>;
  orphaned: Array<{ rootId: string; dir: string; files: number; deletions: string[] }>;
  /** Cloud roots this laptop has no root for (take-over from another laptop): kept as downloads. */
  unmapped: string[];
  /** A lost-marker trip the cloud let us seal (recovery quiesce answered tripLost). */
  sealed?: boolean;
  /** Cloud refs whose content the laptop refused (fsck, a .git path): left in the cloud, named here. */
  refused: Array<{ rootId: string; repo: string; refs: string[]; paths: string[] }>;
}

/**
 * D12 recovery of an abandoned (or another laptop's live) trip, under ONE epoch:
 * quiesce{recovery} -> cut -> snapshot{tolerant} -> fetch every cloud ref, stash entry and
 * snapshot commit into `refs/handsfree/<old>/*` and its files into `trips/<old>/orphaned/`
 * -> seal. A tolerant snapshot is never applied to a working tree. `trip_lost` keeps
 * everything and treats the trip as abandoned.
 */
export async function recoverTrip(env: HandsfreeEnv, client: CloudClient, oldTrip: string, scope: TripScope, onProgress?: Progress): Promise<RecoveryReport> {
  const report: RecoveryReport = { oldTrip, lost: false, parked: [], orphaned: [], unmapped: [], refused: [] };
  const dir = tripDirFor(env, oldTrip);
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let epoch: number;
    try {
      const q = await client.quiesce(oldTrip, true);
      // A lost marker (`tripLost`) runs the SAME full recovery under this epoch: cut -> tolerant
      // snapshot -> park -> seal. "Marker missing" never means "nothing to recover".
      if (q.tripLost) report.lost = true;
      epoch = q.epoch;
    } catch (err) {
      throw await lostTripRefusal(env, err, oldTrip, report);
    }
    await client.cut(epoch);
    const knownTips: Record<string, string[]> = {};
    for (const r of scope.repos) knownTips[r.rootId] = await baseTips(env.run, r.path);
    let snap: SnapshotReply;
    try {
      snap = await client.snapshot({ epoch, tolerant: true, knownTips });
    } catch (err) {
      throw await lostTripRefusal(env, err, oldTrip, report);
    }
    const rdir = join(dir, 'recovery', `e${epoch}`);
    mkdirSync(rdir, { recursive: true });
    // Download everything first.
    for (const r of snap.roots) {
      if (r.kind === 'repo' && r.bundle) await client.downloadTo(r.bundle, join(rdir, `${r.rootId}.bundle`));
      if (r.kind === 'files' && r.pack) await client.downloadTo(r.pack, join(rdir, `${r.rootId}.pack`));
    }
    for (const r of snap.roots) {
      const repo = scope.repos.find((x) => x.rootId === r.rootId);
      const root = scope.roots.find((x) => x.rootId === r.rootId);
      if (r.kind === 'repo') {
        if (!repo) { report.unmapped.push(r.rootId); continue; }
        onProgress?.({ step: 'recovery-park', detail: repo.path });
        let s: RepoSnapshot;
        try {
          s = parseRepoSnapshot(r.snapshot, oldTrip);
        } catch (err) {
          if (!(err instanceof HandsfreeRefusal)) throw err;
          report.refused.push({ rootId: r.rootId, repo: repo.path, refs: [], paths: err.path ? [err.path] : [] });
          continue;
        }
        const bundle = join(rdir, `${r.rootId}.bundle`);
        // Refused content never makes recovery a dead end: park what can be parked, report the rest.
        const tolerant = existsSync(bundle) ? await fetchBundleTolerant(env.run, repo.path, bundle, oldTrip, join(rdir, `diagnose-${r.rootId}`)) : { fetched: {}, refused: [], paths: [] };
        const fetched = tolerant.fetched;
        if (tolerant.refused.length) report.refused.push({ rootId: r.rootId, repo: repo.path, refs: tolerant.refused, paths: tolerant.paths });
        const all: Record<string, string> = { ...s.refs };
        s.stash.forEach((e, i) => { all[snapStashRef(oldTrip, i)] = e.oid; });
        for (const c of s.checkouts) {
          if (c.head.oid) all[`${snapRefPrefix(oldTrip)}/${c.checkoutId}/head`] = c.head.oid;
          for (const [n, oid] of Object.entries(c.inProgress ?? {})) all[`${snapRefPrefix(oldTrip)}/${c.checkoutId}/inprogress/${n}`] = oid;
        }
        Object.assign(all, fetched);
        const present = await presentObjects(env.run, repo.path, Object.values(all));
        const lines: string[] = [];
        const parked: Record<string, string> = {};
        for (const [ref, oid] of Object.entries(all)) {
          const to = parkRefFor(oldTrip, ref);
          if (!to || !present.has(oid)) continue;
          parked[to] = oid;
          lines.push(`update ${to} ${oid}`);
        }
        if (lines.length) await git(env.run, repo.path, ['update-ref', '--stdin'], { input: Buffer.from(lines.join('\n') + '\n') });
        report.parked.push({ rootId: r.rootId, refs: parked });
      } else {
        const packPath = join(rdir, `${r.rootId}.pack`);
        if (!existsSync(packPath)) continue;
        const odir = join(dir, 'orphaned', root ? r.rootId : `unmapped-${r.rootId}`);
        mkdirSync(odir, { recursive: true });
        const cloudM = manifestFromJSON(r.manifest);
        const files: string[] = [];
        const deletions: string[] = [];
        await readPack(createReadStream(packPath), async (rec) => {
          if (rec.kind === 'delete') { deletions.push(rec.path); return; }
          files.push(rec.entry.path);
        }, { maxBytes: capFor(cloudM) });
        const plan: NonGitPlan = { write: files, delete: [], conflicts: [], refused: [] };
        await applyPack(() => createReadStream(packPath), {
          root: odir, plan, expected: new Map(), incoming: cloudM, conflictsDir: join(odir, '.conflicts'),
          backup: new BackupStore(join(dir, 'orphaned-backup', r.rootId)), policy: 'overwrite', maxBytes: capFor(cloudM),
        });
        report.orphaned.push({ rootId: r.rootId, dir: odir, files: files.length, deletions });
        if (!root) report.unmapped.push(r.rootId);
      }
    }
    try {
      await client.seal(epoch);
    } catch (err) {
      if (err instanceof CloudError && err.code === 'epoch_mismatch' && attempt === 0) continue;
      throw err;
    }
    // Recovered ONLY now: the snapshot was parked locally, then the cloud sealed.
    report.sealed = true;
    await markLastTrip(env, oldTrip, { recovered: true, ...(report.lost ? { status: 'lost' as const } : {}) });
    writeJson(join(dir, 'recovery-report.json'), report);
    return report;
  }
  throw new HandsfreeError('cloud', 'the recovery could not seal the cloud under one epoch');
}

/**
 * Unpack a bundle WITHOUT fsck into a scratch bare repository that borrows `repo`'s objects
 * through alternates (so a thin bundle's prerequisites resolve). Never a checkout, never the
 * real repository's refs: only for diagnosing and for the per-ref recovery fetch.
 */
async function unbundleToScratch(run: ProcessRunner, repo: string, bundlePath: string, scratch: string): Promise<boolean> {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  await git(run, scratch, ['init', '--bare', '-q']);
  const common = (await gitOut(run, repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  atomicWriteFile(join(scratch, 'objects', 'info', 'alternates'), join(common, 'objects') + '\n', 0o644);
  const r = await git(run, scratch, ['-c', 'transfer.fsckObjects=false', '-c', 'fetch.fsckObjects=false', 'fetch', '-q', '--no-tags', '--no-write-fetch-head', resolve(bundlePath), '+refs/*:refs/*'], { allowFail: true });
  return r.code === 0;
}

/** Paths the shared guard refuses among the objects reachable from `revs` in a scratch repo. */
async function refusedPathsIn(run: ProcessRunner, scratch: string, revs: string[] = ['--all']): Promise<string[]> {
  const r = await git(run, scratch, ['rev-list', '--objects', ...revs], { allowFail: true });
  const bad = new Set<string>();
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const path = line.slice(sp + 1);
    if (path && !checkRelPath(path).ok) bad.add(path);
  }
  return [...bad].sort().slice(0, 20);
}

/** The cloud sent content this laptop refuses: a HandsfreeError naming the repository and the paths. */
async function cloudContentError(run: ProcessRunner, repo: string, bundlePath: string, scratch: string, cause: unknown): Promise<HandsfreeError> {
  let paths: string[] = [];
  try {
    if (existsSync(bundlePath) && (await unbundleToScratch(run, repo, bundlePath, scratch))) paths = await refusedPathsIn(run, scratch);
  } catch { /* diagnosis only */ } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const refusalPath = cause instanceof HandsfreeRefusal && cause.path ? [cause.path] : [];
  const named = [...new Set([...refusalPath, ...paths])];
  const reason = cause instanceof HandsfreeRefusal ? cause.message
    : cause instanceof GitError ? (cause.stderr.split('\n').find((l: string) => /error|fatal/i.test(l)) ?? cause.stderr).trim().slice(0, 200)
      : (cause as Error).message;
  return new HandsfreeError(
    'cloud_content',
    `the cloud copy of ${repo} holds content this laptop refuses${named.length ? `: ${named.map((p) => JSON.stringify(p)).join(', ')}` : ''} (${reason}). Nothing of it was written here: remove or rename it on the phone (and commit the fix), then return again.`,
    { repo, paths: named },
  );
}

/**
 * Recovery's bundle fetch (D12) that never dead-ends. A bundle is ONE pack, so one refused
 * object refuses every ref fetched from it; when that happens the bundle is unpacked into a
 * scratch repo (no fsck) and each allow-listed ref is fetched from there on its own, still
 * with fsck, so only the objects that ref reaches are checked: clean refs park, the refs whose
 * content is refused are reported and stay in the cloud.
 */
async function fetchBundleTolerant(run: ProcessRunner, repo: string, bundlePath: string, trip: string, scratch: string): Promise<{ fetched: Record<string, string>; refused: string[]; paths: string[] }> {
  try {
    return { fetched: await fetchBundle(run, repo, bundlePath, { trip }), refused: [], paths: [] };
  } catch (err) {
    if (!(err instanceof GitError || err instanceof BundlePrerequisiteError)) throw err;
  }
  const fetched: Record<string, string> = {};
  const refused: string[] = [];
  const heads = await git(run, repo, ['bundle', 'list-heads', resolve(bundlePath)], { allowFail: true });
  const snapPrefix = snapRefPrefix(trip) + '/';
  const wanted: Array<[string, string]> = [];
  for (const line of heads.stdout.toString('utf8').split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const ref = line.slice(sp + 1);
    if (isAllowedRef(ref) || (ref.startsWith(snapPrefix) && isWellFormedRef(ref))) wanted.push([ref, line.slice(0, sp)]);
  }
  let paths: string[] = [];
  try {
    if (!(await unbundleToScratch(run, repo, bundlePath, scratch))) return { fetched, refused: wanted.map(([r]) => r), paths };
    for (const [ref, oid] of wanted) {
      const r = await git(run, repo, [
        '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', '-c', 'gc.auto=0',
        'fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', scratch, `+${ref}:${incomingRefFor(trip, ref)}`,
      ], { allowFail: true });
      if (r.code === 0) fetched[ref] = oid;
      else refused.push(ref);
    }
    if (refused.length) paths = await refusedPathsIn(run, scratch, refused);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { fetched, refused, paths };
}

async function presentObjects(run: ProcessRunner, repo: string, oids: string[]): Promise<Set<string>> {
  const uniq = [...new Set(oids)];
  if (!uniq.length) return new Set();
  const out = (await gitOut(run, repo, ['cat-file', '--batch-check'], { input: Buffer.from(uniq.join('\n') + '\n') })).split('\n');
  return new Set(uniq.filter((_, i) => out[i] && !out[i].endsWith(' missing')));
}

async function markLastTrip(env: HandsfreeEnv, tripId: string, patch: Partial<NonNullable<HandsfreeConfig['lastTrip']>>): Promise<void> {
  await updateConfig(env.home, (c) => {
    const cur = c.lastTrip && c.lastTrip.tripId === tripId ? c.lastTrip : { tripId, status: 'abandoned' as const, at: new Date(nowOf(env)).toISOString() };
    return { ...c, lastTrip: { ...cur, ...patch } };
  });
}

function capFor(m: Manifest): number {
  let n = 64 * 1024 * 1024;
  for (const e of m.values()) n += e.size + 1024;
  return n;
}

// ---------------------------------------------------------------- return

export interface RepoReceipt {
  rootId: string;
  path: string;
  outcome: 'applied' | 'parked' | 'refused';
  parkReasons: string[];
  parkedRefs: Record<string, string>;
  cloudHeads: Array<{ checkout: string; head: string }>;
  branches: Array<{ ref: string; from: string | null; to: string | null }>;
  written: string[];
  deleted: string[];
  conflicts: Conflict[];
  refused: Conflict[];
  verifyMismatch: string[];
  worktreesAdded: string[];
  worktreesRemoved: string[];
}

export interface FilesReceipt {
  rootId: string;
  path: string;
  written: string[];
  conflicts: Conflict[];
  refused: Conflict[];
  /** D20: 'deleted on the phone, kept here'. */
  deletedInCloud: string[];
  /** D16: secret-class names the cloud no longer had (wiped). */
  notReturned: string[];
  /** D16: secret-class names that came home (names only, never contents). */
  secrets: string[];
  /** Transcripts changed on both sides: the cloud's is in place, the laptop's copy is in conflicts. */
  transcriptCopies: string[];
}

export interface Receipt {
  version: 1;
  tripId: string;
  createdAt: string;
  pass: number;
  repos: RepoReceipt[];
  files: FilesReceipt[];
  sessions: Array<{ rootId: string; roster: RosterMergeReport | null; titlesChanged: number; mapFilesWritten: number }>;
  /** AC20: changed auto-executing config, with its plain-text diff (secret-class names only, no diff). */
  autoExec: Array<{ rootId: string; path: string; diff: string }>;
  /** D18 re-sweep: links undone, and escapes reported without touching the laptop. */
  links: Array<{ rootId: string; undone: string[]; escaping: string[] }>;
  /** The receipts of earlier passes of this Return (a second delta return after an epoch move). */
  previousPasses?: Receipt[];
  /** Roots the cloud sent that are no destination on this laptop (ignored, never written). */
  ignoredRoots: Array<{ rootId: string; reason: string }>;
  deletedInCloudReason: string;
  conflictsDir: string;
  backupDir: string;
  finalization: { secretsWiped: boolean; sealed: boolean; stopped: boolean; queued: string[] };
}

export interface ReturnResult {
  tripId: string;
  outcome: 'home' | 'superseded' | 'lost' | 'cancelled';
  receipt: Receipt | null;
  message?: string;
}

interface ReturnProgress { epoch: number; pass: number; receipts: string[] }

const progressPath = (dir: string) => join(dir, 'return-progress.json');
/** Present while a Roll back is under way; holds the earliest pass it rolls back. */
const rollbackMarker = (dir: string) => join(dir, 'rollback-in-progress');
const PASS_JOURNAL_RE = /^return-journal\.pass-(\d+)\.json$/;

/** This trip's archived (applied) return pass journals, oldest pass first. */
function passJournals(dir: string): Array<{ pass: number; path: string }> {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.map((n) => PASS_JOURNAL_RE.exec(n)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pass: Number(m[1]), path: join(dir, m[0]) })).sort((a, b) => a.pass - b.pass);
}

/** Has ANY pass of this Return written to the laptop (the live journal or an archived pass)? */
function returnWriteStarted(dir: string): boolean {
  const started = (j: Journal | null) => !!j && journalStatus(j).writeStarted;
  const safe = (p: string) => { try { return loadJournal(p); } catch { return null; } };
  return started(safe(journalPath(dir, 'return'))) || passJournals(dir).some((p) => started(safe(p.path)));
}

/** Pass N >= 2 backs up (and parks conflicts) under its own scopes. */
function withPassScopes(op: Pick<JournalOp, 'id' | 'kind' | 'params' | 'writes'>, pass: number): Pick<JournalOp, 'id' | 'kind' | 'params' | 'writes'> {
  const p = op.params as Record<string, unknown>;
  const suffix = (x: string) => `${x}.pass-${pass}`;
  if (typeof p.scope === 'string') return { ...op, params: { ...p, scope: suffix(p.scope) } };
  if (Array.isArray(p.scopes)) return { ...op, params: { ...p, scopes: (p.scopes as string[]).map(suffix) } };
  return op;
}

function returnOpsHandlers(env: HandsfreeEnv, dir: string): OpHandlers {
  type P = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    ...gitOpHandlers(env.run, { tripDir: dir }),
    ...fileOpHandlers({ tripDir: dir }),
    ...sessionMergeHandlers({ tripDir: dir, roster: env.roster }),
    'git.addWorktree': {
      isDone: async (op) => existsSync(join((op.params as P).dest, '.git')),
      apply: async (op) => {
        const p = op.params as P;
        await addWorktreeNoCheckout(env.run, p.repoPath, p.dest, p.commit);
      },
      // Only a clean worktree goes: a file the owner added since stays (git refuses, we keep it).
      undo: async (op) => {
        const p = op.params as P;
        const r = await git(env.run, p.repoPath, ['worktree', 'remove', p.dest], { allowFail: true });
        return r.code === 0 ? { removed: p.dest } : { kept: [{ path: p.dest, reason: 'the new worktree has changes since the Return created it, kept' }] };
      },
    },
    'dir.ensure': {
      // A new worktree's transcript dir (wire v1.1): created, and removed again by Roll back when still empty.
      isDone: async (op) => existsSync((op.params as P).path),
      apply: async (op) => {
        const created: string[] = [];
        let cur = (op.params as P).path as string;
        while (!existsSync(cur)) { created.unshift(cur); cur = dirname(cur); }
        for (const d of created) mkdirSync(d);
        return { created };
      },
      undo: async (op) => {
        for (const d of [...(((op.result as { created?: string[] }) ?? {}).created ?? [])].reverse()) {
          try { rmdirSync(d); } catch { /* not empty: kept */ }
        }
      },
    },
    'files.preserve': {
      // The laptop copy of a transcript changed on both sides goes to conflicts first.
      apply: async (op) => {
        const p = op.params as P;
        for (const rel of p.paths as string[]) {
          const src = join(p.root, ...rel.split('/'));
          const dst = join(p.conflictsDir, ...rel.split('/')) + '~laptop';
          if (!existsSync(src) || existsSync(dst)) continue;
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(src, dst);
        }
      },
    },
    'root.resweep': {
      apply: async (op) => {
        const p = op.params as P;
        if (!existsSync(p.root)) return { undone: [], escaping: [] };
        return resweepRootWithBackups(p.root, p.linkRels, (p.scopes as string[]).map((s) => new BackupStore(backupDir(dir, s))));
      },
    },
    'git.base': {
      apply: async (op) => {
        const p = op.params as P;
        const present = await presentObjects(env.run, p.repoPath, Object.values(p.refs as Record<string, string>));
        const refs: Record<string, string> = {};
        for (const [r, oid] of Object.entries(p.refs as Record<string, string>)) if (present.has(oid)) refs[r] = oid;
        await setBaseRefs(env.run, p.repoPath, refs);
      },
    },
  };
}

/** Plan one return pass (downloads already in `pdir`), persist its journal. */
async function planReturnPass(env: HandsfreeEnv, goM: GoManifest, dir: string, pdir: string, snap: SnapshotReply, pass = 1): Promise<{ meta: PassMeta; ops: Array<Pick<JournalOp, 'id' | 'kind' | 'params' | 'writes'>> }> {
  const trip = goM.tripId;
  const ops: Array<Pick<JournalOp, 'id' | 'kind' | 'params' | 'writes'>> = [];
  const meta: PassMeta = { repos: [], files: [], resweep: [], ignored: [] };
  const linkRels = new Map<string, Set<string>>();
  const scopes = new Map<string, Set<string>>();
  const addLinks = (rootId: string, rels: Iterable<string>) => {
    const s = linkRels.get(rootId) ?? new Set<string>();
    for (const r of rels) s.add(r);
    linkRels.set(rootId, s);
  };
  const addScope = (rootId: string, scope: string) => {
    const s = scopes.get(rootId) ?? new Set<string>();
    s.add(scope);
    scopes.set(rootId, s);
  };
  const inHome = underHome(goM.home);
  // Wire v1.1: transcript dirs of worktrees created in the cloud, keyed by the worktree's root
  // id. The dir is derived ONLY from the laptop's allowed new-worktree path (AC10).
  const newTranscripts = new Map<string, string>();
  /** `wt:<checkoutId>` -> the laptop dest of a worktree this Return creates. */
  const newWorktreeDest = new Map<string, string>();

  // Transport 1 per repo root.
  const baseOps: typeof ops = [];
  for (const entry of snap.roots.filter((r): r is Extract<SnapshotRoot, { kind: 'repo' }> => r.kind === 'repo')) {
    const spec = rootFor(goM, entry.rootId);
    if (spec.kind !== 'repo') throw new HandsfreeError('cloud', `the cloud sent git state for ${entry.rootId}, which is not a repository here`);
    const repoPath = spec.localPath;
    const rec: PassMeta['repos'][number] = { rootId: entry.rootId, path: repoPath, parkReasons: [], newWorktrees: [], removed: [], refused: [], cloudHeads: [], branchesFrom: {}, branchesTo: {} };
    meta.repos.push(rec);
    const incoming = parseRepoSnapshot(entry.snapshot, trip);
    const bundle = join(pdir, `${entry.rootId}.bundle`);
    // Content the laptop refuses (fsck: a .git path, a bad object; a refused ref or path) is the
    // CLOUD's to fix on the phone, never a crash: the Return cancels with the repo + path named.
    let fetched: Record<string, string> = {};
    try {
      fetched = existsSync(bundle) ? await fetchBundle(env.run, repoPath, bundle, { trip }) : {};
      await verifyIncoming(env.run, repoPath, incoming, fetched);
    } catch (err) {
      if (err instanceof GitError || err instanceof BundlePrerequisiteError || err instanceof HandsfreeRefusal) {
        throw await cloudContentError(env.run, repoPath, bundle, join(pdir, `diagnose-${entry.rootId}`), err);
      }
      throw err;
    }
    rec.cloudHeads = incoming.checkouts.map((c) => ({ checkout: rootIdToPath(goM, c.checkoutId) ?? c.path, head: c.head.kind === 'symref' ? `${c.head.ref} @ ${c.head.oid ?? 'unborn'}` : `detached @ ${c.head.oid}` }));
    rec.branchesTo = incoming.refs;
    const startS = readJson<RepoSnapshot>(join(dir, 'agreed', `${entry.rootId}.git.json`));
    let nowS: RepoSnapshot | null = null;
    let nowErr: string | null = null;
    try {
      nowS = await snapshotRepo(env.run, repoPath, {
        trip, writeRefs: false, side: 'laptop', checkoutIdFor, checkoutFilter: inHome,
        extraNestedRoots: goM.roots.filter((r) => r.kind !== 'worktree' && r.kind !== 'transcripts' && r.rootId !== entry.rootId).map((r) => r.absPath),
      });
      rec.branchesFrom = nowS.refs;
    } catch (err) {
      if (!(err instanceof HandsfreeRefusal)) throw err;
      nowErr = `the laptop copy cannot be compared (${err.message})`;
    }
    const localCheckouts: Record<string, string> = {};
    for (const c of (nowS ?? startS).checkouts) {
      const p = rootIdToPath(goM, c.checkoutId);
      if (p && existsSync(p)) localCheckouts[c.checkoutId] = p;
    }
    // A laptop copy that cannot even be snapshotted (a merge in progress here) is diverged by
    // definition: park everything, touch nothing.
    const plan: RepoApplyPlan = nowErr
      ? parkPlan(repoPath, trip, incoming, fetched, nowErr)
      : await planRepoApply(env.run, { repoPath, trip, incoming, fetched, receiverStart: startS, receiverNow: nowS, localCheckouts, policy: 'conflict', strict: true });
    rec.parkReasons = plan.parkReasons;
    rec.removed = plan.removedCheckouts.map((cid) => rootIdToPath(goM, cid) ?? cid);
    ops.push(...plan.ops);
    if (plan.parkReasons.length === 0) {
      // New worktrees: only under the repo's allowed parents with a [a-z0-9-] leaf (AC10).
      const empty = await emptyTree(env.run, repoPath);
      for (const cid of plan.newCheckouts) {
        const c = incoming.checkouts.find((x) => x.checkoutId === cid)!;
        const candidate = entry.worktreesAdded.find((p) => checkoutIdFor(p) === cid || rootIdFor(p) === cid) ?? c.path;
        let dest: string;
        try {
          dest = allowedNewWorktreePath(goM, entry.rootId, candidate);
        } catch (err) {
          rec.refused.push({ path: candidate, reason: (err as Error).message });
          continue;
        }
        if (!c.head.oid) { rec.refused.push({ path: candidate, reason: 'the new worktree has no commit yet' }); continue; }
        const wplan = await planWorktree(env.run, repoPath, { prevTree: empty, newTree: c.worktreeTree, fromTolerant: incoming.tolerant });
        wplan.checkout = dest;
        rec.newWorktrees.push(dest);
        newWorktreeDest.set(`wt:${cid}`, dest);
        const tdir = join(projectsDir(env), encodeProjectDir(dest));
        newTranscripts.set(rootIdFor(dest), tdir);
        newTranscripts.set(rootIdFor(candidate), tdir);
        const id = (s: string) => `${repoPath}#new:${cid}:${s}`;
        ops.push(
          { id: id('add'), kind: 'git.addWorktree', writes: true, params: { repoPath, dest, commit: c.head.oid } },
          { id: id('head'), kind: 'git.head', writes: true, params: { checkout: dest, target: c.head, prev: { kind: 'detached', oid: c.head.oid } } },
          { id: id('worktree'), kind: 'git.worktree', writes: true, params: { scope: `git-${cid}`, plan: wplan, policy: 'conflict' } },
          { id: id('index'), kind: 'git.index', writes: true, params: { checkout: dest, target: c.indexTree, prev: empty } },
        );
      }
    }
    // A checkout's links and backup scopes belong to its own root: a go-manifest root, a new
    // worktree this Return creates (re-swept at its dest), or else the repo's root.
    const keyOf = (cid: string) => (newWorktreeDest.has(`wt:${cid}`) ? `wt:${cid}` : rootIdOfCheckout(goM, cid, entry.rootId));
    if (plan.parkReasons.length === 0) for (const c of incoming.checkouts) addScope(keyOf(c.checkoutId), `git-${c.checkoutId}`);
    // Links of the new worktree trees, per root (D18 re-sweep).
    for (const c of incoming.checkouts) {
      const rid = keyOf(c.checkoutId);
      const links = (await lsTree(env.run, repoPath, c.worktreeTree)).filter((e) => e.mode === '120000').map((e) => e.path);
      addLinks(rid, links);
    }
    const tips = [...Object.values(incoming.refs), ...incoming.stash.map((s) => s.oid), ...Object.values(fetched)];
    baseOps.push({ id: `${repoPath}#base`, kind: 'git.base', writes: false, params: { repoPath, refs: baseRefsFor(tips) } });
    rec.parkedRefs = plan.parkReasons.length ? Object.fromEntries(Object.entries((plan.ops[0].params as { fetched: Record<string, string> }).fetched).map(([r, o]) => [parkRefFor(trip, r) ?? r, o])) : {};
  }

  // Transport 2 per root.
  for (const entry of snap.roots.filter((r): r is Extract<SnapshotRoot, { kind: 'files' }> => r.kind === 'files')) {
    let spec: RootSpec & { localPath: string };
    const extra = newTranscripts.get(entry.rootId);
    if (goM.roots.some((r) => r.rootId === entry.rootId)) spec = rootFor(goM, entry.rootId);
    else if (extra) {
      spec = { rootId: entry.rootId, kind: 'transcripts', absPath: extra, localPath: extra };
      ops.push({ id: `dir:${entry.rootId}`, kind: 'dir.ensure', writes: true, params: { path: extra } });
    } else {
      // Not a root of this trip and not a worktree this Return creates: never a destination.
      meta.ignored.push({ rootId: entry.rootId, reason: 'not a root of this trip' });
      continue;
    }
    const root = spec.localPath;
    const startM = readManifestFile(join(dir, 'agreed', `${entry.rootId}.files.json`)) ?? new Map();
    const cloudM = manifestFromJSON(entry.manifest);
    const include = readJsonSafe<{ include?: string[] }>(join(dir, 'scope.json'))?.include ?? [];
    const { manifest: laptopNow } = await laptopManifest(env, spec, include, startM);
    const plan = planNonGitReturn(startM, laptopNow, cloudM, entry.refused.map((r) => r.path));
    // Session state leaves the generic three-way (merged per entry by id).
    const sessionPaths = [...cloudM.keys()].filter((p) => isSessionStatePath(p) && !sameContent(startM.get(p), cloudM.get(p)));
    const drop = (p: string) => isSessionStatePath(p);
    plan.write = plan.write.filter((p) => !drop(p));
    plan.conflicts = plan.conflicts.filter((c) => !drop(c.path));
    plan.deletedInCloud = (plan.deletedInCloud ?? []).filter((p) => !drop(p));
    plan.cloudWins = (plan.cloudWins ?? []).filter((p) => !drop(p));
    // Transcripts changed on both sides: the cloud's lands in place, the laptop's goes to conflicts.
    const transcriptCopies: string[] = [];
    if (spec.kind === 'transcripts') {
      for (const c of [...plan.conflicts]) {
        if (c.reason !== 'changed on both sides') continue;
        plan.conflicts = plan.conflicts.filter((x) => x !== c);
        plan.write.push(c.path);
        plan.cloudWins!.push(c.path);
        transcriptCopies.push(c.path);
      }
    }
    const packPath = join(pdir, `${entry.rootId}.pack`);
    if (!existsSync(packPath)) await packFile(packPath, root, []);
    if (sessionPaths.length) {
      const cloudDir = join(pdir, 'session', entry.rootId);
      await extractFromPack(packPath, new Set(sessionPaths), cloudDir, capFor(cloudM));
      // The pack carries only what differs from the go-time manifest: a session file the cloud
      // changed back to its go-time bytes (pass 2+) is exactly the go-start copy.
      for (const rel of sessionPaths) {
        const got = join(cloudDir, ...rel.split('/'));
        const atGo = join(dir, 'start', 'session', entry.rootId, ...rel.split('/'));
        if (!existsSync(got) && existsSync(atGo) && createHash('sha256').update(readFileSync(atGo)).digest('hex') === cloudM.get(rel)?.sha256) {
          mkdirSync(dirname(got), { recursive: true });
          copyFileSync(atGo, got);
        }
      }
    }
    if (transcriptCopies.length) {
      ops.push({ id: `files:${entry.rootId}#preserve`, kind: 'files.preserve', writes: false, params: { root, paths: transcriptCopies, conflictsDir: conflictsDir(dir, entry.rootId) } });
    }
    ops.push({
      id: `files:${entry.rootId}`, kind: 'files.apply', writes: true,
      params: filesApplyParams({ root, scope: entry.rootId, packPath, plan, expected: laptopNow, incoming: cloudM, policy: 'conflict', maxBytes: capFor(cloudM) }),
    });
    addScope(entry.rootId, entry.rootId);
    if (sessionPaths.length) {
      // The merge base: the go-start copy for pass 1; from pass 2 on, the laptop's session state as
      // the previous pass merged it (the roots are locked, so it is exactly that), so a tab the
      // phone opened and closed between passes does not come back.
      let startDir = join(dir, 'start', 'session', entry.rootId);
      if (pass > 1) {
        startDir = join(pdir, 'session-base', entry.rootId);
        rmSync(startDir, { recursive: true, force: true });
        mkdirSync(startDir, { recursive: true });
        copySessionState(root, startDir);
      }
      ops.push({ id: `session:${entry.rootId}`, kind: 'session.merge', writes: true, params: { root, scope: `session-${entry.rootId}`, startDir, cloudDir: join(pdir, 'session', entry.rootId) } });
      addScope(entry.rootId, `session-${entry.rootId}`);
    }
    addLinks(entry.rootId, [...laptopNow.values(), ...cloudM.values()].filter((e) => e.type === 'symlink').map((e) => e.path));
    meta.files.push({ rootId: entry.rootId, path: root, transcriptCopies });
  }
  // D18: once both transports finished a root, re-sweep every symlink of it.
  for (const [rootId, rels] of linkRels) {
    const p = rootIdToPath(goM, rootId) ?? newWorktreeDest.get(rootId) ?? newTranscripts.get(rootId) ?? null;
    if (!p) continue;
    ops.push({ id: `resweep:${rootId}`, kind: 'root.resweep', writes: false, params: { root: p, linkRels: [...rels], scopes: [...(scopes.get(rootId) ?? [])] } });
    meta.resweep.push(rootId);
  }
  ops.push(...baseOps);
  return { meta, ops };
}

interface PassMeta {
  repos: Array<{
    rootId: string; path: string; parkReasons: string[]; newWorktrees: string[]; removed: string[]; refused: Conflict[];
    cloudHeads: Array<{ checkout: string; head: string }>; branchesFrom: Record<string, string>; branchesTo: Record<string, string>; parkedRefs?: Record<string, string>;
  }>;
  files: Array<{ rootId: string; path: string; transcriptCopies: string[] }>;
  resweep: string[];
  /** Cloud roots that are no destination here (never written). */
  ignored: Array<{ rootId: string; reason: string }>;
}

/** The park-only plan (same op shape as planRepoApply's park branch). */
function parkPlan(repoPath: string, trip: string, incoming: RepoSnapshot, fetched: Record<string, string>, reason: string): RepoApplyPlan {
  const all: Record<string, string> = { ...incoming.refs };
  incoming.stash.forEach((e, i) => { all[snapStashRef(trip, i)] = e.oid; });
  for (const c of incoming.checkouts) if (c.head.oid) all[`${snapRefPrefix(trip)}/${c.checkoutId}/head`] = c.head.oid;
  Object.assign(all, fetched);
  return {
    ops: [{ id: `${repoPath}#park`, kind: 'git.park', writes: false, params: { repoPath, trip, fetched: all } }],
    divergence: { kind: 'diverged', reasons: [reason] }, parkReasons: [reason], newCheckouts: [], removedCheckouts: [],
  };
}

function readJsonSafe<T>(path: string): T | null {
  try { return readJson<T>(path); } catch { return null; }
}

function rootIdToPath(goM: GoManifest, rootId: string): string | null {
  return goM.roots.find((r) => r.rootId === rootId)?.absPath ?? null;
}

/** A checkout's root id is its own (worktree) id when the go manifest has it, else the repo's. */
function rootIdOfCheckout(goM: GoManifest, checkoutId: string, repoRootId: string): string {
  return goM.roots.some((r) => r.rootId === checkoutId) ? checkoutId : repoRootId;
}

async function extractFromPack(packPath: string, want: Set<string>, dest: string, maxBytes: number): Promise<void> {
  await readPack(createReadStream(packPath), async (rec) => {
    if (rec.kind !== 'file' || !want.has(rec.entry.path)) return;
    const abs = join(dest, ...rec.entry.path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    const chunks: Buffer[] = [];
    for await (const c of rec.body) chunks.push(c);
    const data = Buffer.concat(chunks);
    if (createHash('sha256').update(data).digest('hex') !== rec.entry.sha256) throw new HandsfreeError('cloud', `session file ${rec.entry.path} does not match its sha256`);
    atomicWriteFile(abs, data, 0o600);
  }, { maxBytes });
}

const AUTO_EXEC_RE = /^(?:\.claude\/|\.mcp\.json$|\.husky\/|lefthook\.ya?ml$|\.pre-commit-config\.yaml$|\.envrc$|\.vscode\/|\.idea\/)|(?:^|\/)memory\//;

async function noIndexDiff(env: HandsfreeEnv, a: string, b: string): Promise<string> {
  const r = await env.run('git', ['diff', '--no-index', '--no-color', '--', a, b], { cwd: dirname(b), env: { GIT_TERMINAL_PROMPT: '0' } }).catch(() => null);
  return r ? r.stdout.toString('utf8').slice(0, 200_000) : '';
}

/** Build the receipt from the finished journal (results ride on the ops). */
async function buildReceipt(env: HandsfreeEnv, goM: GoManifest, dir: string, j: Journal, meta: PassMeta, pass: number): Promise<Receipt> {
  const receipt: Receipt = {
    version: 1, tripId: goM.tripId, createdAt: new Date(nowOf(env)).toISOString(), pass, repos: [], files: [], sessions: [], autoExec: [], links: [], ignoredRoots: meta.ignored ?? [],
    deletedInCloudReason: DELETED_IN_CLOUD_REASON, conflictsDir: join(dir, 'conflicts'), backupDir: join(dir, 'backup'),
    finalization: { secretsWiped: false, sealed: false, stopped: false, queued: [] },
  };
  const results = (pred: (op: JournalOp) => boolean) => j.ops.filter(pred);
  for (const r of meta.repos) {
    const wt = results((op) => op.kind === 'git.worktree' && String(op.id).startsWith(r.path + '#'));
    const rr: RepoReceipt = {
      rootId: r.rootId, path: r.path, outcome: r.parkReasons.length ? 'parked' : 'applied', parkReasons: r.parkReasons, parkedRefs: r.parkedRefs ?? {},
      cloudHeads: r.cloudHeads, branches: [], written: [], deleted: [], conflicts: [], refused: [...r.refused], verifyMismatch: [],
      worktreesAdded: r.newWorktrees, worktreesRemoved: r.removed,
    };
    const refNames = new Set([...Object.keys(r.branchesFrom), ...Object.keys(r.branchesTo)]);
    if (!r.parkReasons.length) for (const ref of [...refNames].sort()) if (r.branchesFrom[ref] !== r.branchesTo[ref]) rr.branches.push({ ref, from: r.branchesFrom[ref] ?? null, to: r.branchesTo[ref] ?? null });
    for (const op of wt) {
      const res = op.result as { written?: string[]; deleted?: string[]; conflicts?: Conflict[]; refused?: Conflict[]; verifyMismatch?: string[] } | undefined;
      rr.written.push(...(res?.written ?? []));
      rr.deleted.push(...(res?.deleted ?? []));
      rr.conflicts.push(...(res?.conflicts ?? []));
      rr.refused.push(...(res?.refused ?? []));
      rr.verifyMismatch.push(...(res?.verifyMismatch ?? []));
      // AC20: auto-executing config changed through git, with its diff.
      const plan = (op.params as { plan: { prevTree: string; newTree: string; checkout: string } }).plan;
      const changed = [...(res?.written ?? []), ...(res?.deleted ?? [])].filter((p) => AUTO_EXEC_RE.test(p));
      for (const p of changed) {
        const diff = isSecretClass(p) ? '(secret-class file: contents not shown)' : (await git(env.run, r.path, ['diff', '--no-color', plan.prevTree, plan.newTree, '--', p], { allowFail: true })).stdout.toString('utf8').slice(0, 200_000);
        receipt.autoExec.push({ rootId: r.rootId, path: p, diff });
      }
    }
    receipt.repos.push(rr);
  }
  for (const f of meta.files) {
    const op = j.ops.find((x) => x.id === `files:${f.rootId}`);
    const res = op?.result as { written?: string[]; conflicts?: Conflict[]; refused?: Conflict[]; deletedInCloud?: string[]; notReturned?: string[]; secrets?: string[] } | undefined;
    const fr: FilesReceipt = {
      rootId: f.rootId, path: f.path, written: res?.written ?? [], conflicts: res?.conflicts ?? [], refused: res?.refused ?? [],
      deletedInCloud: res?.deletedInCloud ?? [], notReturned: res?.notReturned ?? [], secrets: (res?.secrets ?? []).filter(isSecretClass), transcriptCopies: f.transcriptCopies,
    };
    receipt.files.push(fr);
    for (const p of fr.written.filter((x) => AUTO_EXEC_RE.test(x))) {
      if (isSecretClass(p)) { receipt.autoExec.push({ rootId: f.rootId, path: p, diff: '(secret-class file: contents not shown)' }); continue; }
      const scope = (op?.params as { scope?: string } | undefined)?.scope ?? f.rootId;
      const before = join(backupDir(dir, scope), 'files', ...p.split('/'));
      const after = join(f.path, ...p.split('/'));
      receipt.autoExec.push({ rootId: f.rootId, path: p, diff: await noIndexDiff(env, existsSync(before) ? before : '/dev/null', after) });
    }
    const s = j.ops.find((x) => x.id === `session:${f.rootId}`);
    if (s?.result) receipt.sessions.push({ rootId: f.rootId, ...(s.result as { roster: RosterMergeReport | null; titlesChanged: number; mapFilesWritten: number }) });
  }
  for (const rid of meta.resweep) {
    const op = j.ops.find((x) => x.id === `resweep:${rid}`);
    const res = (op?.result ?? { undone: [], escaping: [] }) as { undone: string[]; escaping: string[] };
    if (res.undone.length || res.escaping.length) receipt.links.push({ rootId: rid, ...res });
  }
  return receipt;
}

/** The agreed baseline after a pass: the cloud's state as this pass applied it. */
function advanceAgreed(dir: string, snap: SnapshotReply, meta: PassMeta, trip: string): void {
  for (const r of snap.roots) {
    if (r.kind === 'repo') {
      const m = meta.repos.find((x) => x.rootId === r.rootId);
      if (m && !m.parkReasons.length) writeJson(join(dir, 'agreed', `${r.rootId}.git.json`), parseRepoSnapshot(r.snapshot, trip));
    } else {
      writeJson(join(dir, 'agreed', `${r.rootId}.files.json`), { manifest: manifestToJSON(manifestFromJSON(r.manifest)), refused: r.refused });
    }
  }
}

async function connectFor(env: HandsfreeEnv): Promise<CloudClient> {
  const cfg = requireConfig(env);
  return env.connect(cfg.codespace.url, await ensureTransferSecret(env.home));
}

/** `handsfree return`: Return + Journal, exactly. */
export async function returnTrip(env: HandsfreeEnv, o: { cutRunning?: boolean; shouldCut?: () => boolean; onProgress?: Progress } = {}): Promise<ReturnResult> {
  const st = requireState(env);
  if (st.phase === 'returning') return resumeTrip(env, o);
  if (st.phase !== 'away') throw new HandsfreeError('not_away', `nothing to return: the laptop is ${st.phase}`);
  const trip = st.tripId!;
  const dir = tripDirFor(env, trip);
  const lock = acquireTripRunLock(dir);
  if (!lock) throw new HandsfreeError('busy', 'another go or return is running for this trip');
  try {
    const up = await ensureRunning(env, { allowCreate: false, onProgress: o.onProgress });
    const health = await up.client.health();
    if (health.supersededLaptopIds.includes(requireConfig(env).laptopId)) return await becomeSuperseded(env, trip);
    await transition(env, trip, 'returning');
    return await runReturnPasses(env, async () => up.client, trip, dir, { ...o, startPass: 1 });
  } finally {
    lock.release();
  }
}

async function becomeSuperseded(env: HandsfreeEnv, trip: string): Promise<ReturnResult> {
  // The old laptop came back after a take-over: unlock, return nothing, local files untouched.
  await transition(env, trip, 'home');
  await markLastTrip(env, trip, { status: 'superseded', recovered: true });
  return { tripId: trip, outcome: 'superseded', receipt: null, message: 'another laptop took this trip over; this laptop was unlocked and nothing came back' };
}

/**
 * D23 (a): the ONE guarded laptop phase change. Once any pass of this trip's Return wrote to
 * the laptop, `returning` only ever leaves through finishReturnHome (`finishing`) or Roll back
 * (which first undoes every write): never back to away, never home by any other path.
 */
async function transition(env: HandsfreeEnv, trip: string, to: TripState['phase'], o: { finishing?: boolean } = {}): Promise<TripState> {
  const dir = tripDirFor(env, trip);
  return updateTripState((c) => {
    if (c.tripId !== trip && c.phase !== 'home') throw new HandsfreeError('busy', `trip mismatch: the laptop is on ${c.tripId ?? 'no trip'}`);
    if (c.phase === 'returning' && to !== 'returning' && returnWriteStarted(dir)) {
      if (to === 'away') throw new HandsfreeError('write_started', 'the return already wrote to the laptop: only Resume or Roll back');
      if (to === 'home' && !o.finishing) throw new HandsfreeError('write_started', 'the return already wrote to the laptop: it ends home only by finishing (Resume) or through Roll back');
    }
    return { ...c, phase: to, tripId: to === 'home' ? null : trip };
  }, { home: env.home });
}

/** Errors that mean "the cloud or GitHub could not be reached or refused": never a local fault. */
function isReachabilityError(err: unknown): boolean {
  return err instanceof CloudError || err instanceof CloudUnreachableError || err instanceof PortPrivateError
    || err instanceof ProviderError || err instanceof ProviderQuotaError
    || (err instanceof HandsfreeError && ['quota', 'cloud', 'port_private', 'tampered', 'turns_running', 'cloud_preflight', 'trip_lost', 'cloud_content'].includes(err.code));
}

/** The highest applied pass of this Return (0 = none). */
function lastAppliedPass(dir: string): number {
  return passJournals(dir).reduce((m, p) => Math.max(m, p.pass), 0);
}

async function runReturnPasses(env: HandsfreeEnv, getClient: () => Promise<CloudClient>, trip: string, dir: string, o: { cutRunning?: boolean; shouldCut?: () => boolean; onProgress?: Progress; startPass: number; resume?: ReturnProgress }): Promise<ReturnResult> {
  const goM = readJson<GoManifest>(join(dir, 'go-manifest.json'));
  // Never reuse an earlier pass's number: its journal and backup scopes stay as they are.
  let pass = Math.max(o.startPass, existsSync(journalPath(dir, 'return')) ? 0 : lastAppliedPass(dir) + 1);
  let resume = o.resume;
  let receipt: Receipt | null = null;
  const cutNow = () => !!o.cutRunning || !!o.shouldCut?.();
  for (;;) {
    let epoch: number;
    let meta: PassMeta;
    let snap: SnapshotReply;
    if (resume && existsSync(journalPath(dir, 'return'))) {
      // Offline-first (D23 b): the whole payload of this pass is already in trips/<trip>/.
      pass = resume.pass;
      epoch = resume.epoch;
      ({ meta, snap } = readJson<{ meta: PassMeta; snap: SnapshotReply }>(join(dir, `return-${pass}`, 'plan.json')));
    } else {
      let quiescedEpoch: number | null = null;
      try {
        const client = await getClient();
        let q;
        try {
          q = await client.quiesce(trip);
        } catch (err) {
          if (err instanceof CloudError && err.code === 'trip_lost') throw new HandsfreeError('trip_lost', 'the cloud no longer has this trip (trip_lost)');
          throw err;
        }
        quiescedEpoch = q.epoch;
        const deadline = nowOf(env) + (env.waitTimeoutMs ?? 2 * 60 * 60_000);
        while (q.running.length && !cutNow()) {
          if (nowOf(env) > deadline) throw new HandsfreeError('turns_running', `${q.running.length} turn(s) or process(es) are still running on the phone; wait or use Cut`);
          // The same RunningWork shape go's wait reports (the job's `running[]`): a turn by its
          // conversation, a scanned process (D22) by its pid.
          const running: RunningWork[] = q.running.map((r) => (r.conversationId
            ? { kind: 'chat' as const, id: r.conversationId, busy: true, ...(r.pid !== undefined ? { pid: r.pid } : {}) }
            : { kind: 'process' as const, id: r.pid !== undefined ? String(r.pid) : UNKNOWN_WORK_ID, busy: true, ...(r.pid !== undefined ? { pid: r.pid } : {}) }));
          o.onProgress?.({ step: 'waiting', detail: `${q.running.length} running on the phone`, running });
          await sleepOf(env)(10_000);
          q = await client.quiesce(trip);
          quiescedEpoch = q.epoch;
        }
        // The owner chose Cut: ALWAYS cut before the snapshot (the cloud's own process scan decides).
        if (cutNow() || q.running.length) await client.cut(q.epoch);
        epoch = q.epoch;
        writeJson(progressPath(dir), { epoch, pass, receipts: readJsonSafe<ReturnProgress>(progressPath(dir))?.receipts ?? [] } satisfies ReturnProgress);
        const knownTips: Record<string, string[]> = {};
        for (const r of goM.roots.filter((x) => x.kind === 'repo')) knownTips[r.rootId] = await baseTips(env.run, r.absPath);
        o.onProgress?.({ step: 'snapshot' });
        try {
          snap = await client.snapshot({ epoch, knownTips });
        } catch (err) {
          if (err instanceof CloudError && err.code === 'turns_running' && cutNow()) {
            await client.cut(epoch);
            snap = await client.snapshot({ epoch, knownTips });
          } else if (err instanceof CloudError && err.code === 'turns_running') {
            throw new HandsfreeError('turns_running', 'processes are still running on the phone; wait or use Cut');
          } else if (err instanceof CloudError && err.code === 'preflight') {
            const problems = (err.body as { problems?: unknown })?.problems ?? null;
            throw new HandsfreeError('cloud_preflight', `the cloud copy is not ready to come back; resolve it on the phone, then return again: ${problems ? JSON.stringify(problems) : err.message}`, { problems });
          } else throw err;
        }
        // Download EVERYTHING before the first write, into a clean dir: an earlier cancelled
        // attempt of this (never applied) pass must not leave a stale bundle or pack behind.
        const pdir = join(dir, `return-${pass}`);
        rmSync(pdir, { recursive: true, force: true });
        mkdirSync(pdir, { recursive: true });
        o.onProgress?.({ step: 'download' });
        for (const r of snap.roots) {
          if (r.kind === 'repo' && r.bundle) await client.downloadTo(r.bundle, join(pdir, `${r.rootId}.bundle`));
          if (r.kind === 'files' && r.pack) await client.downloadTo(r.pack, join(pdir, `${r.rootId}.pack`));
        }
        o.onProgress?.({ step: 'plan' });
        // The agreed baseline as it was before this pass (Roll back puts it back).
        const agreedBefore = join(dir, `agreed.before-pass-${pass}`);
        if (!existsSync(agreedBefore)) cpSync(join(dir, 'agreed'), agreedBefore, { recursive: true });
        const planned = await planReturnPass(env, goM, dir, pdir, snap, pass);
        // Each pass backs up into its own stores, so rolling back pass N restores pass N's own writes.
        if (pass > 1) planned.ops = planned.ops.map((op) => withPassScopes(op, pass));
        meta = planned.meta;
        // The plan, then the journal, persisted before the first laptop write.
        writeJson(join(pdir, 'plan.json'), { meta, snap });
        createJournal(journalPath(dir, 'return'), { trip, direction: 'return', ops: planned.ops });
      } catch (err) {
        if (!isReachabilityError(err)) throw err; // a local fault: Resume picks this pass up again
        return await cancelBeforeWrite(env, getClient, trip, dir, err, quiescedEpoch);
      }
    }
    resume = undefined;
    o.onProgress?.({ step: 'apply' });
    const j = await runJournal(journalPath(dir, 'return'), returnOpsHandlers(env, dir), {
      onOp: (op) => o.onProgress?.({ step: op.kind, detail: op.id }),
      beforeOp: env.beforeOp,
    });
    receipt = await buildReceipt(env, goM, dir, j, meta, pass);
    advanceAgreed(dir, snap, meta, trip);
    const receiptPath = join(dir, `receipt-${pass}.json`);
    writeJson(receiptPath, receipt);
    const prog: ReturnProgress = { epoch, pass, receipts: [...new Set([...(readJsonSafe<ReturnProgress>(progressPath(dir))?.receipts ?? []), receiptPath])] };
    writeJson(progressPath(dir), prog);
    // This pass is done: archive its journal so a second delta pass starts a fresh one.
    renameSync(journalPath(dir, 'return'), join(dir, `return-journal.pass-${pass}.json`));
    // Cloud steps only after the local journal finished; unreachable -> queued, home.
    const fin = await finalizeCloud(env, await getClient(), trip, epoch, o.onProgress);
    if (fin === 'epoch_mismatch' && pass < MAX_RETURN_PASSES) {
      pass++;
      o.onProgress?.({ step: 'delta-return', detail: `pass ${pass}` });
      continue;
    }
    return await finishReturnHome(env, trip, dir, receipt, prog, fin);
  }
}

/**
 * A pass could not get its payload (unreachable cloud, quota, preflight, running work,
 * trip_lost). Before ANY write of this Return: back to away (the cloud unquiesced when it can
 * be told). After an earlier pass wrote (D23): never away; home with the earlier passes'
 * receipt, the cloud's later work recovered by the next go (D12).
 */
async function cancelBeforeWrite(env: HandsfreeEnv, getClient: () => Promise<CloudClient>, trip: string, dir: string, err: unknown, quiescedEpoch: number | null): Promise<ReturnResult> {
  const lost = err instanceof HandsfreeError && err.code === 'trip_lost';
  if (returnWriteStarted(dir)) {
    const prog = readJsonSafe<ReturnProgress>(progressPath(dir)) ?? { epoch: quiescedEpoch ?? 0, pass: lastAppliedPass(dir), receipts: [] };
    const last = prog.receipts.length ? readJsonSafe<Receipt>(prog.receipts[prog.receipts.length - 1]) : null;
    const r = await finishReturnHome(env, trip, dir, last, { ...prog, receipts: prog.receipts }, 'recover');
    if (lost) {
      // The marker is gone: recover the cloud's later work NOW (full D12, snapshot before seal).
      const rec = await recoverLostOnReturn(env, getClient, trip, dir);
      await stopOrQueue(env, trip);
      return { ...r, message: `Everything earlier passes brought back is kept; ${rec.message}.` };
    }
    // finishReturnHome('recover') left the trip abandoned + unrecovered: the next go's recovery
    // (D12) parks the cloud's later work before anything is mirrored over it.
    return { ...r, message: `${(err as Error).message}. Everything earlier passes brought back is kept; the cloud's later work stays on the cloud and the next go recovers it into refs/handsfree/${trip}/* and trips/${trip}/orphaned/ before it starts.` };
  }
  if (lost) {
    await transition(env, trip, 'home');
    const rec = await recoverLostOnReturn(env, getClient, trip, dir);
    await stopOrQueue(env, trip);
    return { tripId: trip, outcome: 'lost', receipt: null, message: `${rec.message}. Everything on the laptop was kept.` };
  }
  if (quiescedEpoch !== null) {
    try { await (await getClient()).unquiesce(quiescedEpoch); } catch { /* the cloud reverts on its own (AC13) */ }
  }
  rmSync(progressPath(dir), { force: true });
  await transition(env, trip, 'away');
  throw err;
}

type FinalizeResult = Receipt['finalization'] | 'epoch_mismatch' | 'recover' | 'other';

/**
 * The end of every Return (normal and finalize-only Resume): the final receipt with every
 * earlier pass, phase home, and the last-trip record. A cloud the phone moved past our last
 * allowed pass (or sealed under another epoch) is recovered by the next go (D12).
 */
async function finishReturnHome(env: HandsfreeEnv, trip: string, dir: string, receipt: Receipt | null, prog: ReturnProgress, fin: FinalizeResult): Promise<ReturnResult> {
  const unfinished = fin === 'epoch_mismatch' || fin === 'recover' || fin === 'other';
  if (fin === 'other') {
    // Nothing of ours was confirmed on the cloud; the machine is still ours to stop.
    await updateConfig(env.home, (c) => ({ ...c, queued: { tripId: trip, epoch: prog.epoch, steps: ['stop'], since: new Date(nowOf(env)).toISOString() } }));
  }
  if (receipt) {
    receipt.finalization = fin === 'other'
      ? { secretsWiped: false, sealed: false, stopped: false, queued: ['stop'] }
      : unfinished ? { secretsWiped: false, sealed: false, stopped: false, queued: ['recovery at the next go'] } : fin;
    receipt.previousPasses = prog.receipts.slice(0, -1).map((p) => readJsonSafe<Receipt>(p)).filter((r): r is Receipt => !!r);
    writeJson(join(dir, 'receipt.json'), receipt);
  }
  await transition(env, trip, 'home', { finishing: true });
  // Everything came home; a cloud left unsealed is sealed by the queue at the next contact
  // (a newer epoch there flips this back to abandoned + unrecovered).
  if (unfinished) await markLastTrip(env, trip, { status: 'abandoned', recovered: false });
  else await markLastTrip(env, trip, { status: 'sealed', recovered: true, epoch: prog.epoch });
  return { tripId: trip, outcome: 'home', receipt };
}

/** wipe-secrets + seal under the pass's epoch (D21), then stop; never wedges `returning`. */
async function finalizeCloud(env: HandsfreeEnv, client: CloudClient, trip: string, epoch: number, onProgress?: Progress): Promise<FinalizeResult> {
  const fin: Receipt['finalization'] = { secretsWiped: false, sealed: false, stopped: false, queued: [] };
  const name = requireConfig(env).codespace.name;
  const r = await ensureCloudSealed(client, trip, epoch, onProgress);
  if (r.kind === 'delta') return 'epoch_mismatch';
  if (r.kind === 'recover') return 'recover';
  // Another trip (or none) holds the cloud: nothing of ours to seal, nothing confirmed; the
  // machine is still ours to stop, so that is queued.
  if (r.kind === 'other') return 'other';
  const queue: Array<'wipe-secrets' | 'seal' | 'stop'> = r.kind === 'queue' ? [...r.remaining, 'stop'] : ['stop'];
  if (r.kind === 'sealed') {
    fin.secretsWiped = true;
    fin.sealed = true;
    onProgress?.({ step: 'stop' });
    try {
      await stopMachine(env, name);
      fin.stopped = true;
      queue.length = 0;
    } catch (err) {
      if (!isReachabilityError(err)) throw err;
    }
  }
  if (queue.length) {
    fin.queued = [...queue];
    await updateConfig(env.home, (c) => ({ ...c, queued: { tripId: trip, epoch, steps: queue, since: new Date(nowOf(env)).toISOString() } }));
  }
  return fin;
}

// ---------------------------------------------------------------- resume / roll back / abandon

/** Resume an interrupted go or return from its journal (AC11). */
export async function resumeTrip(env: HandsfreeEnv, o: { cutRunning?: boolean; shouldCut?: () => boolean; onProgress?: Progress } = {}): Promise<ReturnResult> {
  let restart = false;
  const r = await resumeLocked(env, o, () => { restart = true; });
  return restart ? returnTrip(env, o) : r;
}

async function resumeLocked(env: HandsfreeEnv, o: { cutRunning?: boolean; shouldCut?: () => boolean; onProgress?: Progress }, onRestart: () => void): Promise<ReturnResult> {
  let restart = false;
  const st = requireState(env);
  const trip = st.tripId;
  if (!trip || st.phase === 'home' || st.phase === 'away') throw new HandsfreeError('nothing_to_resume', `nothing to resume (the laptop is ${st.phase})`);
  const dir = tripDirFor(env, trip);
  const lock = acquireTripRunLock(dir);
  if (!lock) throw new HandsfreeError('busy', 'another go or return is running for this trip');
  try {
    if (st.phase === 'going') {
      if (!existsSync(journalPath(dir, 'go'))) {
        await transition(env, trip, 'home');
        return { tripId: trip, outcome: 'cancelled', receipt: null, message: 'the go was interrupted before anything was sent; the laptop is home again, run go again' };
      }
      const up = await ensureRunning(env, { allowCreate: false, onProgress: o.onProgress });
      const goM = readJson<GoManifest>(join(dir, 'go-manifest.json'));
      try {
        await finishGo(env, up.client, up, goM, dir, { staysHome: [], signedOutAccounts: [], recovery: null, warnings: [], onProgress: o.onProgress });
      } catch (err) {
        await abortGoOnVerification(env, trip, dir, err);
        throw err;
      }
      return { tripId: trip, outcome: 'cancelled', receipt: null, message: `the go finished: the trip is away at ${up.info.url}` };
    }
    // returning — offline-first (D23 b): finishing the local journal never needs the cloud or
    // GitHub; the client is built lazily (no start, no blob-sha check, no health read).
    const prog = readJsonSafe<ReturnProgress>(progressPath(dir));
    const j = loadJournal(journalPath(dir, 'return'));
    let client: CloudClient | null = null;
    const getClient = async () => (client ??= await connectFor(env));
    if (j && prog) return await runReturnPasses(env, getClient, trip, dir, { ...o, startPass: prog.pass, resume: prog });
    if (prog && existsSync(join(dir, `return-journal.pass-${prog.pass}.json`))) {
      // The local apply finished; only the cloud finalization is left (queued when unreachable).
      const fin = await finalizeCloud(env, await getClient(), trip, prog.epoch, o.onProgress);
      if (fin === 'epoch_mismatch' && prog.pass < MAX_RETURN_PASSES) return await runReturnPasses(env, getClient, trip, dir, { ...o, startPass: prog.pass + 1 });
      const receipt = readJsonSafe<Receipt>(prog.receipts[prog.receipts.length - 1]);
      return await finishReturnHome(env, trip, dir, receipt, prog, fin);
    }
    if (!returnWriteStarted(dir)) {
      // Nothing of this Return was written: back to away, then start the return over.
      rmSync(progressPath(dir), { force: true });
      await transition(env, trip, 'away');
      restart = true;
      return { tripId: trip, outcome: 'cancelled', receipt: null };
    }
    // An earlier pass applied; this pass never got its plan: plan it again (or, without the
    // cloud, go home with the earlier passes' receipt).
    return await runReturnPasses(env, getClient, trip, dir, { ...o, startPass: prog?.pass ?? lastAppliedPass(dir) + 1 });
  } finally {
    lock.release();
    if (restart) onRestart();
  }
}

export interface RollbackResult {
  tripId: string;
  undone: string[];
  /** Files kept because the owner changed them after the Return wrote them. */
  kept: Conflict[];
  cloudUnquiesced: boolean;
}

/** Roll back: undo ONLY this return's own completed ops, back to away, cloud unquiesce (AC11). */
export async function rollbackTrip(env: HandsfreeEnv): Promise<RollbackResult> {
  const st = requireState(env);
  if (st.phase !== 'returning' || !st.tripId) throw new HandsfreeError('nothing_to_roll_back', `nothing to roll back (the laptop is ${st.phase})`);
  const trip = st.tripId;
  const dir = tripDirFor(env, trip);
  const lock = acquireTripRunLock(dir);
  if (!lock) throw new HandsfreeError('busy', 'another go or return is running for this trip');
  try {
    // Every pass of this Return, newest first: the live journal, then each archived pass.
    const prog = readJsonSafe<ReturnProgress>(progressPath(dir));
    const live = existsSync(journalPath(dir, 'return'));
    const passes = passJournals(dir).reverse();
    // A re-run after a crash mid-roll-back: every journal is already archived as rolled back.
    const resumedRollback = !live && !passes.length && existsSync(rollbackMarker(dir));
    if (!live && !passes.length && !resumedRollback) throw new HandsfreeError('nothing_to_roll_back', 'this return has no journal to roll back');
    // FIRST, before any journal is undone or renamed: the agreed baseline goes back to what it
    // was before the earliest pass (idempotent, so a re-run after a crash restores it again).
    // A partial earlier attempt already fixed the earliest pass: it wins over what is left now.
    const firstPass = existsSync(rollbackMarker(dir))
      ? Number(readFileSync(rollbackMarker(dir), 'utf8'))
      : Math.min(...passes.map((p) => p.pass), ...(live && prog ? [prog.pass] : []));
    if (!existsSync(rollbackMarker(dir))) atomicWriteFile(rollbackMarker(dir), String(firstPass));
    const before = join(dir, `agreed.before-pass-${firstPass}`);
    if (Number.isFinite(firstPass) && existsSync(before)) {
      rmSync(join(dir, 'agreed'), { recursive: true, force: true });
      cpSync(before, join(dir, 'agreed'), { recursive: true });
    }
    const handlers = returnOpsHandlers(env, dir);
    const journals: Journal[] = [];
    if (live) journals.push(await rollbackJournal(journalPath(dir, 'return'), handlers));
    for (const p of passes) journals.push(await rollbackJournal(p.path, handlers));
    const kept: Conflict[] = [];
    const undone: string[] = [];
    for (const j of journals) {
      for (const op of j.ops) {
        if (op.state !== 'undone') continue;
        undone.push(op.id);
        const r = op.undoResult as { kept?: Conflict[] } | undefined;
        if (r?.kept) kept.push(...r.kept);
      }
    }
    rmSync(progressPath(dir), { force: true });
    await transition(env, trip, 'away');
    rmSync(rollbackMarker(dir), { force: true });
    let cloudUnquiesced = false;
    try {
      const client = await connectFor(env);
      const h = await client.health();
      if (h.phase === 'quiescing') { await client.unquiesce(prog?.epoch ?? h.epoch); cloudUnquiesced = true; }
    } catch { /* the cloud's own backstop reverts or seals it */ }
    writeJson(join(dir, `rollback-${nowOf(env)}.json`), { undone, kept });
    return { tripId: trip, undone, kept, cloudUnquiesced };
  } finally {
    lock.release();
  }
}

/**
 * Abandon (double-confirmed in the CLI): unlock the laptop now. Never touches cloud content
 * (D12): the cloud is sealed when reachable and the next go recovers its work first. Offered
 * from going/away, from returning before the first write, and when GitHub refuses a start.
 */
export async function abandonTrip(env: HandsfreeEnv): Promise<{ tripId: string; cloudSealed: boolean }> {
  const st = requireState(env);
  if (st.phase === 'home' || !st.tripId) throw new HandsfreeError('not_away', 'no trip to abandon');
  const trip = st.tripId;
  const dir = tripDirFor(env, trip);
  mkdirSync(dir, { recursive: true });
  // Never under a running go/return (a CLI Abandon racing a dashboard Return).
  const lock = acquireTripRunLock(dir);
  if (!lock) throw new HandsfreeError('busy', 'a go or return is running for this trip; wait for it, or stop it first');
  try {
    if (st.phase === 'returning') {
      if (returnWriteStarted(dir)) throw new HandsfreeError('write_started', 'the return already wrote to the laptop: only Resume or Roll back');
      if (existsSync(journalPath(dir, 'return'))) renameSync(journalPath(dir, 'return'), join(dir, `return-journal.abandoned-${nowOf(env)}.json`));
    }
    await transition(env, trip, 'home');
    await markLastTrip(env, trip, { status: 'abandoned', recovered: false });
  } finally {
    lock.release();
  }
  let cloudSealed = false;
  try {
    const cfg = requireConfig(env);
    const info = await env.provider.get(cfg.codespace.name);
    if (info?.state === 'available') {
      const client = await connectFor(env);
      const h = await client.health();
      if (h.tripId === trip && h.phase !== 'sealed') {
        const q = await client.quiesce(trip, true);
        await client.seal(q.epoch);
        cloudSealed = true;
      }
      await stopMachine(env, info.name);
    }
  } catch { /* unreachable: the next go recovers anyway */ }
  return { tripId: trip, cloudSealed };
}

// ---------------------------------------------------------------- teardown + status

export async function teardown(env: HandsfreeEnv, o: { discardAbandonedWork?: boolean; contextRoot?: string; onProgress?: Progress } = {}): Promise<{ deleted: string | null; recovery: RecoveryReport | null }> {
  const st = requireState(env);
  if (st.phase !== 'home') throw new HandsfreeError('not_home', `teardown runs only while the laptop is home (now ${st.phase})`);
  const cfg = requireConfig(env);
  const last = cfg.lastTrip;
  const unrecovered = !!last && last.status !== 'sealed' && !last.recovered;
  let recovery: RecoveryReport | null = null;
  const info = await env.provider.get(cfg.codespace.name);
  if (info) {
    let up: Running | null = null;
    try {
      up = await ensureRunning(env, { allowCreate: false, onProgress: o.onProgress });
    } catch (err) {
      if (!o.discardAbandonedWork) throw new HandsfreeError('needs_recovery', `the cloud machine cannot be reached (${(err as Error).message}); teardown needs it for the recovery, or --discard-abandoned-work`);
    }
    if (up) {
      const h = await up.client.health();
      assertOwnership(cfg, h, {});
      if (!o.discardAbandonedWork && (unrecovered || h.phase !== 'sealed')) {
        if (!o.contextRoot) throw new HandsfreeError('needs_recovery', 'the cloud holds unrecovered work: run teardown from the project (the recovery needs its roots) or pass --discard-abandoned-work');
        const scope = await computeScope({ run: env.run, home: env.home, contextRoot: o.contextRoot, claudeProjectsDir: projectsDir(env) });
        if (h.tripId) recovery = await recoverTrip(env, up.client, h.tripId, scope, o.onProgress);
      }
    }
    await env.provider.delete(info.name);
  }
  await updateConfig(env.home, (c) => {
    const { codespace: _gone, ...rest } = c;
    return countUptime({ ...rest, queued: null } as HandsfreeConfig, false, coresFor(cfg.codespace.machine), nowOf(env));
  });
  return { deleted: info?.name ?? null, recovery };
}

export interface StatusReport {
  phase: TripState['phase'];
  tripId: string | null;
  /** The state file is unreadable: everything stays locked until it is repaired (names the file). */
  unreadable: string | null;
  setUp: boolean;
  laptopId: string | null;
  codespace: (MachineInfo & { configured: true }) | null;
  url: string | null;
  verifier: { generation: number; confirmed: number; pending: { kind: string; generation: number; since: string } | null } | null;
  queued: HandsfreeConfig['queued'] | null;
  lastTrip: HandsfreeConfig['lastTrip'] | null;
  uptime: { usedCoreMinutes: number; budgetCoreMinutes: number };
  journal: { direction: 'go' | 'return'; writeStarted: boolean; complete: boolean } | null;
  /** What the owner may do now. */
  offers: Array<'setup' | 'go' | 'return' | 'resume' | 'rollback' | 'abandon' | 'teardown'>;
  warnings: string[];
}

/** AC22: from day 20 the codespace of an abandoned or still-away trip is about to be deleted (day 30). */
export function retentionWarning(info: { retentionExpiresAt: string | null } | null, lastTrip: HandsfreeConfig['lastTrip'] | null | undefined, now: number): string | null {
  if (!info?.retentionExpiresAt || !lastTrip) return null;
  if (lastTrip.status === 'sealed' || lastTrip.recovered) return null;
  const left = Date.parse(info.retentionExpiresAt) - now;
  if (!Number.isFinite(left) || left > 10 * DAY) return null;
  return `GitHub deletes the cloud machine on ${info.retentionExpiresAt.slice(0, 10)} (${Math.max(0, Math.ceil(left / DAY))} days): ${lastTrip.status === 'away' ? 'return the trip' : 'its abandoned work is recovered automatically the next time it can be reached'} before then.`;
}

export async function status(env: HandsfreeEnv, o: { probe?: boolean } = {}): Promise<StatusReport> {
  const st = readTripState(env.home);
  const cfg = readConfig(env.home, nowOf(env));
  const warnings: string[] = [];
  let info: MachineInfo | null = null;
  if (o.probe !== false && cfg?.codespace) {
    try { info = await env.provider.get(cfg.codespace.name); } catch (err) { warnings.push(`GitHub: ${(err as Error).message}`); }
    if (info) await reconcileUptime(env, info);
  }
  const rw = retentionWarning(info ?? cfg?.codespace ?? null, cfg?.lastTrip, nowOf(env));
  if (rw) warnings.push(rw);
  let journal: StatusReport['journal'] = null;
  if (st.tripId && st.phase !== 'home' && !st.unreadable) {
    const dir = tripDirFor(env, st.tripId);
    for (const direction of ['return', 'go'] as const) {
      const j = (() => { try { return loadJournal(journalPath(dir, direction)); } catch { return null; } })();
      if (j) { const s = journalStatus(j); journal = { direction, writeStarted: s.writeStarted, complete: s.complete }; break; }
    }
    // An earlier pass of this Return already wrote (its journal is archived): only Resume or Roll back.
    if (st.phase === 'returning' && returnWriteStarted(dir)) journal = { direction: 'return', writeStarted: true, complete: false };
  }
  const offers: StatusReport['offers'] = [];
  if (!cfg?.codespace) offers.push('setup');
  else if (st.unreadable) { /* repair first */ } else if (st.phase === 'home') offers.push('go', 'teardown');
  else if (st.phase === 'away') offers.push('return', 'abandon');
  else if (st.phase === 'going') offers.push('resume', 'abandon');
  else if (st.phase === 'returning') {
    if (journal?.direction === 'return' && journal.writeStarted) offers.push('resume', 'rollback');
    else offers.push('resume', 'abandon');
  }
  const cores = coresFor(cfg?.codespace?.machine ?? 'basicLinux32gb');
  return {
    phase: st.phase,
    tripId: st.tripId,
    unreadable: st.unreadable ?? null,
    setUp: !!cfg?.codespace,
    laptopId: cfg?.laptopId ?? null,
    codespace: info ? { ...info, configured: true } : null,
    url: cfg?.codespace?.url ?? null,
    verifier: cfg?.verifier ? { generation: cfg.verifier.push.generation, confirmed: cfg.verifier.confirmed, pending: cfg.verifier.pending } : null,
    queued: cfg?.queued ?? null,
    lastTrip: cfg?.lastTrip ?? null,
    uptime: { usedCoreMinutes: cfg ? Math.round(usedCoreMinutes(cfg, cores, nowOf(env))) : 0, budgetCoreMinutes: cfg?.budgetCoreMinutes ?? 0 },
    journal,
    offers,
    warnings,
  };
}

/** The receipt of the last finished return of `tripId` (or of the latest trip). */
export function readReceipt(env: HandsfreeEnv, tripId: string): Receipt | null {
  return readJsonSafe<Receipt>(join(tripDirFor(env, tripId), 'receipt.json'));
}

/** Size helper for UIs. */
export function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
