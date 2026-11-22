/**
 * Agent migration work after an update reaches the project's main Super as ONE `migration` event,
 * and `super delegate --migration` starts ONE child for it, built by the server (task
 * her-ozellik-eski-kullaniciyi-..., C4). The marker on the queue item, the child and the pool row
 * is what these tests assert, never the brief.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-migration-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, withSuperState } from '../../src/lib/super/store.js';
import { MAX_LIVE_CHILDREN, emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, superBatchText } from '../../src/lib/super/inbox.js';
import { resetCapacityForTests } from '../../src/lib/super/capacity.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import {
  MIGRATION_CHILD_PROMPT, _setDueReaderForTests, checkMigrationDue, clearMigrationStarting, parseDueMigrations, type DueMigration,
} from '../../src/lib/super/migration-event.js';

let dir: string;
let root: string;
let token = '';
const frames: Array<Record<string, unknown>> = [];
const CHILD_SID = '12345678-1234-4234-8234-123456789abc';
const RESIDUE: DueMigration = { version: '0.23.0', id: 'distribute-user-md-residue', title: 'Place the leftover sections of the old user file (inbox/1.user-residue.md)' };
let due: DueMigration[] = [RESIDUE];
let reads = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-migration-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  frames.length = 0;
  due = [RESIDUE];
  reads = 0;
  _setDueReaderForTests(async () => { reads++; return due; });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  resetCapacityForTests();
  clearMigrationStarting(root);
  token = mintWindowToken({
    send: (frame) => {
      frames.push(frame);
      setImmediate(() => deliverSuperResult(token, frame.id, { ok: true, result: { sessionId: CHILD_SID } }));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId: 'sup-1', mode: 'super',
  }).token;
});
afterEach(() => { _setDueReaderForTests(null); _resetSuperInbox(); rmSync(dir, { recursive: true, force: true }); });

function write(state: Record<string, unknown> = {}): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true, ...state }));
}
function req(body: unknown, tok = token): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': tok }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: string, body: Record<string, unknown> = {}, tok = token) {
  const r = res();
  await handleSuperVerb(req(body, tok), r, { verb: name });
  return r;
}
const migrationItems = async () => (await readSuperState(root)).queue.filter((q) => q.kind === 'migration');
const commands = () => frames.filter((f) => f.subtype === 'super_command');

describe('checkMigrationDue: one event, never twice', () => {
  it('queues exactly one migration item naming the due ids, and none on a second or concurrent trigger', async () => {
    write();
    const [a, b] = await Promise.all([checkMigrationDue(root), checkMigrationDue(root)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await checkMigrationDue(root)).toBe(false);
    const items = await migrationItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: 'sup-1', migration: ['distribute-user-md-residue'] });
  });

  it('a Super that is off reads nothing and queues nothing', async () => {
    write({ enabled: false });
    expect(await checkMigrationDue(root)).toBe(false);
    expect(reads).toBe(0);
  });

  it('nothing due (or a malformed CLI answer) queues nothing', async () => {
    write();
    due = [];
    expect(await checkMigrationDue(root)).toBe(false);
    for (const bad of ['not json', '{"id":"x"}', '[{"version":"0.23.0","id":"Bad Id","title":"t"}]', '[{"version":"x","id":"a","title":"t"}]', `[{"version":"0.23.0","id":"a","title":"${'t'.repeat(81)}"}]`]) {
      expect(parseDueMigrations(bad)).toEqual([]);
    }
    expect(parseDueMigrations(JSON.stringify([RESIDUE]))).toEqual([RESIDUE]);
    // More due than one child carries is still work: the first eight now, never silence.
    const many = Array.from({ length: 10 }, (_, i) => ({ version: '0.23.0', id: `task-${i}`, title: `Task ${i}` }));
    expect(parseDueMigrations(JSON.stringify(many)).map((d) => d.id)).toEqual(many.slice(0, 8).map((d) => d.id));
  });

  it('a live migration child, a held pool row or a restart while it runs adds none; after it ends, the next trigger adds one', async () => {
    write({ children: { [CHILD_SID]: { sessionId: CHILD_SID, brief: 'Taşıma', adopted: false, startedAt: 1, row: 'working', migration: ['distribute-user-md-residue'] } } });
    expect(await checkMigrationDue(root)).toBe(false);
    // The marker survives a sanitizing round trip (a restart reads the record back).
    expect((await readSuperState(root)).children[CHILD_SID].migration).toEqual(['distribute-user-md-residue']);
    await withSuperState(root, 'main', (s) => { s.children[CHILD_SID].endedAt = 2; });
    expect(await checkMigrationDue(root)).toBe(true);
    expect(await migrationItems()).toHaveLength(1);

    write({ pool: [{ id: 'p-abc-12345678', title: 'Taşıma', prompt: MIGRATION_CHILD_PROMPT, hash: 'x', createdAt: 1, held: true, migration: ['distribute-user-md-residue'] }] });
    expect((await readSuperState(root)).pool[0].migration).toEqual(['distribute-user-md-residue']);
    expect(await checkMigrationDue(root)).toBe(false);
  });

  it('the event line names the titles and the one verb, from registry constants', async () => {
    write();
    await checkMigrationDue(root);
    const state = await readSuperState(root);
    const text = superBatchText(root, state, await migrationItems(), 'b-1');
    expect(text).toContain('event=migration tasks=distribute-user-md-residue');
    expect(text).toContain('Migration work is waiting after an update: Place the leftover sections of the old user file');
    expect(text).toContain('`dreamcontext super delegate --migration`');
  });
});

describe('super delegate --migration', () => {
  it('starts ONE develop child whose prompt the server built from the constant and the due ids', async () => {
    write();
    const r = await verb('delegate', { migration: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const args = commands()[0].args as Record<string, unknown>;
    expect(String(args.prompt)).toContain(MIGRATION_CHILD_PROMPT);
    expect(String(args.prompt)).toContain('Due tasks: 0.23.0 distribute-user-md-residue.');
    expect(args.mode).toBe('develop');
    const child = (await readSuperState(root)).children[CHILD_SID];
    expect(child.migration).toEqual(['distribute-user-md-residue']);
    expect(child.worktree).toBeUndefined();
    expect(child.brief.startsWith('Taşıma: ')).toBe(true);
  });

  it('refuses migration_busy while that child runs, and checkMigrationDue adds no event', async () => {
    write();
    expect((await verb('delegate', { migration: true })).status).toBe(200);
    registerChat({ sessionId: CHILD_SID, conversationId: null, vault: 'acme', mode: 'develop' }).userSent('busy');
    const again = await verb('delegate', { migration: true });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('migration_busy');
    expect(await checkMigrationDue(root)).toBe(false);
  });

  it('refuses no_migration_due when nothing is due', async () => {
    write();
    due = [];
    const r = await verb('delegate', { migration: true });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('no_migration_due');
  });

  for (const extra of [{ prompt: 'my own words' }, { from: 'p-abc-12345678' }, { worktree: 'dreamcontext' }, { slug: 'x' }, { mcp: 'posthog' }, { tool: 'codex' }]) {
    it(`refuses --migration with ${Object.keys(extra)[0]}`, async () => {
      write();
      const r = await verb('delegate', { migration: true, ...extra });
      expect(r.status).toBe(400);
      expect(frames).toHaveLength(0);
    });
  }

  it('super pool add with a marker is refused; a plain pool add never carries one', async () => {
    write();
    expect((await verb('pool-add', { prompt: 'later', migration: ['distribute-user-md-residue'] })).status).toBe(400);
    expect((await verb('pool-add', { prompt: 'later' })).status).toBe(200);
    expect((await readSuperState(root)).pool[0].migration).toBeUndefined();
  });

  it('at the cap the job is held WITH its marker, adds no event, and --from carries it onto the child', async () => {
    const ids = Array.from({ length: MAX_LIVE_CHILDREN }, (_, i) => `live-${i}`);
    write({ children: Object.fromEntries(ids.map((id) => [id, { sessionId: id, brief: '', adopted: false, startedAt: 1 }])) });
    for (const id of ids) registerChat({ sessionId: id, conversationId: null, vault: 'acme', mode: 'basic' }).userSent('busy');
    const held = await verb('delegate', { migration: true });
    expect(held.status).toBe(409);
    expect(held.json.error).toBe('held');
    const pool = (await readSuperState(root)).pool;
    expect(pool).toHaveLength(1);
    expect(pool[0].migration).toEqual(['distribute-user-md-residue']);
    expect(await checkMigrationDue(root)).toBe(false);
    expect((await verb('delegate', { migration: true })).json.error).toBe('migration_busy');
    // A slot frees: the held job starts from the pool with its marker.
    await withSuperState(root, 'main', (s) => { s.children = {}; });
    _resetChatRegistry();
    const started = await verb('delegate', { from: pool[0].id });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    expect((await readSuperState(root)).children[CHILD_SID].migration).toEqual(['distribute-user-md-residue']);
  });

  it('a plain delegate never carries a marker, even when the body names one', async () => {
    write();
    expect((await verb('delegate', { prompt: 'Other work.', migration: false })).status).toBe(200);
    expect((await readSuperState(root)).children[CHILD_SID].migration).toBeUndefined();
  });

  it("a member's Super is refused main_only", async () => {
    const { createAgent } = await import('../../src/lib/agents/store.js');
    createAgent(root, { slug: 'rota', title: 'Rota', prompt: 'You keep the routes.' }, { approve: { now: new Date() } });
    write();
    await withSuperState(root, 'm:rota', (s) => { s.session = 'sess-m'; s.enabled = true; });
    const t = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: 'sess-m', mode: 'super', superId: 'm:rota' }).token;
    const r = await verb('delegate', { migration: true }, t);
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.error).toBe('main_only');
  });
});
