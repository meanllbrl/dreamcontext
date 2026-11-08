/**
 * lib/handoff-readiness — the gate both handoffs pass before a fresh session is told to
 * pick a task up cold. A fresh session inherits nothing but the task file, so each gap
 * this misses is a detail the next session never sees.
 */

import { describe, it, expect } from 'vitest';
import {
  contextHandoffGaps,
  renderHandoffEntry,
  developHandoffGaps,
  developHandoffNotes,
  outcomeScope,
  outcomeApprovalGaps,
  HANDOFF_FIELDS,
} from '../../src/lib/handoff-readiness.js';

const FULL = {
  done: 'Parser done and green: 14 unit tests pass.',
  next: 'Write the serializer in src/writer.ts, then tick criterion 3.',
  decisions: 'none',
  learned: 'none',
  style: 'none',
  files: 'none',
};

describe('contextHandoffGaps', () => {
  it('passes when every part is answered — "none" is an answer for the four optional-content parts', () => {
    expect(contextHandoffGaps(FULL)).toEqual([]);
  });

  it('names EVERY missing part, not just the first', () => {
    const gaps = contextHandoffGaps({});
    expect(gaps.map((g) => g.field)).toEqual(HANDOFF_FIELDS.map((f) => f.flag));
  });

  it('refuses a --done or --next that is not a real sentence', () => {
    expect(contextHandoffGaps({ ...FULL, next: 'continue' }).map((g) => g.field)).toEqual(['--next']);
    expect(contextHandoffGaps({ ...FULL, done: '   ' }).map((g) => g.field)).toEqual(['--done']);
  });
});

describe('renderHandoffEntry', () => {
  it('writes every part into ONE entry, in order, with the note last', () => {
    const entry = renderHandoffEntry('2026-09-25', FULL, 'ping the owner');
    expect(entry.startsWith('### 2026-09-25 - Handoff\n')).toBe(true);
    const labels = [...entry.matchAll(/\*\*([^*]+):\*\*/g)].map((m) => m[1]);
    expect(labels).toEqual(['Done', 'Next', 'Decisions', 'Learned', 'Working style', 'Open files', 'Note']);
  });

  it('flattens newlines so a multi-line value cannot break the entry into stray lines', () => {
    expect(renderHandoffEntry('2026-09-25', { ...FULL, next: 'one\n### two' })).toContain('**Next:** one ### two');
  });
});

describe('developHandoffGaps', () => {
  const READY = {
    acceptance_criteria: '- [ ] The writer round-trips every fixture\n- [ ] Validation method: unit tests',
    technical_details: '- src/writer.ts: add serialize() beside parse()',
  };

  it('passes a task carrying criteria, the validation method, and a plan that names a file', () => {
    expect(developHandoffGaps(READY)).toEqual([]);
  });

  it('refuses a bare task — the shape a plan that never reached the file leaves behind', () => {
    const fields = developHandoffGaps({}).map((g) => g.field);
    expect(fields).toEqual(['acceptance_criteria', 'acceptance_criteria', 'technical_details']);
  });

  it('refuses criteria without the validation method the user chose', () => {
    const gaps = developHandoffGaps({ ...READY, acceptance_criteria: '- [ ] The writer round-trips' });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].problem).toMatch(/Validation method/);
  });

  it('refuses a plan that names no file, and one that is only a comment or template skeleton', () => {
    expect(developHandoffGaps({ ...READY, technical_details: 'Update the relevant files.' })[0].problem).toMatch(/names no file/);
    expect(developHandoffGaps({ ...READY, technical_details: '<!-- key files go here -->' })[0].problem).toMatch(/empty/);
    expect(developHandoffGaps({ ...READY, acceptance_criteria: '<!-- - [ ] Validation method: x -->' }).length).toBe(2);
  });
});

// Owner 2026-11-08: a UX/UI plan reaches Develop only with the owner's recorded yes on the
// outcome (and, for a screen, on a static drawing). Every test below fails on the old gate,
// which read only criteria, the validation method and a file path.
describe("outcome approval — a UX/UI plan needs the owner's recorded yes", () => {
  const AC = '- [ ] The panel lists runs\n- [ ] Validation method: unit tests';
  const OUTCOME = 'Owner-approved outcome: Runs page shows a filter chip row; pressing a chip narrows the list (2026-11-08)';
  const yes = () => true;

  it('a plan that changes no UX/UI is not blocked, declared or not', () => {
    expect(developHandoffGaps({ acceptance_criteria: AC, technical_details: '- src/lib/runs.ts: add filter()' })).toEqual([]);
    expect(developHandoffGaps({ acceptance_criteria: AC, technical_details: '- src/lib/runs.ts\nUX/UI change: none' })).toEqual([]);
  });

  it('a plan editing a UI file is a UI plan even undeclared, and names both missing records', () => {
    const tech = '- dashboard/src/pages/Runs.tsx: add the chip row';
    expect(outcomeScope(tech)).toMatchObject({ scope: 'ui', declared: false, uiFile: 'dashboard/src/pages/Runs.tsx' });
    const gaps = developHandoffGaps({ acceptance_criteria: AC, technical_details: tech });
    expect(gaps).toHaveLength(2);
    expect(gaps[0].problem).toMatch(/changes a UI file \(dashboard\/src\/pages\/Runs\.tsx\).*no owner-approved outcome.*Owner-approved outcome:.*UX\/UI change: none/);
    expect(gaps[1].problem).toMatch(/no approved drawing.*static HTML.*draft, not the final version.*Approved drawing:/);
  });

  it('"UX/UI change: none" is an explicit answer that overrides a UI path', () => {
    expect(developHandoffGaps({ acceptance_criteria: AC, technical_details: '- dashboard/src/x.tsx: rename a prop\nUX/UI change: none' })).toEqual([]);
  });

  it('a declared UX plan needs the outcome only, and a one-word outcome is not a record', () => {
    const tech = '- src/cli/commands/runs.ts\nUX/UI change: ux';
    expect(outcomeApprovalGaps({ technical_details: tech }).map((g) => g.problem)).toEqual([expect.stringMatching(/declares "UX\/UI change: ux".*no owner-approved outcome/)]);
    expect(outcomeApprovalGaps({ technical_details: `${tech}\nOwner-approved outcome: yes` })).toHaveLength(1);
    expect(outcomeApprovalGaps({ technical_details: `${tech}\n${OUTCOME}` })).toEqual([]);
  });

  it('a UI plan with the outcome still needs the drawing, and the drawing must exist', () => {
    const tech = `- src/lib/runs.ts\nUX/UI change: ui\n${OUTCOME}`;
    expect(outcomeApprovalGaps({ technical_details: tech }).map((g) => g.problem)).toEqual([expect.stringMatching(/no approved drawing/)]);
    const withDrawing = `${tech}\n- **Approved drawing:** \`_dream_context/state/assets/runs/draft.html\``;
    expect(outcomeApprovalGaps({ technical_details: withDrawing }, yes)).toEqual([]);
    expect(outcomeApprovalGaps({ technical_details: withDrawing }, () => false).map((g) => g.problem))
      .toEqual([expect.stringMatching(/"Approved drawing: _dream_context\/state\/assets\/runs\/draft\.html" is not a file inside the project/)]);
  });

  it('the drawing path itself does not make a plan a UI plan', () => {
    const tech = `- src/cli/commands/runs.ts\nUX/UI change: ux\n${OUTCOME}\nApproved drawing: docs/flow.html`;
    expect(outcomeScope(tech).scope).toBe('ux');
    expect(outcomeScope('- src/a.ts\nApproved drawing: docs/flow.html').scope).toBe('none');
  });

  // End review (edge-cases Major 1): the value was read by its first word only.
  it('reads the declared value whole: both scopes are UI, the pasted template fails closed', () => {
    for (const v of ['ux/ui', 'ux + ui', 'ux, ui', 'UX and UI', 'none|ux|ui', '`ui`']) {
      expect(outcomeScope(`- dashboard/src/Runs.tsx\nUX/UI change: ${v}`), v).toMatchObject({ scope: 'ui', declared: true });
    }
    // Re-check Major: punctuation stuck to the word must not erase a UX declaration.
    for (const v of ['ux.', 'ux-only', '(ux)', 'ux;', '**ux**']) {
      expect(outcomeScope(`- src/cli/commands/tasks.ts\nUX/UI change: ${v}`), v).toMatchObject({ scope: 'ux', declared: true });
    }
    expect(outcomeScope('- src/lib/a.ts\nUX/UI change: ui-only').scope).toBe('ui');
    expect(outcomeScope('- src/lib/a.ts\nUX/UI change: n/a').declared).toBe(false);
    expect(outcomeScope('UX/UI change: none (backend only)').scope).toBe('none');
    expect(outcomeScope('- src/a.ts\nUX/UI change: none, the UI is unchanged').scope).toBe('none');
    // A value naming no scope word is no declaration: the plan's paths decide.
    expect(outcomeScope('- dashboard/src/Runs.tsx\nUX/UI change: maybe')).toMatchObject({ scope: 'ui', declared: false });
    expect(developHandoffGaps({ acceptance_criteria: AC, technical_details: `- dashboard/src/Runs.tsx\nUX/UI change: ux/ui\n${OUTCOME}` }).map((g) => g.problem))
      .toEqual([expect.stringMatching(/no approved drawing/)]);
  });

  it('a very long line cannot stall the scan (the path regexes see at most 2000 chars a line)', () => {
    const t0 = Date.now();
    developHandoffGaps({ acceptance_criteria: AC, technical_details: `src/a.ts\n${'a'.repeat(200_000)}` });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('reads a bold label either way and a backticked value', () => {
    expect(outcomeScope('- **UX/UI change:** `ux`').scope).toBe('ux');
    expect(outcomeScope('- **UX/UI change**: none\n- dashboard/a.tsx').scope).toBe('none');
    const seen: string[] = [];
    outcomeApprovalGaps({ technical_details: `UX/UI change: ui\n${OUTCOME}\n- **Approved drawing:** \`docs/d.html\`` }, (p) => { seen.push(p); return true; });
    expect(seen).toEqual(['docs/d.html']);
  });

  it('the newest declaration wins (a plan rewritten from ui to ux)', () => {
    expect(outcomeScope('UX/UI change: ui\n- src/a.ts\nUX/UI change: ux').scope).toBe('ux');
  });
});

describe('developHandoffNotes — wave sub-tasks are a note, never a gap', () => {
  const map = 'WAVE MAP: EXECUTION: lead | W1 (src/a.ts) | W2 (src/b.ts)';
  it('notes a 2+ wave map on a top-level task with no wave children', () => {
    expect(developHandoffNotes({ slug: 'p', technical_details: map }, [])[0]).toMatch(/--parent p --basis plan/);
  });
  it('is silent with wave children, on a sub-task, and for a single wave', () => {
    expect(developHandoffNotes({ slug: 'p', technical_details: map }, [{ slug: 'w1', name: '1. dalga: a', filed_by: 'plan' }])).toEqual([]);
    expect(developHandoffNotes({ slug: 'p', parent_task: 'q', technical_details: map }, [])).toEqual([]);
    expect(developHandoffNotes({ slug: 'p', technical_details: 'WAVE MAP: EXECUTION: lead | W1 (src/a.ts)' }, [])).toEqual([]);
  });
  it('a non-plan child does not count as a wave', () => {
    expect(developHandoffNotes({ slug: 'p', technical_details: map }, [{ slug: 's', name: 'bug', filed_by: 'sleep' }])).toHaveLength(1);
  });
});
