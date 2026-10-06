// Hands-free LAPTOP orchestration end to end, in-process: real git in temp dirs, a scratch
// laptop HOME (never the real ~/.dreamcontext), and an in-memory fake cloud behind the
// CloudClient interface that runs the W1 library on a mirror under a second scratch home.
// Cases: setup, go then return (staged/unstaged/untracked/stash/branch, D16 secrets, session
// merge, transcripts, D18 re-sweep), divergence park, per-path conflicts, crash + resume,
// roll back, abandon then recovery (tolerant, merge in progress), trip_lost, epoch_mismatch
// -> second delta return, quota refusal never wedges, the run lock.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { vaultNameForPath, withTripVault } from '../../src/lib/handsfree/global-set.js';
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
import { createFakeCloud, FAKE_CLOUD_VERSION, FAKE_INTEGRITY, fakeRegistry, type FakeCloud } from '../helpers/handsfree-fake-cloud.js';
import { CloudError, CloudUnreachableError, PortPrivateError, manifestDigest, type GitReceiveBody, type CloudClient, type CloudHealth, type CloudPhaseName, type RunningTurn, type SnapshotRoot } from '../../src/lib/handsfree/cloud-client.js';
import { FakeCloudProvider, gitBlobSha, ProviderQuotaError } from '../../src/lib/handsfree/provider.js';
import { PIN_PATH, pinFile } from '../../src/lib/handsfree/npm-pin.js';
import {
  abandonTrip, go, HandsfreeError, resumeTrip, returnTrip, rollbackTrip, setup, status, type HandsfreeEnv,
} from '../../src/lib/handsfree/orchestrator.js';
import { readTripState } from '../../src/lib/handsfree/trip-state.js';
import { readConfig, updateConfig } from '../../src/lib/handsfree/local-store.js';
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
    localVersion: () => FAKE_CLOUD_VERSION, registryFetch: fakeRegistry().fetchImpl,
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
  fake = createFakeCloud({ run, laptopHome, cloudHome, gitenv, scratch: join(root, 'fake') });
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

  it('live Cut (shouldCut): a go already waiting cuts on its next round once the owner chooses Cut', async () => {
    let cuts = 0;
    let busy = true;
    let asked = false;
    const turns: TurnControl = {
      list: async () => (busy ? [{ kind: 'chat', id: 'c1', busy: true }] : []),
      cut: async (_r, o) => { if (o.all) { cuts++; busy = false; } return o.all ? 1 : 0; },
    };
    const waits: string[] = [];
    const env = makeEnv({ turns, waitTimeoutMs: 5_000 });
    const onProgress = (e: { step: string }) => { if (e.step === 'waiting') { waits.push(e.step); asked = true; } };
    await go(env, { contextRoot: ctx, onProgress, shouldCut: () => asked });
    expect(waits).toHaveLength(1);
    expect(cuts).toBe(1);
    expect(readTripState(laptopHome).phase).toBe('away');
  });

  it('a return waiting on the phone reports what runs there in the job shape go uses (running[])', async () => {
    const env = makeEnv({ waitTimeoutMs: 5_000 });
    await go(env, { contextRoot: ctx });
    fake.running = [{ conversationId: 'phone-1', startedAt: 0 }, { conversationId: '', startedAt: 0, pid: 4242, command: 'npm test' }];
    const seen: unknown[] = [];
    const onProgress = (e: { step: string; running?: unknown[] }) => { if (e.step === 'waiting') seen.push(e.running); };
    const r = await returnTrip(env, { onProgress, shouldCut: () => seen.length > 0 });
    expect(r.outcome).toBe('home');
    expect(seen[0]).toEqual([
      { kind: 'chat', id: 'phone-1', busy: true },
      { kind: 'process', id: '4242', busy: true, pid: 4242 },
    ]);
  });

  it('live Cut (shouldCut): a return waiting on running work in the cloud cuts it, then lands', async () => {
    const env = makeEnv({ waitTimeoutMs: 5_000 });
    await go(env, { contextRoot: ctx });
    fake.running = [{ conversationId: 'phone-1', startedAt: 0 }];
    let asked = false;
    const onProgress = (e: { step: string }) => { if (e.step === 'waiting') asked = true; };
    const r = await returnTrip(env, { onProgress, shouldCut: () => asked });
    expect(asked).toBe(true);
    expect(r.outcome).toBe('home');
    expect(fake.calls.indexOf('cut')).toBeGreaterThan(-1);
    expect(fake.calls.indexOf('cut')).toBeLessThan(fake.calls.indexOf('seal'));
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

describe('D25: the cloud runs this laptop\'s exact npm version (AC18), and a setup that fails', () => {
  const PIN = { version: FAKE_CLOUD_VERSION, integrity: FAKE_INTEGRITY };
  const I31 = `sha512-${createHash('sha512').update('0.31.0').digest('base64')}`;
  /** Records every repo write (path list) into provider.calls, with the laptop's phase at that moment. */
  const spyWrites = () => {
    const phases: string[] = [];
    const orig = provider.writeFiles.bind(provider);
    provider.writeFiles = async (f, m) => { phases.push(readTripState(laptopHome).phase); provider.calls.push(`write:${Object.keys(f).join(',')}`); return orig(f, m); };
    return phases;
  };

  it('setup pins the exact version + the registry\'s integrity in the repo and records its blob sha; an unchanged pin is never rewritten', async () => {
    expect(provider.repoFiles.get(PIN_PATH)?.equals(pinFile(PIN))).toBe(true);
    expect(JSON.parse(provider.repoFiles.get(PIN_PATH)!.toString('utf8'))).toEqual(PIN);
    expect(readConfig(laptopHome)!.repo!.fileShas[PIN_PATH]).toBe(gitBlobSha(pinFile(PIN)));
    spyWrites();
    provider.calls = [];
    provider.quotaRefusal = new ProviderQuotaError('quota used up', '2026-11-01T00:00:00.000Z'); // stop the go at the start
    const reg = fakeRegistry();
    await expect(go(makeEnv({ registryFetch: reg.fetchImpl }), { contextRoot: ctx })).rejects.toMatchObject({ code: 'quota' });
    expect(reg.seen).toEqual([FAKE_CLOUD_VERSION]);
    expect(provider.calls.filter((c) => c.startsWith('write:'))).toEqual([]);
  });

  it('a newer laptop version: the go rewrites the pin AFTER the AC19 check, BEFORE the lock and before the machine starts', async () => {
    const phases = spyWrites();
    provider.calls = [];
    provider.quotaRefusal = new ProviderQuotaError('quota used up', '2026-11-01T00:00:00.000Z');
    const env = makeEnv({ localVersion: () => '0.31.0', registryFetch: fakeRegistry({ '0.31.0': I31 }).fetchImpl });
    await expect(go(env, { contextRoot: ctx })).rejects.toMatchObject({ code: 'quota' });
    expect(phases).toEqual(['home']); // never 'going'
    expect(provider.calls.findIndex((c) => c === `write:${PIN_PATH}`)).toBeLessThan(provider.calls.findIndex((c) => c.startsWith('start:')));
    expect(JSON.parse(provider.repoFiles.get(PIN_PATH)!.toString('utf8'))).toEqual({ version: '0.31.0', integrity: I31 });
    expect(readConfig(laptopHome)!.repo!.fileShas[PIN_PATH]).toBe(gitBlobSha(pinFile({ version: '0.31.0', integrity: I31 })));
  });

  it('a version that is not on npm: go refuses BEFORE anything is written or locked, naming the version', async () => {
    spyWrites();
    provider.calls = [];
    const err = await go(makeEnv({ localVersion: () => '0.31.0' }), { contextRoot: ctx }).catch((e) => e);
    expect(err).toMatchObject({ code: 'not_published', detail: { version: '0.31.0' } });
    expect(err.message).toBe('this laptop runs dreamcontext 0.31.0, which is not on npm yet. Publish it (or update this laptop to a published version), then run go again.');
    expect(provider.calls).toEqual([]); // no write, no start, no create
    expect(readTripState(laptopHome).phase).toBe('home');
    expect(existsSync(join(laptopHome, '.dreamcontext', 'handsfree', 'trips'))).toBe(false); // never locked: no trip dir
  });

  it('the registry unreachable (or failing): go and setup refuse with that reason, never a fallback', async () => {
    spyWrites();
    provider.calls = [];
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const e1 = await go(makeEnv({ registryFetch: down }), { contextRoot: ctx }).catch((e) => e);
    expect(e1).toMatchObject({ code: 'registry' });
    expect(e1.message).toMatch(/^the npm registry could not confirm dreamcontext 0\.30\.0 \(the npm registry is unreachable \(fetch failed\)\); nothing was written or started\. Run go again once npm answers\.$/);
    const e500 = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const e2 = await setup(makeEnv({ registryFetch: e500 })).catch((e) => e);
    expect(e2).toMatchObject({ code: 'registry' });
    expect(e2.message).toMatch(/answered 503/);
    expect(provider.calls).toEqual([]);
    expect(readTripState(laptopHome).phase).toBe('home');
  });

  it('setup with an unpublished version refuses before any repo write or machine', async () => {
    spyWrites();
    provider.calls = [];
    const err = await setup(makeEnv({ localVersion: () => '0.31.0' })).catch((e) => e);
    expect(err).toMatchObject({ code: 'not_published' });
    expect(err.message).toMatch(/then run setup again\.$/);
    expect(provider.calls).toEqual([]);
  });

  it('a tampered pin in the repo refuses the go before any start or create, and a newer laptop version never overwrites it first', async () => {
    for (const v of [FAKE_CLOUD_VERSION, '0.31.0']) {
      provider.repoFiles.set(PIN_PATH, Buffer.from('{"version":"0.1.0","integrity":"planted"}\n'));
      provider.calls = [];
      spyWrites();
      const err = await go(makeEnv({ localVersion: () => v, registryFetch: fakeRegistry({ [FAKE_CLOUD_VERSION]: FAKE_INTEGRITY, '0.31.0': I31 }).fetchImpl }), { contextRoot: ctx }).catch((e) => e);
      expect(err).toMatchObject({ code: 'tampered' });
      expect(err.detail.files).toEqual([PIN_PATH]);
      expect(provider.calls.filter((c) => /^(start|create|write):/.test(c))).toEqual([]);
      expect(provider.repoFiles.get(PIN_PATH)!.toString()).toContain('planted'); // reported, not overwritten
      expect(readTripState(laptopHome).phase).toBe('home');
    }
  });

  it('a repo deleted (or emptied) on GitHub: setup rewrites the pin and goes on without a tampered loop', async () => {
    provider.repoFiles.clear();
    const r = await setup(makeEnv());
    expect(r.created).toBe(false);
    expect(JSON.parse(provider.repoFiles.get(PIN_PATH)!.toString('utf8'))).toEqual(PIN);
    expect((await setup(makeEnv())).created).toBe(false);
  });

  it('parity: a cloud on another version gets ONE {version, integrity} request (no upload) and the go waits until it reports that version', async () => {
    fake.version = '0.29.0';
    const g = await go(makeEnv(), { contextRoot: ctx });
    expect(fake.runtimeRequests).toEqual([PIN]);
    expect(fake.version).toBe(FAKE_CLOUD_VERSION);
    expect(fake.tripId).toBe(g.tripId);
  });

  it('parity: a cloud that never comes back on the version fails the go, naming it, and the laptop stays home', async () => {
    fake.version = '0.29.0';
    fake.runtime = async (pin) => { fake.runtimeRequests.push(pin); }; // the install "fails": last good stays
    let clock = Date.now();
    const err = await go(makeEnv({ now: () => clock, sleep: async (ms) => { clock += ms; } }), { contextRoot: ctx }).catch((e) => e);
    expect(err).toMatchObject({ code: 'parity', detail: { version: FAKE_CLOUD_VERSION } });
    expect(err.message).toMatch(/did not come back on dreamcontext 0\.30\.0 within 10 minutes \(it reports 0\.29\.0\)/);
    expect(fake.runtimeRequests).toHaveLength(1);
    expect(readTripState(laptopHome).phase).toBe('home');
  });

  it('setup re-creates a codespace that never became healthy and never held a trip; when health still fails it stops the machine and names the failed step and the next step', async () => {
    const old = readConfig(laptopHome)!.codespace!.name;
    expect(readConfig(laptopHome)!.codespace!.healthyAt).toBeTruthy();
    // The smoke-#1 machine: created before the bootstrap existed, never healthy, no trip.
    await updateConfig(laptopHome, (c) => ({ ...c, codespace: { ...c.codespace!, healthyAt: undefined } }));
    provider.calls = [];
    const down = new Proxy(fake, { get: (t, p) => (p === 'publicHealth' ? async () => { throw new CloudUnreachableError('the cloud is not answering'); } : Reflect.get(t, p)) });
    const err = await setup(makeEnv({ connect: () => down as CloudClient })).catch((e) => e);
    expect(err).toBeInstanceOf(HandsfreeError);
    expect(err.message).toMatch(/^setup failed while starting the codespace and waiting for its health: /);
    expect(err.message).toMatch(/was stopped \(no machine is left running\)/);
    expect(err.message).toMatch(/Next: run `dreamcontext handsfree setup` again/);
    expect(err.detail).toMatchObject({ step: 'start', stopped: true });
    const fresh = readConfig(laptopHome)!.codespace!.name;
    expect(provider.calls[0]).toBe(`delete:${old}`);
    expect(provider.calls).toContain(`stop:${fresh}`);
    expect(provider.machines.has(old)).toBe(false);
    expect(provider.machines.get(fresh)!.state).toBe('stopped');
    expect(readConfig(laptopHome)!.codespace!.healthyAt).toBeUndefined();

    // The re-run with a healthy cloud heals it (re-created again: it never answered health).
    provider.calls = [];
    const ok = await setup(makeEnv());
    expect(ok.created).toBe(true);
    expect(provider.calls[0]).toBe(`delete:${fresh}`);
    expect(readConfig(laptopHome)!.codespace!.healthyAt).toBeTruthy();
    expect([...provider.machines.values()].map((m) => m.state)).toEqual(['stopped']);
  });

  it('a codespace that ever held a trip is never deleted by setup, healthy or not', async () => {
    const name = readConfig(laptopHome)!.codespace!.name;
    await updateConfig(laptopHome, (c) => ({ ...c, codespace: { ...c.codespace!, healthyAt: undefined }, lastTrip: { tripId: 't-20261004-aaaaaaaa', status: 'sealed', at: new Date().toISOString() } }));
    provider.calls = [];
    const r = await setup(makeEnv());
    expect(r.created).toBe(false);
    expect(provider.calls.some((c) => c.startsWith('delete:'))).toBe(false);
    expect(provider.machines.has(name)).toBe(true);
  });
});

describe('smoke #3: AC3 a CLI go registers its project; AC23 the own uptime count', () => {
  const vaultsOf = (home: string) => {
    try { return JSON.parse(readFileSync(join(home, '.dreamcontext', 'vaults.json'), 'utf8')).vaults as Array<{ name: string; path: string }>; } catch { return []; }
  };

  it('a go from a project the laptop never registered registers it (as Add Project does) BEFORE the global set is staged', async () => {
    expect(vaultsOf(laptopHome)).toEqual([]);
    const g = await go(makeEnv(), { contextRoot: ctx });
    expect(vaultsOf(laptopHome)).toEqual([{ name: 'app', path: vault }]);
    // The staged (one-way) global set carries it, so the cloud's registry names it.
    const staged = JSON.parse(readFileSync(join(tripDirOf(g.tripId), 'go', 'global', '.dreamcontext', 'vaults.json'), 'utf8')).vaults;
    expect(staged).toEqual([{ name: 'app', path: vault }]);
  });

  it('a CLI go from a Turkish folder (ğ ş ı İ) registers an ASCII, header-safe name, the one `vaults scan` gives; the cloud rule agrees', async () => {
    const tr = join(laptopHome, 'projects', 'Tilki Öğretmen İşleri');
    renameSync(vault, tr);
    const g = await go(makeEnv(), { contextRoot: join(tr, '_dream_context') });
    expect(vaultsOf(laptopHome)).toEqual([{ name: 'tilki-ogretmen-isleri', path: tr }]);
    const name = vaultsOf(laptopHome)[0].name;
    // The SPA sends it in X-Dreamcontext-Vault: a browser refuses any header char above U+00FF.
    expect([...name].every((c) => c.charCodeAt(0) <= 0x7e)).toBe(true);
    expect(() => new Headers({ 'X-Dreamcontext-Vault': name })).not.toThrow();
    const staged = JSON.parse(readFileSync(join(tripDirOf(g.tripId), 'go', 'global', '.dreamcontext', 'vaults.json'), 'utf8')).vaults;
    expect(staged).toEqual([{ name: 'tilki-ogretmen-isleri', path: tr }]);
    // The cloud worker (registerTripVault) names the same path the same way.
    expect(withTripVault(undefined, tr, (a, b) => a === b)!.vaults).toEqual([{ name: 'tilki-ogretmen-isleri', path: tr }]);
    expect(vaultNameForPath(tr)).toBe(name);
  });

  it('an already-registered non-ASCII name is kept (never renamed); an all-symbol name falls back to "vault"', async () => {
    const tr = join(laptopHome, 'projects', 'Tilki Öğretmen');
    renameSync(vault, tr);
    mkdirSync(join(laptopHome, '.dreamcontext'), { recursive: true });
    writeFileSync(join(laptopHome, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'Tilki Öğretmen', path: tr }] }));
    await go(makeEnv(), { contextRoot: join(tr, '_dream_context') });
    expect(vaultsOf(laptopHome)).toEqual([{ name: 'Tilki Öğretmen', path: tr }]);
    expect(vaultNameForPath('/Users/x/日本語')).toBe('vault');
    expect(vaultNameForPath('/Users/x/İzmir.Şube:ığ')).toBe('izmir-sube-ig');
  });

  it('a project already registered keeps its name (idempotent by path); a taken name gets -2', async () => {
    mkdirSync(join(laptopHome, '.dreamcontext'), { recursive: true });
    const other = join(laptopHome, 'projects', 'other-app');
    mkdirSync(join(other, '_dream_context'), { recursive: true });
    writeFileSync(join(laptopHome, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'app', path: other }] }));
    await go(makeEnv(), { contextRoot: ctx });
    expect(vaultsOf(laptopHome)).toEqual([{ name: 'app', path: other }, { name: 'app-2', path: vault }]);
    await returnTrip(makeEnv());
    await go(makeEnv(), { contextRoot: ctx });
    expect(vaultsOf(laptopHome)).toEqual([{ name: 'app', path: other }, { name: 'app-2', path: vault }]);
  });

  // Fixed mid-month times: the count is per calendar month.
  const d = new Date();
  const T0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15, 6);
  const H = 60 * 60_000;
  const iso = (t: number) => new Date(t).toISOString();
  const used = () => readConfig(laptopHome)!.uptime;

  it('a machine that stopped itself: the count closes at GitHub\'s state change (updated_at), not at last_used_at', async () => {
    const name = readConfig(laptopHome)!.codespace!.name;
    await updateConfig(laptopHome, (c) => ({ ...c, uptime: { period: used().period, coreMinutes: 0, runningSince: T0 } }));
    const m = provider.machines.get(name)!;
    Object.assign(m, { state: 'stopped', rawState: 'Shutdown', lastUsedAt: iso(T0 + 60_000), updatedAt: iso(T0 + 3 * H) });
    await status(makeEnv({ now: () => T0 + 5 * H }));
    // basicLinux32gb = 2 cores, up 3 h: 360 core-minutes (last_used_at alone gave 2).
    expect(used()).toMatchObject({ runningSince: null });
    expect(Math.round(used().coreMinutes)).toBe(360);
  });

  it('a machine running that the laptop did not start (the phone\'s Wake, a manual start) is counted from its start', async () => {
    const name = readConfig(laptopHome)!.codespace!.name;
    await updateConfig(laptopHome, (c) => ({ ...c, uptime: { period: used().period, coreMinutes: 0, runningSince: null } }));
    const m = provider.machines.get(name)!;
    Object.assign(m, { state: 'available', rawState: 'Available', lastUsedAt: iso(T0), updatedAt: iso(T0) });
    await status(makeEnv({ now: () => T0 + H }));
    expect(used().runningSince).toBe(T0);
    Object.assign(m, { state: 'stopped', rawState: 'Shutdown', updatedAt: iso(T0 + 2 * H) });
    await status(makeEnv({ now: () => T0 + 4 * H }));
    expect(Math.round(used().coreMinutes)).toBe(240);
  });

  it('a go that finds the machine stopped itself closes the old count first: the stopped hours are not counted', async () => {
    const name = readConfig(laptopHome)!.codespace!.name;
    await updateConfig(laptopHome, (c) => ({ ...c, uptime: { period: used().period, coreMinutes: 0, runningSince: T0 } }));
    const m = provider.machines.get(name)!;
    Object.assign(m, { state: 'stopped', rawState: 'Shutdown', lastUsedAt: iso(T0), updatedAt: iso(T0 + H) });
    let t = T0 + 10 * H;
    provider.quotaRefusal = new ProviderQuotaError('quota used up', '2026-11-01T00:00:00.000Z'); // stop the go at the start
    await expect(go(makeEnv({ now: () => t }), { contextRoot: ctx })).rejects.toMatchObject({ code: 'quota' });
    expect(Math.round(used().coreMinutes)).toBe(120); // 1 h x 2 cores, not 10 h
    expect(used().runningSince).toBeNull();
  });
});

describe('smoke #4: GitHub\'s own cold start is waited for before the 5-minute health deadline', () => {
  const MIN = 60_000;
  let t: number;
  let startAt: number | null;
  /** The machine's state by minutes since the start request: [untilMin, state, rawState][]. */
  let plan: Array<[number, 'starting' | 'available' | 'stopped' | 'other', string]>;
  let healthNever: boolean;
  let events: Array<{ step: string; detail?: string; t: number }>;
  /** What GitHub reports BEFORE the start (r13: never judged). */
  let preStart: readonly ['stopped' | 'other', string];

  beforeEach(() => {
    t = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 15, 6);
    startAt = null;
    preStart = ['stopped', 'Shutdown'];
    healthNever = false;
    events = [];
    const name = readConfig(laptopHome)!.codespace!.name;
    const stateNow = () => {
      if (startAt === null) return preStart;
      const el = (t - startAt) / MIN;
      for (const [until, st, raw] of plan) if (el < until) return [st, raw] as const;
      const last = plan[plan.length - 1];
      return [last[1], last[2]] as const;
    };
    provider.start = async (n: string) => { provider.calls.push(`start:${n}`); startAt = t; };
    const realGet = provider.get.bind(provider);
    provider.get = async (n: string) => {
      const m = await realGet(n);
      if (!m || n !== name) return m;
      const [state, rawState] = stateNow();
      return { ...m, state, rawState };
    };
  });
  /** Health through the forwarder: 404 until GitHub says the machine is available (smoke #4). */
  const gated = () => new Proxy(fake, {
    get: (target, p) => (p === 'publicHealth'
      ? async () => {
        const m = await provider.get(readConfig(laptopHome)!.codespace!.name);
        if (healthNever || m?.state !== 'available') throw new CloudError(404, 'not_found', 'GET /api/health failed (404)');
        return target.publicHealth();
      }
      : Reflect.get(target, p)),
  }) as unknown as CloudClient;
  const env = () => makeEnv({ now: () => t, sleep: async (ms: number) => { t += ms; }, healthTimeoutMs: 5 * MIN, connect: () => gated() });
  const goNow = () => go(env(), { contextRoot: ctx, onProgress: (e) => events.push({ ...e, t }) });

  it('(a) a start that stays "starting" for 8 minutes, then available and healthy, succeeds; (e) one progress line a minute at most', async () => {
    plan = [[8, 'starting', 'Starting'], [Infinity, 'available', 'Available']];
    const g = await goNow();
    expect(fake.tripId).toBe(g.tripId);
    expect(readTripState(laptopHome).phase).toBe('away');
    const notes = events.filter((e) => e.step === 'start' && /still starting the machine/.test(e.detail ?? ''));
    expect(notes.length).toBeGreaterThanOrEqual(7);
    expect(notes.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < notes.length; i++) expect(notes[i].t - notes[i - 1].t).toBeGreaterThanOrEqual(MIN);
    expect(notes[0].detail).toBe('GitHub is still starting the machine (1 min)…');
  });

  it('(b) still "starting" after 15 minutes: the start-phase message, and the count stays open (it keeps starting)', async () => {
    plan = [[Infinity, 'starting', 'Starting']];
    const err = await goNow().catch((e) => e);
    expect(err).toMatchObject({ code: 'cloud', detail: { phase: 'start' } });
    expect(err.message).toBe('GitHub did not finish starting the machine within 15 minutes (it is still Starting). It keeps starting: run the same command again.');
    expect(t - startAt!).toBeGreaterThanOrEqual(15 * MIN);
    expect(t - startAt!).toBeLessThan(15 * MIN + 10_000);
    expect(readConfig(laptopHome)!.uptime.runningSince).toBe(startAt);
    expect(readTripState(laptopHome).phase).toBe('home');
  });

  it('(c) a machine that goes back to stopped fails at once (not at the timeout) and its count is closed', async () => {
    plan = [[1, 'starting', 'Starting'], [Infinity, 'stopped', 'Shutdown']];
    const err = await goNow().catch((e) => e);
    expect(err).toMatchObject({ code: 'cloud', detail: { phase: 'start', state: 'Shutdown' } });
    expect(err.message).toMatch(/^GitHub stopped starting the machine \(it is Shutdown\)\. Run the same command again/);
    expect(t - startAt!).toBeLessThan(2 * MIN);
    expect(readConfig(laptopHome)!.uptime.runningSince).toBeNull();
    // A failed machine ('other') too.
    startAt = null;
    plan = [[Infinity, 'other', 'Failed']];
    const err2 = await goNow().catch((e) => e);
    expect(err2.message).toMatch(/^GitHub stopped starting the machine \(it is Failed\)/);
  });

  it('(f) r13: a pre-start reading of Archived or Unknown is never judged: start accepted, starting, then available succeeds', async () => {
    for (const raw of ['Archived', 'Unknown']) {
      preStart = ['other', raw];
      startAt = null;
      plan = [[2, 'starting', 'Starting'], [Infinity, 'available', 'Available']];
      if (readTripState(laptopHome).phase === 'away') await returnTrip(env());
      const g = await goNow();
      expect(fake.tripId).toBe(g.tripId);
      expect(startAt).not.toBeNull();
      expect(t - startAt!).toBeGreaterThanOrEqual(2 * MIN);
    }
  });

  it('(g) r13: Failed after the start still fails at once, and its uptime count is closed', async () => {
    plan = [[Infinity, 'other', 'Failed']];
    const err = await goNow().catch((e) => e);
    expect(err).toMatchObject({ code: 'cloud', detail: { phase: 'start', state: 'Failed', neverRan: true } });
    expect(err.message).toMatch(/^GitHub stopped starting the machine \(it is Failed\)/);
    expect(t - startAt!).toBeLessThan(10_000);
    expect(readConfig(laptopHome)!.uptime.runningSince).toBeNull();
  });

  it('(h) r13: a transient Updating for 3 minutes, then available, succeeds (only Failed/Deleted are terminal)', async () => {
    plan = [[3, 'other', 'Updating'], [Infinity, 'available', 'Available']];
    const g = await goNow();
    expect(fake.tripId).toBe(g.tripId);
    expect(t - startAt!).toBeGreaterThanOrEqual(3 * MIN);
  });

  it('(d) available but its server never answers: the server-phase message, 5 minutes counted from "available"', async () => {
    plan = [[3, 'starting', 'Starting'], [Infinity, 'available', 'Available']];
    healthNever = true;
    const err = await goNow().catch((e) => e);
    expect(err).toMatchObject({ code: 'cloud', detail: { phase: 'health' } });
    expect(err.message).toBe('the machine started but its server did not answer within 5 minutes (GET /api/health failed (404)). It keeps running: run the same command again.');
    const availableAt = startAt! + 3 * MIN;
    expect(t).toBeGreaterThanOrEqual(availableAt + 5 * MIN);
    expect(t).toBeLessThan(availableAt + 5 * MIN + 15_000);
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

describe('round 3: D23 guarded phase + cut before snapshot', () => {
  it('a pass-2 cancel (cloud preflight) after pass 1 wrote goes HOME with pass 1\'s receipt: never away, no Abandon', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    put(C(), 'b.txt', 'pass one\n');
    fake.beforeSeal = () => { put(C(), 'late.txt', 'later\n'); fake.epoch++; fake.preflightProblem = 'MERGE_HEAD is in progress'; };
    const r = await returnTrip(env);
    expect(r.outcome).toBe('home');
    expect(r.receipt!.pass).toBe(1);
    expect(read(vault, 'b.txt')).toBe('pass one\n');
    expect(readTripState(laptopHome).phase).toBe('home');
    expect(readConfig(laptopHome)!.lastTrip).toMatchObject({ status: 'abandoned', recovered: false });
  });

  it('a pass-1 cancel (nothing written) goes back to away and the cloud is unquiesced', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    fake.preflightProblem = 'stale lock';
    await expect(returnTrip(env)).rejects.toMatchObject({ code: 'cloud_preflight' });
    expect(readTripState(laptopHome).phase).toBe('away');
    expect(fake.calls).toContain('unquiesce');
  });

  it('Cut: POST cut runs before the snapshot even when quiesce reports nothing running; a 409 turns_running is cut then retried', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    fake.liveProcesses = 1;
    const r = await returnTrip(env, { cutRunning: true });
    expect(r.outcome).toBe('home');
    expect(fake.calls.indexOf('cut')).toBeGreaterThan(-1);
    expect(fake.calls.indexOf('cut')).toBeLessThan(fake.calls.indexOf('seal'));
  });

  it('without Cut, a 409 turns_running before any write cancels back to away', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    fake.liveProcesses = 1;
    await expect(returnTrip(env)).rejects.toMatchObject({ code: 'turns_running' });
    expect(readTripState(laptopHome).phase).toBe('away');
  });

  it('the guarded transition refuses returning -> away and a plain home once a return wrote', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    put(C(), 'b.txt', 'cloud b\n');
    const onProgress = (e: { step: string }) => { if (e.step === 'wipe-secrets') throw new Error('killed'); };
    await expect(returnTrip(env, { onProgress })).rejects.toThrow(/killed/);
    await expect(abandonTrip(env)).rejects.toMatchObject({ code: 'write_started' });
    expect(readTripState(laptopHome).phase).toBe('returning');
  });

  it('finalize "other" (the cloud holds another trip) is not recorded as sealed and queues stop', async () => {
    const env = makeEnv();
    const g = await go(env, { contextRoot: ctx });
    fake.beforeWipe = () => { fake.tripId = 't-20990101-0ther000'; throw new CloudError(409, 'trip_mismatch', 'other'); };
    const r = await returnTrip(env);
    expect(r.outcome).toBe('home');
    expect(r.receipt!.finalization).toEqual({ secretsWiped: false, sealed: false, stopped: false, queued: ['stop'] });
    expect(readConfig(laptopHome)!.lastTrip).toMatchObject({ tripId: g.tripId, status: 'abandoned', recovered: false });
    expect(readConfig(laptopHome)!.queued).toMatchObject({ tripId: g.tripId, steps: ['stop'] });
  });
});

describe('wave 3 round-trip findings (lane I r2, items 2-6)', () => {
  const evilBranch = () => {
    const blob = (data: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: C(), env: gitenv, input: data, encoding: 'utf8' }).trim();
    const mktree = (entries: Array<[string, string, string]>) => execFileSync('git', ['mktree'], {
      cwd: C(), env: gitenv, input: entries.map(([m, o, n]) => `${m} ${m === '040000' ? 'tree' : 'blob'} ${o}\t${n}`).join('\n') + '\n', encoding: 'utf8',
    }).trim();
    const evil = mktree([['040000', mktree([['100644', blob('[core]\n'), 'config']]), '.GIT']]);
    const commit = sh(C(), 'commit-tree', evil, '-m', 'evil').trim();
    sh(C(), 'update-ref', 'refs/heads/evil', commit);
  };

  it('(a) AC9: the gitlink refusal names the repository, the path and how to resolve it', async () => {
    const lib = join(vault, 'vendor', 'lib');
    mkdirSync(lib, { recursive: true });
    sh(lib, 'init', '-q');
    put(lib, 'x.txt', 'x\n');
    sh(lib, 'add', '.');
    sh(lib, 'commit', '-qm', 'lib');
    sh(vault, 'add', 'vendor/lib');
    const err = await go(makeEnv(), { contextRoot: ctx }).catch((e) => e);
    expect(err).toMatchObject({ code: 'preflight' });
    expect(err.message).toContain(vault);
    expect(err.message).toContain('vendor/lib');
    expect(err.message).toMatch(/\.gitignore/);
    expect(readTripState(laptopHome).phase).toBe('home');
  });

  it('(b) AC13: a cloud commit carrying a .git path cancels the Return back to away (cloud active), names repo + path, never loops; the phone\'s fix then returns', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    evilBranch();
    const err = await returnTrip(env).catch((e) => e);
    expect(err).toMatchObject({ code: 'cloud_content' });
    expect(err.message).toContain(vault);
    expect(err.message).toContain('.GIT/config');
    expect(readTripState(laptopHome).phase).toBe('away');
    expect(fake.phase).toBe('active');
    expect(fake.calls).toContain('unquiesce');
    // Retrying is the same clean cancel, never a stuck `returning`.
    await expect(returnTrip(env)).rejects.toMatchObject({ code: 'cloud_content' });
    expect(readTripState(laptopHome).phase).toBe('away');
    // The phone removes the bad commit: the Return now lands.
    sh(C(), 'update-ref', '-d', 'refs/heads/evil');
    const r = await returnTrip(env);
    expect(r.outcome).toBe('home');
  });

  it('(c) the same content never wedges a later go: recovery parks what it can, names the refused ref + path, and the new trip starts', async () => {
    const env = makeEnv();
    const g1 = await go(env, { contextRoot: ctx });
    put(C(), 'c.txt', 'cloud\n');
    sh(C(), 'add', 'c.txt');
    sh(C(), 'commit', '-qm', 'good cloud commit');
    const good = sh(C(), 'rev-parse', 'HEAD').trim();
    evilBranch();
    provider.machines.forEach((m) => { m.state = 'available'; });
    await abandonTrip(env);
    const g2 = await go(env, { contextRoot: ctx });
    expect(g2.recovery?.oldTrip).toBe(g1.tripId);
    expect(g2.recovery?.refused).toEqual([expect.objectContaining({ repo: vault, refs: ['refs/heads/evil'], paths: expect.arrayContaining(['.GIT/config']) })]);
    expect(sh(vault, 'rev-parse', `refs/handsfree/${g1.tripId}/heads/main`).trim()).toBe(good);
    expect(readTripState(laptopHome).phase).toBe('away');
  });

  it('(d)(a) trip_lost with the roots on disk: the full D12 recovery parks the phone work (refs + orphaned, secrets backed up) BEFORE the seal; the next go starts', async () => {
    const env = makeEnv();
    const g1 = await go(env, { contextRoot: ctx });
    put(C(), 'src/lost.ts', 'export const lost = 1;\n');
    sh(C(), 'add', 'src/lost.ts');
    sh(C(), 'commit', '-qm', 'phone: work on a machine that loses its marker');
    const phoneCommit = sh(C(), 'rev-parse', 'HEAD').trim();
    put(C(), '.env', 'TOKEN=phone\n');
    put(C(), '_dream_context/state/notes.md', 'phone note\n');
    fake.lost = true;
    const r = await returnTrip(env);
    expect(r.outcome).toBe('lost');
    expect(r.message).toMatch(/recovered into refs\/handsfree\//);
    expect(readTripState(laptopHome).phase).toBe('home');
    // Parked locally: the phone commit, and the files (secret class included) in orphaned/.
    expect(sh(vault, 'rev-parse', `refs/handsfree/${g1.tripId}/heads/main`).trim()).toBe(phoneCommit);
    const orphan = join(tripDirOf(g1.tripId), 'orphaned', rootIdFor(vault));
    expect(read(orphan, '.env')).toBe('TOKEN=phone\n');
    expect(read(orphan, '_dream_context/state/notes.md')).toBe('phone note\n');
    // The order: snapshot, then the seal (which wipes the secret class).
    expect(fake.calls.lastIndexOf('snapshot')).toBeGreaterThan(-1);
    expect(fake.calls.lastIndexOf('snapshot')).toBeLessThan(fake.calls.lastIndexOf('seal'));
    expect(fake.phase).toBe('sealed');
    expect(existsSync(join(C(), '.env'))).toBe(false);
    expect(readConfig(laptopHome)!.lastTrip).toMatchObject({ tripId: g1.tripId, status: 'lost', recovered: true });
    expect([...provider.machines.values()][0].state).toBe('stopped');
    const g2 = await go(env, { contextRoot: ctx });
    expect(g2.tripId).not.toBe(g1.tripId);
    expect(readTripState(laptopHome).phase).toBe('away');
  });

  it('(d)(b) trip_lost with the roots ABSENT: no seal, no wipe, the trip stays unrecovered, and the next go refuses with the teardown way out (never mirrors over it)', async () => {
    const env = makeEnv();
    const g1 = await go(env, { contextRoot: ctx });
    put(C(), '.env', 'TOKEN=phone\n');
    fake.lost = true;
    fake.mirrorAbsent = true;
    const r = await returnTrip(env);
    expect(r.outcome).toBe('lost');
    expect(r.message).toMatch(/teardown --discard-abandoned-work/);
    expect(readTripState(laptopHome).phase).toBe('home');
    expect(fake.calls).not.toContain('seal');
    expect(fake.calls).not.toContain('wipe');
    expect(fake.phase).not.toBe('sealed');
    expect(read(C(), '.env')).toBe('TOKEN=phone\n');
    expect(readConfig(laptopHome)!.lastTrip).toMatchObject({ tripId: g1.tripId, recovered: false });
    const callsBefore = fake.calls.length;
    const err = await go(env, { contextRoot: ctx }).catch((e) => e);
    expect(err).toMatchObject({ code: 'needs_recovery' });
    expect(err.message).toMatch(/teardown --discard-abandoned-work/);
    expect(readTripState(laptopHome).phase).toBe('home');
    expect(fake.calls.slice(callsBefore)).not.toContain('trip'); // nothing mirrored over it
    expect(fake.calls).not.toContain('seal');
    expect(readConfig(laptopHome)!.lastTrip).toMatchObject({ tripId: g1.tripId, recovered: false });
  });

  it('(d) an older cloud that cannot snapshot a lost-marker trip: never sealed, the later go refuses HOME with the teardown way out', async () => {
    const env = makeEnv();
    await go(env, { contextRoot: ctx });
    fake.lost = true;
    fake.oldCloudNoLostRecovery = true;
    const r = await returnTrip(env);
    expect(r.outcome).toBe('lost');
    expect(fake.calls).not.toContain('seal');
    const err = await go(env, { contextRoot: ctx }).catch((e) => e);
    expect(err).toMatchObject({ code: 'needs_recovery' });
    expect(err.message).toMatch(/teardown --discard-abandoned-work/);
    expect(readTripState(laptopHome).phase).toBe('home');
    expect([...provider.machines.values()][0].state).toBe('stopped');
  });

  it('(d) an ABANDONED trip whose marker the cloud lost is recovered (parked) and sealed by the next go, which then starts', async () => {
    const env = makeEnv();
    const g1 = await go(env, { contextRoot: ctx });
    put(C(), 'phone.txt', 'phone\n');
    sh(C(), 'add', 'phone.txt');
    sh(C(), 'commit', '-qm', 'phone work');
    const phoneCommit = sh(C(), 'rev-parse', 'HEAD').trim();
    provider.machines.forEach((m) => { m.state = 'stopped'; });
    await abandonTrip(env); // machine stopped: the cloud stays active, nothing sealed
    fake.lost = true;
    const g2 = await go(env, { contextRoot: ctx });
    expect(g2.recovery).toMatchObject({ oldTrip: g1.tripId, lost: true, sealed: true });
    expect(sh(vault, 'rev-parse', `refs/handsfree/${g1.tripId}/heads/main`).trim()).toBe(phoneCommit);
    expect(readTripState(laptopHome).phase).toBe('away');
  });

  it('(e) paths differing only by Unicode normalization or case are refused at the preflight, naming both', async () => {
    const nfc = 'café.txt';
    const nfd = 'café.txt';
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: vault, env: gitenv, input: 'x\n', encoding: 'utf8' }).trim();
    // As a commit made on Linux brings them: both spellings in the index (precompose off to add).
    sh(vault, '-c', 'core.precomposeunicode=false', 'update-index', '--add', '--cacheinfo', `100644,${oid},${nfc}`);
    sh(vault, '-c', 'core.precomposeunicode=false', 'update-index', '--add', '--cacheinfo', `100644,${oid},${nfd}`);
    sh(vault, 'update-index', '--add', '--cacheinfo', `100644,${oid},Readme.txt`);
    sh(vault, 'update-index', '--add', '--cacheinfo', `100644,${oid},README.TXT`);
    const err = await go(makeEnv(), { contextRoot: ctx }).catch((e) => e);
    expect(err).toMatchObject({ code: 'preflight' });
    expect(err.message.normalize('NFC')).toContain(nfc);
    expect(err.message).toMatch(/Readme\.txt" and "README\.TXT"|README\.TXT" and "Readme\.txt"/);
    expect(readTripState(laptopHome).phase).toBe('home');
  });

  it('(e) a post-lock verification failure (AC2 equality) goes home through the guarded transition, never stays going', async () => {
    const env = makeEnv();
    const real = fake.gitReceive.bind(fake);
    fake.gitReceive = async (b) => ({ ...(await real(b)), snapshotId: 'f'.repeat(64) });
    await expect(go(env, { contextRoot: ctx })).rejects.toMatchObject({ code: 'equality' });
    expect(readTripState(laptopHome).phase).toBe('home');
    expect([...provider.machines.values()][0].state).toBe('stopped');
    expect(fake.phase).not.toBe('active');
    // The next go mirrors again and succeeds.
    fake.gitReceive = real;
    await go(env, { contextRoot: ctx });
    expect(readTripState(laptopHome).phase).toBe('away');
  });
});
