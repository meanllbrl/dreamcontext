import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEVELOP_RECIPE, FAN_OUT_RECIPE } from '../../src/lib/develop-recipe.js';
import { heavySuggestion } from '../../src/lib/run-budget.js';

/**
 * The full suite runs once per release cut (owner, 2026-11-08; task bir-is-tam-test-takimini-bir-
 * kez-kosar…, AC9). Measured on the 0.41.6 cut and Telegram W3: 156 of 327 minutes went to the full
 * suite, 81 of them to reruns made only to read red file names, because shipped instructions asked
 * for the whole suite again after every fix. These are the texts an agent reads; a wording change
 * that keeps the rule passes, one that brings the old rule back fails.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

function markdown(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir))) {
    const p = `${dir}/${e}`;
    if (e === 'node_modules' || e === 'examples') continue;
    if (statSync(join(ROOT, p)).isDirectory()) out.push(...markdown(p));
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}

const SHIPPED = [...markdown('skill'), ...markdown('skill-packs'), ...markdown('agents')];

describe('shipped text: the full suite once per cut, a red reruns only its files', () => {
  it('no shipped instruction asks for npm test after a build or a fix, or gives a red full suite a second run', () => {
    expect(SHIPPED.length).toBeGreaterThan(20);
    const texts = [...SHIPPED.map((p) => [p, read(p)] as const), ['develop recipe', DEVELOP_RECIPE] as const, ['fan-out recipe', FAN_OUT_RECIPE] as const];
    for (const [where, text] of texts) {
      expect(text, where).not.toMatch(/`npm test`/);
      expect(text, where).not.toMatch(/npm run build && npm test/);
      expect(text, where).not.toMatch(/a red earns one more/i);
      expect(text, where).not.toMatch(/full suite (?:runs )?only when the (?:Validation )?method names it/i);
      expect(text, where).not.toMatch(/run the actual suite via Bash/i);
    }
  });

  it('the recipes start a full suite detached and fix its reds with builder test --failed', () => {
    for (const recipe of [DEVELOP_RECIPE, FAN_OUT_RECIPE]) {
      expect(recipe).toMatch(/once per release cut, after its build/);
      expect(recipe).toMatch(/builder heavy --detach/);
      expect(recipe).toMatch(/--wait <id>/);
      expect(recipe).toMatch(/dreamcontext builder test --failed/);
      expect(recipe).toMatch(/A red full suite earns none/);
    }
  });

  it('goal-skill, goal-validator and the references say the new rule', () => {
    const goal = read('skill-packs/goal-skill/SKILL.md');
    expect(goal).toMatch(/The full suite is the release cut's, not a goal's/);
    expect(goal).toMatch(/the full suite only at a release cut/);
    expect(goal).toMatch(/builder test --related`\) plus tsc and a build/);
    const validator = read('skill-packs/agents/goal-validator.md');
    expect(validator).toMatch(/Never start a second full suite/);
    expect(validator).toMatch(/dreamcontext builder test --failed/);
    expect(read('skill/references/super-orchestration.md')).toMatch(/"related tests \+ tsc": the full suite runs once per release cut/);
    const cli = read('skill/references/cli-reference.md');
    expect(cli).toMatch(/`builder test --failed \[--related <files…>\] \[--also <tests…>\]`/);
    expect(cli).toMatch(/--detach/);
    expect(cli).toMatch(/--max-run <min>/);
    expect(cli).toMatch(/a full suite is limited by its record, not a count/);
    expect(read('skill/references/integrations.md')).toMatch(/its red files are rerun by `dreamcontext builder test --failed`/);
  });

  it('the hook sends a full suite to --detach, and to --failed while a red is open', () => {
    expect(heavySuggestion('npm test 2>&1 | tail -30')).toMatch(/^dreamcontext builder heavy --detach -- 'npm test', then dreamcontext builder heavy --wait <id>/);
    expect(heavySuggestion('npx vitest run', { redOpen: true })).toMatch(/^dreamcontext builder test --failed/);
    const hook = read('src/cli/commands/hook.ts');
    expect(hook).toMatch(/The full suite runs once per release cut, after its build; a fix reruns only the red files \(dreamcontext builder test --failed\)/);
    expect(hook).toMatch(/redOpen: kind === 'suite' && suiteRedOpen\(/);
  });
});
