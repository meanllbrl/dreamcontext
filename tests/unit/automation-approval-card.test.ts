import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAutomation, getAutomation, recordRun } from '../../src/lib/automations/store.js';
import { approveAutomation, checkApproval } from '../../src/lib/automations/registry.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { createWhiteboard } from '../../src/lib/whiteboards/store.js';
import {
  approvalCardBlock, approvalCardFacts, doesLine, staleApprovalBlock,
} from '../../src/lib/automations/approval-card.js';
import {
  handleAutomationsApprove, handleAutomationsCard, handleAutomationsCreate, handleAutomationsQuestionAnswer,
  handleAutomationsReject, handleAutomationsUpdate,
} from '../../src/server/routes/automations.js';
import {
  handleAgentsAmendmentRevert, handleAgentsApprove, handleAgentsCreate, handleAgentsUpdate, handleLauncherGlobalAgentsCreate,
} from '../../src/server/routes/agents.js';
import { createQuestion } from '../../src/lib/automations/hitl.js';
import { AUTOMATION_LINE, superBatchText } from '../../src/lib/super/inbox.js';
import { sanitizeSuperState } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem } from '../../src/lib/super/types.js';
import { parseViewBlock } from '../../dashboard/src/lib/chatViewSpec.js';
import { OWNER_PAGE_HEADERS } from '../helpers/owner-page.js';

/**
 * The automation approval card (owner 2026-11-01): an automation an agent or the Super Agent sets
 * up waits for the owner's yes, which he gives on a card in the chat. The agent must not be able
 * to give it: every HTTP route that writes an approval answers the app's own page only.
 */

function makeRes() {
  let code = 0;
  let body: unknown = null;
  const res = {
    writeHead(c: number) { code = c; },
    end(d: string) { try { body = JSON.parse(d); } catch { body = d; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => code, body: () => body as Record<string, unknown> };
}

function post(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf-8')]);
  return Object.assign(r, { method: 'POST', url: '/', headers }) as unknown as IncomingMessage;
}
const owner = (body?: unknown) => post(body, { ...OWNER_PAGE_HEADERS });
/** What an agent's `curl` sends: no Origin. */
const bare = (body?: unknown) => post(body, { host: '127.0.0.1:4173' });
/** A page on another loopback port (a dev server shown in a card). */
const otherPort = (body?: unknown) => post(body, { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:5173' });
const getReq = { method: 'GET', headers: {} } as unknown as IncomingMessage;

let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-autocard-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-autocard-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

function make(slug = 'eod-digest', extra: Partial<Parameters<typeof createAutomation>[1]> = {}) {
  return createAutomation(contextRoot, {
    slug, title: 'End of day digest', days: 'daily', at: '18:00',
    prompt: 'Read today\'s commits and post a three-line digest to the thread.\n', ...extra,
  });
}

describe('approvalCardFacts', () => {
  it('says what it does, how often, until when, its reach and that it can change things', () => {
    const m = make();
    const f = approvalCardFacts(projectRoot, m, { mcp: () => ['slack', 'kb'] });
    expect(f.does).toBe('Read today\'s commits and post a three-line digest to the thread.');
    expect(f.cadence).toMatch(/18:00/);
    expect(f.until).toBe('until-turned-off');
    expect(f.reach).toBe('computer');
    expect(f.mcp).toEqual(['slack', 'kb']);
    expect(f.approved).toBe(false);
    expect(f.approvalReason).toBe('never-approved');
    expect(f.nextFireAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('a board agent reaches its board only, and is handed no MCP server', () => {
    const { slug: board } = createWhiteboard(contextRoot, 'Control panel');
    const m = make('board-bot', { whiteboard: board });
    const f = approvalCardFacts(projectRoot, m, { mcp: () => ['slack'] });
    expect(f.reach).toBe('board');
    expect(f.board).toBe(board);
    expect(f.mcp).toEqual([]);
  });

  it('an on-call agent runs only when called and has no next run', () => {
    const m = createAutomation(contextRoot, { slug: 'helper', title: 'Helper', mode: 'call', prompt: 'Help.' });
    const f = approvalCardFacts(projectRoot, m, { mcp: () => [] });
    expect(f.until).toBe('only-when-called');
    expect(f.nextFireAt).toBeNull();
  });

  it('quotes the prompt, never the scaffold placeholder or a comment', () => {
    expect(doesLine('(What should this automation do? Write the prompt the scheduled run will send.)')).toBe('');
    expect(doesLine('<!-- note -->\n# Title\n- Check the build')).toBe('Check the build');
    expect(doesLine('x'.repeat(400)).length).toBe(280);
  });

  it('the block an agent pastes names the slug and nothing else, and the chat parses it', () => {
    const block = approvalCardBlock('eod-digest');
    expect(block).toBe('```dream-view\n{"type":"automation","slug":"eod-digest"}\n```');
    const body = block.split('\n')[1];
    expect(parseViewBlock(body)).toEqual({ view: { type: 'automation', slug: 'eod-digest' }, notices: [] });
    const asserted = parseViewBlock('{"type":"automation","slug":"eod-digest","title":"Harmless"}');
    expect(asserted.view).toEqual({ type: 'automation', slug: 'eod-digest' });
    expect(asserted.notices[0]).toMatch(/ignored/);
    expect(parseViewBlock('{"type":"automation","slug":"../x"}').view).toBeNull();
  });

  it('the dashboard mirror of the facts has exactly the server\'s keys', () => {
    const m = make();
    const keys = Object.keys(approvalCardFacts(projectRoot, m, { mcp: () => [] })).sort();
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/chat/AutomationApprovalCard.tsx', import.meta.url), 'utf-8');
    const body = /export interface ApprovalCardFacts \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    const mirrored = [...body.matchAll(/^\s+(\w+):/gm)].map((x) => x[1]).sort();
    expect(mirrored).toEqual(keys);
  });
});

describe('a refusal for want of approval is history once approved', () => {
  it('staleApprovalBlock is true only for an approval refusal read after approval', () => {
    const blocked = { status: 'blocked' as const, error: 'not approved (never-approved) — needs approval on the AI Team page in the dashboard' };
    expect(staleApprovalBlock(blocked, true)).toBe(true);
    expect(staleApprovalBlock(blocked, false)).toBe(false);
    expect(staleApprovalBlock({ status: 'failed', error: 'boom' }, true)).toBe(false);
    expect(staleApprovalBlock({ status: 'blocked', error: 'runs on another Mac' }, true)).toBe(false);
    expect(staleApprovalBlock(null, true)).toBe(false);
  });

  it('the card route and the summary drop it after approval', async () => {
    const m = make();
    const at = new Date().toISOString();
    recordRun(contextRoot, m.slug, {
      firedAt: at, startedAt: at, finishedAt: at, status: 'blocked',
      error: 'not approved (never-approved) — needs approval on the AI Team page in the dashboard',
      durationMs: 0, outputPath: null, exitCode: null, sessionId: null, costUsd: null, numTurns: null,
    } as never, { advanceWatermark: false });
    approveAutomation(projectRoot, m, new Date());
    const { handleAutomationsList } = await import('../../src/server/routes/automations.js');
    const r = makeRes();
    await handleAutomationsList(getReq, r.res, {}, contextRoot);
    const cache = (r.body().automations as Array<{ cache: { status: unknown; error: unknown } }>)[0].cache;
    expect(cache.status).toBeNull();
    expect(cache.error).toBeNull();
  });
});

describe('the card\'s approve and reject routes', () => {
  it('an agent\'s call (no Origin) and another port\'s page are refused; nothing is approved', async () => {
    const m = make();
    for (const req of [bare({}), otherPort({})]) {
      const r = makeRes();
      await handleAutomationsApprove(req, r.res, { slug: m.slug }, contextRoot);
      expect(r.status()).toBe(403);
      expect(r.body().error).toBe('owner_page_only');
    }
    expect(checkApproval(projectRoot, getAutomation(contextRoot, m.slug)!, undefined, 'run').approved).toBe(false);
  });

  it('the owner\'s tap approves, turns on an automation that was off, and answers the card', async () => {
    const m = make('off-one', { enabled: false });
    const r = makeRes();
    await handleAutomationsApprove(owner({ enable: true }), r.res, { slug: m.slug }, contextRoot);
    expect(r.status()).toBe(200);
    const card = r.body().card as { approved: boolean; enabled: boolean; nextFireAt: string | null };
    expect(card.approved).toBe(true);
    expect(card.enabled).toBe(true);
    expect(card.nextFireAt).not.toBeNull();
    // Turning it on rewrote the file without touching the hash: still approved.
    expect(checkApproval(projectRoot, getAutomation(contextRoot, m.slug)!, undefined, 'run').approved).toBe(true);
    // Not in a Super Agent's chat: nobody was told by the server.
    expect(r.body().told).toBe(false);
  });

  it('turning it down approves nothing and turns it off, file kept', async () => {
    const m = make();
    const refused = makeRes();
    await handleAutomationsReject(bare({}), refused.res, { slug: m.slug }, contextRoot);
    expect(refused.status()).toBe(403);
    const r = makeRes();
    await handleAutomationsReject(owner({}), r.res, { slug: m.slug }, contextRoot);
    expect(r.status()).toBe(200);
    const after = getAutomation(contextRoot, m.slug)!;
    expect(after.enabled).toBe(false);
    expect(checkApproval(projectRoot, after, undefined, 'run').approved).toBe(false);
  });

  it('turning down an approved automation that is off withdraws the approval too', async () => {
    const m = make('was-yes', { enabled: false });
    approveAutomation(projectRoot, m, new Date());
    const r = makeRes();
    await handleAutomationsReject(owner({}), r.res, { slug: m.slug }, contextRoot);
    expect(r.status()).toBe(200);
    expect((r.body().card as { approved: boolean }).approved).toBe(false);
    expect(checkApproval(projectRoot, getAutomation(contextRoot, m.slug)!, undefined, 'run').approved).toBe(false);
  });

  it('the card route reads the manifest', async () => {
    const m = make();
    const r = makeRes();
    await handleAutomationsCard(getReq, r.res, { slug: m.slug }, contextRoot);
    expect(r.status()).toBe(200);
    expect((r.body().card as { slug: string }).slug).toBe(m.slug);
    expect(r.body().owned).toBe(true);
    const missing = makeRes();
    await handleAutomationsCard(getReq, missing.res, { slug: 'nope' }, contextRoot);
    expect(missing.status()).toBe(404);
  });
});

describe('every HTTP route that writes an approval answers the owner\'s page only', () => {
  it('refuses a request without the page\'s Origin, before it writes anything', async () => {
    const m = make();
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Writes.' });
    const q = createQuestion(contextRoot, {
      slug: m.slug, runFiredAt: new Date().toISOString(), kind: 'approval', sessionId: null, channel: 'chat', question: 'Approve?',
    });
    const routes: Array<[string, (req: IncomingMessage, res: ServerResponse) => Promise<void>, unknown]> = [
      ['automations approve', (req, res) => handleAutomationsApprove(req, res, { slug: m.slug }, contextRoot), {}],
      ['automations create', (req, res) => handleAutomationsCreate(req, res, {}, contextRoot), { title: 'Sneaky', prompt: 'x', days: 'daily', at: '09:00' }],
      ['automations update', (req, res) => handleAutomationsUpdate(req, res, { slug: m.slug }, contextRoot), { prompt: 'changed' }],
      ['approval question yes', (req, res) => handleAutomationsQuestionAnswer(req, res, { id: q.id }, contextRoot), { answer: 'approve' }],
      ['agents approve', (req, res) => handleAgentsApprove(req, res, { slug: 'writer' }, contextRoot), {}],
      ['agents create', (req, res) => handleAgentsCreate(req, res, {}, contextRoot), { title: 'Sneaky', prompt: 'x' }],
      ['agents update', (req, res) => handleAgentsUpdate(req, res, { slug: 'writer' }, contextRoot), { prompt: 'changed' }],
      ['teammate create', (req, res) => handleLauncherGlobalAgentsCreate(req, res, {}, contextRoot), { title: 'Sneaky', prompt: 'x' }],
      ['amendment take-back', (req, res) => handleAgentsAmendmentRevert(req, res, { slug: 'writer', id: 'a1' }, contextRoot), {}],
    ];
    for (const [name, call, body] of routes) {
      const r = makeRes();
      await call(bare(body), r.res);
      expect([name, r.status(), r.body()?.error]).toEqual([name, 403, 'owner_page_only']);
    }
    expect(getAutomation(contextRoot, 'sneaky')).toBeNull();
    expect(checkApproval(projectRoot, getAutomation(contextRoot, m.slug)!, undefined, 'run').approved).toBe(false);
  });
});

describe('the Super Agent hears the decision', () => {
  it('an automation item survives the record\'s sanitizer only with its slug and decision', () => {
    const base = { ...emptySuperState(), session: 'sup', enabled: true };
    const items = [
      { id: 'q-a1', sessionId: 'sup', kind: 'automation', state: 'pending', createdAt: 1, automation: 'eod-digest', decision: 'approved' },
      { id: 'q-a2', sessionId: 'sup', kind: 'automation', state: 'pending', createdAt: 2, automation: '../x', decision: 'approved' },
      { id: 'q-a3', sessionId: 'sup', kind: 'automation', state: 'pending', createdAt: 3, automation: 'eod-digest', decision: 'maybe' },
    ];
    const s = sanitizeSuperState({ ...base, queue: items });
    expect(s.queue.map((q) => q.id)).toEqual(['q-a1']);
    expect(s.queue[0]).toMatchObject({ automation: 'eod-digest', decision: 'approved' });
  });

  it('his decision is a turn the owner reads in full, never folded into one event line', () => {
    const src = readFileSync(new URL('../../src/lib/super/inbox.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/const tells = [^\n]*q\.kind === 'automation'/);
  });

  it('its event line carries the live state and the next run, and the batch says what to do', () => {
    const m = make();
    approveAutomation(projectRoot, m, new Date());
    const item: SuperQueueItem = { id: 'q-a1', sessionId: 'sup', kind: 'automation', state: 'pending', createdAt: 1, automation: m.slug, decision: 'approved' };
    const text = superBatchText(contextRoot, { ...emptySuperState(), session: 'sup', enabled: true }, [item], 'b-1');
    expect(text).toMatch(new RegExp(`- item=q-a1 event=automation automation=${m.slug} decision=approved state=on next=`));
    expect(text).toContain(AUTOMATION_LINE);
    const gone: SuperQueueItem = { ...item, id: 'q-a2', automation: 'removed-since' };
    expect(superBatchText(contextRoot, { ...emptySuperState(), session: 'sup', enabled: true }, [gone], 'b-2')).toContain('state=gone');
  });
});
