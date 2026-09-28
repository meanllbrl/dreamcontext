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
