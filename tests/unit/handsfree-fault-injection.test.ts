// D23 (c): a fault-injection walk over go and Return (single pass and multi-pass).
//
// The injection points are GENERATED, never listed by hand: a recording run of each scenario
// labels every journal op (the env's beforeOp hook) and every cloud-client and provider call
// (proxies), in order. Each label then becomes test cases:
//   - a journal op:      a process crash, followed by Resume with the cloud unreachable, and
//                        (separately) a crash followed by Roll back;
//   - a cloud call:      a crash, a network failure, a stopped codespace (for a client call a
//                        quota refusal cannot be an answer: GitHub's quota acts on the provider);
//   - a provider call:   a crash, a network failure, a quota refusal, a stopped codespace.
// After each injection: the phase is never away after a return write; Abandon is never offered
// after a write; Resume with the cloud and GitHub unreachable reaches home, or Roll back stays
// available (never a state with neither); Roll back restores the pre-return laptop byte for
// byte (files incl. ignored brain state and the roster, refs, stash, HEAD); no retry rewrites an
// earlier pass's journal or truncates a backup ledger. The shared D21 fake cloud rules apply.
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpawnRunner, type ProcessRunner } from '../../src/lib/handsfree/git-snapshot.js';
import { CloudUnreachableError, type CloudClient } from '../../src/lib/handsfree/cloud-client.js';
import { FakeCloudProvider, ProviderError, ProviderQuotaError, type CloudProvider } from '../../src/lib/handsfree/provider.js';
import { abandonTrip, go, resumeTrip, returnTrip, rollbackTrip, setup, status, type HandsfreeEnv } from '../../src/lib/handsfree/orchestrator.js';
import { readTripState } from '../../src/lib/handsfree/trip-state.js';
import { journalStatus, loadJournal, tripDir, type JournalOp } from '../../src/lib/handsfree/journal.js';
import { NO_TURNS } from '../../src/lib/handsfree/turns.js';
import { encodeProjectDir } from '../../src/lib/handsfree/manifest.js';
import { readRosterSurface, writeMergedRosterSurface } from '../../src/server/routes/agent-sessions.js';
import { createFakeCloud, FAKE_CLOUD_VERSION, fakeRegistry, type FakeCloud } from '../helpers/handsfree-fake-cloud.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

type Scenario = 'go' | 'return-single' | 'return-multi';
type Kind = 'crash' | 'crash-rollback' | 'network' | 'quota' | 'stopped';

class SimulatedCrash extends Error {
  constructor(label: string) { super(`simulated process crash at ${label}`); this.name = 'SimulatedCrash'; }
}

const CLIENT_METHODS = [
  'publicHealth', 'health', 'uploadFile', 'downloadTo', 'verifiers', 'revokeAll', 'runtime', 'trip', 'state', 'gitReceive', 'filesReceive',
  'global', 'activate', 'quiesce', 'cut', 'unquiesce', 'snapshot', 'wipeSecrets', 'seal', 'accounts',
] as const;
const PROVIDER_METHODS = ['create', 'start', 'stop', 'delete', 'get', 'remainingQuotaCoreMinutes', 'machineTypes', 'ensure', 'writeFiles', 'blobShas'] as const;

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

interface Case {
  root: string;
  laptopHome: string;
  cloudHome: string;
  vault: string;
  ctx: string;
  run: ProcessRunner;
  gitenv: Record<string, string>;
  fake: FakeCloud;
  provider: FakeCloudProvider;
  /** Every labelled call, in order, while instrumentation is on. */
  labels: string[];
  instrument: boolean;
  target: { label: string; kind: Kind } | null;
  /** Once true, the cloud and GitHub cannot be reached at all. */
  unreachable: boolean;
  env(): HandsfreeEnv;
}

const roster = (sessions: Array<Record<string, unknown>>, mode: 'auto' | 'bypass') => JSON.stringify({ sessions, chatPermissionMode: mode }, null, 2);

function put(base: string, rel: string, data: string): void {
  mkdirSync(join(base, rel, '..'), { recursive: true });
  writeFileSync(join(base, rel), data);
}

function injectError(c: Case, label: string, kind: Kind, where: 'client' | 'provider' | 'op'): Error {
  if (kind === 'crash' || kind === 'crash-rollback') return new SimulatedCrash(label);
  if (kind === 'quota') return new ProviderQuotaError('quota used up (injected)', '2026-11-01T00:00:00.000Z');
  if (kind === 'stopped') {
    c.unreachable = true;
    c.provider.machines.forEach((m) => { m.state = 'stopped'; m.rawState = 'Shutdown'; });
    return where === 'provider' ? new ProviderError('the codespace is stopped (injected)') : new CloudUnreachableError('the codespace is stopped (injected)');
  }
  return where === 'provider' ? new ProviderError('network down (injected)') : new CloudUnreachableError('network down (injected)');
}

/** Count + match a label; throws the injected fault when it is the target. */
function hit(c: Case, base: string, where: 'client' | 'provider' | 'op'): void {
  if (!c.instrument) return;
  const n = c.labels.filter((l) => l.startsWith(base + '#')).length + 1;
  const label = `${base}#${n}`;
  c.labels.push(label);
  if (c.target && c.target.label === label) {
    const kind = c.target.kind;
    c.target = null; // one injection per case
    throw injectError(c, label, kind, where);
  }
}

function wrapClient(c: Case): CloudClient {
  return new Proxy(c.fake as unknown as CloudClient, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function' || !(CLIENT_METHODS as readonly string[]).includes(String(prop))) return v;
      return async (...args: unknown[]) => {
        if (c.unreachable) throw new CloudUnreachableError('the cloud cannot be reached');
        hit(c, `client.${String(prop)}`, 'client');
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function wrapProvider(c: Case): CloudProvider & FakeCloudProvider {
  return new Proxy(c.provider, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function' || !(PROVIDER_METHODS as readonly string[]).includes(String(prop))) return v;
      return async (...args: unknown[]) => {
        if (c.unreachable) {
          if (prop === 'get') return (v as (...a: unknown[]) => unknown).apply(target, args); // GitHub may answer "stopped"…
          throw prop === 'start' || prop === 'create' ? new ProviderQuotaError('quota used up', '2026-11-01T00:00:00.000Z') : new ProviderError('GitHub unreachable');
        }
        hit(c, `provider.${String(prop)}`, 'provider');
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

async function makeCase(): Promise<Case> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hf-fault-')));
  const laptopHome = join(root, 'laptop');
  const cloudHome = join(root, 'cloud');
  mkdirSync(laptopHome);
  mkdirSync(cloudHome);
  const cfg = join(root, '.gitconfig');
  writeFileSync(cfg, '[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
  const gitenv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) gitenv[k] = v;
  Object.assign(gitenv, { HOME: root, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' });
  const run = createSpawnRunner({ baseEnv: gitenv });
  const fake = createFakeCloud({ run, laptopHome, cloudHome, gitenv, scratch: join(root, 'fake') });
  const provider = new FakeCloudProvider({ url: fake.origin });
  const vault = join(laptopHome, 'projects', 'app');
  const ctx = join(vault, '_dream_context');
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: vault, env: gitenv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  mkdirSync(vault, { recursive: true });
  sh('init', '-q');
  put(vault, '.gitignore', '_dream_context/state/\n_dream_context/state/.agent-sessions.json\n_dream_context/state/.session-titles.json\n.env\n');
  put(vault, '_dream_context/core/0.soul.md', 'soul\n');
  put(vault, 'a.txt', 'a1\n');
  put(vault, 'b.txt', 'b1\n');
  sh('add', '.');
  sh('commit', '-qm', 'c1');
  sh('branch', 'feature');
  put(vault, 'a.txt', 'stashed\n');
  sh('stash', 'push', '-m', 'laptop stash');
  put(vault, 'a.txt', 'unstaged\n');
  put(vault, '.env', 'TOKEN=laptop\n');
  put(vault, '_dream_context/state/notes.md', 'state note\n');
  put(vault, '_dream_context/state/.agent-sessions.json', roster([
    { title: 'Kept', bypass: true, minimized: false, size: 1, sessionId: S1, kind: 'chat' },
    { title: 'Closed on phone', bypass: false, minimized: false, size: 1, sessionId: S2, kind: 'chat' },
  ], 'auto'));
  const c: Case = {
    root, laptopHome, cloudHome, vault, ctx, run, gitenv, fake, provider, labels: [], instrument: false, target: null, unreachable: false,
    env() {
      return {
        home: laptopHome, run, provider: wrapProvider(c), repo: wrapProvider(c), connect: () => wrapClient(c), turns: NO_TURNS,
        roster: { read: readRosterSurface, write: writeMergedRosterSurface },
        templateFiles: () => ({ '.devcontainer/devcontainer.json': Buffer.from('{"name":"hf"}\n') }),
        localVersion: () => FAKE_CLOUD_VERSION, registryFetch: fakeRegistry().fetchImpl,
        claudeProjectsDir: join(laptopHome, '.claude', 'projects'), sleep: async () => {}, healthTimeoutMs: 1000, waitTimeoutMs: 0,
        // By kind + ordinal (op ids carry per-case root ids, which differ between runs).
        beforeOp: (op: JournalOp) => hit(c, `op.${op.kind}`, 'op'),
      };
    },
  };
  await setup(c.env(), { token: 'gho_test', login: 'owner' });
  return c;
}

/** The phone's work, so a Return writes files, refs, stash, roster and a secret. */
function phoneWorks(c: Case, multi: boolean): void {
  const C = c.cloudHome + c.vault.slice(c.laptopHome.length);
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: C, env: c.gitenv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  put(C, 'c.txt', 'cloud\n');
  sh('add', 'c.txt');
  sh('commit', '-qm', 'cloud commit');
  sh('stash', 'push', '-m', 'cloud stash');
  put(C, 'b.txt', 'cloud b\n');
  put(C, 'new.txt', 'cloud untracked\n');
  put(C, '_dream_context/state/notes.md', 'cloud note\n');
  put(C, '.env', 'TOKEN=cloud\n');
  put(C, '_dream_context/state/.agent-sessions.json', roster([
    { title: 'Kept, renamed on phone', bypass: true, minimized: false, size: 1, sessionId: S1, kind: 'chat' },
    { title: 'Opened on phone', bypass: true, minimized: false, size: 1, sessionId: S3, kind: 'chat' },
  ], 'bypass'));
  // Smoke #6 / D28: the vault was never opened in Claude on the laptop (no transcript dir at
  // go); the phone's session there makes the Return create it (dir.ensure + files.apply of a
  // transcripts root), so those ops are injection points too.
  put(join(c.cloudHome, '.claude', 'projects', encodeProjectDir(c.vault)), `${S3}.jsonl`, '{"type":"user","phone":true}\n');
  if (multi) {
    c.fake.beforeSeal = () => {
      put(C, 'late.txt', 'after the snapshot\n');
      put(C, 'b.txt', 'cloud b pass two\n');
      c.fake.epoch++;
    };
  }
}

interface LaptopState { files: string[]; refs: string; stash: string; head: string }

function laptopState(c: Case): LaptopState {
  const files: string[] = [];
  const walkDir = (abs: string, rel: string, dirs = false) => {
    for (const n of readdirSync(abs).sort()) {
      if (rel === '' && n === '.git') continue;
      const p = join(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(p);
      if (st.isDirectory()) { if (dirs) files.push(`${r}/`); walkDir(p, r, dirs); }
      else files.push(`${r} ${createHash('sha256').update(readFileSync(p)).digest('hex')} ${st.mode & 0o111 ? 'x' : '-'}`);
    }
  };
  walkDir(c.vault, '');
  // The transcript dirs too: a Roll back removes the dir this Return created (byte for byte).
  if (existsSync(join(c.laptopHome, '.claude'))) walkDir(join(c.laptopHome, '.claude'), '~/.claude', true);
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: c.vault, env: c.gitenv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    files,
    refs: sh('for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags', 'refs/notes'),
    stash: sh('stash', 'list', '--format=%H %gs'),
    head: sh('symbolic-ref', '-q', 'HEAD').trim(),
  };
}

function tripDirOf(c: Case, trip: string): string {
  return tripDir(join(c.laptopHome, '.dreamcontext', 'handsfree'), trip);
}

/** Did any pass of this trip's Return write to the laptop? (computed independently of the orchestrator) */
function wrote(c: Case, trip: string | null): boolean {
  if (!trip) return false;
  const dir = tripDirOf(c, trip);
  if (!existsSync(dir)) return false;
  const started = (p: string) => { try { const j = loadJournal(p); return !!j && journalStatus(j).writeStarted; } catch { return false; } };
  return started(join(dir, 'return-journal.json')) || readdirSync(dir).some((n) => /^return-journal\.pass-\d+\.json$/.test(n) && started(join(dir, n)));
}

/** Archived pass journals and backup ledgers: what no retry may rewrite or truncate. */
function persisted(c: Case, trip: string): Map<string, string> {
  const m = new Map<string, string>();
  const dir = tripDirOf(c, trip);
  if (!existsSync(dir)) return m;
  for (const n of readdirSync(dir)) if (/^return-journal\.pass-\d+\.json$/.test(n)) m.set(n, readFileSync(join(dir, n), 'utf8'));
  const bk = join(dir, 'backup');
  if (existsSync(bk)) for (const s of readdirSync(bk)) {
    const l = join(bk, s, 'ledger.jsonl');
    if (existsSync(l)) m.set(`backup/${s}/ledger.jsonl`, readFileSync(l, 'utf8'));
  }
  return m;
}

async function checkInvariants(c: Case, where: string): Promise<void> {
  const st = readTripState(c.laptopHome);
  const w = wrote(c, st.tripId);
  const s = await status(c.env(), { probe: false });
  if (w) {
    expect(st.phase, `${where}: never away after a return write`).not.toBe('away');
    expect(s.offers, `${where}: Abandon is never offered after a write`).not.toContain('abandon');
    if (st.phase === 'returning') expect(s.offers, `${where}: after a write, Roll back stays available`).toContain('rollback');
  }
  // Never a state with no way out.
  if (st.phase === 'returning') expect(s.offers.includes('rollback') || s.offers.includes('abandon') || s.offers.includes('resume'), `${where}: a way out`).toBe(true);
  if (st.phase === 'going') expect(s.offers, `${where}: an interrupted go can be abandoned`).toContain('abandon');
}

async function runScenario(c: Case, scenario: Scenario): Promise<{ trip: string | null; before: LaptopState | null; error: unknown }> {
  let before: LaptopState | null = null;
  if (scenario === 'go') {
    c.instrument = true;
    const error = await go(c.env(), { contextRoot: c.ctx }).then(() => null, (e: unknown) => e);
    c.instrument = false;
    return { trip: readTripState(c.laptopHome).tripId, before, error };
  }
  const g = await go(c.env(), { contextRoot: c.ctx });
  phoneWorks(c, scenario === 'return-multi');
  before = laptopState(c);
  c.instrument = true;
  const error = await returnTrip(c.env()).then(() => null, (e: unknown) => e);
  c.instrument = false;
  return { trip: g.tripId, before, error };
}

// ---------------------------------------------------------------- generate the injection points

async function record(scenario: Scenario): Promise<string[]> {
  const c = await makeCase();
  try {
    const r = await runScenario(c, scenario);
    if (r.error) throw r.error;
    return [...c.labels];
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
}

function kindsFor(label: string): Kind[] {
  if (label.startsWith('op.')) return ['crash', 'crash-rollback'];
  if (label.startsWith('client.')) return ['crash', 'network', 'stopped'];
  return ['crash', 'network', 'quota', 'stopped'];
}

const SCENARIOS: Scenario[] = ['go', 'return-single', 'return-multi'];
const recorded = new Map<Scenario, string[]>();
for (const s of SCENARIOS) recorded.set(s, await record(s));
const CASES = SCENARIOS.flatMap((s) => recorded.get(s)!.flatMap((label) => kindsFor(label).map((kind) => ({ scenario: s, label, kind }))));

const COUNT = (s: Scenario, pre: string) => recorded.get(s)!.filter((l) => l.startsWith(pre)).length;
describe(`fault-injection points are generated from the recorded op and call lists (go: ${COUNT('go', 'op.')} ops + ${COUNT('go', 'client.')} cloud + ${COUNT('go', 'provider.')} provider; return-single: ${COUNT('return-single', 'op.')} + ${COUNT('return-single', 'client.')} + ${COUNT('return-single', 'provider.')}; return-multi: ${COUNT('return-multi', 'op.')} + ${COUNT('return-multi', 'client.')} + ${COUNT('return-multi', 'provider.')}; ${CASES.length} cases)`, () => {
  it('covers every journal op and every cloud/provider call of go, a single-pass and a multi-pass Return', () => {
    for (const s of SCENARIOS) {
      const labels = recorded.get(s)!;
      expect(labels.some((l) => l.startsWith('op.')), `${s} has journal ops`).toBe(true);
      expect(labels.some((l) => l.startsWith('client.')), `${s} has cloud calls`).toBe(true);
    }
    expect(recorded.get('return-multi')!.filter((l) => l.startsWith('client.quiesce')).length).toBeGreaterThanOrEqual(2);
    // D28: the transcripts root the Return creates is an injection point (crash, crash + Roll back).
    for (const s of ['return-single', 'return-multi'] as const) expect(recorded.get(s)!.some((l) => l.startsWith('op.dir.ensure')), `${s} creates a transcript dir`).toBe(true);
    console.log(`[fault-injection] points: go=${recorded.get('go')!.length} return-single=${recorded.get('return-single')!.length} return-multi=${recorded.get('return-multi')!.length}; cases=${CASES.length}`);
  });
});

describe.concurrent('D23 fault injection', () => {
  for (const { scenario, label, kind } of CASES) {
    it(`${scenario} :: ${label} :: ${kind}`, async () => {
      // A fresh case with the target armed (deterministic: the same labels in the same order).
      const d = await makeCase();
      try {
        d.target = { label, kind };
        const r = await runScenario(d, scenario);
        expect(d.target, `the injection point ${label} was reached`).toBeNull();
        const where = `${scenario} ${label} ${kind}`;
        await checkInvariants(d, `${where} (after the fault)`);
        const trip = readTripState(d.laptopHome).tripId ?? r.trip;

        if (kind === 'crash-rollback') {
          // Straight to Roll back after a crash inside the Return's journal.
          if (readTripState(d.laptopHome).phase === 'returning' && (await status(d.env(), { probe: false })).offers.includes('rollback')) {
            d.unreachable = true;
            await rollbackTrip(d.env());
            expect(readTripState(d.laptopHome).phase, `${where}: Roll back ends away`).toBe('away');
            expect(laptopState(d), `${where}: Roll back restores the pre-return laptop byte for byte`).toEqual(r.before);
          }
          return;
        }

        // Resume with the cloud AND GitHub unreachable.
        d.unreachable = true;
        const keep = trip ? persisted(d, trip) : new Map<string, string>();
        const phase = readTripState(d.laptopHome).phase;
        if (phase === 'returning' || phase === 'going') await resumeTrip(d.env()).catch(() => null);
        await checkInvariants(d, `${where} (after Resume, unreachable)`);
        const after = readTripState(d.laptopHome);
        const offers = (await status(d.env(), { probe: false })).offers;
        const ok = after.phase === 'home' || after.phase === 'away'
          || (after.phase === 'returning' && offers.includes('rollback'))
          || (after.phase === 'going' && offers.includes('abandon'));
        expect(ok, `${where}: Resume reaches home/away or Roll back (or Abandon of a go) stays available; got ${after.phase} ${offers.join(',')}`).toBe(true);
        // D23 (b), stronger: a Return never needs the cloud or GitHub to finish locally, so Resume
        // with both unreachable always ends home (or away, when nothing was written): never stuck.
        if (scenario !== 'go') expect(['home', 'away'], `${where}: offline Resume ends home/away, got ${after.phase}`).toContain(after.phase);
        // No retry rewrote an earlier pass's journal or truncated a backup ledger.
        if (trip) {
          const now = persisted(d, trip);
          for (const [k, v] of keep) {
            if (k.startsWith('return-journal.pass-')) expect(now.get(k), `${where}: ${k} untouched`).toBe(v);
            else expect((now.get(k) ?? '').startsWith(v), `${where}: ${k} only appended`).toBe(true);
          }
        }
        // Whenever Roll back is still offered, it restores the pre-return laptop exactly.
        if (after.phase === 'returning' && offers.includes('rollback') && r.before) {
          await rollbackTrip(d.env());
          expect(readTripState(d.laptopHome).phase).toBe('away');
          expect(laptopState(d), `${where}: Roll back restores the pre-return laptop byte for byte`).toEqual(r.before);
        }
        // An interrupted go is always abandonable, back home with the laptop untouched.
        if (readTripState(d.laptopHome).phase === 'going') {
          await abandonTrip(d.env());
          expect(readTripState(d.laptopHome).phase).toBe('home');
        }
      } finally {
        rmSync(d.root, { recursive: true, force: true });
      }
    });
  }
});
