/**
 * Independent waves start together (owner, 2026-11-08: "yap mutlaka, insanlar gereksiz yere
 * bekliyor"). A five-wave Telegram plan was written as one chain W1→W5 and the Super queued it in
 * that order, though W2 and W3 used only W1's contract and W4 and W5 only W2+W3's: three levels.
 * No code computes levels from a map, so the rule is text, and every copy of it says the same.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEVELOP_RECIPE, FAN_OUT_RECIPE } from '../../src/lib/develop-recipe.js';
import { PLANNER_BRIEF } from '../../src/lib/planner-brief.js';
import { modeBriefing } from '../../src/server/chat-modes.js';
import { toolText } from '../../src/lib/tool-text.js';

const read = (p: string): string => readFileSync(join(__dirname, '..', '..', p), 'utf-8');
const flat = (s: string): string => s.replace(/\s+/g, ' ');

describe('a wave is a level of the dependency graph', () => {
  it.each([
    ['skill-packs/goal-skill/SKILL.md', read('skill-packs/goal-skill/SKILL.md')],
    ['skill-packs/agents/goal-planner.md', read('skill-packs/agents/goal-planner.md')],
    ['planner brief', PLANNER_BRIEF],
    ['develop recipe', DEVELOP_RECIPE],
  ])('%s: a wave names what it waits for, and contract names count against the wave that pins them', (_name, text) => {
    const t = flat(text);
    expect(t).toMatch(/a wave is a level of the dependency graph/i);
    expect(t).toContain('W3 (after W1)');
    expect(t).toMatch(/only names a contract pins .*waits for the wave that pins them/i);
  });

  it('the planner and goal-skill run one level at once, then merge', () => {
    expect(flat(read('skill-packs/goal-skill/SKILL.md'))).toContain('Waves of one level run at the same time in separate sessions, and one merge-and-test step follows each level.');
    expect(flat(read('skill-packs/agents/goal-planner.md'))).toContain('built at the same time in separate sessions, then one merge-and-test step');
  });

  it('a chain the dependencies do not force is a Major map finding', () => {
    expect(flat(read('skill-packs/goal-skill/SKILL.md'))).toContain('A chain the dependencies do not force is a Major `map` finding');
    const reviewer = flat(read('skill-packs/agents/goal-plan-reviewer.md'));
    expect(reviewer).toContain('And is every chain forced?');
    expect(reviewer).toContain('is a Major `kind: map` finding');
    expect(reviewer).toContain('The pragmatist lists the same as a proposal');
    expect(flat(FAN_OUT_RECIPE)).toContain('a chain they do not force is a wrong map');
  });

  it('the Super starts a plan\'s waves level by level, with a merge unit after each', () => {
    const guide = flat(read('skill/references/super-orchestration.md'));
    expect(guide).toContain('A plan\'s own waves too: read its map by level');
    expect(guide).toContain('start every wave of a level at once, then one merge unit per level (`super merge`, sonnet medium)');
    expect(guide).toContain('A busy machine changes nothing: heavy steps queue themselves.');
  });

  it('the Plan brief says it on every tool', () => {
    for (const tool of ['claude', 'codex', 'antigravity'] as const) {
      const base = modeBriefing('plan', { worktreeAllowed: false });
      const brief = flat(tool === 'claude' ? base : toolText(base, tool));
      expect(brief, tool).toContain('a wave is a level, not a step');
      expect(brief, tool).toContain('waves of one level run at once');
    }
  });
});
