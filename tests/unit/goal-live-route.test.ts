import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAgentGoalLive } from '../../src/server/routes/agent-terminal.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: any = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) {
      try { responseBody = JSON.parse(data); } catch { responseBody = data; }
    },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody };
}

function makeReq(query = ''): IncomingMessage {
  return { method: 'GET', url: `/api/agent/goal-live${query}`, headers: { host: 'localhost' } } as unknown as IncomingMessage;
}

const ORCH = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

let ctxRoot: string;

function writeLive(state: Record<string, unknown>, file = '.goal-skill-live.json'): void {
  mkdirSync(join(ctxRoot, 'tmp'), { recursive: true });
  writeFileSync(join(ctxRoot, 'tmp', file), JSON.stringify(state), 'utf-8');
}

function freshState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return { goal: 'demo', started: now, updated: now, phase: 'impl', iters: { plan: 2 }, ...extra };
}

beforeEach(() => {
  ctxRoot = join(tmpdir(), `goal-live-${Date.now()}-${Math.random().toString(36).slice(2)}`, '_dream_context');
  mkdirSync(ctxRoot, { recursive: true });
});

afterEach(() => {
  rmSync(join(ctxRoot, '..'), { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/agent/goal-live', () => {
  it('no live file → inactive', async () => {
    const { res, status, body } = makeRes();
    await handleAgentGoalLive(makeReq(), res, {}, ctxRoot);
    expect(status()).toBe(200);
    expect(body()).toEqual({ active: false });
  });

  it('no vault (contextRoot null) → inactive', async () => {
    const { res, body } = makeRes();
    await handleAgentGoalLive(makeReq(), res, {}, null);
    expect(body()).toEqual({ active: false });
  });

  it('fresh unstamped state → active for any pane (back-compat)', async () => {
    writeLive(freshState());
    const { res, body } = makeRes();
    await handleAgentGoalLive(makeReq(`?claudeId=${OTHER}`), res, {}, ctxRoot);
    expect(body().active).toBe(true);
    expect(body().state.phase).toBe('impl');
  });

  it('stamped state + matching pane id → active', async () => {
    writeLive(freshState({ session: ORCH }));
    const { res, body } = makeRes();
    await handleAgentGoalLive(makeReq(`?claudeId=${ORCH}`), res, {}, ctxRoot);
    expect(body().active).toBe(true);
  });

  it('stamped state + DIFFERENT pane id → inactive (session scoping)', async () => {
    writeLive(freshState({ session: ORCH }));
    const { res, body } = makeRes();
    await handleAgentGoalLive(makeReq(`?claudeId=${OTHER}`), res, {}, ctxRoot);
    expect(body()).toEqual({ active: false });
  });

  it('abandoned state (>3h old) → inactive', async () => {
    const old = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    writeLive({ goal: 'stale', started: old, updated: old, phase: 'plan' });
    const { res, body } = makeRes();
    await handleAgentGoalLive(makeReq(), res, {}, ctxRoot);
    expect(body()).toEqual({ active: false });
  });

  it('malformed live file → inactive, no throw', async () => {
    mkdirSync(join(ctxRoot, 'tmp'), { recursive: true });
    writeFileSync(join(ctxRoot, 'tmp', '.goal-skill-live.json'), 'not-json', 'utf-8');
    const { res, body } = makeRes();
    await handleAgentGoalLive(makeReq(), res, {}, ctxRoot);
    expect(body()).toEqual({ active: false });
  });

  // ── Concurrent runs: one per-session file each ─────────────────────────────

  it('two concurrent stamped runs → each pane sees its OWN run', async () => {
    writeLive(freshState({ goal: 'run-a', session: ORCH }), `.goal-skill-live.${ORCH}.json`);
    writeLive(freshState({ goal: 'run-b', session: OTHER, phase: 'plan' }), `.goal-skill-live.${OTHER}.json`);

    const a = makeRes();
    await handleAgentGoalLive(makeReq(`?claudeId=${ORCH}`), a.res, {}, ctxRoot);
    expect(a.body().active).toBe(true);
    expect(a.body().state.goal).toBe('run-a');

    const b = makeRes();
    await handleAgentGoalLive(makeReq(`?claudeId=${OTHER}`), b.res, {}, ctxRoot);
    expect(b.body().active).toBe(true);
    expect(b.body().state.goal).toBe('run-b');
  });

  it('two stamped runs + unrelated pane → inactive', async () => {
    writeLive(freshState({ session: ORCH }), `.goal-skill-live.${ORCH}.json`);
    writeLive(freshState({ session: OTHER }), `.goal-skill-live.${OTHER}.json`);
    const third = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { res, body } = makeRes();
    await handleAgentGoalLive(makeReq(`?claudeId=${third}`), res, {}, ctxRoot);
    expect(body()).toEqual({ active: false });
  });

  it('stamped mismatch falls back to a fresh UNSTAMPED legacy file', async () => {
    writeLive(freshState({ goal: 'mine', session: ORCH }), `.goal-skill-live.${ORCH}.json`);
    writeLive(freshState({ goal: 'legacy' }));
    const { res, body } = makeRes();
    await handleAgentGoalLive(makeReq(`?claudeId=${OTHER}`), res, {}, ctxRoot);
    expect(body().active).toBe(true);
    expect(body().state.goal).toBe('legacy');
  });

  it('stale per-session file is skipped; the fresh one still matches', async () => {
    const old = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    writeLive({ goal: 'dead', session: OTHER, started: old, updated: old, phase: 'impl' }, `.goal-skill-live.${OTHER}.json`);
    writeLive(freshState({ goal: 'alive', session: ORCH }), `.goal-skill-live.${ORCH}.json`);
    const { res, body } = makeRes();
    await handleAgentGoalLive(makeReq(`?claudeId=${ORCH}`), res, {}, ctxRoot);
    expect(body().active).toBe(true);
    expect(body().state.goal).toBe('alive');
  });

  it('no pane id + multiple runs → freshest run wins', async () => {
    const older = new Date(Date.now() - 60_000).toISOString();
    writeLive({ goal: 'older', session: ORCH, started: older, updated: older, phase: 'plan' }, `.goal-skill-live.${ORCH}.json`);
    writeLive(freshState({ goal: 'newest', session: OTHER }), `.goal-skill-live.${OTHER}.json`);
    const { res, body } = makeRes();
    await handleAgentGoalLive(makeReq(), res, {}, ctxRoot);
    expect(body().active).toBe(true);
    expect(body().state.goal).toBe('newest');
  });
});
