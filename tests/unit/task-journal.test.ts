import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendJournalEntry,
  foldEntryTexts,
  journalPath,
  moveJournal,
  normalizeEntryText,
  parseJournal,
  readJournal,
  retireJournal,
  splitEntryTexts,
  JournalPathError,
} from '../../src/lib/task-journal.js';
import { cardHasChangelog, foldCardChangelog, splitCard } from '../../src/lib/task-card.js';
import { buildCorpus } from '../../src/lib/recall.js';
import { classifyPath, mergeTaskJournal, mergeTaskMd } from '../../src/lib/git-sync/semantic-merge.js';
import { buildBrainGitignore } from '../../src/lib/git-sync/brain-repo.js';
import { REMOTE_BACKEND_GITIGNORE_ENTRIES } from '../../src/lib/task-backend/paths.js';

let root: string;
let stateDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-journal-')));
  stateDir = join(root, '_dream_context', 'state');
  mkdirSync(stateDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const LEGACY = [
  '### 2026-10-15 - Session Update',
  '- second log',
  '### 2026-10-14 - Session Update',
  '- first log',
  '### 2026-10-14 - Session Update',
  '- first log',
  '### 2026-10-13 - Created',
  '- Task created.',
].join('\n');

describe('journal entry identity', () => {
  it('new entries carry a stable explicit id in the heading', () => {
    const e = appendJournalEntry(stateDir, 'a', { kind: 'log', body: '- hello', now: new Date('2026-10-16T10:05:00Z') });
    expect(e.id).toMatch(/^je_[A-Za-z0-9]{10}$/);
    const raw = readFileSync(journalPath(stateDir, 'a'), 'utf-8');
    expect(raw).toBe(`### 2026-10-16 10:05 - log [${e.id}]\n- hello\n`);
    expect(readJournal(stateDir, 'a')[0]).toMatchObject({ id: e.id, explicitId: true, kind: 'log', date: '2026-10-16 10:05' });
  });

  it('legacy entries get content-hash ids that do not move when entries are prepended, and identical texts stay distinct', () => {
    const before = parseJournal(LEGACY);
    expect(before.map((e) => e.explicitId)).toEqual([false, false, false, false]);
    expect(before.every((e) => /^je_h[0-9a-f]{10}$/.test(e.id))).toBe(true);
    // The two identical "first log" entries are told apart (ordinal from the oldest end).
    expect(before[1].id).not.toBe(before[2].id);
    writeFileSync(join(stateDir, 'journal.tmp'), '');
    mkdirSync(join(stateDir, 'journal'), { recursive: true });
    writeFileSync(journalPath(stateDir, 't'), LEGACY);
    appendJournalEntry(stateDir, 't', { kind: 'log', body: '- first log' });
    appendJournalEntry(stateDir, 't', { kind: 'status', label: 'Completed', body: '- done' });
    const after = readJournal(stateDir, 't');
    expect(after.slice(2).map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(after[0]).toMatchObject({ kind: 'status', label: 'Completed' });
  });

  it('legacy labels map to kinds; the heading id and je markers do not change the comparison form', () => {
    const [created] = parseJournal('### 2026-10-13 - Created\n- Task created.');
    expect(created.kind).toBe('created');
    const [completed] = parseJournal('### 2026-10-13 - Completed\n- shipped');
    expect(completed.kind).toBe('status');
    expect(normalizeEntryText('### 2026-10-13 - log [je_abcdefghij]\n- x\n\n<!-- je:je_abcdefghij -->'))
      .toBe(normalizeEntryText('### 2026-10-13 - log\n- x'));
  });
});

describe('continuous fold (copy counting)', () => {
  it('a Changelog of the migrated legacy entries + 2 new on top adds exactly 2; folding again adds 0', () => {
    mkdirSync(join(stateDir, 'journal'), { recursive: true });
    writeFileSync(journalPath(stateDir, 't'), LEGACY);
    const incoming = splitEntryTexts(`### 2026-10-16 - Session Update\n- new two\n### 2026-10-16 - Session Update\n- new one\n${LEGACY}`);
    expect(foldEntryTexts(stateDir, 't', incoming)).toBe(2);
    expect(foldEntryTexts(stateDir, 't', incoming)).toBe(0);
    const texts = readJournal(stateDir, 't').map((e) => e.body);
    expect(texts.filter((t) => t === '- first log')).toHaveLength(2);
    expect(texts.slice(0, 2)).toEqual(['- new two', '- new one']);
  });

  it('a card that regained a Changelog is folded on the next write and loses the section', () => {
    const card = join(stateDir, 'c.md');
    writeFileSync(card, `---\nid: task_x\nname: C\nstatus: todo\n---\n\n## Why\n\nBecause.\n\n## Changelog\n<!-- LIFO: newest at top -->\n\n${LEGACY}\n`);
    expect(cardHasChangelog(readFileSync(card, 'utf-8'))).toBe(true);
    expect(foldCardChangelog(card)).toBe(4);
    const after = readFileSync(card, 'utf-8');
    expect(after).not.toContain('## Changelog');
    expect(after).toBe('---\nid: task_x\nname: C\nstatus: todo\n---\n\n## Why\n\nBecause.\n');
    expect(foldCardChangelog(card)).toBeNull();
  });
});

describe('card split byte ledger', () => {
  it('card + journal + stripped reassemble to the original; added bytes are only the legacy evidence marks', () => {
    const original = [
      '---', 'id: task_x', 'name: "X"', '---', '',
      '## Why',
      '<!-- What problem does this solve? What breaks if we don\'t do it? Be concrete — name the user, the friction, the cost. -->',
      '', 'Because.', '',
      '<!-- Other sections (User Stories, Acceptance Criteria, Workflow, Constraints & Decisions, Technical Details, Notes) are created on first insert — `dreamcontext tasks insert <task> <section> "…"`. A section that has nothing to say doesn\'t exist. -->',
      '',
      '## Acceptance Criteria', '', '- [x] done thing', '- [ ] open thing', '- [x] proven (evidence: commit:abc1234)', '',
      '```md', '## Changelog', 'inside a fence stays', '```', '',
      '## Changelog', '<!-- LIFO: newest at top. Auto-prepended by `dreamcontext tasks log`. -->', '', '',
      LEGACY, '',
    ].join('\n');
    const split = splitCard(original, { markLegacyTicks: true });
    const reassembled = split.segments.filter((s) => s.kind !== 'added').map((s) => s.text).join('');
    expect(reassembled).toBe(original);
    expect(split.added).toBe(' (evidence: legacy)');
    expect(split.legacyTicks).toBe(1);
    expect(split.templateComments).toBe(3);
    expect(split.card).not.toContain('<!--');
    expect(split.card).toContain('inside a fence stays');
    expect(split.card).toContain('- [x] done thing (evidence: legacy)');
    expect(split.card).toContain('- [x] proven (evidence: commit:abc1234)');
    expect(split.card.endsWith('```\n')).toBe(true);
    expect(split.journal.trim()).toBe(LEGACY);
  });
});

describe('the journal follows its card', () => {
  it('rename moves it (folding into one already there); delete retires it beside the tombstone', () => {
    appendJournalEntry(stateDir, 'old', { kind: 'log', body: '- a' });
    moveJournal(stateDir, 'old', 'new');
    expect(existsSync(journalPath(stateDir, 'old'))).toBe(false);
    expect(readJournal(stateDir, 'new')).toHaveLength(1);
    const to = retireJournal(stateDir, 'new', '2026-10-16T10:00:00.000Z');
    expect(to).toContain(join('journal', '.deleted', 'new--2026-10-16T10-00-00-000Z.md'));
    expect(existsSync(journalPath(stateDir, 'new'))).toBe(false);
    expect(readdirSync(join(stateDir, 'journal', '.deleted'))).toHaveLength(1);
  });

  it('a symlinked journal directory is refused', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(stateDir, 'journal'));
    expect(() => journalPath(stateDir, 'x')).toThrow(JournalPathError);
    expect(() => appendJournalEntry(stateDir, 'x', { kind: 'log', body: '- no' })).toThrow(JournalPathError);
    expect(readdirSync(elsewhere)).toHaveLength(0);
  });
});

describe('the journal is never a task anywhere else', () => {
  it('recall does not index it as a task', () => {
    writeFileSync(join(stateDir, 'real-task.md'), '---\nid: task_r\nname: Real\nstatus: todo\n---\n\n## Why\n\nzebra-unique-card\n');
    appendJournalEntry(stateDir, 'real-task', { kind: 'log', body: '- giraffe-unique-history' });
    const docs = buildCorpus(join(root, '_dream_context'), { types: ['task'] });
    const paths = docs.map((d) => d.relPath);
    expect(paths).toContain('state/real-task.md');
    expect(paths.some((p) => p.includes('journal/'))).toBe(false);
  });

  it('git merge classifies it as its own type and unions entries by id', () => {
    expect(classifyPath('_dream_context/state/journal/x.md')).toBe('task-journal');
    expect(classifyPath('state/x.md')).toBe('task-md');
    const base = '### 2026-10-14 - Session Update\n- legacy\n';
    const ours = `### 2026-10-16 10:00 - log [je_ours000001]\n- ours\n\n${base}`;
    const theirs = `### 2026-10-16 11:00 - log [je_their00001]\n- theirs\n\n${base}`;
    const merged = mergeTaskJournal(base, ours, theirs).merged;
    const entries = parseJournal(merged);
    expect(entries.map((e) => e.body)).toEqual(['- theirs', '- ours', '- legacy']);
    expect(mergeTaskJournal(base, merged, theirs).merged).toBe(merged);
  });

  it('the task merge never re-creates an empty Changelog on a card', () => {
    const card = '---\nid: task_x\nname: X\nstatus: todo\nupdated_at: "2026-10-16"\n---\n\n## Why\n\nBecause.\n';
    const edited = card.replace('Because.', 'Because, really.');
    expect(mergeTaskMd(card, edited, card).merged).not.toContain('Changelog');
  });

  it('a remote backend ignores journals in git, both in the brain repo and the project', () => {
    expect(buildBrainGitignore('github')).toContain('state/journal/');
    expect(buildBrainGitignore('local')).not.toContain('state/journal/');
    expect(REMOTE_BACKEND_GITIGNORE_ENTRIES).toContain('_dream_context/state/journal/');
  });
});
