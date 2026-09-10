/**
 * `POST /api/agent/accounts/switch-policy` (src/server/routes/agent-accounts.ts) — the route
 * that chooses WHICH rule auto-switch uses and, for the scoring rule, its coefficients.
 *
 * The underlying `setSwitchPolicy` is covered in `claude-accounts.test.ts`; nothing covered
 * the route, so its two most load-bearing behaviours were invisible to CI:
 *
 *  1. a PARTIAL patch merges over what is saved — the `strategy` and each coefficient move
 *     independently, so one control's request can never reset another's value;
 *  2. a present-but-INVALID value is a 422, never a silent fall back to the default. A
 *     coefficient the server quietly rewrote would leave the user reading a number the
 *     chooser is not using, which is the same class of untruth as switching the billed
 *     account without saying so.
 *
 * The route is desktop + loopback gated like every sibling account route, so each case here
 * drives the real handler with that gate satisfied and a scratch HOME.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAgentAccountsSwitchPolicy } from '../../src/server/routes/agent-accounts.js';
import {
  claudeAccountsFilePath,
  setSwitchPolicy,
  switchStrategyFor,
  switchWeightsFor,
  writeClaudeAccounts,
} from '../../src/lib/claude-accounts.js';
import { DEFAULT_SWITCH_WEIGHTS } from '../../src/lib/claude-account-switch.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-switch-policy-'));
const REAL_HOME = process.env.HOME;

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  delete process.env.DREAMCONTEXT_DESKTOP;
  rmSync(HOME, { recursive: true, force: true });
});

function fakeRes(): { res: ServerResponse; captured: { status: number; body: any } } {
  const captured = { status: 0, body: null as any };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function post(body: unknown): Promise<{ status: number; body: any }> {
  // BUFFERS, not strings: `parseJsonBody` concatenates with `Buffer.concat`, so a stream of
  // strings reads as an unparseable body and every case would 422 for the wrong reason.
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]) as unknown as IncomingMessage;
  (req as any).url = '/api/agent/accounts/switch-policy';
  (req as any).method = 'POST';
  (req as any).headers = { host: '127.0.0.1:1234', 'content-type': 'application/json' };
  // `isLoopback` reads the SOCKET, not the Host header — a header alone would not satisfy
  // the gate, and a test that passed on one would be testing the wrong thing.
  (req as any).socket = { remoteAddress: '127.0.0.1' };
  const { res, captured } = fakeRes();
  await handleAgentAccountsSwitchPolicy(req, res);
  return captured;
}

beforeEach(() => {
  process.env.HOME = HOME;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  rmSync(claudeAccountsFilePath(HOME), { force: true });
  writeClaudeAccounts([], HOME);
});

describe('POST /api/agent/accounts/switch-policy', () => {
  it('sets the mode and echoes the saved policy back', async () => {
    const out = await post({ strategy: 'sequential' });
    expect(out.status).toBe(200);
    expect(out.body.switchStrategy).toBe('sequential');
    expect(switchStrategyFor(HOME)).toBe('sequential');
  });

  it('sets the coefficients', async () => {
    const out = await post({ weights: { session: 2, weekly: 6, order: 1 } });
    expect(out.status).toBe(200);
    expect(switchWeightsFor(HOME)).toEqual({ session: 2, weekly: 6, order: 1 });
  });

  it('a PARTIAL weights patch moves one coefficient and leaves the others alone', async () => {
    setSwitchPolicy({ weights: { session: 3, weekly: 7, order: 9 } }, HOME);
    const out = await post({ weights: { order: 1 } });
    expect(out.status).toBe(200);
    expect(switchWeightsFor(HOME)).toEqual({ session: 3, weekly: 7, order: 1 });
  });

  it('setting the mode does not touch the coefficients', async () => {
    setSwitchPolicy({ weights: { session: 3, weekly: 7, order: 9 } }, HOME);
    await post({ strategy: 'sequential' });
    expect(switchWeightsFor(HOME)).toEqual({ session: 3, weekly: 7, order: 9 });
  });

  it('accepts 0 — it is how a user says "ignore this term"', async () => {
    const out = await post({ weights: { session: 0, weekly: 0, order: 1 } });
    expect(out.status).toBe(200);
    expect(switchWeightsFor(HOME)).toEqual({ session: 0, weekly: 0, order: 1 });
  });

  it('an unknown strategy is refused, and nothing is written', async () => {
    const out = await post({ strategy: 'roulette' });
    expect(out.status).toBe(422);
    expect(switchStrategyFor(HOME)).toBe('score');
  });

  it.each([
    ['negative', { order: -1 }],
    ['not a number', { order: '5' }],
    ['NaN', { order: Number.NaN }],
    ['Infinity', { order: Number.POSITIVE_INFINITY }],
  ])('a present-but-invalid coefficient (%s) is a 422, never a silent default', async (_label, weights) => {
    setSwitchPolicy({ weights: { session: 3, weekly: 7, order: 9 } }, HOME);
    const out = await post({ weights });
    expect(out.status).toBe(422);
    // Refused means REFUSED: the saved value is untouched, not reset to the default.
    expect(switchWeightsFor(HOME)).toEqual({ session: 3, weekly: 7, order: 9 });
  });

  it('a non-object `weights` is refused rather than coerced', async () => {
    expect((await post({ weights: 'lots' })).status).toBe(422);
    expect((await post({ weights: [1, 2, 3] })).status).toBe(422);
  });

  it('an empty body is refused — it would otherwise be a write that changes nothing', async () => {
    expect((await post({})).status).toBe(422);
  });

  it('a `__proto__` payload cannot pollute the coefficients', async () => {
    const out = await post({ weights: JSON.parse('{"__proto__":{"session":999},"order":2}') });
    expect(out.status).toBe(200);
    expect(switchWeightsFor(HOME)).toEqual({ ...DEFAULT_SWITCH_WEIGHTS, order: 2 });
    expect(({} as Record<string, unknown>).session).toBeUndefined();
  });

  it('is desktop-gated like every sibling account route', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const out = await post({ strategy: 'sequential' });
    expect(out.status).toBe(403);
    expect(switchStrategyFor(HOME)).toBe('score');
  });
});
