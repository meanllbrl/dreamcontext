import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSleepGet, handleSleepUpdate } from '../../src/server/routes/sleep.js';
import { readSleepState, writeSleepState } from '../../src/cli/commands/sleep.js';
import {
  PENDING_SESSION_PROVISIONAL,
  PENDING_PROVISIONAL_CAP,
} from '../../src/lib/sleep-consolidation.js';

/**
 * GET /api/sleep — persisted state + the derived effective-debt trio.
 * PATCH /api/sleep — debt + recall_mode (validated against the fixed mode list).
 */

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) {
      try { responseBody = JSON.parse(data); } catch { responseBody = data; }
    },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makePatchReq(bodyObj: unknown): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(bodyObj))]);
  return Object.assign(readable, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

let tmpDir: string;
let contextRoot: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `sleep-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A session record shaped like the ledger's, at the given score. */
function session(id: string, score: number | null) {
  return {
    session_id: id,
    transcript_path: score === null ? null : `/tmp/${id}.jsonl`,
    stopped_at: '2026-08-01T09:00:00.000Z',
    last_assistant_message: 'work happened',
    change_count: 3,
    tool_count: 12,
    score,
    task_slugs: [],
  };
}

describe('GET /api/sleep — effective debt', () => {
  it('reports effective = persisted when every session is scored', async () => {
    const state = readSleepState(contextRoot);
    state.debt = 25;
    state.sessions = [session('a', 15), session('b', 10)];
    writeSleepState(contextRoot, state);

    const { res, status, body } = makeRes();
    await handleSleepGet({} as any, res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().debt).toBe(25);
    expect(body().effective_debt).toBe(25);
    expect(body().provisional_debt).toBe(0);
    expect(body().pending_sessions).toBe(0);
  });

  it('credits provisional debt for sessions still awaiting analysis', async () => {
    const state = readSleepState(contextRoot);
    state.debt = 20;
    state.sessions = [session('a', 20), session('b', null), session('c', null)];
    writeSleepState(contextRoot, state);

    const { res, body } = makeRes();
    await handleSleepGet({} as any, res, {}, contextRoot);
    expect(body().pending_sessions).toBe(2);
    expect(body().provisional_debt).toBe(2 * PENDING_SESSION_PROVISIONAL);
    expect(body().effective_debt).toBe(20 + 2 * PENDING_SESSION_PROVISIONAL);
    // The persisted ledger is never inflated by the estimate — on disk or in the payload.
    expect(body().debt).toBe(20);
    expect(readSleepState(contextRoot).debt).toBe(20);
  });

  it('caps provisional debt so pending sessions alone cannot force a sleep', async () => {
    const state = readSleepState(contextRoot);
    state.debt = 0;
    state.sessions = Array.from({ length: 50 }, (_, i) => session(`s${i}`, null));
    writeSleepState(contextRoot, state);

    const { res, body } = makeRes();
    await handleSleepGet({} as any, res, {}, contextRoot);
    expect(body().provisional_debt).toBe(PENDING_PROVISIONAL_CAP);
    expect(body().effective_debt).toBe(PENDING_PROVISIONAL_CAP);
  });

  it('PATCH returns the same derived fields as GET', async () => {
    const state = readSleepState(contextRoot);
    state.sessions = [session('a', null)];
    writeSleepState(contextRoot, state);

    const { res, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ debt: 12 }), res, {}, contextRoot);
    expect(body().debt).toBe(12);
    expect(body().effective_debt).toBe(12 + PENDING_SESSION_PROVISIONAL);
    expect(body().pending_sessions).toBe(1);
  });
});

describe('PATCH /api/sleep — recall_mode + debt', () => {
  it('accepts a valid recall_mode, persists it, and records a field change', async () => {
    const { res, status, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: 'hybrid' }), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().recall_mode).toBe('hybrid');

    const state = readSleepState(contextRoot);
    expect(state.recall_mode).toBe('hybrid');
    const change = state.dashboard_changes.find((c) => c.field?.includes('recall_mode'));
    expect(change).toBeDefined();
    expect(change?.fields).toContainEqual({ field: 'recall_mode', from: 'haiku', to: 'hybrid' });
  });

  it.each(['haiku', 'raw', 'hybrid', 'off'] as const)('accepts recall_mode=%s', async (mode) => {
    const { res, status, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: mode }), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().recall_mode).toBe(mode);
  });

  it('rejects an unknown recall_mode with 400 invalid_value and persists nothing', async () => {
    const { res, status, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: 'bm42' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_value');
    expect(readSleepState(contextRoot).recall_mode).toBe('haiku'); // default untouched
  });

  it('rejects a non-string recall_mode', async () => {
    const { res, status, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: 42 }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_value');
  });

  it('an invalid recall_mode blocks the whole PATCH — a valid debt in the same body is not persisted', async () => {
    const { res, status } = makeRes();
    await handleSleepUpdate(makePatchReq({ debt: 5, recall_mode: 'nope' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(readSleepState(contextRoot).debt).toBe(0);
  });

  it('debt updates still work (with a field change recorded)', async () => {
    const { res, status, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ debt: 7 }), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().debt).toBe(7);

    const state = readSleepState(contextRoot);
    expect(state.debt).toBe(7);
    expect(state.dashboard_changes.some((c) => c.fields?.some((f) => f.field === 'debt' && f.to === 7))).toBe(true);
  });

  it('setting the same recall_mode again records no field change', async () => {
    const first = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: 'raw' }), first.res, {}, contextRoot);
    const before = readSleepState(contextRoot).dashboard_changes.length;

    const second = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: 'raw' }), second.res, {}, contextRoot);
    expect(second.status()).toBe(200);
    expect(readSleepState(contextRoot).dashboard_changes.length).toBe(before);
  });
});
