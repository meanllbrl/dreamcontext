import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readLedger,
  writeLedger,
  appendLedger,
  isApplied,
  type LedgerEntry,
} from '../../src/lib/migration-ledger.js';

describe('migration-ledger', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-ledger-'));
    mkdirSync(join(root, 'state'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('readLedger returns [] when file is missing', () => {
    expect(readLedger(root)).toEqual([]);
  });

  it('readLedger returns [] on malformed JSON', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'state', '.migrations.json'), 'not-json', 'utf-8');
    expect(readLedger(root)).toEqual([]);
  });

  it('readLedger returns [] when file contains a non-array', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(root, 'state', '.migrations.json'),
      JSON.stringify({ version: '0.7.0' }),
      'utf-8',
    );
    expect(readLedger(root)).toEqual([]);
  });

  it('writeLedger + readLedger round-trips correctly', () => {
    const entry: LedgerEntry = {
      version: '0.7.0',
      step: 'move-data-structures',
      executor: 'code',
      timestamp: '2026-06-11T00:00:00.000Z',
      filesTouched: ['knowledge/data-structures/default.md'],
      summary: 'Moved default',
    };
    writeLedger(root, [entry]);
    const result = readLedger(root);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject(entry);
  });

  it('ledger entry carries version, step, executor, timestamp, filesTouched, summary', () => {
    const entry: LedgerEntry = {
      version: '0.7.0',
      step: 'fence-data-structures',
      executor: 'detected',
      timestamp: new Date().toISOString(),
      filesTouched: [],
      summary: 'Already fenced',
    };
    writeLedger(root, [entry]);
    const result = readLedger(root);
    expect(result[0]).toHaveProperty('version', '0.7.0');
    expect(result[0]).toHaveProperty('step', 'fence-data-structures');
    expect(result[0]).toHaveProperty('executor', 'detected');
    expect(result[0]).toHaveProperty('timestamp');
    expect(result[0]).toHaveProperty('filesTouched');
    expect(result[0]).toHaveProperty('summary');
  });

  it('appendLedger adds entries cumulatively', () => {
    const e1: LedgerEntry = {
      version: '0.7.0',
      step: 'move-data-structures',
      executor: 'code',
      timestamp: new Date().toISOString(),
      filesTouched: [],
      summary: 'step 1',
    };
    const e2: LedgerEntry = {
      version: '0.7.0',
      step: 'fence-data-structures',
      executor: 'detected',
      timestamp: new Date().toISOString(),
      filesTouched: [],
      summary: 'step 2',
    };
    appendLedger(root, e1);
    appendLedger(root, e2);
    const result = readLedger(root);
    expect(result).toHaveLength(2);
  });

  it('writeLedger writes atomically (tmp file removed after write)', () => {
    writeLedger(root, []);
    const tmp = join(root, 'state', '.migrations.json.tmp');
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(join(root, 'state', '.migrations.json'))).toBe(true);
  });

  it('isApplied returns true for matching version+step', () => {
    const ledger: LedgerEntry[] = [
      {
        version: '0.7.0',
        step: 'move-data-structures',
        executor: 'code',
        timestamp: '',
        filesTouched: [],
        summary: '',
      },
    ];
    expect(isApplied(ledger, '0.7.0', 'move-data-structures')).toBe(true);
  });

  it('isApplied returns false for non-matching version+step', () => {
    expect(isApplied([], '0.7.0', 'move-data-structures')).toBe(false);
    const ledger: LedgerEntry[] = [
      {
        version: '0.7.0',
        step: 'move-data-structures',
        executor: 'code',
        timestamp: '',
        filesTouched: [],
        summary: '',
      },
    ];
    expect(isApplied(ledger, '0.8.0', 'move-data-structures')).toBe(false);
    expect(isApplied(ledger, '0.7.0', 'fence-data-structures')).toBe(false);
  });
});
