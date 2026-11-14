/**
 * The Super's agenda card follows every write even when two processes share the Super's pin
 * (owner 2026-11-14: "Ben hala görüyorum agenda'da"). A respawn opened a second Super process for
 * the same pin while the first one never exited; the first one's channel stayed registered with
 * its socket closed, and `pushSuperState` picked that dead channel, so every `super_state` push
 * was dropped and the card froze on lines `super note drop` had removed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintWindowToken, tokenOfSession, superTokenOfSession } from '../../src/lib/window-control.js';
import { pushSuperState } from '../../src/lib/super/inbox.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';

const PIN = '11111111-2222-4333-8444-555555555555';
const releases: Array<() => void> = [];
const dirs: string[] = [];
afterEach(() => {
  while (releases.length) releases.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function channel(open: boolean) {
  const got: Array<Record<string, unknown>> = [];
  const { token, release } = mintWindowToken({
    send: (frame) => { if (!open) return false; got.push(frame); return true; },
    vault: 'orbit', contextRoot: '/tmp/orbit/_dream_context', sessionId: PIN, mode: 'super',
  });
  releases.push(release);
  return { token, got };
}

function stateWithPad(text: string): { root: string; state: SuperState } {
  const dir = mkdtempSync(join(tmpdir(), 'dc-super-push-'));
  dirs.push(dir);
  const state = emptySuperState();
  state.enabled = true;
  state.session = PIN;
  state.pad = [{ id: 'n1', section: 'waiting', text, at: 1 }];
  return { root: join(dir, '_dream_context'), state };
}

describe('super_state reaches the window when an old process of the same pin lingers', () => {
  it('pushes past a dead channel registered first to the live one', () => {
    const dead = channel(false);
    const live = channel(true);
    const { root, state } = stateWithPad('Yük İzleme güncellemesi');
    expect(pushSuperState(root, state)).toBe(true);
    expect(dead.got).toHaveLength(0);
    expect(live.got).toHaveLength(1);
    const frame = live.got[0] as { subtype: string; state: { pad: Array<{ text: string }> } };
    expect(frame.subtype).toBe('super_state');
    expect(frame.state.pad.map((p) => p.text)).toEqual(['Yük İzleme güncellemesi']);
  });

  it('a token lookup names the newest channel of the pin, as the super lookup does', () => {
    channel(false);
    const live = channel(true);
    expect(tokenOfSession(PIN)).toBe(live.token);
    expect(superTokenOfSession(PIN)).toBe(live.token);
  });

  it('is false when no socket of the pin is open', () => {
    channel(false);
    const { root, state } = stateWithPad('x');
    expect(pushSuperState(root, state)).toBe(false);
  });
});
