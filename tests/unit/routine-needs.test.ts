/**
 * What a routine waits on the owner for, derived from the facts on disk (plan K7, criterion 9's
 * derivation table). One row per fact kind and one per excluded kind, over real files written by
 * the real store writers in a temp context root: a need comes from the disk, never from a caller
 * that had to remember to report it. Each fact keeps its id across reads and across a refusal
 * folded onto one history row tick after tick, so the queue side can ring it once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/dc-routine-needs-`);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { automationCachePath, automationPath, createAutomation, patchManifestFrontmatter, recordRun } from '../../src/lib/automations/store.js';
import { createQuestion } from '../../src/lib/automations/hitl.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { blockedKind, readRoutineFacts, routineNeeds, type RoutineFacts } from '../../src/lib/automations/needs.js';
import type { RunEvent } from '../../src/lib/automations/types.js';

let root: string;
let contextRoot: string;
let home: string;

const FIRE = '2026-11-10T06:30:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-routine-needs-'));
  contextRoot = join(root, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-routine-needs-'));
  createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD Digest', days: 'daily', at: '18:00' } as Parameters<typeof createAutomation>[1]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function row(o: Partial<RunEvent> & Record<string, unknown> = {}): RunEvent {
  return {
    firedAt: FIRE, startedAt: '2026-11-10T06:30:01.000Z', finishedAt: '2026-11-10T06:31:00.000Z',
    status: 'ok', durationMs: 59_000, outputPath: null, error: null, exitCode: 0,
    sessionId: null, costUsd: null, numTurns: null, permissionDenials: 0,
    ...o,
  } as RunEvent;
}
const record = (o: Partial<RunEvent> & Record<string, unknown>, coalesce = false) =>
  recordRun(contextRoot, 'eod-digest', row(o), { advanceWatermark: false, coalesceRepeat: coalesce });
const needs = () => routineNeeds(readRoutineFacts(contextRoot, { home }));
const fence = (o: Record<string, unknown>) => `\`\`\`dream-view\n${JSON.stringify(o)}\n\`\`\``;
const post = (kind: 'agent' | 'user', text: string, at: string, extra: Record<string, unknown> = {}) =>
  appendThreadEntry(contextRoot, 'eod-digest', { runId: FIRE, kind, text, via: kind === 'agent' ? 'cli' : 'dashboard', now: new Date(at), ...extra } as Parameters<typeof appendThreadEntry>[2]);

// ─── One row per fact kind ───────────────────────────────────────────────────

describe('routine needs: one need per fact on disk', () => {
  it('a pending flow question → `question`, keyed by the question id, with the routine title and member', () => {
    const q = createQuestion(contextRoot, { slug: 'eod-digest', runFiredAt: FIRE, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Send the digest to the team?\n\nThe body.', choices: ['yes', 'no'] });
    expect(needs()).toEqual([{ slug: 'eod-digest', member: 'eod-digest', title: 'EOD Digest', fact: `q:${q.id}`, kind: 'question', text: 'Send the digest to the team?' }]);
  });

  it('a pending approval question → `awaiting-approval`, and its awaiting row is the same fact (one need)', () => {
    const q = createQuestion(contextRoot, { slug: 'eod-digest', runFiredAt: FIRE, kind: 'approval', sessionId: null, channel: 'chat', question: '"EOD Digest" was edited. Approve the change?', choices: ['approve', 'not now'] });
    record({ status: 'awaiting-approval', error: 'the manifest changed since it was approved' }, true);
    const got = needs();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'awaiting-approval', fact: `q:${q.id}` });
  });

  it('a review question with the newest row `awaiting-review` → `awaiting-review` (one need)', () => {
    const q = createQuestion(contextRoot, { slug: 'eod-digest', runFiredAt: FIRE, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'EOD Digest wrote this report. Publish it?\n\nDoc', choices: ['approve', 'reject'] });
    record({ status: 'awaiting-review', error: 'waiting for your verdict' });
    expect(needs()).toEqual([expect.objectContaining({ kind: 'awaiting-review', fact: `q:${q.id}` })]);
  });

  it('a never-approved refusal → `not-approved`, one fact however many ticks fold onto the row', () => {
    record({ status: 'blocked', error: 'not approved (never-approved) — the owner approves it on its card in the chat or on the AI Team page', sessionId: null }, true);
    const first = needs();
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe('not-approved');
    expect(first[0].fact).toMatch(/^not-approved:/);
    record({ status: 'blocked', error: 'not approved (never-approved) — the owner approves it on its card in the chat or on the AI Team page', startedAt: '2026-11-10T06:35:00.000Z' }, true);
    expect(needs()).toEqual(first);
  });

  it('a change waiting for his approval → `change-pending`; a new change is a new fact', () => {
    record({ status: 'blocked', error: 'its change waits for your approval on the AI Team page' }, true);
    const [a] = needs();
    expect(a.kind).toBe('change-pending');
    // The model is part of what the owner approves (the title is not): a different change.
    patchManifestFrontmatter(automationPath(contextRoot, 'eod-digest'), { model: 'claude-sonnet-5-5' });
    const [b] = needs();
    expect(b.kind).toBe('change-pending');
    expect(b.fact).not.toBe(a.fact);
  });

  it('an orphaned child → `orphaned`, keyed by the owed fire', () => {
    record({ status: 'orphaned', error: "previous run's child group (pgid 4242) is still alive" }, true);
    expect(needs()).toEqual([expect.objectContaining({ kind: 'orphaned', fact: `orphaned:${FIRE}` })]);
  });

  it('a light run that ended ok with refused calls → `denials`, naming what was refused', () => {
    record({ status: 'ok', light: true, permissionDenials: 2, deniedCalls: [{ tool: 'Bash', input: 'node scripts/report.mjs' }, { tool: 'Write', input: '{"file_path":"out.md"}' }] });
    const got = needs();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'denials', fact: 'denials:2026-11-10T06:30:01.000Z' });
    expect(got[0].text).toContain('node scripts/report.mjs');
    expect(got[0].text).toMatch(/^2 calls were refused/);
  });

  it('the newest post holding an owner card nobody answered → `owner-card`, keyed by the post', () => {
    const p = post('agent', `I need you to sign in.\n\n${fence({ type: 'run', id: 'gh-login', command: 'gh auth login', why: 'it opens a browser for your GitHub sign-in' })}`, '2026-11-10T06:31:00.000Z');
    expect(needs()).toEqual([expect.objectContaining({ kind: 'owner-card', fact: `card:${p.id}`, text: 'it opens a browser for your GitHub sign-in' })]);
  });

  it('two facts of one routine are two needs, in a fixed order', () => {
    createQuestion(contextRoot, { slug: 'eod-digest', runFiredAt: FIRE, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Which list?', choices: [] });
    record({ status: 'ok', light: true, permissionDenials: 1, deniedCalls: [{ tool: 'Bash', input: 'ls' }] });
    expect(needs().map((n) => n.kind)).toEqual(['question', 'denials']);
  });
});

// ─── One row per excluded kind ───────────────────────────────────────────────

describe('routine needs: what is not his to settle', () => {
  const none = () => expect(needs()).toEqual([]);

  it('no facts at all → none', () => none());
  it('a failed run → none (already announced)', () => { record({ status: 'failed', error: 'exit 1', exitCode: 1 }); none(); });
  it('a timed-out run → none (already announced)', () => { record({ status: 'timeout', error: 'timed out' }); none(); });
  it('a deferred fire → none', () => { record({ status: 'deferred', error: 'a sleep consolidation is in progress' }, true); none(); });
  it('"runs on <machine>" → none', () => { record({ status: 'blocked', error: 'runs on Work Mac — bring it here on the AI Team page to run it on this machine' }, true); none(); });
  it('someone else\'s agent, read-only here → none', () => { record({ status: 'blocked', error: 'read-only here — EOD Digest belongs to ada; only its owner runs it' }, true); none(); });
  it('a Super automation called off its schedule → none', () => { record({ status: 'blocked', error: 'a Super automation is a turn of the Super session; it only runs on its schedule' }, true); none(); });
  it('a bypass run\'s denials (no light flag) → none', () => { record({ status: 'ok', permissionDenials: 3, deniedCalls: [{ tool: 'Bash', input: 'rm -rf x' }] }); none(); });
  it('a light run that ended ok with no denials → none', () => { record({ status: 'ok', light: true }); none(); });
  it('a light run that failed with denials → none (the failure is announced)', () => { record({ status: 'failed', light: true, permissionDenials: 1, deniedCalls: [{ tool: 'Bash', input: 'ls' }] }); none(); });
  it('an awaiting row whose question was answered → none', () => { record({ status: 'awaiting-review', error: 'waiting' }); none(); });
  it('an owner card the owner answered after → none', () => {
    post('agent', fence({ type: 'secret', id: 'k', title: 'API key', file: '.env', fields: [{ key: 'K', label: 'Key' }] }), '2026-11-10T06:31:00.000Z');
    post('user', '[secret submitted · API key]', '2026-11-10T06:40:00.000Z');
    none();
  });
  it('a post with a card superseded by a newer post with none → none', () => {
    post('agent', fence({ type: 'run', id: 'r', command: 'gh auth login' }), '2026-11-10T06:31:00.000Z');
    post('agent', 'All done, signed in already.', '2026-11-10T06:32:00.000Z');
    none();
  });
});

describe('routine needs: reading the disk', () => {
  it('an app\'s words after a card are never the owner\'s answer', () => {
    post('agent', fence({ type: 'run', id: 'r', command: 'gh auth login' }), '2026-11-10T06:31:00.000Z');
    post('user', 'ok', '2026-11-10T06:33:00.000Z', { via: 'app', app: 'ad-manager' });
    expect(needs().map((n) => n.kind)).toEqual(['owner-card']);
  });

  it('fact ids are the same across two reads', () => {
    createQuestion(contextRoot, { slug: 'eod-digest', runFiredAt: FIRE, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Which list?', choices: [] });
    record({ status: 'orphaned', error: 'still alive' }, true);
    const a = needs();
    const b = needs();
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('a routine with no member (a Super automation) has no `member`; a member\'s routine names it', () => {
    createAutomation(contextRoot, { slug: 'super-sweep', title: 'Morning sweep', days: 'daily', at: '07:00' } as Parameters<typeof createAutomation>[1]);
    patchManifestFrontmatter(automationPath(contextRoot, 'super-sweep'), { target: 'super' });
    recordRun(contextRoot, 'super-sweep', row({ status: 'blocked', error: 'its change waits for your approval on the AI Team page' }), { advanceWatermark: false, coalesceRepeat: true });
    record({ status: 'orphaned', error: 'still alive' }, true);
    const got = needs();
    const sweep = got.find((n) => n.slug === 'super-sweep');
    expect(sweep).toMatchObject({ title: 'Morning sweep', kind: 'change-pending' });
    expect(sweep).not.toHaveProperty('member');
    expect(got.find((n) => n.slug === 'eod-digest')?.member).toBe('eod-digest');
  });

  it('a broken cache file is no fact and no throw', () => {
    // Planted by hand: its folder is made here, never left to another write having made it.
    const cachePath = automationCachePath(contextRoot, 'eod-digest');
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, '{ not json', 'utf-8');
    expect(() => readRoutineFacts(contextRoot, { home })).not.toThrow();
    expect(needs()).toEqual([]);
  });

  it('a context root with nothing in it reads as no facts', () => {
    const empty = join(root, 'empty');
    expect(readRoutineFacts(empty, { home })).toEqual({ routines: [], questions: [] });
  });
});

// ─── The pure core ────────────────────────────────────────────────────────────

describe('routineNeeds (pure)', () => {
  it('reads the runner\'s blocked sentences, and nothing else, as his', () => {
    expect(blockedKind('not approved (manifest-changed) — the owner approves it')).toBe('not-approved');
    expect(blockedKind('its schedule is part of a change that waits for your approval; until you approve it, it runs only when called')).toBe('change-pending');
    expect(blockedKind('runs on Work Mac — bring it here')).toBeNull();
    expect(blockedKind(null)).toBeNull();
  });

  it('a question whose routine is not listed is still a need, named by its slug and with no member', () => {
    const facts: RoutineFacts = { routines: [], questions: [{ id: 'q1', slug: 'gone-one', kind: 'flow-hitl', question: 'Still there?' }] };
    expect(routineNeeds(facts)).toEqual([{ slug: 'gone-one', title: 'gone-one', fact: 'q:q1', kind: 'question', text: 'Still there?' }]);
  });

  it('a blocked row with no hash falls back to the owed fire, and the text is one line', () => {
    const facts: RoutineFacts = {
      routines: [{ slug: 'a', title: 'A', hash: null, newestLight: null, post: null,
        newest: { status: 'blocked', firedAt: FIRE, startedAt: FIRE, error: 'not approved (never-approved)\n— approve it', permissionDenials: 0 } }],
      questions: [],
    };
    expect(routineNeeds(facts)).toEqual([{ slug: 'a', title: 'A', fact: `not-approved:${FIRE}`, kind: 'not-approved', text: 'not approved (never-approved) — approve it' }]);
  });
});
