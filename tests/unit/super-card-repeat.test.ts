/**
 * One card, not four (plan iyilesme-360 D6, C4) and text the shell ate (D7), through the real
 * verb handler. Synthetic project "acme"; every word fictional.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-card-repeat-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { _resetOwnerQuestions, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { cardKey, shellAteField } from '../../src/lib/super/ask-card.js';
import { ASK_RULES_SHORT } from '../../src/lib/ask-rules.js';

const SUPER = 'super-0001-aaaa';
let dir: string;
let root: string;
let token = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-card-repeat-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  _resetOwnerQuestions();
  setOwnerQuestionSinks({ presence: () => ({ vault: null, session: null }), banner: () => true, push: () => 0 });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: { c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 } },
    queue: [{ id: 'q-child1', sessionId: 'c1', kind: 'question', requestId: 'r-1', state: 'delivered', createdAt: 2 }],
  }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); _resetOwnerQuestions(); });

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
async function verb(name: string, body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body), r, { verb: name });
  return r;
}
const result = (r: { json: Record<string, unknown> }) => (r.json.result ?? r.json) as Record<string, unknown>;
const card = (title = 'Orchard checkout → button colour') => ({
  title, questions: [{ question: 'Which colour should the pay button be?', header: 'Colour', options: [{ label: 'Blue' }, { label: 'Green' }] }],
});
const asks = async () => (await readSuperState(root)).queue.filter((q) => q.kind === 'ask');

describe('D6: the same card sent again is the open card', () => {
  it('four sends (json, spaced json, legacy text) → one card, three repeated answers', async () => {
    const first = await verb('ask', { ask: card() });
    expect(first.status).toBe(200);
    const id = result(first).item;
    const again = [
      await verb('ask', { ask: card() }),
      await verb('ask', { ask: { ...card('  ORCHARD checkout →   button colour ') } }),
      await verb('ask', { ask: card() }),
    ];
    for (const r of again) {
      expect(r.status).toBe(200);
      expect(result(r)).toMatchObject({ item: id, repeated: true, note: 'attachments of the open card kept' });
    }
    expect(await asks()).toHaveLength(1);
  });

  it('a different decision while one is open → 409 ask_open, without "ask again"', async () => {
    await verb('ask', { ask: card() });
    const r = await verb('ask', { ask: { title: 'Orchard → launch day', questions: [{ question: 'Launch on Monday?', options: [{ label: 'Yes' }, { label: 'No' }] }] } });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('ask_open');
    expect(String(r.json.message)).not.toMatch(/ask again/);
  });

  it('after the open card is answered, the same card is a new card', async () => {
    const first = result(await verb('ask', { ask: card() }));
    const raw = JSON.parse(require('node:fs').readFileSync(join(root, SUPER_STATE_REL), 'utf-8'));
    for (const q of raw.queue) if (q.id === first.item) q.state = 'done';
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(raw));
    resetSuperIndex();
    const second = await verb('ask', { ask: card() });
    expect(second.status).toBe(200);
    expect(result(second).repeated).toBeUndefined();
    expect(result(second).item).not.toBe(first.item);
  });

  it('queue ask: the same caption on a question already his is a repeat', async () => {
    const a = await verb('queue-ask', { item: 'q-child1', text: 'Postgres or sqlite?' });
    expect(a.status).toBe(200);
    const b = await verb('queue-ask', { item: 'q-child1', text: 'postgres  or sqlite?' });
    expect(result(b)).toMatchObject({ item: 'q-child1', repeated: true });
  });

  it('the key folds case and spacing, and changes with an option', () => {
    expect(cardKey(card())).toBe(cardKey(card(' orchard CHECKOUT → button colour')));
    expect(cardKey(card())).not.toBe(cardKey({ ...card(), questions: [{ question: 'Which colour should the pay button be?', options: [{ label: 'Blue' }, { label: 'Red' }] }] }));
  });

  it('ASK_RULES_SHORT is untouched by this plan', () => {
    expect(ASK_RULES_SHORT).not.toMatch(/--rule|standing rule of his/);
  });
});

describe('D7: text the shell ate is refused', () => {
  it('",99" in an option → shell_ate_text naming the field and both ways out', async () => {
    const r = await verb('ask', { ask: { title: 'Orchard → price', questions: [{ question: 'Raise the price?', options: [{ label: "fiyat ,99'dan ,98'e çıksın mı" }, { label: 'Hayır' }] }] } });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('shell_ate_text');
    expect(String(r.json.message)).toContain('questions[0].options[0].label');
    expect(String(r.json.message)).toContain('--json @file');
    expect(String(r.json.message)).toContain('reword');
  });

  it('a whole price, a letter in quotes and a decimal pass', () => {
    const q = (label: string) => ({ questions: [{ question: 'x', options: [{ label }] }] });
    expect(shellAteField(q("$6,99'dan $13,98'e"))).toBeNull();
    expect(shellAteField(q("'a' harfi"))).toBeNull();
    expect(shellAteField(q('0.50 TL'))).toBeNull();
    expect(shellAteField(q('fiyat ,99 olsun'))).toBe('questions[0].options[0].label');
  });

  // r1 edge-cases-2: the paywall forms after the eaten price (a slash, a bracket, a hyphen suffix).
  it('an eaten price before /hafta, /ay, /mo, a closing bracket or a -lik suffix is caught', () => {
    const q = (label: string) => ({ questions: [{ question: 'x', options: [{ label }] }] });
    for (const label of ['Haftalık ,99/hafta mı?', 'aylık ,99/ay', 'price .99/mo', 'Fiyat (,99) olsun mu', 'Plan ,99-lik', '[,99] paket']) {
      expect(shellAteField(q(label)), label).toBe('questions[0].options[0].label');
    }
    for (const label of ['$6,99/hafta', '(6,99 TL)', '6.99-luk plan', 'v1.25b', 'oran ,5 değil']) {
      expect(shellAteField(q(label)), label).toBeNull();
    }
  });
});
