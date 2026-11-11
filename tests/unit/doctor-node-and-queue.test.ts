import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDoctorReport, checkNodeVersion, checkTaskSyncQueue } from '../../src/cli/commands/doctor.js';
import { TASKS_QUEUE_REL } from '../../src/lib/task-backend/paths.js';

describe('checkNodeVersion', () => {
  it('warns below the floor and says what it costs', () => {
    const r = checkNodeVersion('20.19.0', '/x/node');
    expect(r.status).toBe('warn');
    expect(r.code).toBe('doctor/node-below-floor');
    expect(r.message).toContain('110 ms');
    expect(r.message).toContain('compile cache');
    expect(r.message).toContain('22.16');
  });
  it('is ok at and above the floor', () => {
    expect(checkNodeVersion('22.16.0').status).toBe('ok');
    expect(checkNodeVersion('23.7.0').status).toBe('ok');
    expect(checkNodeVersion('22.15.9').status).toBe('warn');
  });
});

describe('checkTaskSyncQueue', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-queue-')); mkdirSync(join(root, 'state'), { recursive: true }); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 10, 12);
  const write = (ops: unknown[]) => writeFileSync(join(root, TASKS_QUEUE_REL), JSON.stringify(ops));

  it('says nothing for an empty or missing queue', () => {
    expect(checkTaskSyncQueue(root, now)).toEqual([]);
    write([]);
    expect(checkTaskSyncQueue(root, now)).toEqual([]);
  });
  it('is info for a fresh queue', () => {
    write([{ id: 'a', kind: 'push', slug: 's1', ts: now - 3600_000 }]);
    const [r] = checkTaskSyncQueue(root, now);
    expect(r.status).toBe('info');
    expect(r.evidence).toMatchObject({ ops: 1, tasks: 1 });
  });
  it('warns with depth and age for a stuck queue', () => {
    write([
      { id: 'a', kind: 'push', slug: 's1', ts: now - 40 * 86_400_000 },
      { id: 'b', kind: 'create', slug: 's2', ts: now - 1000 },
    ]);
    const [r] = checkTaskSyncQueue(root, now);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('2 op(s) on 2 task(s)');
    expect(r.message).toContain('40 days');
    expect(r.supportedFixes?.length).toBe(1);
  });
});

describe('buildDoctorReport', () => {
  it('counts info separately from warnings', () => {
    const rep = buildDoctorReport([
      { name: 'a', status: 'ok', message: '' }, { name: 'b', status: 'info', message: '' }, { name: 'c', status: 'warn', message: '' },
    ]);
    expect(rep.summary).toEqual({ ok: 1, info: 1, warn: 1, error: 0 });
  });
});

describe('checkTaskSyncQueue — hand-corrupted file', () => {
  it('ignores non-object entries instead of crashing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-queue-'));
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, TASKS_QUEUE_REL), JSON.stringify([null, 3, { id: 'a', kind: 'push', slug: 's', ts: 1 }]));
    expect(checkTaskSyncQueue(root, Date.UTC(2026, 10, 12))[0].evidence).toMatchObject({ ops: 1 });
    rmSync(root, { recursive: true, force: true });
  });
});
