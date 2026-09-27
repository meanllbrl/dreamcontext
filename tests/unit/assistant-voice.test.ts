/**
 * W3 — voice in the dreamcontext Assistant's notch.
 *
 * 1. The Rust hotkey's edges become takes through ONE pure table (`pushToTalkAction`) and a
 *    bus the notch emits on; in toggle mode a press nobody acted on is the owner dismissing.
 * 2. The Assistant's voice lexicon carries every REGISTERED project's name (first, so the
 *    budget never drops them) — and a normal vault's lexicon never does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emitExternalPushToTalk, onExternalPushToTalk, pushToTalkAction, type PushToTalkSignal,
} from '../../dashboard/src/lib/voice/externalPushToTalk';

const sig = (edge: PushToTalkSignal['edge'], mode: PushToTalkSignal['mode'], summon = false): PushToTalkSignal => ({ edge, mode, summon });

describe('hotkey edge → take (pushToTalkAction)', () => {
  it('hold: press opens the mic only for the composer that owns the chord', () => {
    expect(pushToTalkAction(sig('pressed', 'hold', true), true, false)).toBe('start');
    expect(pushToTalkAction(sig('pressed', 'hold'), true, false)).toBe('start');
    expect(pushToTalkAction(sig('pressed', 'hold', true), false, false)).toBeNull();
  });

  it('hold: release always stops — even a take still opening, even after ownership moved', () => {
    expect(pushToTalkAction(sig('released', 'hold'), false, false)).toBe('stop');
    expect(pushToTalkAction(sig('released', 'hold'), true, true)).toBe('stop');
  });

  it('toggle: the summoning press starts, the next press sends, an idle press does nothing', () => {
    expect(pushToTalkAction(sig('pressed', 'toggle', true), true, false)).toBe('start');
    expect(pushToTalkAction(sig('pressed', 'toggle'), true, true)).toBe('stop');
    expect(pushToTalkAction(sig('pressed', 'toggle'), true, false)).toBeNull();
    expect(pushToTalkAction(sig('released', 'toggle'), true, true)).toBeNull();
  });
});

describe('the notch → composer bus', () => {
  it('reports whether any composer acted, so an unanswered toggle press can dismiss', () => {
    expect(emitExternalPushToTalk(sig('pressed', 'toggle'))).toBe(false);
    const seen: PushToTalkSignal[] = [];
    const off = onExternalPushToTalk((s) => { seen.push(s); return pushToTalkAction(s, true, false) !== null; });
    expect(emitExternalPushToTalk(sig('pressed', 'toggle', true))).toBe(true);
    expect(emitExternalPushToTalk(sig('pressed', 'toggle'))).toBe(false);
    off();
    expect(emitExternalPushToTalk(sig('pressed', 'toggle', true))).toBe(false);
    expect(seen).toHaveLength(2);
  });
});

describe('the Assistant lexicon knows the registered projects', () => {
  const home = mkdtempSync(join(tmpdir(), 'dc-assistant-voice-'));
  const prevHome = process.env.HOME;
  let buildVoiceLexicon: typeof import('../../src/lib/voice/lexicon').buildVoiceLexicon;
  let clearLexiconCache: () => void;
  let assistantRoot = '';
  const vaultRoot = join(home, 'projects', 'acme', '_dream_context');

  beforeAll(async () => {
    process.env.HOME = home;
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({
      vaults: [
        { name: 'tilki', path: join(home, 'projects', 'tilki') },
        { name: 'orbitkit', path: join(home, 'projects', 'orbitkit') },
      ],
    }));
    ({ buildVoiceLexicon, clearLexiconCache } = await import('../../src/lib/voice/lexicon'));
    const { assistantContextRoot } = await import('../../src/lib/assistant/home');
    assistantRoot = assistantContextRoot();
    mkdirSync(join(assistantRoot, 'core'), { recursive: true });
    mkdirSync(join(vaultRoot, 'core'), { recursive: true });
  });
  afterAll(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('the hidden vault gets every registered project name, first', () => {
    clearLexiconCache();
    const lex = buildVoiceLexicon(assistantRoot).split(' ');
    expect(lex.slice(0, 2)).toEqual(['tilki', 'orbitkit']);
  });

  it('a normal vault never gets the other projects', () => {
    clearLexiconCache();
    const lex = buildVoiceLexicon(vaultRoot).split(' ');
    expect(lex).not.toContain('tilki');
    expect(lex).not.toContain('orbitkit');
  });
});
