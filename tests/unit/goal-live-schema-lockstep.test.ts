/**
 * Lockstep for the goal-skill live file: ONE schema, three places that must agree.
 *
 *   1. the WRITER, `src/lib/goal-live.ts` (the `dreamcontext goal-live` CLI's reducer);
 *   2. the READER, `dashboard/src/lib/goalLive.ts` (the quest map's types + normalizer),
 *      which cannot import from `src/` (separate bundle) and so MIRRORS the writer;
 *   3. the ORCHESTRATOR'S INSTRUCTIONS, `skill-packs/goal-skill/SKILL.md`, which is what an
 *      agent actually follows at 2 a.m. in someone else's project.
 *
 * A drift between any two reads as a working feature: the CLI writes a field the panel
 * never reads, or the skill documents a subcommand the CLI never grew. So the mirror is
 * pinned textually (see pattern-mirror-with-drift-test), and the skill's own snippets are
 * held to the two rules the team log depends on: a goal-live call is never a step of its
 * own, and a run that SUCCEEDED never deletes its file (the win beat and the "How this was
 * built" receipt are read from it).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { createProgram } from '../../src/cli/program.js';
import { JUDGE_ROLES, applyGoalLiveEvent, type GoalLiveEvent, type GoalLiveState } from '../../src/lib/goal-live.js';
import { ACTOR_ID_MAX, parseActorSpec, parseStatePairs } from '../../src/cli/commands/goal-live.js';
import { AGENT_ROLES, isJudgeRole, type AgentRoleId } from '../../dashboard/src/lib/agentRoles';
import { GOAL_LIVE_ID_MAX, normalizeGoalLive } from '../../dashboard/src/lib/goalLive';
import { goalLineage, goalQuest } from '../../dashboard/src/lib/quest';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf-8');

const WRITER = read('src', 'lib', 'goal-live.ts');
const READER = read('dashboard', 'src', 'lib', 'goalLive.ts');
const SKILL = read('skill-packs', 'goal-skill', 'SKILL.md');
const DEMO = read('skill-packs', 'goal-skill', 'assets', 'goal-skill-demo.cjs');

/** The live-state section of the skill: from its heading to the next `## `. */
const LIVE_SECTION = (() => {
  const start = SKILL.indexOf('## Live run state');
  if (start === -1) throw new Error('SKILL.md lost its "Live run state" section');
  const next = SKILL.indexOf('\n## ', start + 1);
  return SKILL.slice(start, next === -1 ? undefined : next);
})();

interface Fence { lang: string; body: string; heading: string }

/** Every fenced block in `md`, with its language tag and the nearest heading above it. */
function fences(md: string): Fence[] {
  const out: Fence[] = [];
  const re = /^```(\w*)\n([\s\S]*?)^```/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const before = md.slice(0, m.index);
    const headings = before.match(/^#{2,4} .*$/gm) ?? [];
    out.push({ lang: m[1], body: m[2], heading: headings[headings.length - 1] ?? '' });
  }
  return out;
}

/** Field names declared in `interface <name> { … }`, in source order. Brace-balanced, so a
 *  one-line declaration and a multi-line one read the same. */
function interfaceFields(src: string, name: string): string[] {
  const open = new RegExp(`interface ${name}\\s*\\{`).exec(src);
  if (!open) throw new Error(`${name} is not declared as an interface`);
  let depth = 1;
  let i = open.index + open[0].length;
  const from = i;
  while (depth > 0 && i < src.length) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    i += 1;
  }
  const body = src.slice(from, i - 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // Top-level members only: a nested object type's own keys are not fields of this one.
  let flat = '';
  let nested = 0;
  for (const ch of body) {
    if (ch === '{') nested += 1;
    if (nested === 0) flat += ch;
    if (ch === '}') nested -= 1;
  }
  return [...flat.matchAll(/(?:^|[;{\s])(\w+)\??\s*:/g)].map((f) => f[1]);
}

/** Every single-quoted string literal inside the first match of `re` in `src`. */
function literalsIn(src: string, re: RegExp): string[] {
  const m = re.exec(src);
  expect(m, `no match for ${re}`).toBeTruthy();
  return [...m![0].matchAll(/'([^']+)'/g)].map((l) => l[1]);
}

const GOAL_LIVE_LINE = /dreamcontext goal-live\b/;

describe('writer ↔ reader mirror (src/lib/goal-live.ts ↔ dashboard/src/lib/goalLive.ts)', () => {
  for (const name of ['GoalLiveFork', 'GoalLiveLineage', 'GoalLiveState']) {
    it(`${name} declares the same fields on both sides`, () => {
      expect(new Set(interfaceFields(READER, name))).toEqual(new Set(interfaceFields(WRITER, name)));
    });
  }

  it('the field reader is not vacuous (it finds the v3 fields it is meant to compare)', () => {
    expect(interfaceFields(WRITER, 'GoalLiveFork')).toEqual(expect.arrayContaining(['s', 'id', 'name', 'role', 'v']));
    expect(interfaceFields(WRITER, 'GoalLiveLineage')).toEqual(expect.arrayContaining(['a', 'k', 'from', 'r', 'ctx']));
    expect(interfaceFields(WRITER, 'GoalLiveState')).toEqual(expect.arrayContaining(['phase', 'judges', 'history', 'lineage']));
  });

  it('the lineage kinds are the same four words on both sides', () => {
    const kinds = /type GoalLineageKind\s*=[^;]+/;
    expect(new Set(literalsIn(READER, kinds))).toEqual(new Set(['spawn', 'fork', 'resume', 'fresh']));
    expect(new Set(literalsIn(WRITER, kinds))).toEqual(new Set(['spawn', 'fork', 'resume', 'fresh']));
  });

  it('every phase the writer accepts is one the reader knows (plus done)', () => {
    const written = literalsIn(WRITER, /GOAL_LIVE_PHASES\s*=\s*\[[^\]]*\]/);
    const known = literalsIn(READER, /GOAL_PHASES\s*=\s*\[[^\]]*\]/);
    expect(new Set(written)).toEqual(new Set([...known, 'done']));
  });

  it('the fork states are the same four words on both sides', () => {
    const states = /type GoalForkState\s*=[^;]+/;
    expect(new Set(literalsIn(READER, states))).toEqual(new Set(literalsIn(WRITER, states)));
  });

  it('JUDGE_ROLES is exactly the roles the dashboard registry calls judges', () => {
    const judges = (Object.keys(AGENT_ROLES) as AgentRoleId[]).filter(isJudgeRole);
    expect(new Set(JUDGE_ROLES)).toEqual(new Set(judges));
  });
});

describe('actor ids: the reader keeps every id the writer accepts', () => {
  const NOW = '2026-09-25T10:00:00.000Z';

  /** Fold events through the writer's reducer, then read the file the way the dashboard does. */
  function writeThenRead(events: GoalLiveEvent[]): ReturnType<typeof normalizeGoalLive> {
    let state: GoalLiveState | null = null;
    for (const ev of events) state = applyGoalLiveEvent(state, ev, NOW);
    return normalizeGoalLive(JSON.parse(JSON.stringify(state)));
  }

  it('both sides cap an id at the same length', () => {
    expect(GOAL_LIVE_ID_MAX).toBe(ACTOR_ID_MAX);
    expect(parseActorSpec('a'.repeat(ACTOR_ID_MAX))).toEqual([{ id: 'a'.repeat(ACTOR_ID_MAX) }]);
    expect(() => parseActorSpec('a'.repeat(ACTOR_ID_MAX + 1))).toThrow();
  });

  it('the longest id the writer accepts round-trips to the reader unchanged', () => {
    const lead = `planner-${'p'.repeat(ACTOR_ID_MAX - 8)}`;
    const [{ id }] = parseActorSpec(`impl-${'x'.repeat(ACTOR_ID_MAX - 5)}=Role registry`);
    expect(lead).toHaveLength(ACTOR_ID_MAX);
    expect(id).toHaveLength(ACTOR_ID_MAX);
    const n = writeThenRead([
      { type: 'start', goal: 'demo', session: null },
      { type: 'actor', id: lead, role: 'planner', kind: 'spawn' },
      { type: 'actor', id, role: 'implementer', kind: 'fork', from: lead },
    ])!;
    expect(n.impl!.forks!.map((f) => f.id)).toEqual([id]);
    expect(n.lineage!.map((e) => e.a)).toEqual([lead, id]);
    expect(n.lineage![1].from).toBe(lead);
  });

  it('a 13-char role id still finds its seat through quest.ts', () => {
    const n = writeThenRead([
      { type: 'start', goal: 'demo', session: null },
      { type: 'phase', phase: 'review' },
      { type: 'actor', id: 'plan-reviewer', role: 'plan-reviewer', kind: 'fresh', round: 1 },
      ...parseStatePairs(['plan-reviewer=NEEDS_WORK']),
    ])!;
    const node = goalLineage(n)!.root.children.find((c) => c.key === 'plan-reviewer');
    expect(node).toBeTruthy();
    expect(node!.verdict).toBe('needs-work');
    expect(node!.state).toBe('done');
  });

  it('two ids sharing a 12-char prefix stay two seats', () => {
    const n = writeThenRead([
      { type: 'start', goal: 'demo', session: null },
      { type: 'phase', phase: 'impl' },
      ...parseActorSpec('impl-role-registry,impl-role-regimen').map(({ id }): GoalLiveEvent =>
        ({ type: 'actor', id, role: 'implementer', kind: 'spawn' })),
    ])!;
    const keys = goalQuest(n).cast.map((m) => m.key);
    expect(keys).toEqual(['impl-role-registry', 'impl-role-regimen']);
  });
});

describe('SKILL.md documents the CLI that actually exists', () => {
  const program = createProgram();
  const goalLive = program.commands.find((c: Command) => c.name() === 'goal-live');

  it('the goal-live command is registered', () => {
    expect(goalLive, '`dreamcontext goal-live` is not in createProgram()').toBeTruthy();
  });

  it('every subcommand the skill names is a real one', () => {
    const named = new Set([...LIVE_SECTION.matchAll(/dreamcontext goal-live (\w+)/g)].map((m) => m[1]));
    expect(named.size).toBeGreaterThanOrEqual(5);
    const real = new Set((goalLive?.commands ?? []).map((c: Command) => c.name()));
    for (const sub of named) expect(real.has(sub), `SKILL.md names \`goal-live ${sub}\``).toBe(true);
  });

  it('the schema reference block is a file the dashboard can read', () => {
    const block = fences(LIVE_SECTION).find((f) => f.lang === 'json');
    expect(block, 'the schema reference JSON block is missing').toBeTruthy();
    const state = normalizeGoalLive(JSON.parse(block!.body));
    expect(state).not.toBeNull();
    expect(state!.impl?.forks?.some((f) => !!f.name && f.role === 'implementer')).toBe(true);
    expect(state!.judges?.length).toBeGreaterThan(0);
    expect(state!.history?.length).toBeGreaterThan(0);
    expect(state!.lineage?.some((e) => e.k === 'fork' && typeof e.ctx === 'number')).toBe(true);
  });

  it('the demo writes the lineage the receipt is drawn from', () => {
    expect(DEMO).toContain('lineage');
    expect(DEMO).toContain('judges');
  });
});

describe('the orchestrator never spends a step on bookkeeping', () => {
  const FIRST_CALL_MARK = '# first call of the dispatch message';
  const blocks = fences(LIVE_SECTION)
    .filter((f) => f.lang === 'bash' && !/Command reference/i.test(f.heading));

  it('the section still has its snippets (the check below is not vacuous)', () => {
    expect(blocks.filter((b) => GOAL_LIVE_LINE.test(b.body)).length).toBeGreaterThanOrEqual(6);
    expect(blocks.some((b) => b.body.includes(FIRST_CALL_MARK))).toBe(true);
  });

  it('every goal-live line is chained onto real work, or rides first in a dispatch message', () => {
    for (const b of blocks) {
      if (b.body.includes(FIRST_CALL_MARK)) continue;
      for (const line of b.body.split('\n')) {
        if (line.trim().startsWith('#') || !GOAL_LIVE_LINE.test(line)) continue;
        const realWork = line.split('&&').map((s) => s.trim())
          .filter((s) => s && !s.startsWith('dreamcontext goal-live'));
        expect(realWork.length, `a standalone goal-live step: ${line.trim()}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('a finished run keeps its file (the win beat and receipt are read from it)', () => {
  it('no instruction deletes the live file', () => {
    expect(SKILL).not.toMatch(/rm -f[^\n]*goal-skill-live/);
    expect(SKILL).not.toMatch(/delete YOUR file/i);
    expect(SKILL).not.toMatch(/find[^\n]*-delete/);
  });

  it('`goal-live clear` appears only on the escalation path', () => {
    const clears = fences(LIVE_SECTION)
      .filter((f) => f.lang === 'bash' && /goal-live clear/.test(f.body));
    expect(clears.length).toBeGreaterThan(0);
    for (const b of clears) expect(b.body, 'clear outside the escalation snippet').toMatch(/escalat/i);
  });

  it('both ends of a run mark it done and leave it in place', () => {
    const ends = fences(LIVE_SECTION)
      .filter((f) => f.lang === 'bash' && /goal-live phase done/.test(f.body)).map((f) => f.body);
    expect(ends.some((b) => /tasks status \S+ completed/.test(b))).toBe(true);
    expect(ends.some((b) => /tasks status \S+ in_review/.test(b))).toBe(true);
  });
});
