/**
 * The pattern loop — what makes a scheduled job get better instead of
 * repeating the same mistake daily.
 *
 * Three properties carry the design and each has a test here that fails loudly
 * if it regresses:
 *   1. Every cap is enforced at WRITE time, both count and size. The pattern is
 *      prepended to every run's prompt, so unbounded growth would quietly eat
 *      the context the actual job needs.
 *   2. `recordLesson` never touches frontmatter — a run recording what it
 *      learned must never be able to change a hashed field and block itself.
 *   3. The pattern reaches the prompt as NOTES that lose to the instructions,
 *      and only when `learning` is on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAutomation,
  getAutomation,
  parsePattern,
  readPattern,
  recordLesson,
  renderPattern,
  upsertSection,
} from '../../src/lib/automations/store.js';
import {
  buildLearningDirective,
  buildPatternBlock,
  composePrompt,
} from '../../src/lib/automations/runner.js';
import { manifestHash } from '../../src/lib/automations/registry.js';
import {
  AutomationError,
  PATTERN_PLAYBOOK_MAX_CHARS,
  PATTERN_VIEW_LESSON_CHARS,
} from '../../src/lib/automations/types.js';
import { addLesson, lessonTwinScore } from '../../src/lib/automations/store.js';
import { patternView } from '../../src/lib/automations/runner.js';

let projectRoot: string;
let root: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-pattern-'));
  root = join(projectRoot, '_dream_context');
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function make(slug = 'digest', learning = true) {
  return createAutomation(root, {
    slug, title: 'Digest', days: 'daily', at: '18:00', prompt: 'Do the thing.', learning,
  });
}

describe('parsePattern / renderPattern', () => {
  it('splits a playbook from its lesson ledger', () => {
    const parsed = parsePattern('Run it twice.\n\n### Lessons\n- **[2026-07-27]** the API 500s on Sundays');
    expect(parsed.playbook).toBe('Run it twice.');
    expect(parsed.lessons).toEqual([{ date: '2026-07-27', text: 'the API 500s on Sundays' }]);
  });

  it('treats a section with no ledger as all playbook', () => {
    expect(parsePattern('Just prose.').playbook).toBe('Just prose.');
    expect(parsePattern('Just prose.').lessons).toEqual([]);
  });

  it('degrades an unparseable ledger line to nothing rather than throwing', () => {
    // The section is markdown a human may also have hand-edited.
    const parsed = parsePattern('### Lessons\n- not in the expected shape\n- **[2026-07-27]** this one is');
    expect(parsed.lessons).toEqual([{ date: '2026-07-27', text: 'this one is' }]);
  });

  it('round-trips', () => {
    const p = { playbook: 'Prose here.', lessons: [{ date: '2026-07-27', text: 'a lesson' }] };
    expect(parsePattern(renderPattern(p))).toEqual(p);
  });
});

describe('recordLesson', () => {
  it('appends newest-first', () => {
    make();
    recordLesson(root, 'digest', { lesson: 'first', now: new Date('2026-07-26T10:00:00') });
    const after = recordLesson(root, 'digest', { lesson: 'second', now: new Date('2026-07-27T10:00:00') });
    expect(readPattern(after).lessons.map((l) => l.text)).toEqual(['second', 'first']);
  });

  // D6 (plan global-uye-ogrenme; owner: no regression in memory, no count caps): nothing is dropped.
  it.each([25, 100, 500])('keeps every one of %i lessons, newest first; the prompt view folds by size', (n) => {
    make();
    for (let i = 0; i < n; i++) {
      recordLesson(root, 'digest', { lesson: `lesson ${i}`, now: new Date('2026-07-27T10:00:00') });
    }
    const m = getAutomation(root, 'digest')!;
    const lessons = readPattern(m).lessons;
    expect(lessons).toHaveLength(n);
    expect(lessons[0].text).toBe(`lesson ${n - 1}`);
    expect(lessons.some((l) => l.text === 'lesson 0')).toBe(true);
    const view = patternView(m.pattern, 'digest');
    expect(view).toContain(`lesson ${n - 1}`);
    if (n === 500) expect(view).toMatch(/\d+ older notes: `dreamcontext automations pattern digest`/);
  });

  it('keeps a long lesson whole in the file; only the view cuts it', () => {
    make();
    const long = `start ${'x'.repeat(PATTERN_VIEW_LESSON_CHARS * 3)} end`;
    const updated = recordLesson(root, 'digest', { lesson: long });
    expect(readPattern(updated).lessons[0].text).toBe(long);
    const view = patternView(updated.pattern, 'digest');
    expect(view).not.toContain(' end');
    expect(view).toContain('start ');
  });

  it('a near-twin lesson updates the stored one (×N) instead of a new line', () => {
    make();
    recordLesson(root, 'digest', { lesson: 'Run the build before the screenshot step', now: new Date('2026-07-27T10:00:00') });
    recordLesson(root, 'digest', { lesson: 'unrelated note about the port', now: new Date('2026-07-27T10:00:00') });
    const after = recordLesson(root, 'digest', { lesson: 'run the build before every screenshot step', now: new Date('2026-07-28T10:00:00') });
    const lessons = readPattern(after).lessons;
    expect(lessons).toHaveLength(2);
    // The new one adds "every": its text is kept, never the shorter old one (nothing it adds is lost).
    expect(lessons[0].text).toBe('run the build before every screenshot step (×2)');
    expect(lessons[0].date).toBe('2026-07-28');
    const third = addLesson(lessons, { date: '2026-07-29', text: 'run the build before the screenshot step' });
    expect(third[0]!.text).toMatch(/\(×3\)$/);
  });

  it('a lesson that extends an old one keeps the extension; two that each add a word are both kept', () => {
    const one = addLesson([{ date: '2026-07-27', text: 'Deploy fails on the staging branch' }],
      { date: '2026-07-28', text: 'Deploy fails on the staging branch: run the migrations first, then retry' });
    expect(one).toEqual([{ date: '2026-07-28', text: 'Deploy fails on the staging branch: run the migrations first, then retry (×2)' }]);
    const shorter = addLesson(one, { date: '2026-07-29', text: 'deploy fails on the staging branch' });
    expect(shorter[0]!.text).toBe('Deploy fails on the staging branch: run the migrations first, then retry (×3)');
    const both = addLesson([{ date: '2026-07-27', text: 'Use pnpm never npm for installs in this repo always' }],
      { date: '2026-07-28', text: 'Use pnpm never npm for installs in this repo with force' });
    expect(both).toHaveLength(2);
  });

  it('two lessons that differ in a number are two facts, never twins', () => {
    expect(lessonTwinScore('lesson number 0', 'lesson number 1')).toBe(0);
    expect(lessonTwinScore('Ders 01: kurgusal çalışma notu 1', 'Ders 02: kurgusal çalışma notu 2')).toBe(0);
  });

  it('caps the playbook SIZE too', () => {
    make();
    const updated = recordLesson(root, 'digest', { playbook: 'y'.repeat(PATTERN_PLAYBOOK_MAX_CHARS * 2) });
    expect(readPattern(updated).playbook.length).toBeLessThanOrEqual(PATTERN_PLAYBOOK_MAX_CHARS);
  });

  it('flattens a multi-line lesson — one lesson is one ledger line', () => {
    // An embedded newline would split one lesson into an unparseable fragment
    // on the next read, silently losing it.
    make();
    const updated = recordLesson(root, 'digest', { lesson: 'line one\nline two' });
    expect(readPattern(updated).lessons[0].text).toBe('line one line two');
    expect(readPattern(updated).lessons).toHaveLength(1);
  });

  it('NEVER changes the approval hash, however many lessons it records', () => {
    // THE regression test for this whole feature. A run that blocks itself by
    // recording a lesson is a SILENT outage: a blocked run notifies nobody (the
    // blocked path passes notify: false, deliberately), so the automation just
    // goes quiet and the user finds out days later.
    //
    // The real bug this pins: `upsertSection` used to finish with a whole-file
    // `.replace(/\n{3,}/g, '\n\n')`, which collapsed blank lines inside
    // `## Prompt` too — and the prompt IS hashed (`normalizeText` strips \r and
    // trims; it does NOT collapse internal blank lines). It needed TWO lessons
    // to show up, because the first append takes a different branch.
    const m = createAutomation(root, {
      slug: 'gappy', title: 'Gappy', days: 'daily', at: '18:00',
      prompt: 'Step one.\n\n\nStep two.\n\n\n\nStep three.',
      outputInstructions: 'Be terse.\n\n\nReally terse.',
      learning: true,
    });
    const before = manifestHash(m);
    for (let i = 0; i < 5; i++) {
      recordLesson(root, 'gappy', { lesson: `lesson ${i}` });
      expect(manifestHash(getAutomation(root, 'gappy')!)).toBe(before);
    }
    recordLesson(root, 'gappy', { playbook: 'A revised playbook.' });
    expect(manifestHash(getAutomation(root, 'gappy')!)).toBe(before);
    // And the prompt survives byte-for-byte, not merely "hashes the same".
    expect(getAutomation(root, 'gappy')!.prompt).toBe('Step one.\n\n\nStep two.\n\n\n\nStep three.');
  });

  it('NEVER touches frontmatter — a run recording a lesson cannot block itself', () => {
    const manifest = make();
    const before = readFileSync(manifest.path, 'utf-8').split('---')[1];
    recordLesson(root, 'digest', { lesson: 'something learned' });
    const after = readFileSync(manifest.path, 'utf-8').split('---')[1];
    expect(after).toBe(before);
  });

  it('leaves the approved prompt and output instructions untouched', () => {
    make();
    recordLesson(root, 'digest', { lesson: 'a lesson', playbook: 'a playbook' });
    const updated = getAutomation(root, 'digest')!;
    expect(updated.prompt).toBe('Do the thing.');
    expect(updated.outputInstructions).toContain('Optional');
  });

  it('rewrites the playbook without disturbing the ledger', () => {
    make();
    recordLesson(root, 'digest', { lesson: 'keep me' });
    const updated = recordLesson(root, 'digest', { playbook: 'new playbook' });
    expect(readPattern(updated).playbook).toBe('new playbook');
    expect(readPattern(updated).lessons.map((l) => l.text)).toEqual(['keep me']);
  });

  it('refuses an empty call rather than writing an empty section', () => {
    make();
    expect(() => recordLesson(root, 'digest', {})).toThrow(AutomationError);
  });

  it('throws on an unknown slug', () => {
    expect(() => recordLesson(root, 'nope', { lesson: 'x' })).toThrow(AutomationError);
  });
});

describe('upsertSection', () => {
  it('appends the section when absent', () => {
    const out = upsertSection('---\nid: x\n---\n## Prompt\n\nDo it.\n', 'Pattern', 'learned things');
    expect(out).toContain('## Prompt');
    expect(out).toContain('## Pattern\n\nlearned things');
  });

  it('preserves every byte OUTSIDE the target section — no whole-file normalization', () => {
    // The surgical contract. Blank-line runs elsewhere in the file are the
    // author's, not ours to tidy: one of them lives in an approval-hashed
    // section.
    const raw = '---\nid: x\n---\n## Prompt\n\nOne.\n\n\n\nTwo.\n\n## Pattern\n\nold\n';
    const out = upsertSection(raw, 'Pattern', 'new');
    expect(out).toContain('One.\n\n\n\nTwo.');
    expect(out.slice(0, out.indexOf('## Pattern'))).toBe(raw.slice(0, raw.indexOf('## Pattern')));
  });

  it('replaces the section body in place, preserving what follows', () => {
    const raw = '## Prompt\n\nDo it.\n\n## Pattern\n\nold\n\n## Output instructions\n\nbe terse\n';
    const out = upsertSection(raw, 'Pattern', 'new');
    expect(out).toContain('## Pattern\n\nnew');
    expect(out).not.toContain('old');
    expect(out).toContain('## Output instructions\n\nbe terse');
    expect(out.indexOf('## Prompt')).toBeLessThan(out.indexOf('## Pattern'));
  });
});

describe('the pattern reaches the prompt as NOTES, not instructions', () => {
  it('injects nothing when learning is off, even if a pattern somehow exists', () => {
    make('no-learn', false);
    recordLesson(root, 'no-learn', { lesson: 'x' }); // bypasses the CLI's refusal
    const manifest = getAutomation(root, 'no-learn')!;
    expect(manifest.pattern).toContain('x');
    expect(buildPatternBlock(manifest)).toBe('');
    expect(buildLearningDirective(manifest)).toBe('');
    expect(composePrompt(manifest, '/p', new Date(), '/o.md')).not.toContain('YOUR PATTERN');
  });

  it('injects nothing when learning is on but nothing has been learned yet', () => {
    expect(buildPatternBlock(make('fresh'))).toBe('');
  });

  it('frames the pattern as observations that LOSE to the instructions', () => {
    make();
    recordLesson(root, 'digest', { lesson: 'the API 500s on Sundays' });
    const block = buildPatternBlock(getAutomation(root, 'digest')!);
    expect(block).toContain('the API 500s on Sundays');
    // This framing is the security boundary: the pattern is not approval-hashed,
    // so an instruction smuggled into it must never outrank the approved prompt.
    expect(block).toMatch(/OBSERVATIONS, not instructions/);
    expect(block).toMatch(/instructions above always win/i);
  });

  it('orders the pattern AFTER the approved prompt and output instructions', () => {
    make();
    recordLesson(root, 'digest', { lesson: 'a lesson' });
    const prompt = composePrompt(getAutomation(root, 'digest')!, '/p', new Date(), '/o.md');
    expect(prompt.indexOf('Do the thing.')).toBeLessThan(prompt.indexOf('YOUR PATTERN'));
    expect(prompt.indexOf('Output instructions:')).toBeLessThan(prompt.indexOf('YOUR PATTERN'));
  });

  it('closes the loop — the run is told the exact command that records a lesson', () => {
    // Without this the pattern is a file nothing ever writes.
    const directive = buildLearningDirective(make('digest'));
    expect(directive).toContain('dreamcontext automations learn digest --lesson');
    expect(directive).toMatch(/Record NOTHING when the run was unremarkable/);
  });

  it('tells the run whether it HAS a pattern, so an empty one is not mistaken for a hidden one', () => {
    // Caught by dogfooding: a real run with an empty pattern went looking for a
    // command to read it and invented `automations pattern`, because nothing
    // was injected and it could not tell "I have no notes" from "my notes were
    // withheld". (The invented command now exists — the guess was a good one.)
    make('empty-pattern');
    expect(buildLearningDirective(getAutomation(root, 'empty-pattern')!))
      .toMatch(/You have no pattern yet/);

    recordLesson(root, 'empty-pattern', { lesson: 'something' });
    expect(buildLearningDirective(getAutomation(root, 'empty-pattern')!))
      .toMatch(/already included above/);
  });
});

describe('the learning flag itself', () => {
  it('create writes learning: true explicitly', () => {
    expect(make('on-by-default').learning).toBe(true);
    expect(readFileSync(getAutomation(root, 'on-by-default')!.path, 'utf-8')).toContain('learning: true');
  });

  it('--no-learning writes it off', () => {
    expect(make('opted-out', false).learning).toBe(false);
  });

  it('a manifest written BEFORE the field existed reads as OFF, keeping its old hash', () => {
    // Strict-true, unlike `notify`: this flag admits a self-rewritten file into
    // the run's input, so it must never switch itself on. The consequence that
    // matters is in automations-registry.test.ts — the hash stays byte-identical.
    const manifest = make('legacy');
    writeFileSync(
      manifest.path,
      readFileSync(manifest.path, 'utf-8').replace(/^learning: true\n/m, ''),
      'utf-8',
    );
    expect(getAutomation(root, 'legacy')!.learning).toBe(false);
  });
});
