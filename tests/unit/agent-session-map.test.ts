/**
 * Unit tests for the agent tab → live Claude session map (`agent-session-map.ts`) —
 * the fix for "resumed tabs reopen stale" (a `/clear` / in-TUI resume rotates the
 * conversation id under a running tab; the map records the rotation so reopening
 * resumes what was actually on screen):
 *   - record + resolve round-trip (per-tab sidecar files — no shared-blob write race)
 *   - later records overwrite (the map holds the LATEST id in the chain)
 *   - identity mappings resolve to '' (unrotated tab → caller uses the pinned id)
 *   - uniqueness sweep: recording a conversation under one tab evicts any other tab's
 *     entry pointing at the same conversation (no two tabs may resume one transcript)
 *   - non-UUID input is rejected on write AND on read (shell-injection / path defense)
 *   - corrupt / missing entry files resolve to '' (never throws)
 *   - symlinked state dir refuses the write (malicious-vault guard)
 *   - prunes the oldest entries beyond the ceiling (deterministic tie-break)
 *   - writes the gitignore entry for the machine-local dir
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordAgentSession, resolveAgentSession, recordAgentFirstPrompt, readAgentSessionEntry, titleWorthyPrompt,
} from '../../src/lib/agent-session-map.js';

const TAB = '11111111-2222-3333-4444-555555555555';
const TAB2 = '22222222-3333-4444-5555-666666666666';
const SES = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SES2 = '99999999-8888-7777-6666-555555555555';

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-session-map-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

const dir = () => join(contextRoot, 'state', '.agent-session-map');
const entryFile = (tab: string) => join(dir(), `${tab}.json`);

describe('record + resolve', () => {
  it('round-trips a rotation', () => {
    recordAgentSession(contextRoot, TAB, SES);
    expect(resolveAgentSession(contextRoot, TAB)).toBe(SES);
  });

  it('later records overwrite — the map holds the latest id in the chain', () => {
    recordAgentSession(contextRoot, TAB, SES);
    recordAgentSession(contextRoot, TAB, SES2);
    expect(resolveAgentSession(contextRoot, TAB)).toBe(SES2);
  });

  it('collapses an identity mapping to "" (unrotated tab)', () => {
    recordAgentSession(contextRoot, TAB, TAB);
    expect(resolveAgentSession(contextRoot, TAB)).toBe('');
  });

  it('resolves "" for an unknown tab', () => {
    expect(resolveAgentSession(contextRoot, TAB)).toBe('');
  });

  it('keeps tabs independent — one file per tab, no shared blob to race on', () => {
    recordAgentSession(contextRoot, TAB, SES);
    recordAgentSession(contextRoot, TAB2, SES2);
    expect(resolveAgentSession(contextRoot, TAB)).toBe(SES);
    expect(resolveAgentSession(contextRoot, TAB2)).toBe(SES2);
    expect(existsSync(entryFile(TAB))).toBe(true);
    expect(existsSync(entryFile(TAB2))).toBe(true);
  });
});

describe('uniqueness sweep — one live tab per conversation', () => {
  it('recording a conversation under a new tab evicts the old tab\'s entry', () => {
    recordAgentSession(contextRoot, TAB, SES);   // tab 1 rotated to SES
    recordAgentSession(contextRoot, TAB2, SES);  // user pulls SES into tab 2 via /resume
    expect(resolveAgentSession(contextRoot, TAB2)).toBe(SES);
    expect(resolveAgentSession(contextRoot, TAB)).toBe(''); // falls back to its pinned chain
  });

  it('does not evict entries pointing at other conversations', () => {
    recordAgentSession(contextRoot, TAB, SES);
    recordAgentSession(contextRoot, TAB2, SES2);
    expect(resolveAgentSession(contextRoot, TAB)).toBe(SES);
  });
});

describe('input validation (shell-injection / path defense)', () => {
  it('rejects non-UUID ids on write', () => {
    recordAgentSession(contextRoot, 'not-a-uuid', SES);
    recordAgentSession(contextRoot, TAB, '$(rm -rf /)');
    expect(existsSync(dir())).toBe(false);
  });

  it('rejects a non-UUID tab id on read', () => {
    recordAgentSession(contextRoot, TAB, SES);
    expect(resolveAgentSession(contextRoot, '../../etc/passwd')).toBe('');
  });

  it('drops hand-edited non-UUID values on read', () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(entryFile(TAB), JSON.stringify({ current: '; touch /tmp/pwned', updated: '2026-01-01T00:00:00.000Z' }));
    expect(resolveAgentSession(contextRoot, TAB)).toBe('');
  });
});

describe('robustness', () => {
  it('resolves "" from a corrupt entry file (never throws), and a record recovers it', () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(entryFile(TAB), '{not json');
    expect(resolveAgentSession(contextRoot, TAB)).toBe('');
    recordAgentSession(contextRoot, TAB, SES);
    expect(resolveAgentSession(contextRoot, TAB)).toBe(SES);
  });

  it('refuses to write through a symlinked state dir (malicious-vault guard)', () => {
    const outside = join(projectRoot, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(contextRoot, 'state'));
    recordAgentSession(contextRoot, TAB, SES);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('prunes the oldest entries beyond the ceiling (40)', () => {
    for (let i = 0; i < 45; i++) {
      const tab = `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`;
      // distinct target per tab so the uniqueness sweep never fires here
      const ses = `${String(i).padStart(8, '0')}-1111-1111-1111-111111111111`;
      recordAgentSession(contextRoot, tab, ses);
    }
    expect(readdirSync(dir()).length).toBe(40);
    expect(existsSync(entryFile('00000044-0000-0000-0000-000000000000'))).toBe(true);
    expect(existsSync(entryFile('00000000-0000-0000-0000-000000000000'))).toBe(false);
  });

  it('ensures the gitignore entry for the machine-local dir', () => {
    recordAgentSession(contextRoot, TAB, SES);
    const gi = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(gi).toContain('_dream_context/state/.agent-session-map/');
  });
});

// The auto-title fallback: Claude Code ≥2.1.x flushes a live session's transcript only
// on exit/rotation, so the UserPromptSubmit hook records the conversation's first
// title-worthy prompt here and /agent/title reads it back when no transcript exists.
describe('first-prompt capture (auto-title fallback)', () => {
  it('records and reads back the first prompt', () => {
    recordAgentFirstPrompt(contextRoot, TAB, SES, 'Fix the popover resize bug');
    const entry = readAgentSessionEntry(contextRoot, TAB);
    expect(entry?.current).toBe(SES);
    expect(entry?.firstPrompt).toBe('Fix the popover resize bug');
  });

  it('is write-once per conversation — a second prompt never overwrites the first', () => {
    recordAgentFirstPrompt(contextRoot, TAB, SES, 'first ask');
    recordAgentFirstPrompt(contextRoot, TAB, SES, 'second ask');
    expect(readAgentSessionEntry(contextRoot, TAB)?.firstPrompt).toBe('first ask');
  });

  it('survives the Stop-hook re-record of the SAME conversation', () => {
    recordAgentFirstPrompt(contextRoot, TAB, SES, 'the task');
    recordAgentSession(contextRoot, TAB, SES); // Stop hook re-records every turn
    expect(readAgentSessionEntry(contextRoot, TAB)?.firstPrompt).toBe('the task');
    expect(resolveAgentSession(contextRoot, TAB)).toBe(SES);
  });

  it('resets on rotation — a new conversation titles from ITS first prompt', () => {
    recordAgentFirstPrompt(contextRoot, TAB, SES, 'old conversation ask');
    recordAgentSession(contextRoot, TAB, SES2); // /clear → SessionStart records the new id
    expect(readAgentSessionEntry(contextRoot, TAB)?.firstPrompt).toBeUndefined();
    recordAgentFirstPrompt(contextRoot, TAB, SES2, 'new conversation ask');
    expect(readAgentSessionEntry(contextRoot, TAB)?.firstPrompt).toBe('new conversation ask');
  });

  it('re-points a lagging entry when the prompt arrives for a different conversation', () => {
    recordAgentFirstPrompt(contextRoot, TAB, SES, 'old ask');
    // SessionStart record for the rotation was lost; the prompt hook sees the new id first.
    recordAgentFirstPrompt(contextRoot, TAB, SES2, 'new ask');
    const entry = readAgentSessionEntry(contextRoot, TAB);
    expect(entry?.current).toBe(SES2);
    expect(entry?.firstPrompt).toBe('new ask');
  });

  it('creates the entry when SessionStart never recorded (hook timeout)', () => {
    recordAgentFirstPrompt(contextRoot, TAB, SES, 'the ask');
    expect(resolveAgentSession(contextRoot, TAB)).toBe(SES);
  });

  it('rejects non-UUID ids on write', () => {
    recordAgentFirstPrompt(contextRoot, 'not-a-uuid', SES, 'ask');
    recordAgentFirstPrompt(contextRoot, TAB, '$(rm -rf /)', 'ask');
    expect(existsSync(dir())).toBe(false);
  });

  it('rejects a non-UUID tab id on read', () => {
    recordAgentFirstPrompt(contextRoot, TAB, SES, 'ask');
    expect(readAgentSessionEntry(contextRoot, '../../etc/passwd')).toBeNull();
  });

  it('caps a hand-edited oversized prompt on read', () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(entryFile(TAB), JSON.stringify({
      current: SES, updated: '2026-01-01T00:00:00.000Z', firstPrompt: 'x'.repeat(5000),
    }));
    expect(readAgentSessionEntry(contextRoot, TAB)?.firstPrompt?.length).toBe(800);
  });
});

describe('titleWorthyPrompt — what may name a tab', () => {
  it('passes a normal ask through, trimmed', () => {
    expect(titleWorthyPrompt('  Fix the resize bug  ')).toBe('Fix the resize bug');
  });

  it('rejects slash commands, shell passthroughs, and wrapper payloads', () => {
    expect(titleWorthyPrompt('/clear')).toBeNull();
    expect(titleWorthyPrompt('!git status')).toBeNull();
    expect(titleWorthyPrompt('<system-reminder>x</system-reminder>')).toBeNull();
  });

  it('rejects empty / too-short input', () => {
    expect(titleWorthyPrompt('')).toBeNull();
    expect(titleWorthyPrompt('   ')).toBeNull();
    expect(titleWorthyPrompt('x')).toBeNull();
  });

  it('folds control chars to spaces and caps at 800 chars', () => {
    expect(titleWorthyPrompt('fix the\u0000bug')).toBe('fix the bug');
    expect(titleWorthyPrompt('y'.repeat(2000))?.length).toBe(800);
  });
});
