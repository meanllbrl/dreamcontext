/**
 * K1 (sahip-karti-yerinde criterion 3): checklist and MCP cards are records that open, close and
 * rebuild like run and secret; a crew child's owner item carries a card handle whose spec equals
 * the chat's own parse; `ensureCardsFor` resolves a record from the handle's OWN transcript with
 * no live chat, after a restart and after a `/clear` rotation. Red on 6fece93a (CardKind was
 * run | secret, and every rebuild needed a registry entry).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetCardsForTests, cardHandleOf, cardsInText, closeCard, ensureCardsFor, getCard, isRebuiltFrom, listCards,
  noteAssistantCards, rebuildCards, setCardsHomeForTests,
} from '../../src/lib/cards/records.js';
import { parseViewBlock } from '../../src/lib/chat-view-spec.js';

const SID = '11111111-2222-4333-8444-555555555555';
const OLD_T = 'aaaaaaaa-2222-4333-8444-555555555555';
const NEW_T = 'bbbbbbbb-2222-4333-8444-555555555555';
const MSG = '0f0f0f0f-1111-4222-8333-444444444444';
const fence = (o: object) => `\`\`\`dream-view\n${JSON.stringify(o)}\n\`\`\``;
const checklist = { type: 'checklist', id: 'store-setup', title: 'Store setup', items: [{ id: 'a', text: 'Open the console' }, { id: 'k', text: 'Paste the key', wants: 'secret' }] };
const mcp = { type: 'mcp', id: 'need-linear', servers: ['linear'], why: 'Read the issue' };
const run = { type: 'run', id: 'login', command: 'gcloud auth login' };
const row = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'owner-card-home-'));
  setCardsHomeForTests(home);
  _resetCardsForTests();
});
afterEach(() => {
  setCardsHomeForTests(null);
  rmSync(home, { recursive: true, force: true });
});

function writeTranscript(id: string, rows: string[]): void {
  const dir = join(home, '.claude', 'projects', '-scratch-project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${rows.join('\n')}\n`, 'utf-8');
}

describe('checklist and mcp are records', () => {
  it('cardsInText reads all four owner kinds', () => {
    const t = [fence(run), fence({ type: 'secret', id: 's', title: 'Key', fields: [{ key: 'API_KEY' }] }), fence(checklist), fence(mcp)].join('\n');
    expect(cardsInText(t).map((c) => c.spec.type)).toEqual(['run', 'secret', 'checklist', 'mcp']);
  });
  it('open, close durably, and rebuild closed', () => {
    noteAssistantCards(SID, 'acme', MSG, `${fence(checklist)}\n${fence(mcp)}`);
    const [c, m] = listCards(SID);
    expect([c.kind, c.state, m.kind, m.state]).toEqual(['checklist', 'open', 'mcp', 'open']);
    expect(closeCard(SID, c.cardRef, 'done')).toBe(true);
    // A restart: the records rebuild from the transcript; the closed one comes back closed.
    _resetCardsForTests();
    rebuildCards(SID, 'acme', row(MSG, `${fence(checklist)}\n${fence(mcp)}`));
    expect(getCard(SID, c.cardRef)).toMatchObject({ kind: 'checklist', state: 'closed', closedBy: 'done' });
    expect(getCard(SID, m.cardRef)).toMatchObject({ kind: 'mcp', state: 'open' });
  });
  it('a re-post of the same checklist id supersedes the open one', () => {
    noteAssistantCards(SID, 'acme', MSG, fence(checklist));
    noteAssistantCards(SID, 'acme', 'm2', fence({ ...checklist, title: 'Store setup 2' }));
    expect(listCards(SID).map((x) => [x.state, x.closedBy])).toEqual([['closed', 'superseded'], ['open', undefined]]);
  });
});

describe('the card handle', () => {
  it('carries the cardRef, the posting session and transcript, and a spec equal to the chat\'s own parse', () => {
    const text = `Do this:\n${fence(run)}\nand\n${fence(checklist)}`;
    noteAssistantCards(SID, 'acme', MSG, text);
    const h = cardHandleOf({ postingSession: SID, vault: 'acme', postingConversationId: OLD_T, messageUuid: MSG, text, kind: 'checklist', id: 'store-setup', childRecordId: 'main', childId: SID });
    expect(h).not.toBeNull();
    expect(h!.spec).toEqual(parseViewBlock(JSON.stringify(checklist)).view);
    expect(h!.cardRef).toBe(listCards(SID)[1].cardRef);
    expect(h).toMatchObject({ postingSession: SID, vault: 'acme', postingConversationId: OLD_T, childRecordId: 'main', childId: SID, deliverTo: SID });
    expect(cardHandleOf({ postingSession: SID, vault: 'acme', postingConversationId: OLD_T, messageUuid: MSG, text, kind: 'mcp', id: 'nope', childRecordId: 'main', childId: SID })).toBeNull();
  });
});

describe('ensureCardsFor (no live chat needed)', () => {
  const text = fence(run);
  const handleFor = () => cardHandleOf({ postingSession: SID, vault: 'acme', postingConversationId: OLD_T, messageUuid: MSG, text, kind: 'run', id: 'login', childRecordId: 'main', childId: SID })!;

  it('after a restart, rebuilds the record from the handle\'s own transcript with no registry entry', () => {
    const h = handleFor();
    writeTranscript(OLD_T, [row(MSG, text)]);
    expect(getCard(SID, h.cardRef)).toBeNull();
    const rec = ensureCardsFor(h, '/scratch/project');
    expect(rec).toMatchObject({ cardRef: h.cardRef, kind: 'run', state: 'open', vault: 'acme' });
    expect(isRebuiltFrom(SID, OLD_T)).toBe(true);
  });
  it('after a /clear rotation, a live rebuild of the NEW transcript does not mask the old card', () => {
    const h = handleFor();
    writeTranscript(OLD_T, [row(MSG, text)]);
    // The session's live ensureCards read its new transcript first (no card of ours in it).
    rebuildCards(SID, 'acme', row('cccccccc-1111-4222-8333-444444444444', fence({ type: 'run', id: 'other', command: 'ls' })));
    expect(getCard(SID, h.cardRef)).toBeNull();
    expect(ensureCardsFor(h, '/scratch/project')?.cardRef).toBe(h.cardRef);
    expect(listCards(SID)).toHaveLength(2);
  });
  it('a closed record comes back closed (never a fresh ▶)', () => {
    const h = handleFor();
    writeTranscript(OLD_T, [row(MSG, text)]);
    closeCard(SID, h.cardRef, 'done');
    expect(ensureCardsFor(h, '/scratch/project')).toMatchObject({ state: 'closed', closedBy: 'done' });
  });
  it('an unknown vault (no project root) or a missing transcript resolves nothing', () => {
    const h = handleFor();
    expect(ensureCardsFor(h, null)).toBeNull();
    expect(ensureCardsFor({ ...h, postingConversationId: NEW_T }, '/scratch/project')).toBeNull();
  });
});
