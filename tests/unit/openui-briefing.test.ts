/**
 * The generated half of the `dream-ui` briefing, and the locks around it.
 *
 * `src/server/chat-surface-openui.generated.ts` is NOT hand-written: it is `Library.prompt()`
 * run over the trimmed component library in
 * `dashboard/src/components/sleepy/chat/openuiLibrary.ts`. It is committed so the server can
 * build a system prompt without importing React, and this file is what stops the committed
 * copy from drifting away from the library it claims to describe.
 *
 *   • CHECK (this file):  render in memory, compare to the committed file, fail on any diff.
 *   • UPDATE:             `npm run gen:openui-briefing` — the SAME function, written to disk.
 *
 * Same shape as `cli-manifest.test.ts`, and the same reason: a generator nobody runs is a
 * generator that lies. Making the check and the update the same code path means the only way
 * to satisfy CI is to have actually regenerated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHAT_SURFACE_BRIEFING, CHAT_BRIEFING_PARTS } from '../../src/server/chat-surface.js';
import { CHAT_SURFACE_BRIEFING_OPENUI } from '../../src/server/chat-surface-openui.js';
import { OPENUI_COMPONENT_NAMES, OPENUI_SHIPPED_COMPONENT_NAMES } from '../../dashboard/src/components/sleepy/chat/openuiLibrary.js';

import { renderGeneratedFile, OPENUI_GENERATED_PATH } from '../../scripts/gen-openui-briefing.js';
import { OPENUI_GENERATED_BRIEFING } from '../../src/server/chat-surface-openui.generated.js';

describe('openui briefing — generated, never hand-written', () => {
  it('the committed file matches what the library generates today', () => {
    // Fails with a diff the moment the library changes and nobody ran the generator.
    expect(readFileSync(OPENUI_GENERATED_PATH, 'utf-8')).toBe(renderGeneratedFile());
  });

  it('every component the briefing names exists in the library, and vice versa', () => {
    // The lockstep `dream-html` needs a whole test file for, held by construction here: the
    // prompt is DERIVED from the library, so this asserts the derivation actually mentions
    // each one rather than silently dropping it.
    for (const name of OPENUI_COMPONENT_NAMES) {
      expect(CHAT_SURFACE_BRIEFING_OPENUI, `${name} missing from the briefing`).toContain(name);
    }
  });

  it('names NO dropped component anywhere — not in a signature, not in a child-type union', () => {
    // The generalisation of a bug this wave actually hit: filtering the component LIST leaves
    // the component SCHEMAS untouched, so `Card`'s children union still named all 29 shipped
    // components — a briefing promising a `Form` the renderer cannot draw. Enumerated rather
    // than spot-checked, because the next leak will be somewhere nobody thought to look.
    const kept = new Set<string>(OPENUI_COMPONENT_NAMES);
    const dropped = OPENUI_SHIPPED_COMPONENT_NAMES.filter((n) => !kept.has(n));
    expect(dropped.length).toBeGreaterThan(5); // the trim is real, not a no-op
    for (const name of dropped) {
      // Word boundaries: `Series` is kept and `ScatterSeries` is not, and a bare `indexOf`
      // cannot tell those apart.
      // Scoped to the GENERATED text: the hand-written prose around it legitimately uses
      // English words that collide with component names ("Buttons", introducing the
      // `dream-actions` block that is a real capability of this surface in both modes).
      expect(new RegExp(`\\b${name}\\b`).test(OPENUI_GENERATED_BRIEFING), `${name} leaked into the vocabulary`).toBe(false);
    }
  });

  it('drops the generated Action/Button section', () => {
    // Emitted unconditionally by `Library.prompt()` — no option removes it. It documents a
    // `Button` this vocabulary does not have and, more importantly, an `@OpenUrl` navigation
    // that would be a second path to an affordance `dream-actions` already gates (https-only,
    // checked on the client AND in Rust). One gate or none.
    expect(OPENUI_GENERATED_BRIEFING).not.toContain('@OpenUrl');
    expect(OPENUI_GENERATED_BRIEFING).not.toContain('@ToAssistant');
    expect(OPENUI_GENERATED_BRIEFING).not.toContain('## Action');
    // The sections around it must survive the cut.
    expect(OPENUI_GENERATED_BRIEFING).toContain('## Component Signatures');
    expect(OPENUI_GENERATED_BRIEFING).toContain('## Hoisting & Streaming');
  });

  it('names no component the trimmed library left out', () => {
    // FORMS stay out because a submitted form has nowhere to go, and `Button` stays out for a
    // sharper reason: it accepts `Action([@OpenUrl(...)])`, a second and ungated route to what
    // `dream-actions` gates to https on the client AND in Rust.
    //
    // `FollowUpBlock`/`FollowUpItem` were on this list until Wave 5 and are deliberately no
    // longer: their action carries TEXT and nothing else, and Wave 5 built the round trip that
    // makes it mean something (`openuiAction.ts` -> the same `toAction` validator every
    // `dream-actions` button passes). The rule this list enforces has not moved — a component
    // is offered only once using it does something — the component moved across it.
    // Scoped to the GENERATED vocabulary, like the exhaustive check above and for the same
    // reason: the hand-written tail legitimately says "**Buttons** — a fenced `dream-actions`
    // block", which is a real capability of this surface in BOTH modes and not a component.
    for (const absent of ['DatePicker', 'Slider', 'CheckBoxGroup', 'RadioGroup', 'ScatterChart', 'Buttons']) {
      expect(OPENUI_GENERATED_BRIEFING, `${absent} should not be offered`).not.toContain(absent);
    }
  });
});

describe('openui briefing — the follow-up is the ONE interactive component', () => {
  it('offers FollowUpItem, because Wave 5 wired what it does', () => {
    expect(CHAT_SURFACE_BRIEFING_OPENUI).toContain('FollowUpItem');
    expect(CHAT_SURFACE_BRIEFING_OPENUI).toContain('FollowUpBlock');
  });

  it('still refuses Button, and the URL action it can carry', () => {
    // A `Button` can hold `Action([@OpenUrl(...)])`. The generated Action section was stripped
    // in Wave 2 for exactly this, and adding the component back would reintroduce the hole
    // from the other side.
    expect(/\bButton\b/.test(OPENUI_GENERATED_BRIEFING)).toBe(false);
    expect(OPENUI_GENERATED_BRIEFING).not.toContain('@OpenUrl');
  });

  it('tells the agent what clicking one actually does', () => {
    // A capability named without its consequence is how an agent writes a follow-up that
    // reads like a heading instead of the reader's own next question.
    expect(CHAT_SURFACE_BRIEFING_OPENUI).toMatch(/sends its text as their next message/);
  });
});

describe('openui briefing — one channel, not two', () => {
  it('teaches dream-ui and NOT dream-html', () => {
    expect(CHAT_SURFACE_BRIEFING_OPENUI).toContain('dream-ui');
    expect(CHAT_SURFACE_BRIEFING_OPENUI).not.toContain('dream-html');
    // The kit belongs to the other channel; a dc- class named here would render as nothing.
    expect(CHAT_SURFACE_BRIEFING_OPENUI).not.toContain('dc-doc');
  });

  it('overrides the package preamble that would forbid prose', () => {
    // The shipped preamble says the ENTIRE response must be openui-lang. On this surface the
    // answer is markdown and the block is one part of it; left in, it would tell the agent to
    // stop writing sentences.
    expect(CHAT_SURFACE_BRIEFING_OPENUI).not.toContain('ENTIRE response must be valid openui-lang');
    expect(CHAT_SURFACE_BRIEFING_OPENUI).toContain('the rest of your');
  });

  it('keeps every OTHER capability of the surface', () => {
    for (const shared of ['dream-view', 'dream-actions', '.excalidraw.md', '==phrase==', 'dc-']) {
      const inDefault = CHAT_SURFACE_BRIEFING.includes(shared);
      const inOpenUi = CHAT_SURFACE_BRIEFING_OPENUI.includes(shared);
      // `dc-` is the one thing that must NOT carry over; everything else must.
      if (shared === 'dc-') expect(inOpenUi).toBe(false);
      else expect(inOpenUi, `${shared} lost in the openui variant`).toBe(inDefault);
    }
  });
});

describe('openui briefing — the default is untouched', () => {
  it('composes byte-identically from its parts', () => {
    // The parts split is a refactor, and this is the assertion that keeps it one: a default
    // session must be told exactly what it was told before the variant existed.
    expect(CHAT_SURFACE_BRIEFING).toBe(
      `${CHAT_BRIEFING_PARTS.head}\n${CHAT_BRIEFING_PARTS.drawHtml}\n${CHAT_BRIEFING_PARTS.rest}\n`,
    );
  });

  it('still teaches the HTML channel', () => {
    expect(CHAT_SURFACE_BRIEFING).toContain('dream-html');
    expect(CHAT_SURFACE_BRIEFING).not.toContain('dream-ui');
  });
});

describe('openui briefing — the budget is MEASURED', () => {
  /**
   * The default briefing carries a hard bound (9,800 in `agent-board-assets.test.ts`) whose
   * standing rule is "cut prose before you raise the bound". This variant gets its OWN bound
   * rather than that one, because the thing that grew is not prose: it is a generated
   * vocabulary, and the only way to cut it is to remove a component the agent can then no
   * longer draw. Recorded so the cost is visible in review rather than discovered later.
   *
   * MEASURED 2026-09-05: default 9,670 · openui 11,701 (+2,031) · of which 5,890 is the
   * generated vocabulary for 19 components. For scale: the full shipped library would
   * generate 15,052 on its own, and the `dream-html` section this replaces is 5,395.
   */
  const OPENUI_BRIEFING_MAX = 12_500;

  it('stays inside its measured bound', () => {
    expect(CHAT_SURFACE_BRIEFING_OPENUI.length).toBeLessThan(OPENUI_BRIEFING_MAX);
  });

  it('costs more than the default, and the gap is the generated vocabulary', () => {
    const extra = CHAT_SURFACE_BRIEFING_OPENUI.length - CHAT_SURFACE_BRIEFING.length;
    // Not an aesthetic assertion: if this gap ever collapses, the generation broke and the
    // agent is being handed an empty vocabulary while every other test still passes.
    expect(extra).toBeGreaterThan(1_500);
    expect(extra).toBeLessThan(4_000);
  });
});

describe('openui briefing — the spawn actually chooses it', () => {
  const spawn = readFileSync('src/server/routes/agent-chat.ts', 'utf-8');

  it('reads the setting and picks the variant', () => {
    // Without this the whole wave is a designed capability nobody wired — the failure mode
    // this project has a named memory about. The setting exists, the variant exists, and
    // nothing would ever hand it to a session.
    expect(spawn).toContain('readAgentUiChatRender');
    expect(spawn).toContain('CHAT_SURFACE_BRIEFING_OPENUI');
  });

  it('still reaches the default briefing for everyone else', () => {
    expect(spawn).toContain('CHAT_SURFACE_BRIEFING');
  });

  it('resolves it at SPAWN, inside the file-writing block', () => {
    // The mode must be decided where the briefing FILE is written — that is what makes a
    // running session keep the mode it started in, which the Settings copy promises.
    // Anchored on the WRITE, not on the flag: the flag's name also appears in the comment
    // block above, which made a first version of this assertion fail for the wrong reason.
    const write = spawn.indexOf('writeFileSync(brief');
    const pick = spawn.indexOf('readAgentUiChatRender()');
    expect(write).toBeGreaterThan(0);
    expect(pick).toBeGreaterThan(0);
    expect(pick).toBeLessThan(write);
  });
});
