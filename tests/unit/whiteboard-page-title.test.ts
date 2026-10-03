import { describe, expect, it } from 'vitest';
import {
  humanizeFileName, isPagePath, pageCardTitle, pageKindLabel, pageTypeLabel, stampedTitle,
} from '../../dashboard/src/components/whiteboard/widgetModel.js';
import { pageKindChip, pageTitleFromPath, pageTypeChip } from '../../dashboard/src/components/whiteboard/pagePopupModel.js';

/** A page card says what the page is and reads its file name as a title, never the raw name. */
describe('page card type label', () => {
  it('a knowledge slug is Knowledge; a file says its type in the picker vocabulary', () => {
    expect(pageTypeLabel('onboarding-playbook')).toBe('Knowledge');
    expect(pageTypeLabel('features/sleep-cycle')).toBe('Knowledge');
    expect(pageTypeLabel('docs/notes.md')).toBe('MD');
    expect(pageTypeLabel('pricing-sheet.pdf')).toBe('PDF');
    expect(pageTypeLabel('site/index.html')).toBe('HTML');
    expect(pageTypeLabel('site/old.htm')).toBe('HTML');
    expect(pageTypeLabel('Deck.PDF')).toBe('PDF');
  });

  it('an invalid ref has no label', () => {
    expect(pageTypeLabel(undefined)).toBeNull();
    expect(pageTypeLabel('')).toBeNull();
    expect(pageTypeLabel('../secret.md')).toBeNull();
    expect(pageTypeLabel('/abs/path.pdf')).toBeNull();
    expect(pageTypeLabel('image.png')).toBeNull();
  });

  it('a PDF card never says Knowledge', () => {
    expect(pageTypeLabel('reports/q3.pdf')).not.toBe('Knowledge');
    expect(isPagePath('reports/q3.pdf')).toBe(true);
    expect(isPagePath('reports-q3')).toBe(false);
  });
});

describe('humanizeFileName', () => {
  it('reads the examples as titles', () => {
    expect(humanizeFileName('pricing-sheet.pdf')).toBe('Pricing sheet');
    expect(humanizeFileName('docs/Q3_report-final.html')).toBe('Q3 report final');
    expect(humanizeFileName('README.md')).toBe('README');
  });

  it('nested folders, uppercase extensions and .htm all strip to the name', () => {
    expect(humanizeFileName('a/b/c/launch-plan.md')).toBe('Launch plan');
    expect(humanizeFileName('Deck.PDF')).toBe('Deck');
    expect(humanizeFileName('site/old_landing.htm')).toBe('Old landing');
  });

  it('collapses runs of separators and spaces, keeps the rest as written', () => {
    expect(humanizeFileName('my--big__file  name.md')).toBe('My big file name');
    expect(humanizeFileName('iOS-release-notes.md')).toBe('IOS release notes');
    expect(humanizeFileName('v1.2-notes.md')).toBe('V1.2 notes');
  });

  it('a name with no extension keeps the whole leaf', () => {
    expect(humanizeFileName('docs/CHANGELOG')).toBe('CHANGELOG');
  });

  it('a leading dot is not part of the name (one rule for cards, wiki rows and the panel)', () => {
    expect(humanizeFileName('.notes.md')).toBe('Notes');
    expect(humanizeFileName('docs/.hidden.md')).toBe('Hidden');
    expect(humanizeFileName('..twice.pdf')).toBe('Twice');
  });

  it('nothing left after stripping falls back to the file name', () => {
    expect(humanizeFileName('docs/.md')).toBe('.md');
    expect(humanizeFileName('.gitignore')).toBe('.gitignore');
    expect(humanizeFileName('---.pdf')).toBe('---.pdf');
  });
});

describe('page card title', () => {
  it('a file path shows its humanised name', () => {
    expect(pageCardTitle('pricing-sheet.pdf')).toBe('Pricing sheet');
    expect(pageCardTitle('docs/Q3_report-final.html')).toBe('Q3 report final');
  });

  it('a knowledge slug shows the entry title, else the slug humanised', () => {
    expect(pageCardTitle('onboarding-playbook', undefined, 'The onboarding playbook')).toBe('The onboarding playbook');
    expect(pageCardTitle('onboarding-playbook')).toBe('Onboarding playbook');
  });

  it('a stamped title wins, unless it is only the ref or the raw file name', () => {
    expect(pageCardTitle('pricing-sheet.pdf', 'Pricing for 2027')).toBe('Pricing for 2027');
    expect(pageCardTitle('docs/pricing-sheet.pdf', 'docs/pricing-sheet.pdf')).toBe('Pricing sheet');
    expect(pageCardTitle('docs/pricing-sheet.pdf', 'pricing-sheet.pdf')).toBe('Pricing sheet');
    expect(pageCardTitle('onboarding-playbook', 'onboarding-playbook', 'Playbook')).toBe('Playbook');
    expect(pageCardTitle('onboarding-playbook', '  ', 'Playbook')).toBe('Playbook');
  });

  it('stampedTitle: empty for no stamp or a stamp that repeats the ref', () => {
    expect(stampedTitle(undefined, 'a-b')).toBe('');
    expect(stampedTitle('a-b', 'a-b')).toBe('');
    expect(stampedTitle('features/a-b', 'features/a-b')).toBe('');
    expect(stampedTitle(' Real name ', 'a-b')).toBe('Real name');
    expect(stampedTitle('Real name', null)).toBe('Real name');
  });
});

/** ONE source: the panel's helpers (pagePopupModel.ts) delegate to the cards' (widgetModel.ts),
 *  so a file never reads one way on a card and another in the panel. */
describe('the panel and the cards read a page the same way', () => {
  const paths = [
    'pricing-sheet.pdf', 'docs/Q3_report-final.html', 'README.md', '.hidden.md', 'docs/.hidden.md', 'docs/.pdf',
    'docs/---.md', 'a/b/launch-plan.md', 'Deck.PDF', 'site/old_landing.htm', 'v1.2-notes.md', 'docs/CHANGELOG',
  ];
  it('pageTitleFromPath is humanizeFileName', () => {
    for (const p of paths) expect(pageTitleFromPath(p)).toBe(humanizeFileName(p));
    expect(pageTitleFromPath('.hidden.md')).toBe('Hidden');
  });

  it('pageTypeChip says what pageTypeLabel says, with a knowledge page read as the MD file it is', () => {
    for (const ref of ['docs/notes.md', 'Deck.PDF', 'site/index.html', 'site/old.htm', 'onboarding', '../x.md', 'a.png', 42]) {
      const label = pageTypeLabel(ref);
      expect(pageTypeChip(ref)).toBe(label === 'Knowledge' ? 'MD' : label);
    }
  });

  it('pageKindChip and pageKindLabel name a file kind the same', () => {
    for (const kind of ['md', 'pdf', 'html'] as const) expect(pageKindChip(kind)).toBe(pageKindLabel(kind));
    expect(pageKindLabel('knowledge')).toBe('Knowledge');
  });
});
