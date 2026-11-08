import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_CHAT_LIST_MAX, appChatIds, appChatRoot, newestAppChat, appChatRefusal, assertNotAppChat, closeAppChat, createAppChat, listAppChats, lookupAppChat,
  lookupAppChatOf, reopenAppChat, rotateAppChat, stampAppRemoved, titleAppChat,
} from '../../src/lib/apps/chat-store.js';
import { appChatsDir } from '../../src/lib/apps/registry.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-chats-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const make = (over: Partial<{ id: string; hash: string; projectRoot: string }> = {}) => createAppChat({
  id: over.id ?? randomUUID(), hash: over.hash ?? 'h1', slug: 'yuk', projectRoot: over.projectRoot ?? '/p', member: null,
}, home);

describe('the record', () => {
  it('is a 0600 file, and membership is the file', () => {
    const r = make();
    const file = join(appChatsDir(home), `${r.id}.json`);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(lookupAppChat(r.id, home)).toEqual({ kind: 'record', record: r });
    expect(lookupAppChat(randomUUID(), home)).toEqual({ kind: 'none' });
  });
  it('no id that is not a UUID reaches a path', () => {
    expect(lookupAppChat('../../etc/passwd', home)).toEqual({ kind: 'none' });
    expect(() => createAppChat({ id: '../x', hash: 'h', slug: 's', projectRoot: '/p', member: null }, home)).toThrow();
  });
  it('a damaged or symlinked file reads as damaged, and still refuses', () => {
    const r = make();
    const file = join(appChatsDir(home), `${r.id}.json`);
    writeFileSync(file, '{ not json');
    expect(lookupAppChat(r.id, home).kind).toBe('damaged');
    expect(appChatRefusal(r.id, home)).toBeTruthy();
    const other = randomUUID();
    symlinkSync('/etc/hosts', join(appChatsDir(home), `${other}.json`));
    expect(lookupAppChat(other, home).kind).toBe('damaged');
    writeFileSync(file, JSON.stringify({ id: randomUUID(), hash: 'h', slug: 's', projectRoot: '/p', createdAt: 'x' }));
    expect(lookupAppChat(r.id, home).kind).toBe('damaged');
  });
  it('close, reopen and title', () => {
    const r = make();
    expect(closeAppChat(r.id, home)?.closedAt).toBeTruthy();
    expect(reopenAppChat(r.id, home)?.closedAt).toBeNull();
    expect(titleAppChat(r.id, '  Yük  ', home)?.title).toBe('Yük');
  });
});

describe('the refusal for every other resume path', () => {
  it('names a record and passes anything else', () => {
    const r = make();
    expect(appChatRefusal(r.id, home)).toBeTruthy();
    expect(appChatRefusal(randomUUID(), home)).toBeNull();
    expect(appChatRefusal('', home)).toBeNull();
    expect(() => assertNotAppChat(r.id, home)).toThrow();
    const free = randomUUID();
    expect(assertNotAppChat(free, home)).toBe(free);
  });
  it('a row past the listing cap still refuses', () => {
    const rows = Array.from({ length: APP_CHAT_LIST_MAX + 5 }, () => make());
    expect(listAppChats('h1', '/p', home)).toHaveLength(APP_CHAT_LIST_MAX);
    for (const r of rows) expect(appChatRefusal(r.id, home)).toBeTruthy();
  });
});

describe('rotation', () => {
  it('gives the successor its own record, stamps the predecessor, collapses the listing', () => {
    const a = make();
    const b = randomUUID();
    const next = rotateAppChat(a, b, home);
    expect(next).toMatchObject({ id: b, via: a.id, hash: a.hash, slug: a.slug, projectRoot: a.projectRoot, member: null });
    expect(lookupAppChat(a.id, home)).toMatchObject({ record: { closedAt: expect.any(String) } });
    // One row, under the pin its live child is keyed by.
    expect(listAppChats('h1', '/p', home).map((r) => r.id)).toEqual([a.id]);
    expect(listAppChats('h1', '/p', home)[0].closedAt).toBeNull();
    expect(appChatRoot(b, home)).toBe(a.id);
    expect(newestAppChat(a.id, home)).toBe(b);
    expect(appChatIds('h1', '/p', home)).toEqual(new Set([a.id, b]));
    expect(rotateAppChat(a, b, home)).toBeNull();
    expect(appChatRefusal(b, home)).toBeTruthy();
  });
  it('carries a title set since the spawn, and a removal', () => {
    const a = make();
    titleAppChat(a.id, 'Later', home);
    stampAppRemoved('h1', home);
    const next = rotateAppChat(a, randomUUID(), home);
    expect(next).toMatchObject({ title: 'Later', removedAt: expect.any(String) });
  });
  it('lookupAppChatOf finds the first of several ids, and a damaged one', () => {
    const a = make();
    expect(lookupAppChatOf(['', randomUUID(), a.id], home).kind).toBe('record');
    writeFileSync(join(appChatsDir(home), `${a.id}.json`), 'x');
    expect(lookupAppChatOf([a.id], home).kind).toBe('damaged');
  });
});

describe('removal', () => {
  it('stamps every record of the app and none of another, keeping the files', () => {
    const a = make();
    const b = make({ hash: 'h2' });
    expect(stampAppRemoved('h1', home)).toEqual([a.id]);
    expect(lookupAppChat(a.id, home)).toMatchObject({ record: { removedAt: expect.any(String) } });
    expect(lookupAppChat(b.id, home)).toMatchObject({ record: { removedAt: null } });
    expect(readFileSync(join(appChatsDir(home), `${a.id}.json`), 'utf-8')).toContain('removedAt');
  });
  it('another project is not this project', () => {
    make({ projectRoot: '/other' });
    expect(listAppChats('h1', '/p', home)).toEqual([]);
    mkdirSync(join(home, 'x'));
  });
});
