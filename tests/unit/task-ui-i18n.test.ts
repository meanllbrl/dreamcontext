/**
 * The task screens speak English and Turkish (plan r3 § 5f, C5 validation "TR/EN parity").
 *
 *  1. Key parity: every key under the task screens' prefixes is in English AND in Turkish, and
 *     the Turkish keeps every `{placeholder}`.
 *  2. Every key the new or edited files read, literally or through a known dynamic family,
 *     resolves in both.
 *  3. No bare JSX text in the new files: every visible word goes through `t()`.
 *
 * A source scan, like `sidebar-nav.test.ts`: root vitest runs plain Node and cannot render JSX.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'dashboard', 'src');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf-8');
const dir = (p: string): string[] => readdirSync(join(SRC, p)).filter((f) => f.endsWith('.tsx')).map((f) => `${p}/${f}`);
/** The source with its comments taken out, so a pin cannot pass (or fail) on a comment. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ');

const I18N = read('context/I18nContext.tsx');
const TR_START = I18N.indexOf('const TR_PARTIAL');
const EN_BLOCK = I18N.slice(0, TR_START);
const TR_BLOCK = I18N.slice(TR_START, I18N.indexOf('const PARTIALS'));

/** Every `'key': 'value'` of one strings block. */
function entries(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/^\s*'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gm)) out.set(m[1], m[2] ?? m[3]);
  return out;
}
const EN = entries(EN_BLOCK);
const TR = entries(TR_BLOCK);

// The Inbox page's sections, not `inbox.` whole: the older `inbox.title` / `inbox.refresh` / …
// belong to the desktop notifications window (components/appLink/InboxWindow.tsx).
const PREFIXES = [
  'taskPage.', 'board.', 'planning.', 'closeDeck.', 'releases.', 'giveAgent.',
  'inbox.reviews.', 'inbox.proposals.', 'inbox.flags.', 'inbox.learned.', 'inbox.records.',
];
const NAV_KEYS = ['nav.task', 'nav.inbox', 'nav.planning', 'nav.releases', 'nav.inbox.waitingBadge'];
const owned = (k: string) => PREFIXES.some((p) => k.startsWith(p)) || NAV_KEYS.includes(k);

/** The files W5 created: every word in them goes through `t()`. */
const NEW_FILES = [
  'pages/TaskPage.tsx', 'pages/InboxPage.tsx', 'pages/PlanningPage.tsx', 'pages/ReleasesPage.tsx',
  ...dir('components/tasks/page'),
  ...dir('components/inbox').filter((f) => !f.endsWith('ProposalsSection.tsx')),
  ...dir('components/planning'), ...dir('components/releases'), ...dir('components/agent-door'),
  'components/tasks/CycleStrip.tsx',
];
/** The board files W5 edited, whose chrome now goes through `t()` too. */
const EDITED_FILES = [
  'components/tasks/KanbanBoard.tsx', 'components/tasks/BoardToolbar.tsx', 'components/tasks/BoardViewTabs.tsx',
  'components/tasks/TimelineGantt.tsx', 'components/tasks/BoardCard.tsx', 'components/tasks/BoardColumn.tsx',
];

/** The dynamic key families these files build (`t(\`board.sort.${k}\`)`), with every member. */
const DYNAMIC: Record<string, string[]> = {
  'board.dim.': ['order', 'status', 'version', 'assignee'],
  'board.layout.': ['board', 'list', 'timeline'],
  'board.sort.': ['manual', 'rank', 'due', 'updated', 'created', 'name'],
  'board.due.': ['all', 'overdue', 'today', 'risk', 'has', 'none'],
  'board.prop.': ['description', 'tags', 'due', 'assignee', 'version'],
  'taskPage.evidence.': ['cmd', 'commit', 'shot', 'owner', 'legacy'],
  'inbox.records.kind.': ['approval', 'send_back', 'accept', 'apply', 'force', 'held_open', 'exempt'],
  'inbox.records.via.': ['cli', 'dashboard', 'phone', 'no-origin'],
  'planning.status.': ['planned', 'active', 'closed'],
  'closeDeck.action.': ['carry', 'back', 'cancel'],
  'giveAgent.choice.': ['develop', 'agent', 'custom', 'author', 'developHint', 'agentHint', 'customHint', 'authorHint'],
  'tasks.': ['todo', 'in_progress', 'in_review', 'completed'],
};

describe('task screens: English and Turkish key parity', () => {
  it('every task-screen key is in both, and the Turkish is a translation', () => {
    const enOwned = [...EN.keys()].filter(owned);
    const trOwned = [...TR.keys()].filter(owned);
    expect(enOwned.length).toBeGreaterThan(250);
    expect(enOwned.filter((k) => !TR.has(k)), 'English keys with no Turkish').toEqual([]);
    expect(trOwned.filter((k) => !EN.has(k)), 'Turkish keys with no English').toEqual([]);
  });

  it('the Turkish keeps every placeholder of the English', () => {
    const lost: string[] = [];
    for (const k of [...EN.keys()].filter(owned)) {
      for (const ph of EN.get(k)!.match(/\{\w+\}/g) ?? []) if (!TR.get(k)?.includes(ph)) lost.push(`${k} ${ph}`);
    }
    expect(lost).toEqual([]);
  });

  it('every dynamic family member exists in both', () => {
    const missing: string[] = [];
    for (const [prefix, members] of Object.entries(DYNAMIC)) {
      for (const m of members) {
        const k = `${prefix}${m}`;
        if (!EN.has(k)) missing.push(`${k} (en)`);
        if (!TR.has(k)) missing.push(`${k} (tr)`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('task screens: every key read resolves', () => {
  for (const f of [...NEW_FILES, ...EDITED_FILES]) {
    it(f, () => {
      const src = code(read(f));
      const literal = [...src.matchAll(/(?<![\w.])t\('([A-Za-z0-9_.-]+)'\)/g)].map((m) => m[1]);
      const viaTr = [...src.matchAll(/\btr\(t, '([A-Za-z0-9_.-]+)'/g)].map((m) => m[1]);
      const missing = [...literal, ...viaTr].filter((k) => !EN.has(k) || !TR.has(k));
      expect(missing, `${f}: keys missing in en or tr`).toEqual([]);
      // A dynamic key must belong to a family listed above (so the family test covers it).
      for (const m of src.matchAll(/(?<![\w.])t\(`([A-Za-z0-9_.]+)\$\{/g)) {
        expect(Object.keys(DYNAMIC), `${f}: unlisted dynamic family ${m[1]}`).toContain(m[1]);
      }
    });
  }
});

describe('task screens: no bare JSX text in the new files', () => {
  for (const f of NEW_FILES) {
    it(f, () => {
      const src = code(read(f));
      // Text sitting between a tag's `>` and a closing tag on the same line, with no `{…}`:
      // `<span>Delete task</span>`. An arrow's `=>` is not a tag.
      const bare = [...src.matchAll(/(?<![=\-])>([^<>{}\n]*[A-Za-z]{2,}[^<>{}\n]*)<\//g)].map((m) => m[1].trim());
      expect(bare, `${f}: words that do not go through t()`).toEqual([]);
      // And no English sentence in a string attribute a person reads.
      const attrs = [...src.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"]*[A-Za-z]{2,}[^"]*)"/g)].map((m) => m[1]);
      expect(attrs, `${f}: attribute text that does not go through t()`).toEqual([]);
    });
  }
});

/**
 * End review, finding 7: a board sub-group label is often data (an assignee, a version, a custom
 * status). CSS `uppercase` turns a Turkish `i` into `I` (not `İ`) under an English document, so
 * the label keeps its case and is marked `lang="und"`, like every other task-authored name.
 */
describe('board sub-group labels keep the case they were written in', () => {
  it('BoardColumn renders sub.label without text-transform, in a lang="und" span', () => {
    const src = code(read('components/tasks/BoardColumn.tsx'));
    const label = /<span lang="und" style=\{\{[^}]*\}\}>\{sub\.label\}<\/span>/.exec(src)?.[0] ?? '';
    expect(label, 'the sub-group label span').not.toBe('');
    expect(label).not.toMatch(/textTransform/);
  });
});
