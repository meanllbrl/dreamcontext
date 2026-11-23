/** The committed measurement script (plan super-cocuk-tasarruf D7, criterion 13) on a synthetic
 *  projects folder: a child, its rotated successor two hops on (joined through the handoff log),
 *  an owner chat that is no child. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error a plain .mjs script, no types
import { childSessions, measure, scanConversation } from '../../scripts/measure/super-children-tokens.mjs';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const C = 'aaaaaaaa-0000-4000-8000-000000000003';
const OWNER = 'bbbbbbbb-0000-4000-8000-000000000001';
let projects: string;

const asst = (id: string, ctx: number, model = 'claude-opus-5-5', bash?: string) => ({
  type: 'assistant', message: { id, model, usage: { input_tokens: 10, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0, output_tokens: 100 }, content: bash ? [{ type: 'tool_use', name: 'Bash', input: { command: bash } }] : [] },
});
const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });

beforeAll(() => {
  projects = mkdtempSync(join(tmpdir(), 'dc-measure-'));
  const dir = join(projects, '-orbit');
  mkdirSync(dir, { recursive: true });
  const write = (sid: string, recs: unknown[]) => writeFileSync(join(dir, `${sid}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n'));
  write(A, [user('Build the Orbit footer'), asst('a1', 100_000), user('[context handoff] nudge'), asst('a2', 260_000), user('and the header too'), asst('a3', 300_000, 'claude-opus-5-5', 'dreamcontext tasks handoff orbit-footer --done x')]);
  write(B, [user('Handoff: continue'), asst('b1', 60_000)]);
  write(C, [user('Handoff: continue'), asst('c1', 70_000, 'claude-sonnet-5-5')]);
  write(OWNER, [user('hi'), asst('o1', 500_000)]);
  mkdirSync(join(dir, A, 'subagents'), { recursive: true });
  writeFileSync(join(dir, A, 'subagents', 'agent-1.jsonl'), JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5-2', usage: {} } }));
  writeFileSync(join(dir, A, 'subagents', 'agent-1.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
});
afterAll(() => rmSync(projects, { recursive: true, force: true }));

const sup = { children: { [A]: { mode: 'develop', model: 'opus' } }, formerChildren: [] };
const log = [{ fromSession: A, toSession: B }, { fromSession: B, toSession: C }, { fromSession: OWNER, toSession: 'cccccccc-0000-4000-8000-000000000009' }];

describe('super-children-tokens.mjs', () => {
  it('joins successors transitively through the handoff log, never an owner chat\'s', () => {
    const { kids, successors } = childSessions([sup], log);
    expect([...kids.keys()].sort()).toEqual([A, B, C].sort());
    expect(successors).toBe(2);
    expect(kids.get(C).mode).toBe('develop');
  });

  it('scans peak, nudge, handoff and a follow-up started past the ladder', () => {
    const r = scanConversation([user('x'), asst('1', 100_000), user('[context handoff] n'), asst('2', 260_000), user('more'), asst('3', 270_000, 'claude-opus-5-5', 'dreamcontext tasks handoff t')], 250_000);
    expect(r.peak).toBe(270_000);
    expect(r.nudges).toEqual([100_000]);
    expect(r.handoffs).toEqual([270_000]);
    expect(r.followUpsAbove).toBe(1);
  });

  it('reproduces the table: children incl. successors, nudge, handoff, follow-ups, models, Fable sub-agents', () => {
    const t = measure({ superRecords: [sup], handoffLines: log, projectsDir: projects, ladder: 250_000 });
    expect(t.children).toBe(3);
    expect(t.successorConversations).toBe(2);
    expect(t.pastLadder).toBe(1);
    expect(t.nudged).toBe(1);
    expect(t.handedOff).toBe(1);
    expect(t.handoffAt.p50).toBe(300_000);
    expect(t.followUpsAboveLadder).toBe(1);
    expect(t.byModeModel['develop/opus'].n).toBe(2);
    expect(t.byModeModel['develop/sonnet'].n).toBe(1);
    expect(t.subagents).toEqual({ total: 1, fable: 1, noModelAsked: 1 });
  });
});
