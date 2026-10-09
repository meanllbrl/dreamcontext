import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertTaskFilingBar, isSleepCycleLive, cycleTasksFiled, recordCycleTaskFiled,
  MIN_SLEEP_WHY_CHARS, type FilingActor, type FilingBarEmbedder, type FilingBarInput,
} from '../../src/lib/task-filing-bar.js';
import { appendTombstone } from '../../src/lib/task-tombstones.js';
import { appendDeclined } from '../../src/lib/task-declined.js';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { SLEEP_LOCK_STALE_MS } from '../../src/lib/sleep-consolidation.js';

// The embedder module is mocked so this file NEVER loads the real ONNX model and
// never depends on whether THIS machine happens to have the 113 MB weights on
// disk. `isEmbedModelDownloaded` is pinned TRUE on purpose: it is clause 1 of the
// availability check, and pinning it is what makes the clause-3 assertion below
// ("a usable cache that does not cover the task corpus is still no-index") a real
// regression guard rather than a machine-dependent accident. Every test that
// wants the gates to run injects its own deterministic `embed`.
vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 3,
  isEmbedModelDownloaded: () => true,
  embeddingsAvailable: async () => true,
  embedPassages: async () => null,
  embedQuery: async () => null,
}));

/**
 * B2. The bar is a floor against the EMPTY TEMPLATE, not a quality judge — B0
 * measured the thinnest REAL task on this brain at 146 characters of
 * justification and found exactly one task with none at all. What matters most
 * in these tests is who the bar does NOT stop: a person working while a
 * background cycle runs must get a clear way through, not a silent block.
 *
 * The semantic gates (neighbor, declined-by-meaning) are exercised with a
 * DETERMINISTIC fake embedder — the real ONNX model is never loaded, and every
 * verdict boundary is testable to the decimal. Where no embedder is injected the
 * temp vault has no embedding cache, so the gates are OFF and the pre-existing
 * behaviour below is byte-for-byte what it always was.
 */

let project = '';
let ctx = '';

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-bar-'));
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  delete process.env.DREAMCONTEXT_AUTO_SLEEP;
  delete process.env.DREAMCONTEXT_DECLINED_MATCH;
  delete process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC;
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  delete process.env.DREAMCONTEXT_AUTO_SLEEP;
  delete process.env.DREAMCONTEXT_DECLINED_MATCH;
  delete process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC;
});

function writeSleep(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({
    debt: 0, last_sleep: null, last_sleep_summary: null, sleep_started_at: null,
    sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [],
    compaction_log: [], pendingMigrationNotices: [], ...extra,
  }, null, 2));
}

const liveEpoch = () => new Date().toISOString();
const staleEpoch = () => new Date(Date.now() - SLEEP_LOCK_STALE_MS - 60_000).toISOString();
const GOOD_WHY = 'The dashboard shows a stale count because the cache is never invalidated on write.';

const bar = (actor: FilingActor, why?: string, slug?: string) =>
  assertTaskFilingBar({ contextRoot: ctx, actor, why, slug });

describe('when the bar applies at all', () => {
  it('is OFF with no sleep state at all', async () => {
    expect((await bar('unknown', '')).allowed).toBe(true);
    expect((await bar('unknown', '')).underBar).toBe(false);
  });

  it('is OFF when no cycle is running', async () => {
    writeSleep();
    expect(await bar('unknown', '')).toMatchObject({ allowed: true, underBar: false });
  });

  it('is ON during a live cycle', async () => {
    writeSleep({ sleep_started_at: liveEpoch() });
    expect(isSleepCycleLive(ctx)).toBe(true);
    expect((await bar('unknown', '')).allowed).toBe(false);
  });

  it('is OFF again once the lock goes STALE — a crashed sleep must not wedge it on forever', async () => {
    writeSleep({ sleep_started_at: staleEpoch() });
    expect(isSleepCycleLive(ctx)).toBe(false);
    expect(await bar('unknown', '')).toMatchObject({ allowed: true, underBar: false });
  });

  it('is ON under DREAMCONTEXT_AUTO_SLEEP even with no epoch stamped yet', async () => {
    writeSleep();
    process.env.DREAMCONTEXT_AUTO_SLEEP = '1';
    expect(isSleepCycleLive(ctx)).toBe(true);
    expect((await bar('unknown', '')).allowed).toBe(false);
  });

  it('is ON for an explicit `--by sleep` even outside a cycle — a specialist is taken at its word', async () => {
    writeSleep();
    expect((await bar('sleep', 'short')).allowed).toBe(false);
  });

  it('NEVER applies to an explicit human, cycle or not', async () => {
    writeSleep({ sleep_started_at: liveEpoch() });
    process.env.DREAMCONTEXT_AUTO_SLEEP = '1';
    expect(await bar('human', '')).toMatchObject({ allowed: true, underBar: false });
  });
});

describe('the justification floor', () => {
  beforeEach(() => writeSleep({ sleep_started_at: liveEpoch() }));

  it('refuses an empty Why — the exact shape of the one junk task on this brain', async () => {
    const v = await bar('sleep', '');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain(`at least ${MIN_SLEEP_WHY_CHARS} characters`);
  });

  it.each([undefined, null, '   ', '(To be defined)'])('refuses the placeholder %s', async (why) => {
    expect((await bar('sleep', why as string | undefined)).allowed).toBe(false);
  });

  it('accepts a real justification', async () => {
    expect(await bar('sleep', GOOD_WHY)).toMatchObject({ allowed: true, underBar: true });
  });

  it('tells an UNKNOWN caller the escape hatch, so a person is never silently blocked', async () => {
    expect((await bar('unknown', '')).reason).toContain('--by human');
  });

  it('does not dangle that hatch in front of a specialist that named itself', async () => {
    expect((await bar('sleep', '')).reason).not.toContain('--by human');
  });
});

describe('the per-cycle cap', () => {
  it('refuses once the configured cap is reached, and says where the candidate should go', async () => {
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 2 } });
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a', 'b'] });
    const v = await bar('sleep', GOOD_WHY);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('2/2');
    expect(v.reason).toContain('Candidates NOT filed (cap)');
  });

  it('allows up to the cap', async () => {
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 2 } });
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a'] });
    expect((await bar('sleep', GOOD_WHY)).allowed).toBe(true);
  });

  it('a cap of 0 files nothing at all, with its own message', async () => {
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 0 } });
    writeSleep({ sleep_started_at: liveEpoch() });
    expect((await bar('sleep', GOOD_WHY)).reason).toContain('files no tasks during sleep');
  });

  it('defaults to 5 when the brain configured nothing', async () => {
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a', 'b', 'c', 'd'] });
    expect((await bar('sleep', GOOD_WHY)).allowed).toBe(true);
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a', 'b', 'c', 'd', 'e'] });
    expect((await bar('sleep', GOOD_WHY)).allowed).toBe(false);
  });

  it('reports the CAP rather than the Why when both would fail — the cap is the real blocker', async () => {
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 1 } });
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a'] });
    expect((await bar('sleep', '')).reason).toContain('Cap reached');
  });

  it('recordCycleTaskFiled counts a slug once', () => {
    writeSleep({ sleep_started_at: liveEpoch() });
    recordCycleTaskFiled(ctx, 'x');
    recordCycleTaskFiled(ctx, 'x');
    recordCycleTaskFiled(ctx, 'y');
    expect(cycleTasksFiled(ctx)).toEqual(['x', 'y']);
  });

  it('recordCycleTaskFiled leaves the rest of the state alone', () => {
    writeSleep({ sleep_started_at: liveEpoch(), debt: 42 });
    recordCycleTaskFiled(ctx, 'x');
    const state = JSON.parse(readFileSync(join(ctx, 'state', '.sleep.json'), 'utf8'));
    expect(state.debt).toBe(42);
    expect(state.sleep_started_at).toBeTruthy();
  });
});

describe('a task that was deliberately consolidated away', () => {
  beforeEach(() => writeSleep({ sleep_started_at: liveEpoch() }));

  it('cannot be re-filed while the absorbing task is alive', async () => {
    appendTombstone(ctx, { slug: 'old-chore', deletedAt: new Date().toISOString(), absorbedBy: 'the-real-task' });
    const v = await bar('sleep', GOOD_WHY, 'old-chore');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('the-real-task');
    expect(v.reason).toContain('tombstones');
  });

  it('names the whole chain when it was absorbed transitively', async () => {
    const at = new Date().toISOString();
    appendTombstone(ctx, { slug: 'a', deletedAt: at, absorbedBy: 'b' });
    appendTombstone(ctx, { slug: 'b', deletedAt: at, absorbedBy: 'c' });
    expect((await bar('sleep', GOOD_WHY, 'a')).reason).toContain('a → b → c');
  });

  it('CAN be filed again when the chain dead-ends — the work was dropped, not moved', async () => {
    appendTombstone(ctx, { slug: 'gone', deletedAt: new Date().toISOString() });
    expect((await bar('sleep', GOOD_WHY, 'gone')).allowed).toBe(true);
  });

  it('never blocks a human, even on a tombstoned slug', async () => {
    appendTombstone(ctx, { slug: 'old-chore', deletedAt: new Date().toISOString(), absorbedBy: 'the-real-task' });
    expect((await bar('human', '', 'old-chore')).allowed).toBe(true);
  });
});

// ─── The semantic gates ─────────────────────────────────────────────────────
//
// Deterministic fake embedder, same idiom as tests/unit/dedup.test.ts: each text
// carries an `@v(x,y,z)` tag and is embedded as that direction, so the cosine
// between any two texts is exactly the dot of their tagged directions. The tag
// is put in the WHY (which is both the dedup body and the declined candidate
// text) and in each task body / declined reason.

function unit(x: number, y: number, z: number): Float32Array {
  const n = Math.hypot(x, y, z) || 1;
  return new Float32Array([x / n, y / n, z / n]);
}
function vecFor(text: string): Float32Array {
  const m = text.match(/@v\(([^)]+)\)/);
  if (!m) return unit(1, 0, 0);
  const [x, y, z] = m[1].split(',').map(Number);
  return unit(x, y, z);
}
const fakeEmbed: FilingBarEmbedder = async (texts) => texts.map(vecFor);
/** A direction at exact cosine `c` to `@v(1,0,0)` (in the x-y plane). */
function atCosine(c: number): string {
  const y = Math.sqrt(Math.max(0, 1 - c * c));
  return `@v(${c},${y},0)`;
}

/** The candidate always points at `@v(1,0,0)`; every fixture is placed relative to it. */
const CANDIDATE_WHY = `@v(1,0,0) ${GOOD_WHY}`;

function writeTask(slug: string, name: string, tag: string, dir = 'state'): void {
  mkdirSync(join(ctx, dir), { recursive: true });
  writeFileSync(
    join(ctx, dir, `${slug}.md`),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${tag} ${slug} body content here\n`,
  );
}
function writeDigest(sessionId: string, tag: string): void {
  mkdirSync(join(ctx, 'state', '.session-digests'), { recursive: true });
  writeFileSync(
    join(ctx, 'state', '.session-digests', `${sessionId}.md`),
    `---\nsession_id: ${sessionId}\ncreated_at: '2026-09-11T00:00:00.000Z'\n---\n\n${tag} what happened this session\n`,
  );
}
function decline(key: string, topic: string, reason: string): void {
  appendDeclined(ctx, {
    key, topic,
    declinedAt: '2026-09-10T12:00:00.000Z',
    reason,
  });
}

/** File a candidate as the cycle would, with the fake embedder wired in. */
const file = (over: Partial<FilingBarInput> = {}) =>
  assertTaskFilingBar({
    contextRoot: ctx,
    actor: 'sleep',
    name: 'A brand new concern',
    description: 'one line of scope',
    why: CANDIDATE_WHY,
    embed: fakeEmbed,
    ...over,
  });

describe('gate 5 — the nearest existing task', () => {
  beforeEach(() => writeSleep({ sleep_started_at: liveEpoch() }));

  it('MERGE band: refuses naming the twin and the fold-in command', async () => {
    writeTask('the-twin', 'The twin', atCosine(0.98));
    const v = await file();
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('`the-twin` already covers this');
    expect(v.reason).toContain('dreamcontext tasks insert the-twin acceptance_criteria');
    expect(v.neighbor).toMatchObject({ state: 'checked', verdict: 'merge' });
  });

  it('MERGE band has NO --neighbor-checked escape — naming it changes nothing', async () => {
    writeTask('the-twin', 'The twin', atCosine(0.98));
    const v = await file({ neighborChecked: 'the-twin' });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('already covers this');
  });

  it('an ARCHIVED task is a valid neighbor, and the message says where it lives', async () => {
    writeTask('old-twin', 'Old twin', atCosine(0.98), join('state', 'archive'));
    const v = await file();
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('`old-twin`');
    expect(v.reason).toContain('state/archive/');
  });

  it('REVIEW band: refuses and names the exact flag that lifts it', async () => {
    writeTask('nearby', 'Nearby work', atCosine(0.93));
    const v = await file();
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('Nearest task is `nearby`');
    expect(v.reason).toContain('--neighbor-checked nearby');
    expect(v.neighbor).toMatchObject({ state: 'checked', verdict: 'review' });
  });

  it('REVIEW band is lifted by naming that neighbor — and the verdict is still recorded', async () => {
    writeTask('nearby', 'Nearby work', atCosine(0.93));
    const v = await file({ neighborChecked: 'nearby' });
    expect(v.allowed).toBe(true);
    expect(v.neighbor).toMatchObject({ state: 'checked', verdict: 'review' });
    expect(v.neighbor && v.neighbor.state === 'checked' && v.neighbor.top?.slug).toBe('nearby');
  });

  it('a WRONG --neighbor-checked is still refused, and the message names both', async () => {
    writeTask('nearby', 'Nearby work', atCosine(0.93));
    const v = await file({ neighborChecked: 'some-other-task' });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('nearby');
    expect(v.reason).toContain('some-other-task');
  });

  it('accepts the docKey form: --neighbor-checked task/nearby', async () => {
    writeTask('nearby', 'Nearby work', atCosine(0.93));
    expect((await file({ neighborChecked: 'task/nearby' })).allowed).toBe(true);
  });

  it('a SESSION DIGEST is never the neighbor — it is not a doc anything folds into', async () => {
    writeDigest('sess-1', '@v(1,0,0)');
    const v = await file();
    expect(v.allowed).toBe(true);
    expect(v.neighbor).toMatchObject({ state: 'checked', verdict: 'create' });
  });

  it('CREATE verdict passes untouched', async () => {
    writeTask('unrelated', 'Unrelated', atCosine(0.4));
    const v = await file();
    expect(v).toMatchObject({ allowed: true, underBar: true });
    expect(v.neighbor).toMatchObject({ state: 'checked', verdict: 'create' });
  });

  it('never runs for an explicit human — no embedder call at all', async () => {
    writeTask('the-twin', 'The twin', atCosine(0.98));
    let calls = 0;
    const spy: FilingBarEmbedder = async (t) => { calls++; return t.map(vecFor); };
    const v = await file({ actor: 'human', embed: spy });
    expect(v).toMatchObject({ allowed: true, underBar: false });
    expect(calls).toBe(0);
  });
});

describe('when the semantic gates cannot run, the bar passes AND SAYS SO', () => {
  beforeEach(() => writeSleep({ sleep_started_at: liveEpoch() }));

  it('semantic:false — allowed, marked unavailable, with a notice naming both skipped checks', async () => {
    writeTask('the-twin', 'The twin', atCosine(0.98));
    const v = await file({ semantic: false });
    expect(v.allowed).toBe(true);
    expect(v.neighbor).toEqual({ state: 'unavailable', why: 'disabled' });
    expect(v.notices?.[0]).toContain('neighbor check skipped');
    expect(v.notices?.[0]).toContain('declined ideas were matched by exact slug only');
  });

  it('an unindexed vault (the default here) skips with why:no-index — not a silent pass', async () => {
    writeTask('the-twin', 'The twin', atCosine(0.98));
    const v = await assertTaskFilingBar({
      contextRoot: ctx, actor: 'sleep', name: 'A brand new concern', why: CANDIDATE_WHY,
    });
    expect(v.allowed).toBe(true);
    expect(v.neighbor).toEqual({ state: 'unavailable', why: 'no-index' });
    expect(v.notices?.[0]).toContain('neighbor check skipped');
  });

  it('the kill switch turns them off even on a warm vault', async () => {
    process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC = '0';
    writeTask('the-twin', 'The twin', atCosine(0.98));
    const v = await assertTaskFilingBar({
      contextRoot: ctx, actor: 'sleep', name: 'A brand new concern', why: CANDIDATE_WHY,
    });
    expect(v.neighbor).toEqual({ state: 'unavailable', why: 'disabled' });
  });

  it('a model that answers null degrades to unavailable, allowed', async () => {
    writeTask('the-twin', 'The twin', atCosine(0.98));
    const v = await file({ embed: async () => null });
    expect(v.allowed).toBe(true);
    expect(v.neighbor).toEqual({ state: 'unavailable', why: 'model-unavailable' });
    expect(v.notices?.[0]).toContain('neighbor check skipped');
  });

  it('an embedder that makes dedup THROW never crashes the create', async () => {
    writeTask('the-twin', 'The twin', atCosine(0.98));
    // Un-normalized vectors trip dedup's assertComparable, which throws loudly.
    const v = await file({ embed: async (t) => t.map(() => new Float32Array([2, 0, 0])) });
    expect(v.allowed).toBe(true);
    expect(v.neighbor).toEqual({ state: 'unavailable', why: 'model-unavailable' });
  });
});

describe('gates 4 and 6 — an idea a human already declined', () => {
  beforeEach(() => writeSleep({ sleep_started_at: liveEpoch() }));

  it('gate 4: an EXACT key match is refused with the date, the reason and the way back', async () => {
    decline('a-brand-new-concern', 'A brand new concern', 'we decided to ship the simple version instead');
    const v = await file();
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('Declined on 2026-09-10');
    expect(v.reason).toContain('A brand new concern');
    expect(v.reason).toContain('we decided to ship the simple version instead');
    expect(v.reason).toContain('dreamcontext tasks undecline a-brand-new-concern');
    expect(v.declined).toMatchObject({ key: 'a-brand-new-concern', match: 'slug' });
  });

  it('gate 4 needs NO embedder — the exact match runs before any model work', async () => {
    decline('a-brand-new-concern', 'A brand new concern', 'dropped in the next session, it was a dead end');
    let calls = 0;
    const spy: FilingBarEmbedder = async (t) => { calls++; return t.map(vecFor); };
    expect((await file({ embed: spy })).allowed).toBe(false);
    expect(calls).toBe(0);
  });

  it('gate 6: a semantic match at 0.86 is refused and names --declined-checked', async () => {
    decline('dropped-idea', 'A dropped idea', `${atCosine(0.86)} we are not doing this, the owner said no`);
    const v = await file();
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('Looks like a declined idea');
    expect(v.reason).toContain('--declined-checked dropped-idea');
    expect(v.declined).toMatchObject({ key: 'dropped-idea', match: 'semantic' });
    expect(v.declined?.sim).toBeCloseTo(0.86, 5);
  });

  it('gate 6: below the floor (0.80) it never fires', async () => {
    decline('dropped-idea', 'A dropped idea', `${atCosine(0.8)} unrelated reasoning about something else`);
    const v = await file();
    expect(v.allowed).toBe(true);
    expect(v.declined).toBeUndefined();
  });

  it('gate 6 is a PROOF-OF-LOOKING gate: naming the key lifts it, and the match is still reported', async () => {
    decline('dropped-idea', 'A dropped idea', `${atCosine(0.86)} we are not doing this, the owner said no`);
    const v = await file({ declinedChecked: 'dropped-idea' });
    expect(v.allowed).toBe(true);
    expect(v.declined).toMatchObject({ key: 'dropped-idea', match: 'semantic' });
  });

  it('a WRONG --declined-checked is still refused, and the message names both', async () => {
    decline('dropped-idea', 'A dropped idea', `${atCosine(0.86)} we are not doing this, the owner said no`);
    const v = await file({ declinedChecked: 'some-other-idea' });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('dropped-idea');
    expect(v.reason).toContain('some-other-idea');
  });

  it('DREAMCONTEXT_DECLINED_MATCH is read at CALL time, so 0.9 lets 0.86 through', async () => {
    decline('dropped-idea', 'A dropped idea', `${atCosine(0.86)} we are not doing this, the owner said no`);
    process.env.DREAMCONTEXT_DECLINED_MATCH = '0.9';
    expect((await file()).allowed).toBe(true);
  });

  it('never runs for an explicit human — no embedder call, exact match not consulted', async () => {
    decline('a-brand-new-concern', 'A brand new concern', 'we decided to ship the simple version instead');
    let calls = 0;
    const spy: FilingBarEmbedder = async (t) => { calls++; return t.map(vecFor); };
    const v = await file({ actor: 'human', embed: spy });
    expect(v).toMatchObject({ allowed: true, underBar: false });
    expect(calls).toBe(0);
  });
});

describe('gate ORDER — the cheap deterministic checks come first', () => {
  it('a capped candidate that is ALSO a declined twin reports the CAP, and embeds nothing', async () => {
    updateSetupConfig(project, { sleep: { maxNewTasksPerCycle: 1 } });
    writeSleep({ sleep_started_at: liveEpoch(), cycle_tasks_filed: ['a'] });
    writeTask('the-twin', 'The twin', atCosine(0.98));
    decline('a-brand-new-concern', 'A brand new concern', 'we decided to ship the simple version instead');
    let calls = 0;
    const spy: FilingBarEmbedder = async (t) => { calls++; return t.map(vecFor); };
    const v = await file({ embed: spy });
    expect(v.reason).toContain('Cap reached');
    expect(calls).toBe(0);
  });

  it('a thin --why is reported before any neighbor work', async () => {
    writeSleep({ sleep_started_at: liveEpoch() });
    writeTask('the-twin', 'The twin', atCosine(0.98));
    let calls = 0;
    const spy: FilingBarEmbedder = async (t) => { calls++; return t.map(vecFor); };
    const v = await file({ why: 'too short', embed: spy });
    expect(v.reason).toContain(`at least ${MIN_SLEEP_WHY_CHARS} characters`);
    expect(calls).toBe(0);
  });

  it('a tombstoned slug is reported before any neighbor work', async () => {
    writeSleep({ sleep_started_at: liveEpoch() });
    writeTask('the-twin', 'The twin', atCosine(0.98));
    appendTombstone(ctx, { slug: 'old-chore', deletedAt: new Date().toISOString(), absorbedBy: 'the-real-task' });
    let calls = 0;
    const spy: FilingBarEmbedder = async (t) => { calls++; return t.map(vecFor); };
    const v = await file({ slug: 'old-chore', name: 'old chore', embed: spy });
    expect(v.reason).toContain('the-real-task');
    expect(calls).toBe(0);
  });
});
