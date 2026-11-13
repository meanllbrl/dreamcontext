import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ensureMeFile, newEventId, newRuleId, personalStoreRef, projectStoreRef, readStore, deriveAll, writeStore, type RuleRecord,
} from '../../src/lib/rules-store.js';
import { handleLearnedDrop, handleLearnedGet, handleLearnedKeep, handleLearnedUndo } from '../../src/server/routes/learned.js';
import { learnedMessage, onLearnedButton } from '../../src/server/telegram/blocks.js';
import { parseViewBlock } from '../../dashboard/src/lib/chatViewSpec.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';
import { OWNER_PAGE_HEADERS } from '../helpers/owner-page.js';

let tmp: string;
let home: string;
let ctx: string;
let realHome: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dc-learned-routes-'));
  home = join(tmp, 'home');
  ctx = join(tmp, 'orchard', '_dream_context');
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(home, { recursive: true });
  realHome = process.env.HOME;
  process.env.HOME = home;
  ensureMeFile(home, 'gardener@example.com');
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(tmp, { recursive: true, force: true });
});

function req(headers: Record<string, string> = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end('{}'); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { setHeader: () => void }).setHeader = () => {};
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

function rule(headline: string, status: 'active' | 'proposed', scope: 'me' | 'project' = 'me'): RuleRecord {
  return {
    id: newRuleId(), scope, created: { at: '2026-11-02T09:00:00.000Z', by: 'owner', person: '' },
    events: [{ eid: newEventId(), at: '2026-11-02T09:00:00.000Z', op: 'create', by: 'owner', conversation: 'c1', status, headline, text: headline, quotes: [{ text: 'raporda önce sayılar', turn: 't1', via: 'composer', occasion: 'o1' }] }],
  };
}

describe('the learned card (C9)', () => {
  it('the view is a learned id and nothing else; a described rule is ignored', () => {
    expect(parseViewBlock('{"type":"learned","id":"k7m2q6xw4b"}').view).toEqual({ type: 'learned', id: 'k7m2q6xw4b' });
    expect(parseViewBlock('{"type":"learned","id":"nope"}').view).toBeNull();
    expect(parseViewBlock('{"type":"learned","id":"k7m2q6xw4b","headline":"x"}').notices.join(' ')).toMatch(/ignored/);
  });

  it('GET reads the record: headline, scope, his quote; an unknown id is 404', async () => {
    const r = rule('Numbers first in a report', 'active');
    writeStore(personalStoreRef(home), { version: 1, rules: [r] });
    const out = res();
    await handleLearnedGet(req(), out, { id: r.id }, ctx);
    expect(out.status).toBe(200);
    expect(out.json.card).toMatchObject({ id: r.id, scope: 'me', status: 'active', headline: 'Numbers first in a report', quote: { text: 'raporda önce sayılar' } });
    const miss = res();
    await handleLearnedGet(req(), miss, { id: 'aaaaaaaaaa' }, ctx);
    expect(miss.status).toBe(404);
  });

  it('undo, keep and drop take his page only; an agent\'s call is refused and changes nothing', async () => {
    const a = rule('Numbers first', 'active');
    const p = rule('Short reports', 'proposed', 'project');
    writeStore(personalStoreRef(home), { version: 1, rules: [a] });
    writeStore(projectStoreRef(ctx, home), { version: 1, rules: [p] });
    const agent = res();
    await handleLearnedUndo(req(), agent, { id: a.id }, ctx);
    expect(agent.status).toBe(403);
    expect(deriveAll(readStore(personalStoreRef(home)))[0]!.status).toBe('active');
    const undo = res();
    await handleLearnedUndo(req(OWNER_PAGE_HEADERS), undo, { id: a.id }, ctx);
    expect(undo.status).toBe(200);
    expect((undo.json.card as { status: string }).status).toBe('undone');
    const keep = res();
    await handleLearnedKeep(req(OWNER_PAGE_HEADERS), keep, { id: p.id }, ctx);
    expect((keep.json.card as { status: string }).status).toBe('active');
    const drop = res();
    await handleLearnedDrop(req(OWNER_PAGE_HEADERS), drop, { id: p.id }, ctx);
    expect(drop.status).toBe(409);
  });

  it('the phone may read and undo; keep and drop stay on the Mac', () => {
    expect(ROUTE_POLICY['GET /api/learned/:id']!.allow).toBe(true);
    expect(ROUTE_POLICY['POST /api/learned/:id/undo']!.allow).toBe(true);
    expect(ROUTE_POLICY['POST /api/learned/:id/keep']!.allow).toBe(false);
    expect(ROUTE_POLICY['POST /api/learned/:id/drop']!.allow).toBe(false);
  });

  it('Telegram: the receipt line with Geri al for an active rule, and the tap undoes it', async () => {
    const a = rule('Numbers first', 'active');
    const p = rule('Short reports', 'proposed');
    writeStore(personalStoreRef(home), { version: 1, rules: [a, p] });
    const m = learnedMessage(ctx, JSON.stringify({ type: 'learned', id: a.id }), home)!;
    expect(m.line).toBe('Kaydedildi: "Numbers first" · senin tercihlerin, her projede');
    expect(m.undo).toBe(true);
    const mp = learnedMessage(ctx, JSON.stringify({ type: 'learned', id: p.id }), home)!;
    expect(mp.undo).toBe(false);
    expect(mp.line).toMatch(/^Önerildi: .*Mac'te tut ya da bırak$/);
    const ab = { contextRoot: ctx } as Parameters<typeof onLearnedButton>[0];
    expect(await onLearnedButton(ab, { id: a.id }, home)).toBe('↩ Geri alındı');
    expect(await onLearnedButton(ab, { id: a.id }, home)).toMatch(/already undone/);
  });

  it('the dashboard card mirrors the route\'s facts key set', () => {
    const server = readFileSync(join(__dirname, '../../src/server/routes/learned.ts'), 'utf-8');
    const client = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/chat/LearnedCard.tsx'), 'utf-8');
    const keys = (src: string): string[] => {
      const body = /interface LearnedCardFacts \{([\s\S]*?)\n\}/.exec(src)![1]!;
      return [...body.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]!).sort();
    };
    expect(keys(client)).toEqual(keys(server));
  });
});
