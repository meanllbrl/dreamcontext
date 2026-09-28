import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEAMMATE_QUIET_MS, TEAMMATE_STEP_CAP, readTeammateTranscript, summarizeTeammateTranscript, teammatesAlive,
} from '../../src/lib/headless-teammate.js';
import {
  handleAgentTeammateHistory, handleAgentTeammates, launchedAt, launchedBy, parseLaunched, registeredTeammates,
} from '../../src/server/routes/agent-teammates.js';

// ─── Transcript fixtures (the shapes claude 2.1.281 writes for a `-p` run) ─────────

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const T = (s: number) => new Date(Date.UTC(2026, 8, 26, 10, 0, s)).toISOString();

const enqueue = (prompt: string, s = 0) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: T(s), content: prompt, sessionId: SID });
const userText = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'assistant', message: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] } });
const answer = (text: string) => ({ type: 'assistant', message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const exit = { type: 'cost-state', sessionId: SID, totalDuration: 42000 };

const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const NOW = Date.parse(T(100));

describe('summarizeTeammateTranscript: status is asked of the transcript', () => {
  const working = [enqueue('Plan the payment line'), userText('Plan the payment line'), toolUse('t1', 'Read', { file_path: 'src/a.ts' }), toolResult('t1'), toolUse('t2', 'Grep', { pattern: 'balance' })];

  it('reads the brief, the steps and a live run', () => {
    const s = summarizeTeammateTranscript(SID, jsonl(working), NOW, NOW, true);
    expect(s.status).toBe('running');
    expect(s.brief).toBe('Plan the payment line');
    expect(s.startedAt).toBe(Date.parse(T(0)));
    expect(s.steps.map((x) => [x.name, x.status])).toEqual([['Read', 'done'], ['Grep', 'running']]);
    expect(s.toolUses).toBe(2);
    expect(s.model).toBe('claude-opus-5-5');
    expect(s.result).toBeUndefined();
  });

  it('an exit record after a clean final answer is done, with the answer as its result', () => {
    const s = summarizeTeammateTranscript(SID, jsonl([...working, toolResult('t2'), answer('PLAN READY'), exit]), NOW, NOW, false);
    expect(s.status).toBe('done');
    expect(s.result).toBe('PLAN READY');
    expect(s.durationMs).toBe(42000);
    expect(s.endedAt).toBe(NOW);
  });

  it('an exit record with no clean answer (killed mid-tool) is failed, and its open step did not finish', () => {
    const s = summarizeTeammateTranscript(SID, jsonl([...working, exit]), NOW, NOW, false);
    expect(s.status).toBe('failed');
    expect(s.steps[s.steps.length - 1].status).toBe('error');
  });

  it('no exit record and no process is stopped, never running forever', () => {
    expect(summarizeTeammateTranscript(SID, jsonl(working), NOW - 10 * 60_000, NOW, false).status).toBe('stopped');
  });

  it('without a process table, a recent write reads as running and a quiet one as stopped', () => {
    expect(summarizeTeammateTranscript(SID, jsonl(working), NOW - 1000, NOW, null).status).toBe('running');
    expect(summarizeTeammateTranscript(SID, jsonl(working), NOW - TEAMMATE_QUIET_MS - 1, NOW, null).status).toBe('stopped');
  });

  it('a resume is a new assignment: the brief, steps and exit are read after the latest one', () => {
    const rows = [...working, toolResult('t2'), answer('first answer'), exit, enqueue('Now fix the finding', 50), toolUse('t3', 'Edit', { file_path: 'src/b.ts' })];
    const s = summarizeTeammateTranscript(SID, jsonl(rows), NOW, NOW, true);
    expect(s.status).toBe('running');
    expect(s.brief).toBe('Now fix the finding');
    expect(s.steps.map((x) => x.name)).toEqual(['Edit']);
    expect(s.result).toBeUndefined();
  });

  it('a resumed run started at its spawn: startedAt is the FIRST enqueue, not the resume', () => {
    const rows = [...working, toolResult('t2'), answer('first answer'), exit, enqueue('Now fix the finding', 50), toolUse('t3', 'Edit', { file_path: 'src/b.ts' })];
    const s = summarizeTeammateTranscript(SID, jsonl(rows), NOW, NOW, true);
    expect(s.startedAt).toBe(Date.parse(T(0)));
    expect(s.brief).toBe('Now fix the finding');
  });

  it('caps the steps it returns, but counts them all', () => {
    const rows: unknown[] = [enqueue('go')];
    for (let i = 0; i < 20; i += 1) rows.push(toolUse(`t${i}`, 'Read', { file_path: `f${i}` }), toolResult(`t${i}`));
    const s = summarizeTeammateTranscript(SID, jsonl(rows), NOW, NOW, true);
    expect(s.steps).toHaveLength(TEAMMATE_STEP_CAP);
    expect(s.toolUses).toBe(20);
  });

  it('a write payload is never carried as a step label', () => {
    const s = summarizeTeammateTranscript(SID, jsonl([enqueue('go'), toolUse('w', 'Write', { file_path: 'x.ts', content: 'x'.repeat(5000) })]), NOW, NOW, true);
    const input = s.steps[0].input as Record<string, string>;
    expect(input.file_path).toBe('x.ts');
    expect(input.content.length).toBeLessThanOrEqual(201);
  });

  it('tolerates a half-written last line', () => {
    const s = summarizeTeammateTranscript(SID, `${jsonl(working)}{"type":"assist`, NOW, NOW, true);
    expect(s.toolUses).toBe(2);
  });
});

describe('teammatesAlive', () => {
  it('an id no process carries is not alive', async () => {
    const alive = await teammatesAlive(['deadbeef-0000-0000-0000-000000000000']);
    // null only when `ps` itself is missing; on this machine it answers.
    expect([false, null]).toContain(alive.get('deadbeef-0000-0000-0000-000000000000'));
  });
});

// ─── Reading the file safely, and the route's authorization ──────────────────────

let home: string;
let ctxRoot: string;
const PANE = '11111111-2222-3333-4444-555555555555';
const prevHome = process.env.HOME;
const prevDesktop = process.env.DREAMCONTEXT_DESKTOP;

function writeTranscript(id: string, rows: unknown[], dir = 'wt-slug'): string {
  const d = join(home, '.claude', 'projects', dir);
  mkdirSync(d, { recursive: true });
  const p = join(d, `${id}.jsonl`);
  writeFileSync(p, jsonl(rows));
  return p;
}

function writeLive(lineage: unknown[], session = PANE): void {
  const now = new Date().toISOString();
  mkdirSync(join(ctxRoot, 'tmp'), { recursive: true });
  writeFileSync(join(ctxRoot, 'tmp', `.goal-skill-live.${session}.json`), JSON.stringify({ session, started: now, updated: now, phase: 'plan', lineage }));
}

function call(handler: typeof handleAgentTeammates, query: string): Promise<any> {
  let body: any = null;
  const res = { writeHead() {}, setHeader() {}, end(d: string) { body = JSON.parse(d); } } as unknown as ServerResponse;
  const req = { method: 'GET', url: `/api/agent/x?${query}`, headers: { host: 'localhost' } } as unknown as IncomingMessage;
  return handler(req, res, {}, ctxRoot).then(() => body);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'teammate-home-'));
  ctxRoot = join(home, 'proj', '_dream_context');
  mkdirSync(ctxRoot, { recursive: true });
  process.env.HOME = home;
  process.env.DREAMCONTEXT_DESKTOP = '1';
});

afterEach(() => {
  process.env.HOME = prevHome;
  if (prevDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = prevDesktop;
  rmSync(home, { recursive: true, force: true });
});

describe('readTeammateTranscript', () => {
  it('finds a run under any project slug (a worktree run lives under its own)', () => {
    writeTranscript(SID, [enqueue('go')], '-Users-x--claude-worktrees-feature');
    expect(readTeammateTranscript(SID, home)?.raw).toContain('"enqueue"');
  });

  it('refuses a non-UUID id before touching the disk', () => {
    expect(readTeammateTranscript('../../etc/passwd', home)).toBeNull();
    expect(readTeammateTranscript('AAAAAAAA-1111-2222-3333-444444444444', home)).toBeNull();
  });

  it('refuses a symlinked transcript', () => {
    const outside = join(home, 'secret.jsonl');
    writeFileSync(outside, 'secret\n');
    const d = join(home, '.claude', 'projects', 'evil');
    mkdirSync(d, { recursive: true });
    symlinkSync(outside, join(d, `${SID}.jsonl`));
    expect(readTeammateTranscript(SID, home)).toBeNull();
  });
});

describe('route helpers', () => {
  it('registeredTeammates keeps strict UUIDs only, newest registration per id', () => {
    const got = registeredTeammates({ lineage: [
      { a: 'planner', role: 'planner', k: 'spawn', sid: SID, at: T(1) },
      { a: 'T1', role: 'implementer', k: 'fork', sid: 'not-a-uuid' },
      { a: 'planner', role: 'planner', k: 'resume', sid: SID, at: T(9) },
      { a: 'critic', role: 'critic', k: 'fresh' },
    ] });
    expect(got).toEqual([{ sid: SID, actor: 'planner', role: 'planner', kind: 'resume', at: T(9) }]);
  });

  it('parseLaunched drops anything that is not a UUID and caps the list', () => {
    expect(parseLaunched(`${SID},../x,${SID.toUpperCase()}`)).toEqual([SID]);
    expect(parseLaunched(null)).toEqual([]);
  });

  it('launchedAt reads the launching line\'s own timestamp', () => {
    const pane = [
      JSON.stringify({ type: 'user', timestamp: T(1), message: { content: 'go' } }),
      JSON.stringify({ type: 'assistant', timestamp: T(7), message: { content: [{ type: 'tool_use', input: { command: `claude -p --session-id ${SID} x` } }] } }),
    ].join('\n');
    expect(launchedAt(pane, SID)).toBe(Date.parse(T(7)));
    expect(launchedAt(pane, 'bbbbbbbb-1111-2222-3333-444444444444')).toBeNull();
  });

  it('launchedBy needs the id as a --session-id argument, not just anywhere', () => {
    expect(launchedBy(`"command":"claude -p --session-id ${SID} 'go'"`, SID)).toBe(true);
    expect(launchedBy(`"command":"claude -p --session-id=${SID}"`, SID)).toBe(true);
    expect(launchedBy(`"text":"look at ${SID}"`, SID)).toBe(false);
  });
});

describe('GET /api/agent/teammates', () => {
  it('serves a registered teammate, summarized from its own transcript', async () => {
    writeTranscript(SID, [enqueue('Draft the plan'), toolUse('t1', 'Read', { file_path: 'a.ts' }), toolResult('t1'), answer('PLAN'), exit]);
    writeLive([{ a: 'planner', role: 'planner', k: 'spawn', sid: SID, at: new Date().toISOString() }]);
    const body = await call(handleAgentTeammates, `claudeId=${PANE}`);
    expect(body.teammates).toHaveLength(1);
    expect(body.teammates[0]).toMatchObject({ session: SID, status: 'done', brief: 'Draft the plan', result: 'PLAN', actor: 'planner', role: 'planner', kind: 'spawn' });
  });

  it('a registered run with no transcript is starting, then never started', async () => {
    writeLive([{ a: 'planner', role: 'planner', k: 'spawn', sid: SID, at: new Date().toISOString() }]);
    expect((await call(handleAgentTeammates, `claudeId=${PANE}`)).teammates[0]).toMatchObject({ status: 'running', missing: true });
    writeLive([{ a: 'planner', role: 'planner', k: 'spawn', sid: SID, at: new Date(Date.now() - 10 * 60_000).toISOString() }]);
    expect((await call(handleAgentTeammates, `claudeId=${PANE}`)).teammates[0]).toMatchObject({ status: 'failed', missing: true });
  });

  it('another pane\'s registered teammate is not served', async () => {
    writeTranscript(SID, [enqueue('x')]);
    writeLive([{ a: 'planner', role: 'planner', k: 'spawn', sid: SID }], '99999999-8888-7777-6666-555555555555');
    expect((await call(handleAgentTeammates, `claudeId=${PANE}`)).teammates).toEqual([]);
  });

  it('a launched id is served only when the pane\'s own transcript launched it', async () => {
    writeTranscript(SID, [enqueue('Build T1'), toolUse('t1', 'Edit', { file_path: 'a.ts' })]);
    const other = 'bbbbbbbb-1111-2222-3333-444444444444';
    writeTranscript(other, [enqueue('someone else')]);
    writeTranscript(PANE, [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: `claude -p --session-id ${SID} 'Build T1' &` } }] } }], 'pane-slug');
    const body = await call(handleAgentTeammates, `claudeId=${PANE}&launched=${SID},${other}`);
    expect(body.teammates.map((t: { session: string }) => t.session)).toEqual([SID]);
    expect(body.teammates[0].brief).toBe('Build T1');
  });

  it('is empty outside the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    writeLive([{ a: 'planner', role: 'planner', k: 'spawn', sid: SID }]);
    expect((await call(handleAgentTeammates, `claudeId=${PANE}`)).teammates).toEqual([]);
  });
});

describe('GET /api/agent/teammate-history', () => {
  it('replays a registered teammate\'s transcript', async () => {
    writeTranscript(SID, [enqueue('Draft the plan'), userText('Draft the plan'), answer('PLAN'), exit]);
    writeLive([{ a: 'planner', role: 'planner', k: 'spawn', sid: SID }]);
    const body = await call(handleAgentTeammateHistory, `claudeId=${PANE}&session=${SID}`);
    expect(body.items.map((i: { kind: string }) => i.kind)).toEqual(['user', 'text']);
  });

  it('refuses an id this pane has no claim to', async () => {
    // A pane of its own: a launch confirmed for another pane above must not leak into this one.
    const stranger = 'cccccccc-1111-2222-3333-444444444444';
    writeTranscript(SID, [userText('private')]);
    writeTranscript(stranger, [userText(`I mention ${SID} but never launched it`)], 'pane-slug');
    expect((await call(handleAgentTeammateHistory, `claudeId=${stranger}&session=${SID}&launched=1`)).items).toEqual([]);
  });
});
