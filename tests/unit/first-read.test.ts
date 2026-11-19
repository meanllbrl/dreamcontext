/**
 * The app's one-time first read (plan ilk-acilis C14, C14a, C16, D12, D13): the per-machine
 * marker, the per-project claim, eligibility, "had files", the derived running state, and the
 * server's copy of the window's canStartClaude.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearPending, firstReadEligible, firstReadLive, firstRunMarkerPath, hadFiles, readFirstReadClaim, readFirstRunMarker,
  recordRegistration, serverCanStartClaude, writeFirstReadClaim, FIRST_READ_PROMPT,
} from '../../src/lib/first-read.js';
import { canStartClaude } from '../../dashboard/src/pages/onboarding/handoffPlan.js';

let dir: string;
let home: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dc-first-read-')));
  home = join(dir, 'home');
  mkdirSync(home);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function folder(name: string, files: Record<string, string> = {}): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  return root;
}
/** A brain the scaffold just made: template core, nothing learned yet ("sparse"). */
function sparseBrain(root: string): void {
  mkdirSync(join(root, '_dream_context', 'core'), { recursive: true });
  mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(root, '_dream_context', 'core', '0.soul.md'), '# {{PROJECT_NAME}}\n');
}

describe('hadFiles (C14a)', () => {
  it('names only: dot entries and _dream_context do not count, a lone README does', () => {
    expect(hadFiles(folder('empty'))).toBe(false);
    expect(hadFiles(folder('dots', { '.gitignore': 'x', '.claude/settings.json': '{}' }))).toBe(false);
    expect(hadFiles(folder('brainonly', { '_dream_context/core/0.soul.md': 'x' }))).toBe(false);
    expect(hadFiles(folder('readme', { README: 'hi' }))).toBe(true);
    expect(hadFiles(join(dir, 'missing'))).toBe(false);
  });

  it('a folder that had files stays "had files" after setup wrote its agent files', () => {
    const root = folder('app', { 'src/index.ts': 'x' });
    const had = hadFiles(root);
    writeFileSync(join(root, 'CLAUDE.md'), 'x');
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'settings.json'), '{}');
    expect(had).toBe(true);
  });
});

describe('the first-run marker (D12)', () => {
  it('is written once, at the machine\'s first registration, with pending = the real root when it had files', () => {
    const root = folder('Orbit', { 'package.json': '{}' });
    expect(recordRegistration(root, true, 0, home)).toBe(true);
    expect(readFirstRunMarker(home)?.pending).toBe(realpathSync(root));
    // A second registration never writes it, even when the count reads 0 again (all removed).
    const other = folder('Later', { 'a.txt': 'x' });
    expect(recordRegistration(other, true, 1, home)).toBe(false);
    clearPending(root, home);
    expect(recordRegistration(other, true, 0, home)).toBe(false);
    expect(readFirstRunMarker(home)?.pending).toBeNull();
  });

  it('an empty first project writes pending null: no offer, ever', () => {
    expect(recordRegistration(folder('Empty'), false, 0, home)).toBe(true);
    expect(readFirstRunMarker(home)).toMatchObject({ pending: null });
  });

  it('refuses a symlinked ~/.dreamcontext', () => {
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(home, '.dreamcontext'));
    expect(recordRegistration(folder('Orbit', { a: 'x' }), true, 0, home)).toBe(false);
    expect(existsSync(join(dir, 'elsewhere', 'first-run.json'))).toBe(false);
  });

  it('clearPending only clears its own root', () => {
    const root = folder('Orbit', { a: 'x' });
    recordRegistration(root, true, 0, home);
    clearPending(folder('Other'), home);
    expect(readFirstRunMarker(home)?.pending).toBe(realpathSync(root));
    clearPending(root, home);
    expect(readFirstRunMarker(home)?.pending).toBeNull();
    expect(existsSync(firstRunMarkerPath(home))).toBe(true);
  });
});

describe('the claim (D13) and eligibility (C14)', () => {
  it('eligible only for the pending root, with a sparse brain and no claim', () => {
    const root = folder('Orbit', { 'package.json': '{}' });
    sparseBrain(root);
    expect(firstReadEligible(root, home)).toBe(false); // no marker
    recordRegistration(root, true, 0, home);
    expect(firstReadEligible(root, home)).toBe(true);
    // Another project (added later) is never offered.
    const later = folder('Later', { a: 'x' });
    sparseBrain(later);
    expect(firstReadEligible(later, home)).toBe(false);
    // A healthy brain (a second Mac, a brain already written) is not offered.
    writeFileSync(join(root, '_dream_context', 'core', '0.soul.md'), '# Orbit\nA real soul.\n');
    expect(firstReadEligible(root, home)).toBe(false);
  });

  it('the claim is written once and then ends the offer; never through a symlinked state folder', () => {
    const root = folder('Orbit', { a: 'x' });
    sparseBrain(root);
    recordRegistration(root, true, 0, home);
    writeFirstReadClaim(root, 'job-1');
    expect(readFirstReadClaim(root)?.job).toBe('job-1');
    expect(firstReadEligible(root, home)).toBe(false);
    expect(() => writeFirstReadClaim(root, 'job-2')).toThrow(/already/);
    expect(readFirstReadClaim(root)?.job).toBe('job-1');

    const linked = folder('Linked', { a: 'x' });
    mkdirSync(join(linked, '_dream_context'));
    mkdirSync(join(dir, 'outside-state'));
    symlinkSync(join(dir, 'outside-state'), join(linked, '_dream_context', 'state'));
    expect(() => writeFirstReadClaim(linked, 'job-3')).toThrow();
    expect(readdirSafe(join(dir, 'outside-state'))).toEqual([]);
  });

  it('keeps the other keys of .config.json', () => {
    const root = folder('Orbit', { a: 'x' });
    sparseBrain(root);
    writeFileSync(join(root, '_dream_context', 'state', '.config.json'), JSON.stringify({ customKey: 7 }));
    writeFirstReadClaim(root, 'job-1');
    const raw = JSON.parse(readFileSync(join(root, '_dream_context', 'state', '.config.json'), 'utf-8'));
    expect(raw.customKey).toBe(7);
    expect(raw.firstRead.job).toBe('job-1');
  });
});

function readdirSafe(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

describe('firstReadLive (C16, derived)', () => {
  const claim = { job: 'r1', at: '2026-11-20T00:00:00Z' };
  it('running only while the claim\'s child is not ended and working, asking or waiting', () => {
    expect(firstReadLive({ children: { r1: { row: 'working' } } }, claim)).toBe(true);
    expect(firstReadLive({ children: { r1: { row: 'asking' } } }, claim)).toBe(true);
    expect(firstReadLive({ children: { r1: { row: 'done' } } }, claim)).toBe(false);
    expect(firstReadLive({ children: { r1: { row: 'working', endedAt: 5 } } }, claim)).toBe(false);
    // A quit mid-read: the child is gone from the record, or the claim names nothing live.
    expect(firstReadLive({ children: {} }, claim)).toBe(false);
    expect(firstReadLive({ children: { r1: { row: 'working' } } }, null)).toBe(false);
  });
});

describe('the fixed prompt (S4)', () => {
  it('is unattended, data-only, brain-only, and asks for a short summary', () => {
    expect(FIRST_READ_PROMPT).toMatch(/ask no questions/);
    expect(FIRST_READ_PROMPT).toMatch(/as data/);
    expect(FIRST_READ_PROMPT).toMatch(/_dream_context\//);
    expect(FIRST_READ_PROMPT).not.toMatch(/—/);
  });
});

describe('serverCanStartClaude equals the window\'s canStartClaude where a Super runs', () => {
  const settings = { enabled: true, chatView: true } as never;
  const cases: Array<Array<{ id: string; status: string; reason?: string }>> = [
    [{ id: 'claude', status: 'ok' }, { id: 'claude-auth', status: 'ok' }],
    [{ id: 'claude', status: 'ok' }, { id: 'claude-auth', status: 'unknown' }],
    [{ id: 'claude', status: 'ok' }, { id: 'claude-auth', status: 'needs-action' }],
    [{ id: 'claude', status: 'needs-action', reason: 'not-on-path' }, { id: 'claude-auth', status: 'ok' }],
    [{ id: 'claude', status: 'needs-action', reason: 'missing' }, { id: 'claude-auth', status: 'ok' }],
    [{ id: 'claude-auth', status: 'ok' }],
  ];
  for (const [i, checks] of cases.entries()) {
    it(`case ${i}`, () => {
      const report = { surface: 'desktop', platform: 'darwin', checks: [...checks, { id: 'terminal', status: 'ok' }] };
      expect(serverCanStartClaude(report)).toBe(canStartClaude(report as never, settings));
    });
  }
  it('not the desktop: no', () => {
    expect(serverCanStartClaude({ surface: 'browser', checks: [{ id: 'claude', status: 'ok' }, { id: 'claude-auth', status: 'ok' }] })).toBe(false);
  });
});
