/**
 * `dreamcontext assistant agent` through the real route: `--board` reaches only that board's
 * HOME agent (404 `no_agent` naming the boards that have one when there is none, 409
 * `ambiguous` when there are several), `--slug` reaches any agent, the call is gated like
 * `send` (a proposal under autonomy `ask`), and the message lands through `sayToAgent` with
 * `via: 'assistant'`. The CLI verb posts exactly that body and refuses both or neither flag.
 */
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import type { BoardAgent } from '../../src/lib/whiteboards/agents.js';

const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  const h = fs.mkdtempSync(`${os.tmpdir()}/assistant-agent-home-`);
  process.env.HOME = h;
  return h;
});

type SayInput = { slug: string; text: string; via: string; board?: string | null };
type SayOut =
  | { ok: true; status: 200; body: Record<string, unknown> }
  | { ok: false; status: 400 | 404 | 409; code: string; message: string };
const sayToAgent = vi.hoisted(() => vi.fn((_root: string, input: SayInput): SayOut =>
  ({ ok: true, status: 200, body: { started: true, slug: input.slug, runId: 'r1' } })));
vi.mock('../../src/server/routes/automations.js', async (orig) => ({
  ...(await orig<typeof import('../../src/server/routes/automations.js')>()),
  sayToAgent,
}));

/** The agent cards per board, as `boardAgents` would resolve them. */
const BOARDS: Record<string, BoardAgent[]> = {};
const card = (slug: string, home: boolean, missing = false): BoardAgent => ({ id: `el-${slug}`, slug, title: `T ${slug}`, home, missing });
vi.mock('../../src/lib/whiteboards/agents.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/whiteboards/agents.js')>()),
  boardAgents: (_root: string, board: string) => BOARDS[board] ?? [],
}));
vi.mock('../../src/lib/whiteboards/store.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/whiteboards/store.js')>()),
  listWhiteboards: () => Object.keys(BOARDS).sort().map((slug) => ({ slug, name: slug, description: '', elements: 1, updatedAt: '' })),
}));

const state = await import('../../src/lib/assistant/session-state.js');
const { listProposals, resolveProposal } = await import('../../src/lib/assistant/proposals.js');
const { writeAssistantConfig } = await import('../../src/lib/assistant/home.js');
const { addVault } = await import('../../src/lib/vaults.js');
const routes = await import('../../src/server/routes/assistant.js');
const { registerAssistantCommand } = await import('../../src/cli/commands/assistant.js');

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { res.writableEnded = true; try { body = JSON.parse(String(data)); } catch { body = {}; } },
  });
  return { res: res as unknown as ServerResponse, status: () => status, body: () => body };
}

function tokenReq(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', url: '/api/assistant/ui/agent',
    headers: { host: '127.0.0.1:4173', 'x-dreamcontext-assistant-token': state.assistantToken() },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

const agent = (body: unknown, r = makeRes()) => routes.handleAssistantUi(tokenReq(body), r.res, { verb: 'agent' }).then(() => r);
const ALPHA_CTX = join(HOME, 'p', 'alpha-app', '_dream_context');

beforeAll(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  mkdirSync(ALPHA_CTX, { recursive: true });
  addVault('alpha-app', join(HOME, 'p', 'alpha-app'), HOME);
  mkdirSync(join(HOME, '.dreamcontext', 'assistant', '_dream_context'), { recursive: true });
});

beforeEach(() => {
  state._resetAssistantState();
  sayToAgent.mockClear();
  for (const k of Object.keys(BOARDS)) delete BOARDS[k];
  BOARDS.launch = [card('launch-bot', true), card('helper', false)];
  BOARDS.ops = [card('ops-a', true), card('ops-b', true)];
  BOARDS.attached = [card('helper', false), card('gone-bot', true, true)];
  writeAssistantConfig({ name: 'Nova', autonomy: 'auto' }, HOME);
});

describe('assistant agent — the route', () => {
  it('--board reaches the board\'s one home agent, via the assistant, with the board passed on', async () => {
    const r = await agent({ vault: 'alpha-app', text: 'summarise the launch', board: 'launch' });
    expect(r.status()).toBe(200);
    expect(r.body()).toMatchObject({ ok: true, vault: 'alpha-app', slug: 'launch-bot', started: true });
    expect(sayToAgent).toHaveBeenCalledTimes(1);
    expect(sayToAgent).toHaveBeenCalledWith(ALPHA_CTX, { slug: 'launch-bot', text: 'summarise the launch', via: 'assistant', board: 'launch' });
  });

  it('a board with only attached (or missing) agents is a 404 no_agent naming the boards that have one, by slug', async () => {
    const r = await agent({ vault: 'alpha-app', text: 'hi', board: 'attached' });
    expect(r.status()).toBe(404);
    expect(r.body()).toMatchObject({ error: 'no_agent', boards: ['launch', 'ops'] });
    expect(String(r.body().message)).not.toContain('T ');
    expect(sayToAgent).not.toHaveBeenCalled();
  });

  it('a board that does not exist is a 404 no_agent too', async () => {
    const r = await agent({ vault: 'alpha-app', text: 'hi', board: 'nowhere' });
    expect(r.status()).toBe(404);
    expect(r.body()).toMatchObject({ error: 'no_agent' });
  });

  it('several home agents on one board is a 409 ambiguous listing their slugs', async () => {
    const r = await agent({ vault: 'alpha-app', text: 'hi', board: 'ops' });
    expect(r.status()).toBe(409);
    expect(r.body()).toMatchObject({ error: 'ambiguous', agents: ['ops-a', 'ops-b'] });
    expect(sayToAgent).not.toHaveBeenCalled();
  });

  it('--slug reaches any agent, attached-only ones included, with no board', async () => {
    const r = await agent({ vault: 'alpha-app', text: 'hi', slug: 'helper' });
    expect(r.status()).toBe(200);
    expect(sayToAgent).toHaveBeenCalledWith(ALPHA_CTX, { slug: 'helper', text: 'hi', via: 'assistant', board: null });
  });

  it('refuses a bad body: unknown project, no text, both or neither of board/slug, a malformed slug', async () => {
    for (const body of [
      { vault: 'nope', text: 'hi', slug: 'helper' },
      { vault: 'alpha-app', text: '  ', slug: 'helper' },
      { vault: 'alpha-app', text: 'hi' },
      { vault: 'alpha-app', text: 'hi', slug: 'helper', board: 'launch' },
      { vault: 'alpha-app', text: 'hi', slug: '../etc' },
      { vault: 'alpha-app', text: 'hi', board: '../etc' },
    ]) {
      const r = await agent(body);
      expect(r.status(), JSON.stringify(body)).toBe(400);
      expect(r.body()).toMatchObject({ error: 'invalid_args' });
    }
    expect(sayToAgent).not.toHaveBeenCalled();
  });

  it('under autonomy ask it becomes a send proposal, and the approved (edited) text is what is said', async () => {
    writeAssistantConfig({ autonomy: 'ask' }, HOME);
    const r = makeRes();
    const running = agent({ vault: 'alpha-app', text: 'draft', board: 'launch' }, r);
    await vi.waitFor(() => expect(listProposals()).toHaveLength(1));
    const p = listProposals()[0];
    expect(p).toMatchObject({ verb: 'send', target: 'alpha-app · launch-bot', text: 'draft' });
    expect(sayToAgent).not.toHaveBeenCalled();
    resolveProposal(p.id, 'edit', 'final words');
    await running;
    expect(sayToAgent).toHaveBeenCalledWith(ALPHA_CTX, expect.objectContaining({ slug: 'launch-bot', text: 'final words', via: 'assistant' }));
    expect(r.body()).toMatchObject({ ok: true, approved: true, proposal: p.id });
  });

  it('a rejected proposal says nothing', async () => {
    writeAssistantConfig({ autonomy: 'ask' }, HOME);
    const r = makeRes();
    const running = agent({ vault: 'alpha-app', text: 'draft', slug: 'helper' }, r);
    await vi.waitFor(() => expect(listProposals()).toHaveLength(1));
    resolveProposal(listProposals()[0].id, 'reject');
    await running;
    expect(sayToAgent).not.toHaveBeenCalled();
    expect(r.body()).toMatchObject({ declined: 'rejected' });
  });

  it('a refusal from sayToAgent (disabled, unapproved) keeps its status and code, wrapped as project output', async () => {
    sayToAgent.mockReturnValueOnce({ ok: false, status: 409, code: 'say_unapproved', message: 'Helper is not approved on this machine yet.' });
    const r = await agent({ vault: 'alpha-app', text: 'hi', slug: 'helper' });
    expect(r.status()).toBe(409);
    expect(r.body()).toMatchObject({ ok: false, error: 'say_unapproved' });
    expect(String(r.body().message)).toMatch(/^<untrusted-project-output vault="alpha-app">Helper is not approved/);
    expect(state.isTainted()).toBe(true);
  });
});

describe('assistant agent — the CLI verb', () => {
  let server: ReturnType<typeof createServer>;
  let seen: Array<{ url: string; body: Record<string, unknown> }>;
  let url = '';
  const saved = { ...process.env };

  beforeEach(async () => {
    seen = [];
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body: JSON.parse(data || '{}') as Record<string, unknown> });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.DREAMCONTEXT_ASSISTANT_URL = url;
    process.env.DREAMCONTEXT_ASSISTANT_TOKEN = 'tok';
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...saved };
    process.exitCode = undefined;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const run = (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerAssistantCommand(program);
    return program.parseAsync(['node', 'dreamcontext', 'assistant', 'agent', ...args]);
  };

  it('posts {vault, text, board} for --board and {vault, text, slug} for --slug', async () => {
    await run('alpha-app', 'hello there', '--board', 'launch');
    await run('alpha-app', 'hi', '--slug', 'helper');
    expect(seen).toEqual([
      { url: '/api/assistant/ui/agent', body: { vault: 'alpha-app', text: 'hello there', board: 'launch' } },
      { url: '/api/assistant/ui/agent', body: { vault: 'alpha-app', text: 'hi', slug: 'helper' } },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses both or neither of --board/--slug without calling the server', async () => {
    await run('alpha-app', 'hi');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await run('alpha-app', 'hi', '--board', 'launch', '--slug', 'helper');
    expect(process.exitCode).toBe(1);
    expect(seen).toHaveLength(0);
  });
});
