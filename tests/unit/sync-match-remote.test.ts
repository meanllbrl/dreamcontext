import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SyncLedger,
  matchLocalTaskForRemote,
  type LocalTaskDescriptor,
  type TaskMapEntry,
} from '../../src/lib/task-backend/sync-state.js';

/**
 * Scope C's pure matching primitive (owned by Task B): re-link an incoming
 * remote task to an existing local mirror when the committed map lost the
 * entry, instead of the pull path minting a fresh `-N` duplicate (#204).
 */

let contextRoot: string;

beforeEach(() => {
  const raw = join(tmpdir(), `dc-match-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  contextRoot = realpathSync(raw);
});

afterEach(() => {
  rmSync(contextRoot, { recursive: true, force: true });
});

function mapEntry(overrides: Partial<TaskMapEntry>): TaskMapEntry {
  return { slug: 'foo', dcId: 'task_D1', backend: 'clickup', remoteId: 'R1', ...overrides };
}

function local(overrides: Partial<LocalTaskDescriptor>): LocalTaskDescriptor {
  return { slug: 'foo', dcId: 'task_D1', name: 'Fix login', ...overrides };
}

describe('matchLocalTaskForRemote', () => {
  it('matches an unmapped local mirror by exact folded name', () => {
    const ledger = new SyncLedger(contextRoot); // empty map
    const live = [local({ slug: 'fix-login', name: 'Fix login' })];
    const match = matchLocalTaskForRemote(ledger, live, { remoteId: 'R1', name: 'Fix login' });
    expect(match).toEqual(live[0]);
  });

  it('returns null when no local task has a matching name', () => {
    const ledger = new SyncLedger(contextRoot);
    const live = [local({ slug: 'fix-login', name: 'Fix login' })];
    const match = matchLocalTaskForRemote(ledger, live, { remoteId: 'R1', name: 'Totally different task' });
    expect(match).toBeNull();
  });

  it('folds diacritics/case for the name comparison (Turkish dotless i, etc.)', () => {
    const ledger = new SyncLedger(contextRoot);
    const live = [local({ slug: 'fix-login', name: 'FIX LOGİN' })];
    const match = matchLocalTaskForRemote(ledger, live, { remoteId: 'R1', name: 'fix login' });
    expect(match).toEqual(live[0]);
  });

  it('refuses (returns null) a candidate slug already claimed by a DIFFERENT remoteId — genuine name collision', () => {
    const ledger = new SyncLedger(contextRoot);
    ledger.recordMapping(mapEntry({ slug: 'fix-login', dcId: 'task_OTHER', remoteId: 'R_OTHER' }));
    const live = [local({ slug: 'fix-login', name: 'Fix login' })];
    const match = matchLocalTaskForRemote(ledger, live, { remoteId: 'R1', name: 'Fix login' });
    expect(match).toBeNull();
  });

  it('still matches when the candidate slug is mapped to the SAME remoteId (not a foreign claim)', () => {
    const ledger = new SyncLedger(contextRoot);
    ledger.recordMapping(mapEntry({ slug: 'fix-login', dcId: 'task_D1', remoteId: 'R1' }));
    const live = [local({ slug: 'fix-login', name: 'Fix login' })];
    const match = matchLocalTaskForRemote(ledger, live, { remoteId: 'R1', name: 'Fix login' });
    expect(match).toEqual(live[0]);
  });

  it('is deterministic on ties: picks the lexicographically-smallest candidate slug', () => {
    const ledger = new SyncLedger(contextRoot);
    const live = [
      local({ slug: 'fix-login-2', name: 'Fix login' }),
      local({ slug: 'fix-login', name: 'Fix login' }),
      local({ slug: 'fix-login-3', name: 'Fix login' }),
    ];
    const match = matchLocalTaskForRemote(ledger, live, { remoteId: 'R1', name: 'Fix login' });
    expect(match?.slug).toBe('fix-login');
  });

  it('skips a same-named candidate claimed elsewhere but still finds an unclaimed one', () => {
    const ledger = new SyncLedger(contextRoot);
    ledger.recordMapping(mapEntry({ slug: 'fix-login', dcId: 'task_OTHER', remoteId: 'R_OTHER' }));
    const live = [
      local({ slug: 'fix-login', name: 'Fix login' }),
      local({ slug: 'fix-login-2', name: 'Fix login' }),
    ];
    const match = matchLocalTaskForRemote(ledger, live, { remoteId: 'R1', name: 'Fix login' });
    expect(match?.slug).toBe('fix-login-2');
  });

  it('returns null against an empty local task list', () => {
    const ledger = new SyncLedger(contextRoot);
    expect(matchLocalTaskForRemote(ledger, [], { remoteId: 'R1', name: 'Anything' })).toBeNull();
  });
});
