/**
 * Two bridges on one Super pin (field 2026-11-14, Tilki): a command goes to the NEWEST bridge
 * and the window's `super_state` to every bridge. The oldest-first lookup sent every push to a
 * process nobody read, so the window's record froze: a freshly delegated child got no card on
 * the stage and showed as a tab in the chat window.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-push-newest-home-`);
});

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintWindowToken, resetWindowControl, tokenOfSession, tokensOfSession } from '../../src/lib/window-control.js';
import { pushSuperState } from '../../src/lib/super/inbox.js';
import { emptySuperState } from '../../src/lib/super/types.js';

const PIN = 'eed2f1d1-7c04-41d9-a702-4aec1fc17c66';
let dir: string;
let root: string;

function bridge(label: string, sent: string[], open = true) {
  return mintWindowToken({
    send: (frame) => { if (!open) return false; sent.push(`${label}:${String(frame.subtype)}`); return true; },
    vault: 'acme', contextRoot: root, sessionId: PIN, mode: 'super', superId: 'main',
  });
}

beforeEach(() => {
  resetWindowControl();
  dir = mkdtempSync(join(tmpdir(), 'super-push-newest-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
});

afterEach(() => {
  resetWindowControl();
  rmSync(dir, { recursive: true, force: true });
});

describe('the pin\'s token is the newest bridge', () => {
  it('two bridges on one pin: the newest answers, and the older again once the newest leaves', () => {
    const sent: string[] = [];
    const old = bridge('old', sent);
    const fresh = bridge('new', sent);
    expect(tokenOfSession(PIN)).toBe(fresh.token);
    expect(tokensOfSession(PIN)).toEqual([fresh.token, old.token]);
    fresh.release();
    expect(tokenOfSession(PIN)).toBe(old.token);
    old.release();
    expect(tokenOfSession(PIN)).toBeNull();
    expect(tokensOfSession('')).toEqual([]);
  });
});

describe('pushSuperState', () => {
  const state = () => ({ ...emptySuperState(), session: PIN, enabled: true });

  it('reaches every bridge on the pin: the window may hold either socket', () => {
    const sent: string[] = [];
    bridge('old', sent);
    bridge('new', sent);
    expect(pushSuperState(root, state())).toBe(true);
    expect(sent.sort()).toEqual(['new:super_state', 'old:super_state']);
  });

  it('a newest bridge whose socket is gone: the older one still gets it', () => {
    const sent: string[] = [];
    bridge('old', sent);
    bridge('new', sent, false);
    expect(pushSuperState(root, state())).toBe(true);
    expect(sent).toEqual(['old:super_state']);
  });

  it('no bridge, or none with a socket: not pushed', () => {
    expect(pushSuperState(root, state())).toBe(false);
    const sent: string[] = [];
    bridge('old', sent, false);
    expect(pushSuperState(root, state())).toBe(false);
    expect(sent).toEqual([]);
  });
});
