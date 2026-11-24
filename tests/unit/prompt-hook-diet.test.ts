/**
 * The prompt hook's diet (overnight audit B1: MM-1, MM-3, MM-4, MM-7, MM-13): it searches on the
 * owner's words only, prints its long fixed blocks once per session, never cuts a hit's path, shows
 * a peer only when it earns it, and prints each hit's size.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELAUNCH_FIRST_LEAD, RELAUNCH_PREFIX, TELEGRAM_QUOTED_LABELS, promptOwnerText, recallQuery } from '../../src/lib/agents/team-roster.js';
import { FIRST_PROMPT_LEAD, REASK_TEXT, RESUME_TEXT } from '../../src/lib/super/outbox.js';
import { inboundTurnText } from '../../src/lib/telegram/inbound.js';
import { readFileSync } from 'node:fs';
import { firstInSession, resetSessionOnce } from '../../src/lib/hook-delivery.js';
import {
  CONTEXT_GATE_REMINDER, PATTERN_BANNER_REMINDER, SUBAGENT_DISPATCH_REMINDER, hitSize, peerNamed, renderRecallBlock,
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
  it('a relaunch continue or re-ask turn is no query; a lost first job keeps its job', () => {
    expect(recallQuery(RESUME_TEXT)).toBeNull();
    expect(recallQuery(REASK_TEXT)).toBeNull();
    expect(promptOwnerText(RESUME_TEXT)).toBeNull();
    expect(recallQuery(`${FIRST_PROMPT_LEAD}Fix the login bug on the checkout page.`)).toBe('Fix the login bug on the checkout page.');
  });
  it('the mirrored relaunch texts match the outbox (drift)', () => {
    expect(FIRST_PROMPT_LEAD).toBe(RELAUNCH_FIRST_LEAD);
    for (const t of [RESUME_TEXT, REASK_TEXT, FIRST_PROMPT_LEAD]) expect(t.startsWith(RELAUNCH_PREFIX)).toBe(true);
  });
  it('a sub-agent or teammate message is not the owner speaking', () => {
    const report = 'Another Claude session sent a message:\n<agent-message from="a1b2c3">\n[Subagent hand-back] The report follows:\n  REVIEW: the checkout flow in src/lib/pay.ts has two Major findings, retry loop and refund race\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session, so this was not typed by your user.';
    expect(recallQuery(report)).toBeNull();
    expect(recallQuery('<agent-message from="t9">still running the payment tests</agent-message>')).toBeNull();
    expect(recallQuery(report + '\nwhy is the checkout slow?')).toBe('why is the checkout slow?');
  });

  it('the server\'s hidden card-feedback turn is no query (it used to search on its own tag)', () => {
    const gate = '<dreamcontext-card-feedback>\n<owner-text-gate>\nYour last answer to him was not in Turkish. Write that same answer again, in Turkish only.\nDo not mention this note itself.\n</owner-text-gate>\n</dreamcontext-card-feedback>\n[owner language] The owner writes Turkish.';
    const skipped = '<dreamcontext-card-feedback>\nThe chat did NOT draw part of your last answer. The owner sees only this note where the card should be:\n- A run card spans two lines.\n</dreamcontext-card-feedback>';
    expect(recallQuery(gate)).toBeNull();
    expect(promptOwnerText(gate)).toBeNull();
    expect(recallQuery(skipped)).toBeNull();
    expect(recallQuery('  ' + skipped)).toBeNull();
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

  it('a Telegram reply searches on his words, not the Super message it replies to', () => {
    const superMsg = 'Kestrel build is ready. Should the Lumen voiceover be generated now? About 400 credits.\nSay go or wait.';
    const turn = inboundTurnText({ text: 'go, with music', reply_to_message: { text: superMsg } });
    expect(turn).toContain('Yanıtlanan mesaj: "');
    expect(recallQuery(turn)).toBe('go, with music');
    const quoted = inboundTurnText({ text: 'fix this line please', quote: { text: 'Lumen voiceover is 400 credits' } });
    expect(recallQuery(quoted)).toBe('fix this line please');
    // The header form the hub adds in front keeps working.
    const withHeader = `[Reply to message ref=abc123 from=super]\nquote: "Kestrel build is ready."\n\n${turn}`;
    expect(recallQuery(withHeader)).toBe('go, with music');
  });

  it('a forwarded Telegram message is what he brings: it stays searchable', () => {
    const fwd = inboundTurnText({ text: 'Lumen invoice for March is overdue', forward_origin: { type: 'user', sender_user_name: 'Mira' } });
    expect(recallQuery(fwd)).toContain('Lumen invoice for March is overdue');
  });

  it('the quoted-data labels mirror telegram/inbound.ts', () => {
    const src = readFileSync(new URL('../../src/lib/telegram/inbound.ts', import.meta.url), 'utf8');
    for (const label of TELEGRAM_QUOTED_LABELS) expect(src).toContain(`quotedData('${label}'`);
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

describe('peerNamed (MM-7)', () => {
  it('a named peer is a mention, in any case and with a suffix', () => {
    expect(peerNamed('what did harbor decide about payments', ['harbor'])).toBe(true);
    expect(peerNamed("Harbor'un ödeme kararı", ['Harbor'])).toBe(true);
    expect(peerNamed('check the lighthouse app', ['harbor', 'Lighthouse'])).toBe(true);
  });
  it('an unnamed peer is never shown, however its files score', () => {
    expect(peerNamed('payments flow, wave map, fan-out agents', ['harbor'])).toBe(false);
  });
  it('a name inside another word is not a mention, and a too-short name never is', () => {
    expect(peerNamed('the harbored doubt', ['harbor'])).toBe(false);
    expect(peerNamed('go ab now', ['ab'])).toBe(false);
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
