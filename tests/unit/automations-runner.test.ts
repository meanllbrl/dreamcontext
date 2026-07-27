import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  buildPreamble,
  composePrompt,
  killRunGroup,
  outputPathFor,
  OUTPUT_WRITE_FAILURE_REASON,
  parseClaudeJson,
  runAutomation,
  sanitizeAutomationPrompt,
  type SpawnImpl,
} from '../../src/lib/automations/runner.js';
import {
  createAutomation,
  getAutomation,
  lockPathFor,
  readAutomationCache,
  readRunSidecar,
  writeRunSidecar,
} from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { MAX_PROMPT_BYTES, type AutomationManifest } from '../../src/lib/automations/types.js';
import { NOTIFY_SOUND_OK, NOTIFY_SOUND_FAILED } from '../../src/lib/automations/notifier.js';
import { writeSleepState } from '../../src/cli/commands/sleep.js';
import type { SleepState } from '../../src/lib/sleep-consolidation.js';

/** A minimal fake ChildProcess: a real EventEmitter with stdout/stderr streams
 *  (also EventEmitters), so `runner.ts`'s `.on('data'|'close'|'error', ...)`
 *  wiring works unmodified against it. `pid` is settable per-test so the
 *  spawn-failure gate (`child.pid == null`) is directly exercisable. */
function makeFakeChild(pid: number | undefined): {
  child: EventEmitter & { pid: number | undefined; stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  emitClose: (code: number | null) => void;
  emitStdout: (data: string) => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { pid, stdout, stderr, kill: () => {} });
  return {
    child,
    emitClose: (code) => child.emit('close', code),
    emitStdout: (data) => stdout.emit('data', Buffer.from(data, 'utf-8')),
  };
}

const CLAUDE_JSON_OK = JSON.stringify({
  session_id: 'sess_abc123',
  result: '# Daily digest\n\nAll good.\n',
  is_error: false,
  permission_denials: [],
  total_cost_usd: 0.0123,
  num_turns: 4,
  duration_ms: 5400,
  subtype: 'success',
});

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = new Date('2026-07-26T18:00:00.000Z');

function makeSpawnImpl(child: EventEmitter): SpawnImpl {
  return vi.fn(() => child) as unknown as SpawnImpl;
}

/** Approved automation, ready to run — the common fixture for most cases. */
function createApproved(slug: string, overrides?: Partial<Parameters<typeof createAutomation>[1]>): AutomationManifest {
  const manifest = createAutomation(contextRoot, {
    slug,
    title: `Test — ${slug}`,
    days: 'daily',
    at: '18:00',
    prompt: 'Say hello.',
    ...overrides,
  });
  approveAutomation(projectRoot, manifest, NOW, home);
  return manifest;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-automations-runner-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-automations-runner-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('parseClaudeJson', () => {
  it('parses a valid JSON result with full telemetry', () => {
    const r = parseClaudeJson(CLAUDE_JSON_OK);
    expect(r.parsed).toBe(true);
    expect(r.result).toBe('# Daily digest\n\nAll good.\n');
    expect(r.isError).toBe(false);
    expect(r.sessionId).toBe('sess_abc123');
    expect(r.costUsd).toBe(0.0123);
    expect(r.numTurns).toBe(4);
    expect(r.durationMs).toBe(5400);
    expect(r.permissionDenials).toBe(0);
    expect(r.subtype).toBe('success');
  });

  it('counts permission_denials length', () => {
    const r = parseClaudeJson(JSON.stringify({ result: 'x', permission_denials: [{ tool: 'Bash' }, { tool: 'Write' }] }));
    expect(r.permissionDenials).toBe(2);
  });

  it('degrades gracefully on non-JSON stdout — never throws', () => {
    const r = parseClaudeJson('not json at all {{{');
    expect(r.parsed).toBe(false);
    expect(r.result).toBeNull();
    expect(r.isError).toBe(true);
    expect(r.raw).toBe('not json at all {{{');
  });

  it('degrades gracefully when JSON parses but result is missing/non-string', () => {
    expect(parseClaudeJson(JSON.stringify({ ok: true })).parsed).toBe(false);
    expect(parseClaudeJson(JSON.stringify({ result: 42 })).parsed).toBe(false);
    expect(parseClaudeJson(JSON.stringify(['array', 'not', 'object']))).toMatchObject({ parsed: false });
    expect(parseClaudeJson('null')).toMatchObject({ parsed: false });
  });

  it('surfaces is_error: true even when parsed', () => {
    const r = parseClaudeJson(JSON.stringify({ result: 'partial', is_error: true }));
    expect(r.parsed).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.result).toBe('partial');
  });
});

describe('sanitizeAutomationPrompt', () => {
  it('strips NUL bytes but preserves newlines (unlike sanitizePrompt)', () => {
    const s = 'line one\nline two\tindented\x00null-here';
    const out = sanitizeAutomationPrompt(s);
    expect(out).toContain('\n');
    expect(out).toContain('\t');
    expect(out).not.toContain('\x00');
  });

  it('caps at MAX_PROMPT_BYTES', () => {
    const huge = 'a'.repeat(MAX_PROMPT_BYTES + 5000);
    const out = sanitizeAutomationPrompt(huge);
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
  });
});

describe('composePrompt / buildPreamble', () => {
  it('preamble names the title, project root, fire time, and output path', () => {
    const manifest = createApproved('preamble-check');
    const preamble = buildPreamble(manifest, projectRoot, NOW, '/tmp/out.md');
    expect(preamble).toContain(manifest.title);
    expect(preamble).toContain(projectRoot);
    expect(preamble).toContain(NOW.toISOString());
    expect(preamble).toContain('/tmp/out.md');
    expect(preamble).toContain('NO user available');
  });

  it('appends output instructions only when present', () => {
    // createAutomation always scaffolds a placeholder stub into
    // `## Output instructions` when none is given (store.ts's create-time
    // prompt-for-content behavior), so a file-backed manifest is never
    // genuinely empty there — construct literal manifest objects instead to
    // exercise composePrompt's OWN conditional directly.
    const withInstructions = createApproved('with-instructions', { outputInstructions: 'Keep it short.' });
    const withoutInstructionsFile = createApproved('without-instructions');
    const withoutInstructions: AutomationManifest = { ...withoutInstructionsFile, outputInstructions: '' };
    expect(composePrompt(withInstructions, projectRoot, NOW, '/x.md')).toContain('Output instructions:');
    expect(composePrompt(withoutInstructions, projectRoot, NOW, '/x.md')).not.toContain('Output instructions:');
  });
});

describe('effort — passed through to claude, never a placeholder token when null', () => {
  it('appends --effort <level> immediately after --model when both are set', async () => {
    const manifest = createApproved('effort-set', { model: 'sonnet-5', effort: 'max' });
    const { child, emitClose, emitStdout } = makeFakeChild(9001);
    const rawSpawn = vi.fn(() => child);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: rawSpawn as unknown as SpawnImpl, notify: () => {},
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    await runPromise;

    const args = rawSpawn.mock.calls[0][1] as string[];
    const modelIdx = args.indexOf('--model');
    const effortIdx = args.indexOf('--effort');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(effortIdx).toBe(modelIdx + 2); // immediately after `--model <value>`
    expect(args[effortIdx + 1]).toBe('max');
  });

  it('still appends --effort even when model is unset', async () => {
    const manifest = createApproved('effort-no-model', { effort: 'low' });
    const { child, emitClose, emitStdout } = makeFakeChild(9002);
    const rawSpawn = vi.fn(() => child);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: rawSpawn as unknown as SpawnImpl, notify: () => {},
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    await runPromise;

    const args = rawSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
  });

  it('emits NO --effort token at all when effort is null — never a placeholder', async () => {
    const manifest = createApproved('effort-null'); // effort defaults to null
    const { child, emitClose, emitStdout } = makeFakeChild(9003);
    const rawSpawn = vi.fn(() => child);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: rawSpawn as unknown as SpawnImpl, notify: () => {},
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    await runPromise;

    const args = rawSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--effort');
  });
});

describe('outputPathFor', () => {
  it('suffixes -2, -3 on same-day collision, never clobbering', () => {
    const manifest = createApproved('collide-me');
    const first = outputPathFor(contextRoot, manifest, NOW);
    mkdirSync(join(first, '..'), { recursive: true });
    writeFileSync(first, 'day one');
    const second = outputPathFor(contextRoot, manifest, NOW);
    expect(second).not.toBe(first);
    expect(second).toMatch(/-2\.md$/);
    writeFileSync(second, 'day one, run two');
    const third = outputPathFor(contextRoot, manifest, NOW);
    expect(third).toMatch(/-3\.md$/);
    expect(readFileSync(first, 'utf-8')).toBe('day one'); // never clobbered
  });
});

// ─── runAutomation — gates and dispositions ─────────────────────────────────

describe('runAutomation — preconditions', () => {
  it('throws on win32 (POSIX-only process-group signalling)', async () => {
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await expect(runAutomation(contextRoot, 'whatever', {})).rejects.toThrow(/Windows is not supported/);
    spy.mockRestore();
  });

  it('throws when host:"server" is passed without registerChild', async () => {
    await expect(
      runAutomation(contextRoot, 'whatever', { host: 'server' } as never),
    ).rejects.toThrow(/requires registerChild/);
  });
});

describe('runAutomation — step 1: no manifest', () => {
  it('returns failed with NO cache record ever written for that slug', async () => {
    const outcome = await runAutomation(contextRoot, 'does-not-exist', { notify: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.event).toBeNull();
    expect(outcome.cache).toBeNull();
    expect(readAutomationCache(contextRoot, 'does-not-exist')).toBeNull();
    expect(existsSync(join(contextRoot, 'automations', 'cache', 'does-not-exist.json'))).toBe(false);
  });
});

describe('runAutomation — step 2: approval gate', () => {
  it('unapproved ⇒ blocked, watermark not advanced, and the spawn is NEVER invoked', async () => {
    const manifest = createAutomation(contextRoot, {
      slug: 'never-approved', title: 'Never approved', days: 'daily', at: '18:00',
    });
    // Deliberately do NOT approve.
    const spawnFn = vi.fn();
    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home,
      spawnImpl: spawnFn as unknown as SpawnImpl,
      notify: () => {},
    });
    expect(outcome.status).toBe('blocked');
    expect(spawnFn).not.toHaveBeenCalled();
    const cache = readAutomationCache(contextRoot, manifest.slug);
    expect(cache?.lastFireAt).toBeNull(); // watermark never advanced
    expect(cache?.status).toBe('blocked');
  });
});

describe('runAutomation — step 3: sleep-lock deference', () => {
  it('deferred while a fresh sleep lock is held; skipped entirely under --force', async () => {
    const manifest = createApproved('sleep-deferred');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    const state: SleepState = {
      debt: 0, last_sleep: null, last_sleep_summary: null,
      sleep_started_at: NOW.toISOString(), sessions_since_last_sleep: 0,
      sessions: [], bookmarks: [], triggers: [], knowledge_access: {},
      dashboard_changes: [], compaction_log: [], recall_mode: 'haiku',
    } as unknown as SleepState;
    writeSleepState(contextRoot, state);

    const spawnFn = vi.fn();
    const deferred = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: spawnFn as unknown as SpawnImpl, notify: () => {},
    });
    expect(deferred.status).toBe('deferred');
    expect(spawnFn).not.toHaveBeenCalled();
    expect(readAutomationCache(contextRoot, manifest.slug)?.lastFireAt).toBeNull();

    // force skips sleep-deference (but the fake spawn still needs a fake child
    // to avoid actually invoking claude; we assert the run at least proceeds
    // past the sleep gate here by checking it did NOT report 'deferred' for
    // the sleep reason — spawn will still be called this time).
    const { child, emitClose } = makeFakeChild(4242);
    const forcedSpawn = makeSpawnImpl(child);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: forcedSpawn, force: true, notify: () => {}, killImpl: vi.fn(),
    });
    emitClose(0);
    const forced = await runPromise;
    expect(forced.status).not.toBe('deferred');
    expect(forcedSpawn).toHaveBeenCalled();
  });
});

describe('runAutomation — step 4: orphan guard (BEFORE the lock)', () => {
  it('a live child group with a dead runner ⇒ orphaned, zero spawns, watermark not advanced', async () => {
    const manifest = createApproved('has-orphan');
    // A real, currently-alive PID for the "child" (this test process itself —
    // never actually signalled beyond signal 0 probes) and a PID that is
    // certainly dead for the "runner".
    writeRunSidecar(contextRoot, manifest.slug, {
      slug: manifest.slug,
      runnerPid: 999999, // treated as dead via the injected killImpl below
      childPid: process.pid,
      childPgid: process.pid,
      fireAt: NOW.toISOString(),
      startedAt: NOW.toISOString(),
      timeoutAt: NOW.toISOString(),
    });
    const killImpl = vi.fn((pid: number) => {
      if (pid === 999999) { const e = new Error('no such process') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; }
      // any other pid (the "child") is treated as alive — no throw.
    });
    const spawnFn = vi.fn();
    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: spawnFn as unknown as SpawnImpl, killImpl, notify: () => {},
    });
    expect(outcome.status).toBe('orphaned');
    expect(spawnFn).not.toHaveBeenCalled();
    expect(readAutomationCache(contextRoot, manifest.slug)?.lastFireAt).toBeNull();
    expect(outcome.error).toContain('dreamcontext automations kill');
  });

  it('fires BEFORE lock acquisition — a stale, unreclaimable lock does not mask the orphan as merely deferred', async () => {
    const manifest = createApproved('orphan-before-lock', { timeoutMinutes: 1 });
    // Write a lock that looks "genuinely held" (fresh timestamp) so that if
    // the orphan guard ran AFTER lock acquisition, this would report
    // 'deferred' (self-overlap) instead of the true 'orphaned' state.
    mkdirSync(join(contextRoot, 'automations', 'cache'), { recursive: true });
    writeFileSync(lockPathFor(contextRoot, manifest.slug), JSON.stringify({ pid: 999998, at: NOW.getTime() }));
    writeRunSidecar(contextRoot, manifest.slug, {
      slug: manifest.slug, runnerPid: 999999, childPid: process.pid, childPgid: process.pid,
      fireAt: NOW.toISOString(), startedAt: NOW.toISOString(), timeoutAt: NOW.toISOString(),
    });
    const killImpl = vi.fn((pid: number) => {
      if (pid === 999999) { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; }
    });
    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: vi.fn() as unknown as SpawnImpl, killImpl, notify: () => {},
    });
    expect(outcome.status).toBe('orphaned'); // NOT 'deferred'
  });

  it('a stale sidecar with a dead child does NOT trigger the guard (no false positive)', async () => {
    const manifest = createApproved('stale-dead-sidecar');
    writeRunSidecar(contextRoot, manifest.slug, {
      slug: manifest.slug, runnerPid: 999999, childPid: 999998, childPgid: 999998,
      fireAt: NOW.toISOString(), startedAt: NOW.toISOString(), timeoutAt: NOW.toISOString(),
    });
    const killImpl = vi.fn(() => { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; });
    const { child, emitClose } = makeFakeChild(555);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), killImpl, notify: () => {},
    });
    emitClose(0);
    const outcome = await runPromise;
    expect(outcome.status).not.toBe('orphaned');
  });
});

describe('runAutomation — self-overlap (the lock)', () => {
  it('a live, unexpired lock held by another run ⇒ deferred, watermark not advanced', async () => {
    const manifest = createApproved('self-overlap');
    mkdirSync(join(contextRoot, 'automations', 'cache'), { recursive: true });
    writeFileSync(lockPathFor(contextRoot, manifest.slug), JSON.stringify({ pid: process.pid, at: NOW.getTime() }));
    const spawnFn = vi.fn();
    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: spawnFn as unknown as SpawnImpl, notify: () => {},
    });
    expect(outcome.status).toBe('deferred');
    expect(spawnFn).not.toHaveBeenCalled();
    expect(readAutomationCache(contextRoot, manifest.slug)?.lastFireAt).toBeNull();
  });
});

describe('runAutomation — step 8: spawn failure', () => {
  it('child.pid == null ⇒ failed, NO sidecar written, watermark NOT advanced', async () => {
    const manifest = createApproved('spawn-fails');
    const { child } = makeFakeChild(undefined);
    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), notify: () => {},
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/spawn failed/);
    expect(readRunSidecar(contextRoot, manifest.slug)).toBeNull();
    expect(readAutomationCache(contextRoot, manifest.slug)?.lastFireAt).toBeNull();
  });

  it('notifies on spawn failure, with the failure sound', async () => {
    const manifest = createApproved('spawn-fails-notify');
    const { child } = makeFakeChild(undefined);
    const notify = vi.fn();
    await runAutomation(contextRoot, manifest.slug, { now: () => NOW, home, spawnImpl: makeSpawnImpl(child), notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][2]).toBe(NOTIFY_SOUND_FAILED);
  });
});

/**
 * Completion notifications. The original implementation notified only when
 * `status !== 'ok'`, so the case the whole feature exists for — a run that
 * succeeded while nobody was at the keyboard — was the one case that stayed
 * silent. These pin both directions, plus the two ways silence is still correct:
 * an explicit `notify: false` manifest, and any path where nothing actually ran.
 */
describe('runAutomation — completion notifications', () => {
  const runToSuccess = async (slug: string, notify: (t: string, b: string) => void) => {
    const manifest = createApproved(slug);
    const { child, emitClose, emitStdout } = makeFakeChild(4321);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), notify,
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    return runPromise;
  };

  it('notifies on SUCCESS, naming the automation and its output file', async () => {
    const notify = vi.fn();
    const outcome = await runToSuccess('notify-on-ok', notify);
    expect(outcome.status).toBe('ok');
    expect(notify).toHaveBeenCalledTimes(1);
    const [title, body, sound] = notify.mock.calls[0];
    expect(title).toMatch(/done/i);
    expect(title).not.toMatch(/fail/i);
    // Success and failure must not sound alike: nobody is watching when these
    // fire, so the sound is the only signal that arrives before you look.
    expect(sound).toBe(NOTIFY_SOUND_OK);
    expect(NOTIFY_SOUND_OK).not.toBe(NOTIFY_SOUND_FAILED);
    expect(body).toContain('notify-on-ok'); // createApproved titles the manifest after the slug
    // The body carries the BASENAME, never the absolute path — an output path can
    // sit under a private brain and a notification is the least private surface
    // there is (it renders on a possibly-shared screen, and macOS keeps it in
    // Notification Centre afterwards).
    expect(body).toMatch(/\.md$/);
    expect(body).not.toContain(contextRoot);
  });

  it('a manifest with notify: false stays silent on success AND on failure', async () => {
    const silent = createApproved('silent-one', { notify: false });
    expect(silent.notify).toBe(false);

    const notify = vi.fn();
    const { child, emitClose, emitStdout } = makeFakeChild(4322);
    const runPromise = runAutomation(contextRoot, silent.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), notify,
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    expect((await runPromise).status).toBe('ok');

    const { child: child2 } = makeFakeChild(undefined); // spawn failure
    await runAutomation(contextRoot, silent.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child2), notify,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('an omitted notify field reads as notify — every manifest written before the field existed', () => {
    const manifest = createApproved('legacy-manifest');
    // Simulate a manifest authored before `notify` existed by stripping the line.
    const raw = readFileSync(manifest.path, 'utf-8');
    expect(raw).toContain('notify:');
    writeFileSync(manifest.path, raw.replace(/^notify:.*\n/m, ''));
    const reread = getAutomation(contextRoot, manifest.slug);
    expect(reread?.notify).toBe(true);
  });

  it('never notifies for a run that did not happen — an unapproved slug stays silent every tick', async () => {
    const manifest = createAutomation(contextRoot, {
      slug: 'unapproved-silent',
      title: 'Unapproved',
      days: 'daily',
      at: '18:00',
      prompt: 'do the thing',
    });
    expect(manifest.notify).toBe(true); // the gate below is the run-happened gate, not the flag
    const notify = vi.fn();
    const spawnImpl = vi.fn();
    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: spawnImpl as unknown as SpawnImpl, notify,
    });
    expect(outcome.status).toBe('blocked');
    expect(spawnImpl).not.toHaveBeenCalled();
    // The dispatcher re-evaluates every 5 minutes and a blocked automation stays
    // due, so notifying here would be a notification every 5 minutes, forever.
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('runAutomation — completed runs', () => {
  it('is_error: true ⇒ failed, even though JSON parsed fine', async () => {
    const manifest = createApproved('claude-is-error');
    const { child, emitClose, emitStdout } = makeFakeChild(1234);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), notify: () => {},
    });
    emitStdout(JSON.stringify({ result: 'partial output', is_error: true }));
    emitClose(1);
    const outcome = await runPromise;
    expect(outcome.status).toBe('failed');
    expect(outcome.event?.exitCode).toBe(1);
  });

  it('unparseable stdout ⇒ failed WITH the raw tail still written to the output file — never lose work', async () => {
    const manifest = createApproved('unparseable');
    const { child, emitClose, emitStdout } = makeFakeChild(1235);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), notify: () => {},
    });
    emitStdout('this is not json, just plain rambling output from a confused process');
    emitClose(0);
    const outcome = await runPromise;
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('unparseable CLI output');
    expect(outcome.outputPath).not.toBeNull();
    expect(readFileSync(outcome.outputPath as string, 'utf-8')).toContain('confused process');
  });

  it('ok ⇒ writes result verbatim and nothing else to the output file', async () => {
    const manifest = createApproved('happy-path');
    const { child, emitClose, emitStdout } = makeFakeChild(1236);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), notify: () => {},
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    const outcome = await runPromise;
    expect(outcome.status).toBe('ok');
    expect(readFileSync(outcome.outputPath as string, 'utf-8')).toBe('# Daily digest\n\nAll good.\n');
    expect(outcome.event?.sessionId).toBe('sess_abc123');
    expect(outcome.event?.costUsd).toBe(0.0123);
    const cache = readAutomationCache(contextRoot, manifest.slug);
    expect(cache?.lastFireAt).toBe(NOW.toISOString()); // watermark advanced
  });

  it('output-write failure: the synced RunEvent.error carries NO path (fixed reason only); the real message goes only to the log callback', async () => {
    const manifest = createApproved('write-fails');
    // Pre-create the output directory, then make it read-only so the internal
    // writeFileSync throws EACCES — whose message embeds the FULL ABSOLUTE
    // PATH being written to. Established pattern: features-knowledge.test.ts's
    // "transient write failure" case.
    const outputPath = outputPathFor(contextRoot, manifest, NOW);
    const outDir = dirname(outputPath);
    mkdirSync(outDir, { recursive: true });
    chmodSync(outDir, 0o555);

    const { child, emitClose, emitStdout } = makeFakeChild(1238);
    const logLines: string[] = [];
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), notify: () => {}, log: (l) => logLines.push(l),
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);

    let outcome;
    try {
      outcome = await runPromise;
    } finally {
      chmodSync(outDir, 0o755); // restore before afterEach's rmSync cleanup
    }

    expect(outcome.status).toBe('failed');
    // The SYNCED field: fixed reason, no interpolation.
    expect(outcome.error).toBe(OUTPUT_WRITE_FAILURE_REASON);
    expect(outcome.event?.error).toBe(OUTPUT_WRITE_FAILURE_REASON);
    // Assert the ABSENCE of the path specifically, not just that the run failed.
    expect(outcome.error).not.toContain(projectRoot);
    expect(outcome.error).not.toContain(outDir);
    expect(outcome.error).not.toContain(outputPath);
    expect(outcome.error).not.toMatch(/\/Users\//);
    const cache = readAutomationCache(contextRoot, manifest.slug);
    expect(cache?.error).toBe(OUTPUT_WRITE_FAILURE_REASON);
    expect(cache?.error).not.toContain(projectRoot);
    expect(JSON.stringify(cache)).not.toContain(projectRoot); // whole synced record, not just the error field

    // The log callback (machine-local, never synced) DID receive the real,
    // path-bearing message — proving detail wasn't just discarded, only kept
    // off the synced channel.
    const detailed = logLines.find((l) => l.includes('output write failed'));
    expect(detailed).toBeDefined();
    expect(detailed).toContain(outputPath);
  });

  it('a completed run writes NO sidecar afterward (cleared in finally)', async () => {
    const manifest = createApproved('sidecar-cleared');
    const { child, emitClose, emitStdout } = makeFakeChild(1237);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), notify: () => {},
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    await runPromise;
    expect(readRunSidecar(contextRoot, manifest.slug)).toBeNull();
  });
});

describe('runAutomation — sidecar retention (rev-5 regression)', () => {
  it('a second run attempt does NOT overwrite a live orphan\'s sidecar record', async () => {
    const manifest = createApproved('retention-check');
    writeRunSidecar(contextRoot, manifest.slug, {
      slug: manifest.slug, runnerPid: 999999, childPid: 424242, childPgid: 424242,
      fireAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z', timeoutAt: '2026-01-01T00:15:00.000Z',
    });
    const killImpl = vi.fn((pid: number) => {
      if (pid === 999999) { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; }
      // 424242 (the orphaned child) is treated as alive.
    });
    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: vi.fn() as unknown as SpawnImpl, killImpl, notify: () => {},
    });
    expect(outcome.status).toBe('orphaned');
    const sidecar = readRunSidecar(contextRoot, manifest.slug);
    expect(sidecar?.childPgid).toBe(424242); // untouched — still describes the ORIGINAL orphan
  });

  it('a spawn-failure finally does NOT clear a sidecar whose runnerPid differs from this process', async () => {
    const manifest = createApproved('finally-does-not-clobber');
    // A sidecar from a DIFFERENT (dead) runner, whose child is ALSO dead —
    // i.e. inert garbage that doesn't trip the orphan guard (childAlive is
    // false), so this run proceeds past step 4 into a real spawn attempt.
    writeRunSidecar(contextRoot, manifest.slug, {
      slug: manifest.slug, runnerPid: 888888, childPid: 888887, childPgid: 888887,
      fireAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z', timeoutAt: '2026-01-01T00:15:00.000Z',
    });
    const killImpl = vi.fn(() => { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; });
    const { child } = makeFakeChild(undefined); // spawn failure
    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), killImpl, notify: () => {},
    });
    expect(outcome.status).toBe('failed');
    // The stale sidecar (belonging to pid 888888, NOT this process) must
    // survive untouched — this run never wrote one of its own (runnerPid
    // never matched), so `finally` must not have cleared it.
    const sidecar = readRunSidecar(contextRoot, manifest.slug);
    expect(sidecar?.runnerPid).toBe(888888);
  });
});

// ─── host discriminated union + listener lifecycle ──────────────────────────

describe('runAutomation — host wiring', () => {
  it('host:"server" never touches process-level SIGINT/SIGTERM listener counts', async () => {
    const manifest = createApproved('host-server');
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const { child, emitClose, emitStdout } = makeFakeChild(2001);
    let registeredKillGroup: (() => void) | null = null;
    const untrack = vi.fn();
    const registerChild = vi.fn((killGroup: () => void) => { registeredKillGroup = killGroup; return untrack; });
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), host: 'server', registerChild, notify: () => {},
    });
    // Mid-flight: listener counts must be UNCHANGED (host:'server' installs none).
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(registerChild).toHaveBeenCalledTimes(1);

    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    await runPromise;

    expect(untrack).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(typeof registeredKillGroup).toBe('function');
  });

  it('the host:"server" registered callback issues an IMMEDIATE group SIGKILL — no SIGTERM, no grace wait', async () => {
    const manifest = createApproved('host-server-kill');
    const { child, emitClose, emitStdout } = makeFakeChild(2002);
    let killGroup: (() => void) | null = null;
    const registerChild = vi.fn((kg: () => void) => { killGroup = kg; return () => {}; });
    const killImpl = vi.fn();
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), host: 'server', registerChild, killImpl, notify: () => {},
    });
    expect(killGroup).not.toBeNull();
    (killGroup as unknown as () => void)();
    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenCalledWith(-2002, 'SIGKILL');

    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    await runPromise;
  });

  it('host:"cli" (default) installs exactly one SIGINT + one SIGTERM handler for the run\'s lifetime, removed after', async () => {
    const manifest = createApproved('host-cli');
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const { child, emitClose, emitStdout } = makeFakeChild(2003);
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), notify: () => {}, // host omitted ⇒ 'cli'
    });
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);

    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    await runPromise;

    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  });
});

// ─── Timeout path (fake timers — no real 15-minute wait) ────────────────────

describe('runAutomation — timeout kill matrix', () => {
  it('SIGTERM at the timeout, then SIGKILL after KILL_GRACE_MS — never the reverse, never simultaneous', async () => {
    vi.useFakeTimers();
    const manifest = createApproved('times-out'); // default 15-minute timeout
    const { child } = makeFakeChild(3001); // never closes on its own — simulates a hang
    const killImpl = vi.fn();
    const runPromise = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), killImpl, notify: () => {},
    });

    // Precise 1ms margins throughout — timeoutMs = 900_000, KILL_GRACE_MS = 10_000.
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1); // cumulative 899_999
    expect(killImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1); // cumulative 900_000 — SIGTERM fires
    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenCalledWith(-3001, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(9_999); // cumulative 909_999 — 1ms short of the grace window
    expect(killImpl).toHaveBeenCalledTimes(1); // grace period not yet elapsed

    await vi.advanceTimersByTimeAsync(1); // cumulative 910_000 — SIGKILL fires
    expect(killImpl).toHaveBeenCalledTimes(2);
    expect(killImpl).toHaveBeenNthCalledWith(2, -3001, 'SIGKILL');

    child.emit('close', null);
    const outcome = await runPromise;
    expect(outcome.status).toBe('timeout');
    expect(outcome.outputPath).toBeNull();
  });
});

// ─── killRunGroup — CLI-only guards ──────────────────────────────────────────

describe('killRunGroup', () => {
  it('no sidecar ⇒ found: false', () => {
    const result = killRunGroup(contextRoot, 'no-such-slug');
    expect(result).toEqual({ found: false, killed: false, childPgid: null, ageMs: null, runnerAlive: false, groupAlive: false, refusedReason: null });
  });

  it('refuses an invalid pgid recorded in the sidecar (defence in depth)', () => {
    const slug = 'invalid-pgid';
    mkdirSync(join(contextRoot, 'automations', 'cache'), { recursive: true });
    // Hand-write a sidecar bypassing readRunSidecar's own validation on WRITE
    // (writeRunSidecar doesn't validate — only readRunSidecar does), so this
    // exercises killRunGroup's own re-assertion, not the store's read guard.
    writeFileSync(
      join(contextRoot, 'automations', 'cache', `.${slug}.run.json`),
      JSON.stringify({ slug, runnerPid: 123, childPid: 456, childPgid: 456, fireAt: NOW.toISOString(), startedAt: NOW.toISOString(), timeoutAt: NOW.toISOString() }),
    );
    // childPgid 456 IS a valid integer > 1, so let's instead prove the guard
    // fires for a genuinely invalid value by writing one directly (readRunSidecar
    // would reject it as null, giving found:false — so to exercise killRunGroup's
    // OWN guard 2 in isolation we'd need to bypass readRunSidecar entirely, which
    // isn't possible via this module's public surface. This test instead confirms
    // the found:false path for a sidecar readRunSidecar correctly rejects.)
    writeFileSync(
      join(contextRoot, 'automations', 'cache', `.${slug}.run.json`),
      JSON.stringify({ slug, runnerPid: 123, childPid: 1, childPgid: 1, fireAt: NOW.toISOString(), startedAt: NOW.toISOString(), timeoutAt: NOW.toISOString() }),
    );
    const result = killRunGroup(contextRoot, slug);
    expect(result.found).toBe(false); // readRunSidecar already rejected pgid=1
  });

  it('refuses when the recorded pgid equals the caller itself', () => {
    const slug = 'self-pgid';
    writeRunSidecar(contextRoot, slug, {
      slug, runnerPid: 999999, childPid: process.pid, childPgid: process.pid,
      fireAt: NOW.toISOString(), startedAt: NOW.toISOString(), timeoutAt: NOW.toISOString(),
    });
    const result = killRunGroup(contextRoot, slug);
    expect(result.killed).toBe(false);
    expect(result.refusedReason).toMatch(/matches the caller itself/);
  });

  it('refuses on a lock/sidecar runnerPid mismatch (forged or stale sidecar)', () => {
    const slug = 'lock-mismatch';
    mkdirSync(join(contextRoot, 'automations', 'cache'), { recursive: true });
    writeFileSync(lockPathFor(contextRoot, slug), JSON.stringify({ pid: 111, at: NOW.getTime() }));
    writeRunSidecar(contextRoot, slug, {
      slug, runnerPid: 222, childPid: 33333, childPgid: 33333, // 222 !== the lock's 111
      fireAt: NOW.toISOString(), startedAt: NOW.toISOString(), timeoutAt: NOW.toISOString(),
    });
    const killImpl = vi.fn();
    const result = killRunGroup(contextRoot, slug, { killImpl });
    expect(result.killed).toBe(false);
    expect(result.refusedReason).toMatch(/does not match the current run lock/);
    // killImpl IS invoked with signal 0 for the informational runnerAlive/
    // groupAlive probes (computed before this guard, for display purposes
    // even on a refusal) — the invariant that actually matters is that no
    // SIGKILL was ever issued against the group.
    expect(killImpl).not.toHaveBeenCalledWith(-33333, 'SIGKILL');
  });

  it('refuses a sidecar past the PID-reuse window without --force, and allows it with --force', () => {
    const slug = 'aged-sidecar';
    const oldStart = new Date(NOW.getTime() - 2 * 60 * 60 * 1000); // 2h old
    writeRunSidecar(contextRoot, slug, {
      slug, runnerPid: 999999, childPid: 44444, childPgid: 44444,
      fireAt: oldStart.toISOString(), startedAt: oldStart.toISOString(), timeoutAt: oldStart.toISOString(),
    });
    const killImpl = vi.fn((pid: number) => {
      if (pid === 999999) { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; }
    });
    const refused = killRunGroup(contextRoot, slug, { nowMs: NOW.getTime(), killImpl });
    expect(refused.killed).toBe(false);
    expect(refused.refusedReason).toMatch(/minutes old/);
    expect(killImpl).not.toHaveBeenCalledWith(-44444, 'SIGKILL');

    const forced = killRunGroup(contextRoot, slug, { nowMs: NOW.getTime(), killImpl, force: true });
    expect(forced.killed).toBe(true);
    expect(killImpl).toHaveBeenCalledWith(-44444, 'SIGKILL');
  });

  it('on success: kills the negative pgid, records a complete 12-field RunEvent, advances the watermark, and clears the sidecar', () => {
    const slug = 'operator-kill-success';
    createApproved(slug);
    const startedAt = '2026-07-26T17:00:00.000Z';
    const fireAt = '2026-07-26T17:00:00.000Z';
    writeRunSidecar(contextRoot, slug, {
      slug, runnerPid: 999999, childPid: 55555, childPgid: 55555,
      fireAt, startedAt, timeoutAt: '2026-07-26T17:15:00.000Z',
    });
    const killImpl = vi.fn((pid: number) => {
      if (pid === 999999) { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; }
    });
    const nowMs = new Date('2026-07-26T17:05:00.000Z').getTime();
    const result = killRunGroup(contextRoot, slug, { killImpl, nowMs });

    expect(result.killed).toBe(true);
    expect(result.childPgid).toBe(55555);
    expect(killImpl).toHaveBeenCalledWith(-55555, 'SIGKILL');

    const cache = readAutomationCache(contextRoot, slug);
    expect(cache?.lastFireAt).toBe(fireAt); // watermark ADVANCED
    const event = cache?.history[0];
    expect(event).toMatchObject({
      firedAt: fireAt,
      startedAt,
      status: 'failed',
      durationMs: 5 * 60_000,
      outputPath: null,
      error: 'run group killed by operator',
      exitCode: null,
      sessionId: null,
      costUsd: null,
      numTurns: null,
      permissionDenials: 0,
    });
    expect(event?.finishedAt).toBe(new Date(nowMs).toISOString());

    expect(readRunSidecar(contextRoot, slug)).toBeNull(); // cleared
  });

  it('ESRCH on the kill itself is swallowed, not thrown', () => {
    const slug = 'already-gone';
    writeRunSidecar(contextRoot, slug, {
      slug, runnerPid: 999999, childPid: 66666, childPgid: 66666,
      fireAt: NOW.toISOString(), startedAt: NOW.toISOString(), timeoutAt: NOW.toISOString(),
    });
    const killImpl = vi.fn(() => { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; });
    expect(() => killRunGroup(contextRoot, slug, { killImpl, nowMs: NOW.getTime() })).not.toThrow();
  });
});
