// Laptop trip state + the PINNED lock API (handsfreeLockFor / isAway) wave 2 lane F
// consumes. Every test injects its own HOME; the developer's ~/.dreamcontext is never read.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TripStateError, beginGoing, handsfreeDir, handsfreeLockFor, isAway, lastGoodPath, readTripState, setPhase, statePath, updateTripState,
} from '../../src/lib/handsfree/trip-state.js';

let home: string;
let root: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hf-trip-'));
  root = join(home, 'projects', 'app');
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('trip state', () => {
  it('defaults to home and lives under the injected HOME', () => {
    expect(readTripState(home).phase).toBe('home');
    expect(isAway(home)).toBe(false);
    expect(handsfreeLockFor(root, home)).toBeNull();
    expect(handsfreeDir(home)).toBe(join(home, '.dreamcontext', 'handsfree'));
  });

  it('home → going locks the roots first; away/returning stay locked; home unlocks', async () => {
    await beginGoing('t1', [{ rootId: 'r-a', path: root }], home);
    expect(existsSync(statePath(home))).toBe(true);
    expect(isAway(home)).toBe(true);
    expect(handsfreeLockFor(root, home)).toMatchObject({ tripId: 't1', phase: 'going', rootId: 'r-a' });
    expect(handsfreeLockFor(join(root, 'src', 'not-yet-created.ts'), home)).not.toBeNull();
    expect(handsfreeLockFor(join(home, 'projects', 'other'), home)).toBeNull();
    expect(handsfreeLockFor(join(home, 'projects', 'app-sibling'), home)).toBeNull();
    await setPhase('away', 't1', home);
    await setPhase('returning', 't1', home);
    expect(handsfreeLockFor(root, home)?.phase).toBe('returning');
    await setPhase('home', 't1', home);
    expect(isAway(home)).toBe(false);
    expect(readTripState(home)).toMatchObject({ phase: 'home', tripId: null, roots: [] });
  });

  it('a symlink into a locked root is locked; on case-insensitive macOS so is another spelling', async () => {
    await beginGoing('t1', [{ rootId: 'r-a', path: root }], home);
    symlinkSync(root, join(home, 'alias'));
    expect(handsfreeLockFor(join(home, 'alias', 'x'), home)).not.toBeNull();
    if (process.platform === 'darwin') expect(handsfreeLockFor(join(home, 'Projects', 'APP'), home)).not.toBeNull();
  });

  it('refuses illegal transitions and a second trip', async () => {
    await expect(updateTripState((s) => ({ ...s, phase: 'away', tripId: 't1' }), { home })).rejects.toThrow(TripStateError);
    await beginGoing('t1', [{ rootId: 'r-a', path: root }], home);
    await expect(beginGoing('t2', [], home)).rejects.toThrow(/while going/);
    await expect(setPhase('away', 't2', home)).rejects.toThrow(/mismatch/);
    await expect(setPhase('returning', 't1', home)).rejects.toThrow(/illegal/);
  });

  it('a corrupt state file falls back to the last-good copy (still away, still locked)', async () => {
    await beginGoing('t1', [{ rootId: 'r-a', path: root }], home);
    await setPhase('away', 't1', home);
    writeFileSync(statePath(home), '{torn');
    expect(readTripState(home)).toMatchObject({ phase: 'away', tripId: 't1' });
    expect(isAway(home)).toBe(true);
    expect(handsfreeLockFor(root, home)).toMatchObject({ tripId: 't1', rootId: 'r-a' });
    expect(handsfreeLockFor(join(home, 'elsewhere'), home)).toBeNull();
  });

  it('fails CLOSED when the state file exists but neither copy is readable: every path locked, the file named', async () => {
    mkdirSync(handsfreeDir(home), { recursive: true });
    writeFileSync(statePath(home), '{not json');
    expect(isAway(home)).toBe(true);
    const lock = handsfreeLockFor(join(home, 'anything', 'at', 'all'), home)!;
    expect(lock).not.toBeNull();
    expect(lock.error).toContain(statePath(home));
    expect(readTripState(home).unreadable).toContain(statePath(home));
    await expect(beginGoing('t2', [], home)).rejects.toThrow(/unreadable/);
    // Repair: delete the file -> absent -> home.
    rmSync(statePath(home));
    expect(isAway(home)).toBe(false);
    expect(existsSync(lastGoodPath(home))).toBe(false);
  });

  it('an absent state file is home; every successful update also writes the last-good copy', async () => {
    expect(readTripState(home).phase).toBe('home');
    await beginGoing('t1', [{ rootId: 'r-a', path: root }], home);
    expect(JSON.parse(readFileSync(lastGoodPath(home), 'utf8'))).toMatchObject({ phase: 'going', tripId: 't1' });
  });
});
