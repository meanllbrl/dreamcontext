/**
 * Task ajanda-gunluk C1, criterion 6: five statuses over the stored `section` (+ `stage`), the
 * store keeps `bornAt`, `stage` and `author`, `super note status` sets each status, and
 * `super note add` with only a section works as before. Fictional project (synthetic fixtures).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { readSuperState, resetSuperIndex, sanitizeSuperState, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox, writeSuper } from '../../src/lib/super/inbox.js';
import { padStatus, withPadStatus } from '../../src/lib/super/pad.js';
import { PAD_STATUSES, emptySuperState, type SuperPadItem } from '../../src/lib/super/types.js';
import { SUPER_VERB_HANDLERS, type SuperCaller } from '../../src/server/routes/super.js';

const SESSION = 'sess-status';
let dir: string;
let root: string;

beforeEach(() => {
  resetSuperIndex();
  _resetSuperInbox();
  dir = mkdtempSync(join(tmpdir(), 'pad-status-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
});
afterEach(() => { _resetSuperInbox(); rmSync(dir, { recursive: true, force: true }); });

function res() {
  const out: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  const r = {
    writeHead: (s: number) => { out.status = s; return r; },
    setHeader: () => r,
    end: (b?: string) => { out.body = b ? JSON.parse(b) : {}; },
    headersSent: false,
  } as unknown as ServerResponse;
  return { r, out };
}
async function caller(): Promise<SuperCaller> {
  const state = await readSuperState(root);
  return { who: { contextRoot: root, sessionId: SESSION }, state, superId: 'main', token: 't' } as unknown as SuperCaller;
}
const line = (over: Partial<SuperPadItem> = {}): SuperPadItem => ({ id: 'n1', section: 'now', text: 'Draft the Acme pricing page', at: 1000, ...over });

describe('the five statuses are a pure mapping over the stored section', () => {
  it('round-trips every status and stamps the change', () => {
    for (const status of PAD_STATUSES) {
      const p = withPadStatus(line(), status, 5000);
      expect(padStatus(p)).toBe(status);
      expect(p.at).toBe(5000);
    }
    expect(withPadStatus(line(), 'not-started', 1)).toMatchObject({ section: 'now', stage: 'todo' });
    expect(withPadStatus(line(), 'almost-done', 1)).toMatchObject({ section: 'now', stage: 'almost' });
    expect(withPadStatus(line({ stage: 'todo' }), 'in-progress', 1)).not.toHaveProperty('stage');
    expect(withPadStatus(line({ stage: 'almost' }), 'waiting', 1)).toEqual({ id: 'n1', section: 'waiting', text: 'Draft the Acme pricing page', at: 1 });
  });

  it('a line with no stage reads as In progress (every line before this change)', () => {
    expect(padStatus(line())).toBe('in-progress');
    expect(padStatus(line({ section: 'done' }))).toBe('done');
    expect(padStatus(line({ section: 'waiting' }))).toBe('waiting');
  });
});

describe('the store keeps the new fields', () => {
  it('bornAt, stage and author survive a write and a read; a line without bornAt gets `at`', async () => {
    await writeSuper(root, (s) => {
      s.session = SESSION; s.enabled = true;
      s.pad = [line({ bornAt: 500, stage: 'almost', author: 'owner' }), line({ id: 'n2', at: 2000 })];
    });
    const back = (await readSuperState(root)).pad!;
    expect(back[0]).toMatchObject({ bornAt: 500, stage: 'almost', author: 'owner' });
    expect(back[1].bornAt).toBe(2000);
  });

  it('drops what does not belong: a stage outside Now, an unknown author, a bornAt after at', () => {
    const s = sanitizeSuperState({ ...emptySuperState(), pad: [
      line({ section: 'done', stage: 'todo' }),
      { ...line({ id: 'n2' }), author: 'super' } as unknown as SuperPadItem,
      line({ id: 'n3', bornAt: 9999 }),
      { ...line({ id: 'n4' }), stage: 'later' } as unknown as SuperPadItem,
    ] });
    expect(s.pad![0]).not.toHaveProperty('stage');
    expect(s.pad![1]).not.toHaveProperty('author');
    expect(s.pad![2].bornAt).toBe(1000);
    expect(s.pad![3]).not.toHaveProperty('stage');
  });
});

describe('the Super\'s verbs', () => {
  beforeEach(() => {
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SESSION, enabled: true }));
  });

  it('`note add` with only a section works as before, now with its day', async () => {
    const { r, out } = res();
    await SUPER_VERB_HANDLERS['note-add'](await caller(), { section: 'waiting', text: 'Your sign-off on the Acme logo' }, r);
    expect((out.body.result as Record<string, unknown>).note).toMatchObject({ id: 'n1', section: 'waiting', text: 'Your sign-off on the Acme logo' });
    const n = ((out.body.result as Record<string, unknown>).note as SuperPadItem);
    expect(n.bornAt).toBe(n.at);
  });

  it('`note status` sets each of the five statuses, and refuses an unknown one', async () => {
    await SUPER_VERB_HANDLERS['note-add'](await caller(), { section: 'now', text: 'Ship the Acme build' }, res().r);
    for (const status of PAD_STATUSES) {
      const { r, out } = res();
      await SUPER_VERB_HANDLERS['note-status'](await caller(), { id: 'n1', status }, r);
      expect(padStatus((out.body.result as Record<string, unknown>).note as SuperPadItem)).toBe(status);
      expect(padStatus((await readSuperState(root)).pad![0])).toBe(status);
    }
    const bad = res();
    await SUPER_VERB_HANDLERS['note-status'](await caller(), { id: 'n1', status: 'later' }, bad.r);
    expect(bad.out.status).toBe(400);
    const none = res();
    await SUPER_VERB_HANDLERS['note-status'](await caller(), { id: 'n9', status: 'done' }, none.r);
    expect(none.out.status).toBe(404);
  });
});
