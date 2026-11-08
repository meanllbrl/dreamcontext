/**
 * The thread ledger keeps each entry's content hash beside its id (plan Y3, AA3, AB), and
 * `appendThreadEntry` hands the written id + hash to an optional `stamp` callback (the run-post
 * stamp hangs there). Prune and seed keep the two maps in step; a seeded id has no hash (unknown).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendThreadEntry, isContainedBrainRel, resolvesInsideBrain, threadEntryContentHash } from '../../src/lib/automations/threads.js';
import { confirmAgentSyncHere, recordThreadEntryHere, renameOrForgetThreadLedger, seedThreadLedger, threadEntriesHere, threadHashesHere } from '../../src/lib/agents/agent-sync.js';
import { setGlobalGitHubLogin } from '../../src/lib/git-sync/auth-store.js';
import { localDir } from '../../src/lib/local-store.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;
/** The machine-local ledger (`~/.dreamcontext/local/<projectKey>/`), never the brain. */
const ledgerPath = (): string => join(localDir(projectRoot, home), 'agent-thread-entries.json');

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-ledger-hash-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'dc-ledger-hash-home-'));
  process.env.HOME = home;
  setGlobalGitHubLogin('bob', home);
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('stamp callback', () => {
  it('is called once with the id actually written and the content hash of the written fields', () => {
    const calls: [string, string][] = [];
    const e = appendThreadEntry(contextRoot, 'researcher', {
      runId: 'r1', kind: 'agent', text: 'Rapor hazır\0', via: 'runner', summary: [{ key: ' Gün ', value: ' 12 ' }],
      stamp: (id, hash) => calls.push([id, hash]),
    });
    expect(calls).toEqual([[e.id, threadEntryContentHash(e)]]);
    // The hash covers the NORMALISED fields (NUL stripped, rows trimmed), as read back.
    expect(calls[0][1]).toBe(threadEntryContentHash({ text: 'Rapor hazır', summary: [{ key: 'Gün', value: '12' }] }));
  });

  it('a refused append never stamps', () => {
    const calls: unknown[] = [];
    expect(() => appendThreadEntry(contextRoot, 'researcher', { runId: '', kind: 'agent', text: 'x', via: 'runner', stamp: () => calls.push(1) })).toThrow();
    expect(calls).toEqual([]);
  });

  it('the content hash changes with text, files or summary', () => {
    const h = threadEntryContentHash({ text: 'a' });
    expect(threadEntryContentHash({ text: 'a', files: [], summary: [] })).toBe(h);
    expect(threadEntryContentHash({ text: 'b' })).not.toBe(h);
    expect(threadEntryContentHash({ text: 'a', files: ['x.md'] })).not.toBe(h);
    expect(threadEntryContentHash({ text: 'a', summary: [{ key: 'k', value: 'v' }] })).not.toBe(h);
  });
});

describe('threadHashesHere: a sibling map beside id → at', () => {
  it('null while agent sync is not confirmed here (no ledger is written)', () => {
    appendThreadEntry(contextRoot, 'researcher', { runId: 'r1', kind: 'agent', text: 'x', via: 'runner' });
    expect(threadHashesHere(contextRoot, 'researcher', home)).toBeNull();
  });

  it('records the hash of every entry this machine writes once sync is confirmed', () => {
    confirmAgentSyncHere(contextRoot, home);
    const e = appendThreadEntry(contextRoot, 'researcher', { runId: 'r1', kind: 'agent', text: 'merhaba', via: 'runner' });
    expect(threadEntriesHere(contextRoot, 'researcher', home)?.has(e.id)).toBe(true);
    expect(threadHashesHere(contextRoot, 'researcher', home)?.get(e.id)).toBe(threadEntryContentHash(e));
    const led = JSON.parse(readFileSync(ledgerPath(), 'utf-8'));
    expect(led.entries.researcher[e.id]).toBe(e.at);
    expect(led.hashes.researcher[e.id]).toBe(threadEntryContentHash(e));
  });

  it('a pruned id loses its hash too; an old id → at string reads as no hash (unknown)', () => {
    confirmAgentSyncHere(contextRoot, home);
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
    writeFileSync(ledgerPath(), JSON.stringify({ entries: { researcher: { oldid: old, legacy: new Date().toISOString() } }, hashes: { researcher: { oldid: 'h-old' } } }));
    recordThreadEntryHere(contextRoot, 'researcher', 'newid', new Date().toISOString(), home, 'h-new');
    const led = JSON.parse(readFileSync(ledgerPath(), 'utf-8'));
    expect(led.entries.researcher.oldid).toBeUndefined();
    expect(led.hashes.researcher).toEqual({ newid: 'h-new' });
    const map = threadHashesHere(contextRoot, 'researcher', home)!;
    expect(map.get('legacy')).toBeUndefined();
    expect(map.get('newid')).toBe('h-new');
  });

  it('a hash with no ledger id is ignored (never trusted alone)', () => {
    confirmAgentSyncHere(contextRoot, home);
    writeFileSync(ledgerPath(), JSON.stringify({ entries: { researcher: {} }, hashes: { researcher: { forged: 'h' } } }));
    expect(threadHashesHere(contextRoot, 'researcher', home)?.size).toBe(0);
  });

  it('seeding keeps the hash map (the file is replaced, AB)', () => {
    confirmAgentSyncHere(contextRoot, home);
    const e = appendThreadEntry(contextRoot, 'researcher', { runId: 'r1', kind: 'agent', text: 'kalsın', via: 'runner' });
    seedThreadLedger(contextRoot, home);
    expect(threadHashesHere(contextRoot, 'researcher', home)?.get(e.id)).toBe(threadEntryContentHash(e));
  });
});

describe('rename and forget keep the hash map', () => {
  it('a rename moves the slug\'s hashes, a forget drops them, other agents keep theirs', () => {
    confirmAgentSyncHere(contextRoot, home);
    const a = appendThreadEntry(contextRoot, 'researcher', { runId: 'r1', kind: 'agent', text: 'a', via: 'runner' });
    const b = appendThreadEntry(contextRoot, 'writer', { runId: 'r2', kind: 'agent', text: 'b', via: 'runner' });
    renameOrForgetThreadLedger(contextRoot, 'researcher', 'analyst', home);
    expect(threadHashesHere(contextRoot, 'analyst', home)?.get(a.id)).toBe(threadEntryContentHash(a));
    expect(threadHashesHere(contextRoot, 'writer', home)?.get(b.id)).toBe(threadEntryContentHash(b));
    expect(JSON.parse(readFileSync(ledgerPath(), 'utf-8')).hashes.researcher).toBeUndefined();
    renameOrForgetThreadLedger(contextRoot, 'analyst', null, home);
    const led = JSON.parse(readFileSync(ledgerPath(), 'utf-8'));
    expect(led.hashes.analyst).toBeUndefined();
    expect(led.hashes.writer[b.id]).toBe(threadEntryContentHash(b));
  });
});

describe('exports for member-forward', () => {
  it('isContainedBrainRel and resolvesInsideBrain are exported and refuse a climb', () => {
    expect(isContainedBrainRel(contextRoot, 'automations/output/x.md')).toBe(true);
    expect(isContainedBrainRel(contextRoot, '../secret')).toBe(false);
    expect(resolvesInsideBrain(contextRoot, resolve(contextRoot, 'automations'))).toBe(true);
    expect(resolvesInsideBrain(contextRoot, resolve(projectRoot, '..'))).toBe(false);
  });
});
