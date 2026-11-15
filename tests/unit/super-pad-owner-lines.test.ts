/**
 * Task ajanda-gunluk C2, criterion 7: a line the owner wrote himself (`author: 'owner'`) is his.
 * No automatic rule acts on it: settlePad (also after it gains a `for`), the twin rule, the
 * answer-close rule, the stale fold, the agenda notice, `note clear`. The Super's explicit note
 * commands still change it, and a Super line he moved back still goes stale. Fictional project.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { closeAnswered, ownerLine, padNotice, padStale, settlePad, withoutTwins } from '../../src/lib/super/pad.js';
import { PAD_STALE_MS, emptySuperState, type SuperChild, type SuperPadItem, type SuperState } from '../../src/lib/super/types.js';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { SUPER_VERB_HANDLERS, type SuperCaller } from '../../src/server/routes/super.js';
import { superNotepad } from '../../dashboard/src/components/sleepy/super/superHandover.js';

const KID = 'kid-1';
const NOW = 10 * PAD_STALE_MS;
const child = (extra: Partial<SuperChild> = {}): SuperChild => ({ sessionId: KID, brief: 'Acme board', adopted: false, startedAt: 1, row: 'working', ...extra });
const his = (extra: Partial<SuperPadItem> = {}): SuperPadItem => ({ id: 'n1', section: 'now', text: 'Call the Acme printer about the proofs', at: NOW - 3 * PAD_STALE_MS, author: 'owner', by: 'owner', ...extra });
const state = (extra: Partial<SuperState> = {}): SuperState => ({ ...emptySuperState(), session: 'sess-own', enabled: true, children: { [KID]: child() }, ...extra });

describe('no automatic rule acts on his line', () => {
  it('ownerLine reads author only', () => {
    expect(ownerLine(his())).toBe(true);
    expect(ownerLine({ author: undefined })).toBe(false);
  });

  it('settlePad never moves it, even after it gained a job', () => {
    const s = state({ children: { [KID]: child({ row: 'done' }) }, pad: [his({ for: KID })] });
    expect(settlePad(s, NOW)).toBe(false);
    expect(s.pad![0].section).toBe('now');
    const noBy = state({ children: { [KID]: child({ row: 'done' }) }, pad: [his({ for: KID, by: undefined })] });
    expect(settlePad(noBy, NOW)).toBe(false);
  });

  it('the twin rule never removes it', () => {
    const pad = [his({ by: undefined, text: 'Acme pricing page draft review' })];
    expect(withoutTwins(pad, 'Acme pricing page draft review', NOW)).toHaveLength(1);
  });

  it('an answered question never closes it', () => {
    const s = state({ pad: [his({ section: 'waiting', by: undefined, text: 'Choose the Acme logo colour palette' })] });
    closeAnswered(s, 'Choose the Acme logo colour palette', NOW);
    expect(s.pad![0].section).toBe('waiting');
  });

  it('it never goes stale and is never told to the Super', () => {
    expect(padStale(his(), NOW)).toBe(false);
    expect(padStale(his({ section: 'waiting', at: 1 }), NOW)).toBe(false);
    expect(padNotice(state({ pad: [his()] }), NOW).ids).toEqual([]);
    // The card mirrors it: no stale fold.
    const rows = superNotepad({ queue: [], pad: [his()] }, { live: () => null, titleFor: (x: string) => x, superTitle: 'Super' }, NOW);
    expect(rows.now[0].stale).toBeUndefined();
  });

  it('a Super line he moved back still goes stale, as before', () => {
    expect(padStale({ id: 'n2', section: 'now', text: 'Acme deploy', at: NOW - PAD_STALE_MS, for: KID, by: 'owner' }, NOW)).toBe(true);
  });
});

describe('the Super\'s commands', () => {
  let dir: string;
  let root: string;
  beforeEach(() => {
    resetSuperIndex();
    _resetSuperInbox();
    dir = mkdtempSync(join(tmpdir(), 'pad-owner-lines-'));
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sess-own', enabled: true, pad: [
      his({ id: 'n1', at: 1000 }),
      { id: 'n2', section: 'now', text: 'Acme deploy', at: 1000 },
      { id: 'n3', section: 'done', text: 'Acme logo sent', at: Date.now() },
    ], padSeq: 3 }));
  });
  afterEach(() => { _resetSuperInbox(); rmSync(dir, { recursive: true, force: true }); });

  function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
    const out = { status: 0, json: {} } as ServerResponse & { status: number; json: Record<string, unknown> };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
    (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
    return out;
  }
  async function verb(name: keyof typeof SUPER_VERB_HANDLERS, body: Record<string, unknown>) {
    const r = res();
    await SUPER_VERB_HANDLERS[name]({ token: 't', who: { contextRoot: root }, state: await readSuperState(root) } as unknown as SuperCaller, body, r);
    return r;
  }

  it('`note clear` leaves his lines; a section clear too', async () => {
    await verb('note-clear', {});
    expect((await readSuperState(root)).pad!.map((p) => p.id)).toEqual(['n1']);
    await verb('note-clear', { section: 'now' });
    expect((await readSuperState(root)).pad!.map((p) => p.id)).toEqual(['n1']);
  });

  it('`note done`, `note status` and `note drop` still change his line', async () => {
    expect((await verb('note-status', { id: 'n1', status: 'almost-done' })).status).toBe(200);
    expect((await readSuperState(root)).pad!.find((p) => p.id === 'n1')).toMatchObject({ stage: 'almost', author: 'owner', by: 'owner' });
    await verb('note-done', { id: 'n1' });
    expect((await readSuperState(root)).pad!.find((p) => p.id === 'n1')).toMatchObject({ section: 'done', author: 'owner' });
    await verb('note-drop', { id: 'n1' });
    expect((await readSuperState(root)).pad!.find((p) => p.id === 'n1')).toBeUndefined();
  });
});
