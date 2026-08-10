import { describe, it, expect } from 'vitest';
import {
  parseFinalReport,
  computeDebateStats,
} from '../../dashboard/src/components/council/lib/councilStats';
import { extractExecutiveSummary } from '../../src/lib/council';

/**
 * Regression: every section parser in the council pipeline terminated its body
 * with `(?=^##\s+|\Z)`. JavaScript has no `\Z` anchor — it degrades to the
 * literal letter "Z", so under `/i` each body was cut at its first "z". Turkish
 * reports lost most of their prose ("bağımsız" → "bağımsı", "çözecek" → "çö").
 */

const TURKISH_REPORT = `---
id: test-debate
---

## Verdict

Oda semantik olarak güçlü birleşti. 5 personanın 4'ü aynı mimariye bağımsız
olarak yakınsadı.

## Decision Card

Aşağıdakiler senin vereceğin sayılı kararlar — oda bunları çözemez.

## Open risks

- Milestone kapanışı tanımsız kaldı
- Snapshot diff ücretsiz değil

## Minority views

- veri-disiplin-gercekci yalnız kaldı ve pozisyonunu korudu

## Appendix

Kartın son bölümü üç satır yalnızca.
`;

describe('parseFinalReport', () => {
  const parsed = parseFinalReport(TURKISH_REPORT);

  it('keeps the verdict body past its first "z"', () => {
    expect(parsed.verdict).toContain('bağımsız');
    expect(parsed.verdict).toContain('olarak yakınsadı.');
  });

  it('keeps every other section body past its first "z"', () => {
    const decision = parsed.sections.find((s) => s.heading === 'Decision Card');
    expect(decision?.body).toContain('çözemez');

    const risks = parsed.sections.find((s) => s.heading === 'Open risks');
    expect(risks?.body).toContain('tanımsız kaldı');
    expect(risks?.body).toContain('ücretsiz değil');
  });

  it('splits the appendix off intact', () => {
    expect(parsed.appendix?.heading).toBe('Appendix');
    expect(parsed.appendix?.body).toContain('yalnızca');
  });

  it('does not bleed one section into the next', () => {
    const decision = parsed.sections.find((s) => s.heading === 'Decision Card');
    expect(decision?.body).not.toContain('Open risks');
  });

  it('reads the final section all the way to end of input', () => {
    const noTrailingNewline = '## Verdict\n\nson söz burada bitiyor.';
    expect(parseFinalReport(noTrailingNewline).verdict).toBe('son söz burada bitiyor.');
  });
});

describe('computeDebateStats', () => {
  // Only the finalReport branch is under test; the rest of DebateDetail is
  // shaped just enough for the reducers to run.
  const debate = {
    frontmatter: { id: 'test-debate', topic: 'test', rounds_planned: 2 },
    personas: [],
    finalReport: { frontmatter: {}, content: TURKISH_REPORT },
  } as unknown as Parameters<typeof computeDebateStats>[0];

  const stats = computeDebateStats(debate);

  it('counts open risks whose text contains a "z"', () => {
    expect(stats.openRisks).toBe(2);
  });

  it('counts a minority view whose text contains a "z"', () => {
    expect(stats.minorityViews).toBe(1);
  });
});

describe('extractExecutiveSummary', () => {
  it('keeps the summary past its first "Z"', () => {
    const body = [
      '### Executive Summary',
      '',
      'Zaman kısıtı nedeniyle Zorunlu kapsam daraltıldı.',
      '',
      '### Position',
      '',
      'ignored',
    ].join('\n');
    expect(extractExecutiveSummary(body)).toBe('Zaman kısıtı nedeniyle Zorunlu kapsam daraltıldı.');
  });
});
