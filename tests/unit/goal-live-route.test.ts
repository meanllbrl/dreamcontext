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

function writeLive(state: Record<string, unknown>): void {
  mkdirSync(join(ctxRoot, 'tmp'), { recursive: true });
  writeFileSync(join(ctxRoot, 'tmp', '.goal-skill-live.json'), JSON.stringify(state), 'utf-8');
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
});
