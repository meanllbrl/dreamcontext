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
