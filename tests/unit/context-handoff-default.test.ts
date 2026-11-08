/**
 * Settings → Eco mode's route: `GET /api/agent/context-handoff-default` answers this Mac's
 * Eco mode switch (agent-ui.json `ecoMode`, ON when never chosen) and the open project's
 * thresholds. The per-project write is gone (owner 2026-11-08). HOME is pointed at a scratch
 * dir so the developer's real agent-ui.json never decides a test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleContextHandoffDefaultGet } from '../../src/server/routes/agent-handoff-default.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';

let scratch: string;
let contextRoot: string;
let projectRoot: string;
/** `.brain-local.json` (setup-config.ts BRAIN_LOCAL_REL_PATH). */
const brainLocalPath = (root: string) => join(root, '_dream_context', 'state', '.brain-local.json');

beforeEach(() => {
  // A registered prefix (super-disk-leftovers).
  scratch = mkdtempSync(join(tmpdir(), 'chat-seed-ctx-'));
  projectRoot = join(scratch, 'proj');
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  prevHome = process.env.HOME;
  process.env.HOME = join(scratch, 'home');
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  rmSync(scratch, { recursive: true, force: true });
});
let prevHome: string | undefined;

function res() {
  let code = 0;
  let body: Record<string, unknown> = {};
  const r = { writeHead(c: number) { code = c; }, setHeader() {}, end(d: string) { body = JSON.parse(d); } } as unknown as ServerResponse;
  return { r, status: () => code, body: () => body };
}

describe('Eco mode route (thresholds + the machine switch)', () => {
  it('answers this Mac\'s switch (ON when never chosen) with the project\'s thresholds', async () => {
    const out = res();
    await handleContextHandoffDefaultGet({ socket: {} } as IncomingMessage, out.r, {}, contextRoot);
    expect(out.status()).toBe(200);
    expect(out.body()).toEqual({ enabled: true, nudgeAt: 300_000, hardAt: 650_000 });
  });

  it('ignores an old per-project default', async () => {
    const path = brainLocalPath(projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ contextHandoffDefault: false }));
    const out = res();
    await handleContextHandoffDefaultGet({ socket: {} } as IncomingMessage, out.r, {}, contextRoot);
    expect(out.body()).toMatchObject({ enabled: true });
  });

  it('has no write any more: the switch is saved through the agent settings', () => {
    expect(ROUTE_POLICY['POST /api/agent/context-handoff-default']).toBeUndefined();
  });

  it('is refused on the phone, by the route itself and by the phone route policy', async () => {
    const socket = {};
    markPhoneSocket(socket);
    const out = res();
    await handleContextHandoffDefaultGet({ socket } as unknown as IncomingMessage, out.r, {}, contextRoot);
    expect(out.status()).toBe(403);
    expect(ROUTE_POLICY['GET /api/agent/context-handoff-default']?.allow).toBe(false);
  });
});
