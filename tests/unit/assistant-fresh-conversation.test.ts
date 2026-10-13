/**
 * After a long idle the Assistant starts a fresh conversation instead of resuming one whose
 * history had grown every turn's context (owner, 2026-10-14). The rule (`startsFresh`) and the
 * server's activity clock (`conversationLastActiveAt`, the transcript's mtime).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRESH_AFTER_IDLE_MS, startsFresh } from '../../dashboard/src/components/assistant/notchModel.js';
import { conversationLastActiveAt } from '../../src/server/routes/assistant.js';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

describe('startsFresh', () => {
  const now = 1_800_000_000_000;
  it('is two hours', () => expect(FRESH_AFTER_IDLE_MS).toBe(2 * 60 * 60 * 1000));
  it('a conversation idle for two hours or more starts fresh; a shorter gap resumes', () => {
    expect(startsFresh(now - FRESH_AFTER_IDLE_MS, now)).toBe(true);
    expect(startsFresh(now - 26 * 60 * 60 * 1000, now)).toBe(true);
    expect(startsFresh(now - FRESH_AFTER_IDLE_MS + 1, now)).toBe(false);
    expect(startsFresh(now - 5 * 60 * 1000, now)).toBe(false);
  });
  it('unknown activity never forces a fresh start', () => {
    expect(startsFresh(null, now)).toBe(false);
    expect(startsFresh(undefined, now)).toBe(false);
    expect(startsFresh(Number.NaN, now)).toBe(false);
  });
});

describe('conversationLastActiveAt', () => {
  it('is the transcript\'s mtime, found in any project dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-fresh-'));
    homes.push(home);
    const dir = join(home, '.claude', 'projects', '-Users-someone--dreamcontext-assistant');
    mkdirSync(dir, { recursive: true });
    const id = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
    writeFileSync(join(dir, `${id}.jsonl`), '{}\n');
    const at = new Date('2026-10-13T08:00:00Z');
    utimesSync(join(dir, `${id}.jsonl`), at, at);
    expect(conversationLastActiveAt(id, home)).toBe(at.getTime());
  });
  it('no conversation, a missing transcript or an unsafe id is unknown (null)', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-fresh-'));
    homes.push(home);
    expect(conversationLastActiveAt(null, home)).toBeNull();
    expect(conversationLastActiveAt('0b1c2d3e-4f50-4617-8899-aabbccddeeff', home)).toBeNull();
    expect(conversationLastActiveAt('../../etc/passwd', home)).toBeNull();
  });
});
