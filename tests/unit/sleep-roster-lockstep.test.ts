/**
 * Docs-in-lockstep for WHICH sleep specialists a cycle dispatches. The roster is
 * stated on four code surfaces (the hook's directive, the dashboard Sleep button,
 * the headless Sleep button, the background dispatcher) and they drifted: none
 * named `sleep-learn` while the sleep reference dispatched it, and the retired
 * `sleep-federation` stayed on the tunable list. Every surface now states the
 * roster through `SLEEP_ROSTER_CLAUSE`; this test fails the moment one stops.
 * Mirror-with-drift-test pattern: the code is the source of truth.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SLEEP_ROSTER_CLAUSE, SLEEP_AGENT_PROMPT } from '../../src/lib/sleep-prompt.js';
import { SLEEP_FLOW_LINE } from '../../src/cli/commands/hook.js';
import { buildSleepPrompt } from '../../src/server/routes/launcher.js';
import { SLEEP_SPECIALISTS, RETIRED_SLEEP_SPECIALISTS } from '../../src/lib/setup-config.js';

const repoRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf-8');

const SURFACES: Array<[string, string]> = [
  ['SLEEP_FLOW_LINE (hook directive)', SLEEP_FLOW_LINE],
  ['SLEEP_AGENT_PROMPT (Sleep button + background dispatcher)', SLEEP_AGENT_PROMPT],
  ...(['light', 'standard', 'deep'] as const).map(
    (depth): [string, string] => [`buildSleepPrompt('${depth}')`, buildSleepPrompt(depth)],
  ),
];

describe('the sleep roster clause', () => {
  it('names every tunable specialist and no retired one', () => {
    for (const name of SLEEP_SPECIALISTS) expect(SLEEP_ROSTER_CLAUSE).toContain(name);
    for (const name of RETIRED_SLEEP_SPECIALISTS) expect(SLEEP_ROSTER_CLAUSE).not.toContain(name);
  });

  it('is newline-free and carries no em dash', () => {
    expect(SLEEP_ROSTER_CLAUSE).not.toMatch(/\n/);
    expect(SLEEP_ROSTER_CLAUSE).not.toContain('—');
  });

  it('never shares the tunable roster with the retired list', () => {
    const tunable = new Set<string>(SLEEP_SPECIALISTS);
    for (const name of RETIRED_SLEEP_SPECIALISTS) expect(tunable.has(name)).toBe(false);
  });
});

describe('every surface that asks for a sleep states the same roster', () => {
  it.each(SURFACES)('%s carries the clause verbatim', (_name, text) => {
    expect(text).toContain(SLEEP_ROSTER_CLAUSE);
  });

  it.each(SURFACES)('%s names sleep-learn and not sleep-federation', (_name, text) => {
    expect(text).toContain('sleep-learn');
    expect(text).not.toContain('sleep-federation');
  });
});

describe('the dashboard mirror of the tunable roster', () => {
  it('lists exactly SLEEP_SPECIALISTS, in order', () => {
    const source = read('dashboard/src/hooks/useConfig.ts');
    const start = source.indexOf('export const SLEEP_SPECIALISTS = [');
    expect(start, 'SLEEP_SPECIALISTS not found in dashboard/src/hooks/useConfig.ts').toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf(']', start));
    const names = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names).toEqual([...SLEEP_SPECIALISTS]);
  });
});

/**
 * The docs half. An agent learns the roster from the skill, not from the hook's
 * one-line directive, so the always-loaded SKILL.md must carry the same clause and
 * the sleep reference must dispatch `sleep-learn`. A retired specialist may still be
 * NAMED in shipped docs, but only on a line that says it is retired; a line telling
 * an agent to fire it would resurrect a dispatch the code no longer supports.
 */
describe('the shipped docs state the same roster', () => {
  const SHIPPED_DOC_ROOTS = ['skill', 'agents', 'skill-packs', 'src/templates'];

  function markdownFiles(rel: string): string[] {
    const abs = join(repoRoot, rel);
    return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) return markdownFiles(child);
      return entry.name.endsWith('.md') ? [child] : [];
    });
  }

  it('SKILL.md sleep flow step 4 carries the clause verbatim', () => {
    const skill = read('skill/SKILL.md');
    const step4 = skill.slice(skill.indexOf('4. Dispatch specialists'), skill.indexOf('\n5. ', skill.indexOf('4. Dispatch specialists')));
    expect(step4, 'SKILL.md sleep flow step 4 not found').not.toBe('');
    expect(step4).toContain(SLEEP_ROSTER_CLAUSE);
  });

  it('SKILL.md lists sleep-learn among the sleep specialists', () => {
    const skill = read('skill/SKILL.md');
    const line = skill.split('\n').find((l) => l.includes('**Sleep specialists**'));
    expect(line, 'Sleep specialists line not found in SKILL.md').toBeDefined();
    for (const name of SLEEP_SPECIALISTS) expect(line).toContain(name);
  });

  it('sleep.md dispatches sleep-learn', () => {
    expect(read('skill/references/sleep.md')).toMatch(/fire `sleep-learn`/);
  });

  it('no shipped doc names a retired specialist except to say it is retired', () => {
    const files = [...SHIPPED_DOC_ROOTS.flatMap(markdownFiles), 'README.md'];
    const offenders: string[] = [];
    for (const file of files) {
      read(file).split('\n').forEach((line, i) => {
        for (const name of RETIRED_SLEEP_SPECIALISTS) {
          if (line.includes(name) && !/retired/i.test(line)) offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
