import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBuildFingerprint } from '../../src/server/cloud-fingerprint.js';
import { CloudStateStore, parseTripRecord } from '../../src/server/cloud-state.js';
import { seamRefusal } from '../../src/cli/commands/cloud.js';
// @ts-expect-error: a plain .mjs script (copied verbatim into the private repo), no types.
import { computeFingerprint, validMirrorPath } from '../../cloud/supervisor.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cloud-sup-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('build fingerprint (AC18)', () => {
  it('the root supervisor and the server compute the same pinned hash', () => {
    mkdirSync(join(dir, 'dist', 'dashboard', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.js'), 'console.log(1)\n');
    writeFileSync(join(dir, 'dist', 'dashboard', 'index.html'), '<html></html>');
    writeFileSync(join(dir, 'dist', 'dashboard', 'assets', 'a.js'), 'x');
    symlinkSync('index.js', join(dir, 'dist', 'link.js')); // skipped by both
    writeFileSync(join(dir, 'package.json'), '{}'); // outside dist: not part of the build
    const ts = computeBuildFingerprint(dir);
    expect(ts).toMatch(/^[0-9a-f]{64}$/);
    expect(computeFingerprint(dir)).toBe(ts);
    writeFileSync(join(dir, 'dist', 'dashboard', 'assets', 'a.js'), 'y');
    expect(computeBuildFingerprint(dir)).not.toBe(ts);
    expect(computeFingerprint(dir)).toBe(computeBuildFingerprint(dir));
  });

  it('no dist, no fingerprint', () => {
    expect(computeBuildFingerprint(dir)).toBeNull();
    expect(computeFingerprint(dir)).toBeNull();
  });
});

describe('mirror path the supervisor mounts on', () => {
  it('accepts only a plain home path', () => {
    expect(validMirrorPath('/Users/someone')).toBe(true);
    expect(validMirrorPath('/home/someone')).toBe(true);
    for (const bad of ['/etc', '/Users/../etc', '/Users/a/b', '/Users/', 'Users/a', '/opt/x', '/Users/a;b', 42]) {
      expect(validMirrorPath(bad)).toBe(false);
    }
  });
});

describe('test seams', () => {
  it('are refused inside a codespace and as root', () => {
    expect(seamRefusal({ CODESPACES: 'true' }, 1000)).toMatch(/codespace/);
    expect(seamRefusal({}, 0)).toMatch(/root/);
    expect(seamRefusal({}, 501)).toBeNull();
  });
});

describe('cloud trip state', () => {
  it('a missing or corrupt record reads as sealed (fail closed)', () => {
    expect(parseTripRecord(null).phase).toBe('sealed');
    expect(parseTripRecord({ phase: 'open' }).phase).toBe('sealed');
    writeFileSync(join(dir, 'cloud-trip.json'), '{not json');
    expect(new CloudStateStore({ dir }).phase()).toBe('sealed');
  });

  it('persists every transition before it takes effect', () => {
    const a = new CloudStateStore({ dir, now: () => 1000 });
    expect(a.startTrip({ tripId: 't1', laptopId: 'l1', go: {}, rootIds: [], takeOver: false }).ok).toBe(true);
    expect(a.activate('t1').ok).toBe(true);
    const q = a.quiesce('t1');
    expect(q.ok && q.epoch).toBe(1);
    const b = new CloudStateStore({ dir });
    expect(b.phase()).toBe('quiescing');
    expect(b.epochMatches(1)).toBe(true);
    expect(b.epochMatches(0)).toBe(false);
  });
});
