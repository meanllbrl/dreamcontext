import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { createAutomation, writeFlowSection, getAutomation, readAutomationCache } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { listQuestions } from '../../src/lib/automations/hitl.js';
import { appendThreadEntry, readThread } from '../../src/lib/automations/threads.js';
import type { AutomationManifest, FlowGraph } from '../../src/lib/automations/types.js';

/**
 * THE USAGE-LIMIT GATE — a capped run must not publish the refusal as its work.
 *
 * Why this file exists, in the words of the four incidents that produced it: a run that
 * hits the account's 5-hour or weekly cap gets back a perfectly ordinary JSON envelope
 * whose `result` text is the limit banner and whose `is_error` is FALSE. Everything
 * downstream keys off `is_error`, so the run was recorded `ok` and the quota message was
 * written to `outputPath` as the day's digest, notified as the day's headline, and handed
 * to sleep as truth.
 *
 * The gate's POSITION is the part worth protecting with tests, not merely its existence.
 * Because `status` is 'ok', the branch chain it sits in front of does not only publish —
 * with `review: output`, or with a `hitl` node in the flow, it hands the banner to
 * `createQuestion` as the BODY of a review question and ends `awaiting-review`. A quota
 * message then sits in the human's verdict queue looking like something the agent wrote.
 * B3 and B4 are the tests that hold that, and they are the ones that fail if a later edit
 * "simplifies" the gate into the else-chain or re-couples it to `status === 'ok'`.
 *
 * B5 holds the other side: an automation whose JOB is to write about usage limits must
 * still publish. A false positive here has no visible symptom — the run reports failed and
 * writes nothing — so it is the more expensive direction and is tested with a real
 * document shape.
 */

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

/** The banner, copied from the real refused turn quoted in `claude-limit-signal.ts`. */
const BANNER = "You've hit your session limit · resets 9:30pm (Europe/Istanbul)";

/** A capped turn: the banner in `result`, and `is_error` FALSE. That pairing is the whole
 *  defect — every consumer that trusts `is_error` believes this run succeeded. */
function cappedEnvelope(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess_capped',
    result: BANNER,
    is_error: false,
    permission_denials: [],
    total_cost_usd: 0.001,
    num_turns: 1,
    duration_ms: 900,
    subtype: 'success',
    ...extra,
  });
}

function healthyEnvelope(result: string): string {
  return JSON.stringify({
    session_id: 'sess_ok',
    result,
    is_error: false,
    permission_denials: [],
    total_cost_usd: 0.02,
    num_turns: 3,
    duration_ms: 5400,
    subtype: 'success',
  });
}

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = new Date('2026-09-22T18:00:00.000Z');

function makeSpawnImpl(child: EventEmitter): SpawnImpl {
  return vi.fn(() => child) as unknown as SpawnImpl;
}

function createApproved(slug: string, overrides?: Partial<Parameters<typeof createAutomation>[1]>): AutomationManifest {
  const manifest = createAutomation(contextRoot, {
    slug, title: `Test — ${slug}`, days: 'daily', at: '18:00', prompt: 'Say hello.', ...overrides,
  });
  approveAutomation(projectRoot, manifest, NOW, home);
  return manifest;
}

/** A graph whose single node is a `hitl` gate — the other way a run stops to ask. Written
 *  BEFORE approval because `flow` is an approval-hashed field. */
function createApprovedWithHitlFlow(slug: string): AutomationManifest {
  createAutomation(contextRoot, { slug, title: `Test — ${slug}`, days: 'daily', at: '18:00', prompt: 'Say hello.' });
  const graph: FlowGraph = {
    version: 'automation-flow/v1',
    nodes: [{ id: 'ask', kind: 'hitl', label: 'Send the digest?' }],
    edges: [],
  };
  writeFlowSection(contextRoot, slug, graph);
  const fresh = getAutomation(contextRoot, slug)!;
  approveAutomation(projectRoot, fresh, NOW, home);
  return fresh;
}

/** Drive one fire to completion with a scripted envelope. */
async function runWith(slug: string, stdout: string, opts: { notify?: (t: string, b: string) => void } = {}) {
  const { child, emitClose, emitStdout } = makeFakeChild(5150);
  const run = runAutomation(contextRoot, slug, {
    now: () => NOW,
    home,
    spawnImpl: makeSpawnImpl(child),
    killImpl: vi.fn(),
    notify: opts.notify ?? (() => {}),
    log: () => {},
  });
  emitStdout(stdout);
  emitClose(0);
  return run;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-usage-limit-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-usage-limit-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('B1/B2 — a capped run fails honestly and publishes nothing', () => {
  it('reports failed with a one-sentence reason naming the window, and never writes outputPath', async () => {
    const manifest = createApproved('digest-capped');
    const outcome = await runWith(manifest.slug, cappedEnvelope());

    // B1 — the disposition. `is_error` was false; the gate is what makes this `failed`.
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe(
      'It stopped at the 5-hour usage limit — nothing was published. Try again once the window resets.',
    );
    // ONE sentence, and it says the thing that matters: nothing was published.
    expect(outcome.error).toMatch(/nothing was published/);

    // B1 — nothing published. The outcome carries no path, and no file was written.
    expect(outcome.outputPath).toBeNull();
    const event = readAutomationCache(contextRoot, manifest.slug)?.history[0];
    expect(event?.outputPath).toBeNull();
    expect(event?.status).toBe('failed');
  });

  it('the thread closes with system:failed carrying that same sentence, never system:ok', async () => {
    // B2 — the channel must not tell the human the run finished. The sentence is not
    // re-worded here: `finalize` appends `params.error`, so the run, the cache, the
    // banner and the channel all say one thing.
    const manifest = createApproved('digest-capped-thread');
    await runWith(manifest.slug, cappedEnvelope());

    const entries = readThread(contextRoot, manifest.slug);
    expect(entries.map((e) => e.event)).toEqual(['started', 'failed']);
    expect(entries[1].text).toContain('usage limit');
    expect(entries[1].text).toContain('nothing was published');
  });

  it('names the WEEKLY window and the reset when the envelope carries them', async () => {
    const manifest = createApproved('digest-capped-weekly');
    const outcome = await runWith(
      manifest.slug,
      cappedEnvelope({ quotaLimits: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1788546600 } }),
    );
    expect(outcome.error).toMatch(/^It stopped at the weekly usage limit — nothing was published\. The window reopens /);
  });
});

describe('B3/B4 — the gate runs BEFORE the review chain, and independent of status', () => {
  it('review: output — no question is created, no system:asked, not awaiting-review', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Without the gate's position, `status === 'ok'`
    // sends the banner into `createQuestion` as the question's BODY.
    const manifest = createApproved('capped-review-output', { review: 'output' });
    const outcome = await runWith(manifest.slug, cappedEnvelope());

    expect(outcome.status).toBe('failed');
    expect(outcome.status).not.toBe('awaiting-review');
    expect(listQuestions(contextRoot, manifest.slug)).toEqual([]);

    const events = readThread(contextRoot, manifest.slug).map((e) => e.event);
    expect(events).not.toContain('asked');
    expect(events).toEqual(['started', 'failed']);
  });

  it('a flow with a hitl node — same, the graph does not get to ask either', async () => {
    // B4. The flow gate is checked BEFORE the review modes ("a graph that says ask wins
    // over frontmatter that says don't"), so it is a second, independent door into
    // `createQuestion` and needs its own test.
    const manifest = createApprovedWithHitlFlow('capped-flow-hitl');
    const outcome = await runWith(manifest.slug, cappedEnvelope());

    expect(outcome.status).toBe('failed');
    expect(listQuestions(contextRoot, manifest.slug)).toEqual([]);
    expect(readThread(contextRoot, manifest.slug).map((e) => e.event)).toEqual(['started', 'failed']);
  });

  it('a HEALTHY run with review: output still asks — the gate did not break the chain', async () => {
    // The control. A gate that suppressed every question would pass the two tests above
    // for the wrong reason.
    const manifest = createApproved('healthy-review-output', { review: 'output' });
    const outcome = await runWith(manifest.slug, healthyEnvelope('# Digest\n\nWAU is down 4%.\n'));

    expect(outcome.status).toBe('awaiting-review');
    expect(listQuestions(contextRoot, manifest.slug)).toHaveLength(1);
    expect(readThread(contextRoot, manifest.slug).map((e) => e.event)).toContain('asked');
  });
});

describe('B5 — a document that DISCUSSES usage limits still publishes', () => {
  it('a long document with a heading that quotes the banner is published normally', async () => {
    // The false-positive direction, and the expensive one: a suppressed run reports failed
    // and writes nothing, with no symptom anywhere for the user to trace.
    const manifest = createApproved('writes-about-limits');
    const doc = `# Usage limits report\n\nThe CLI says "${BANNER}" when an account is capped. `
      + 'We saw this four times last month across two projects. '.repeat(10);
    const outcome = await runWith(manifest.slug, healthyEnvelope(doc));

    expect(outcome.status).toBe('ok');
    expect(outcome.outputPath).not.toBeNull();
    expect(existsSync(outcome.outputPath!)).toBe(true);
    expect(readFileSync(outcome.outputPath!, 'utf-8')).toBe(doc);
  });
});

describe('B6 — the structured readers on an envelope', () => {
  it('a rejected quotaLimits envelope is caught even when the result text is innocent', async () => {
    const manifest = createApproved('capped-structured');
    const outcome = await runWith(
      manifest.slug,
      healthyEnvelope('All good.').replace(
        '"is_error":false',
        '"is_error":false,"quotaLimits":{"status":"rejected","rateLimitType":"five_hour"}',
      ),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('5-hour usage limit');
  });

  it('a HEALTHY rate_limit_event on the envelope changes nothing', async () => {
    // The CLI emits one of these on EVERY turn; `status: allowed` is the common case and
    // must not disqualify a run. (The meter once exiled two accounts measured at 7% and
    // 19% — see the module header in claude-limit-signal.ts.)
    const manifest = createApproved('healthy-meter');
    const outcome = await runWith(
      manifest.slug,
      healthyEnvelope('# Digest\n\nAll good.\n').replace(
        '"is_error":false',
        '"is_error":false,"rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}',
      ),
    );
    expect(outcome.status).toBe('ok');
    expect(outcome.outputPath).not.toBeNull();
  });
});

describe('B7 — an uncapped run is byte-for-byte what it was', () => {
  it('publishes, records ok, and closes its thread with ok', async () => {
    const manifest = createApproved('healthy-plain');
    const doc = '# Digest\n\nWAU is down 4% week-over-week.\n';
    const outcome = await runWith(manifest.slug, healthyEnvelope(doc));

    expect(outcome.status).toBe('ok');
    expect(outcome.error).toBeNull();
    expect(readFileSync(outcome.outputPath!, 'utf-8')).toBe(doc);
    expect(readThread(contextRoot, manifest.slug).map((e) => e.event)).toEqual(['started', 'ok']);
  });
});

describe('the notification body is the agent’s own last post when it made one', () => {
  it('falls back to the document’s opening line when the run posted nothing', async () => {
    // Unchanged behaviour, kept as the control for the test below.
    const manifest = createApproved('banner-fallback');
    const banners: { title: string; body: string }[] = [];
    await runWith(manifest.slug, healthyEnvelope('WAU is down 4% week-over-week.\n\n# Detail\n\nmore\n'), {
      notify: (title, body) => banners.push({ title, body }),
    });
    expect(banners).toHaveLength(1);
    expect(banners[0].body).toBe('WAU is down 4% week-over-week.');
  });

  it('a run that POSTED is announced in its own words, not the document’s first line', async () => {
    // The agent chose that sentence for this human to read, and the banner is realistically
    // the only thing they see. Simulated the way it really happens: the child calls
    // `automations post` mid-run, so the entry lands after `started` and before the close.
    const manifest = createApproved('banner-from-post');
    const banners: string[] = [];
    const { child, emitClose, emitStdout } = makeFakeChild(5151);
    const run = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), killImpl: vi.fn(),
      notify: (_t, body) => banners.push(body), log: () => {},
    });
    appendThreadEntry(contextRoot, manifest.slug, {
      runId: NOW.toISOString(), kind: 'agent', via: 'cli',
      text: 'Three insights synced; WAU is down 4% week-over-week.',
    });
    emitStdout(healthyEnvelope('The digest is ready.\n\n# Detail\n\nmore\n'));
    emitClose(0);
    await run;

    expect(banners).toEqual(['Three insights synced; WAU is down 4% week-over-week.']);
    // Exactly one banner per run — the post did not add a second.
    expect(banners).toHaveLength(1);
  });

  it('a capped run notifies the limit sentence, and only once', async () => {
    const manifest = createApproved('banner-capped');
    const banners: { title: string; body: string }[] = [];
    await runWith(manifest.slug, cappedEnvelope(), { notify: (title, body) => banners.push({ title, body }) });
    expect(banners).toHaveLength(1);
    expect(banners[0].title).toContain('failed');
    expect(banners[0].body).toContain('usage limit');
  });

  it('notify: false silences the banner entirely, capped or not', async () => {
    const manifest = createApproved('banner-silent', { notify: false });
    const banners: string[] = [];
    await runWith(manifest.slug, cappedEnvelope(), { notify: (_t, body) => banners.push(body) });
    expect(banners).toEqual([]);
  });
});
