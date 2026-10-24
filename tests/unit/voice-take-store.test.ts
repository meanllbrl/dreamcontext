/**
 * The take store (task sesli-giris-bozuk…, AC9): random refs, no path from a malformed ref,
 * 24 h / 200 MB retention, 0700/0600, and bind-once.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, readdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  keepTake, findTake, bindTake, latestTakeOf, pruneTakes, takesDir, contextTakes, TAKE_MAX_BYTES,
} from '../../src/lib/voice/voiceLog.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-takes-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const rec = (over: Record<string, unknown> = {}) => ({ contextRoot: '/vault/a', quality: 'clean' as const, language: 'tr', chars: 5, ...over });

describe('refs', () => {
  it('are random 128-bit refs that never collide', () => {
    const refs = new Set(Array.from({ length: 50 }, () => keepTake(Buffer.from('x'), rec(), home)));
    expect(refs.size).toBe(50);
    for (const r of refs) expect(r).toMatch(/^vt_[0-9a-f]{32}$/);
  });

  it('a malformed ref joins no path', () => {
    keepTake(Buffer.from('x'), rec(), home);
    for (const bad of ['../../etc/passwd', 'vt_../x', 'vt_' + 'g'.repeat(32), 'vt_' + 'a'.repeat(31), 42, null]) {
      expect(findTake(bad, home), String(bad)).toBeNull();
    }
  });

  it('stores only trusted fields, re-validated on read', () => {
    const ref = keepTake(Buffer.from('x'), rec({ language: 'Turkish', conv: '../evil', primary: 'nope' }), home)!;
    const t = findTake(ref, home)!;
    expect(t.language).toBe('tr');
    expect(t.primary).toBeNull();
    expect(t.conv).toBeUndefined();
    const file = join(takesDir(home), `${ref}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), quality: 'excellent' }));
    expect(findTake(ref, home)).toBeNull();
  });
});

describe('permissions', () => {
  it('an existing 0755 directory becomes 0700; files are 0600', () => {
    mkdirSync(takesDir(home), { recursive: true, mode: 0o755 });
    const ref = keepTake(Buffer.from('x'), rec(), home)!;
    expect(statSync(takesDir(home)).mode & 0o777).toBe(0o700);
    expect(statSync(join(takesDir(home), `${ref}.wav`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(takesDir(home), `${ref}.json`)).mode & 0o777).toBe(0o600);
  });
});

describe('retention', () => {
  it('drops takes older than 24 h (old-format ones too), keeps the rest', () => {
    const now = Date.now();
    const fresh = keepTake(Buffer.from('x'), rec(), home, now)!;
    const dir = takesDir(home);
    writeFileSync(join(dir, '2026-10-24T18-07-02-130Z.wav'), 'old');
    writeFileSync(join(dir, '2026-10-24T18-07-02-130Z.json'), '{}');
    const past = (now - 25 * 3600_000) / 1000;
    utimesSync(join(dir, '2026-10-24T18-07-02-130Z.wav'), past, past);
    utimesSync(join(dir, '2026-10-24T18-07-02-130Z.json'), past, past);
    pruneTakes(home, now);
    expect(readdirSync(dir).sort()).toEqual([`${fresh}.json`, `${fresh}.wav`]);
  });

  it('past the ceiling (200 MB; scaled down here) the oldest go first', () => {
    const dir = takesDir(home);
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const chunk = Buffer.alloc(70 * 1024);
    for (const [i, name] of ['a', 'b', 'c', 'd'].entries()) {
      writeFileSync(join(dir, `${name}.wav`), chunk);
      const t = (now - (4 - i) * 60_000) / 1000;
      utimesSync(join(dir, `${name}.wav`), t, t);
    }
    pruneTakes(home, now, 200 * 1024);
    expect(readdirSync(dir).sort()).toEqual(['c.wav', 'd.wav']);
    expect(TAKE_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe('bind', () => {
  it('binds once, same vault, within 10 minutes; garbled takes never bind', () => {
    const now = Date.now();
    const ref = keepTake(Buffer.from('x'), rec(), home, now)!;
    expect(bindTake(ref, 's1', '/vault/other', home, now)).toBeNull();
    expect(bindTake(ref, 's1', '/vault/a', home, now)?.session).toBe('s1');
    expect(bindTake(ref, 's2', '/vault/a', home, now)).toBeNull();
    const stale = keepTake(Buffer.from('x'), rec(), home, now - 11 * 60_000)!;
    expect(bindTake(stale, 's1', '/vault/a', home, now)).toBeNull();
    const bad = keepTake(Buffer.from('x'), rec({ quality: 'garbled' }), home, now)!;
    expect(bindTake(bad, 's1', '/vault/a', home, now)).toBeNull();
    expect(latestTakeOf('s1', '/vault/a', home)?.ref).toBe(ref);
    expect(latestTakeOf('s1', '/vault/other', home)).toBeNull();
  });

  it('feeds the language context with what it stored', () => {
    keepTake(Buffer.from('x'), rec({ conv: 'c1' }), home);
    expect(contextTakes(home)[0]).toMatchObject({ language: 'tr', quality: 'clean', conv: 'c1' });
  });
});
