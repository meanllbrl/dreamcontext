/**
 * The Super Agent reads a team job's answer whole (`super read <team-id>`) and sees its AI Team in
 * `super state` (`members`), the same reading as `super team ask` (task super-agent-isi-bolerken-…).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-team-read-home-`);
});

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperState, type SuperTeamJob } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { getAutomation } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';

let dir: string;
let root: string;
let token = '';
const SUPER = 'sup-1';
const RUN = '2026-10-29T10:00:00.000Z';

function makeVault(state: Partial<SuperState> = {}): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...state }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-team-read-')));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function req(body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: string, body: Record<string, unknown> = {}) {
  const r = res();
  await handleSuperVerb(req(body), r, { verb: name });
  return r;
}

describe('super read <team-id>', () => {
  it('gives the member\'s whole answer, last post first, fenced; an unknown team id is 404 unknown_team', async () => {
    makeVault();
    createAgent(root, { slug: 'ledger', title: 'Ledger', prompt: 'Revenue.' });
    const ask = appendThreadEntry(root, 'ledger', { runId: RUN, kind: 'user', text: 'revenue?', via: 'super', now: new Date(RUN) });
    const long = `October revenue: $48,200 net.\n${'Detail line. '.repeat(80)}`;
    appendThreadEntry(root, 'ledger', { runId: RUN, kind: 'agent', text: 'Reading mrr-now.', via: 'cli', now: new Date(Date.parse(RUN) + 1000) });
    appendThreadEntry(root, 'ledger', { runId: RUN, kind: 'agent', text: long, via: 'cli', now: new Date(Date.parse(RUN) + 2000) });
    appendThreadEntry(root, 'ledger', { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner', now: new Date(Date.parse(RUN) + 3000) });
    const job: SuperTeamJob = { id: 'team-abc123', member: 'ledger', runId: RUN, entryId: ask.id, jobKind: 'run', queued: false, brief: 'revenue', startedAt: Date.parse(RUN) };
    makeVault({ team: [job] });
    const r = await verb('read', { child: 'team-abc123' });
    expect(r.status).toBe(200);
    const out = r.json.result as Record<string, unknown>;
    expect(out).toMatchObject({ team: 'team-abc123', member: 'ledger', status: 'done' });
    const text = String(out.text);
    expect(text.startsWith('<untrusted-project-output vault="acme">October revenue: $48,200 net.')).toBe(true);
    expect(text).toContain('Detail line. Detail line.');
    expect(text.indexOf('Reading mrr-now.')).toBeGreaterThan(text.indexOf('October revenue'));
    const unknown = await verb('read', { child: 'team-nope' });
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ ok: false, error: 'unknown_team' });
    // A child id still reads a child (and an unknown one is still unknown_child).
    expect((await verb('read', { child: 'not-a-child' })).json).toMatchObject({ error: 'unknown_child' });
  });
});

describe('super state members', () => {
  it('lists the AI Team as team ask judges it, ready first, names and fields fenced; omitted without one', async () => {
    makeVault();
    expect((await verb('state')).json.result).not.toHaveProperty('members');
    createAgent(root, { slug: 'atlas', title: 'Atlas', prompt: 'Funnel strategy.' });
    createAgent(root, { slug: 'ledger', title: 'Ledger', prompt: 'Revenue and payments.' });
    approveAutomation(dirname(root), getAutomation(root, 'ledger')!, new Date());
    const members = (await verb('state')).json.result as { members: Array<Record<string, string>> };
    expect(members.members).toEqual([
      { slug: 'ledger', title: '<untrusted-project-output vault="acme">Ledger</untrusted-project-output>', state: 'ready', role: '<untrusted-project-output vault="acme">Revenue and payments.</untrusted-project-output>' },
      { slug: 'atlas', title: '<untrusted-project-output vault="acme">Atlas</untrusted-project-output>', state: 'needs-approval', role: '<untrusted-project-output vault="acme">Funnel strategy.</untrusted-project-output>' },
    ]);
  });
});
