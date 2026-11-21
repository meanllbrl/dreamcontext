/**
 * Reference pictures ride with the job (plan iyilesme-360 D8, D9, C8, C11, S3; criterion 8-9).
 * A picture he sent (a Mac `[Picture N: …]` line, a Telegram drop path) is copied into the child's
 * `tmp/super-prompts/<name>/ref/` and named in its first message; pictures of his messages in the
 * 10 minutes before the origin count, never one after it; a link or an out-of-vault path never
 * rides. Fictional words throughout; HOME is a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-ref-home-`);
});

const sent = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock('../../src/lib/window-control.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/window-control.js')>();
  return {
    ...real,
    sendSuperCommand: async (...a: Parameters<typeof real.sendSuperCommand>) => {
      if (a[1] !== 'delegate') return real.sendSuperCommand(...a);
      sent.prompts.push(String((a[2] as { prompt?: unknown }).prompt ?? ''));
      return { ok: true, result: { sessionId: `child-${sent.prompts.length}` } };
    },
  };
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, msgRef, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, markSuperEventTurn, noteSuperOwnerMsg } from '../../src/lib/super/inbox.js';
import { openMessageDebt } from '../../src/lib/super/owed.js';
import { handleSuperVerb, referenceLines } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { ownerPicturePaths, picturePaths } from '../../src/lib/t3-bridge/pictures.js';
import { promptOwnerText } from '../../src/lib/agents/team-roster.js';

let dir: string;
let root: string;
let drops: string;
let token = '';
const SUPER = 'sup-1';
const MIN = 60_000;
const job = { model: 'sonnet', prompt: 'Read and follow _dream_context/tmp/super-prompts/orbit-hero/brief.md', brief: 'Orbit hero · basic sonnet/medium', mode: 'basic' };

function pic(name: string): string {
  const p = join(drops, name);
  writeFileSync(p, 'PNGDATA');
  return p;
}
/** His earlier messages, as superOwnerOwes leaves them in the record. */
function writeDebts(debts: Array<{ text: string; at: number; pictures?: string[] }>): void {
  const s: SuperState = { ...emptySuperState(), session: SUPER, enabled: true };
  for (const d of debts) {
    const o = openMessageDebt(s, d.text, d.at, msgRef(d.text));
    if (d.pictures) o.pictures = d.pictures;
  }
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(s));
  resetSuperIndex();
}
function req(body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
async function verb(name: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const out = { status: 0, json: {} as Record<string, unknown> };
  const r = out as unknown as ServerResponse;
  (r as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (r as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  await handleSuperVerb(req(body), r, { verb: name });
  return out;
}
const refFiles = (): string[] => {
  const base = join(root, 'tmp', 'super-prompts');
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((n) => existsSync(join(base, n, 'ref')) ? readdirSync(join(base, n, 'ref')).map((f) => `${n}/ref/${f}`) : []);
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-ref-')));
  sent.prompts.length = 0;
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  root = join(dir, 'acme', '_dream_context');
  drops = join(root, 'tmp', 'agent-drops');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(drops, { recursive: true });
  writeDebts([]);
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
});
afterEach(() => { markSuperEventTurn(SUPER, false); rmSync(dir, { recursive: true, force: true }); });

describe('intake: only his real pictures inside agent-drops (S3)', () => {
  it('picture lines, bare drop paths and picture chips count; a link, another folder or a non-image never', () => {
    const a = pic('a.png'); const b = pic('tg-b.jpg');
    const outside = join(dir, 'secret.png'); writeFileSync(outside, 'X');
    const link = join(drops, 'link.png'); symlinkSync(outside, link);
    const txt = pic('notes.txt');
    const text = `[Picture 1: ${a}]\nbunu birebir yap\n\n${b}\n\npicture: ${link}\n${outside}\n${txt}\n[Picture 2: ${a}]`;
    expect(ownerPicturePaths(text, root)).toEqual([a, b]);
  });
  it('picturePaths for Codex and Antigravity is unchanged', () => {
    const a = pic('a.png');
    expect(picturePaths(`[Picture 1: ${a}]\n${a}`, dir)).toEqual([a]);
  });
});

describe('a job takes his pictures (criterion 8)', () => {
  it('(a) in his turn, before the debt lands: both pictures copied to ref/ and named', async () => {
    const a = pic('a.png'); const b = pic('b.png');
    const text = `[Picture 1: ${a}]\n[Picture 2: ${b}]\nbunu birebir yap`;
    markSuperEventTurn(SUPER, false);
    noteSuperOwnerMsg(SUPER, msgRef(text), { words: 'bunu birebir yap', pictures: ownerPicturePaths(text, root) });
    expect((await verb('delegate', job)).status).toBe(200);
    expect(refFiles()).toHaveLength(2);
    const p = sent.prompts[0];
    expect(p).toContain('Reference pictures from his messages (match them exactly unless his words say otherwise):');
    expect(p).toMatch(/super-prompts\/[^/\s]+\/ref\/ref-1\.png, .*ref-2\.png\./);
    expect(p).toContain("End with result screenshots at the reference's width, `result-<n>.png` beside `ref/`");
    expect((await readSuperState(root)).children['child-1'].context?.pictures).toEqual([a, b]);
  });

  it('(b) a Telegram photo, then his voice note 2 min later as the origin: the photo rides', async () => {
    const photo = pic('tg-photo.jpg');
    const now = Date.now();
    writeDebts([{ text: `İletilen açıklama ${'x'.repeat(320)}`, at: now - 2 * MIN, pictures: [photo] }, { text: 'şunu aynısı gibi yap', at: now }]);
    markSuperEventTurn(SUPER, true);
    expect((await verb('delegate', { ...job, origin: msgRef('şunu aynısı gibi yap') })).status).toBe(200);
    expect(sent.prompts[0]).toMatch(/ref-1\.jpg\./);
  });

  it('(c, e) an older origin: its own and those up to 10 min before, never 11 min before or after it', async () => {
    const own = pic('own.png'); const before = pic('before.png'); const tooOld = pic('old.png'); const after = pic('after.png');
    const now = Date.now();
    writeDebts([
      { text: 'çok eski', at: now - 41 * MIN, pictures: [tooOld] },
      { text: 'biraz önce', at: now - 35 * MIN, pictures: [before] },
      { text: 'asıl istek', at: now - 30 * MIN, pictures: [own] },
      { text: 'sonradan', at: now - 5 * MIN, pictures: [after] },
    ]);
    markSuperEventTurn(SUPER, true);
    expect((await verb('delegate', { ...job, origin: msgRef('asıl istek') })).status).toBe(200);
    expect((await readSuperState(root)).children['child-1'].context?.pictures).toEqual([own, before]);
  });

  it('(g) a pooled row keeps its picture; a later turn of his with other pictures never adds them; a gone file is named', async () => {
    const mine = pic('mine.png');
    const text = `[Picture 1: ${mine}]\nhero bunun gibi`;
    markSuperEventTurn(SUPER, false);
    noteSuperOwnerMsg(SUPER, msgRef(text), { words: 'hero bunun gibi', pictures: ownerPicturePaths(text, root) });
    const pooled = await verb('pool-add', job);
    expect(pooled.status).toBe(200);
    const id = String((pooled.json.result as { pooled?: unknown }).pooled);
    const other = pic('other.png');
    const later = `[Picture 1: ${other}]\nbaşka bir iş`;
    noteSuperOwnerMsg(SUPER, msgRef(later), { words: 'başka bir iş', pictures: ownerPicturePaths(later, root) });
    const started = await verb('delegate', { from: id });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    expect(refFiles()).toEqual([`${id}/ref/ref-1.png`]);
    // The same row started again after the file went: named, not copied.
    unlinkSync(mine);
    rmSync(join(root, 'tmp', 'super-prompts'), { recursive: true, force: true });
    expect(referenceLines({ paths: [], missing: 1 })).toBe('1 picture was no longer there.\n\n');
  });

  it('(h) no pictures: no reference line at all', async () => {
    markSuperEventTurn(SUPER, false);
    noteSuperOwnerMsg(SUPER, msgRef('bir iş'), { words: 'bir iş', pictures: [] });
    expect((await verb('delegate', job)).status).toBe(200);
    expect(sent.prompts[0]).not.toContain('Reference pictures');
    expect(refFiles()).toEqual([]);
  });

  it('every reference line is stripped from his words', () => {
    const lines = referenceLines({ paths: ['/x/_dream_context/tmp/super-prompts/j1/ref/ref-1.png'], missing: 1 });
    expect(promptOwnerText(`${lines}${referenceLines({ paths: [], missing: 2 })}Ship the hero.`)).toBe('Ship the hero.');
  });
});
