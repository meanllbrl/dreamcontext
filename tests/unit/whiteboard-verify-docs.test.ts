/**
 * How an agent verifies a whiteboard is written where it will look, and stays written: never
 * a browser or the user's dashboard; `show`, the overlap check and `render` instead. An agent
 * once opened the user's dashboard with Playwright to "see" a board because the excalidraw
 * skill pointed at a renderer that does not ship. These pins keep both halves fixed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf-8');

const WHITEBOARDS_MD = read('skill', 'references', 'whiteboards.md');
const CLI_REFERENCE_MD = read('skill', 'references', 'cli-reference.md');
const SKILL_MD = read('skill', 'SKILL.md');
const EXCALIDRAW_SKILL = read('skill-packs', 'excalidraw', 'SKILL.md');

describe('the no-browser verification rule', () => {
  it('whiteboards.md states it and names the three checks', () => {
    expect(WHITEBOARDS_MD).toContain("**Never verify a whiteboard with Playwright or any browser, and never touch the user's open dashboard**");
    expect(WHITEBOARDS_MD).toContain('Verify with `whiteboard show --json`, the overlap check every write runs, and `whiteboard render`');
  });

  it('the excalidraw skill states it and points at a renderer that ships', () => {
    expect(EXCALIDRAW_SKILL).toContain("**Never verify with Playwright or any browser, and never touch the user's open dashboard or Obsidian");
    expect(EXCALIDRAW_SKILL).toContain('dreamcontext whiteboard render --file <board.excalidraw.md>');
    expect(EXCALIDRAW_SKILL).not.toContain('render-excalidraw.mjs');
  });

  it('the dreamcontext skill routes verification to render', () => {
    expect(SKILL_MD).toContain('Verify with `whiteboard render`, never a browser');
  });
});

describe('placement and render are documented', () => {
  it('whiteboards.md has the section, place, --below and render', () => {
    expect(WHITEBOARDS_MD).toContain('## Placing without collisions, and looking at the result');
    expect(WHITEBOARDS_MD).toContain('dreamcontext whiteboard place <slug> --size');
    expect(WHITEBOARDS_MD).toContain('`draw|add --below <tag>`');
    expect(WHITEBOARDS_MD).toContain('--allow-overlap');
    expect(WHITEBOARDS_MD).toContain('dreamcontext whiteboard render <slug> --tag');
  });

  it('cli-reference.md has a row for place and render, and the overlap refusal on draw', () => {
    expect(CLI_REFERENCE_MD).toContain('| `whiteboard place <slug> --size');
    expect(CLI_REFERENCE_MD).toContain('| `whiteboard render [slug] --out <file.png>`');
    expect(CLI_REFERENCE_MD).toContain('`{error: "overlap", box, overlaps, groups, hint}`');
  });
});

/**
 * Owner, 2026-10-21: "whiteboard'a yazı yazma ve çizim yapma excalidraw skill'ine göre olsun".
 * An explanation on a whiteboard is a drawing from the excalidraw kit, never a stack of notes;
 * only a live metric is a widget. These pins keep both skills saying so, from both sides.
 */
describe('an explanation on a whiteboard is drawn with the excalidraw kit', () => {
  const KIT_MD = read('skill-packs', 'excalidraw', 'reference', 'whiteboard-kit.md');

  it('whiteboards.md makes drawing the default and points at the kit', () => {
    expect(WHITEBOARDS_MD).toContain('**Anything you explain or show on a whiteboard is drawn, not written.**');
    expect(WHITEBOARDS_MD).toContain('### (c) Explaining or showing something: draw it with the kit');
    expect(WHITEBOARDS_MD).toContain('dreamcontext whiteboard draw <slug> --spec <spec.json>');
    expect(WHITEBOARDS_MD).toContain('dreamcontext whiteboard kit');
    expect(WHITEBOARDS_MD).toContain('**A picture is part of the drawing.**');
    expect(WHITEBOARDS_MD).toContain('**Keep it current: redraw in place.**');
    expect(WHITEBOARDS_MD).not.toContain('A heading or a short explanation is a `note`');
    // The live-data rule is unchanged.
    expect(WHITEBOARDS_MD).toContain('**A number on a whiteboard is a live widget, never a drawing.**');
  });

  it('the excalidraw skill no longer turns itself away from a whiteboard, only from its metrics', () => {
    const description = EXCALIDRAW_SKILL.slice(0, EXCALIDRAW_SKILL.indexOf('\n---', 4));
    expect(description).not.toContain('NOT for a dreamcontext whiteboard');
    expect(description).toMatch(/description: >-\n {2}The visual-first drawing kit\. Draws and writes on a dreamcontext whiteboard/);
    expect(description).toContain('`dreamcontext whiteboard draw <board> --spec`');
    expect(description).toContain('only a live METRIC there is an insight widget');
    expect(EXCALIDRAW_SKILL).toContain('> **Drawing on a dreamcontext whiteboard**');
    expect(EXCALIDRAW_SKILL).not.toContain('STOP if the target is a dreamcontext whiteboard');
    expect(EXCALIDRAW_SKILL).toContain('**A number on a whiteboard (MRR, revenue, signups, a trend, a split) is a live');
  });

  it('the kit reference is what `whiteboard kit` prints, and the CLI reference names both verbs', () => {
    expect(KIT_MD).toContain('`dreamcontext whiteboard kit` prints this page.');
    // A board agent learns the loop from this page: its render example must be one it may run.
    expect(KIT_MD).toContain('--out $DREAMCONTEXT_AGENT_SCRATCH/look.png');
    expect(KIT_MD).not.toMatch(/--out look\.png/);
    expect(CLI_REFERENCE_MD).toContain('| `whiteboard kit` |');
    expect(CLI_REFERENCE_MD).toContain('| `whiteboard draw <slug> --spec <spec.json>` |');
  });

  it('SKILL.md routes a whiteboard explanation to a drawing', () => {
    expect(SKILL_MD).toContain('Explain = draw (`draw --spec`)');
    expect(SKILL_MD).toContain('Explaining is a drawing (excalidraw kit), never notes');
  });
});
