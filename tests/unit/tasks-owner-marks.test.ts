/**
 * Task ajanda-gunluk C5/C6, criterion 9: a task the owner created or moved by hand (a kanban drag
 * included) rides his next message to the main Super as a hand mark, recorded right after the task
 * write. Only a request proven his (the shell's owner key) and only while the Super is on; a mark
 * never fails the task write. Fictional project (synthetic fixtures).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleTasksCreate, handleTasksUpdate } from '../../src/server/routes/tasks.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { emptySuperState } from '../../src/lib/super/types.js';

const KEY = 'b2'.repeat(32);
let dir: string;
let root: string;

beforeEach(() => {
  resetSuperIndex();
  _resetSuperInbox();
  setOwnerKey(KEY);
  dir = mkdtempSync(join(tmpdir(), 'tasks-owner-marks-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'core'), { recursive: true });
});
afterEach(() => { setOwnerKey(null); _resetSuperInbox(); rmSync(dir, { recursive: true, force: true }); });

async function superOn(enabled = true): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-tasks', enabled }));
  await readSuperState(root);
}
function req(body: unknown, owner: boolean): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(r, { headers: owner ? { [OWNER_KEY_HEADER]: KEY } : {}, method: 'POST', url: '/' });
  return r;
}
function res(): ServerResponse & { statusCode: number } {
  const out = { statusCode: 0, writeHead(c: number) { out.statusCode = c; return out; }, end() { return out; }, setHeader() { return out; } };
  return out as unknown as ServerResponse & { statusCode: number };
}
const marks = async () => (await readSuperState(root)).ownerMarks ?? [];

describe('task hand marks', () => {
  it('his create and his status change coalesce into one created mark with the latest status', async () => {
    await superOn();
    const c = res();
    await handleTasksCreate(req({ name: 'Acme logo refresh', why: 'The Acme brand moved' }, true), c, {}, root);
    expect(c.statusCode).toBe(201);
    expect(await marks()).toEqual([expect.objectContaining({ key: 'task:acme-logo-refresh', kind: 'task-created', text: 'Acme logo refresh' })]);
    const u = res();
    await handleTasksUpdate(req({ status: 'in_progress' }, true), u, { slug: 'acme-logo-refresh' }, root);
    expect(u.statusCode).toBe(200);
    expect(await marks()).toEqual([expect.objectContaining({ kind: 'task-created', to: 'in_progress' })]);
  });

  it('a status change alone (a kanban drag) is a task-status mark; a change back leaves nothing', async () => {
    await superOn(false);
    await handleTasksCreate(req({ name: 'Acme pricing', why: 'Prices change' }, true), res(), {}, root);
    await superOn();
    await handleTasksUpdate(req({ status: 'in_progress' }, true), res(), { slug: 'acme-pricing' }, root);
    expect(await marks()).toEqual([expect.objectContaining({ key: 'task:acme-pricing', kind: 'task-status', to: 'in_progress' })]);
    const from = (await marks())[0].from!;
    await handleTasksUpdate(req({ status: from }, true), res(), { slug: 'acme-pricing' }, root);
    expect(await marks()).toEqual([]);
  });

  it('no key, or the Super off: the task changes and no mark is made', async () => {
    await superOn();
    await handleTasksCreate(req({ name: 'Acme docs', why: 'Docs' }, false), res(), {}, root);
    expect(await marks()).toEqual([]);
    await superOn(false);
    await handleTasksCreate(req({ name: 'Acme blog', why: 'Blog' }, true), res(), {}, root);
    expect(await marks()).toEqual([]);
  });
});
