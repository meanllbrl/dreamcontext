/**
 * A member's own Super chat and the CLI (plan-r10 1, critic 1; security r8-2).
 *
 *  - The member Super chat keeps `DREAMCONTEXT_AGENT_CHAT=<slug>` (every owner-only verb stays
 *    refused there) and gets `DREAMCONTEXT_MEMBER_SUPER=<slug>`: `dreamcontext super` lets exactly
 *    that process through. An inherited marker beside `DREAMCONTEXT_AGENT_SELF` or
 *    `DREAMCONTEXT_AUTOMATION_RUN` is refused, so is a mismatched one, so is a member's child.
 *  - A member's CHILDREN carry `DREAMCONTEXT_MEMBER_CREW=<slug>`: `insideAgentRun` is true for
 *    them (no `agents edit --autonomy`, no `tasks agent-action`), and their permission mode never
 *    exceeds the member's own level.
 *
 * The marker grants nothing on the server (its token check is the gate, super-multi.test.ts);
 * these pin the CLI side. Scratch HOME and vault only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createProgram } from '../../src/cli/program.js';
import { callSuper, mayCallSuper } from '../../src/cli/commands/super.js';
import { createAgent, getAgent } from '../../src/lib/agents/store.js';
import {
  AGENT_CHAT_ENV, AGENT_SELF_ENV, MEMBER_CREW_ENV, MEMBER_SUPER_ENV, insideAgentRun, memberSuperProcess,
} from '../../src/lib/automations/types.js';
import { memberCrewOf, memberCrewPermissionMode } from '../../src/server/routes/agent-chat.js';
import { resetSuperIndex, withSuperState } from '../../src/lib/super/store.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;
let cwd: string;
let server: Server;
let url: string;
let hits: Array<{ path: string; token: string | undefined }>;
const MARKERS = [AGENT_CHAT_ENV, AGENT_SELF_ENV, MEMBER_CREW_ENV, MEMBER_SUPER_ENV, 'DREAMCONTEXT_AUTOMATION_RUN'];

beforeEach(async () => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-member-cli-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-member-cli-home-')));
  realHome = process.env.HOME;
  process.env.HOME = home;
  resetSuperIndex();
  hits = [];
  server = createServer((req, res) => {
    hits.push({ path: req.url ?? '', token: req.headers['x-dreamcontext-window-token'] as string | undefined });
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { reached: true } })); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  for (const k of MARKERS) delete process.env[k];
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function makeAgent(slug: string, autonomy: 'ask' | 'balanced' | 'free' = 'balanced') {
  return createAgent(contextRoot, { slug, title: slug, prompt: `${slug} keeps the routes.`, learning: false, autonomy }, { approve: { now: new Date(), home } });
}

async function runCli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); }));
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { lines.push(String(s)); return true; }) as never);
  process.exitCode = undefined;
  process.chdir(projectRoot);
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    for (const s of spies) s.mockRestore();
    errSpy.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

const windowEnvOf = () => ({ DREAMCONTEXT_WINDOW_URL: url, DREAMCONTEXT_WINDOW_TOKEN: 'a'.repeat(48) });

describe('dreamcontext super from a member\'s own Super chat', () => {
  it('passes with the member marker equal to its agent chat marker', async () => {
    const env = { ...windowEnvOf(), [AGENT_CHAT_ENV]: 'rota', [MEMBER_SUPER_ENV]: 'rota' };
    expect(memberSuperProcess(env)).toBe('rota');
    expect(mayCallSuper(env)).toBe(true);
    const r = await callSuper('state', {}, env);
    expect(r.status).toBe(200);
    expect(hits).toEqual([{ path: '/api/super/v/state', token: 'a'.repeat(48) }]);
  });

  it('the project\'s own Super (no agent marker) passes as before', async () => {
    const r = await callSuper('state', {}, windowEnvOf());
    expect(r.status).toBe(200);
    expect(hits.length).toBe(1);
  });

  it('an inherited marker with a run marker, a mismatched one, a member\'s child, or a plain agent chat never posts', async () => {
    const refused = [
      { [AGENT_CHAT_ENV]: 'rota', [MEMBER_SUPER_ENV]: 'rota', [AGENT_SELF_ENV]: 'rota' },
      { [AGENT_CHAT_ENV]: 'rota', [MEMBER_SUPER_ENV]: 'rota', DREAMCONTEXT_AUTOMATION_RUN: '1' },
      { [AGENT_CHAT_ENV]: 'mira', [MEMBER_SUPER_ENV]: 'rota' },
      { [MEMBER_SUPER_ENV]: 'rota', [AGENT_SELF_ENV]: 'rota' },
      { [AGENT_CHAT_ENV]: 'rota', [MEMBER_SUPER_ENV]: 'rota', [MEMBER_CREW_ENV]: 'rota' },
      { [MEMBER_CREW_ENV]: 'rota' },
      { [AGENT_CHAT_ENV]: 'rota' },
      { [AGENT_CHAT_ENV]: 'rota', [MEMBER_SUPER_ENV]: '' },
    ];
    for (const markers of refused) {
      const env = { ...windowEnvOf(), ...markers };
      expect(mayCallSuper(env), JSON.stringify(markers)).toBe(false);
      const r = await callSuper('state', {}, env);
      expect(r.status, JSON.stringify(markers)).toBe(401);
    }
    expect(hits).toEqual([]);
  });

  it('owner-only verbs stay refused there: `agents edit --autonomy`, `tasks approve-filing`', async () => {
    makeAgent('rota');
    writeFileSync(join(contextRoot, 'state', 'opened.md'), ['---', 'id: task_opened', 'name: opened', "description: ''", 'priority: medium', 'urgency: medium', 'status: todo', "created_at: '2026-10-24'", "updated_at: '2026-10-24'", 'tags: []', 'filed_by: agent', '---', '', '## Why', '', 'x', ''].join('\n'));
    process.env[AGENT_CHAT_ENV] = 'rota';
    process.env[MEMBER_SUPER_ENV] = 'rota';
    expect(insideAgentRun()).toBe(true);
    expect((await runCli(['agents', 'edit', 'rota', '--autonomy', 'free'])).code).toBe(1);
    expect(getAgent(contextRoot, 'rota')!.autonomy).toBe('balanced');
    expect((await runCli(['tasks', 'approve-filing', 'opened'])).code).toBe(1);
    expect(readFileSync(join(contextRoot, 'state', 'opened.md'), 'utf-8')).not.toContain('filing_approved');
  });
});

describe('a member Super\'s children', () => {
  it('carry DREAMCONTEXT_MEMBER_CREW: insideAgentRun is true, owner-only verbs refuse them', async () => {
    makeAgent('rota');
    writeFileSync(join(contextRoot, 'state', 'opened.md'), ['---', 'id: task_opened', 'name: opened', "description: ''", 'priority: medium', 'urgency: medium', 'status: todo', "created_at: '2026-10-24'", "updated_at: '2026-10-24'", 'tags: []', 'filed_by: agent', '---', '', '## Why', '', 'x', ''].join('\n'));
    expect(insideAgentRun({ [MEMBER_CREW_ENV]: 'rota' })).toBe(true);
    expect(insideAgentRun({ [MEMBER_CREW_ENV]: '' })).toBe(false);
    process.env[MEMBER_CREW_ENV] = 'rota';
    expect((await runCli(['agents', 'edit', 'rota', '--autonomy', 'free'])).code).toBe(1);
    expect(getAgent(contextRoot, 'rota')!.autonomy).toBe('balanced');
    expect((await runCli(['tasks', 'agent-action', 'opened', 'complete'])).code).toBe(1);
    expect((await runCli(['tasks', 'approve-filing', 'opened'])).code).toBe(1);
  });

  it('never run wider than the member: the pane\'s mode, capped at the member\'s own level', () => {
    makeAgent('asker', 'ask');
    makeAgent('middle', 'balanced');
    makeAgent('roamer', 'free');
    expect(memberCrewPermissionMode(contextRoot, 'asker', true)).toBe('default');
    expect(memberCrewPermissionMode(contextRoot, 'asker', false)).toBe('default');
    expect(memberCrewPermissionMode(contextRoot, 'middle', true)).toBe('auto');
    expect(memberCrewPermissionMode(contextRoot, 'middle', false)).toBe('auto');
    expect(memberCrewPermissionMode(contextRoot, 'roamer', true)).toBe('bypassPermissions');
    // The pane is narrower than a Free member: the pane wins (never wider than either).
    expect(memberCrewPermissionMode(contextRoot, 'roamer', false)).toBe('auto');
    // A member gone from the project leaves the narrowest chat mode.
    expect(memberCrewPermissionMode(contextRoot, 'nobody', true)).toBe('default');
  });

  it('are recognised from the member\'s record (a URL hint alone names nobody)', async () => {
    await withSuperState(contextRoot, 'm:rota', (s) => {
      s.session = 'sess-rota'; s.enabled = true;
      s.children = { 'kid-1': { sessionId: 'kid-1', brief: 'x', adopted: false, startedAt: Date.now() } };
    });
    await withSuperState(contextRoot, 'main', (s) => {
      s.session = 'sess-main'; s.enabled = true;
      s.children = { 'kid-main': { sessionId: 'kid-main', brief: 'x', adopted: false, startedAt: Date.now() } };
    });
    expect(memberCrewOf('kid-1', null)).toBe('rota');
    // The record wins over what the URL says.
    expect(memberCrewOf('kid-1', 'mira')).toBe('rota');
    expect(memberCrewOf('kid-main', null)).toBeNull();
    // Before its record lands, only a crewTicket names a member exactly (super-multi-requests).
    // A hint alone only narrows: an ambiguous mark ('*', never a member's own), no member named.
    expect(memberCrewOf('new-kid', 'mira', contextRoot)).toBe('*');
    expect(memberCrewOf('new-kid', '../evil', contextRoot)).toBeNull();
    expect(memberCrewOf('', null)).toBeNull();
  });
});
