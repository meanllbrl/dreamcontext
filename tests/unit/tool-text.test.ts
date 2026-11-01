/**
 * Every text of ours a Codex or Antigravity turn reads is in that tool's words: no "Skill tool",
 * "Agent tool", subagent_type or a sub-agent model rule. Claude's text never passes through, so
 * it stays byte for byte (the recipe golden below; the hook's in hook-golden.test.ts).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { goalLiveRecipe } from '../../src/cli/commands/goal-live.js';
import { GOAL_LIVE_RECIPES } from '../../src/lib/develop-recipe.js';
import { CLAUDE_ONLY, forEnvTool, toolNote, toolText, type TextTool } from '../../src/lib/tool-text.js';
import { CHAT_SURFACE_BRIEFING, SUPER_CHILD_BRIEFING } from '../../src/server/chat-surface.js';
import { CHAT_MODES, modeBriefing } from '../../src/server/chat-modes.js';
import { TOOL_SKILL_SOURCES } from '../../src/lib/tool-skills.js';

const ROOT = resolve(import.meta.dirname, '../..');
const TOOLS: TextTool[] = ['codex', 'antigravity'];

/** Each offending line, so a failure names the phrase a new rule needs. */
const leftovers = (text: string): string[] => text.split('\n').filter((l) => CLAUDE_ONLY.test(l));

const mdFiles = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) mdFiles(p, out);
    else if (n.endsWith('.md')) out.push(p);
  }
  return out;
};

describe('toolText', () => {
  it('rewrites the phrases a briefing and a recipe use', () => {
    expect(toolText('ONE `review-router` sub-agent (Agent tool, model sonnet, effort low) told', 'codex')).toBe('ONE `review-router` sub-agent (spawn_agent, effort low) told');
    expect(toolText('ONE `reviewer` (model opus, effort high, not in the background)', 'codex')).toBe('ONE `reviewer` (effort high, not in the background)');
    expect(toolText('INVOKE any that fit via the Skill tool', 'codex')).toBe('INVOKE any that fit by opening its SKILL.md');
    expect(toolText('the Agent tool with `subagent_type` set', 'codex')).toBe('spawn_agent with `agent_type` set');
    expect(toolText('the Agent tool with `subagent_type` set', 'antigravity')).toBe('a role you run yourself with `role` set');
    // A dreamcontext CLI flag is not Claude's harness: `--model sonnet` stays.
    expect(toolText('`dreamcontext super send --model sonnet`', 'codex')).toBe('`dreamcontext super send --model sonnet`');
  });

  it('leaves no Claude-only phrase in any chat briefing, for every mode', () => {
    const briefs = [CHAT_SURFACE_BRIEFING, SUPER_CHILD_BRIEFING, ...CHAT_MODES.flatMap((m) => [true, false].map((w) => modeBriefing(m, { worktreeAllowed: w })))];
    for (const tool of TOOLS) for (const b of briefs) expect(leftovers(toolText(b, tool))).toEqual([]);
  });

  it('leaves no Claude-only phrase in a recipe a bridge chat prints', () => {
    for (const tool of TOOLS) for (const [name, text] of Object.entries(GOAL_LIVE_RECIPES)) expect(leftovers(toolText(text, tool)), name).toEqual([]);
  });

  it('rewrites the verbs in every shipped skill', () => {
    const verbs = /\bSkill tool\b|\bAgent tool\b|\bsubagent_type\b/;
    for (const sub of TOOL_SKILL_SOURCES) {
      for (const f of mdFiles(join(ROOT, sub))) {
        for (const tool of TOOLS) expect(toolText(readFileSync(f, 'utf-8'), tool).split('\n').filter((l) => verbs.test(l)), f).toEqual([]);
      }
    }
  });

  it('the notes are themselves free of what they explain away, but for the quoted names', () => {
    for (const tool of TOOLS) {
      const note = toolNote(tool, { roles: ['reviewer'], roleDirs: ['/x/agents'] });
      expect(note).toContain('SKILL.md');
      expect(note).toMatch(/opus, sonnet, haiku, fable/);
    }
    expect(toolNote('codex', { roles: ['reviewer', 'goal-planner'] })).toContain('Configured roles: reviewer, goal-planner.');
    expect(toolNote('codex')).toContain('spawn_agent with agent_type X');
    expect(toolNote('antigravity', { roleDirs: ['/x/agents'] })).toContain('No sub-agents here');
  });
});

describe('recipe output per tool', () => {
  it('Claude and a terminal print the recipe byte for byte', () => {
    let out = '';
    const before = process.env.DREAMCONTEXT_AGENT_TOOL;
    delete process.env.DREAMCONTEXT_AGENT_TOOL;
    try {
      goalLiveRecipe('develop', (t) => { out = t; });
    } finally {
      if (before !== undefined) process.env.DREAMCONTEXT_AGENT_TOOL = before;
    }
    expect(out).toBe(GOAL_LIVE_RECIPES.develop);
  });

  it('a Codex chat gets the same recipe in its words', () => {
    const codex = forEnvTool(GOAL_LIVE_RECIPES.develop, { DREAMCONTEXT_AGENT_TOOL: 'codex' });
    expect(codex).not.toBe(GOAL_LIVE_RECIPES.develop);
    expect(leftovers(codex)).toEqual([]);
    expect(forEnvTool('the Agent tool', { DREAMCONTEXT_AGENT_TOOL: 'claude' })).toBe('the Agent tool');
  });
});

describe('the worktree sentence on a tool with no worktree tool (TABLO row 39)', () => {
  it('points at git worktree add and the checkout block, on both tools', async () => {
    const { toolText } = await import('../../src/lib/tool-text.js');
    for (const tool of ['codex', 'antigravity'] as const) {
      const out = toolText('Moving checkout? Prefer the EnterWorktree tool. The shelf reads it.', tool);
      expect(out).not.toContain('EnterWorktree');
      expect(out).toContain('git worktree add');
      expect(out).toContain('`checkout` block');
    }
  });
});
