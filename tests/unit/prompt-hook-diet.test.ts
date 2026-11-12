/**
 * The prompt hook's diet (overnight audit B1: MM-1, MM-3, MM-4, MM-7, MM-13): it searches on the
 * owner's words only, prints its long fixed blocks once per session, never cuts a hit's path, shows
 * a peer only when it earns it, and prints each hit's size.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptOwnerText, recallQuery } from '../../src/lib/agents/team-roster.js';
import { firstInSession, resetSessionOnce } from '../../src/lib/hook-delivery.js';
import {
  CONTEXT_GATE_REMINDER, PATTERN_BANNER_REMINDER, SUBAGENT_DISPATCH_REMINDER, hitSize, peerBlockWanted, renderRecallBlock,
} from '../../src/cli/commands/hook.js';
import type { CorpusDoc, RecallHit } from '../../src/lib/recall.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmpHome = () => { const d = mkdtempSync(join(tmpdir(), 'dc-diet-')); dirs.push(d); return d; };

describe('recallQuery: the owner words, nothing a machine wrote (MM-1)', () => {
  it('a task notification is no query at all', () => {
    const n = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "Review the diff" completed</summary>\n<result>PASS: no Critical or Major findings in src/lib/x.ts</result>\n</task-notification>';
    expect(recallQuery(n)).toBeNull();
    expect(promptOwnerText(n)).toBeNull();
  });

  it('a Super event and a handoff turn are no query', () => {
    expect(recallQuery('[super events] child b1 finished: green, 3 commits')).toBeNull();
    expect(recallQuery('Handoff: continue the checkout work from the task')).toBeNull();
  });

  it('a child kickoff keeps the job, drops the dev-server line and the brief path', () => {
    const p = 'If you start a dev server, pin its url (a `dream-view` pin) so the owner sees the site. Your job is B1. Read and follow /Users/me/brain/_dream_context/tmp/super-prompts/gece/brief.md';
    const q = recallQuery(p);
    expect(q).toBe('Your job is B1. Read and follow');
    expect(promptOwnerText(p)).toContain('/Users/me/brain/_dream_context/tmp/super-prompts/gece/brief.md');
  });

  it('the dock page header and a dictation tag are not searched', () => {
    expect(recallQuery('why is the checkout slow?\n\n[On page tasks view="board" filters=2]')).toBe('why is the checkout slow?');
    expect(recallQuery('<voice-take ref="v1" lang="tr" quality="ok"/>\nödeme ekranını düzelt')).toBe('ödeme ekranını düzelt');
  });

  it('drops the worktree preamble a child is born with', () => {
    const p = 'You work in your own git worktree: /Users/me/.claude-worktrees/x (branch super/x, repo /Users/me/r). cd there first, then work and commit only there. Never push and never merge into another branch. Fix the login bug.';
    expect(recallQuery(p)).toBe('Fix the login bug.');
  });

  it('a bare wrapper or a lone path is under 8 chars: null', () => {
    expect(recallQuery('/Users/me/projects/app/src/index.ts')).toBeNull();
    expect(recallQuery('ok')).toBeNull();
    expect(recallQuery('[On page tasks]')).toBeNull();
  });

  it('a plain owner prompt passes through, whitespace folded', () => {
    expect(recallQuery('how does   the\ncheckout work')).toBe('how does the checkout work');
  });

  it('keeps a relative path and a url (those name things he means)', () => {
    expect(recallQuery('look at src/lib/recall.ts and https://example.com/docs')).toBe('look at src/lib/recall.ts and https://example.com/docs');
  });
});

describe('firstInSession: the long blocks once, then one line (MM-3)', () => {
  it('true once per key, false after, true again after a SessionStart reset', () => {
    const home = tmpHome();
    expect(firstInSession('sess-1', 'authorization', home)).toBe(true);
    expect(firstInSession('sess-1', 'authorization', home)).toBe(false);
    expect(firstInSession('sess-1', 'gate', home)).toBe(true);
    expect(firstInSession('sess-2', 'authorization', home)).toBe(true);
    resetSessionOnce('sess-1', home);
    expect(firstInSession('sess-1', 'authorization', home)).toBe(true);
    expect(firstInSession('sess-2', 'authorization', home)).toBe(false);
  });

  it('no session id: always the full block', () => {
    const home = tmpHome();
    expect(firstInSession('', 'gate', home)).toBe(true);
    expect(firstInSession('', 'gate', home)).toBe(true);
  });

  it('the one-line forms together stay under 300 chars and keep their meaning', () => {
    const fixed = [SUBAGENT_DISPATCH_REMINDER, CONTEXT_GATE_REMINDER, PATTERN_BANNER_REMINDER].join('\n');
    expect(fixed.length).toBeLessThan(300);
    expect(SUBAGENT_DISPATCH_REMINDER).toMatch(/pre-authorized by the user/i);
    expect(SUBAGENT_DISPATCH_REMINDER).toMatch(/nothing ad-hoc/);
    expect(PATTERN_BANNER_REMINDER).toMatch(/update that file/);
    expect(CONTEXT_GATE_REMINDER).toMatch(/matching sections/);
  });
});

describe('peerBlockWanted (MM-7)', () => {
  it('named peer: shown, whatever the scores', () => {
    expect(peerBlockWanted('what did tilki decide about payments', ['tilki'], 3, 40)).toBe(true);
    expect(peerBlockWanted("Tilki'nin ödeme kararı", ['Tilki'], 3, 40)).toBe(true);
  });
  it('not named: only when the peer outscores this vault', () => {
    expect(peerBlockWanted('payments flow', ['tilki'], 9, 12)).toBe(false);
    expect(peerBlockWanted('payments flow', ['tilki'], 14, 12)).toBe(true);
    expect(peerBlockWanted('payments flow', ['tilki'], 3, 0)).toBe(true);
  });
  it('a name inside another word is not a mention', () => {
    expect(peerBlockWanted('the tilkiness of it', ['tilki'], 1, 5)).toBe(false);
  });
});

describe('recall render: sizes and capped snippets (MM-4, MM-13)', () => {
  const hit = (slug: string, body: string, snippet: string): RecallHit => ({
    doc: { type: 'knowledge', path: `/v/${slug}.md`, relPath: `knowledge/${slug}.md`, slug, title: slug, description: '', tags: [], body } as unknown as CorpusDoc,
    score: 5, rankScore: 5, snippet,
  });
  it('prints each hit with its size and caps a long Why line', () => {
    const lines = renderRecallBlock([hit('big', 'x'.repeat(24_400), 'y'.repeat(900))], 'BM25');
    expect(lines[2]).toBe('  [knowledge] knowledge/big.md  (24k chars)');
    expect(lines[3]!.length).toBeLessThanOrEqual('    Why: '.length + 200);
    expect(hitSize('abc')).toBe('3 chars');
  });
});
