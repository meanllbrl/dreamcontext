/**
 * Every card on the Super stage has a readable name (owner 2026-10-22: a group tile listed
 * "_dream_context/tm…" paths and task slugs: "başlıkları yok"). superTitles.ts decides it for the
 * tile, a group's list, a panel and Others alike.
 */
import { describe, it, expect } from 'vitest';
import { cardTitle, humanizeFile, pageName, stripTags } from '../../dashboard/src/components/sleepy/super/superTitles.js';

const from = {
  chat: (ref: string) => (ref === 'kid' ? '<untrusted-project-output vault="acme">Fix the login button</untrusted-project-output>' : ''),
  team: (ref: string) => (ref === 'team-1' ? 'doctor' : undefined),
  task: (slug: string) => (slug === 'ship-the-share-sheet' ? 'Ship the share sheet' : undefined),
};

describe('cardTitle', () => {
  it('a picture or a local page is named by its file, never its path', () => {
    expect(cardTitle({ kind: 'image', ref: '_dream_context/tmp/agent-drops/A-agac-listede.png' }, from)).toBe('A agac listede');
    expect(cardTitle({ kind: 'image', ref: 'tmp/1792687062767-before_after.png' }, from)).toBe('Before after');
    expect(cardTitle({ kind: 'web', ref: 'mockups/share-sheet-before-after.html' }, from)).toBe('Share sheet before after');
    expect(cardTitle({ kind: 'web', ref: 'https://example.com/pricing/' }, from)).toBe('example.com/pricing');
    expect(cardTitle({ kind: 'web', ref: 'http://localhost:5173' }, from)).toBe('localhost:5173');
  });

  it('a task by its title (its slug made readable until the list is read)', () => {
    expect(cardTitle({ kind: 'task', ref: 'ship-the-share-sheet' }, from)).toBe('Ship the share sheet');
    expect(cardTitle({ kind: 'task', ref: 'agents-epic-finish' }, from)).toBe('Agents epic finish');
  });

  it('a chat by its brief, the untrusted fence taken off; a given label wins elsewhere', () => {
    expect(cardTitle({ kind: 'chat', ref: 'kid' }, from)).toBe('Fix the login button');
    expect(cardTitle({ kind: 'image', ref: 'a/b.png', title: 'Önce: liste' }, from)).toBe('Önce: liste');
    expect(cardTitle({ kind: 'task', ref: 'x', title: '<untrusted-project-output vault="a">Named</untrusted-project-output>' }, from)).toBe('Named');
    expect(cardTitle({ kind: 'team', ref: 'team-1' }, from)).toBe('doctor');
    expect(cardTitle({ kind: 'knowledge', ref: 'pricing-notes' }, from)).toBe('Pricing notes');
  });

  it('the helpers', () => {
    expect(stripTags('<b>x</b> y')).toBe('x y');
    expect(humanizeFile('docs/x.svg')).toBe('X');
    expect(pageName('not a url')).toBe('Not a url');
  });
});
