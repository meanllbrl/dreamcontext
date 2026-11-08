/**
 * Card records (plan H1, J1, K1, K2, K3): an unforgeable cardRef per drawn run/secret card, a
 * durable closed-cards file, and a rebuild after a restart that never reopens a closed card.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetCardsForTests, cardRefOf, cardsInText, closeCard, closeCardsById, getCard, listCards, newestCard,
  noteAssistantCards, readClosedFile, rebuildCards, setCardsHomeForTests,
} from '../../src/lib/cards/records.js';
import { TG_SENTINEL } from '../../src/lib/telegram/contract.js';

const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const run = (id: string, command: string) => `\`\`\`dream-view\n${JSON.stringify({ type: 'run', id, command })}\n\`\`\``;
const secret = (id: string, title: string) => `\`\`\`dream-view\n${JSON.stringify({ type: 'secret', id, title, fields: [{ key: 'API_KEY' }] })}\n\`\`\``;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cards-home-'));
  setCardsHomeForTests(home);
  _resetCardsForTests();
});
afterEach(() => {
  setCardsHomeForTests(null);
  rmSync(home, { recursive: true, force: true });
});

describe('cardRef', () => {
  it('is deterministic over (session, message, fence index, canonical spec) and differs on each', () => {
    const spec = { type: 'run' as const, id: 'x', command: 'ls' };
    const a = cardRefOf(SID, 'm1', 0, spec);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(cardRefOf(SID, 'm1', 0, { command: 'ls', id: 'x', type: 'run' })).toBe(a);
    expect(cardRefOf(SID2, 'm1', 0, spec)).not.toBe(a);
    expect(cardRefOf(SID, 'm2', 0, spec)).not.toBe(a);
    expect(cardRefOf(SID, 'm1', 1, spec)).not.toBe(a);
    expect(cardRefOf(SID, 'm1', 0, { ...spec, command: 'ls -la' })).not.toBe(a);
  });
  it('reads only run and secret cards, with the fence position as the index', () => {
    const t = `${'```dream-view\n{"type":"title","text":"x"}\n```'}\n${run('a', 'ls')}\n${secret('s', 'Key')}`;
    expect(cardsInText(t).map((c) => [c.index, c.spec.type])).toEqual([[1, 'run'], [2, 'secret']]);
  });
});

describe('records', () => {
  it('the same id in two chats are two records; a re-post with a new command is a new cardRef and closes the old', () => {
    noteAssistantCards(SID, 'acme', 'm1', run('deploy', 'npm run a'));
    noteAssistantCards(SID2, 'acme', 'm1', run('deploy', 'npm run a'));
    const [first] = listCards(SID);
    expect(listCards(SID2)[0].cardRef).not.toBe(first.cardRef);
    noteAssistantCards(SID, 'acme', 'm2', run('deploy', 'npm run b'));
    const cards = listCards(SID);
    expect(cards).toHaveLength(2);
    expect(cards[0].state).toBe('closed');
    expect(cards[1].state).toBe('open');
    expect(newestCard(SID, 'run', 'deploy')?.cardRef).toBe(cards[1].cardRef);
    expect(readClosedFile(SID)?.closed).toEqual([first.cardRef]);
  });

  it('the same message seen twice adds nothing', () => {
    noteAssistantCards(SID, 'acme', 'm1', run('a', 'ls'));
    noteAssistantCards(SID, 'acme', 'm1', run('a', 'ls'));
    expect(listCards(SID)).toHaveLength(1);
  });

  it('caps at 16 per chat, evicting closed records before open ones', () => {
    noteAssistantCards(SID, 'acme', 'm0', run('keep-open', 'echo open'));
    for (let i = 1; i <= 16; i++) {
      noteAssistantCards(SID, 'acme', `m${i}`, run(`c${i}`, `echo ${i}`));
      const ref = listCards(SID).find((c) => c.id === `c${i}`)!.cardRef;
      closeCard(SID, ref);
    }
    const cards = listCards(SID);
    expect(cards).toHaveLength(16);
    expect(cards.some((c) => c.id === 'keep-open')).toBe(true);
  });

  it('closing writes the file once (0700 dir, 0600 file); re-closing adds no duplicate', () => {
    noteAssistantCards(SID, 'acme', 'm1', secret('k', 'Key'));
    const ref = listCards(SID)[0].cardRef;
    expect(closeCard(SID, ref)).toBe(true);
    expect(closeCard(SID, ref)).toBe(false);
    const dir = join(home, '.dreamcontext', 'cards');
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    const file = join(dir, `${SID}.json`);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf-8')).closed).toEqual([ref]);
    expect(JSON.parse(readFileSync(file, 'utf-8')).since).toBe('m1');
  });

  it('the Super dropping the wait closes its open records', () => {
    noteAssistantCards(SID, 'acme', 'm1', run('a', 'ls'));
    closeCardsById(SID, 'run', 'a');
    expect(listCards(SID)[0].state).toBe('closed');
  });

  it('a symlinked closed-cards file is not read and not written through', () => {
    const dir = join(home, '.dreamcontext', 'cards');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(home, 'elsewhere.json');
    writeFileSync(target, JSON.stringify({ v: 1, closed: ['0'.repeat(32)] }));
    symlinkSync(target, join(dir, `${SID}.json`));
    expect(readClosedFile(SID)).toBeNull();
    noteAssistantCards(SID, 'acme', 'm1', run('a', 'ls'));
    closeCard(SID, listCards(SID)[0].cardRef);
    expect(JSON.parse(readFileSync(target, 'utf-8')).closed).toEqual(['0'.repeat(32)]);
  });

  it('a non-UUID session never becomes a path', () => {
    noteAssistantCards('../../etc', 'acme', 'm1', run('a', 'ls'));
    expect(listCards('../../etc')).toEqual([]);
    expect(existsSync(join(home, '.dreamcontext', 'cards'))).toBe(false);
  });
});

describe('rebuild after a restart', () => {
  const row = (type: string, uuid: string, text: string) => JSON.stringify({ type, uuid, message: { content: [{ type: 'text', text }] } });

  it('a card in the closed-cards file comes back CLOSED; a genuinely open one stays open', () => {
    noteAssistantCards(SID, 'acme', 'u1', run('a', 'ls'));
    noteAssistantCards(SID, 'acme', 'u2', run('b', 'pwd'));
    const [a, b] = listCards(SID);
    closeCard(SID, a.cardRef);
    _resetCardsForTests();
    const jsonl = [row('assistant', 'u1', run('a', 'ls')), row('user', 'x', 'thanks'), row('assistant', 'u2', run('b', 'pwd'))].join('\n');
    rebuildCards(SID, 'acme', jsonl);
    expect(getCard(SID, a.cardRef)?.state).toBe('closed');
    expect(getCard(SID, b.cardRef)?.state).toBe('open');
    // After the marker, an owner line never closes a card by inference.
    expect(getCard(SID, b.cardRef)?.rebuilt).toBe(true);
  });

  it('a pre-tracking (legacy) card is closed by a later owner line, never by a Telegram owner block', () => {
    const jsonl = [
      row('assistant', 'u1', run('a', 'ls')),
      row('user', 'x1', `${TG_SENTINEL}abc123${TG_SENTINEL}tamam yaptım`),
      row('assistant', 'u2', run('b', 'pwd')),
      row('user', 'x2', '[ran in chat]\n$ pwd\nexit 0 · 1s'),
    ].join('\n');
    rebuildCards(SID, 'acme', jsonl);
    const cards = listCards(SID);
    // The Telegram block answered nothing; the receipt names pwd, so only `b` closes.
    expect(cards.find((c) => c.id === 'a')?.state).toBe('open');
    expect(cards.find((c) => c.id === 'b')?.state).toBe('closed');
  });
});
