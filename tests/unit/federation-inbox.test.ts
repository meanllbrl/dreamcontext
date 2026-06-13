import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  DIGEST_SCHEMA_VERSION,
  consumeEntry,
  consumedDir,
  drainInbox,
  inboxDir,
  inboxFilename,
  pendingInboxCount,
  writeInboxEntry,
  type DigestEntry,
} from '../../src/lib/federation-inbox.js';

const execFileAsync = promisify(execFile);

/** Absolute path to the vite-node binary bundled with this project. */
const VITE_NODE = resolve('node_modules/.bin/vite-node');

/** Absolute path to the child-writer helper script. */
const CHILD_WRITER = resolve('tests/helpers/federation-inbox-child-writer.ts');

function makeContextRoot(): string {
  const root = join(
    tmpdir(),
    `dc-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    '_dream_context',
  );
  mkdirSync(root, { recursive: true });
  return root;
}

/** Build a minimal, valid DigestEntry for the given origin + entryId. */
function makeEntry(vault: string, entryId: string, version = DIGEST_SCHEMA_VERSION): DigestEntry {
  return {
    version,
    id: `${vault}:${entryId}`,
    origin: { vault, entryId, sourceTimestamp: '2026-06-12' },
    kind: 'knowledge',
    title: `Entry ${entryId}`,
    summary: `Summary for ${entryId}`,
    recallScore: 1,
    links: [`knowledge/${entryId}.md`],
  };
}

describe('federation-inbox', () => {
  let contextRoot: string;

  beforeEach(() => {
    contextRoot = makeContextRoot();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    rmSync(join(contextRoot, '..'), { recursive: true, force: true });
  });

  it('writeInboxEntry dedups by filename: a second write of the same origin/entryId → written:false', () => {
    const entry = makeEntry('alpha', 'k1');
    const first = writeInboxEntry(contextRoot, entry);
    expect(first.written).toBe(true);
    expect(first.path).not.toBeNull();

    // Second write of the SAME (origin, entryId) targets the same file → skipped.
    const second = writeInboxEntry(contextRoot, { ...entry, summary: 'changed body' });
    expect(second.written).toBe(false);
    expect(second.path).toBe(first.path);

    // The original content is untouched (dedup did not overwrite).
    const onDisk = JSON.parse(readFileSync(first.path as string, 'utf-8')) as DigestEntry;
    expect(onDisk.summary).toBe('Summary for k1');
  });

  it(
    'two OS processes writing distinct entries into the same inbox concurrently → all entries present and uncorrupted',
    async () => {
      // Spawn PROCESS_COUNT child Node processes via vite-node so each runs the
      // REAL TypeScript writeInboxEntry in a separate OS process, all targeting the
      // same inbox directory at the same time.  This validates the "two vaults
      // sleeping concurrently, both writing a third's inbox" invariant from #25.
      const PROCESS_COUNT = 4;
      const ENTRIES_PER_PROCESS = 10;
      const TOTAL = PROCESS_COUNT * ENTRIES_PER_PROCESS;

      // Each child gets its own vault name and a non-overlapping entry index range
      // so all TOTAL filenames are distinct (concurrency stress, no dedup).
      const childArgs = Array.from({ length: PROCESS_COUNT }, (_, p) => ({
        vault: `vault${p}`,
        startIndex: p * ENTRIES_PER_PROCESS,
        count: ENTRIES_PER_PROCESS,
      }));

      // Launch all child processes simultaneously.
      await Promise.all(
        childArgs.map(({ vault, startIndex, count }) =>
          execFileAsync(VITE_NODE, [
            CHILD_WRITER,
            contextRoot,
            vault,
            String(startIndex),
            String(count),
          ]),
        ),
      );

      // Assert: every expected file is present and contains valid JSON with the correct id.
      for (const { vault, startIndex, count } of childArgs) {
        for (let i = startIndex; i < startIndex + count; i++) {
          const entryId = `k${i}`;
          const filePath = join(inboxDir(contextRoot), inboxFilename(vault, entryId));
          expect(existsSync(filePath), `missing file for ${vault}:${entryId}`).toBe(true);
          const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as DigestEntry;
          expect(parsed.id).toBe(`${vault}:${entryId}`);
          expect(parsed.origin.vault).toBe(vault);
          expect(parsed.origin.entryId).toBe(entryId);
        }
      }

      // Total file count must equal total entries — no lost, no duplicated files.
      expect(pendingInboxCount(contextRoot)).toBe(TOTAL);
    },
    30_000, // generous timeout: vite-node startup per process
  );

  it('drainInbox quarantines an entry whose major version exceeds the reader, leaving the file in place', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const future = makeEntry('alpha', 'future', DIGEST_SCHEMA_VERSION + 1);
    const write = writeInboxEntry(contextRoot, future);
    expect(write.written).toBe(true);

    const { entries, quarantined } = drainInbox(contextRoot);
    expect(entries).toHaveLength(0);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].version).toBe(DIGEST_SCHEMA_VERSION + 1);
    // The quarantined file is LEFT IN PLACE (never applied, never moved).
    expect(existsSync(write.path as string)).toBe(true);
  });

  it('drainInbox skips malformed JSON without crashing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mkdirSync(inboxDir(contextRoot), { recursive: true });
    writeFileSync(join(inboxDir(contextRoot), 'broken.json'), '{ not valid json', 'utf-8');
    // A valid entry alongside the broken one is still drained.
    writeInboxEntry(contextRoot, makeEntry('alpha', 'good'));

    const { entries, quarantined } = drainInbox(contextRoot);
    expect(quarantined).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].entry.origin.entryId).toBe('good');
  });

  it('consumeEntry moves the file from the inbox root into consumed/', () => {
    const entry = makeEntry('alpha', 'k1');
    writeInboxEntry(contextRoot, entry);
    const filename = inboxFilename('alpha', 'k1');

    consumeEntry(contextRoot, filename);

    expect(existsSync(join(inboxDir(contextRoot), filename))).toBe(false);
    expect(existsSync(join(consumedDir(contextRoot), filename))).toBe(true);
    // A consumed entry is not re-drained.
    expect(drainInbox(contextRoot).entries).toHaveLength(0);
  });

  it('pendingInboxCount returns 0 when the inbox directory is absent', () => {
    expect(existsSync(inboxDir(contextRoot))).toBe(false);
    expect(pendingInboxCount(contextRoot)).toBe(0);
  });

  it('a malicious origin/entryId containing "../" cannot escape the inbox directory', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const malicious = makeEntry('../../etc', '../../../passwd');

    const result = writeInboxEntry(contextRoot, malicious);

    // The write either lands strictly inside the inbox dir, or is refused — never
    // escapes. The sanitiser collapses `..` so the file should land inside.
    const base = inboxDir(contextRoot);
    if (result.written) {
      expect(result.path).not.toBeNull();
      expect((result.path as string).startsWith(base)).toBe(true);
    } else {
      expect(result.path).toBeNull();
    }
    // Nothing was written outside the context root.
    expect(existsSync(join(contextRoot, '..', '..', 'passwd'))).toBe(false);
    expect(existsSync(join(contextRoot, '..', '..', 'etc'))).toBe(false);
  });
});
