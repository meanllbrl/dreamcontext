/**
 * Settings → Eco mode's route (task codex-tarzi-yeni-kabuk W2-C, flagged F4):
 * `GET|POST /api/agent/context-handoff-default` reads and writes ONLY this machine's
 * `contextHandoffDefault` for the project (`dirname(contextRoot)`), boolean only, refused on
 * the phone, and the write keeps every other key of `.brain-local.json` (it also holds the
 * auto-sleep consent and `codeRepoPath`) through an atomic temp-and-rename.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleContextHandoffDefaultGet, handleContextHandoffDefaultPost } from '../../src/server/routes/agent-handoff-default.js';
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
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function res() {
  let code = 0;
  let body: Record<string, unknown> = {};
  const r = { writeHead(c: number) { code = c; }, setHeader() {}, end(d: string) { body = JSON.parse(d); } } as unknown as ServerResponse;
  return { r, status: () => code, body: () => body };
}
function post(payload: unknown, socket: object = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage;
  Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json' }, socket });
  return req;
}

describe('Eco mode default route', () => {
  it('reads the team default when this machine never chose, with the thresholds', async () => {
    const out = res();
    await handleContextHandoffDefaultGet({ socket: {} } as IncomingMessage, out.r, {}, contextRoot);
    expect(out.status()).toBe(200);
    expect(out.body()).toEqual({ enabled: false, nudgeAt: 300_000, hardAt: 650_000 });
  });

  it('writes the machine-local default for this project and keeps every other key', async () => {
    const path = brainLocalPath(projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ codeRepoPath: '/code/acme', autoSleep: { enabled: true, trigger: 'sleepy', approvedAt: 'x', approvedFingerprint: 'y' } }));
    const out = res();
    await handleContextHandoffDefaultPost(post({ enabled: true }), out.r, {}, contextRoot);
    expect(out.status()).toBe(200);
    expect(out.body()).toMatchObject({ enabled: true });
    const stored = JSON.parse(readFileSync(path, 'utf-8'));
    expect(stored).toMatchObject({ contextHandoffDefault: true, codeRepoPath: '/code/acme', autoSleep: { enabled: true } });
    // No temp file left beside it.
    expect(readdirSync(dirname(path)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('takes a boolean only', async () => {
    for (const payload of [{ enabled: 'yes' }, {}, { enabled: 1 }]) {
      const out = res();
      await handleContextHandoffDefaultPost(post(payload), out.r, {}, contextRoot);
      expect(out.status()).toBe(400);
    }
    expect(existsSync(brainLocalPath(projectRoot))).toBe(false);
  });

  it('is refused on the phone, by the route itself and by the phone route policy', async () => {
    const socket = {};
    markPhoneSocket(socket);
    const out = res();
    await handleContextHandoffDefaultPost(post({ enabled: true }, socket), out.r, {}, contextRoot);
    expect(out.status()).toBe(403);
    expect(existsSync(brainLocalPath(projectRoot))).toBe(false);
    expect(ROUTE_POLICY['POST /api/agent/context-handoff-default']?.allow).toBe(false);
    expect(ROUTE_POLICY['GET /api/agent/context-handoff-default']?.allow).toBe(false);
  });
});
