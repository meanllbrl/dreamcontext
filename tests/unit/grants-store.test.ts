/**
 * The grant store (plan uye-bildirim K3 "Store", criterion 3): one machine-local directory, 0700
 * folders and 0600 files written atomically, a reader that never throws (corrupt = no grant), a
 * one-shot that exactly one consumer spends, and the deaths of once and job grants. A temp home
 * per test (pattern test-isolation-injectable): the real `~/.dreamcontext` is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addConversationId, bindingByConversation, bindingsByConversation, consumeOnce, grantsDir, listGrants, newGrantId, pruneGrants,
  readBinding, removeBinding, removeGrant, removeMemberGrants, writeBinding, writeGrant,
} from '../../src/lib/grants/store.js';
import { GRANT_MAX_MS, MEMBER_NO_EXPIRY, type Binding, type Grant } from '../../src/lib/grants/types.js';

const PROJECT = '/work/acme';
const NOW = 1_800_000_000_000;
let home: string;
const opts = () => ({ home });

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-grants-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const g = (over: Partial<Grant> = {}): Grant => ({
  id: newGrantId(over.scope ?? 'job'), scope: 'job', project: PROJECT, pin: 'pin-a', tool: 'Bash', input: 'node scripts/build.mjs',
  form: 'script', script: { interpreter: 'node', interpreterPath: '/usr/local/bin/node', scriptPath: `${PROJECT}/scripts/build.mjs`, sha256: 'sha' },
  createdAt: NOW, expiresAt: NOW + GRANT_MAX_MS, ...over,
});
const member = (slug: string, project = PROJECT): Grant => g({ id: newGrantId('member'), scope: 'member', pin: undefined, member: slug, project, expiresAt: MEMBER_NO_EXPIRY });
const once = (over: Partial<Grant> = {}): Grant => g({ id: newGrantId('once'), scope: 'once', ...over });

describe('grants store: writing and reading', () => {
  it('writes each scope in its own folder, 0700 folders and 0600 files, and lists them by project', () => {
    const job = g();
    const rule = member('scout');
    const shot = once({ item: 'item-1' });
    writeGrant(job, opts()); writeGrant(rule, opts()); writeGrant(shot, opts());
    writeGrant(g({ project: '/work/other' }), opts());
    const dir = grantsDir(home);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const sub of ['jobs', 'rules', 'once']) {
      expect(statSync(join(dir, sub)).mode & 0o777).toBe(0o700);
      for (const f of readdirSync(join(dir, sub))) expect(statSync(join(dir, sub, f)).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(join(dir, 'jobs'))).toContain(`${job.id}.json`);
    expect(readdirSync(join(dir, 'rules'))).toEqual([`${rule.id}.json`]);
    expect(listGrants(PROJECT, opts()).map((x) => x.id).sort()).toEqual([job.id, rule.id, shot.id].sort());
    expect(listGrants(undefined, opts())).toHaveLength(4);
    // No temp file is left behind by the atomic write.
    for (const sub of ['jobs', 'rules', 'once']) expect(readdirSync(join(dir, sub)).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('refuses to write an off-shape grant', () => {
    expect(() => writeGrant({ ...g(), id: '../escape' }, opts())).toThrow();
    expect(() => writeGrant({ ...g(), scope: 'member', member: undefined, pin: 'p' }, opts())).toThrow();
    expect(() => writeGrant({ ...g(), script: undefined }, opts())).toThrow();
  });

  it('a corrupt or hand-shaped store reads as no grants and never throws', () => {
    writeGrant(g(), opts());
    const dir = grantsDir(home);
    // Every folder a file is planted into is made here, never left to an earlier write.
    for (const sub of ['jobs', 'once']) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, 'jobs', 'garbage.json'), '{not json');
    writeFileSync(join(dir, 'jobs', 'wrong.json'), JSON.stringify({ id: 'wrong', scope: 'job' }));
    // A job grant dropped into the one-shot folder is not a one-shot, and a file named for another id is not that grant.
    const stray = g({ id: 'job-stray' });
    writeFileSync(join(dir, 'once', 'job-stray.json'), JSON.stringify(stray));
    writeFileSync(join(dir, 'jobs', 'renamed.json'), JSON.stringify(g({ id: 'job-other' })));
    expect(listGrants(PROJECT, opts())).toHaveLength(1);
    // The whole directory replaced by a file.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'grants'), 'not a folder');
    expect(() => listGrants(PROJECT, opts())).not.toThrow();
    expect(listGrants(PROJECT, opts())).toEqual([]);
    expect(bindingByConversation('c1', opts())).toBeNull();
    expect(consumeOnce('once-x', opts())).toBe(false);
  });

  it('removes one grant, and every rule of a deleted member (never another member\'s)', () => {
    const a = member('scout'); const b = member('scout', '/work/other'); const c = member('writer');
    for (const x of [a, b, c]) writeGrant(x, opts());
    expect(removeGrant(a.id, opts())).toBe(true);
    expect(removeGrant(a.id, opts())).toBe(false);
    writeGrant(a, opts());
    expect(removeMemberGrants('scout', undefined, opts())).toBe(2);
    expect(listGrants(undefined, opts()).map((x) => x.id)).toEqual([c.id]);
  });
});

describe('grants store: a one-shot is spent once', () => {
  it('two concurrent consumers: exactly one wins', async () => {
    const shot = once();
    writeGrant(shot, opts());
    const results = await Promise.all([
      Promise.resolve().then(() => consumeOnce(shot.id, opts())),
      Promise.resolve().then(() => consumeOnce(shot.id, opts())),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(listGrants(PROJECT, opts())).toEqual([]);
    expect(consumeOnce(shot.id, opts())).toBe(false);
    expect(consumeOnce('../jobs/x', opts())).toBe(false);
  });
});

describe('grants store: deaths', () => {
  const live = { livePins: ['pin-a'], openRequests: [] as string[] };

  it('a one-shot dies after a day and when its item closed', () => {
    const fresh = once({ item: 'item-open' });
    const closed = once({ item: 'item-closed' });
    const old = once({ createdAt: NOW - GRANT_MAX_MS - 1, expiresAt: NOW + GRANT_MAX_MS });
    for (const x of [fresh, closed, old]) writeGrant(x, opts());
    const gone = pruneGrants({ now: NOW, ...live, openItems: ['item-open'] }, opts());
    expect(gone.sort()).toEqual([closed.id, old.id].sort());
    expect(listGrants(PROJECT, opts()).map((x) => x.id)).toEqual([fresh.id]);
  });

  it('a job grant dies when its session ends, when its requests close, and after a day; a respawn keeps it', () => {
    const mine = g({ pin: 'pin-a' });
    const ended = g({ pin: 'pin-ended' });
    const requests = g({ pin: 'pin-a', requests: ['req-1', 'req-2'] });
    const stillOpen = g({ pin: 'pin-a', requests: ['req-3'] });
    const old = g({ pin: 'pin-a', createdAt: NOW - GRANT_MAX_MS - 1 });
    for (const x of [mine, ended, requests, stillOpen, old]) writeGrant(x, opts());
    // The same pin is live again after a respawn: its grant stays.
    const gone = pruneGrants({ now: NOW, livePins: ['pin-a'], openRequests: ['req-3'] }, opts());
    expect(gone.sort()).toEqual([ended.id, requests.id, old.id].sort());
    expect(listGrants(PROJECT, opts()).map((x) => x.id).sort()).toEqual([mine.id, stillOpen.id].sort());
  });

  it('a member rule is never pruned', () => {
    const rule = { ...member('scout'), createdAt: NOW - 100 * GRANT_MAX_MS };
    writeGrant(rule, opts());
    expect(pruneGrants({ now: NOW, livePins: [], openRequests: [], openItems: [] }, opts())).toEqual([]);
    expect(listGrants(PROJECT, opts())).toHaveLength(1);
  });
});

describe('grants store: bindings', () => {
  const b = (over: Partial<Binding> = {}): Binding => ({
    pid: 4242, startedAt: 'Tue Nov 10 22:01:00 2026', pin: 'pin-a', project: PROJECT, crew: 'member', member: 'scout',
    conversationIds: ['c1'], writtenAt: NOW, ...over,
  });

  it('one file per pid, found by conversation id; a rotated id becomes the current one', () => {
    writeBinding(b(), opts());
    expect(statSync(join(grantsDir(home), 'bindings', '4242.json')).mode & 0o777).toBe(0o600);
    expect(readBinding(4242, opts())).toMatchObject({ pin: 'pin-a', conversationIds: ['c1'] });
    expect(bindingByConversation('c1', opts())?.pid).toBe(4242);
    expect(addConversationId(4242, 'c2', opts())).toBe(true);
    expect(readBinding(4242, opts())?.conversationIds).toEqual(['c1', 'c2']);
    expect(addConversationId(4242, 'c1', opts())).toBe(true);
    expect(readBinding(4242, opts())?.conversationIds).toEqual(['c2', 'c1']);
    expect(addConversationId(9999, 'c3', opts())).toBe(false);
    writeBinding(b({ pid: 5151, conversationIds: ['c2'], writtenAt: Date.now() + 60_000 }), opts());
    // Both have seen `c2`, newest written first (whoAmI tells them apart by current id, pid and start time).
    expect(bindingsByConversation('c2', opts()).map((x) => x.pid)).toEqual([5151, 4242]);
    removeBinding(4242, opts());
    expect(readBinding(4242, opts())).toBeNull();
    expect(bindingByConversation('c1', opts())).toBeNull();
  });

  it('refuses an off-shape binding and ignores a hand-shaped one', () => {
    expect(() => writeBinding(b({ pid: 1 }), opts())).toThrow();
    expect(() => writeBinding({ ...b(), crew: 'boss' as Binding['crew'] }, opts())).toThrow();
    mkdirSync(join(grantsDir(home), 'bindings'), { recursive: true });
    writeFileSync(join(grantsDir(home), 'bindings', '7777.json'), JSON.stringify(b({ pid: 8888 })));
    expect(readBinding(7777, opts())).toBeNull();
    expect(bindingByConversation('c1', opts())).toBeNull();
  });
});
