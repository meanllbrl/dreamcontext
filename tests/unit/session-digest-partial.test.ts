import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeDigest, digestExists, digestIsPartial, loadDigestDocs } from '../../src/lib/session-digest.js';

// PreCompact partial-digest contract: a digest written mid-session (before
// context compaction) is flagged `partial: true` so the SessionStart catch-up
// re-digests the FULL transcript over it — while still being recallable the
// moment compaction ends.

describe('partial (PreCompact) digests', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `digest-partial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flags a partial digest and clears the flag when the full digest overwrites it', () => {
    writeDigest(root, 'sess-1', '## Decisions\n- chose X over Y\n', { partial: true });
    expect(digestExists(root, 'sess-1')).toBe(true);
    expect(digestIsPartial(root, 'sess-1')).toBe(true);

    // SessionStart catch-up writes the full digest over the placeholder.
    writeDigest(root, 'sess-1', '## Decisions\n- chose X over Y\n- post-compaction follow-up\n');
    expect(digestIsPartial(root, 'sess-1')).toBe(false);
  });

  it('a partial digest is indexed into the recall corpus immediately', () => {
    writeDigest(root, 'sess-2', '## Decisions\n- switched the queue to SQS\n', { partial: true });
    const docs = loadDigestDocs(root);
    const doc = docs.find((d) => d.slug === 'digest#sess-2');
    expect(doc).toBeDefined();
    expect(doc!.body).toContain('switched the queue to SQS');
    expect(doc!.capture).toBe(true); // still rank-penalised like any capture
  });

  it('digestIsPartial is false for missing digests', () => {
    expect(digestIsPartial(root, 'nope')).toBe(false);
  });
});
