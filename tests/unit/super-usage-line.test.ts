import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEAR_LIMIT_PERCENT, nearLimitLine } from '../../src/lib/super/usage-line.js';

/** C5 (plan iyilesme-360 D11, criterion 10). Synthetic project "acme". */
let dir: string;
let home: string;
let root: string;
const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const RESET = new Date(2026, 10, 23, 3, 0).getTime();

function meter(percent: number, resetsAt = RESET, key: 'weekly' | 'session' = 'weekly', configDir = home): void {
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'claude-account-usage.json'), JSON.stringify({
    accounts: { [configDir]: { limits: [{ key, percent, resetsAt }], fetchedAtMs: NOW - 1000 } },
  }));
}
function superRecord(session: string): void {
  writeFileSync(join(root, 'state', '.super-agent.json'), JSON.stringify({ session, enabled: true }));
}
const line = (ids: string[], configDir?: string) => nearLimitLine({ contextRoot: root, ids, home, now: NOW, ...(configDir ? { configDir } : {}) });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'usage-line-')));
  home = join(dir, 'home');
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state', '.super', 'members'), { recursive: true });
  mkdirSync(home, { recursive: true });
  superRecord('sup-1');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the near-limit line (C5)', () => {
  it('86% on the main Super → one [usage] line naming the window and its reset', () => {
    meter(86);
    expect(line(['sup-1'])).toBe('[usage] weekly 86% · resets 03:00. New non-urgent children wait or start on sonnet; running work continues. Tell him once for this reset.');
  });
  it('84% → none; a reset in the past → none', () => {
    meter(NEAR_LIMIT_PERCENT - 1);
    expect(line(['sup-1'])).toBeNull();
    meter(95, NOW - 60_000);
    expect(line(['sup-1'])).toBeNull();
  });
  it('a member Super, a child and a plain chat → none', () => {
    meter(90);
    writeFileSync(join(root, 'state', '.super', 'members', 'scout.json'), JSON.stringify({ session: 'member-sup' }));
    expect(line(['member-sup'])).toBeNull();
    expect(line(['child-1'])).toBeNull();
    expect(line([''])).toBeNull();
  });
  it('another account folder is read as its own', () => {
    const acct = join(home, 'acct-2');
    meter(92, RESET, 'session', acct);
    expect(line(['sup-1'])).toBeNull();
    expect(line(['sup-1'], acct)).toContain('5-hour 92%');
  });
  it('an unreadable meter → none and no error', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'claude-account-usage.json'), '{not json');
    expect(() => line(['sup-1'])).not.toThrow();
    expect(line(['sup-1'])).toBeNull();
  });
});
