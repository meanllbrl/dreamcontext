import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeConflictReport, readConflictReport, clearConflictReport } from '../../src/lib/git-sync/conflict-report.js';

describe('git-sync/conflict-report', () => {
  let contextRoot: string;

  beforeEach(() => {
    contextRoot = mkdtempSync(join(tmpdir(), 'dc-conflict-report-'));
  });
  afterEach(() => rmSync(contextRoot, { recursive: true, force: true }));

  it('write/read round-trip, with base/ours/theirs snapshot files created', () => {
    writeConflictReport(contextRoot, {
      remoteRef: 'origin/main',
      resolvedByCli: ['core/CHANGELOG.json'],
      deferred: [
        { path: 'knowledge/x.md', class: 'knowledge-md', reason: 'overlap', base: 'BASE', ours: 'OURS', theirs: 'THEIRS' },
      ],
    });

    const report = readConflictReport(contextRoot);
    expect(report).not.toBeNull();
    expect(report!.status).toBe('awaiting-agent');
    expect(report!.resolvedByCli).toEqual(['core/CHANGELOG.json']);
    expect(report!.deferred).toHaveLength(1);

    const entry = report!.deferred[0];
    expect(readFileSync(join(contextRoot, entry.basePath), 'utf-8')).toBe('BASE');
    expect(readFileSync(join(contextRoot, entry.oursPath), 'utf-8')).toBe('OURS');
    expect(readFileSync(join(contextRoot, entry.theirsPath), 'utf-8')).toBe('THEIRS');
  });

  it('readConflictReport returns null when no report exists', () => {
    expect(readConflictReport(contextRoot)).toBeNull();
  });

  it('clearConflictReport removes report.json AND every base/ours/theirs snapshot', () => {
    writeConflictReport(contextRoot, {
      remoteRef: 'origin/main',
      resolvedByCli: [],
      deferred: [
        { path: 'knowledge/x.md', class: 'knowledge-md', reason: 'overlap', base: 'b', ours: 'o', theirs: 't' },
        { path: 'core/features/y.md', class: 'feature-md', reason: 'overlap', base: 'b2', ours: 'o2', theirs: 't2' },
      ],
    });
    const report = readConflictReport(contextRoot)!;
    const snapshotPaths = report.deferred.flatMap((d) => [d.basePath, d.oursPath, d.theirsPath]);
    for (const p of snapshotPaths) expect(existsSync(join(contextRoot, p))).toBe(true);

    clearConflictReport(contextRoot);

    expect(readConflictReport(contextRoot)).toBeNull();
    for (const p of snapshotPaths) expect(existsSync(join(contextRoot, p))).toBe(false);
  });

  it('clearConflictReport is idempotent (no report present)', () => {
    expect(() => clearConflictReport(contextRoot)).not.toThrow();
  });
});
