import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { generateSubagentBriefing, measureSubagentBriefing } from '../../src/cli/commands/snapshot.js';
import {
  SUBAGENT_BRIEFING_BUDGET_TOKENS, SUBAGENT_BRIEFING_MAX_CHARS, resolveSubagentBriefingBudget,
} from '../../src/lib/snapshot-budget.js';
import { RECALL_GUIDANCE, TASK_CREATE_GUIDANCE, BRIEFING_RECOVERY_NOTE } from '../../src/lib/agent-guidance.js';

/**
 * The SubagentStart briefing's budget ladder.
 *
 * Every sub-agent pays for the briefing before its first tool call. Unbudgeted,
 * a mature brain produced ~92,000 chars, past the harness persist limit, so the
 * agent saw a 2,000-char preview and never the feature list or knowledge index
 * it was told to check first. These tests pin the cap, what always survives the
 * ladder (directives, override, every pinned file / pattern / feature NAMED or
 * COUNTED), and that a small brain is left exactly as it was.
 *
 * The large vault is fictional (synthetic-fixtures pattern): no real project,
 * person or path appears in it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SMALL_VAULT_CONTEXT = join(REPO_ROOT, 'tests', 'fixtures', 'snapshot-golden-people', 'vault', '_dream_context');

const TOPICS = ['harbor', 'lantern', 'meadow', 'quarry', 'orchard', 'beacon', 'cobalt', 'delta', 'ember', 'fjord'];
const pad = (n: number): string => String(n).padStart(3, '0');

interface LargeVault {
  context: string;
  pinned: string[];
  patterns: string[];
  features: string[];
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
}

/** 60 features, 150 knowledge files (8 pinned, 40 patterns), 20 tasks, an override. */
function buildLargeVault(base: string): LargeVault {
  const context = join(base, '_dream_context');
  write(join(context, 'core', '0.soul.md'),
    '---\nname: northwind-atlas\ntype: soul\n---\n\n## Project Identity\n\nNorthwind Atlas is a fictional route planner used only by this test.\n');
  write(join(context, 'core', '2.memory.md'), '---\nname: memory\ntype: memory\n---\n\n## Active Memory\n');
  write(join(context, 'core', '4.tech_stack.md'),
    '---\nname: Tech Stack\ntype: reference\nsummary: A fictional stack for the briefing fixture\n---\n\n# Tech Stack\n');
  write(join(context, 'overrides', 'task.md'), [
    '---', 'custom_fields:', '  - name: Estimate', '    type: text', '    required: true', '    ask: true',
    '    prompt: How long will this take? Ask the user, do not guess.', '---', '', '## Task', '',
    '## Agent Instructions', '', 'Every task carries an Estimate.', '',
  ].join('\n'));

  const features: string[] = [];
  for (let i = 1; i <= 60; i++) {
    const slug = `route-feature-${pad(i)}`;
    features.push(slug);
    write(join(context, 'knowledge', 'features', `${slug}.md`), [
      '---', `status: ${i % 3 === 0 ? 'active' : 'shipped'}`, 'tags: [routing, fixture]',
      `related_tasks: [route-task-${pad(i)}]`, '---', '', '## Why', '',
      `Fictional feature ${i} exists so the briefing ladder has a long, realistic feature list to shrink.`, '',
    ].join('\n'));
  }

  const pinned: string[] = [];
  const patterns: string[] = [];
  for (let i = 1; i <= 150; i++) {
    const topic = TOPICS[i % TOPICS.length];
    let rel: string;
    let extra = '';
    if (i <= 8) {
      rel = `pinned-${topic}-${pad(i)}`;
      pinned.push(rel);
      extra = 'pinned: true\n';
    } else if (i <= 48) {
      rel = `patterns/${topic}-rule-${pad(i)}`;
      patterns.push(rel);
    } else {
      rel = `${topic}/note-${pad(i)}`;
    }
    write(join(context, 'knowledge', `${rel}.md`),
      `---\nname: ${topic} ${i}\ndescription: Fictional note ${i} about the ${topic} area, long enough to be worth demoting when the budget is tight.\ntype: knowledge\n${extra}tags:\n  - 'topic:${topic}'\n---\n\nBody ${i}.\n`);
  }

  for (let i = 1; i <= 20; i++) {
    write(join(context, 'state', `route-task-${pad(i)}.md`), [
      '---', `name: Route task ${i} keeps the fixture busy`, 'status: in_progress', 'priority: high',
      `created_at: "2026-01-${String((i % 28) + 1).padStart(2, '0')}"`, '---', '', `Fictional task ${i}.`, '',
    ].join('\n'));
  }
  return { context, pinned, patterns, features };
}

/** How many of `slugs` the text names, plus what a `+N` tail for `noun` counts without naming. */
function namedOrCounted(text: string, slugs: string[], noun: string): number {
  const named = slugs.filter((s) => text.includes(s)).length;
  const escaped = noun.replace(/[()]/g, '\\$&');
  // Pattern tail: "- (+N more pattern(s): a, b — +M unnamed — ...)": the named ones are counted above.
  const unnamed = [...text.matchAll(new RegExp(`\\+\\d+ more ${escaped}:[^\\n]*?\\+(\\d+) unnamed`, 'g'))]
    .reduce((sum, m) => sum + Number(m[1]), 0);
  // Feature roster: "- a, b (+N more feature(s))": the N are counted, not named.
  const counted = [...text.matchAll(new RegExp(`\\(\\+(\\d+) more ${escaped}\\)`, 'g'))]
    .reduce((sum, m) => sum + Number(m[1]), 0);
  return named + unnamed + counted;
}

let tmp: string;
let originalHome: string | undefined;
let originalBudget: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dc-briefing-'));
  originalHome = process.env.HOME;
  originalBudget = process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  // An empty HOME: no linked-repo registry, no machine state leaks into the render.
  process.env.HOME = join(tmp, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalBudget === undefined) delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  else process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = originalBudget;
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveSubagentBriefingBudget', () => {
  it('uses the briefing default when unset, empty, or a number (numbers are the snapshot\'s)', () => {
    expect(resolveSubagentBriefingBudget(undefined)).toBe(SUBAGENT_BRIEFING_BUDGET_TOKENS);
    expect(resolveSubagentBriefingBudget('')).toBe(SUBAGENT_BRIEFING_BUDGET_TOKENS);
    expect(resolveSubagentBriefingBudget('9000')).toBe(SUBAGENT_BRIEFING_BUDGET_TOKENS);
  });

  it('lifts the budget on the shared escape hatch', () => {
    for (const off of ['0', 'off', 'OFF', 'false']) expect(resolveSubagentBriefingBudget(off)).toBeNull();
  });

  it('leaves room for the budget note under the hard cap', () => {
    // estimateTokens is ceil(chars / 4): the body can reach budget * 4 chars.
    expect(SUBAGENT_BRIEFING_BUDGET_TOKENS * 4 + 300).toBeLessThanOrEqual(SUBAGENT_BRIEFING_MAX_CHARS);
  });
});

describe('sub-agent briefing on a large brain', () => {
  let vault: LargeVault;
  beforeEach(() => { vault = buildLargeVault(join(tmp, 'project')); });

  it('fits the hard cap, budget note included, without exhausting the ladder', () => {
    const m = measureSubagentBriefing({ root: vault.context });
    expect(m.text.length).toBeLessThanOrEqual(SUBAGENT_BRIEFING_MAX_CHARS);
    expect(m.overBudget).toBe(false);
    expect(m.demoted.length).toBeGreaterThan(0);
    expect(m.bodyChars).toBeLessThanOrEqual(SUBAGENT_BRIEFING_BUDGET_TOKENS * 4);
  });

  it('keeps the directive first, the recall line, and the task-format override', () => {
    const text = generateSubagentBriefing({ root: vault.context });
    expect(text.indexOf('MANDATORY')).toBeGreaterThan(-1);
    expect(text.indexOf('MANDATORY')).toBeLessThan(500);
    expect(text).toContain('MUST check the feature list');
    expect(text).toContain('BEFORE using Glob, Grep, or searching code');
    expect(text).toContain('ACTIVE TASK-FORMAT OVERRIDE:');
    expect(text).toContain('Estimate');
  });

  it('names every pinned file', () => {
    const text = generateSubagentBriefing({ root: vault.context });
    for (const slug of vault.pinned) expect(text).toContain(slug);
  });

  it('names or counts every pattern and every feature', () => {
    const text = generateSubagentBriefing({ root: vault.context });
    expect(namedOrCounted(text, vault.patterns, 'pattern(s)')).toBe(vault.patterns.length);
    expect(namedOrCounted(text, vault.features, 'feature(s)')).toBe(vault.features.length);
  });

  it('carries the shared guidance verbatim and a briefing-specific budget note', () => {
    const text = generateSubagentBriefing({ root: vault.context });
    expect(text).toContain(RECALL_GUIDANCE);
    expect(text).toContain(TASK_CREATE_GUIDANCE);
    expect(text).toContain('sections demoted to fit the briefing budget');
    expect(text).toContain(BRIEFING_RECOVERY_NOTE);
    // Untrue for the briefing: at the floor, features and knowledge have no path.
    expect(text).not.toContain('keeps its file path above');
    expect(text).not.toContain('snapshot budget');
  });

  it('is unbounded with budgetTokens: null, and on the DREAMCONTEXT_SNAPSHOT_BUDGET=off switch', () => {
    const unbounded = generateSubagentBriefing({ root: vault.context, budgetTokens: null });
    expect(unbounded.length).toBeGreaterThan(SUBAGENT_BRIEFING_MAX_CHARS);
    expect(unbounded).not.toContain('Budget note');
    process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = 'off';
    expect(generateSubagentBriefing({ root: vault.context })).toBe(unbounded);
  });

  it('ignores a numeric DREAMCONTEXT_SNAPSHOT_BUDGET: that number sizes the snapshot, not the briefing', () => {
    const byDefault = generateSubagentBriefing({ root: vault.context });
    process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = '9000';
    expect(generateSubagentBriefing({ root: vault.context })).toBe(byDefault);
  });

  it('keeps every name at the floor, with the budget note excluded from the body count', () => {
    const floor = measureSubagentBriefing({ root: vault.context, budgetTokens: 1 });
    expect(floor.overBudget).toBe(true);
    expect(floor.bodyChars).toBeLessThan(floor.text.length);
    for (const slug of vault.pinned) expect(floor.text).toContain(slug);
    expect(namedOrCounted(floor.text, vault.patterns, 'pattern(s)')).toBe(vault.patterns.length);
    expect(namedOrCounted(floor.text, vault.features, 'feature(s)')).toBe(vault.features.length);
    expect(floor.text).toContain('is still over budget');
    expect(floor.text).toContain('pin fewer files or retire stale patterns');
  });
});

describe('sub-agent briefing on a small brain', () => {
  it('fits at level 0: the ladder does not run and the render equals the unbounded one', () => {
    const m = measureSubagentBriefing({ root: SMALL_VAULT_CONTEXT });
    expect(m.demoted).toEqual([]);
    expect(m.text).not.toContain('Budget note');
    expect(m.text).toBe(generateSubagentBriefing({ root: SMALL_VAULT_CONTEXT, budgetTokens: null }));
  });

  it('keeps the full level-0 shapes the integration suite pins', () => {
    const text = generateSubagentBriefing({ root: SMALL_VAULT_CONTEXT });
    expect(text).toContain('# Agent Context -- Sub-agent Briefing');
    expect(text).toContain('--> Read: _dream_context/knowledge/features/login-flow.md');
    expect(text).toContain('## Knowledge Index');
    expect(text).toContain('## Core Files');
    expect(text).toContain('## Task Awareness');
    expect(text).toContain('save this plan as an dreamcontext task');
    expect(text).toContain('## Context Directory');
  });

  it('no longer teaches the three stale facts', () => {
    const text = generateSubagentBriefing({ root: SMALL_VAULT_CONTEXT });
    expect(text).not.toContain('BM25');
    expect(text).not.toContain('user (1)');
    expect(text).not.toContain('--status pending');
    expect(text).toContain('`_dream_context/people/`');
  });

  it('is unchanged by rendering (no side effects on the fixture)', () => {
    const sleep = join(SMALL_VAULT_CONTEXT, 'state', '.sleep.json');
    const before = readFileSync(sleep, 'utf-8');
    generateSubagentBriefing({ root: SMALL_VAULT_CONTEXT });
    expect(readFileSync(sleep, 'utf-8')).toBe(before);
  });
});

// Opt-in measurement of THIS repository's own brain (plan-r3 T1): prints the
// briefing at the default budget and with every section forced to its floor.
// Non-hermetic by design, so it only runs when asked for.
describe.runIf(process.env.MEASURE_THIS_BRAIN === '1')('measure this repository\'s brain', () => {
  it('reports the briefing size at the default budget and at the floors', () => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    const context = join(REPO_ROOT, '_dream_context');
    const byDefault = measureSubagentBriefing({ root: context });
    const floors = measureSubagentBriefing({ root: context, budgetTokens: 1 });
    const bytes = (s: string): number => Buffer.byteLength(s, 'utf-8');
    console.log(JSON.stringify({
      default: {
        chars: byDefault.text.length, bytes: bytes(byDefault.text), bodyChars: byDefault.bodyChars,
        overBudget: byDefault.overBudget, demoted: byDefault.demoted,
      },
      floors: { chars: floors.text.length, bodyChars: floors.bodyChars, overBudget: floors.overBudget },
    }, null, 2));
    expect(byDefault.text.length).toBeLessThanOrEqual(SUBAGENT_BRIEFING_MAX_CHARS);
    expect(byDefault.overBudget).toBe(false);
    expect(floors.bodyChars).toBeLessThanOrEqual(SUBAGENT_BRIEFING_BUDGET_TOKENS * 4);
  }, 120_000);
});
