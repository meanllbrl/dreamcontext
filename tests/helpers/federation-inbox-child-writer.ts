/**
 * Child-process helper used by the cross-process concurrency test in
 * federation-inbox.test.ts. Spawned via vite-node so it runs the REAL
 * TypeScript writeInboxEntry implementation in a separate OS process.
 *
 * argv: <contextRoot> <vault> <startIndex> <count>
 *
 * Writes `count` distinct entries (vault:k<startIndex> … vault:k<startIndex+count-1>)
 * into the given contextRoot's inbox and prints one JSON result per line.
 */
import { writeInboxEntry, DIGEST_SCHEMA_VERSION } from '../../src/lib/federation-inbox.js';
import type { DigestEntry } from '../../src/lib/federation-inbox.js';

const [, , contextRoot, vault, startStr, countStr] = process.argv;
const start = parseInt(startStr, 10);
const count = parseInt(countStr, 10);

for (let i = start; i < start + count; i++) {
  const entryId = `k${i}`;
  const entry: DigestEntry = {
    version: DIGEST_SCHEMA_VERSION,
    id: `${vault}:${entryId}`,
    origin: { vault, entryId, sourceTimestamp: '2026-06-12' },
    kind: 'knowledge',
    title: `Entry ${entryId}`,
    summary: `Summary for ${entryId}`,
    recallScore: 1,
    links: [`knowledge/${entryId}.md`],
  };
  const result = writeInboxEntry(contextRoot, entry);
  process.stdout.write(JSON.stringify({ entryId, ...result }) + '\n');
}
