// Hands-free LAPTOP orchestration end to end, in-process: real git in temp dirs, a scratch
// laptop HOME (never the real ~/.dreamcontext), and an in-memory fake cloud behind the
// CloudClient interface that runs the W1 library on a mirror under a second scratch home.
// Cases: setup, go then return (staged/unstaged/untracked/stash/branch, D16 secrets, session
// merge, transcripts, D18 re-sweep), divergence park, per-path conflicts, crash + resume,
// roll back, abandon then recovery (tolerant, merge in progress), trip_lost, epoch_mismatch
// -> second delta return, quota refusal never wedges, the run lock.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  createBundle, createSpawnRunner, fetchBundle, parseRepoSnapshot, snapshotBundleRefs, snapshotId, snapshotRepo, type ProcessRunner, type RepoSnapshot,
} from '../../src/lib/handsfree/git-snapshot.js';
import { addWorktreeNoCheckout, applyRemoteRefs, baseTips, gitOpHandlers, planRepoApply, setBaseRefs, verifyIncoming } from '../../src/lib/handsfree/git-apply.js';
import { applyPack, BackupStore, planMirror } from '../../src/lib/handsfree/apply.js';
import {
  buildManifest, encodeProjectDir, isSecretClass, manifestFromJSON, manifestToJSON, prefixPathMap, rootIdFor, sameContent, selectNonGitEntries, walk, type GoManifest,
  type Manifest, type ManifestEntry,
} from '../../src/lib/handsfree/manifest.js';
import { readPack, writePack } from '../../src/lib/handsfree/pack.js';
import { fakeFinalize, fakeUnquiesce } from '../helpers/handsfree-fake-cloud-state.js';
import { CloudError, CloudUnreachableError, PortPrivateError, manifestDigest, type GitReceiveBody, type CloudClient, type CloudHealth, type CloudPhaseName, type RunningTurn, type SnapshotRoot } from '../../src/lib/handsfree/cloud-client.js';
import { FakeCloudProvider, ProviderQuotaError } from '../../src/lib/handsfree/provider.js';
import {
  abandonTrip, go, HandsfreeError, resumeTrip, returnTrip, rollbackTrip, setup, status, type HandsfreeEnv,
} from '../../src/lib/handsfree/orchestrator.js';
import { readTripState } from '../../src/lib/handsfree/trip-state.js';
import { readConfig } from '../../src/lib/handsfree/local-store.js';
import { acquireTripRunLock, journalPath, tripDir, loadJournal } from '../../src/lib/handsfree/journal.js';
import { NO_TURNS, type TurnControl } from '../../src/lib/handsfree/turns.js';
import { readRosterSurface, writeMergedRosterSurface } from '../../src/server/routes/agent-sessions.js';
import type { JournalOp } from '../../src/lib/handsfree/journal.js';

vi.setConfig({ testTimeout: 240_000 });

let root: string;
let laptopHome: string;
let cloudHome: string;
let gitenv: Record<string, string>;
let run: ProcessRunner;

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitenv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const put = (base: string, rel: string, data: string) => {
  mkdirSync(join(base, rel, '..'), { recursive: true });
  writeFileSync(join(base, rel), data);
};
const read = (base: string, rel: string) => readFileSync(join(base, rel), 'utf8');
const toCloud = (p: string) => (p.startsWith(laptopHome) ? cloudHome + p.slice(laptopHome.length) : p);
const toLaptop = (p: string) => (p.startsWith(cloudHome) ? laptopHome + p.slice(cloudHome.length) : p);
const cloudId = (abs: string) => rootIdFor(toLaptop(abs));

function gitState(repo: string) {
  return {
    status: sh(repo, 'status', '--porcelain=v2'),
    refs: sh(repo, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags', 'refs/notes'),
    stash: sh(repo, 'stash', 'list', '--format=%H %gs'),
  };
}

// ---------------------------------------------------------------- the fake cloud (lane D's semantics)

class FakeCloud implements CloudClient {
  readonly origin = 'https://fake-hf-1-8080.app.github.dev';
  phase: CloudPhaseName = 'sealed';
  tripId: string | null = null;
  laptopId: string | null = null;
  epoch = 0;
  superseded: string[] = [];
  verifierGeneration = 0;
  lost = false;
  running: RunningTurn[] = [];
  goM: GoManifest | null = null;
  recorded = new Map<string, ManifestEntry[]>();
  agreedGit = new Map<string, RepoSnapshot>();
  uploads = new Map<string, string>();
  downloads = new Map<string, string>();
  /** Runs right before seal answers (the phone wakes it after the snapshot). */
  beforeSeal: (() => void) | null = null;
  preflightProblem: string | null = null;
  includes: Record<string, string[]> = {};
  gitBodies: Array<Omit<GitReceiveBody, 'snapshot'>> = [];
  mirrorPending = 0;
  sealedEpoch: number | null = null;
  loseSealReply = false;
  privateTimes = 0;
  beforeWipe: (() => void) | null = null;
  failWipe: Error | null = null;
  forged: SnapshotRoot | null = null;
  calls: string[] = [];
  private n = 0;

  constructor(private readonly scratch: string) {
    mkdirSync(join(scratch, 'up'), { recursive: true });
    mkdirSync(join(scratch, 'dl'), { recursive: true });
  }

  markStarted(): void {}
  async publicHealth() {
    if (this.privateTimes > 0) { this.privateTimes--; throw new PortPrivateError(this.origin); }
    return { version: '0', fingerprint: 'fp' };
  }
  async health(): Promise<CloudHealth> {
    return { version: '0', fingerprint: 'fp', phase: this.phase, tripId: this.tripId, laptopId: this.laptopId, epoch: this.epoch, verifierGeneration: this.verifierGeneration, supersededLaptopIds: this.superseded, sealedEpoch: this.sealedEpoch };
  }
  async uploadFile(path: string) {
    const id = `up-${String(++this.n).padStart(8, '0')}`;
    copyFileSync(path, join(this.scratch, 'up', id));
    this.uploads.set(id, join(this.scratch, 'up', id));
    return id;
  }
  async downloadTo(blob: { id: string; size: number; sha256: string }, path: string) {
    const src = this.downloads.get(blob.id)!;
    copyFileSync(src, path);
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== blob.sha256) throw new Error('bad download');
  }
  private blob(path: string) {
    const id = `dl-${String(++this.n).padStart(8, '0')}`;
    this.downloads.set(id, path);
    const b = readFileSync(path);
    return { id, size: b.length, sha256: createHash('sha256').update(b).digest('hex') };
  }
  async verifiers(push: { generation: number }) { this.verifierGeneration = push.generation; return { ok: true as const, generation: push.generation, changed: true }; }
  async revokeAll(generation: number) { this.verifierGeneration = generation; return { ok: true as const, generation, changed: true }; }
  async runtime() {}
  async trip(b: { tripId: string; laptopId: string; go: GoManifest; takeOver?: boolean; includes: Record<string, string[]> }) {
    this.calls.push('trip');
    if (this.mirrorPending > 0) { this.mirrorPending--; throw new CloudUnreachableError('503 mirror_pending', 'mirror_pending'); }
    this.includes = JSON.parse(JSON.stringify(b.includes));
    if (this.phase !== 'sealed') throw new CloudError(409, 'not_sealed', 'not sealed');
    if (b.takeOver && this.laptopId && this.laptopId !== b.laptopId) this.superseded.push(this.laptopId);
    this.tripId = b.tripId;
    this.laptopId = b.laptopId;
    this.goM = JSON.parse(JSON.stringify(b.go));
    this.lost = false;
  }
  spec(rootId: string) {
    const s = this.goM!.roots.find((r) => r.rootId === rootId);
    if (!s) throw new CloudError(404, 'unknown_root', rootId);
    return s;
  }
  async currentFiles(rootId: string) {
    const s = this.spec(rootId);
    const r = toCloud(s.absPath);
    if (!existsSync(r)) return { manifest: new Map() as Manifest, refused: [] as Array<{ path: string; reason: string }> };
    const sel = s.kind === 'transcripts' ? walk(r, [''], { side: 'cloud' }) : await selectNonGitEntries(run, r, { isGitRepo: s.kind === 'repo', side: 'cloud', include: this.includes[rootId] ?? [] });
    const refused = [...sel.refused];
    return { manifest: await buildManifest(r, sel.entries, undefined, refused), refused };
  }
  async state(rootId: string) {
    const s = this.spec(rootId);
    if (s.kind === 'repo') {
      const c = toCloud(s.absPath);
      return { kind: 'repo' as const, snapshot: null, baseTips: existsSync(join(c, '.git')) ? await baseTips(run, c) : [] };
    }
    return { kind: 'files' as const, manifest: manifestToJSON((await this.currentFiles(rootId)).manifest) };
  }
  async gitReceive(b: GitReceiveBody) {
    const s = this.spec(b.rootId);
    const C = toCloud(s.absPath);
    this.gitBodies.push(JSON.parse(JSON.stringify({ ...b, snapshot: null })));
    if (!existsSync(join(C, '.git'))) { mkdirSync(C, { recursive: true }); sh(C, 'init', '-q'); }
    // v1.1: the GENERATED .git/info/ and remotes (a URL that still carries userinfo is refused).
    for (const k of ['exclude', 'attributes'] as const) {
      if (b.info[k] !== undefined) { mkdirSync(join(C, '.git', 'info'), { recursive: true }); writeFileSync(join(C, '.git', 'info', k), b.info[k]!); }
    }
    for (const r of b.remotes) {
      if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(r.url) || /^[^/@:]+@[^/:]+:/.test(r.url)) throw new CloudError(400, 'bad_remote', 'userinfo');
      try { sh(C, 'remote', 'set-url', r.name, r.url); } catch { sh(C, 'remote', 'add', r.name, r.url); }
    }
    // A merge left in progress (already captured by the D12 recovery) is cleared before S lands.
    if (existsSync(join(C, '.git', 'MERGE_HEAD'))) sh(C, 'merge', '--abort');
    // Reach S from whatever the cloud holds NOW (the phone may have worked since the last trip).
    const hasHead = (() => { try { sh(C, 'rev-parse', '-q', '--verify', 'HEAD'); return true; } catch { return false; } })();
    const current = hasHead ? await snapshotRepo(run, C, { trip: b.tripId, side: 'cloud', checkoutIdFor: cloudId, writeRefs: false }) : null;
    const fetched = b.uploadId ? await fetchBundle(run, C, this.uploads.get(b.uploadId)!, { trip: b.tripId, acceptRemotes: true }) : {};
    const incoming = parseRepoSnapshot(JSON.parse(JSON.stringify(b.snapshot)), b.tripId);
    await verifyIncoming(run, C, incoming, fetched);
    const plan = await planRepoApply(run, {
      repoPath: C, trip: b.tripId, incoming, fetched, receiverStart: current, receiverNow: null,
      localCheckouts: { [cloudId(C)]: C }, policy: 'overwrite', strict: false,
    });
    const h = gitOpHandlers(run, { tripDir: join(this.scratch, 'trips', b.tripId) });
    for (const op of plan.ops) await h[op.kind].apply({ ...op, state: 'pending' } as JournalOp);
    if (incoming.remoteRefs) await applyRemoteRefs(run, C, incoming.remoteRefs);
    const cs = await snapshotRepo(run, C, { trip: b.tripId, side: 'cloud', checkoutIdFor: cloudId });
    this.agreedGit.set(b.rootId, cs);
    await setBaseRefs(run, C, Object.fromEntries(Object.values(cs.refs).map((o, i) => [`refs/handsfree/base/c${i}`, o])));
    return { snapshotId: snapshotId(cs) };
  }
  async filesReceive(b: { tripId: string; rootId: string; uploadId?: string; expected: ManifestEntry[] }) {
    const s = this.spec(b.rootId);
    const r = toCloud(s.absPath);
    mkdirSync(r, { recursive: true });
    const incoming = manifestFromJSON(b.expected);
    const now = (await this.currentFiles(b.rootId)).manifest;
    const plan = planMirror(now, incoming);
    const res = await applyPack(() => createReadStream(this.uploads.get(b.uploadId!)!), {
      root: r, plan, expected: now, incoming, conflictsDir: join(this.scratch, 'conf'), backup: new BackupStore(join(this.scratch, 'bk', b.rootId, String(++this.n))),
      policy: 'overwrite', maxBytes: 1 << 30,
    });
    this.recorded.set(b.rootId, b.expected);
    const after = (await this.currentFiles(b.rootId)).manifest;
    return { refused: res.refused, digest: manifestDigest(after.values()) };
  }
  async global(uploadId: string) { await readPack(createReadStream(this.uploads.get(uploadId)!), async () => {}, { maxBytes: 1 << 30 }); }
  async activate() { this.phase = 'active'; }
  async quiesce(tripId: string) {
    this.calls.push('quiesce');
    if (this.lost) throw new CloudError(409, 'trip_lost', 'trip marker missing');
    if (tripId !== this.tripId) throw new CloudError(409, 'trip_mismatch', 'other trip');
    this.phase = 'quiescing';
    this.epoch++;
    return { epoch: this.epoch, running: this.running };
  }
  async cut() { this.running = []; }
  async unquiesce() { this.calls.push('unquiesce'); fakeUnquiesce(this); }
  async snapshot(b: { epoch: number; tolerant?: boolean; knownTips: Record<string, string[]> }) {
    if (this.lost) throw new CloudError(409, 'trip_lost', 'trip marker missing');
    if (b.epoch !== this.epoch) throw new CloudError(409, 'epoch_mismatch', 'epoch');
    if (this.preflightProblem) throw new CloudError(409, 'preflight', 'preflight', { problems: [this.preflightProblem] });
    const trip = this.tripId!;
    const roots: SnapshotRoot[] = [];
    for (const s of this.goM!.roots.filter((x) => x.kind === 'repo')) {
      const C = toCloud(s.absPath);
      const cs = await snapshotRepo(run, C, { trip, side: 'cloud', checkoutIdFor: cloudId, tolerant: !!b.tolerant });
      const out = join(this.scratch, 'dl', `${++this.n}.bundle`);
      const made = await createBundle(run, C, { refs: snapshotBundleRefs(cs), knownTips: b.knownTips[s.rootId] ?? [], out });
      // v1.1: worktrees created in the cloud (absolute paths) + their transcript dirs, keyed by rootIdFor(path).
      const added = cs.checkouts.filter((c) => !c.isMain).map((c) => toLaptop(c.path));
      roots.push({ rootId: s.rootId, kind: 'repo', snapshot: JSON.parse(JSON.stringify(cs)), worktreesAdded: added, ...(made.created ? { bundle: this.blob(out) } : {}) });
      for (const lp of added) {
        const tdir = join(cloudHome, '.claude', 'projects', encodeProjectDir(lp));
        if (!existsSync(tdir)) continue;
        const m = await buildManifest(tdir, walk(tdir, [''], { side: 'cloud' }).entries);
        const out2 = join(this.scratch, 'dl', `${++this.n}.pack`);
        await writePack(createWriteStream(out2), { root: tdir, entries: m.values() });
        roots.push({ rootId: rootIdFor(lp), kind: 'files', manifest: manifestToJSON(m), refused: [], pack: this.blob(out2) });
      }
    }
    if (this.forged) roots.push(this.forged);
    for (const s of this.goM!.roots) {
      const { manifest, refused } = await this.currentFiles(s.rootId);
      const atGo = manifestFromJSON(this.recorded.get(s.rootId) ?? []);
      const changed = [...manifest.values()].filter((e) => !sameContent(atGo.get(e.path), e));
      const deletions = [...atGo.keys()].filter((p) => !manifest.has(p));
      let pack;
      if (changed.length || deletions.length) {
        const out = join(this.scratch, 'dl', `${++this.n}.pack`);
        await writePack(createWriteStream(out), { root: toCloud(s.absPath), entries: changed, deletions });
        pack = this.blob(out);
      }
      roots.push({ rootId: s.rootId, kind: 'files', manifest: manifestToJSON(manifest), refused, ...(pack ? { pack } : {}) });
    }
    return { epoch: b.epoch, roots };
  }
  async doWipe() {
    for (const s of this.goM!.roots) {
      const { manifest } = await this.currentFiles(s.rootId);
      for (const p of manifest.keys()) if (isSecretClass(p)) rmSync(join(toCloud(s.absPath), p), { force: true });
    }
  }
  // Lane D's D21 rules (tests/helpers/handsfree-fake-cloud-state.ts, held to the real store by
  // handsfree-finalize-contract.test.ts).
  async wipeSecrets(epoch: number) {
    this.calls.push('wipe');
    if (this.failWipe) { const e = this.failWipe; this.failWipe = null; throw e; }
    if (this.beforeWipe) { const f = this.beforeWipe; this.beforeWipe = null; f(); }
    return fakeFinalize(this, 'wipe-secrets', epoch, () => this.doWipe());
  }
  async seal(epoch: number) {
    this.calls.push('seal');
    if (this.beforeSeal) { const f = this.beforeSeal; this.beforeSeal = null; f(); }
    await fakeFinalize(this, 'seal', epoch, () => this.doWipe());
    if (this.loseSealReply) { this.loseSealReply = false; throw new CloudUnreachableError('the reply was lost'); }
  }
  async accounts() { return [{ id: 'main', label: 'main', signedIn: false }]; }
}

// ---------------------------------------------------------------- fixtures

let vault: string;
let ctx: string;
let fake: FakeCloud;
let provider: FakeCloudProvider;

function makeEnv(over: Partial<HandsfreeEnv> = {}): HandsfreeEnv {
  return {
    home: laptopHome, run, provider, repo: provider, connect: () => fake, turns: NO_TURNS,
    roster: { read: readRosterSurface, write: writeMergedRosterSurface },
    templateFiles: () => ({ '.devcontainer/devcontainer.json': Buffer.from('{"name":"hf"}\n') }),
    localFingerprint: () => 'fp', packRuntime: async () => { throw new Error('no pack in tests'); },
    claudeProjectsDir: join(laptopHome, '.claude', 'projects'), sleep: async () => {}, healthTimeoutMs: 1000,
    ...over,
  };
}

function roster(sessions: Array<Record<string, unknown>>, mode: 'auto' | 'bypass') {
  return JSON.stringify({ sessions, chatPermissionMode: mode }, null, 2);
}
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

function makeVault(): void {
  vault = join(laptopHome, 'projects', 'app');
  ctx = join(vault, '_dream_context');
  mkdirSync(vault, { recursive: true });
  sh(vault, 'init', '-q');
  put(vault, '.gitignore', '_dream_context/state/\n_dream_context/state/.agent-sessions.json\n_dream_context/state/.session-titles.json\n.env\n.env.local\n');
  put(vault, '_dream_context/core/0.soul.md', 'soul\n');
  put(vault, 'a.txt', 'a1\n');
  put(vault, 'b.txt', 'b1\n');
  sh(vault, 'add', '.');
  sh(vault, 'commit', '-qm', 'c1');
  put(vault, '.env', 'TOKEN=laptop\n');
  put(vault, '.env.local', 'LOCAL=1\n');
  put(vault, '_dream_context/state/notes.md', 'state note\n');
  put(vault, '_dream_context/state/.agent-sessions.json', roster([
    { title: 'Kept', bypass: true, minimized: false, size: 1, sessionId: S1, kind: 'chat' },
    { title: 'Closed on phone', bypass: false, minimized: false, size: 1, sessionId: S2, kind: 'chat' },
  ], 'auto'));
  // A transcript of the vault.
  const enc = vault.replace(/[^A-Za-z0-9]/g, '-');
  put(join(laptopHome, '.claude', 'projects', enc), `${S1}.jsonl`, '{"type":"user"}\n');
}

beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hf-orch-')));
  laptopHome = join(root, 'laptop');
  cloudHome = join(root, 'cloud');
  mkdirSync(laptopHome);
  mkdirSync(cloudHome);
  const cfg = join(root, '.gitconfig');
  writeFileSync(cfg, '[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
  gitenv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) gitenv[k] = v;
  Object.assign(gitenv, { HOME: root, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' });
  run = createSpawnRunner({ baseEnv: gitenv });
  fake = new FakeCloud(join(root, 'fake'));
  provider = new FakeCloudProvider({ url: fake.origin });
  makeVault();
  await setup(makeEnv(), { token: 'gho_test', login: 'owner' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const C = () => toCloud(vault);
const tripDirOf = (trip: string) => tripDir(join(laptopHome, '.dreamcontext', 'handsfree'), trip);

// ---------------------------------------------------------------- tests

describe('setup', () => {
  it('signs in, writes the repo files + verifiers, creates the machine, pushes the verifiers and leaves it stopped; a re-run is idempotent', async () => {
    const cfg = readConfig(laptopHome)!;
    expect(cfg.codespace?.url).toBe(fake.origin);
    expect(cfg.verifier?.pending).toBeNull();
    expect(fake.verifierGeneration).toBe(1);
    expect(provider.repoFiles.has('.devcontainer/bootstrap/verifiers.json')).toBe(true);
    expect([...provider.machines.values()][0].state).toBe('stopped');
    const again = await setup(makeEnv());
    expect(again.passphrase).toBeNull();
    expect(again.created).toBe(false);
    expect(provider.machines.size).toBe(1);
  });
});

describe('go then return', () => {
  it('lands commits, branches, stash, staged/unstaged/untracked, D16 secrets, the session merge and transcripts; re-sweeps every root; seals and stops', async () => {
    sh(vault, 'branch', 'feature');
    put(vault, 'a.txt', 'stashed\n');
    sh(vault, 'stash', 'push', '-m', 'laptop stash');
    put(vault, 'a.txt', 'staged\n');
    sh(vault, 'add', 'a.txt');
    put(vault, 'a.txt', 'staged + unstaged\n');
    put(vault, 'untracked.md', 'u\n');

    const env = makeEnv();
    const g = await go(env, { contextRoot: ctx });
    expect(g.url).toBe(fake.origin);
    expect(g.signedOutAccounts).toEqual(['main']);
    expect(readTripState(laptopHome).phase).toBe('away');
    expect(fake.phase).toBe('active');
    // AC2: equal git state and equal non-git files.
    expect(gitState(C())).toEqual(gitState(vault));
    expect(read(C(), '_dream_context/state/notes.md')).toBe('state note\n');
    expect(read(C(), '.env')).toBe('TOKEN=laptop\n');

    // The phone works.
    sh(C(), 'stash', 'push', '-m', 'cloud stash');
    put(C(), 'c.txt', 'cloud\n');
    sh(C(), 'add', 'c.txt');
    sh(C(), 'commit', '-qm', 'cloud commit');
    sh(C(), 'branch', 'cloud-branch');
    put(C(), 'b.txt', 'cloud unstaged\n');
    put(C(), 'scratch.txt', 'cloud untracked\n');
    put(C(), '_dream_context/state/notes.md', 'cloud note\n');
    put(C(), '.env', 'TOKEN=cloud\n');
    rmSync(join(C(), '.env.local'));
    put(C(), '_dream_context/state/.agent-sessions.json', roster([
      { title: 'Kept, renamed on phone', bypass: true, minimized: false, size: 1, sessionId: S1, kind: 'chat' },
      { title: 'Opened on phone', bypass: true, minimized: false, size: 1, sessionId: S3, kind: 'chat' },
    ], 'bypass'));
    const enc = vault.replace(/[^A-Za-z0-9]/g, '-');
    put(join(cloudHome, '.claude', 'projects', enc), `${S3}.jsonl`, '{"type":"user","phone":true}\n');

    const r = await returnTrip(env);
    expect(r.outcome).toBe('home');
    expect(readTripState(laptopHome).phase).toBe('home');
    // AC7: equal git state.
    expect(gitState(vault)).toEqual(gitState(C()));
    expect(read(vault, 'scratch.txt')).toBe('cloud untracked\n');
    expect(read(vault, '_dream_context/state/notes.md')).toBe('cloud note\n');
    // D16: a cloud-changed secret overwrites (backed up); an absent one is kept.
    expect(read(vault, '.env')).toBe('TOKEN=cloud\n');
    expect(read(vault, '.env.local')).toBe('LOCAL=1\n');
    const files = r.receipt!.files.find((f) => f.path === vault)!;
    expect(files.secrets).toEqual(['.env']);
    expect(files.notReturned).toEqual(['.env.local']);
    // Session merge: laptop permission mode, cloud wins per entry, tombstone, cloud-only bypass:false.
    const merged = readRosterSurface(ctx);
    expect(merged.chatPermissionMode).toBe('auto');
    expect(merged.sessions.map((s) => s.sessionId)).toEqual([S1, S3]);
    expect(merged.sessions[0].title).toBe('Kept, renamed on phone');
    expect(merged.sessions[0].bypass).toBe(true);
    expect(merged.sessions[1].bypass).toBe(false);
    expect(merged.generation).toBeGreaterThan(0);
    // The phone's transcript came home into the vault's encoded dir.
    expect(existsSync(join(laptopHome, '.claude', 'projects', enc, `${S3}.jsonl`))).toBe(true);
    // D18: every root was re-swept after both transports.
    const j = JSON.parse(readFileSync(join(tripDirOf(r.tripId), 'return-journal.pass-1.json'), 'utf8')) as { ops: JournalOp[] };
    const resweeps = j.ops.filter((o) => o.kind === 'root.resweep');
    expect(resweeps.length).toBeGreaterThanOrEqual(2);
    expect(resweeps.every((o) => o.state === 'done')).toBe(true);
    // Finalized: secrets wiped, sealed, stopped.
    expect(r.receipt!.finalization).toEqual({ secretsWiped: true, sealed: true, stopped: true, queued: [] });
    expect(existsSync(join(C(), '.env'))).toBe(false);
    expect(fake.phase).toBe('sealed');
    expect([...provider.machines.values()][0].state).toBe('stopped');
    expect(readConfig(laptopHome)!.lastTrip?.status).toBe('sealed');
  });
});

describe('divergence and conflicts', () => {
  it('a laptop commit while away parks the cloud refs under refs/handsfree/<trip>/* and leaves the laptop untouched', async () => {
    const env = makeEnv();
    const g = await go(env, { contextRoot: ctx });
    put(C(), 'c.txt', 'cloud\n');
    sh(C(), 'add', '.');
    sh(C(), 'commit', '-qm', 'cloud');
    const cloudHead = sh(C(), 'rev-parse', 'HEAD').trim();
    put(vault, 'l.txt', 'laptop\n');
    sh(vault, 'add', 'l.txt');
    sh(vault, 'commit', '-qm', 'laptop');
    const before = gitState(vault);
    const r = await returnTrip(env);
    const repo = r.receipt!.repos[0];
    expect(repo.outcome).toBe('parked');
    expect(gitState(vault)).toEqual(before);
    expect(sh(vault, 'rev-parse', `refs/handsfree/${g.tripId}/heads/main`).trim()).toBe(cloudHead);
  });

  it('a laptop working-tree edit and a non-git edit on both sides keep the laptop file; the cloud copy goes to conflicts/', async () => {
    const env = makeEnv();
    const g = await go(env, { contextRoot: ctx });
    put(C(), 'a.txt', 'cloud a\n');
    put(C(), 'b.txt', 'cloud b\n');
    put(C(), '_dream_context/state/notes.md', 'cloud note\n');
    put(vault, 'a.txt', 'laptop a\n');
    put(vault, '_dream_context/state/notes.md', 'laptop note\n');
    const r = await returnTrip(env);
    expect(read(vault, 'a.txt')).toBe('laptop a\n');
    expect(read(vault, 'b.txt')).toBe('cloud b\n');
    expect(read(vault, '_dream_context/state/notes.md')).toBe('laptop note\n');
    const cid = rootIdFor(vault);
    expect(read(join(tripDirOf(g.tripId), 'conflicts', `git-${cid}`), 'a.txt')).toBe('cloud a\n');
    expect(read(join(tripDirOf(g.tripId), 'conflicts', cid), '_dream_context/state/notes.md')).toBe('cloud note\n');
    expect(r.receipt!.repos[0].conflicts.map((c) => c.path)).toEqual(['a.txt']);
    expect(r.receipt!.files.find((f) => f.path === vault)!.conflicts.map((c) => c.path)).toEqual(['_dream_context/state/notes.md']);
  });
});

describe('crash safety', () => {
  async function crashedReturn() {
    let fail = true;
    const env = makeEnv({
      roster: {
        read: readRosterSurface,
        write: (c, s) => { if (fail) throw new Error('killed mid-return'); return writeMergedRosterSurface(c, s); },
      },
    });
    const g = await go(env, { contextRoot: ctx });
    put(C(), 'b.txt', 'cloud b\n');
    put(C(), '_dream_context/state/notes.md', 'cloud note\n');
    put(C(), '_dream_context/state/.agent-sessions.json', roster([{ title: 'Phone', bypass: false, minimized: false, size: 1, sessionId: S1, kind: 'chat' }], 'auto'));
    await expect(returnTrip(env)).rejects.toThrow(/killed mid-return/);
    expect(readTripState(laptopHome).phase).toBe('returning');
    expect(read(vault, 'b.txt')).toBe('cloud b\n'); // git ops already landed
    return { env, g, heal: () => { fail = false; } };
  }

  it('a return killed mid-journal completes from the journal on re-run', async () => {
    const { env, heal } = await crashedReturn();
    const st = await status(env, { probe: false });
    expect(st.offers).toEqual(['resume', 'rollback']);
    heal();
    const r = await resumeTrip(env);
    expect(r.outcome).toBe('home');
    expect(readRosterSurface(ctx).sessions[0].title).toBe('Phone');
    expect(read(vault, '_dream_context/state/notes.md')).toBe('cloud note\n');
    expect(fake.phase).toBe('sealed');
  });

  it('Roll back restores files, goes back to away and unquiesces the cloud', async () => {
    const { env } = await crashedReturn();
    const rb = await rollbackTrip(env);
    expect(readTripState(laptopHome).phase).toBe('away');
    expect(read(vault, 'b.txt')).toBe('b1\n');
    expect(read(vault, '_dream_context/state/notes.md')).toBe('state note\n');
    expect(rb.cloudUnquiesced).toBe(true);
    expect(fake.phase).toBe('active');
    // A retried Return creates a fresh journal and lands again.
    const r = await returnTrip(makeEnv());
    expect(r.outcome).toBe('home');
    expect(read(vault, 'b.txt')).toBe('cloud b\n');
  });
});

describe('abandon and recovery (D12)', () => {
  it('abandon never touches cloud work; the next go recovers it (tolerant, merge in progress) into refs/handsfree/<old>/* and trips/<old>/orphaned/', async () => {
    const env = makeEnv();
    const g1 = await go(env, { contextRoot: ctx });
    // The phone: a branch, a conflicting merge left in progress, an ignored brain file.
    sh(C(), 'checkout', '-q', '-b', 'side');
    put(C(), 'a.txt', 'side a\n');
    sh(C(), 'commit', '-qam', 'side');
    sh(C(), 'checkout', '-q', 'main');
    put(C(), 'a.txt', 'main a\n');
    sh(C(), 'commit', '-qam', 'main');
    expect(() => sh(C(), 'merge', 'side')).toThrow();
    put(C(), '_dream_context/state/phone.md', 'from the phone\n');
    const sideTip = sh(C(), 'rev-parse', 'side').trim();
    provider.machines.forEach((m) => { m.state = 'available'; });

    const a = await abandonTrip(env);
    expect(a.cloudSealed).toBe(true);
    expect(readTripState(laptopHome).phase).toBe('home');
    expect(readConfig(laptopHome)!.lastTrip).toMatchObject({ tripId: g1.tripId, status: 'abandoned', recovered: false });
    expect(existsSync(join(C(), '_dream_context/state/phone.md'))).toBe(true);
    expect(read(vault, 'a.txt')).toBe('a1\n');

    // The next go recovers first (tolerant snapshot under one epoch), then starts the new trip.
    const g2 = await go(env, { contextRoot: ctx });
    expect(g2.recovery?.oldTrip).toBe(g1.tripId);
    expect(g2.tripId).not.toBe(g1.tripId);
    // The recovery ran before the new trip.
    expect(sh(vault, 'rev-parse', `refs/handsfree/${g1.tripId}/heads/side`).trim()).toBe(sideTip);
    const inprog = sh(vault, 'for-each-ref', '--format=%(refname)', `refs/handsfree/${g1.tripId}/snap/`);
    expect(inprog).toMatch(/inprogress\/MERGE_HEAD/);
    const orphanDir = join(tripDirOf(g1.tripId), 'orphaned', rootIdFor(vault));
    expect(read(orphanDir, '_dream_context/state/phone.md')).toBe('from the phone\n');
    expect(readConfig(laptopHome)!.lastTrip).toMatchObject({ tripId: g2.tripId, status: 'away' });
  });

  it('trip_lost keeps everything on the laptop and treats the trip as abandoned', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    fake.lost = true;
    const before = gitState(vault);
    const r = await returnTrip(env);
    expect(r.outcome).toBe('lost');
    expect(readTripState(laptopHome).phase).toBe('home');
    expect(gitState(vault)).toEqual(before);
    expect(readConfig(laptopHome)!.lastTrip?.status).toBe('lost');
  });
});

describe('epoch mismatch', () => {
  it('a phone action between snapshot and seal runs a second delta return under the new epoch', async () => {
    const env = makeEnv();
    const g = await go(env, { contextRoot: ctx });
    put(C(), 'b.txt', 'pass one\n');
    fake.beforeSeal = () => {
      put(C(), 'late.txt', 'written after the snapshot\n');
      fake.epoch++;
    };
    const r = await returnTrip(env);
    expect(r.outcome).toBe('home');
    expect(r.receipt!.pass).toBe(2);
    expect(read(vault, 'b.txt')).toBe('pass one\n');
    expect(read(vault, 'late.txt')).toBe('written after the snapshot\n');
    expect(fake.phase).toBe('sealed');
    expect(existsSync(join(tripDirOf(g.tripId), 'return-journal.pass-2.json'))).toBe(true);
  });
});

describe('quota and the run lock', () => {
  it('a quota refusal at go ends at home (never wedges); an away trip refused at return can still be abandoned', async () => {
    provider.quotaRefusal = new ProviderQuotaError('quota used up', '2026-11-01T00:00:00.000Z');
    const env = makeEnv();
    await expect(go(env, { contextRoot: ctx })).rejects.toMatchObject({ code: 'quota' });
    expect(readTripState(laptopHome).phase).toBe('home');

    provider.quotaRefusal = null;
    await go(env, { contextRoot: ctx });
    provider.machines.forEach((m) => { m.state = 'stopped'; });
    provider.quotaRefusal = new ProviderQuotaError('quota used up', '2026-11-01T00:00:00.000Z');
    await expect(returnTrip(env)).rejects.toMatchObject({ code: 'quota', detail: { canAbandon: true } });
    expect(readTripState(laptopHome).phase).toBe('away');
    await abandonTrip(env);
    expect(readTripState(laptopHome).phase).toBe('home');
  });

  it('a second go (or resume) while one runs is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let waiting!: () => void;
    const started = new Promise<void>((r) => { waiting = r; });
    const turns: TurnControl = {
      list: async () => { waiting(); await gate; return []; },
      cut: async () => 0,
    };
    const env = makeEnv({ turns });
    const first = go(env, { contextRoot: ctx });
    await started;
    await expect(go(makeEnv(), { contextRoot: ctx })).rejects.toMatchObject({ code: 'not_home' });
    await expect(resumeTrip(makeEnv())).rejects.toMatchObject({ code: 'busy' });
    release();
    await first;
    expect(readTripState(laptopHome).phase).toBe('away');
  });

  it('a running turn waits until it ends unless Cut is chosen; the preflight re-runs after a cut', async () => {
    let cuts = 0;
    let busy = true;
    const turns: TurnControl = {
      list: async () => (busy ? [{ kind: 'chat', id: 'c1', busy: true }] : []),
      cut: async (_r, o) => { if (o.all) { cuts++; busy = false; } return o.all ? 1 : 0; },
    };
    const env = makeEnv({ turns, waitTimeoutMs: 0 });
    await expect(go(env, { contextRoot: ctx })).rejects.toMatchObject({ code: 'turns_running' });
    expect(readTripState(laptopHome).phase).toBe('home');
    await go(env, { contextRoot: ctx, cutRunning: true });
    expect(cuts).toBe(1);
    expect(readTripState(laptopHome).phase).toBe('away');
  });
});

describe('take-over and superseded (AC24)', () => {
  it('a live trip of another laptop refuses go; the old laptop that comes back sees superseded, unlocks and returns nothing', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    // Another laptop took it over.
    fake.superseded.push(readConfig(laptopHome)!.laptopId);
    fake.laptopId = 'lp-other';
    const before = gitState(vault);
    const r = await returnTrip(env);
    expect(r.outcome).toBe('superseded');
    expect(readTripState(laptopHome).phase).toBe('home');
    expect(gitState(vault)).toEqual(before);
  });
});

describe('cloud preflight at return (AC13)', () => {
  it('a merge in progress in the cloud cancels back to active with a message to resolve it on the phone', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    fake.preflightProblem = 'MERGE_HEAD is in progress';
    await expect(returnTrip(env)).rejects.toMatchObject({ code: 'cloud_preflight' });
    expect(readTripState(laptopHome).phase).toBe('away');
    expect(fake.phase).toBe('active');
    expect(fake.calls).toContain('unquiesce');
  });
});


describe('wire v1.1', () => {
  it('git/receive carries .git/info/exclude + attributes and userinfo-stripped remotes; POST trip carries the include patterns; AC2 holds with an info/exclude', async () => {
    sh(vault, 'remote', 'add', 'origin', 'https://someone:ghp_secret@github.com/owner/app.git');
    sh(vault, 'remote', 'add', 'mirror', 'git@github.com:owner/app.git');
    writeFileSync(join(vault, '.git', 'info', 'exclude'), '**/.claude/worktrees/\nlocal-only/\n');
    writeFileSync(join(vault, '.git', 'info', 'attributes'), '*.bin binary\n');
    put(vault, 'local-only/x.txt', 'excluded by info/exclude\n');
    put(vault, '_dream_context/state/.config.json', JSON.stringify({ handsfree: { include: ['data'] } }));
    put(vault, '.gitignore', read(vault, '.gitignore') + 'data/\n');
    sh(vault, 'commit', '-qam', 'ignore data');
    put(vault, 'data/a.txt', 'included\n');
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    const body = fake.gitBodies[0];
    expect(body.info).toEqual({ exclude: '**/.claude/worktrees/\nlocal-only/\n', attributes: '*.bin binary\n' });
    expect(body.remotes).toEqual([{ name: 'origin', url: 'https://github.com/owner/app.git' }, { name: 'mirror', url: 'github.com:owner/app.git' }]);
    expect(JSON.stringify(fake.gitBodies)).not.toContain('ghp_secret');
    expect(fake.includes[rootIdFor(vault)]).toEqual(['data']);
    expect(read(C(), 'data/a.txt')).toBe('included\n');
    // AC2: the porcelain status matches because the cloud's GENERATED info/exclude matches.
    expect(gitState(C())).toEqual(gitState(vault));
    // A file the phone creates under an included path comes home.
    put(C(), 'data/b.txt', 'from the phone\n');
    await returnTrip(env);
    expect(read(vault, 'data/b.txt')).toBe('from the phone\n');
  });

  it('a worktree created in the cloud comes home with its transcripts, only into the encoded dir of the allowed laptop path; an unknown root is ignored', async () => {
    writeFileSync(join(vault, '.git', 'info', 'exclude'), '**/.claude/worktrees/\n');
    mkdirSync(join(vault, '.claude', 'worktrees'), { recursive: true });
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    const wt = join(vault, '.claude', 'worktrees', 'wt-one');
    mkdirSync(join(C(), '.claude', 'worktrees'), { recursive: true });
    sh(C(), 'worktree', 'add', '-q', '-b', 'wt-one', toCloud(wt));
    put(toCloud(wt), 'wt.txt', 'worktree file\n');
    symlinkSync('wt.txt', join(toCloud(wt), 'link'));
    const enc = encodeProjectDir(wt);
    put(join(cloudHome, '.claude', 'projects', enc), `${S3}.jsonl`, '{"type":"user","wt":true}\n');
    // A forged entry for a root this laptop never listed: ignored, never written.
    fake.forged = { rootId: rootIdFor(join(laptopHome, 'elsewhere')), kind: 'files', manifest: [], refused: [] };
    const r = await returnTrip(env);
    expect(r.outcome).toBe('home');
    expect(read(wt, 'wt.txt')).toBe('worktree file\n');
    expect(sh(wt, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/wt-one');
    expect(read(join(laptopHome, '.claude', 'projects', enc), `${S3}.jsonl`)).toBe('{"type":"user","wt":true}\n');
    expect(r.receipt!.repos[0].worktreesAdded).toEqual([realpathSync.native(wt)]);
    // The new worktree's links are re-swept at its own dest (D18), not under the repo root.
    const j = JSON.parse(readFileSync(join(tripDirOf(r.tripId), 'return-journal.pass-1.json'), 'utf8')) as { ops: JournalOp[] };
    const sweep = j.ops.find((o) => o.kind === 'root.resweep' && (o.params as { root: string }).root === realpathSync.native(wt))!;
    expect((sweep.params as { linkRels: string[] }).linkRels).toContain('link');
    expect(sweep.state).toBe('done');
    expect(readlinkSync(join(wt, 'link'))).toBe('wt.txt');
    expect(r.receipt!.ignoredRoots).toEqual([{ rootId: rootIdFor(join(laptopHome, 'elsewhere')), reason: 'not a root of this trip' }]);
  });

  it('a worktree outside the allowed parents is refused, and its transcripts never land', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    const wt = join(laptopHome, 'stray-wt');
    sh(C(), 'worktree', 'add', '-q', '-b', 'stray', toCloud(wt));
    const enc = encodeProjectDir(wt);
    put(join(cloudHome, '.claude', 'projects', enc), `${S3}.jsonl`, '{}\n');
    const r = await returnTrip(env);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(laptopHome, '.claude', 'projects', enc))).toBe(false);
    expect(r.receipt!.repos[0].refused.map((x) => x.path)).toContain(wt);
    expect(r.receipt!.ignoredRoots.map((x) => x.rootId)).toEqual([rootIdFor(wt)]);
  });

  it('POST trip retries 503 mirror_pending (the mirror is mounted after a fresh start)', async () => {
    fake.mirrorPending = 2;
    const g = await go(makeEnv(), { contextRoot: ctx });
    expect(fake.tripId).toBe(g.tripId);
    expect(fake.mirrorPending).toBe(0);
  });

  it('the blob-sha check covers supervisor.mjs: a changed copy in the repo refuses the go', async () => {
    const env = makeEnv({ templateFiles: () => ({ '.devcontainer/devcontainer.json': Buffer.from('{}\n'), '.devcontainer/supervisor.mjs': Buffer.from('// supervisor\n') }) });
    await setup(env);
    expect(readConfig(laptopHome)!.repo!.fileShas['.devcontainer/supervisor.mjs']).toBeDefined();
    provider.repoFiles.set('.devcontainer/supervisor.mjs', Buffer.from('// planted\n'));
    await expect(go(env, { contextRoot: ctx })).rejects.toMatchObject({ code: 'tampered' });
    expect(readTripState(laptopHome).phase).toBe('home');
  });
});

describe('review round 1: multi-pass returns', () => {
  it('an epoch moved before wipe-secrets runs the second delta return and goes home (AC13); every pass receipt is kept', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    put(C(), 'b.txt', 'pass one\n');
    fake.beforeWipe = () => { put(C(), 'late.txt', 'after the snapshot\n'); fake.epoch++; };
    const r = await returnTrip(env);
    expect(r.outcome).toBe('home');
    expect(r.receipt!.pass).toBe(2);
    expect(r.receipt!.previousPasses?.map((x) => x.pass)).toEqual([1]);
    expect(read(vault, 'late.txt')).toBe('after the snapshot\n');
    expect(readTripState(laptopHome).phase).toBe('home');
    expect(fake.phase).toBe('sealed');
  });

  it('a crash after pass 1 applied offers only Resume or Roll back; Roll back restores the pre-return laptop and a retried Return lands again', async () => {
    const env = makeEnv();
    const g = await go(env, { contextRoot: ctx });
    put(C(), 'b.txt', 'cloud b\n');
    put(C(), 'new.txt', 'new\n');
    put(C(), '_dream_context/state/notes.md', 'cloud note\n');
    // The process dies right after pass 1 applied, as finalization starts.
    const onProgress = (e: { step: string }) => { if (e.step === 'wipe-secrets') throw new Error('killed after pass 1'); };
    await expect(returnTrip(env, { onProgress })).rejects.toThrow(/killed after pass 1/);
    expect(read(vault, 'b.txt')).toBe('cloud b\n');
    expect(existsSync(journalPath(tripDirOf(g.tripId), 'return'))).toBe(false); // archived as pass 1
    expect((await status(env, { probe: false })).offers).toEqual(['resume', 'rollback']);
    await expect(abandonTrip(env)).rejects.toMatchObject({ code: 'write_started' });
    await rollbackTrip(env);
    expect(readTripState(laptopHome).phase).toBe('away');
    expect(read(vault, 'b.txt')).toBe('b1\n');
    expect(existsSync(join(vault, 'new.txt'))).toBe(false);
    expect(read(vault, '_dream_context/state/notes.md')).toBe('state note\n');
    const r = await returnTrip(env);
    expect(r.outcome).toBe('home');
    expect(read(vault, 'b.txt')).toBe('cloud b\n');
    expect(read(vault, 'new.txt')).toBe('new\n');
    expect(r.receipt!.repos[0].conflicts).toEqual([]);
  });

  it('Roll back during pass 2 undoes pass 2 AND pass 1', async () => {
    let failRoster = false;
    const env = makeEnv({
      roster: { read: readRosterSurface, write: (c, s) => { if (failRoster) throw new Error('killed in pass 2'); return writeMergedRosterSurface(c, s); } },
    });
    await go(env, { contextRoot: ctx });
    put(C(), 'b.txt', 'pass one\n');
    fake.beforeSeal = () => {
      put(C(), 'late.txt', 'pass two\n');
      put(C(), '_dream_context/state/.agent-sessions.json', roster([{ title: 'Phone', bypass: false, minimized: false, size: 1, sessionId: S1, kind: 'chat' }], 'auto'));
      failRoster = true;
      fake.epoch++;
    };
    await expect(returnTrip(env)).rejects.toThrow(/killed in pass 2/);
    expect(read(vault, 'b.txt')).toBe('pass one\n');
    expect(read(vault, 'late.txt')).toBe('pass two\n');
    const rb = await rollbackTrip(env);
    expect(rb.undone.length).toBeGreaterThan(0);
    expect(readTripState(laptopHome).phase).toBe('away');
    expect(read(vault, 'b.txt')).toBe('b1\n');
    expect(existsSync(join(vault, 'late.txt'))).toBe(false);
    expect(readRosterSurface(ctx).sessions.map((x) => x.title)).toEqual(['Kept', 'Closed on phone']);
  });

  it('abandon takes the trip run lock (it never races a running return)', async () => {
    const env = makeEnv();
    const g = await go(env, { contextRoot: ctx });
    const lock = acquireTripRunLock(tripDirOf(g.tripId))!;
    try {
      await expect(abandonTrip(env)).rejects.toMatchObject({ code: 'busy' });
      expect(readTripState(laptopHome).phase).toBe('away');
    } finally {
      lock.release();
    }
  });
});

describe('round 2: D21 finalization never wedges', () => {
  it('a crash during stop after a successful seal ends home on the next Resume', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    put(C(), 'b.txt', 'cloud b\n');
    const onProgress = (e: { step: string }) => { if (e.step === 'stop') throw new Error('killed during stop'); };
    await expect(returnTrip(env, { onProgress })).rejects.toThrow(/killed during stop/);
    expect(fake.phase).toBe('sealed');
    expect(readTripState(laptopHome).phase).toBe('returning');
    const r = await resumeTrip(env);
    expect(r.outcome).toBe('home');
    expect(r.receipt!.finalization).toMatchObject({ secretsWiped: true, sealed: true, stopped: true });
    expect([...provider.machines.values()][0].state).toBe('stopped');
  });

  it('a seal whose reply was lost (it ran) is read from health: done, home', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    fake.loseSealReply = true;
    const r = await returnTrip(env);
    expect(r.outcome).toBe('home');
    expect(r.receipt!.finalization).toMatchObject({ sealed: true, stopped: true, queued: [] });
  });

  it('an unreachable cloud after the local apply: home, the rest queued with its trip id; the next contact finishes it', async () => {
    const env = makeEnv();
    const g = await go(env, { contextRoot: ctx });
    const realHealth = fake.health.bind(fake);
    let down = false;
    // The cloud vanishes exactly when finalization starts.
    fake.beforeWipe = () => { down = true; throw new CloudUnreachableError('down'); };
    fake.health = async () => { if (down) throw new CloudUnreachableError('down'); return realHealth(); };
    const r = await returnTrip(env);
    expect(r.outcome).toBe('home');
    expect(readConfig(laptopHome)!.queued).toMatchObject({ tripId: g.tripId, steps: ['wipe-secrets', 'seal', 'stop'] });
    down = false;
    // The next go meets the queue first: the cloud is still quiescing at that epoch -> sealed, then the new trip.
    await go(env, { contextRoot: ctx });
    expect(readConfig(laptopHome)!.queued ?? null).toBeNull();
  });

  it('a queued finalization of ANOTHER trip is dropped without touching this trip\'s record', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    await returnTrip(env);
    const { updateConfig } = await import('../../src/lib/handsfree/local-store.js');
    await updateConfig(laptopHome, (c) => ({ ...c, queued: { tripId: 't-20260101-deadbeef', epoch: 1, steps: ['wipe-secrets', 'seal', 'stop'], since: new Date().toISOString() } }));
    const before = readConfig(laptopHome)!.lastTrip;
    fake.calls.length = 0;
    provider.machines.forEach((m) => { m.state = 'available'; });
    const g2 = await go(env, { contextRoot: ctx });
    expect(fake.calls.filter((c) => c === 'wipe')).toEqual([]);
    expect(readConfig(laptopHome)!.queued ?? null).toBeNull();
    expect(before?.status).toBe('sealed');
    expect(readConfig(laptopHome)!.lastTrip?.tripId).toBe(g2.tripId);
  });

  it('a sign-in redirect past the client grace is retried until waitHealthy\'s own deadline (slow boot, not a private port)', async () => {
    provider.machines.forEach((m) => { m.state = 'stopped'; });
    fake.privateTimes = 2;
    const g = await go(makeEnv({ healthTimeoutMs: 60_000 }), { contextRoot: ctx });
    expect(g.url).toBe(fake.origin);
  });

  it('pass 2 merges the roster against pass 1\'s merged roster: a tab opened and closed on the phone between passes stays closed', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    put(C(), '_dream_context/state/.agent-sessions.json', roster([
      { title: 'Kept', bypass: true, minimized: false, size: 1, sessionId: S1, kind: 'chat' },
      { title: 'Closed on phone', bypass: false, minimized: false, size: 1, sessionId: S2, kind: 'chat' },
      { title: 'Brief phone tab', bypass: false, minimized: false, size: 1, sessionId: S3, kind: 'chat' },
    ], 'auto'));
    fake.beforeSeal = () => {
      put(C(), '_dream_context/state/.agent-sessions.json', roster([
        { title: 'Kept', bypass: true, minimized: false, size: 1, sessionId: S1, kind: 'chat' },
        { title: 'Closed on phone', bypass: false, minimized: false, size: 1, sessionId: S2, kind: 'chat' },
      ], 'auto'));
      fake.epoch++;
    };
    const r = await returnTrip(env);
    expect(r.receipt!.pass).toBe(2);
    expect(readRosterSurface(ctx).sessions.map((x) => x.sessionId)).toEqual([S1, S2]);
  });

  it('Roll back re-run after a crash once every journal was already archived still restores agreed/ and goes away', async () => {
    const env = makeEnv();
    const g = await go(env, { contextRoot: ctx });
    put(C(), 'b.txt', 'cloud b\n');
    const onProgress = (e: { step: string }) => { if (e.step === 'wipe-secrets') throw new Error('killed'); };
    await expect(returnTrip(env, { onProgress })).rejects.toThrow(/killed/);
    const dir = tripDirOf(g.tripId);
    const agreedBefore = readFileSync(join(dir, 'agreed.before-pass-1', `${rootIdFor(vault)}.git.json`), 'utf8');
    // State after a crash mid-roll-back: marker written, agreed/ not yet restored, the pass journal already undone + archived.
    const { rollbackJournal } = await import('../../src/lib/handsfree/journal.js');
    writeFileSync(join(dir, 'rollback-in-progress'), '1');
    const { gitOpHandlers: gh } = await import('../../src/lib/handsfree/git-apply.js');
    const { fileOpHandlers } = await import('../../src/lib/handsfree/apply.js');
    const { sessionMergeHandlers } = await import('../../src/lib/handsfree/session-merge.js');
    await rollbackJournal(join(dir, 'return-journal.pass-1.json'), {
      ...gh(run, { tripDir: dir }), ...fileOpHandlers({ tripDir: dir }), ...sessionMergeHandlers({ tripDir: dir, roster: { read: readRosterSurface, write: writeMergedRosterSurface } }),
      'root.resweep': { apply: async () => {} }, 'git.base': { apply: async () => {} }, 'dir.ensure': { apply: async () => {} }, 'files.preserve': { apply: async () => {} }, 'git.addWorktree': { apply: async () => {} },
    });
    await rollbackTrip(env);
    expect(readTripState(laptopHome).phase).toBe('away');
    expect(readFileSync(join(dir, 'agreed', `${rootIdFor(vault)}.git.json`), 'utf8')).toBe(agreedBefore);
    expect(existsSync(join(dir, 'rollback-in-progress'))).toBe(false);
    expect(read(vault, 'b.txt')).toBe('b1\n');
  });
});
