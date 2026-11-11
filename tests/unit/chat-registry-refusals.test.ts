/**
 * K2 (uye-bildirim): a refused tool call in a Super-crew chat becomes an owner wait of kind
 * `refusal`, read from the stream itself. A refused turn still ends `success`, so before this a
 * refused call was byte-identical to an allowed one for every reader (probe `replay.ts`) and the
 * owner never heard.
 *
 * Driven through the REAL `registerChat().observe()` with recorded Claude Code 2.1.322 streams
 * (tests/fixtures/refusals: auto, dontask, rules, auto-hook) and one SYNTHETIC classifier block
 * (its shape could not be reproduced on demand; pinned here as inferred). Each row is one line of
 * plan criterion 1.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/dc-refusals-`);
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PERMISSION_FULL_CAP, _resetChatRegistry, bridgeRefusalFrame, crewHandle, getChat, onOwnerWaitChange, ownerWaitAnswered,
  refusalSource, registerChat, registerCrewHandle, setChatPermissionMode, type ChatHandle,
} from '../../src/lib/assistant/chat-registry.js';
import { refusalWaitId, noteSuperSend, _resetSuperSends, type OwnerWait } from '../../src/lib/super/owner-wait.js';
import { MAX_REFUSAL_INPUT } from '../../src/lib/super/types.js';
import { canonicalInput } from '../../src/lib/grants/canonical.js';

type Frame = Record<string, unknown>;
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'refusals');
const stream = (name: string): Frame[] => readFileSync(join(FIX, name), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Frame);

let n = 0;
function open(opts: { crew?: boolean; mode?: string } = {}): { h: ChatHandle; sid: string } {
  const sid = `11111111-2222-4333-8444-${String(++n).padStart(12, '0')}`;
  const h = registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode: 'basic', crew: opts.crew ?? true, permissionMode: opts.mode ?? 'auto' });
  h.userSent('go');
  return { h, sid };
}
function replay(frames: Frame[], opts: { crew?: boolean; mode?: string } = {}): { h: ChatHandle; sid: string; waits: OwnerWait[] } {
  const { h, sid } = open(opts);
  for (const f of frames) h.observe(f);
  return { h, sid, waits: waitsOf(sid) };
}
const waitsOf = (sid: string): OwnerWait[] => (getChat(sid)?.ownerWaits ?? []).filter((w) => w.kind === 'refusal');

// ─── Synthetic frames in the measured shapes ────────────────────────────────────────────────

const call = (id: string, command: string, tool = 'Bash'): Frame => ({
  type: 'assistant', parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input: tool === 'Bash' ? { command, description: 'd' } : { file_path: command } }] },
});
const rejected = (id: string, decision: Record<string, unknown>, kind?: string, text = 'denied'): Frame => ({
  type: 'user', parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', content: text, is_error: true, tool_use_id: id }] },
  tool_result_meta: [{ id, ...(kind ? { non_execution_kind: kind } : {}), permission_decision: { decision: 'reject', ...decision } }],
});
const accepted = (id: string): Frame => ({
  type: 'user', parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', is_error: false, tool_use_id: id }] },
  tool_result_meta: [{ id, permission_decision: { decision: 'accept', source: 'config', reason_type: 'classifier' } }],
});
const classifierBlock = (id: string, command: string): Frame[] => [
  call(id, command),
  { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: id, decision_reason_type: 'classifier', message: 'blocked by the safety check' },
  rejected(id, { source: 'config', reason_type: 'classifier', classifier_category: 'interfere_with_workloads' }, 'automode-blocked'),
];
const result: Frame = { type: 'result', subtype: 'success', is_error: false, result: 'done' };

beforeEach(() => { _resetChatRegistry(); _resetSuperSends(); });

describe('K2 — refusals read from the stream, as plan criterion 1 lists them', () => {
  it('an allowed call (recorded auto stream, classifier accept) and a hook allow are no refusal', () => {
    expect(replay(stream('auto.jsonl')).waits).toEqual([]);
    expect(replay(stream('auto-hook.jsonl')).waits).toEqual([]);
  });

  it('the classifier block in an auto crew session: one refusal with tool, input and category', () => {
    const { waits } = replay(stream('classifier-block.synthetic.jsonl'));
    const cmd = 'kubectl delete deployment acme-api --namespace prod';
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      kind: 'refusal', id: refusalWaitId('Bash', cmd), key: 'Bash',
      refusal: { tool: 'Bash', input: cmd, whole: true, source: 'classifier', category: 'interfere_with_workloads' },
    });
    expect(waits[0].refusal?.reason).toMatch(/blocked/);
  });

  it('a mode refusal in an auto crew session is a refusal; in dontAsk or plan it is the owner\'s envelope', () => {
    const auto = replay(stream('dontask.jsonl'), { mode: 'auto' }).waits;
    expect(auto).toHaveLength(1);
    expect(auto[0].refusal).toMatchObject({ tool: 'Bash', input: 'touch probe.txt', whole: true, source: 'mode' });
    expect(auto[0].refusal?.reason).toMatch(/don't ask mode/);
    expect(replay(stream('dontask.jsonl'), { mode: 'dontAsk' }).waits).toEqual([]);
    expect(replay(stream('dontask.jsonl'), { mode: 'plan' }).waits).toEqual([]);
  });

  it('a settings deny rule and a settings ask rule (recorded) are refusals by rule', () => {
    const { waits } = replay(stream('rules.jsonl'), { mode: 'default' });
    expect(waits.map((w) => [w.refusal?.input, w.refusal?.source])).toEqual([['touch rule-denied.txt', 'rule'], ['touch rule-ask.txt', 'rule']]);
    // The deny rule has no permission_denied event: its reason is the tool_result's own text.
    expect(waits[0].refusal?.reason).toMatch(/has been denied/);
    expect(waits[1].refusal?.reason).toMatch(/haven't granted it yet/);
  });

  it('a hook deny is dreamcontext\'s own guidance: none', () => {
    expect(replay([call('t1', 'rm -rf build'), rejected('t1', { source: 'hook', reason_type: 'hook' }), result]).waits).toEqual([]);
  });

  it('the decider\'s own no (user_reject, a user source, an interrupted call): none', () => {
    expect(replay([call('t1', 'ls'), rejected('t1', { source: 'user', reason_type: 'user_reject' }, 'user-rejected'), result]).waits).toEqual([]);
    expect(replay([call('t1', 'ls'), rejected('t1', { source: 'user_temporary' }), result]).waits).toEqual([]);
    expect(replay([call('t1', 'ls'), rejected('t1', { source: 'config' }, 'interrupted'), result]).waits).toEqual([]);
  });

  it('refused then run after all in the same turn (a description change included): none', () => {
    const frames = [...classifierBlock('t1', 'node scripts/deploy.mjs'), call('t2', '  node scripts/deploy.mjs  '), accepted('t2'), result];
    expect(replay(frames).waits).toEqual([]);
    // Run BEFORE the refusal does not count: the refusal is still his.
    const before = [call('t0', 'node scripts/deploy.mjs'), accepted('t0'), ...classifierBlock('t1', 'node scripts/deploy.mjs'), result];
    expect(replay(before).waits).toHaveLength(1);
  });

  it('an unknown kind is a refusal, never read as allowed', () => {
    expect(replay([call('t1', 'ls'), rejected('t1', { source: 'mystery', reason_type: 'weird' }), result]).waits[0]?.refusal?.source).toBe('unknown');
    expect(replay([call('t1', 'ls'), { ...rejected('t1', {}), tool_result_meta: [{ id: 't1', permission_decision: { decision: 'deny' } }] }, result]).waits[0]?.refusal?.source).toBe('unknown');
  });

  it('five refusals keep four (the newest), and the same call refused twice is one', () => {
    const frames = [1, 2, 3, 4, 5].flatMap((i) => classifierBlock(`t${i}`, `node s${i}.mjs`));
    frames.push(...classifierBlock('t6', 'node s5.mjs'), result);
    const { waits } = replay(frames);
    expect(waits.map((w) => w.refusal?.input)).toEqual(['node s2.mjs', 'node s3.mjs', 'node s4.mjs', 'node s5.mjs']);
  });

  it('the bridge\'s unattended deny frame is a refusal with the call it carries', () => {
    const input = { file_path: '/acme/src/app.ts', old_string: 'a', new_string: 'b' };
    const { waits } = replay([bridgeRefusalFrame('Edit', input, 'Denied while nobody was watching', 'call-7'), result]);
    expect(waits).toHaveLength(1);
    expect(waits[0].refusal).toMatchObject({ tool: 'Edit', input: canonicalInput('Edit', input), source: 'bridge', reason: 'Denied while nobody was watching' });
    expect(bridgeRefusalFrame('Bash', { command: 'ls' }, 'x')).not.toHaveProperty('tool_use_id');
  });

  it('an input over the cap is kept cut and marked not whole, under the id of the whole call', () => {
    const cmd = `echo ${'x'.repeat(PERMISSION_FULL_CAP + 10)}`;
    const [w] = replay([...classifierBlock('t1', cmd), result]).waits;
    expect(w.refusal?.whole).toBe(false);
    expect(w.refusal?.input).toHaveLength(PERMISSION_FULL_CAP);
    expect(w.id).toBe(refusalWaitId('Bash', cmd));
    expect(MAX_REFUSAL_INPUT).toBe(PERMISSION_FULL_CAP);
  });

  it('a plain chat (not crew) produces none', () => {
    expect(replay(stream('classifier-block.synthetic.jsonl'), { crew: false }).waits).toEqual([]);
    expect(replay(stream('rules.jsonl'), { crew: false, mode: 'default' }).waits).toEqual([]);
  });

  it('the input comes from the result\'s permission_denials when the call frame never came', () => {
    const lines = stream('classifier-block.synthetic.jsonl').filter((f) => f.type !== 'assistant');
    const [w] = replay(lines).waits;
    expect(w.refusal?.input).toBe('kubectl delete deployment acme-api --namespace prod');
  });

  it('a turn stopped with no result drops its refusals', () => {
    const { h, sid } = open();
    for (const f of classifierBlock('t1', 'node s.mjs')) h.observe(f);
    h.stopSettled();
    h.observe(result);
    expect(waitsOf(sid)).toEqual([]);
  });

  it('the told mode is what counts, and a live change is heard (setChatPermissionMode)', () => {
    const { h, sid } = open({ mode: 'auto' });
    setChatPermissionMode(sid, 'dontAsk');
    for (const f of stream('dontask.jsonl')) h.observe(f);
    expect(waitsOf(sid)).toEqual([]);
    expect(getChat(sid)?.permissionMode).toBe('dontAsk');
  });
});

describe('K2 — how a refusal closes', () => {
  it('the same call run in a later turn closes it (seen answered), and the owner channel says so', () => {
    const { h, sid } = open();
    const seen: number[] = [];
    onOwnerWaitChange((e) => { if (e.sessionId === sid) seen.push((e.ownerWaits ?? []).length); });
    for (const f of [...classifierBlock('t1', 'node s.mjs'), result]) h.observe(f);
    expect(waitsOf(sid)).toHaveLength(1);
    const id = waitsOf(sid)[0].id;
    h.userSent('try again');
    // His words close it already; a fresh refusal reopens it as a new ask.
    expect(waitsOf(sid)).toEqual([]);
    for (const f of [...classifierBlock('t2', 'node s.mjs'), result]) h.observe(f);
    expect(waitsOf(sid)).toHaveLength(1);
    expect(ownerWaitAnswered(sid, 'refusal', id)).toBe(false);
    for (const f of [call('t3', 'node s.mjs'), accepted('t3')]) h.observe(f);
    expect(waitsOf(sid)).toEqual([]);
    expect(ownerWaitAnswered(sid, 'refusal', id)).toBe(true);
    expect(seen).toEqual([1, 0, 1, 0]);
  });

  it('the owner writing into the session closes it; the server\'s own turn and a Super send never do', () => {
    const { h, sid } = open();
    for (const f of [...classifierBlock('t1', 'node s.mjs'), result]) h.observe(f);
    h.userSent('The owner allowed exactly this call, once. Run it unchanged, then go on.', { server: true });
    expect(waitsOf(sid)).toHaveLength(1);
    noteSuperSend(sid, 'carry on with the rest');
    h.userSent('carry on with the rest');
    expect(waitsOf(sid)).toHaveLength(1);
    h.userSent('skip that, use the staging cluster');
    expect(waitsOf(sid)).toEqual([]);
  });
});

describe('refusalSource — the mapping, total', () => {
  type Row = [string, Record<string, unknown> | null, Record<string, unknown> | null, string, string | null];
  const pd = (o: Record<string, unknown>): Record<string, unknown> => ({ permission_decision: { decision: 'reject', ...o } });
  const rows: Row[] = [
    ['accept', { permission_decision: { decision: 'accept', source: 'config' } }, null, 'auto', null],
    ['nothing', null, null, 'auto', null],
    ['hook', pd({ source: 'hook', reason_type: 'hook' }), null, 'auto', null],
    ['mode in dontAsk', pd({ source: 'config', reason_type: 'mode' }), null, 'dontAsk', null],
    ['mode in plan', pd({ source: 'config', reason_type: 'mode' }), null, 'plan', null],
    ['mode in auto', pd({ source: 'config', reason_type: 'mode' }), null, 'auto', 'mode'],
    ['user', pd({ source: 'user', reason_type: 'user_reject' }), null, 'auto', null],
    ['interrupted', { non_execution_kind: 'interrupted', ...pd({ source: 'config' }) }, null, 'auto', null],
    ['ask rule (user-rejected kind, config source)', { non_execution_kind: 'user-rejected', ...pd({ source: 'config' }) }, { decision_reason_type: 'rule' }, 'default', 'rule'],
    ['deny rule', pd({ source: 'config', reason_type: 'rule' }), null, 'default', 'rule'],
    ['classifier', pd({ source: 'config', reason_type: 'classifier' }), null, 'auto', 'classifier'],
    ['automode-blocked kind alone', { non_execution_kind: 'automode-blocked', ...pd({ source: 'config', reason_type: 'something' }) }, null, 'auto', 'classifier'],
    ['bridge event only', null, { decision_reason_type: 'bridge' }, 'auto', 'bridge'],
    ['event only, unknown', null, { decision_reason_type: 'novel' }, 'auto', 'unknown'],
    ['unknown', pd({ source: 'mystery' }), null, 'auto', 'unknown'],
  ];
  it.each(rows)('%s', (_name, meta, ev, mode, want) => {
    expect(refusalSource(meta, ev, mode)).toBe(want);
  });
});

describe('crew handles', () => {
  it('register, read, and an unregister that removes only its own handle', () => {
    const a = { sendServerTurn: vi.fn(() => true) };
    const b = { sendServerTurn: vi.fn(() => false) };
    expect(crewHandle('s1')).toBeNull();
    const offA = registerCrewHandle('s1', a);
    expect(crewHandle('s1')).toBe(a);
    const offB = registerCrewHandle('s1', b);
    offA();
    expect(crewHandle('s1')).toBe(b);
    expect(crewHandle('s1')?.sendServerTurn('x')).toBe(false);
    offB();
    expect(crewHandle('s1')).toBeNull();
    registerCrewHandle('s2', a);
    _resetChatRegistry();
    expect(crewHandle('s2')).toBeNull();
  });
});
