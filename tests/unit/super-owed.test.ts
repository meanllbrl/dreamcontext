/**
 * The Super never drops a topic (task super-hicbir-konuyu-kacirmaz): an owed ledger the server
 * keeps. His messages, the results he waits on and a child's outward actions are DEBTS, opened
 * from facts and closed only by a line-start `<!-- re:<ref> -->` section, his drop or his
 * take-back; a natural turn end with one open brings one `[super owed]` turn, at most twice a
 * debt; Stop, a limit and a process exit decide nothing. Fictional project and words (synthetic
 * fixtures pattern).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-owed-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetChatRegistry, getChat, registerChat, setOutwardSink, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { emptySuperState, msgRef, OWED_NUDGES, SUPER_EVENT_PREFIXES, type SuperChild, type SuperState } from '../../src/lib/super/types.js';
import {
  closeByMarks, decideOwed, dropDebt, openDebts, openMessageDebt, openResultDebt, outwardAction, owedVisible, replyMarkRefs, nextOwedReveal,
} from '../../src/lib/super/owed.js';
import {
  OWED_PREFIX, _resetSuperInbox, _superInboxDrained, attachSuperInbox, nextBatch, pumpSuper, startSuperInbox, superOwedBlock, superOwnerOwes,
  superOwnerSpoke, superSaid, superTurnEnded, writeSuper, type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { disableSuper } from '../../src/lib/super/handover.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import { ownerWords } from '../../src/lib/agents/team-roster.js';

let dir: string;
let root: string;
const SUPER = 'sup-1';
const W = { timeout: 10_000 };

const child = (sid: string, over: Partial<SuperChild> = {}): SuperChild => ({ sessionId: sid, brief: `brief of ${sid}`, adopted: false, startedAt: 1, ...over } as SuperChild);
function makeVault(state: Partial<SuperState>): void {
  root = join(dir, 'orbit', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...state }));
}
const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: null, vault: 'orbit', mode });
const settle = (h: ChatHandle) => { h.userSent(''); h.observe({ type: 'result' }); };
function fakeInbox(ok: () => boolean = () => true) {
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`, sessionId: SUPER, attached: () => true, idle: () => true,
    deliver: async (text, event) => { if (!ok()) return false; delivered.push({ text, event }); return true; },
  };
  return { inbox, delivered };
}
const bare = (over: Partial<SuperState> = {}): SuperState => sanitizeSuperState({ ...emptySuperState(), session: SUPER, enabled: true, ...over });
const toolUse = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, isError = false, parent: string | null = null) =>
  ({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-owed-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
});
afterEach(async () => {
  let cap: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([_superInboxDrained(), new Promise((r) => { cap = setTimeout(r, 8_000); })]);
  clearTimeout(cap);
  _resetSuperInbox();
  rmSync(dir, { recursive: true, force: true });
});

describe('outward actions (owner decision D3)', () => {
  it('the fixed list, read segment by segment', () => {
    expect(outwardAction('Bash', { command: 'cd app && git push origin super/x' })).toBe('git push');
    expect(outwardAction('Bash', { command: 'git -C ../app push' })).toBe('git push');
    expect(outwardAction('Bash', { command: 'echo "git push" > notes.txt' })).toBeNull();
    expect(outwardAction('Bash', { command: 'git status; npm publish --access public' })).toBe('npm publish');
    expect(outwardAction('Bash', { command: 'gh pr create --fill' })).toBe('PR create');
    expect(outwardAction('Bash', { command: 'gh pr merge 12 --squash' })).toBe('PR merge');
    expect(outwardAction('Bash', { command: 'gh release create v1.0.0' })).toBe('release create');
    expect(outwardAction('Bash', { command: 'npx firebase deploy --only hosting' })).toBe('firebase deploy');
    expect(outwardAction('Bash', { command: 'vercel deploy --prod' })).toBe('vercel deploy --prod');
    expect(outwardAction('Bash', { command: 'vercel deploy' })).toBeNull();
    expect(outwardAction('Bash', { command: 'git commit -m "push later"' })).toBeNull();
    // Data, not a command: a heredoc body and a quoted prompt that mention a push.
    expect(outwardAction('Bash', { command: "cat > brief.md <<'EOF'\n# Release\ngit push main v1\nEOF\nls" })).toBeNull();
    expect(outwardAction('Bash', { command: "dreamcontext super delegate --prompt 'build it\ngit push when green'" })).toBeNull();
    expect(outwardAction('Bash', { command: "cat > a.md <<'EOF'\nnotes\nEOF\ngit push main v1" })).toBe('git push');
    expect(outwardAction('mcp__whatsapp__send_message', { to: 'E.' })).toBe('mcp whatsapp/send_message');
    expect(outwardAction('mcp__whatsapp__list_chats', {})).toBeNull();
    expect(outwardAction('mcp__gmail__create_draft', {})).toBeNull();
    expect(outwardAction('mcp__gmail__get_message', {})).toBeNull();
    expect(outwardAction('Read', { file_path: 'x' })).toBeNull();
    expect(outwardAction(undefined, {})).toBeNull();
  });

  it('a child\'s frames: told once, only on a non-error result, top level and inside a sub-agent; Claude, Codex and Antigravity shapes', () => {
    const told: Array<[string, string]> = [];
    const prev = setOutwardSink((sid, what) => told.push([sid, what]));
    try {
      // Claude: a top-level push, its frame seen twice, its result seen twice.
      const c = reg('kid-claude');
      c.observe(toolUse('tu-1', 'Bash', { command: 'git push' }));
      c.observe(toolUse('tu-1', 'Bash', { command: 'git push' }));
      c.observe(toolResult('tu-1'));
      c.observe(toolResult('tu-1'));
      // A sub-agent's MCP send.
      c.observe(toolUse('tu-2', 'mcp__whatsapp__send_message', { to: 'H.K.' }, 'agent-1'));
      c.observe(toolResult('tu-2', false, 'agent-1'));
      // A push the owner denied: an error result, never told.
      c.observe(toolUse('tu-3', 'Bash', { command: 'git push --force' }));
      c.observe(toolResult('tu-3', true));
      // Codex and Antigravity: the t3-bridge (to-wire.ts) emits the same shapes.
      const x = reg('kid-codex');
      x.observe({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_i1', role: 'assistant', content: [{ type: 'tool_use', id: 'cx-1', name: 'Bash', input: { command: 'gh pr create --fill' } }] } });
      x.observe({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cx-1', content: [{ type: 'text', text: 'https://example.test/pr/1' }], is_error: false }] }, parent_tool_use_id: null });
      const g = reg('kid-antigravity');
      g.observe({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'ag-1', name: 'mcp__slack.post_message', input: {} }] } });
      g.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ag-1', is_error: false }] } });
      expect(told).toEqual([
        ['kid-claude', 'git push'],
        ['kid-claude', 'mcp whatsapp/send_message'],
        ['kid-codex', 'PR create'],
        ['kid-antigravity', 'mcp slack.post_message'],
      ]);
    } finally { setOutwardSink(prev); }
  });
});

describe('marks', () => {
  it('line-start sections only, outside fences, repeats counted, several refs on a line, case folded', () => {
    const a = msgRef('ship it');
    const text = [`<!-- re:${a} -->`, 'Done.', '```', `<!-- re:${a} -->`, '```', `  <!-- re:${a}, ZZZZZ1 -->`, 'more', `inline <!-- re:${a} -->`].join('\n');
    expect(replyMarkRefs(text)).toEqual([a, a, 'zzzzz1']);
    expect(replyMarkRefs('no marks')).toEqual([]);
  });

  it('one section closes one debt, oldest first, at or under the ceiling; a part ref closes its message', () => {
    const s = bare();
    const m1 = openMessageDebt(s, 'tamam', 1);
    const m2 = openMessageDebt(s, 'tamam', 2);
    const multi = '[About agenda line note=n1 section=now]\nline: "a"\n\nfirst\n\n[About agenda line note=n2 section=now]\nline: "b"\n\nsecond';
    const m3 = openMessageDebt(s, multi, 3);
    expect(m3.parts?.length).toBe(2);
    expect(closeByMarks(s, [msgRef('tamam')], m2.seq)).toBe(1);
    expect(openDebts(s).map((d) => d.id)).toEqual([m2.id, m3.id]);
    // Under the ceiling only: a debt opened after the text arrived waits.
    expect(closeByMarks(s, [msgRef('tamam')], m1.seq)).toBe(0);
    expect(closeByMarks(s, [m3.parts![1]], m3.seq)).toBe(1);
    expect(openDebts(s).map((d) => d.id)).toEqual([m2.id]);
    expect(s.owed!.find((d) => d.id === m1.id)!.closed!.by).toBe('mark');
  });

  it('the record keeps every open debt and the newest closed ones; a hostile one is dropped', () => {
    const s = bare();
    for (let i = 0; i < 50; i++) openMessageDebt(s, `m${i}`, i);
    for (const d of s.owed!.slice(0, 45)) d.closed = { at: d.at, by: 'mark' };
    const back = sanitizeSuperState({ ...s, owed: [...s.owed!, { id: 'o9999', kind: 'msg', ref: 'NOT A REF', seq: 9999, at: 1, gist: '', nudges: 0 }, 'junk'] });
    expect(openDebts(back).length).toBe(5);
    expect(back.owed!.filter((d) => d.closed).length).toBe(40);
    expect(back.owedSeq).toBe(50);
    expect(back.owed!.some((d) => d.id === 'o9999')).toBe(false);
  });
});

describe('the decision at a turn end', () => {
  const ends = (o: Partial<{ ceiling: number; stopped: boolean; exited: boolean; limited: boolean }>) => [{ ceiling: 99, stopped: false, exited: false, limited: false, ...o }];

  it('a natural end queues its open debts; a Stop or a limit parks them; an exit decides nothing', () => {
    const s = bare();
    const d = openMessageDebt(s, 'how is the login fix?', 1);
    expect(decideOwed(s, ends({ stopped: true }), () => false, 100)).toEqual([]);
    expect(d.parked).toBe('stop');
    expect(owedVisible(d, 100)).toBe(false);
    expect(owedVisible(d, 100 + 10 * 60_000)).toBe(true);
    expect(nextOwedReveal(s.owed, 100)).toBe(100 + 10 * 60_000);
    expect(decideOwed(s, ends({ exited: true }), () => false, 200)).toEqual([]);
    expect(decideOwed(s, ends({ limited: true }), () => false, 300)).toEqual([]);
    // The next natural end clears the parking and decides.
    expect(decideOwed(s, ends({}), () => false, 400)).toEqual([d.id]);
    expect(d.parked).toBeUndefined();
  });

  it('the newest natural end\'s ceiling decides; a result back in pending, a debt nudged twice and a pending owed turn are left out', () => {
    const s = bare();
    const a = openMessageDebt(s, 'one', 1);
    const b = openResultDebt(s, { ref: 'abc123', item: 'q-r1', child: 'c1', gist: 'build' }, 2);
    const c = openMessageDebt(s, 'three', 3);
    expect(decideOwed(s, [{ ceiling: a.seq, stopped: false, exited: false, limited: false }, { ceiling: b.seq, stopped: false, exited: false, limited: false }], (id) => id === 'q-r1', 10)).toEqual([a.id]);
    a.nudges = OWED_NUDGES;
    expect(owedVisible(a)).toBe(true);
    expect(decideOwed(s, ends({}), () => false, 11)).toEqual([b.id, c.id]);
    s.queue.push({ id: 'q-owed-1', sessionId: SUPER, kind: 'owed', state: 'pending', createdAt: 12, owed: [b.id] });
    expect(decideOwed(s, ends({}), () => false, 13)).toEqual([]);
  });

  it('his drop closes one open debt; a closed or unknown one is refused', () => {
    const s = bare();
    const d = openMessageDebt(s, 'one', 1);
    expect(dropDebt(s, d.id)).toBe(true);
    expect(dropDebt(s, d.id)).toBe(false);
    expect(dropDebt(s, 'o42')).toBe(false);
  });
});

describe('the ledger in the running inbox', () => {
  async function boot(state: Partial<SuperState> = {}, ok?: () => boolean) {
    makeVault(state);
    await startSuperInbox([root]);
    const h = reg(SUPER, 'super');
    settle(h);
    const fake = fakeInbox(ok);
    attachSuperInbox(fake.inbox);
    return { h, ...fake };
  }

  it('his message opens a debt (never a slash command); a section closes it; the old one rides his next message', async () => {
    await boot();
    await superOwnerOwes(SUPER, '/model sonnet');
    await superOwnerOwes(SUPER, 'Is the release notes page live?');
    let s = await readSuperState(root);
    expect(openDebts(s).map((d) => d.ref)).toEqual([msgRef('Is the release notes page live?')]);
    expect(s.owedSince).toBeGreaterThan(0);
    const block = superOwedBlock(SUPER, 'And the logo?');
    expect(block).toContain(`ref=${msgRef('Is the release notes page live?')}`);
    expect(block!.startsWith('<super-owed')).toBe(true);
    // A fenced mark closes nothing; a line-start one does.
    await superSaid(SUPER, `\`\`\`\n<!-- re:${msgRef('Is the release notes page live?')} -->\n\`\`\``);
    expect(openDebts(await readSuperState(root)).length).toBe(1);
    await superSaid(SUPER, `<!-- re:${msgRef('Is the release notes page live?')} -->\nYes, it is live.`);
    s = await readSuperState(root);
    expect(openDebts(s).length).toBe(0);
    expect(superOwedBlock(SUPER, 'And the logo?')).toBeNull();
  });

  it('a natural end with his message unanswered brings ONE [super owed] turn, drawn as an event line; twice, then it is his to see', async () => {
    const { h, delivered } = await boot();
    await superOwnerOwes(SUPER, 'Did the export finish?');
    // His turn ends with no section for it.
    h.userSent('Did the export finish?'); h.observe({ type: 'result' });
    superTurnEnded(SUPER);
    await vi.waitFor(() => expect(delivered.length).toBe(1), W);
    expect(delivered[0].text.startsWith(OWED_PREFIX)).toBe(true);
    expect(delivered[0].event.kind).toBe('batch');
    expect(delivered[0].event.items?.[0].kind).toBe('owed');
    expect(SUPER_EVENT_PREFIXES).toContain(OWED_PREFIX);
    expect(client.SUPER_EVENT_PREFIXES).toContain(OWED_PREFIX);
    expect(ownerWords(delivered[0].text)).toBeNull();
    // The owed turn ends unanswered: one more; then none, and the debt is visible.
    h.userSent(''); h.observe({ type: 'result' }); superTurnEnded(SUPER);
    await vi.waitFor(() => expect(delivered.length).toBe(2), W);
    h.userSent(''); h.observe({ type: 'result' }); superTurnEnded(SUPER);
    await _superInboxDrained();
    await new Promise((r) => setTimeout(r, 150));
    expect(delivered.length).toBe(2);
    const d = openDebts(await readSuperState(root))[0];
    expect(d.nudges).toBe(OWED_NUDGES);
    expect(owedVisible(d)).toBe(true);
  });

  it('an owed turn is re-decided at delivery: answered meanwhile, it is dropped, never sent', async () => {
    const { delivered } = await boot();
    await superOwnerOwes(SUPER, 'Rename the board?');
    const ref = msgRef('Rename the board?');
    const s0 = await readSuperState(root);
    await writeSuper(root, (s) => { s.queue.push({ id: 'q-owed-x', sessionId: SUPER, kind: 'owed', state: 'pending', createdAt: Date.now(), owed: [openDebts(s0)[0].id] }); });
    await superSaid(SUPER, `<!-- re:${ref} -->\nDone.`);
    expect(nextBatch(await readSuperState(root)).drop).toContain('q-owed-x');
    await pumpSuper(root);
    await _superInboxDrained();
    expect(delivered.length).toBe(0);
    expect((await readSuperState(root)).queue.find((q) => q.id === 'q-owed-x')?.state).toBe('done');
  });

  it('a Stop (with or without a result) and a process exit decide nothing; the next natural end does', async () => {
    const { h, delivered } = await boot();
    await superOwnerOwes(SUPER, 'Check the payments page');
    h.userSent('Check the payments page');
    // Stop with no result: the registry stamps the stopped turn, one end marked stopped.
    h.interrupted(); h.stopSettled();
    expect(getChat(SUPER)!.lastTurn!.interrupted).toBe(true);
    expect(getChat(SUPER)!.status).toBe('idle');
    superTurnEnded(SUPER, { stopped: true });
    await _superInboxDrained();
    expect(delivered.length).toBe(0);
    expect(openDebts(await readSuperState(root))[0].parked).toBe('stop');
    // Stop WITH a result: the registry's interrupted stamp says so.
    h.userSent('x'); h.interrupted(); h.observe({ type: 'result' });
    superTurnEnded(SUPER);
    await _superInboxDrained();
    expect(delivered.length).toBe(0);
    // A natural end: decided.
    h.userSent('y'); h.observe({ type: 'result' });
    superTurnEnded(SUPER);
    await vi.waitFor(() => expect(delivered.length).toBe(1), W);
    expect(openDebts(await readSuperState(root))[0].parked).toBeUndefined();
  });

  it('a stopped child with no result settles slowly (no false done) and its interrupt flag is not kept', () => {
    const c = reg('kid-1');
    c.userSent('go');
    c.interrupted();
    c.stopSettled();
    expect(getChat('kid-1')!.lastTurn!.interrupted).toBe(true);
    // The next real turn is not stamped interrupted.
    c.userSent('again'); c.observe({ type: 'result' });
    expect(getChat('kid-1')!.lastTurn!.interrupted).toBe(false);
    // An idle entry is left alone.
    const before = getChat('kid-1')!.lastTurn!.resultSeq;
    c.stopSettled();
    expect(getChat('kid-1')!.lastTurn!.resultSeq).toBe(before);
  });

  it('a result he waits on opens ONE debt at delivery; a fast mark closes it; old items and a second write never owe', async () => {
    const { delivered } = await boot({ children: { c1: child('c1', { row: 'working', awaited: true, origin: 'abc123' }), c2: child('c2', { row: 'working', awaited: true }) } });
    reg('c1'); reg('c2');
    const s0 = await readSuperState(root);
    // An item older than the ledger is never owed.
    await writeSuper(root, (s) => {
      s.children.c2.row = 'done';
      s.queue.push({ id: 'q-old', sessionId: 'c2', kind: 'done', state: 'pending', createdAt: (s0.owedSince ?? Date.now()) - 60_000 });
    });
    await writeSuper(root, (s) => {
      s.children.c1.row = 'done';
      s.queue.push({ id: 'q-new', sessionId: 'c1', kind: 'done', state: 'pending', createdAt: Date.now() });
    });
    await pumpSuper(root);
    await vi.waitFor(() => expect(delivered.length).toBe(1), W);
    expect(delivered[0].text).toMatch(/item=q-new child=c1 event=done awaited=owner origin=abc123 status=\S+ ref=abc123/);
    expect(delivered[0].text).toMatch(/item=q-old child=c2 event=done awaited=owner status=\S+ ref=\w{6}/);
    let s = await readSuperState(root);
    expect(openDebts(s).map((d) => [d.kind, d.item, d.ref])).toEqual([['result', 'q-new', 'abc123']]);
    expect(s.queue.find((q) => q.id === 'q-new')!.owedAt).toBeGreaterThan(0);
    // The delivered write found it stamped: still one debt.
    expect(s.owed!.filter((d) => d.item === 'q-new').length).toBe(1);
    await superSaid(SUPER, '<!-- re:abc123 -->\nThe import job is done.');
    s = await readSuperState(root);
    expect(openDebts(s).length).toBe(0);
  });

  it('a delivery that times out undoes exactly; the retry opens ONE debt that still carries the sends', async () => {
    let up = false;
    const { delivered } = await boot({ children: { c1: child('c1', { row: 'working' }) } }, () => up);
    reg('c1');
    await writeSuper(root, (s) => {
      s.children.c1.sent = ['git push'];
      s.children.c1.row = 'done';
      s.queue.push({ id: 'q-d1', sessionId: 'c1', kind: 'done', state: 'pending', createdAt: Date.now() });
    });
    await pumpSuper(root);
    await _superInboxDrained();
    let s = await readSuperState(root);
    expect(delivered.length).toBe(0);
    expect(s.owed ?? []).toEqual([]);
    expect(s.queue.find((q) => q.id === 'q-d1')!.owedAt).toBeUndefined();
    expect(s.children.c1.sent).toEqual(['git push']);
    up = true;
    await pumpSuper(root);
    await vi.waitFor(() => expect(delivered.length).toBe(1), W);
    // Not awaited, yet told in full: a send is the exception to event silence.
    expect(delivered[0].text).toMatch(/status=\S+ sent="git push" ref=\w{6}/);
    expect(delivered[0].text).toContain('sent="…" is a job that sent something out');
    s = await readSuperState(root);
    expect(openDebts(s).map((d) => d.sent)).toEqual([['git push']]);
    expect(s.children.c1.sent).toBeUndefined();
    expect(s.ownerBatches.length).toBe(1);
  });

  it('D1: his own question open, a finished job reaches the Super at once; only a child question waits', async () => {
    const { delivered } = await boot({ children: { c1: child('c1', { row: 'working', awaited: true }) } });
    reg('c1');
    await writeSuper(root, (s) => {
      s.queue.push({ id: 'q-ask-1', sessionId: SUPER, kind: 'ask', state: 'escalated', ownerText: 'Ship it?', createdAt: Date.now() });
      s.children.c1.row = 'done';
      s.queue.push({ id: 'q-d1', sessionId: 'c1', kind: 'done', state: 'pending', createdAt: Date.now() });
    });
    await pumpSuper(root);
    await vi.waitFor(() => expect(delivered.length).toBe(1), W);
    expect(delivered[0].text).toContain('item=q-d1');
    expect((await readSuperState(root)).held ?? []).toEqual([]);
  });

  it('a mid-turn message answered in its own follow-on turn costs no owed turn', async () => {
    const { h, delivered } = await boot();
    h.userSent('first');
    await superOwnerOwes(SUPER, 'first');
    // His second message goes in mid-turn; the turn ends, the Super answers both in the next turn.
    superOwnerSpoke(SUPER, Date.now(), [], [], true);
    await superOwnerOwes(SUPER, 'second');
    await superSaid(SUPER, `<!-- re:${msgRef('first')} -->\nOne.\n<!-- re:${msgRef('second')} -->\nTwo.`);
    h.observe({ type: 'result' });
    superTurnEnded(SUPER);
    await _superInboxDrained();
    await new Promise((r) => setTimeout(r, 100));
    expect(delivered.length).toBe(0);
  });

  it('a Super that sends something out itself owes it at once (Tilki field: its own WhatsApp sends)', async () => {
    const { h } = await boot();
    h.observe(toolUse('own-1', 'mcp__whatsapp__send_message', { to: 'H.K.' }));
    h.observe(toolResult('own-1'));
    await vi.waitFor(async () => expect(openDebts(await readSuperState(root)).map((d) => [d.kind, d.sent])).toEqual([['result', ['mcp whatsapp/send_message']]]), W);
  });

  it('his take-back closes every open debt', async () => {
    await boot();
    await superOwnerOwes(SUPER, 'one');
    await superOwnerOwes(SUPER, 'two');
    const s = await disableSuper(root);
    expect(openDebts(s).length).toBe(0);
    expect(s.owed!.every((d) => d.closed?.by === 'takeback')).toBe(true);
  });
});

describe('the window reads the same ledger', () => {
  it('the debt mirror and the about header agree', () => {
    const t = '[About agenda line owed=o3 section=unanswered]\nwhy is this open?';
    expect(client.aboutHeads(t)).toEqual([{ kind: 'owed', id: 'o3', at: 0, end: '[About agenda line owed=o3 section=unanswered]'.length }]);
    const s = bare();
    const d = openMessageDebt(s, 'one', 1);
    d.nudges = 2;
    const view = { ...s, vault: 'orbit' };
    expect(client.readSuperStateView(JSON.parse(JSON.stringify(view)))?.owed).toEqual(s.owed);
    expect(client.owedVisible(d)).toBe(owedVisible(d));
  });
});
