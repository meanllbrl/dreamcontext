import { describe, it, expect } from 'vitest';
import { splitReport, MIN_FOLDED_SECTIONS } from '../../dashboard/src/lib/reportSections';

// A fictional outreach report, shaped like the one the owner found too long to read whole.
const REPORT = [
  '14 new replies · 3 CRM writes · 2 people waiting',
  '',
  '# Outreach · 2026-01-05',
  '',
  '**Yes, two people are waiting.** The most urgent is Ada Lovelace.',
  '',
  '## 1. Waiting on you',
  '',
  '**1) Ada Lovelace** · 11 h',
  '> "Can I pay another way?"',
  '',
  '## 2. CRM',
  '',
  '| Who | Old → New |',
  '|---|---|',
  '| Alan Turing | trial → won |',
  '',
  '## 3. Signals',
  '',
  '```md',
  '## not a heading inside a fence',
  '```',
  '- Lesson reminders: third time.',
].join('\n');

describe('splitReport — answer first, detail folded', () => {
  it('keeps the lead as prose and drops the H1 title from it', () => {
    const r = splitReport(REPORT);
    expect(r.lead).toContain('14 new replies');
    expect(r.lead).toContain('Yes, two people are waiting.');
    expect(r.lead).not.toContain('# Outreach');
  });

  it('cuts one section per ## heading, in order, with its body', () => {
    const r = splitReport(REPORT);
    expect(r.sections.map((s) => s.title)).toEqual(['1. Waiting on you', '2. CRM', '3. Signals']);
    expect(r.sections[0].body).toContain('Ada Lovelace');
    expect(r.sections[1].body).toContain('Alan Turing');
  });

  it('a ## inside a code fence is not a heading', () => {
    const r = splitReport(REPORT);
    expect(r.sections).toHaveLength(3);
    expect(r.sections[2].body).toContain('## not a heading inside a fence');
  });

  it('previews the first readable line without markdown syntax, skipping a table', () => {
    const r = splitReport(REPORT);
    expect(r.sections[0].preview).toBe('1) Ada Lovelace · 11 h');
    // The CRM section opens with a table: no sentence to preview.
    expect(r.sections[1].preview).toBe('');
    expect(r.sections[2].preview).toBe('Lesson reminders: third time.');
  });

  it('a short answer has no sections and is shown whole', () => {
    const r = splitReport('Two people are waiting: Ada and Alan.');
    expect(r.sections.length).toBeLessThan(MIN_FOLDED_SECTIONS);
    expect(r.lead).toBe('Two people are waiting: Ada and Alan.');
  });
});
