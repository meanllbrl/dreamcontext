/**
 * Full Disk Access probe (src/lib/full-disk-access.ts): the only grant macOS keeps for the app's
 * children reading other apps' data. Read from the TCC database's readability, never changed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FULL_DISK_PANE, hasFullDiskAccess } from '../../src/lib/full-disk-access.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';

let home = '';
const homes: string[] = [];
const tccDb = (h: string) => join(h, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
const fakeHome = (mode: number | null): string => {
  home = mkdtempSync(join(tmpdir(), 'dc-fda-'));
  homes.push(home);
  if (mode === null) return home;
  mkdirSync(join(home, 'Library', 'Application Support', 'com.apple.TCC'), { recursive: true });
  writeFileSync(tccDb(home), 'x');
  chmodSync(tccDb(home), mode);
  return home;
};
afterEach(() => {
  for (const h of homes.splice(0)) {
    try { chmodSync(tccDb(h), 0o600); } catch { /* none */ }
    rmSync(h, { recursive: true, force: true });
  }
});

describe('Full Disk Access probe', () => {
  it('reads on when the TCC database opens', () => {
    expect(hasFullDiskAccess(fakeHome(0o600), 'darwin')).toBe(true);
  });
  it.skipIf(process.getuid?.() === 0)('reads off when macOS refuses the database', () => {
    expect(hasFullDiskAccess(fakeHome(0o000), 'darwin')).toBe(false);
  });
  it('cannot tell without the database, and is off the table elsewhere', () => {
    expect(hasFullDiskAccess(fakeHome(null), 'darwin')).toBeNull();
    expect(hasFullDiskAccess(fakeHome(0o600), 'linux')).toBeNull();
    expect(hasFullDiskAccess(home, 'win32')).toBeNull();
  });
  it('opens the Full Disk Access pane, and only the Mac itself may ask', () => {
    expect(FULL_DISK_PANE).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    expect(ROUTE_POLICY['POST /api/agent/open-full-disk-access']?.allow).toBe(false);
  });
});
