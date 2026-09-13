/**
 * Unit tests for the opt-in context handoff's measurement + state layer
 * (`context-watch.ts`) and its config surface (`setup-config.ts`):
 *   - contextTokensFromUsage is the ONE formula (all four components, junk ⇒ 0)
 *   - the tail reader: reads only the tail, drops the partial first line, skips
 *     sidechains, survives a missing/corrupt file
 *   - isMainChainHookInput: agent_id / agent_type / `/subagents/` / sidechain tail
 *   - shouldNudge: the full matrix (off, below, first rung, ladder, repeat)
 *   - renderNudge: both commands, the "you decide" clause, the next rung
 *   - resolveContextHandoff: defaults, partials, junk, and NO floor (the floors
 *     live at the CLI write boundary — see the module's doc comment)
 *   - the handoff record: write / overwrite / stamp / consume, and the banner
 *     selection matrix INCLUDING the automation-hijack case
 *   - resolveTabSeed precedence: brain-local > .config.json > off
 *   - readBrainLocal validation of contextHandoffDefault
 *   - the tab file survives a /clear while the nudge ladder resets
 *   - pruning: 7 days for ladders/records, 30 for tab files
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contextTokensFromUsage,
  tailRecords,
  lastMainChainContext,
  isMainChainHookInput,
  shouldNudge,
  renderNudge,
  readNudgeState,
  writeNudgeState,
  readTabHandoff,
  writeTabHandoff,
  resolveHandoffFor,
  resolveTabSeed,
  writeHandoffRecord,
  readHandoffRecord,
  stampHandoffRecord,
  listHandoffRecords,
  selectHandoffForSessionStart,
  shouldRotateForHandoff,
  renderHandoffBanner,
  pruneContextWatch,
  maybeNudge,
  handoffKey,
  activeTaskForNudge,
  contextWatchDir,
  handoffDir,
  TABLESS_HANDOFF_MAX_AGE_MS,
  type HandoffRecord,
} from '../../src/lib/context-watch.js';
import {
  updateSetupConfig,
  readSetupConfig,
  resolveContextHandoff,
  CONTEXT_HANDOFF_DEFAULTS,
  readBrainLocal,
  writeBrainLocal,
} from '../../src/lib/setup-config.js';

const SES = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SES2 = '99999999-8888-7777-6666-555555555555';
const TAB = '11111111-2222-3333-4444-555555555555';
const TAB2 = '22222222-3333-4444-5555-666666666666';

const LADDER = { enabled: true, nudgeAt: 200_000, remindEvery: 100_000 };

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-ctx-watch-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Write a JSONL transcript from record objects. */
function transcript(records: unknown[], name = 'x.jsonl'): string {
  const p = join(projectRoot, name);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

const usage = (o: Partial<Record<string, number>>) => ({ message: { usage: o } });

// ─── the one formula ──────────────────────────────────────────────────────────

describe('contextTokensFromUsage', () => {
  it('sums all four components — input, cache write, cache read, output', () => {
    expect(contextTokensFromUsage({
      input_tokens: 10,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 3000,
      output_tokens: 40,
    })).toBe(3250);
  });

  it('treats missing / non-numeric components as zero rather than NaN', () => {
    // A NaN here would propagate into `ctx >= nudgeAt`, which is false for NaN — so the
    // feature would silently never fire. Zero is the honest and the safe answer.
    expect(contextTokensFromUsage({ input_tokens: 5, cache_read_input_tokens: 'lots' as unknown as number })).toBe(5);
    expect(contextTokensFromUsage({})).toBe(0);
    expect(contextTokensFromUsage(null)).toBe(0);
    expect(contextTokensFromUsage(undefined)).toBe(0);
  });
});

// ─── the tail reader ──────────────────────────────────────────────────────────

describe('tailRecords / lastMainChainContext', () => {
  it('reads the LAST main-chain usage record, not a running sum', () => {
    const p = transcript([
      usage({ input_tokens: 1, cache_read_input_tokens: 100 }),
      usage({ input_tokens: 2, cache_read_input_tokens: 500 }),
    ]);
    expect(lastMainChainContext(p)).toBe(502);
  });

  it('SKIPS sidechain records — a sub-agent lives in its own window', () => {
    // The STEP 0 spike proved a sub-agent's records land in the PARENT transcript, so
    // this is the guard that stops a sub-agent's footprint being read as the main chain's.
    const p = transcript([
      usage({ cache_read_input_tokens: 300_000 }),
      { isSidechain: true, ...usage({ cache_read_input_tokens: 9 }) },
    ]);
    expect(lastMainChainContext(p)).toBe(300_000);
  });

  it('reads ONLY the tail, and drops the truncated first line', () => {
    const big = 'x'.repeat(1024);
    const p = transcript([
      { pad: big, ...usage({ cache_read_input_tokens: 111 }) },
      { pad: big, ...usage({ cache_read_input_tokens: 222 }) },
    ]);
    // A window smaller than the file: the first record is unreachable AND the line we
    // land mid-way through must not be parsed as if it were whole.
    const recs = tailRecords(p, 2048);
    expect(recs.length).toBe(1);
    expect(lastMainChainContext(p, 2048)).toBe(222);
  });

  it('returns null / [] for a missing or unparseable transcript instead of throwing', () => {
    expect(lastMainChainContext(join(projectRoot, 'nope.jsonl'))).toBeNull();
    expect(tailRecords(join(projectRoot, 'nope.jsonl'))).toEqual([]);
    const junk = join(projectRoot, 'junk.jsonl');
    writeFileSync(junk, 'not json\n{also not\n', 'utf-8');
    expect(lastMainChainContext(junk)).toBeNull();
  });

  it('returns null when the tail holds no usage record at all', () => {
    expect(lastMainChainContext(transcript([{ type: 'user' }, { type: 'summary' }]))).toBeNull();
  });
});

// ─── main chain vs sub-agent ──────────────────────────────────────────────────

describe('isMainChainHookInput', () => {
  const path = () => transcript([usage({ cache_read_input_tokens: 10 })]);

  it('accepts a parent payload — no agent fields, no sidechain tail', () => {
    expect(isMainChainHookInput({ transcript_path: path(), session_id: SES })).toBe(true);
  });

  it('rejects on agent_id and on agent_type — the field names the spike pinned', () => {
    const p = path();
    expect(isMainChainHookInput({ transcript_path: p, agent_id: 'ad27a8b8ac307e324' })).toBe(false);
    expect(isMainChainHookInput({ transcript_path: p, agent_type: 'general-purpose' })).toBe(false);
  });

  it('rejects a /subagents/ transcript path', () => {
    expect(isMainChainHookInput({ transcript_path: '/tmp/p/subagents/agent-x.jsonl' })).toBe(false);
  });

  it('rejects when the newest USAGE record in the tail is a sidechain', () => {
    const p = transcript([
      usage({ cache_read_input_tokens: 10 }),
      { isSidechain: true, ...usage({ cache_read_input_tokens: 20 }) },
    ]);
    expect(isMainChainHookInput({ transcript_path: p })).toBe(false);
  });

  it('ignores trailing non-usage records when deciding — they answer a different question', () => {
    // A tool_result with no chain marker is the common last line; reading it as
    // "main chain" (or as "unknown, therefore sub-agent") would both be wrong.
    const p = transcript([
      { isSidechain: true, ...usage({ cache_read_input_tokens: 20 }) },
      { type: 'user', toolUseResult: {} },
    ]);
    expect(isMainChainHookInput({ transcript_path: p })).toBe(false);
  });
});

// ─── the ladder ───────────────────────────────────────────────────────────────

describe('shouldNudge', () => {
  it('never fires when the feature is off, however big the window', () => {
    expect(shouldNudge(null, 5_000_000, { ...LADDER, enabled: false })).toBe(false);
  });

  it('stays silent below the threshold', () => {
    expect(shouldNudge(null, 199_999, LADDER)).toBe(false);
  });

  it('fires the first rung at exactly the threshold', () => {
    expect(shouldNudge(null, 200_000, LADDER)).toBe(true);
  });

  it('does NOT re-fire until remindEvery more tokens have accumulated', () => {
    const state = { lastNudgedAt: 210_000, nudges: 1 };
    expect(shouldNudge(state, 260_000, LADDER)).toBe(false);
    expect(shouldNudge(state, 309_999, LADDER)).toBe(false);
    expect(shouldNudge(state, 310_000, LADDER)).toBe(true);
  });

  it('measures the next rung from WHERE WE NUDGED, not from the threshold', () => {
    // A session already at 400k when the feature is switched on must not be nudged
    // on every turn afterwards just because it is far past 200k.
    const state = { lastNudgedAt: 400_000, nudges: 1 };
    expect(shouldNudge(state, 450_000, LADDER)).toBe(false);
    expect(shouldNudge(state, 500_000, LADDER)).toBe(true);
  });
});

describe('nudge state round-trip', () => {
  it('records the rung and counts the nudges', () => {
    expect(readNudgeState(contextRoot, SES)).toBeNull();
    writeNudgeState(contextRoot, SES, 205_000);
    expect(readNudgeState(contextRoot, SES)).toEqual({ lastNudgedAt: 205_000, nudges: 1 });
    writeNudgeState(contextRoot, SES, 320_000);
    expect(readNudgeState(contextRoot, SES)).toEqual({ lastNudgedAt: 320_000, nudges: 2 });
  });

  it('is keyed per conversation, and reads corrupt state as "never nudged"', () => {
    writeNudgeState(contextRoot, SES, 205_000);
    expect(readNudgeState(contextRoot, SES2)).toBeNull();
    writeFileSync(join(contextWatchDir(contextRoot), `${SES}.json`), '{ broken', 'utf-8');
    expect(readNudgeState(contextRoot, SES)).toBeNull();
  });

  it('refuses an unsafe session id as a filename', () => {
    writeNudgeState(contextRoot, '../../escape', 1);
    expect(existsSync(join(projectRoot, 'escape.json'))).toBe(false);
  });
});

// ─── the nudge text ───────────────────────────────────────────────────────────

describe('renderNudge', () => {
  it('names both commands with the real slug, the numbers, and the next rung', () => {
    const text = renderNudge(240_000, LADDER, 'my-task');
    expect(text).toContain('240k');
    expect(text).toContain('200k');
    expect(text).toContain('dreamcontext tasks log my-task');
    expect(text).toContain('dreamcontext tasks handoff my-task');
    expect(text).toContain('340k'); // 240k + remindEvery
  });

  it('states the mechanism — every further turn re-reads all of it', () => {
    expect(renderNudge(240_000, LADDER, 'my-task')).toContain('re-reads all of it');
  });

  it('ALWAYS carries the explicit permission to ignore it — the feature is a nudge', () => {
    // If this assertion ever fails the feature has become an instruction, which is the
    // one thing the owner ruled out. It is tested on both the with- and without-task paths.
    for (const slug of ['my-task', null]) {
      const text = renderNudge(240_000, LADDER, slug);
      expect(text).toContain('YOU DECIDE');
      expect(text).toMatch(/nudge, not an instruction/);
    }
  });

  it('tells the agent to create a task first when none is in progress', () => {
    const text = renderNudge(240_000, LADDER, null);
    expect(text).toContain('<task-slug>');
    expect(text).toContain('dreamcontext tasks create');
  });
});

describe('activeTaskForNudge', () => {
  const task = (slug: string, status: string, updated: string, name?: string) =>
    writeFileSync(
      join(contextRoot, 'state', `${slug}.md`),
      `---\nname: ${name ?? slug}\nstatus: ${status}\nupdated_at: '${updated}'\n---\n\n## Why\n`,
      'utf-8',
    );

  it('picks the most recently updated in_progress task', () => {
    task('old-one', 'in_progress', '2026-01-01');
    task('new-one', 'in_progress', '2026-09-01', 'The newer one');
    task('done-one', 'completed', '2026-09-10');
    expect(activeTaskForNudge(contextRoot)).toEqual({ slug: 'new-one', title: 'The newer one' });
  });

  it('returns null when nothing is active', () => {
    task('done-one', 'completed', '2026-09-10');
    expect(activeTaskForNudge(contextRoot)).toBeNull();
    rmSync(join(contextRoot, 'state'), { recursive: true, force: true });
    expect(activeTaskForNudge(contextRoot)).toBeNull();
  });
});

// ─── config defaulting ────────────────────────────────────────────────────────

describe('resolveContextHandoff', () => {
  it('defaults to OFF at 200k / 100k when absent', () => {
    expect(resolveContextHandoff(undefined)).toEqual(CONTEXT_HANDOFF_DEFAULTS);
    expect(resolveContextHandoff(null)).toEqual({ enabled: false, nudgeAt: 200_000, remindEvery: 100_000 });
  });

  it('fills only the missing half of a partial block', () => {
    expect(resolveContextHandoff({ enabled: true })).toEqual({ enabled: true, nudgeAt: 200_000, remindEvery: 100_000 });
    expect(resolveContextHandoff({ enabled: true, nudgeAt: 300_000 }).remindEvery).toBe(100_000);
  });

  it('falls back to the defaults for junk, NaN, Infinity and non-positive values', () => {
    const junk = { enabled: 'yes', nudgeAt: 'big', remindEvery: NaN } as never;
    expect(resolveContextHandoff(junk)).toEqual(CONTEXT_HANDOFF_DEFAULTS);
    expect(resolveContextHandoff({ nudgeAt: Infinity }).nudgeAt).toBe(200_000);
    expect(resolveContextHandoff({ nudgeAt: 0 }).nudgeAt).toBe(200_000);
    expect(resolveContextHandoff({ nudgeAt: -5 }).nudgeAt).toBe(200_000);
  });

  it('honours a SMALL positive ladder — the floors are a CLI typo guard, not a resolver rule', () => {
    // Load-bearing for the runtime verification, which drives a scratch vault at
    // 3000 / 2000. A resolver floor here would rewrite those to the defaults and no
    // nudge could ever fire. See the doc comment on CONTEXT_HANDOFF_MIN_NUDGE_AT.
    expect(resolveContextHandoff({ enabled: true, nudgeAt: 3000, remindEvery: 2000 }))
      .toEqual({ enabled: true, nudgeAt: 3000, remindEvery: 2000 });
  });

  it('enabled is STRICTLY true — a truthy string does not switch the feature on', () => {
    expect(resolveContextHandoff({ enabled: 'true' as never }).enabled).toBe(false);
  });
});

// ─── per-pane toggle + precedence ─────────────────────────────────────────────

describe('the tab file and the resolution ladder', () => {
  it('round-trips a pane toggle', () => {
    expect(readTabHandoff(contextRoot, TAB)).toBeNull();
    const written = writeTabHandoff(contextRoot, TAB, { enabled: true });
    expect(written?.enabled).toBe(true);
    expect(readTabHandoff(contextRoot, TAB)?.enabled).toBe(true);
    expect(readTabHandoff(contextRoot, TAB)?.updatedAt).toBeTruthy();
  });

  it('resolves tab file > .config.json > off', () => {
    // no tab file, no config ⇒ off
    expect(resolveHandoffFor(contextRoot, projectRoot, TAB).enabled).toBe(false);

    writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({
      platforms: [], packs: [], multiProduct: false, setupVersion: '1',
      contextHandoff: { enabled: true, nudgeAt: 250_000 },
    }), 'utf-8');
    // config on, no tab file ⇒ on (this is the terminal/CLI path too)
    expect(resolveHandoffFor(contextRoot, projectRoot, null).enabled).toBe(true);
    expect(resolveHandoffFor(contextRoot, projectRoot, null).nudgeAt).toBe(250_000);

    // a pane toggled OFF overrides a vault that says on
    writeTabHandoff(contextRoot, TAB, { enabled: false });
    expect(resolveHandoffFor(contextRoot, projectRoot, TAB).enabled).toBe(false);
    // ...and the sibling pane is untouched
    expect(resolveHandoffFor(contextRoot, projectRoot, TAB2).enabled).toBe(true);
  });

  it('keeps the pane toggle across a /clear while the nudge ladder RESTARTS', () => {
    // The toggle is keyed by PANE, the ladder by CONVERSATION — that split is what
    // lets a fresh session climb from zero without losing the user's setting.
    writeTabHandoff(contextRoot, TAB, { enabled: true });
    writeNudgeState(contextRoot, SES, 205_000);

    // /clear: same pane, new conversation id.
    expect(readTabHandoff(contextRoot, TAB)?.enabled).toBe(true);
    expect(readNudgeState(contextRoot, SES2)).toBeNull();
    expect(shouldNudge(readNudgeState(contextRoot, SES2), 10_000, LADDER)).toBe(false);
  });
});

describe('resolveTabSeed', () => {
  it('prefers brain-local over .config.json over off', () => {
    expect(resolveTabSeed(true, { enabled: false }).enabled).toBe(true);
    expect(resolveTabSeed(false, { enabled: true }).enabled).toBe(false);
    expect(resolveTabSeed(undefined, { enabled: true }).enabled).toBe(true);
    expect(resolveTabSeed(undefined, undefined).enabled).toBe(false);
  });

  it('takes the LADDER from config even when brain-local decides the switch', () => {
    expect(resolveTabSeed(true, { enabled: false, nudgeAt: 250_000 }))
      .toEqual({ enabled: true, nudgeAt: 250_000, remindEvery: 100_000 });
  });
});

describe('brain-local contextHandoffDefault', () => {
  it('round-trips, and is scoped to the project root it was written under', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'dc-ctx-other-'));
    try {
      mkdirSync(join(otherRoot, '_dream_context', 'state'), { recursive: true });
      writeBrainLocal(projectRoot, { contextHandoffDefault: true });
      expect(readBrainLocal(projectRoot).contextHandoffDefault).toBe(true);
      // Vault A on must leave vault B untouched — the whole reason this is not app-global.
      expect(readBrainLocal(otherRoot).contextHandoffDefault).toBeUndefined();
      expect(resolveTabSeed(readBrainLocal(otherRoot).contextHandoffDefault, undefined).enabled).toBe(false);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('validates the field on read — a non-boolean is dropped, not coerced', () => {
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(join(contextRoot, 'state', '.brain-local.json'), JSON.stringify({ contextHandoffDefault: 'yes' }), 'utf-8');
    expect(readBrainLocal(projectRoot).contextHandoffDefault).toBeUndefined();
  });

  it('preserves the other brain-local fields when merging the new one', () => {
    writeBrainLocal(projectRoot, { activePersonSlug: 'someone' });
    writeBrainLocal(projectRoot, { contextHandoffDefault: true });
    const local = readBrainLocal(projectRoot);
    expect(local.activePersonSlug).toBe('someone');
    expect(local.contextHandoffDefault).toBe(true);
  });
});

// ─── the handoff record ───────────────────────────────────────────────────────

const rec = (over: Partial<HandoffRecord> = {}): HandoffRecord => ({
  task: 'my-task',
  title: 'My task',
  at: new Date().toISOString(),
  contextTokens: 205_000,
  fromSession: SES,
  tab: TAB,
  ...over,
});

describe('the handoff record', () => {
  it('writes and reads back', () => {
    expect(writeHandoffRecord(contextRoot, TAB, rec())).toBe(true);
    const read = readHandoffRecord(contextRoot, TAB);
    expect(read?.task).toBe('my-task');
    expect(read?.contextTokens).toBe(205_000);
    expect(read?.actedAt).toBeUndefined();
  });

  it('OVERWRITES on a second handoff — the newer state is the true one', () => {
    writeHandoffRecord(contextRoot, TAB, rec({ task: 'first' }));
    writeHandoffRecord(contextRoot, TAB, rec({ task: 'second' }));
    expect(readHandoffRecord(contextRoot, TAB)?.task).toBe('second');
    expect(listHandoffRecords(contextRoot).length).toBe(1);
  });

  it('stamps actedAt and consumedAt independently — neither writer clobbers the other', () => {
    writeHandoffRecord(contextRoot, TAB, rec());
    stampHandoffRecord(contextRoot, TAB, { actedAt: '2026-09-13T00:00:00Z' });
    stampHandoffRecord(contextRoot, TAB, { consumedAt: '2026-09-13T00:01:00Z' });
    const read = readHandoffRecord(contextRoot, TAB);
    expect(read?.actedAt).toBe('2026-09-13T00:00:00Z');
    expect(read?.consumedAt).toBe('2026-09-13T00:01:00Z');
    expect(read?.task).toBe('my-task');
  });

  it('reads a corrupt or shapeless record as absent', () => {
    mkdirSync(handoffDir(contextRoot), { recursive: true });
    writeFileSync(join(handoffDir(contextRoot), `${TAB}.json`), '{ not json', 'utf-8');
    expect(readHandoffRecord(contextRoot, TAB)).toBeNull();
    writeFileSync(join(handoffDir(contextRoot), `${TAB}.json`), JSON.stringify({ nope: 1 }), 'utf-8');
    expect(readHandoffRecord(contextRoot, TAB)).toBeNull();
    expect(listHandoffRecords(contextRoot)).toEqual([]);
  });

  it('keys by pane, then conversation, then a manual stamp', () => {
    expect(handoffKey({ DREAMCONTEXT_TAB_SESSION: TAB, CLAUDE_CODE_SESSION_ID: SES } as never)).toBe(TAB);
    expect(handoffKey({ CLAUDE_CODE_SESSION_ID: SES } as never)).toBe(SES);
    expect(handoffKey({} as never)).toMatch(/^manual-\d+$/);
    // An unsafe pane id must not become a filename.
    expect(handoffKey({ DREAMCONTEXT_TAB_SESSION: '../../x' } as never)).toMatch(/^manual-\d+$/);
  });
});

// ─── the banner selection matrix ──────────────────────────────────────────────

describe('selectHandoffForSessionStart', () => {
  it('with a tab: returns that pane record on any source but compact', () => {
    writeHandoffRecord(contextRoot, TAB, rec());
    for (const source of ['startup', 'resume', 'clear']) {
      expect(selectHandoffForSessionStart(contextRoot, source, TAB)?.key).toBe(TAB);
    }
    expect(selectHandoffForSessionStart(contextRoot, 'compact', TAB)).toBeNull();
  });

  it('never returns an ALREADY-CONSUMED record — the banner prints exactly once', () => {
    writeHandoffRecord(contextRoot, TAB, rec());
    expect(selectHandoffForSessionStart(contextRoot, 'clear', TAB)).not.toBeNull();
    stampHandoffRecord(contextRoot, TAB, { consumedAt: new Date().toISOString() });
    expect(selectHandoffForSessionStart(contextRoot, 'clear', TAB)).toBeNull();
  });

  it('with a tab: ignores ANOTHER pane’s record', () => {
    writeHandoffRecord(contextRoot, TAB2, rec({ tab: TAB2 }));
    expect(selectHandoffForSessionStart(contextRoot, 'clear', TAB)).toBeNull();
  });

  it('AUTOMATION HIJACK: a tab-less startup/resume session can neither receive nor consume one', () => {
    // The guard this function exists for. A headless automation run starts with
    // source=startup and no pane id; if it could claim a pending handoff it would print
    // the banner into a transcript nobody reads AND mark the record used, so the real
    // fresh session would never see it.
    writeHandoffRecord(contextRoot, 'manual-1', rec({ tab: null }));
    expect(selectHandoffForSessionStart(contextRoot, 'startup', null)).toBeNull();
    expect(selectHandoffForSessionStart(contextRoot, 'resume', null)).toBeNull();
    expect(selectHandoffForSessionStart(contextRoot, 'compact', null)).toBeNull();
    expect(selectHandoffForSessionStart(contextRoot, undefined, null)).toBeNull();
    // ...and the record is still there, unconsumed, for whoever legitimately clears.
    expect(readHandoffRecord(contextRoot, 'manual-1')?.consumedAt).toBeUndefined();
  });

  it('tab-less: claims the NEWEST unconsumed record on source=clear', () => {
    const now = Date.now();
    writeHandoffRecord(contextRoot, 'manual-1', rec({ tab: null, task: 'older', at: new Date(now - 60_000).toISOString() }));
    writeHandoffRecord(contextRoot, 'manual-2', rec({ tab: null, task: 'newer', at: new Date(now - 1_000).toISOString() }));
    expect(selectHandoffForSessionStart(contextRoot, 'clear', null, now)?.record.task).toBe('newer');
  });

  it('tab-less: refuses a record older than the 15-minute window', () => {
    const now = Date.now();
    writeHandoffRecord(contextRoot, 'manual-1', rec({
      tab: null,
      at: new Date(now - TABLESS_HANDOFF_MAX_AGE_MS - 1000).toISOString(),
    }));
    expect(selectHandoffForSessionStart(contextRoot, 'clear', null, now)).toBeNull();
  });
});

describe('renderHandoffBanner', () => {
  it('names the task, its slug, the size and the file to read first', () => {
    const text = renderHandoffBanner(rec({ title: 'My task', task: 'my-task', contextTokens: 205_000 }));
    expect(text).toContain('HANDOFF');
    expect(text).toContain('My task');
    expect(text).toContain('(my-task)');
    expect(text).toContain('205k');
    expect(text).toContain('_dream_context/state/my-task.md');
    expect(text).toContain('latest changelog entry');
  });

  it('omits the size when it was never measured', () => {
    expect(renderHandoffBanner(rec({ contextTokens: null }))).not.toContain('reached');
  });
});

// ─── gitignore + pruning ──────────────────────────────────────────────────────

describe('housekeeping', () => {
  it('gitignores both machine-local dirs on first write', () => {
    writeNudgeState(contextRoot, SES, 205_000);
    writeHandoffRecord(contextRoot, TAB, rec());
    const ignore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(ignore).toContain('_dream_context/state/.context-watch/');
    expect(ignore).toContain('_dream_context/state/.handoff-requests/');
  });

  it('prunes ladders and records after 7 days but KEEPS a tab toggle', () => {
    writeNudgeState(contextRoot, SES, 205_000);
    writeHandoffRecord(contextRoot, TAB, rec());
    writeTabHandoff(contextRoot, TAB, { enabled: true });

    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const p of [
      join(contextWatchDir(contextRoot), `${SES}.json`),
      join(handoffDir(contextRoot), `${TAB}.json`),
      join(contextWatchDir(contextRoot), `tab-${TAB}.json`),
    ]) utimesSync(p, old, old);

    const swept = pruneContextWatch(contextRoot);
    expect(swept.watch).toBe(1);
    expect(swept.handoffs).toBe(1);
    // The toggle is a PREFERENCE — expiring it in a week would silently flip a pane off.
    expect(swept.tabs).toBe(0);
    expect(readTabHandoff(contextRoot, TAB)?.enabled).toBe(true);
    expect(readNudgeState(contextRoot, SES)).toBeNull();
    expect(readHandoffRecord(contextRoot, TAB)).toBeNull();
  });

  it('prunes a tab toggle only after 30 days', () => {
    writeTabHandoff(contextRoot, TAB, { enabled: true });
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(join(contextWatchDir(contextRoot), `tab-${TAB}.json`), old, old);
    expect(pruneContextWatch(contextRoot).tabs).toBe(1);
    expect(readTabHandoff(contextRoot, TAB)).toBeNull();
  });

  it('never throws on dirs that do not exist yet', () => {
    const bare = mkdtempSync(join(tmpdir(), 'dc-ctx-bare-'));
    try {
      expect(() => pruneContextWatch(join(bare, '_dream_context'))).not.toThrow();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ─── maybeNudge: the one entry point the hooks call ──────────────────────────

describe('maybeNudge', () => {
  const TINY = { enabled: true, nudgeAt: 3000, remindEvery: 2000 };

  function configure(handoff: Record<string, unknown> | null) {
    writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({
      platforms: [], packs: [], multiProduct: false, setupVersion: '1',
      ...(handoff ? { contextHandoff: handoff } : {}),
    }), 'utf-8');
  }

  it('returns null and opens NO transcript when the feature is off', () => {
    configure({ enabled: false, nudgeAt: 3000 });
    // A path that would throw if it were ever opened proves the early return is real:
    // "off ⇒ zero extra work" has to be literally true, not merely quiet.
    expect(maybeNudge(contextRoot, {
      transcript_path: '/proc/definitely/not/a/file.jsonl',
      session_id: SES,
    }, {} as never)).toBeNull();
  });

  it('nudges once past the threshold, then holds until the next rung', () => {
    configure(TINY);
    const p = transcript([usage({ cache_read_input_tokens: 3500 })]);
    const first = maybeNudge(contextRoot, { transcript_path: p, session_id: SES }, {} as never);
    expect(first).toContain('YOU DECIDE');
    // Same context, same session: the ladder holds.
    expect(maybeNudge(contextRoot, { transcript_path: p, session_id: SES }, {} as never)).toBeNull();
    // Past the next rung (3500 + 2000): it fires again.
    const p2 = transcript([usage({ cache_read_input_tokens: 5500 })], 'y.jsonl');
    expect(maybeNudge(contextRoot, { transcript_path: p2, session_id: SES }, {} as never)).not.toBeNull();
  });

  it('stays silent inside a SUB-AGENT even when the parent is far over the threshold', () => {
    configure(TINY);
    const p = transcript([usage({ cache_read_input_tokens: 500_000 })]);
    expect(maybeNudge(contextRoot, {
      transcript_path: p, session_id: SES, agent_id: 'ad27a8b8ac307e324', agent_type: 'general-purpose',
    }, {} as never)).toBeNull();
    // ...and it left no ladder state behind, so the PARENT's next turn is unaffected.
    expect(readNudgeState(contextRoot, SES)).toBeNull();
  });

  it('honours the PANE toggle over the vault default, in both directions', () => {
    configure({ ...TINY, enabled: false });
    const p = transcript([usage({ cache_read_input_tokens: 3500 })]);
    const env = { DREAMCONTEXT_TAB_SESSION: TAB } as never;
    expect(maybeNudge(contextRoot, { transcript_path: p, session_id: SES }, env)).toBeNull();

    // Pane A on: it nudges even though the vault says off.
    writeTabHandoff(contextRoot, TAB, { enabled: true, nudgeAt: 3000, remindEvery: 2000 });
    expect(maybeNudge(contextRoot, { transcript_path: p, session_id: SES }, env)).not.toBeNull();
    // Pane B, untouched, still follows the vault default: off.
    expect(maybeNudge(contextRoot, { transcript_path: p, session_id: SES2 }, { DREAMCONTEXT_TAB_SESSION: TAB2 } as never)).toBeNull();
  });

  it('returns null rather than throwing on a missing transcript or session id', () => {
    configure(TINY);
    expect(maybeNudge(contextRoot, { session_id: SES }, {} as never)).toBeNull();
    expect(maybeNudge(contextRoot, { transcript_path: transcript([usage({ cache_read_input_tokens: 9999 })]) }, {} as never)).toBeNull();
  });
});

// ─── The config WRITE path (two runtime bugs lived here) ─────────────────────

describe('contextHandoff survives the config read/write round-trip', () => {
  // BOTH of these regressions were real and both were silent: `readSetupConfig`
  // rebuilds its object field by field and `updateSetupConfig` merges field by
  // field, so a field missing from EITHER list is dropped without an error. The
  // CLI happily printed "Context handoff on" over a file that said nothing.
  it('updateSetupConfig persists it, and reads back', () => {
    updateSetupConfig(projectRoot, { contextHandoff: { enabled: true, nudgeAt: 250_000, remindEvery: 50_000 } });
    const raw = JSON.parse(readFileSync(join(contextRoot, 'state', '.config.json'), 'utf-8')) as Record<string, unknown>;
    expect(raw.contextHandoff).toEqual({ enabled: true, nudgeAt: 250_000, remindEvery: 50_000 });
    expect(readSetupConfig(projectRoot)?.contextHandoff?.enabled).toBe(true);
  });

  it('survives an UNRELATED config write — the setting is not collateral damage', () => {
    updateSetupConfig(projectRoot, { contextHandoff: { enabled: true, nudgeAt: 250_000 } });
    updateSetupConfig(projectRoot, { disableNativeMemory: false });
    expect(readSetupConfig(projectRoot)?.contextHandoff).toEqual({ enabled: true, nudgeAt: 250_000 });
  });

  it('drops a malformed block rather than persisting junk', () => {
    updateSetupConfig(projectRoot, { contextHandoff: { enabled: 'yes', nudgeAt: 'big' } as never });
    expect(readSetupConfig(projectRoot)?.contextHandoff).toBeUndefined();
    // ...and the resolver then hands the hooks the shipped ladder, switched off.
    expect(resolveContextHandoff(readSetupConfig(projectRoot)?.contextHandoff)).toEqual(CONTEXT_HANDOFF_DEFAULTS);
  });
});

// ─── Who may rotate a pane (regression: the double-rotation defect) ───────────

describe('shouldRotateForHandoff', () => {
  it('rotates a fresh, unhandled record', () => {
    expect(shouldRotateForHandoff(rec())).toBe(true);
  });

  it('does NOT rotate one we already acted on — the /clear-loop latch', () => {
    expect(shouldRotateForHandoff(rec({ actedAt: '2026-09-13T00:00:00Z' }))).toBe(false);
  });

  it('does NOT rotate one the BANNER already delivered', () => {
    // Found on a real machine, not reasoned out: a handoff recorded under an old
    // server process was consumed by the SessionStart banner at resume; when the
    // rebuilt server came up it still saw actedAt missing and queued a second,
    // pointless rotation — /clear-ing a session the user was actively working in.
    expect(shouldRotateForHandoff(rec({ consumedAt: '2026-09-12T23:39:58Z' }))).toBe(false);
  });

  it('does not rotate on a missing record', () => {
    expect(shouldRotateForHandoff(null)).toBe(false);
    expect(shouldRotateForHandoff(undefined)).toBe(false);
  });
});
