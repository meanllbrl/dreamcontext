/**
 * Marker tests for the automations skill-doc wiring (feature-integration-pattern.md,
 * checklist items 1, 2, 3, 8). Lab shipped once with zero skill-doc wiring (v0.11.0)
 * and agents shadow-built insights as knowledge files because the Entity Router had
 * no row for them. These assertions make the same failure loud for automations
 * instead of silent, and they compute the Entity Router row count from the table
 * itself rather than hardcoding "eleven" so the prose count can never silently drift
 * out of sync with the table again.
 *
 * Extended for the effort / private-by-default sharing / sleep-reads-output round:
 * the approval surface grew from five hashed fields to six, automations gained
 * opt-in sharing, and sleep gained a bounded, gated read of automation output. The
 * completeness gate below replaces an earlier `grep "five hashed|all five"` version
 * that could not catch "one of the five approval-hashed fields" (the substring
 * between "five" and "hashed" defeated a literal match) — it binds the numeral to
 * the hashed-field CLAIM specifically, not the bare word, so it stays achievable
 * (the five SHARE states and "every five minutes" are legitimate, unrelated uses of
 * "five" elsewhere on this same surface) while remaining a real regression lock.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_DIFF_FIELDS } from '../../src/lib/automations/types.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

const SKILL_MD = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');
const AUTOMATIONS_MD = readFileSync(join(ROOT, 'skill', 'references', 'automations.md'), 'utf-8');
const CLI_REFERENCE_MD = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');
const SLEEP_MD = readFileSync(join(ROOT, 'skill', 'references', 'sleep.md'), 'utf-8');
const SLEEP_PRODUCT_MD = readFileSync(join(ROOT, 'agents', 'sleep-product.md'), 'utf-8');

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};

/** The Entity Router table's body rows, extracted between the section heading and
 *  the "Litmus tests when unsure:" line that follows it — mirrors how a reader
 *  would visually scope the table. Excludes the header row and the `|---|` divider. */
function entityRouterRows(content: string): string[] {
  const start = content.indexOf('## Entity Router');
  const end = content.indexOf('**Litmus tests when unsure:**', start);
  expect(start, 'Entity Router section heading not found').toBeGreaterThan(-1);
  expect(end, 'Litmus tests marker not found after Entity Router').toBeGreaterThan(start);
  const section = content.slice(start, end);
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && l.endsWith('|'))
    .filter((l) => !l.includes('User says'))       // header row
    .filter((l) => !/^\|[\s-]+\|[\s|-]+$/.test(l)); // the |---|---|---|---| divider
}

describe('skill/SKILL.md — Entity Router row count matches its own prose', () => {
  it('computes the actual row count and asserts the prose number equals it', () => {
    const rows = entityRouterRows(SKILL_MD);
    // Sanity floor: catches a broken extraction silently returning zero/one rows.
    expect(rows.length).toBeGreaterThanOrEqual(10);

    const match = SKILL_MD.match(/dreamcontext has \*\*(\w+) distinct entity types\*\*/);
    expect(match, 'entity-count sentence not found in SKILL.md').not.toBeNull();
    const word = match![1].toLowerCase();
    expect(NUMBER_WORDS[word], `unrecognized number word "${word}"`).toBeDefined();

    expect(NUMBER_WORDS[word]).toBe(rows.length);
  });
});

describe('skill/SKILL.md — Automations capability and router wiring', () => {
  it('has an Automations capabilities row linking references/automations.md', () => {
    expect(SKILL_MD).toContain('**Automations**');
    expect(SKILL_MD).toContain('[automations.md](references/automations.md)');
  });

  it('has an Automation row in the Entity Router table', () => {
    const rows = entityRouterRows(SKILL_MD);
    const automationRow = rows.find((r) => r.includes('**Automation**'));
    expect(automationRow, 'no Entity Router row contains **Automation**').toBeDefined();
  });

  it('names the automations create command in the Entity Router', () => {
    expect(SKILL_MD).toContain('dreamcontext automations create <slug>');
  });

  it('carries non-English trigger phrasing in the Automation row, like other rows do', () => {
    const rows = entityRouterRows(SKILL_MD);
    const automationRow = rows.find((r) => r.includes('**Automation**'));
    expect(automationRow).toBeDefined();
    expect(automationRow).toMatch(/her (akşam|cuma|gün)/);
  });

  it('declares "automation" a reserved entity noun', () => {
    expect(SKILL_MD).toContain('Entity nouns are reserved words — in ANY language.');
    const match = SKILL_MD.match(/In a dreamcontext project, \*([^*]+)\*/);
    expect(match, 'reserved-words sentence not found').not.toBeNull();
    const words = match![1].split(',').map((w) => w.trim());
    expect(words).toContain('automation');
    // The two entities that were already missing before this feature — pin them too
    // so a future edit can't silently drop them again while adding automation.
    expect(words).toContain('thesis');
    expect(words).toContain('pattern');
  });

  it('routes a recurring-schedule need to automations in the litmus tests', () => {
    expect(SKILL_MD).toMatch(/work that should run on a schedule.*automation/);
  });

  it("routes a recurring-schedule need to automations in the 'don't rebuild' rule", () => {
    expect(SKILL_MD).toContain("Don't rebuild what the brain already has.");
    expect(SKILL_MD).toMatch(/recurring job that must run unattended on a schedule.*\*\*automations\*\*/);
  });

  it('has the automations.md entry in the Reference Index', () => {
    expect(SKILL_MD).toMatch(/\[automations\.md\]\(references\/automations\.md\)/);
  });
});

describe('skill/references/sleep.md — the three-part rule (execute / own / read)', () => {
  const content = SLEEP_MD;

  it('states plainly that sleep never EXECUTES an automation', () => {
    expect(content).toContain('Sleep never EXECUTES an automation');
  });

  it('states plainly that sleep never OWNS an automation\'s files', () => {
    expect(content).toContain('Sleep never OWNS an automation\'s files');
    expect(content).toMatch(/No specialist creates, edits, or retires.*automations/i);
  });

  it('states that sleep DOES read automation output — the new, third part of the rule', () => {
    expect(content).toContain('Sleep DOES read an automation\'s output');
  });

  it('names the sleep-lock deference automations perform instead of racing', () => {
    expect(content).toContain('inspectSleepLock');
    expect(content.toLowerCase()).toContain('defer');
  });

  it('documents the last_consolidated_at consumption boundary and its null bootstrap', () => {
    expect(content).toContain('last_consolidated_at');
    expect(content).toMatch(/null.*consume nothing/is);
  });

  it('documents that a private automation\'s output still feeds the local brain, with the gate flag named', () => {
    expect(content.toLowerCase()).toContain("synced regardless of any automation's sharing flag");
    expect(content).toContain('--ack-private-derivation');
  });

  it('links back to automations.md', () => {
    expect(content).toContain('[automations.md](automations.md)');
  });
});

describe('skill/references/automations.md — reciprocal link to sleep.md exists', () => {
  const content = AUTOMATIONS_MD;

  it('links to sleep.md and states sleep never runs automations', () => {
    expect(content).toContain('[sleep.md](sleep.md)');
    expect(content.toLowerCase()).toContain('sleep never runs automations');
  });
});

describe('skill/references/automations.md — Sharing section (private by default)', () => {
  const content = AUTOMATIONS_MD;

  it('has a Sharing section', () => {
    expect(content).toContain('## Sharing');
  });

  it('states the flag defaults to private with a strict true-only read', () => {
    expect(content.toLowerCase()).toContain('defaults to `false`');
    expect(content).toContain('shared');
  });

  it('names all five share states', () => {
    for (const state of ['private', 'shared', 'drifted-flag-only', 'drifted-ignore-only', 'tracked-despite-private']) {
      expect(content).toContain(state);
    }
  });

  it('states the non-retroactive truth about unsharing', () => {
    expect(content).toContain('unsharing is not retroactive');
  });

  it('documents the private-output-to-synced-knowledge caveat with the gate flag, no alias, no discard', () => {
    expect(content.toLowerCase()).toContain("synced regardless of any automation's sharing flag");
    expect(content).toContain('--ack-private-derivation');
    expect(content.toLowerCase()).toContain('no shorter alias');
    expect(content.toLowerCase()).toContain('no way to discard');
  });

  it('documents the share and unshare verbs', () => {
    expect(content).toContain('dreamcontext automations share');
    expect(content).toContain('dreamcontext automations unshare');
  });
});

describe('skill/references/cli-reference.md — share/unshare verbs and the six-field diff', () => {
  const content = CLI_REFERENCE_MD;

  it('lists the share and unshare verbs', () => {
    expect(content).toMatch(/`automations share <slug>`/);
    expect(content).toMatch(/`automations unshare <slug>`/);
  });

  it('describes the approve diff without hardcoding a field count numeral', () => {
    expect(content).toMatch(/diffing every hashed field/i);
    expect(content).not.toMatch(/(five|5)\s+(\w+\s+)?(hashed|approval-hashed)/i);
  });
});

describe('agents/sleep-product.md — automation-output consumption contract', () => {
  const content = SLEEP_PRODUCT_MD;

  it('fires on the automationOutputs signal', () => {
    expect(content).toContain('automationOutputs.outputs');
  });

  it('states the caps: 20 files, 200 KB total', () => {
    expect(content).toContain('20 files');
    expect(content).toContain('200 KB');
  });

  it('states SKIP-by-default', () => {
    expect(content.toUpperCase()).toContain('DEFAULT ACTION IS SKIP');
  });

  it('states the hard rule against one knowledge file per output per day', () => {
    expect(content).toMatch(/HARD RULE.*never create one knowledge file per automation output/i);
  });

  it('states the obligation to write the private-derivation marker', () => {
    expect(content.toLowerCase()).toContain('private-derivation marker');
    expect(content).toContain('.sleep-private-derivation.json');
  });

  it('never edits or owns the automations subsystem\'s own files', () => {
    expect(content).toMatch(/never edit, move, or delete/i);
  });
});

describe('approval surface — six hashed fields, everywhere it is claimed', () => {
  it('APPROVAL_DIFF_FIELDS is the six-tuple including effort', () => {
    expect(APPROVAL_DIFF_FIELDS).toEqual([
      'prompt',
      'outputInstructions',
      'model',
      'effort',
      'timeoutMinutes',
      'outputDir',
    ]);
  });

  it('the automations skill-doc surface contains no stale "five hashed fields" claim', () => {
    // Bound to the CLAIM ("N hashed fields" / "all N"), not the bare numeral — the
    // five SHARE states and the dispatcher's five-minute tick are legitimate,
    // unrelated uses of "five" on this same surface and must not trip this gate.
    const HASHED_FIELD_COUNT_CLAIM = /(five|5)\s+(\w+\s+)?(hashed|approval-hashed)/i;
    const ALL_FIVE_CLAIM = /all\s+(five|5)\b/i;
    for (const [name, content] of [
      ['skill/references/automations.md', AUTOMATIONS_MD],
      ['skill/references/cli-reference.md', CLI_REFERENCE_MD],
    ] as const) {
      expect(content, `${name} contains a stale hashed-field-count claim`).not.toMatch(HASHED_FIELD_COUNT_CLAIM);
      expect(content, `${name} contains a stale "all five" claim`).not.toMatch(ALL_FIVE_CLAIM);
    }
  });
});
