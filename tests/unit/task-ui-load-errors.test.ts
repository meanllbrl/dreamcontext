/**
 * Second-pass review, Minor 7: a failed read is not an empty list or an endless "Loading…".
 * The task journal and the Releases page show an alert row first, and Releases still marks
 * itself settled (`data-releases-ready`). A source scan: root vitest has no DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', 'dashboard', 'src');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf-8');

describe('a failed read says so', () => {
  it('the journal timeline: an error is an alert, checked before the empty history', () => {
    const src = read('components/tasks/page/TaskJournalTimeline.tsx');
    const err = src.indexOf("if (isError) return <li className=\"tkp-error\" role=\"alert\">{t('taskPage.journal.loadFailed')}</li>;");
    const empty = src.indexOf("t('tasks.history_empty')");
    expect(err).toBeGreaterThan(0);
    expect(err).toBeLessThan(empty);
  });

  it('the Releases page: an error is an alert, and the page is ready once each read has an answer', () => {
    const src = read('pages/ReleasesPage.tsx');
    expect(src).toContain('const ready = (!!releases.data || releases.isError) && (!!unreleased.data || unreleased.isError);');
    expect(src).toContain("const failed = <p className=\"rel-empty\" role=\"alert\">{t('releases.loadFailed')}</p>;");
    expect(src).toContain('{unreleased.isError ? failed : unreleased.data');
    expect(src).toContain('{releases.isError ? failed : releases.data');
  });
});
