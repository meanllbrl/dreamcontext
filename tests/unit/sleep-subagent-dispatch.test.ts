import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUBAGENT_DISPATCH_AUTHORIZATION } from '../../src/cli/commands/hook.js';
import { buildSleepPrompt } from '../../src/server/routes/launcher.js';

/**
 * SPEC — sub-agent dispatch survives the injected "don't call the AgentTool" line.
 *
 * Claude Code ≥2.1.220 appends two lines to the system prompt of every Opus 5
 * session (binary constant, remote key `tengu_heron_brook`, gated on the
 * `opus_5_prompt_bundle` — no user-facing setting disables it):
 *
 *     Do not call the AgentTool unless the user requested it
 *     Do not use workflows or deep-research unless the user requested it
 *
 * That outranks SKILL.md, and sleep silently degraded to running every specialist
 * INLINE — losing the disjoint-file-domain no-stomp guarantee and the per-agent
 * context budget in one go. The fix routes the request through the three surfaces
 * the CLI actually accepts as "the user": the UserPromptSubmit hook (which Claude
 * Code's own system prompt says to treat as coming from the user), and the two
 * launcher prompts, which ARE literal user turns.
 *
 * These assertions are deliberately about the CONTRACT, not the wording: each
 * surface must name the Agent-tool dispatch and forbid the inline fallback. Reword
 * freely; keep those two claims.
 */

const repoRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8');

describe('sub-agent dispatch authorization', () => {
  describe('UserPromptSubmit hook line', () => {
    it('names the escape hatch the injected instruction actually offers', () => {
      // The injected line permits dispatch "unless the user requested it" — the
      // authorization has to assert the request, not argue the instruction is wrong.
      expect(SUBAGENT_DISPATCH_AUTHORIZATION).toMatch(/pre-authorized by the user/i);
      expect(SUBAGENT_DISPATCH_AUTHORIZATION).toMatch(/IS the user requesting/i);
    });

    it('covers every fan-out flow, so no skill is left arguing its own case', () => {
      for (const flow of [
        'sleep-tasks', 'sleep-state', 'sleep-product', 'sleep-migration',
        'sleep-federation', 'sleep-learn',
        'curator', 'initializer', 'goal-skill', 'dreamcontext-deep-research',
        'council', 'multi-review',
        // The Plan and Develop chat MODES are here too: their briefings are system-prompt
        // appends, which cannot satisfy an injected line that asks for a USER request.
        // Drop these and plan mode reviews its own plan inline while develop mode signs
        // off on its own diff (server/chat-modes.ts).
        'goal-plan-reviewer', 'goal-validator',
      ]) {
        expect(SUBAGENT_DISPATCH_AUTHORIZATION).toContain(flow);
      }
    });

    it('stays scoped — it is not a blanket licence to spawn agents', () => {
      // Without this clause the line reads as "sub-agents are always fine", which
      // trades one failure mode (never dispatching) for a costlier one.
      expect(SUBAGENT_DISPATCH_AUTHORIZATION).toMatch(/does not authorize ad-hoc/i);
    });

    it('is emitted before the consolidation-lock early return', () => {
      // A prompt sent mid-sleep is exactly when the orchestrator decides whether to
      // dispatch the next specialist; if the lock return swallowed the line, the
      // turn that most needs it is the one that loses it.
      const src = read('src/cli/commands/hook.ts');
      const emitted = src.indexOf('console.log(SUBAGENT_DISPATCH_AUTHORIZATION)');
      const lockReturn = src.indexOf('if (lock.locked && !lock.stale) {', emitted);
      expect(emitted).toBeGreaterThan(-1);
      expect(lockReturn).toBeGreaterThan(emitted);
    });
  });

  describe('launcher prompts (literal user turns)', () => {
    // The desktop constant is a .ts module in the dashboard workspace; read it as
    // text so this suite stays in the CLI's tsconfig without a cross-project import.
    const desktopPrompt = read('dashboard/src/lib/sleepAgent.ts');

    it('the desktop Sleep button requests the fan-out explicitly', () => {
      const body = desktopPrompt.slice(desktopPrompt.indexOf('export const SLEEP_AGENT_PROMPT'));
      expect(body).toMatch(/explicitly requesting the sub-agent fan-out/i);
      expect(body).toMatch(/PARALLEL sub-agents via the Agent tool/i);
      expect(body).toMatch(/do NOT run those passes inline/i);
    });

    it('SLEEP_AGENT_PROMPT stays newline-free (a bare \\n submits early in readline)', () => {
      const start = desktopPrompt.indexOf('export const SLEEP_AGENT_PROMPT');
      const end = desktopPrompt.indexOf(';', desktopPrompt.indexOf('consolidated.', start));
      const literal = desktopPrompt.slice(start, end);
      // Concatenated source lines are fine; an escaped newline inside a segment is not.
      expect(literal).not.toMatch(/\\n/);
    });

    it('the headless Sleep button requests it at every depth', () => {
      for (const depth of ['light', 'standard', 'deep'] as const) {
        const prompt = buildSleepPrompt(depth);
        expect(prompt).toMatch(/explicitly requesting the sub-agent fan-out/i);
        expect(prompt).toMatch(/PARALLEL sub-agents via the Agent tool/i);
        expect(prompt).toMatch(/do NOT run those passes inline/i);
      }
    });

    it('keeps the depth guard intact alongside the new clause', () => {
      // The fan-out sentence sits next to the destructive-authorization branch;
      // a careless edit to one is the realistic way to drop the other.
      expect(buildSleepPrompt('deep')).toMatch(/you ARE authorized/i);
      expect(buildSleepPrompt('light')).toMatch(/do NOT merge/i);
      expect(buildSleepPrompt('standard')).toMatch(/do NOT merge/i);
    });
  });

  describe('skill instructions', () => {
    it('SKILL.md states the dispatch is requested rather than optional', () => {
      const skill = read('skill/SKILL.md');
      expect(skill).toMatch(/Sub-agent dispatch is REQUESTED, not optional/);
      expect(skill).toMatch(/already satisfied/i);
      // The specific rationalization that produced the regression: "this cycle is
      // small, inline is fine."
      expect(skill).toMatch(/size is not the criterion/i);
    });

    it('sleep.md distinguishes orchestrator-runs-directly from specialists-are-inline', () => {
      // The old line ("the main agent runs the orchestration directly") was true but
      // misread as permission to do the specialist work inline too.
      const ref = read('skill/references/sleep.md');
      expect(ref).toMatch(/specialist passes themselves are \*\*always\*\* sub-agents/i);
    });
  });
});
