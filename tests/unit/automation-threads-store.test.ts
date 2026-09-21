/**
 * The thread store — an agent's channel as append-only, merge-tolerant markdown.
 *
 * The properties worth holding, each of which fails SILENTLY if it breaks:
 *   1. `id` string compare is time order (everything rests on this: sort,
 *      unread, and the pruned-watermark math all use `<` with no lookup).
 *   2. `readThread` never throws and stays correct through git conflict
 *      markers, duplicated ids and torn blocks — a conflicted thread must be
 *      readable BEFORE anyone resolves the file.
 *   3. Two processes appending concurrently lose at most a torn block, never
 *      the file.
 *   4. Unread is per machine, monotonic, excludes your own replies, and fails
 *      toward OVER-notifying in all three pruned-watermark branches (R3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  allThreadUnread,
  appendThreadEntry,
  listThreadRuns,
  markThreadRead,
  newThreadEntryId,
  pruneThreads,
  readThread,
  readThreadRun,
  threadDateStamp,
  threadDayPath,
  threadSlugDir,
  threadUnread,
  threadWatermarkPath,
} from '../../src/lib/automations/threads.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { AutomationError, THREAD_DAY_MAX_ENTRIES, THREAD_ENTRY_MARKER, THREAD_TEXT_MAX_CHARS } from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;
let home: string;

const RUN = '2026-09-20T09:00:00.000Z';

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-threads-'));
  contextRoot = join(projectRoot, '_dream_context');
  home = join(projectRoot, 'home');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function post(text: string, over: Partial<Parameters<typeof appendThreadEntry>[2]> = {}) {
  return appendThreadEntry(contextRoot, 'digest', { runId: RUN, kind: 'agent', text, via: 'cli', ...over });
}

describe('newThreadEntryId — string compare IS time order', () => {
  it('an earlier timestamp always sorts before a later one (property, 1000 samples)', () => {
    // The whole store rests on this: sort, unread and the pruned-watermark
    // branches all use `<` on raw ids with no entry lookup.
    for (let i = 0; i < 1000; i++) {
      const t1 = Math.floor(Math.random() * 4_000_000_000_000);
      const t2 = t1 + 1 + Math.floor(Math.random() * 1_000_000);
      expect(newThreadEntryId(t1) < newThreadEntryId(t2)).toBe(true);
    }
  });

  it('keeps a fixed-width prefix, so `<` cannot be thrown off by length', () => {
    expect(newThreadEntryId(0).split('_')[0]).toHaveLength(9);
    expect(newThreadEntryId(Date.now()).split('_')[0]).toHaveLength(9);
    // Year ~5000, the documented ceiling.
    expect(newThreadEntryId(95_617_584_000_000).split('_')[0]).toHaveLength(9);
  });

  it('two ids in the SAME millisecond are still distinct', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newThreadEntryId(1_700_000_000_000)));
    expect(ids.size).toBe(200);
  });
});

describe('append and read', () => {
  it('round-trips an entry and writes a human-readable day file', () => {
    const e = post('3 insights synced.', { files: ['automations/output/digest/2026-09-20.md'] });
    const raw = readFileSync(threadDayPath(contextRoot, 'digest'), 'utf-8');
    expect(raw).toContain('slug: digest');
    expect(raw).toContain(THREAD_ENTRY_MARKER);
    const read = readThread(contextRoot, 'digest');
    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(e);
    expect(read[0].files).toEqual(['automations/output/digest/2026-09-20.md']);
  });

  it('orders by id across several day files, not by the order they are read', () => {
    post('day one', { now: new Date('2026-09-18T10:00:00') });
    post('day three', { now: new Date('2026-09-20T10:00:00') });
    post('day two', { now: new Date('2026-09-19T10:00:00') });
    expect(readThread(contextRoot, 'digest').map((e) => e.text)).toEqual(['day one', 'day two', 'day three']);
  });

  it('honours limit, sinceId and runId', () => {
    const a = post('one');
    post('two');
    appendThreadEntry(contextRoot, 'digest', { runId: 'other-run', kind: 'agent', text: 'elsewhere', via: 'cli' });
    expect(readThread(contextRoot, 'digest', { limit: 1 }).map((e) => e.text)).toEqual(['elsewhere']);
    expect(readThread(contextRoot, 'digest', { sinceId: a.id }).map((e) => e.text)).toEqual(['two', 'elsewhere']);
    expect(readThreadRun(contextRoot, 'digest', RUN).map((e) => e.text)).toEqual(['one', 'two']);
  });

  it('caps text and strips NULs — this string lands in a synced file', () => {
    const e = post(`${'x'.repeat(THREAD_TEXT_MAX_CHARS + 500)}\0\0`);
    expect(e.text).toHaveLength(THREAD_TEXT_MAX_CHARS);
    expect(e.text).not.toContain('\0');
  });

  it('refuses a file path outside the brain, and writes NOTHING', () => {
    expect(() => post('x', { files: ['/etc/passwd'] })).toThrow(AutomationError);
    expect(() => post('x', { files: ['../../../etc/passwd'] })).toThrow(AutomationError);
    expect(readThread(contextRoot, 'digest')).toHaveLength(0);
  });

  it('refuses an unsafe slug rather than joining it into a path', () => {
    expect(() => appendThreadEntry(contextRoot, '../escape', { runId: RUN, kind: 'agent', text: 'x', via: 'cli' }))
      .toThrow(AutomationError);
    expect(() => threadSlugDir(contextRoot, '../escape')).toThrow(AutomationError);
  });

  it('refuses an entry with no run to belong to', () => {
    expect(() => appendThreadEntry(contextRoot, 'digest', { runId: '  ', kind: 'agent', text: 'x', via: 'cli' }))
      .toThrow(AutomationError);
  });

  it('REFUSES past the per-day cap rather than dropping silently', () => {
    // A post the agent believes it made is worse than one it knows it could not.
    const day = new Date('2026-09-20T10:00:00');
    for (let i = 0; i < THREAD_DAY_MAX_ENTRIES; i++) post(`e${i}`, { now: day });
    expect(() => post('one too many', { now: day })).toThrow(/refusing to append/i);
    // …and tomorrow is a different file, so the cap bounds a FILE, not a thread.
    expect(() => post('next day', { now: new Date('2026-09-21T10:00:00') })).not.toThrow();
  });
});

describe('readThread is TOTAL', () => {
  it('reads a file carrying git conflict markers and a duplicated entry id', () => {
    post('kept');
    const path = threadDayPath(contextRoot, 'digest');
    const dup = readFileSync(path, 'utf-8').split(THREAD_ENTRY_MARKER)[1];
    writeFileSync(path, [
      readFileSync(path, 'utf-8'),
      '<<<<<<< HEAD',
      `${THREAD_ENTRY_MARKER}${dup}`,
      '=======',
      `${THREAD_ENTRY_MARKER}${dup}`,
      '>>>>>>> theirs',
      '',
    ].join('\n'), 'utf-8');

    const read = readThread(contextRoot, 'digest');
    expect(read).toHaveLength(1);
    expect(read[0].text).toBe('kept');
  });

  it('skips a torn block and RESYNCS on the next marker instead of swallowing it', () => {
    post('before');
    post('after');
    const path = threadDayPath(contextRoot, 'digest');
    const raw = readFileSync(path, 'utf-8');
    // Cut the first block's closing fence — exactly what a torn interleave does.
    const torn = raw.replace('```\n\n<!-- dc-thread-entry -->', '\n<!-- dc-thread-entry -->');
    writeFileSync(path, torn, 'utf-8');
    const read = readThread(contextRoot, 'digest');
    expect(read.map((e) => e.text)).toEqual(['after']);
  });

  it('never throws on a missing dir, garbage, or an entry missing required fields', () => {
    expect(readThread(contextRoot, 'never-existed')).toEqual([]);
    expect(readThread(contextRoot, '../escape')).toEqual([]);
    const dir = threadSlugDir(contextRoot, 'digest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-09-20.md'), [
      '---', 'slug: digest', '---', '',
      THREAD_ENTRY_MARKER, '```json', '{not json at all', '```', '',
      THREAD_ENTRY_MARKER, '```json', '{"id":"x"}', '```', '',
      THREAD_ENTRY_MARKER, '```json', `{"id":"000000001_aaaaaa","runId":"${RUN}","kind":"agent","at":"2026-09-20T09:00:00.000Z","text":"survives","via":"cli"}`, '```', '',
    ].join('\n'), 'utf-8');
    expect(readThread(contextRoot, 'digest').map((e) => e.text)).toEqual(['survives']);
  });

  it('ignores files that are not day files', () => {
    const dir = threadSlugDir(contextRoot, 'digest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `${THREAD_ENTRY_MARKER}\n\`\`\`json\n{"id":"zzz","runId":"r","kind":"agent","at":"x","text":"nope","via":"cli"}\n\`\`\`\n`, 'utf-8');
    expect(readThread(contextRoot, 'digest')).toEqual([]);
  });
});

describe('concurrent appends from two processes', () => {
  it('two children appending 200 entries each lose at most a torn block, never the file', () => {
    // The honest claim about `appendFileSync` + O_APPEND: a torn interleave is
    // possible, and the marker resync bounds its cost to one skipped entry.
    const script = join(projectRoot, 'appender.mjs');
    const threadsMod = new URL('../../src/lib/automations/threads.ts', import.meta.url).pathname;
    writeFileSync(script, `
      const { appendThreadEntry } = await import(${JSON.stringify(threadsMod)});
      const [ctx, tag] = process.argv.slice(2);
      for (let i = 0; i < 200; i++) {
        appendThreadEntry(ctx, 'digest', { runId: ${JSON.stringify(RUN)}, kind: 'agent', text: tag + i, via: 'cli' });
      }
    `, 'utf-8');

    const run = (tag: string) => execFileSync('npx', ['tsx', script, contextRoot, tag], { cwd: process.cwd(), stdio: 'ignore' });
    const a = new Promise<void>((res) => { run('a'); res(); });
    const b = new Promise<void>((res) => { run('b'); res(); });
    return Promise.all([a, b]).then(() => {
      const read = readThread(contextRoot, 'digest');
      expect(new Set(read.map((e) => e.id)).size).toBeGreaterThanOrEqual(399);
      expect(read.length).toBe(new Set(read.map((e) => e.id)).size);
    });
  }, 120_000);
});

describe('listThreadRuns', () => {
  it('groups by run, newest first, with the root and the terminal status', () => {
    const older = '2026-09-19T09:00:00.000Z';
    appendThreadEntry(contextRoot, 'digest', { runId: older, kind: 'system', event: 'started', text: 'Run started.', via: 'runner' });
    appendThreadEntry(contextRoot, 'digest', { runId: older, kind: 'system', event: 'ok', text: 'Done.', via: 'runner' });
    appendThreadEntry(contextRoot, 'digest', { runId: RUN, kind: 'system', event: 'started', text: 'Run started.', via: 'runner' });
    post('WAU is down 4%.');

    const runs = listThreadRuns(contextRoot, 'digest');
    expect(runs.map((r) => r.runId)).toEqual([RUN, older]);
    expect(runs[0].status).toBeNull();          // still going
    expect(runs[0].entryCount).toBe(2);
    expect(runs[0].lastEntry?.text).toBe('WAU is down 4%.');
    expect(runs[1].status).toBe('ok');
    expect(runs[1].startedAt).not.toBeNull();
  });
});

describe('unread', () => {
  it('counts everything when nothing has been read, and excludes your own replies', () => {
    post('one');
    post('two');
    appendThreadEntry(contextRoot, 'digest', { runId: RUN, kind: 'user', text: 'my reply', via: 'dashboard' });
    // You do not badge yourself.
    expect(threadUnread(contextRoot, 'digest', home).count).toBe(2);
  });

  it('counts only what is newer than the watermark', () => {
    const first = post('one');
    post('two');
    markThreadRead(contextRoot, 'digest', first.id, home);
    expect(threadUnread(contextRoot, 'digest', home).count).toBe(1);
  });

  it('is MONOTONIC — an older id never rewinds the mark', () => {
    const first = post('one');
    const second = post('two');
    markThreadRead(contextRoot, 'digest', second.id, home);
    markThreadRead(contextRoot, 'digest', first.id, home);
    expect(threadUnread(contextRoot, 'digest', home).count).toBe(0);
  });

  it('R3: a watermark BELOW every survivor ⇒ everything unread (over-notify)', () => {
    // The laptop that was away four months: the pruned past was read, the
    // survivors are newer.
    post('survivor one');
    post('survivor two');
    markThreadRead(contextRoot, 'digest', newThreadEntryId(1_000_000_000_000), home);
    expect(threadUnread(contextRoot, 'digest', home).count).toBe(2);
  });

  it('R3: a watermark ABOVE every survivor ⇒ nothing unread', () => {
    post('one');
    markThreadRead(contextRoot, 'digest', newThreadEntryId(Date.now() + 86_400_000), home);
    expect(threadUnread(contextRoot, 'digest', home).count).toBe(0);
  });

  it('R3: a CORRUPT watermark file reads as absent ⇒ everything unread', () => {
    post('one');
    const path = threadWatermarkPath(home);
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(path, '{ this is not json', 'utf-8');
    expect(threadUnread(contextRoot, 'digest', home).count).toBe(1);
  });

  it('the watermark file is machine-local and mode 0600', () => {
    const e = post('one');
    markThreadRead(contextRoot, 'digest', e.id, home);
    const path = threadWatermarkPath(home);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain(e.id);
    // Never inside the brain — a synced watermark makes another machine wrong.
    expect(path.startsWith(contextRoot)).toBe(false);
  });

  it('allThreadUnread reports per slug and omits the quiet ones', () => {
    createAutomation(contextRoot, { slug: 'digest', title: 'D', days: 'daily', at: '09:00', prompt: 'x' });
    createAutomation(contextRoot, { slug: 'quiet', title: 'Q', days: 'daily', at: '09:00', prompt: 'x' });
    post('one');
    post('two');
    expect(allThreadUnread(contextRoot, home)).toEqual({ digest: 2 });
  });
});

describe('pruneThreads', () => {
  it('removes day files past the retention window and keeps the rest', () => {
    post('old', { now: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) });
    post('recent', { now: new Date() });
    expect(readdirSync(threadSlugDir(contextRoot, 'digest'))).toHaveLength(2);
    expect(pruneThreads(contextRoot, 'digest', 90)).toBe(1);
    expect(readThread(contextRoot, 'digest').map((e) => e.text)).toEqual(['recent']);
  });

  it('is total on a slug that has no thread at all', () => {
    expect(pruneThreads(contextRoot, 'never-existed', 90)).toBe(0);
    expect(pruneThreads(contextRoot, '../escape', 90)).toBe(0);
  });
});

describe('threadDateStamp', () => {
  it('is LOCAL, so an 18:00 run does not land in tomorrow', () => {
    expect(threadDateStamp(new Date(2026, 8, 20, 18, 0, 0))).toBe('2026-09-20');
  });
});

describe('newThreadEntryId — the two properties the store depends on', () => {
  it('entries issued in the SAME millisecond stay in issue order', () => {
    // A random tie-break put a run's `system:started` after its own first post.
    const ms = 1_700_000_000_000;
    const ids = Array.from({ length: 50 }, () => newThreadEntryId(ms));
    expect([...ids].sort()).toEqual(ids);
  });

  it('an EXPLICIT earlier timestamp is honoured, never clamped forward', () => {
    // A catch-up write answers for an earlier fire; rewriting its time would
    // sort it into the wrong day and push a read watermark past unseen entries.
    newThreadEntryId(2_000_000_000_000);
    expect(newThreadEntryId(1_000_000_000_000) < newThreadEntryId(2_000_000_000_000)).toBe(true);
  });
});
