import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_POPUP_START,
  appPopupLater,
  appPopupReopen,
  appPopupStep,
  type AppPopupState,
} from '../../dashboard/src/components/sleepy/super/superAppCards.js';

/**
 * A waiting app card comes as a pop-up (owner 2026-11-16: "bu istek pop up olarak gelsin"):
 * it opens once by itself, closing it never decides, its row reopens it, one at a time.
 */

const SUPER = join(__dirname, '../../dashboard/src/components/sleepy/super');

describe('app card pop-up queue', () => {
  it('opens a waiting card once, by itself', () => {
    const s = appPopupStep(APP_POPUP_START, ['a'], false);
    expect(s.shown).toBe('a');
    // The next read of the same list changes nothing (same object: no re-render).
    expect(appPopupStep(s, ['a'], false)).toBe(s);
  });

  it('closing it keeps the card waiting and never pops it up again by itself', () => {
    let s = appPopupStep(APP_POPUP_START, ['a'], false);
    s = appPopupLater(s);
    expect(s.shown).toBeNull();
    expect(s.later).toEqual(['a']);
    // Still in the waiting list on every later read: it stays closed.
    s = appPopupStep(s, ['a'], false);
    s = appPopupStep(s, ['a'], false);
    expect(s.shown).toBeNull();
  });

  it('its row reopens a card he closed', () => {
    let s = appPopupLater(appPopupStep(APP_POPUP_START, ['a'], false));
    s = appPopupReopen(s, 'a');
    expect(s).toEqual({ shown: 'a', later: [] });
    expect(appPopupStep(s, ['a'], false).shown).toBe('a');
  });

  it('two waiting cards: one at a time, the second after the first is decided', () => {
    let s = appPopupStep(APP_POPUP_START, ['a', 'b'], false);
    expect(s.shown).toBe('a');
    // A second read with both still waiting: still only the first.
    s = appPopupStep(s, ['a', 'b'], false);
    expect(s.shown).toBe('a');
    // Decided here: closes at once, even before the waiting list catches up...
    s = appPopupLater(s);
    s = appPopupStep(s, ['a', 'b'], false);
    expect(s.shown).toBe('b');
    // ...and once the list drops it, it is forgotten.
    s = appPopupStep(s, ['b'], false);
    expect(s).toEqual({ shown: 'b', later: [] });
  });

  it('a card decided elsewhere (notch, Telegram) closes and the next one opens', () => {
    let s = appPopupStep(APP_POPUP_START, ['a', 'b'], false);
    s = appPopupStep(s, ['b'], false);
    expect(s.shown).toBe('b');
    s = appPopupStep(s, [], false);
    expect(s).toEqual({ shown: null, later: [] });
  });

  it('never opens over another pop-up, and opens once that one is gone', () => {
    let s: AppPopupState = appPopupStep(APP_POPUP_START, ['a'], true);
    expect(s.shown).toBeNull();
    s = appPopupStep(s, ['a'], false);
    expect(s.shown).toBe('a');
    // Already open: a pop-up that comes later does not take it away.
    expect(appPopupStep(s, ['a'], true).shown).toBe('a');
  });

  it('a closed card that comes back as a new request opens again', () => {
    let s = appPopupLater(appPopupStep(APP_POPUP_START, ['a'], false));
    s = appPopupStep(s, [], false);
    expect(s.later).toEqual([]);
    expect(appPopupStep(s, ['a'], false).shown).toBe('a');
  });
});

describe('app card pop-up wiring', () => {
  const card = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/chat/AppRequestCard.tsx'), 'utf-8');
  const stageParts = readFileSync(join(SUPER, 'StageParts.tsx'), 'utf-8');
  const agentSurface = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf-8');
  const model = readFileSync(join(SUPER, 'superAppCards.ts'), 'utf-8');

  it('Esc on the pop-up closes it alone: it is in every window-level Esc owner list', () => {
    expect(stageParts).toMatch(/PRESENT_KEY_OWNERS = '[^']*\.app-popup-scrim/);
    expect(agentSurface).toMatch(/querySelector\('[^']*\.app-popup-scrim[^']*'\)\) return;/);
  });

  it('a pop-up that opened by itself ignores a press until its buttons have been on screen a moment', () => {
    expect(popup).toMatch(/armMs=\{APP_POPUP_ARM_MS\}/);
    expect(card).toMatch(/if \(!card \|\| busy \|\| !armed\) return;/);
    expect(card.match(/disabled=\{busy \|\| !armed\}/g)?.length).toBe(2);
  });

  it('the band row tells the server the card is on the Super screen, queued or not', () => {
    expect(band).toMatch(/useTellShown\(id, q\.data\?\.state === 'pending', 'super'\)/);
  });

  it('never opens over another dialog or panel, nor while he is typing', () => {
    expect(model).toMatch(/IN_THE_WAY = '\[aria-modal="true"\]/);
    expect(model).toContain('.super-group-panel');
    expect(model).toMatch(/Date\.now\(\) - lastKeyAt < TYPING_MS/);
  });

  const popup = readFileSync(join(SUPER, 'AppRequestPopup.tsx'), 'utf-8');
  const band = readFileSync(join(SUPER, 'SuperApprovalBand.tsx'), 'utf-8');
  const surface = readFileSync(join(SUPER, 'SuperSurface.tsx'), 'utf-8');

  it('the pop-up draws the very card (its decide route), as a real modal, never window.confirm', () => {
    expect(popup).toMatch(/<AppRequestCard\b[^>]*where="super"/);
    expect(popup).toContain('aria-modal="true"');
    expect(popup).not.toMatch(/window\.confirm|confirm\(/);
    // Its own controls only close: no decide call in the frame.
    expect(popup).not.toMatch(/\bdecide\(|api\.post/);
  });

  it('the band draws one line per app card, never the full card over the chat', () => {
    expect(band).not.toMatch(/<AppRequestCard\b/);
    expect(band).toContain('data-testid="super-app-row"');
    expect(band).toMatch(/onOpenApp\?\.\(id\)/);
  });

  it('the Super screen opens the pop-up and its rows reopen it', () => {
    // Only over the Super screen on screen: not a folded stage, not a background project.
    expect(surface).toMatch(/useAppPopup\(appCards, !member && !remote && props\.visible && projectOnScreen\)/);
    expect(surface).toMatch(/onOpenApp=\{appPopup\.reopen\}/);
    expect(surface).toMatch(/<AppRequestPopup[\s\S]*?onLater=\{appPopup\.later\}/);
  });
});
