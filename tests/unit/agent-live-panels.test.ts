/**
 * Marker tests for the two live orchestration panels (goal-skill + council) across BOTH
 * agent renderers.
 *
 * Two regressions these pin, both found 2026-07-25 while checking how the panels read in
 * the new Chat view:
 *
 *  1. **Council was terminal-only.** `PaneComposer` (terminal) mounted GoalLivePanel AND
 *     CouncilLivePanel; `ChatPane` mounted only the goal one — so a `/council` debate
 *     driven from a Chat tab rendered nothing, even though `GET /api/agent/council-live`
 *     scopes by conversation id identically for both kinds of pane. Parity across the two
 *     renderers is the invariant; a panel added to one and not the other is the bug.
 *  2. **Dark-only hardcoded palettes.** Both panels were styled against a fixed terminal
 *     dark surface (#17171c canvas, #d6d3e3 text …) on the premise that they only ever sat
 *     against xterm — but that chrome is token-driven too, so they rendered as dark slabs
 *     in light mode, which the fully tokenized Chat surface made obvious. Everything
 *     except the categorical stance palette and the modal scrims is now DS tokens.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const sleepy = (...p: string[]) => readFileSync(join(ROOT, 'dashboard', 'src', 'components', 'sleepy', ...p), 'utf-8');

/** Surface hexes the dark-only pass baked in. Any of them reappearing means a value was
 *  written for one theme again. The modal scrims (`rgba(8, 8, 12, 0.55)`) are deliberately
 *  theme-invariant — same convention as the chat's own slide-over/lightbox — so they are
 *  not in this list. */
const DARK_ONLY_HEXES = ['#17171c', '#d6d3e3', '#8b8898', '#5c5f66', '#2b2b33', '#232329', '#a9a6b6', '#3a3a44'];

/** Declarations only — the file headers NAME the hexes they replaced, and that prose is
 *  the point of the comment, not a regression. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('live panels are mounted by BOTH agent renderers', () => {
  it('the terminal composer strip mounts goal + council', () => {
    const src = sleepy('PaneComposer.tsx');
    expect(src).toContain('<GoalLivePanel');
    expect(src).toContain('<CouncilLivePanel');
  });

  it('the chat live rail mounts goal + council', () => {
    const src = sleepy('ChatPane.tsx');
    expect(src).toContain('<GoalLivePanel');
    expect(src).toContain('<CouncilLivePanel');
  });

  it('the chat rail passes each panel the conversation id it is scoped by', () => {
    const src = sleepy('ChatPane.tsx');
    // Without claudeId the poll is disabled and the panel can never activate — the exact
    // shape of "mounted but permanently dead" a bare `<CouncilLivePanel />` would have.
    const rail = src.slice(src.indexOf('function ChatLiveRail'), src.indexOf('// ─── Degraded'));
    expect(rail).toMatch(/<GoalLivePanel claudeId=\{session\.claudeId\}/);
    expect(rail).toMatch(/<CouncilLivePanel claudeId=\{session\.claudeId\}/);
  });

  it('the minimized dock chip carries both badges', () => {
    const src = sleepy('AgentDock.tsx');
    expect(src).toContain('<GoalDockBadge');
    expect(src).toContain('<CouncilDockBadge');
  });
});

describe('live panels theme with the app (no dark-only palettes)', () => {
  for (const file of ['GoalLivePanel.css', 'CouncilLivePanel.css']) {
    it(`${file} carries none of the old dark-surface hexes`, () => {
      const css = stripComments(sleepy(file));
      for (const hex of DARK_ONLY_HEXES) {
        expect(css, `${file} still hardcodes ${hex}`).not.toContain(hex);
      }
    });

    it(`${file} publishes the edge token the chat rail borders with`, () => {
      // ChatPane.css reads these to give each bar its card border on the rail; a rename
      // here without one there silently degrades the bar to a borderless block.
      const css = sleepy(file);
      const name = file.startsWith('Goal') ? '--goal-live-edge' : '--council-live-edge';
      expect(css).toContain(`${name}:`);
      expect(sleepy('ChatPane.css')).toContain(`var(${name})`);
    });
  }

  it('the chat rail collapses when no run is active', () => {
    // Every child renders null while its own run is inactive, so the rail is childless —
    // without this it would leave a bordered strip above every plain conversation.
    expect(sleepy('ChatPane.css')).toContain('.chat-live-rail:empty { display: none; }');
  });

  it('the goal graph resolves heat + fork colors in CSS, not inline JS hexes', () => {
    const tsx = sleepy('GoalLivePanel.tsx');
    expect(tsx).not.toContain('HEAT_COLORS');
    expect(tsx).not.toContain('FORK_COLORS');
    // The tier/state travel as attributes so the CSS palette (and reduced-motion) applies.
    expect(tsx).toContain('data-heat={goalHeatTier(state.iters, from)}');
    expect(tsx).toContain('className="goal-live-sat" data-s={f.s}');
  });
});
