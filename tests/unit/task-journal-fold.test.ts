import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';

import { convertJournalHeading, canonicalEntry, convertJournalText, MAX_HEADING_LINE } from '../../src/lib/task-backend/legacy-journal.js';
import { unionChangelog } from '../../src/lib/task-backend/merge.js';
import { normalizeEntry } from '../../src/lib/task-backend/clickup-map.js';
import { foldJournalIntoCard, foldTaskJournals, hasTaskJournals, journalsTravelByGit } from '../../src/lib/task-journal-fold.js';
import { hashContent } from '../../src/lib/task-backend/sync-state.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { bodyToIssueBody } from '../../src/lib/task-backend/github-map.js';
import { buildCorpus } from '../../src/lib/recall.js';
import { runMigrations } from '../../src/lib/migration-runner.js';
import { readLedger } from '../../src/lib/migration-ledger.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * The reverted 0.33.0 task system moved every `## Changelog` into
 * `state/journal/<slug>.md`. The 0.32.0 fold puts that history back on the
 * card, records it as already posted in the sync ledger, and moves the journals
 * where neither the task lister nor recall reads. Fixture vault: fictional.
 */

let root: string;
let ctx: string;

beforeEach(() => {
  const raw = join(tmpdir(), `dc-fold-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  root = realpathSync(raw);
  ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'state', 'journal'), { recursive: true });
  mkdirSync(join(ctx, 'core'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const card = (name: string, tail = '## Notes\n\nKeep the orbit tiles square.\n') => `---
id: task_${name.replace(/\W/g, '').slice(0, 8)}
name: ${name}
description: Orbit tiles
priority: medium
urgency: medium
status: in_progress
created_at: '2026-09-01'
updated_at: '2026-10-19'
tags: []
parent_task: null
related_feature: null
version: null
queue: next
rank: 1000
---
## Why

Orbit needs square tiles.

${tail}`;

const LEGACY_JOURNAL = `
### 2026-09-03 - Session Update
- measured the tile grid

### 2026-09-01 - Created
- Task created.
`;

const V033_JOURNAL = `### 2026-10-19 21:04 - log [je_GdiRYGvJEp]
- tiles land square at 1280

### 2026-10-19 20:52 - evidence [je_Phk7pS5rMi] (by orbit-owner)
- criterion 1: grid measured
${LEGACY_JOURNAL}`;

describe('0.33.0 headings', () => {
  it('rewrites each 0.33.0 kind to the shape this CLI writes and leaves every other line alone', () => {
    expect(convertJournalHeading('### 2026-10-19 21:04 - log [je_GdiRYGvJEp]')).toBe('### 2026-10-19 - Session Update');
    expect(convertJournalHeading('### 2026-10-19 21:21 - status: Status → in_review [je_laxAl3HL6A]')).toBe('### 2026-10-19 - Status → in_review');
    expect(convertJournalHeading('### 2026-10-19 20:52 - evidence [je_Phk7pS5rMi] (by orbit-owner)')).toBe('### 2026-10-19 - Evidence (by orbit-owner)');
    expect(convertJournalHeading('### 2026-10-19 21:26 - created [je_I2rhntXASM]')).toBe('### 2026-10-19 - Created');
    expect(convertJournalHeading('### 2026-10-20 01:03 - sleep [je_8jKfXiLU9f]')).toBe('### 2026-10-20 - Sleep');
    expect(convertJournalHeading('### 2026-10-20 01:03 - remote [je_8jKfXiLU9f] (by remote:kerem)')).toBe('### 2026-10-20 - Comment (by kerem)');
    // A heading this CLI wrote (no `[je_…]`) is not touched.
    expect(convertJournalHeading('### 2026-09-03 - Session Update')).toBeNull();
    expect(convertJournalHeading('### 2026-09-03 - Fix (by reviewer)')).toBeNull();
  });

  it('a comment 0.33.0 posted (its heading, its marker) compares equal to the folded entry', () => {
    const posted = '### 2026-10-19 21:04 - log [je_GdiRYGvJEp]\n- tiles land square at 1280\n\n<!-- je:je_GdiRYGvJEp -->';
    expect(canonicalEntry(posted)).toBe(canonicalEntry('### 2026-10-19 - Session Update\n- tiles land square at 1280'));
  });
});

/**
 * Raw ClickUp/GitHub comments and teammates' cards reach these functions on every
 * sync. The first heading pattern backtracked catastrophically (0.8 s for one
 * 500-blank line, 49 s at 4,000); the marker pattern was quadratic on any blank run.
 */
describe('0.33.0 shape on hostile input', () => {
  // Best of three: a backtracking pattern is slow on every attempt, while one GC pause or a
  // descheduled worker under a full parallel run (seen once at 100k) is not a regression.
  const within = (ms: number, fn: () => unknown) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = performance.now();
      fn();
      if (performance.now() - t < ms) return true;
    }
    return false;
  };
  const hostile = (n: number) => [
    `### 2026-01-01 - ${' '.repeat(n)}x`,
    `### 2026-01-01 - ${' '.repeat(n)}[je_`,
    `### 2026-01-01 21:04 -${' \t'.repeat(n / 2)}log${' '.repeat(n)}[je_abcd]x`,
    `### 2026-01-01 - log [je_abcd] (by ${' '.repeat(n)}`,
    `a${' '.repeat(n)}b`,
    `a${' \t'.repeat(n / 2)}<!-- je:x`,
    `${' '.repeat(n)}<!-- je:${'-'.repeat(n)}x`,
    `<!--${' '.repeat(n)}je:x`,
  ];

  it('a heading-sized line (under the length cap) is still decided in linear time', () => {
    const room = MAX_HEADING_LINE - 30;
    for (const line of hostile(room)) {
      const capped = line.slice(0, MAX_HEADING_LINE);
      expect(within(50, () => convertJournalHeading(capped)), JSON.stringify(capped.slice(0, 40))).toBe(true);
      expect(within(50, () => canonicalEntry(capped)), JSON.stringify(capped.slice(0, 40))).toBe(true);
    }
  });

  it.each([10_000, 100_000])('a %i-character line finishes in under 50 ms on every sync path', (n) => {
    for (const line of hostile(n)) {
      const label = JSON.stringify(line.slice(0, 40));
      expect(within(50, () => convertJournalHeading(line)), label).toBe(true);
      expect(within(50, () => convertJournalText(line)), label).toBe(true);
      expect(within(50, () => canonicalEntry(line)), label).toBe(true);
      expect(within(50, () => normalizeEntry(line)), label).toBe(true);
      expect(within(50, () => unionChangelog([line], [line, `${line}y`])), label).toBe(true);
    }
  });

  it('the linear rewrite reads the same headings and markers as before', () => {
    expect(convertJournalHeading('### 2026-10-19 21:04 -  [je_GdiRYGvJEp]')).toBe('### 2026-10-19 - ');
    expect(convertJournalHeading('### 2026-10-19 21:04 - [je_GdiRYGvJEp]')).toBeNull();
    expect(convertJournalHeading('### 2026-10-19 21:04 - log[je_GdiRYGvJEp]')).toBeNull();
    expect(convertJournalHeading('### 2026-10-19 21:04 - log [je_GdiRYGvJEp] trailing')).toBeNull();
    expect(convertJournalHeading('### 2026-10-19 21:04 - log [je_GdiRYGvJEp]\r')).toBe('### 2026-10-19 - Session Update');
    expect(convertJournalHeading('### 2026-10-19T21:04 - status: Status → done [je_GdiRYGvJEp]  (by remote:kerem) ')).toBe('### 2026-10-19 - Status → done (by kerem)');
    expect(convertJournalHeading('### 2026-10-19 - Fix the [je_ parser [je_GdiRYGvJEp]')).toBe('### 2026-10-19 - Fix the [je_ parser');
    expect(convertJournalText('- shipped \t<!-- je:je_GdiRYGvJEp -->')).toBe('- shipped');
    expect(convertJournalText('a <!-- je:je_A --> b\t<!--je:je_B-->')).toBe('a b');
    expect(convertJournalText('a <!-- not a marker --> b')).toBe('a <!-- not a marker --> b');
    // Past the cap a line is not a 0.33.0 heading: it stays exactly as written.
    const long = `### 2026-10-19 21:04 - log: ${'x'.repeat(MAX_HEADING_LINE)} [je_GdiRYGvJEp]`;
    expect(convertJournalHeading(long)).toBeNull();
  });
});

describe('changelog union keeps multiplicity', () => {
  // The canonical form drops a 0.33.0 entry's time and id: these two compare equal.
  const a = '### 2026-10-19 21:04 - log [je_GdiRYGvJEp]\n- ran the orbit suite';
  const b = '### 2026-10-19 22:10 - log [je_Phk7pS5rMi]\n- ran the orbit suite';
  const folded = '### 2026-10-19 - Session Update\n- ran the orbit suite';

  it('two same-day entries with the same words stay two, whichever side holds them', () => {
    expect(canonicalEntry(a)).toBe(canonicalEntry(b));
    expect(unionChangelog([], [a, b])).toEqual([a, b]);
    expect(unionChangelog([a], [a, b])).toEqual([b, a]);
    expect(unionChangelog([a, b], [a])).toEqual([a, b]);
    expect(unionChangelog([a, b], [b, a])).toEqual([a, b]);
    // The comments 0.33.0 posted for them still equal the two folded entries: no third copy.
    expect(unionChangelog([folded, folded], [`${a}\n\n<!-- je:je_GdiRYGvJEp -->`, b])).toEqual([folded, folded]);
  });
});

describe('foldJournalIntoCard', () => {
  it('creates the Changelog at the end of a card that has none, newest first, legacy bytes kept', () => {
    const out = foldJournalIntoCard(card('Orbit tiles'), V033_JOURNAL);
    expect(out.added).toBe(4);
    const tail = out.text.slice(out.text.indexOf('## Changelog'));
    expect(tail).toBe(`## Changelog
<!-- LIFO: newest entry at top -->

### 2026-10-19 - Session Update
- tiles land square at 1280

### 2026-10-19 - Evidence (by orbit-owner)
- criterion 1: grid measured

### 2026-09-03 - Session Update
- measured the tile grid

### 2026-09-01 - Created
- Task created.
`);
    // Notes is untouched and the frontmatter (queue/rank included) is byte-identical.
    expect(out.text.startsWith(card('Orbit tiles').trimEnd())).toBe(true);
    expect(bodyToIssueBody(out.text)).not.toContain('tiles land square');
  });

  it('skips what the card already holds and merges the rest by date; a second fold adds nothing', () => {
    const withLog = card('Orbit tiles', `## Notes\n\nx\n\n## Changelog\n<!-- LIFO: newest entry at top -->\n\n### 2026-10-20 - Session Update\n- logged after the revert\n\n### 2026-09-03 - Session Update\n- measured the tile grid\n`);
    const once = foldJournalIntoCard(withLog, V033_JOURNAL);
    expect(once.added).toBe(3);
    expect(once.present).toBe(1);
    const headings = once.text.split('\n').filter((l) => l.startsWith('### '));
    expect(headings).toEqual([
      '### 2026-10-20 - Session Update',
      '### 2026-10-19 - Session Update',
      '### 2026-10-19 - Evidence (by orbit-owner)',
      '### 2026-09-03 - Session Update',
      '### 2026-09-01 - Created',
    ]);
    const twice = foldJournalIntoCard(once.text, V033_JOURNAL);
    expect(twice.added).toBe(0);
    expect(twice.text).toBe(once.text);
  });

  it('moves the entries the reverted CLI appended at the card end into the Changelog, and only those', () => {
    const misfiled = card('Orbit tiles', [
      '## Notes', '', 'Keep the orbit tiles square.', '',
      '### 2026-10-11 - Session Update', '- an old dated note that belongs to Notes', '',
      '### 2026-10-20 - Session Update', '- first log after the revert', '',
      '### 2026-10-20 - Completed', '- shipped', '',
    ].join('\n'));
    const out = foldJournalIntoCard(misfiled, LEGACY_JOURNAL, { rescueSince: '2026-10-19', today: '2026-10-20' });
    expect(out.rescued).toBe(2);
    const notes = out.text.slice(out.text.indexOf('## Notes'), out.text.indexOf('## Changelog'));
    expect(notes).toContain('an old dated note that belongs to Notes');
    expect(notes).not.toContain('first log after the revert');
    expect(out.text.slice(out.text.indexOf('## Changelog')).split('\n').filter((l) => l.startsWith('### '))).toEqual([
      '### 2026-10-20 - Completed',
      '### 2026-10-20 - Session Update',
      '### 2026-09-03 - Session Update',
      '### 2026-09-01 - Created',
    ]);
    // Without a split date (no 0.33.0 ledger entry) nothing is moved.
    expect(foldJournalIntoCard(misfiled, LEGACY_JOURNAL).rescued).toBe(0);
  });
});

describe('the fold finds the Changelog exactly where the CLI reads it', () => {
  const readChangelog = async (slug: string) => (await new LocalTaskBackend(join(ctx, 'state')).get(slug))!.changelog;

  it('a CRLF card: its "## Changelog\\r" is no section to the reader, so the history goes where the reader looks', async () => {
    const crlf = card('Orbit tiles', '## Notes\n\nx\n\n## Changelog\n<!-- LIFO: newest entry at top -->\n\n### 2026-09-20 - Session Update\n- written on Windows\n').replace(/\n/g, '\r\n');
    writeFileSync(join(ctx, 'state', 'orbit-tiles.md'), crlf);
    expect(await readChangelog('orbit-tiles')).toBe(''); // the premise: the reader sees no CRLF section
    writeFileSync(join(ctx, 'state', 'journal', 'orbit-tiles.md'), V033_JOURNAL);

    const r = foldTaskJournals(ctx);
    expect(r.failed).toEqual([]);
    const seen = await readChangelog('orbit-tiles');
    expect(seen).toContain('### 2026-10-19 - Session Update\n- tiles land square at 1280');
    expect(seen).toContain('### 2026-09-01 - Created');
    // The CRLF section and its bytes are left as they were.
    expect(readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8').startsWith(crlf.trimEnd())).toBe(true);
  });

  it('a "## Changelog" line inside the frontmatter is YAML, not the section: the frontmatter is left intact', async () => {
    const withComment = card('Orbit tiles').replace('\nqueue: next\n', '\nqueue: next\n## Changelog\n');
    writeFileSync(join(ctx, 'state', 'orbit-tiles.md'), withComment);
    writeFileSync(join(ctx, 'state', 'journal', 'orbit-tiles.md'), LEGACY_JOURNAL);
    const before = matter(withComment).data;

    expect(foldTaskJournals(ctx).failed).toEqual([]);
    const after = readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8');
    expect(matter(after).data).toEqual(before);
    expect(after.startsWith(withComment.trimEnd())).toBe(true);
    expect(await readChangelog('orbit-tiles')).toContain('### 2026-09-03 - Session Update\n- measured the tile grid');
  });
});

describe('the rescue moves only what the reverted CLI wrote', () => {
  const RESCUE = { rescueSince: '2026-10-19', today: '2026-10-20' };
  const tailOf = (lines: string[]) => card('Orbit tiles', ['## Plan', '', 'Square tiles first.', '', ...lines, ''].join('\n'));
  const planOf = (text: string) => text.slice(text.indexOf('## Plan'), text.indexOf('## Changelog'));
  const cli = ['### 2026-10-20 - Session Update', '- logged after the revert'];

  it('takes the CLI shapes: a log, a bare status line, a handoff', () => {
    const out = foldJournalIntoCard(tailOf([
      ...cli, '',
      '### 2026-10-20 - Status → in_review', '',
      '### 2026-10-20 - Handoff', '- **Done:** the grid', '- **Next:** the legend',
    ]), LEGACY_JOURNAL, RESCUE);
    expect(out.rescued).toBe(3);
    expect(planOf(out.text)).not.toContain('###');
  });

  it('leaves a dated heading after today where the owner wrote it', () => {
    const out = foldJournalIntoCard(tailOf(['### 2026-11-03 - Session Update', '- planned for the beta']), LEGACY_JOURNAL, RESCUE);
    expect(out.rescued).toBe(0);
    expect(planOf(out.text)).toContain('### 2026-11-03 - Session Update\n- planned for the beta');
  });

  it("leaves the owner's own titles, however they are dated", () => {
    const out = foldJournalIntoCard(tailOf(['### 2026-10-20 - Beta ship', '- twenty testers', '', ...cli]), LEGACY_JOURNAL, RESCUE);
    expect(out.rescued).toBe(1);
    expect(planOf(out.text)).toContain('### 2026-10-20 - Beta ship\n- twenty testers');
    expect(planOf(out.text)).not.toContain('logged after the revert');
  });

  it('leaves a block whose body is not the CLI bullets', () => {
    const out = foldJournalIntoCard(tailOf(['### 2026-10-20 - Session Update', 'We decided to ship the grid first.', '- then the legend']), LEGACY_JOURNAL, RESCUE);
    expect(out.rescued).toBe(0);
    expect(planOf(out.text)).toContain('We decided to ship the grid first.');
  });

  it('never takes anything inside a code fence, and never splits one', () => {
    const fenced = ['```md', ...cli, '```'];
    const out = foldJournalIntoCard(tailOf(fenced), LEGACY_JOURNAL, RESCUE);
    expect(out.rescued).toBe(0);
    expect(planOf(out.text)).toContain(fenced.join('\n'));
    // An open fence that runs to the end of the card holds the entry too.
    const open = foldJournalIntoCard(tailOf(['~~~', ...cli]), LEGACY_JOURNAL, RESCUE);
    expect(open.rescued).toBe(0);
  });
});

describe('foldTaskJournals on a vault', () => {
  function writeVault(): void {
    writeFileSync(join(ctx, 'state', 'orbit-tiles.md'), card('Orbit tiles'));
    writeFileSync(join(ctx, 'state', 'journal', 'orbit-tiles.md'), V033_JOURNAL);
    writeFileSync(join(ctx, 'state', 'orbit-legend.md'), card('Orbit legend'));
    writeFileSync(join(ctx, 'state', 'journal', 'orbit-legend.md'), LEGACY_JOURNAL);
    mkdirSync(join(ctx, 'state', 'archive'), { recursive: true });
    writeFileSync(join(ctx, 'state', 'archive', 'orbit-v1.md'), card('Orbit v1'));
    writeFileSync(join(ctx, 'state', 'journal', 'orbit-v1.md'), LEGACY_JOURNAL);
    writeFileSync(join(ctx, 'state', 'journal', 'orbit-gone.md'), LEGACY_JOURNAL);
    mkdirSync(join(ctx, 'state', 'journal', '.deleted'), { recursive: true });
    writeFileSync(join(ctx, 'state', 'journal', '.deleted', 'orbit-old--2026-10-19.md'), LEGACY_JOURNAL);
  }

  it('folds every journal, moves them out of state/, and neither the lister nor recall sees them', async () => {
    writeVault();
    // Recall never reads a journal as a task, folded or not (a git-synced brain keeps them).
    const before = buildCorpus(ctx, { types: ['task'] });
    expect(before.some((d) => d.relPath.startsWith('state/journal/'))).toBe(false);
    expect(before.some((d) => d.relPath === 'state/orbit-tiles.md')).toBe(true);
    const tasksBefore = (await new LocalTaskBackend(join(ctx, 'state')).list()).length;

    const r = foldTaskJournals(ctx, { now: new Date('2026-10-20T12:00:00Z') });
    expect(r.failed).toEqual([]);
    expect(r.folded.sort()).toEqual(['orbit-legend', 'orbit-tiles', 'orbit-v1']);
    expect(r.orphans).toEqual(['orbit-gone']);
    expect(r.entriesAdded).toBe(4 + 2 + 2);

    // Cards (live and archived) carry their history again.
    expect(readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8')).toContain('### 2026-10-19 - Session Update\n- tiles land square at 1280');
    expect(readFileSync(join(ctx, 'state', 'archive', 'orbit-v1.md'), 'utf-8')).toContain('## Changelog');

    // Nothing is deleted: journals (orphan and .deleted too) and the pre-fold cards sit in the backup.
    expect(existsSync(join(ctx, 'state', 'journal'))).toBe(false);
    const backup = r.backupDir!;
    expect(backup.startsWith(join(ctx, 'tmp', 'folded-journals-'))).toBe(true);
    expect(readdirSync(join(backup, 'journal')).sort()).toEqual(['.deleted', 'orbit-gone.md', 'orbit-legend.md', 'orbit-tiles.md', 'orbit-v1.md']);
    expect(readFileSync(join(backup, 'cards', 'orbit-tiles.md'), 'utf-8')).toBe(card('Orbit tiles'));
    expect(readFileSync(join(backup, 'cards', 'archive', 'orbit-v1.md'), 'utf-8')).toBe(card('Orbit v1'));
    expect(readFileSync(join(backup, '.gitignore'), 'utf-8')).toBe('*\n');

    // Recall indexes no journal and nothing in the backup; the lister counts the same tasks.
    const after = buildCorpus(ctx);
    expect(after.filter((d) => d.relPath.startsWith('state/journal/') || d.relPath.startsWith('tmp/'))).toEqual([]);
    expect(after.filter((d) => d.type === 'task').map((d) => d.relPath).sort())
      .toEqual(['state/archive/orbit-v1.md', 'state/orbit-legend.md', 'state/orbit-tiles.md']);
    expect((await new LocalTaskBackend(join(ctx, 'state')).list()).length).toBe(tasksBefore);

    // Idempotent: a second run has nothing to do.
    const again = foldTaskJournals(ctx);
    expect(again.journals).toBe(0);
    expect(again.backupDir).toBeNull();
  });

  it('a busy task sync folds nothing and leaves every journal in place', () => {
    writeVault();
    writeFileSync(join(ctx, 'state', '.tasks-sync.lock'), JSON.stringify({ pid: 1, at: Date.now(), token: 'rival' }));
    const r = foldTaskJournals(ctx);
    expect(r.lockBusy).toBe(true);
    expect(r.failed.length).toBe(4);
    expect(readdirSync(join(ctx, 'state', 'journal')).filter((f) => f.endsWith('.md')).length).toBe(4);
    expect(readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8')).toBe(card('Orbit tiles'));
  });

  it('runs on a vault stamped 0.33.0 by the reverted build (downgrade), and only there writes the ledger', () => {
    writeFileSync(join(ctx, 'state', '.migrations.json'), JSON.stringify([
      { version: '0.33.0', step: 'task-journal-split', executor: 'code', timestamp: '2026-10-19T19:50:06.593Z', filesTouched: [], summary: 'split' },
    ]));
    writeVault();
    const r = runMigrations(ctx, '0.33.0', '0.32.0');
    expect(r.failedSteps).toBe(0);
    expect(r.applied.map((e) => `${e.version}/${e.step}`)).toEqual(['0.32.0/fold-task-journals']);
    expect(existsSync(join(ctx, 'state', 'journal'))).toBe(false);

    // Every later pass (setupVersion now 0.32.0, or any range) finds nothing and records nothing.
    const ledger = readLedger(ctx).length;
    expect(runMigrations(ctx, '0.32.0', '0.32.0').applied).toEqual([]);
    expect(readLedger(ctx).length).toBe(ledger);
  });

  const backups = () => (existsSync(join(ctx, 'tmp')) ? readdirSync(join(ctx, 'tmp')).filter((f) => f.startsWith('folded-journals-')) : []);

  it('a journal folder holding no real journal is no work: no backup folder and no ledger entry, however often it runs', () => {
    writeFileSync(join(root, 'elsewhere.md'), LEGACY_JOURNAL);
    symlinkSync(join(root, 'elsewhere.md'), join(ctx, 'state', 'journal', 'orbit-link.md'));
    mkdirSync(join(ctx, 'state', 'journal', 'orbit-dir.md'));
    expect(hasTaskJournals(ctx)).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(foldTaskJournals(ctx).backupDir).toBeNull();
      expect(runMigrations(ctx, '0.32.0', '0.32.0').applied).toEqual([]);
    }
    expect(backups()).toEqual([]);
  });

  it('a run that writes nothing (its only card unreadable) leaves no backup folder behind, run after run', () => {
    writeFileSync(join(ctx, 'state', 'orbit-tiles.md'), card('Orbit tiles'));
    writeFileSync(join(ctx, 'state', 'journal', 'orbit-tiles.md'), V033_JOURNAL);
    writeFileSync(join(ctx, 'state', '.tasks-sync.json'), JSON.stringify({ version: 1, watermark: null, tasks: {} }));
    chmodSync(join(ctx, 'state', 'orbit-tiles.md'), 0o000);
    try {
      for (let i = 0; i < 3; i++) {
        const r = foldTaskJournals(ctx);
        expect(r.failed.map((f) => f.slug)).toEqual(['orbit-tiles']);
        expect(r.backupDir).toBeNull();
      }
      expect(backups()).toEqual([]);
      expect(readFileSync(join(ctx, 'state', 'journal', 'orbit-tiles.md'), 'utf-8')).toBe(V033_JOURNAL);
    } finally {
      chmodSync(join(ctx, 'state', 'orbit-tiles.md'), 0o644);
    }
  });

  it('refuses a tmp/ that is a symlink (or a file): every journal reported, nothing written anywhere', () => {
    writeVault();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(ctx, 'tmp'));
    const r = foldTaskJournals(ctx);
    expect(r.backupDir).toBeNull();
    expect(r.failed.map((f) => f.slug).sort()).toEqual(['orbit-gone', 'orbit-legend', 'orbit-tiles', 'orbit-v1']);
    expect(r.failed.every((f) => /tmp\/ is a symlink/.test(f.reason))).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8')).toBe(card('Orbit tiles'));
    expect(readdirSync(join(ctx, 'state', 'journal')).filter((f) => f.endsWith('.md')).length).toBe(4);

    rmSync(join(ctx, 'tmp'));
    writeFileSync(join(ctx, 'tmp'), 'not a folder');
    const again = foldTaskJournals(ctx);
    expect(again.failed.length).toBe(4);
    expect(again.failed[0].reason).toMatch(/tmp\/ is not a directory/);
    expect(readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8')).toBe(card('Orbit tiles'));
  });

  it('a vault that never had journals gets no ledger entry and no ledger file', () => {
    expect(runMigrations(ctx, '0.31.0', '0.32.0').applied).toEqual([]);
    expect(existsSync(join(ctx, 'state', '.migrations.json'))).toBe(false);
  });
});

describe('a brain that syncs through git keeps its journals in place', () => {
  const journalDir = () => join(ctx, 'state', 'journal');
  const backups = () => (existsSync(join(ctx, 'tmp')) ? readdirSync(join(ctx, 'tmp')).filter((f) => f.startsWith('folded-journals-')) : []);
  const configWith = (brainRepo: Record<string, unknown>) => writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '0.32.0', brainRepo }));
  function writeVault(): void {
    writeFileSync(join(ctx, 'state', 'orbit-tiles.md'), card('Orbit tiles'));
    writeFileSync(join(journalDir(), 'orbit-tiles.md'), V033_JOURNAL);
    writeFileSync(join(ctx, 'state', 'orbit-legend.md'), card('Orbit legend'));
    writeFileSync(join(journalDir(), 'orbit-legend.md'), LEGACY_JOURNAL);
    writeFileSync(join(journalDir(), 'orbit-gone.md'), LEGACY_JOURNAL);
    mkdirSync(join(journalDir(), '.deleted'), { recursive: true });
    writeFileSync(join(journalDir(), '.deleted', 'orbit-old--2026-10-19.md'), LEGACY_JOURNAL);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

  it('knows which brains travel by git: brain sync on, or a journal git tracks', () => {
    writeVault();
    expect(journalsTravelByGit(ctx)).toBe(false); // no repo, no config
    configWith({ enabled: true, mode: 'full-repo' });
    expect(journalsTravelByGit(ctx)).toBe(true);
    configWith({ enabled: false, mode: 'in-tree' });
    git('init', '-q');
    expect(journalsTravelByGit(ctx)).toBe(false); // a repo, the journals untracked
    git('add', '_dream_context/state/journal/orbit-tiles.md');
    expect(journalsTravelByGit(ctx)).toBe(true); // tracked: a move would push a deletion
  });

  it('folds every journal onto its card and moves none of them, orphans and .deleted included', async () => {
    writeVault();
    configWith({ enabled: true, mode: 'full-repo' });
    const listed = readdirSync(journalDir()).sort();
    const r = foldTaskJournals(ctx, { now: new Date('2026-10-20T12:00:00Z') });
    expect(r.kept).toBe(true);
    expect(r.failed).toEqual([]);
    expect(r.folded.sort()).toEqual(['orbit-legend', 'orbit-tiles']);
    expect(readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8')).toContain('### 2026-10-19 - Session Update\n- tiles land square at 1280');
    expect(readdirSync(journalDir()).sort()).toEqual(listed);
    expect(readFileSync(join(journalDir(), 'orbit-tiles.md'), 'utf-8')).toBe(V033_JOURNAL);
    // The backup holds the pre-fold cards, and no journal (none moved).
    expect(readdirSync(join(r.backupDir!, 'journal'))).toEqual([]);
    expect(readFileSync(join(r.backupDir!, 'cards', 'orbit-tiles.md'), 'utf-8')).toBe(card('Orbit tiles'));
    // Neither recall nor the lister reads a journal left in place.
    expect(buildCorpus(ctx).filter((d) => d.relPath.startsWith('state/journal/'))).toEqual([]);
    expect((await new LocalTaskBackend(join(ctx, 'state')).list()).length).toBe(2);
  });

  it('a later run is the cheap check and nothing else: no fold, no backup folder, no ledger entry', () => {
    writeVault();
    configWith({ enabled: true, mode: 'full-repo' });
    const first = runMigrations(ctx, '0.32.0', '0.32.0');
    expect(first.applied.map((e) => e.step)).toEqual(['fold-task-journals']);
    expect(first.applied[0].summary).toMatch(/journals stay in state\/journal\//);
    const cards = readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8');
    const ledger = readLedger(ctx).length;
    const folders = backups().length;
    expect(hasTaskJournals(ctx)).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(runMigrations(ctx, '0.32.0', '0.32.0').applied).toEqual([]);
      expect(foldTaskJournals(ctx).journals).toBe(0);
    }
    expect(readLedger(ctx).length).toBe(ledger);
    expect(backups().length).toBe(folders);
    expect(readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8')).toBe(cards);
    // The stamp is this machine's: self-gitignored inside tmp/.
    expect(readFileSync(join(ctx, 'tmp', 'journal-fold', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  it('a checkout that only touches a journal re-reads it without folding it again (an entry removed since stays removed)', () => {
    writeVault();
    foldTaskJournals(ctx, { keepJournals: true });
    const path = join(ctx, 'state', 'orbit-tiles.md');
    const trimmed = readFileSync(path, 'utf-8').replace('### 2026-09-01 - Created\n- Task created.\n', '');
    writeFileSync(path, trimmed);
    utimesSync(join(journalDir(), 'orbit-tiles.md'), new Date('2026-10-21T00:00:00Z'), new Date('2026-10-21T00:00:00Z'));
    expect(hasTaskJournals(ctx)).toBe(true); // the cheap check cannot know the content is the same
    const r = foldTaskJournals(ctx, { keepJournals: true });
    expect(r.entriesAdded).toBe(0);
    expect(r.backupDir).toBeNull();
    expect(readFileSync(path, 'utf-8')).toBe(trimmed);
    expect(hasTaskJournals(ctx)).toBe(false);
  });

  it("a teammate's 0.33.0 adding to a journal, or an orphan's card arriving, is folded on the next run", () => {
    writeVault();
    foldTaskJournals(ctx, { keepJournals: true });
    writeFileSync(join(journalDir(), 'orbit-tiles.md'), `### 2026-10-20 09:00 - log [je_Zz9yX8wV7u]\n- legend tiles too\n\n${V033_JOURNAL}`);
    writeFileSync(join(ctx, 'state', 'orbit-gone.md'), card('Orbit gone'));
    expect(hasTaskJournals(ctx)).toBe(true);
    const r = foldTaskJournals(ctx, { keepJournals: true });
    expect(r.folded.sort()).toEqual(['orbit-gone', 'orbit-tiles']);
    expect(r.entriesAdded).toBe(1 + 2);
    expect(readFileSync(join(ctx, 'state', 'orbit-tiles.md'), 'utf-8')).toContain('### 2026-10-20 - Session Update\n- legend tiles too');
    expect(readFileSync(join(ctx, 'state', 'orbit-gone.md'), 'utf-8')).toContain('### 2026-09-03 - Session Update');
    expect(hasTaskJournals(ctx)).toBe(false);
  });

  it('a brain that does not sync through git still moves its journals out (control)', () => {
    writeVault();
    configWith({ enabled: false, mode: 'in-tree' });
    const r = foldTaskJournals(ctx);
    expect(r.kept).toBe(false);
    expect(existsSync(journalDir())).toBe(false);
  });
});

/**
 * What the reverted 0.33.0 migration + sync left for a task that 0.32 had synced: the
 * Changelog moved off the card AND off its sync base into the journal, a new 0.33.0
 * entry on top (posted by its sync with a marker), `posted_journal_ids` recorded.
 */
function simulate033(slug: string, postComment: (body: string) => void, serverNow: number): void {
  const path = join(ctx, 'state', `${slug}.md`);
  const syncPath = join(ctx, 'state', '.tasks-sync.json');
  const raw = readFileSync(path, 'utf-8');
  const at = raw.indexOf('## Changelog');
  const cardOnly = raw.slice(0, at).replace(/\s+$/, '\n');
  const legacy = raw.slice(at).split('\n').slice(2).join('\n');
  const newEntry = '### 2026-10-19 21:04 - log [je_GdiRYGvJEp]\n- tiles land square at 1280';
  writeFileSync(path, cardOnly);
  writeFileSync(join(ctx, 'state', 'journal', `${slug}.md`), `${newEntry}\n\n${legacy.trim()}\n`);
  postComment(`${newEntry}\n\n<!-- je:je_GdiRYGvJEp -->`);
  const state = JSON.parse(readFileSync(syncPath, 'utf-8'));
  const e = state.tasks[slug];
  const base = e.base_snapshot.body.slice(0, e.base_snapshot.body.indexOf('## Changelog')).replace(/\s+$/, '\n');
  e.base_snapshot = { hash: hashContent(base), body: base };
  e.localHash = hashContent(cardOnly);
  e.posted_journal_ids = ['je_GdiRYGvJEp', 'je_hdeadbeef01', 'je_hdeadbeef02'];
  e.last_synced_at = serverNow;
  writeFileSync(syncPath, JSON.stringify(state, null, 2));
}

/** 0.33.0 also gave every card queue/rank frontmatter; no backend may send either. */
function addQueueRank(slug: string): void {
  const path = join(ctx, 'state', `${slug}.md`);
  writeFileSync(path, readFileSync(path, 'utf-8').replace(/\n---\n/, '\nqueue: next\nrank: 1000\n---\n'));
}

const wireMentions = (requests: Array<{ body?: unknown }>, word: RegExp) =>
  requests.filter((q) => q.body !== undefined && word.test(JSON.stringify(q.body)));

describe('the next GitHub sync after the fold', () => {
  const CONFIG: SetupConfig = {
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.32.0', disableNativeMemory: true,
    taskBackend: 'github', cloudTaskManagement: true,
    github: { owner: 'meanllbrl', repo: 'dreamcontext', changelogTarget: 'comments' },
  };
  let fake: FakeGitHub;
  let clock: number;
  const backend = () => {
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    const adapter = new ApiAdapter({ baseUrl: 'https://api.github.com', authHeaders: () => ({ Authorization: 'Bearer ghp_test' }), fetchImpl: fake.fetchImpl, now, sleep });
    return new GitHubTaskBackend(ctx, CONFIG, { adapter, now, sleep });
  };
  const syncFile = () => join(ctx, 'state', '.tasks-sync.json');
  const commentPosts = () => fake.requests.filter((q) => q.method === 'POST' && /\/comments$/.test(q.path));

  /** A task synced by 0.32, then migrated and synced by 0.33.0 exactly as that build did. */
  async function vaultAfter033(): Promise<{ slug: string; issue: number }> {
    fake = makeFakeGitHub();
    clock = 1000;
    const gh = backend();
    await gh.create({ name: 'Orbit tiles', variant: 'cli' });
    await gh.addChangelog('orbit-tiles', '### 2026-09-03 - Session Update\n- measured the tile grid');
    await gh.sync('push');
    const issue = Number(JSON.parse(readFileSync(join(ctx, 'state', '.tasks-map.json'), 'utf-8'))[0].remoteId);
    expect(fake.comments.get(issue)).toHaveLength(2);
    simulate033('orbit-tiles', (body) => fake.addRemoteComment(issue, body, 'api-user'), fake.serverNow());
    return { slug: 'orbit-tiles', issue };
  }

  it('posts no comment for the folded history and pushes nothing for an in-sync card', async () => {
    const { issue } = await vaultAfter033();
    const r = foldTaskJournals(ctx);
    expect(r.ledgerSeeded).toBe(1);
    fake.requests.length = 0;

    const report = await backend().sync('push');
    expect(report.errors).toEqual([]);
    expect(commentPosts()).toEqual([]);
    expect(report.commentsAdded).toBe(0);
    expect(report.pushed).toBe(0);
    expect(fake.comments.get(issue)).toHaveLength(3);
  });

  it('machine B (its ledger never seeded, its base stale) posts none of the history the remote holds; a new entry still posts', async () => {
    const { issue } = await vaultAfter033();
    const r = foldTaskJournals(ctx);
    // A teammate's machine: the same folded card, the ledger as 0.33.0 left it there.
    cpSync(join(r.backupDir!, '.tasks-sync.json'), syncFile());
    fake.requests.length = 0;

    const report = await backend().sync('push');
    expect(report.errors).toEqual([]);
    expect(commentPosts()).toEqual([]);
    expect(report.commentsAdded).toBe(0);
    expect(fake.comments.get(issue)).toHaveLength(3);

    const fresh = '### 2026-10-21 - Session Update\n- tiles ship at 1440';
    await backend().addChangelog('orbit-tiles', fresh);
    fake.requests.length = 0;
    expect((await backend().sync('push')).errors).toEqual([]);
    expect(commentPosts().map((q) => (q.body as { body: string }).body)).toEqual([fresh]);
    expect(fake.comments.get(issue)).toHaveLength(4);
  });

  it('a later pull does not merge the comments 0.33.0 posted in a second time', async () => {
    const { slug, issue } = await vaultAfter033();
    foldTaskJournals(ctx);
    fake.editIssue(issue, { title: 'Orbit tiles (renamed remotely)' }); // forces a real pull of this issue

    const report = await backend().sync('pull');
    expect(report.errors).toEqual([]);
    const after = readFileSync(join(ctx, 'state', `${slug}.md`), 'utf-8');
    expect(after).toContain('Orbit tiles (renamed remotely)');
    const entries = after.split('\n').filter((l) => l.startsWith('### '));
    expect(entries).toEqual([
      '### 2026-10-19 - Session Update',
      '### 2026-09-03 - Session Update',
      expect.stringMatching(/^### \d{4}-\d{2}-\d{2} - Created$/),
    ]);
  });

  it('queue/rank frontmatter never reaches the wire on an update push', async () => {
    await vaultAfter033();
    foldTaskJournals(ctx);
    addQueueRank('orbit-tiles');
    await backend().updateFields('orbit-tiles', { priority: 'high' });
    fake.requests.length = 0;

    const report = await backend().sync('push');
    expect(report.errors).toEqual([]);
    expect(report.pushed).toBe(1);
    expect(commentPosts()).toEqual([]);
    expect(wireMentions(fake.requests, /queue|rank/)).toEqual([]);
    expect(wireMentions(fake.requests, /Orbit tiles/).length).toBeGreaterThan(0); // the task itself did travel
  });

  it('a second same-day entry with the same words is posted, not taken for the first', async () => {
    fake = makeFakeGitHub();
    clock = 1000;
    const gh = backend();
    await gh.create({ name: 'Orbit tiles', variant: 'cli' });
    const same = '### 2026-10-20 - Session Update\n- ran the orbit suite';
    await gh.addChangelog('orbit-tiles', same);
    await gh.sync('push');
    const issue = Number(JSON.parse(readFileSync(join(ctx, 'state', '.tasks-map.json'), 'utf-8'))[0].remoteId);
    expect(fake.comments.get(issue)).toHaveLength(2);

    await backend().addChangelog('orbit-tiles', same);
    fake.requests.length = 0;
    const report = await backend().sync('push');
    expect(report.errors).toEqual([]);
    expect(commentPosts().map((q) => (q.body as { body: string }).body)).toEqual([same]);
    expect(fake.comments.get(issue)).toHaveLength(3);
  });

  it('an entry the reverted CLI misfiled into the description leaves it and becomes a comment; nothing else posts', async () => {
    const { slug, issue } = await vaultAfter033();
    writeFileSync(join(ctx, 'state', '.migrations.json'), JSON.stringify([
      { version: '0.33.0', step: 'task-journal-split', executor: 'code', timestamp: '2026-10-19T19:50:06.593Z', filesTouched: [], summary: 'split' },
    ]));
    // What the reverted `tasks log` did, and the sync that pushed it as the description.
    const path = join(ctx, 'state', `${slug}.md`);
    writeFileSync(path, `${readFileSync(path, 'utf-8').trimEnd()}\n\n### 2026-10-20 - Session Update\n- misfiled after the revert\n`);
    await backend().sync('push');
    expect(fake.issues.get(issue)!.body).toContain('misfiled after the revert');

    const r = foldTaskJournals(ctx);
    expect(r.entriesRescued).toBe(1);
    fake.requests.length = 0;
    const report = await backend().sync('push');
    expect(report.errors).toEqual([]);
    expect(commentPosts().map((q) => (q.body as { body: string }).body)).toEqual(['### 2026-10-20 - Session Update\n- misfiled after the revert']);
    expect(fake.issues.get(issue)!.body).not.toContain('misfiled after the revert');
  });
});

describe('the next ClickUp sync after the fold', () => {
  const CONFIG: SetupConfig = {
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.32.0', disableNativeMemory: true,
    taskBackend: 'clickup', cloudTaskManagement: true,
    clickup: { teamId: 'team1', spaceId: 'space1', listId: 'list1', changelogTarget: 'comments' },
  };
  let fake: FakeClickUp;
  let clock: number;
  const backend = () => {
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    const adapter = new ApiAdapter({ baseUrl: 'https://api.clickup.com/api/v2', authHeaders: () => ({ Authorization: 'pk_test' }), fetchImpl: fake.fetchImpl, now, sleep });
    return new ClickUpTaskBackend(ctx, CONFIG, { adapter, now, sleep });
  };
  const commentPosts = () => fake.requests.filter((q) => q.method === 'POST' && /\/comment$/.test(q.path));

  async function vaultAfter033(): Promise<string> {
    fake = makeFakeClickUp();
    clock = 1000;
    const cu = backend();
    await cu.create({ name: 'Orbit tiles', variant: 'cli' });
    await cu.addChangelog('orbit-tiles', '### 2026-09-03 - Session Update\n- measured the tile grid');
    await cu.sync('push');
    const id = JSON.parse(readFileSync(join(ctx, 'state', '.tasks-map.json'), 'utf-8'))[0].remoteId as string;
    expect(fake.comments.get(id)).toHaveLength(2);
    simulate033('orbit-tiles', (body) => fake.addRemoteComment(id, body, 'api-user'), fake.serverNow());
    return id;
  }

  it('posts no comment for the folded history', async () => {
    const id = await vaultAfter033();
    const r = foldTaskJournals(ctx);
    expect(r.ledgerSeeded).toBe(1);
    fake.requests.length = 0;
    const report = await backend().sync('push');
    expect(report.errors).toEqual([]);
    expect(commentPosts()).toEqual([]);
    expect(report.pushed).toBe(0);
    expect(fake.comments.get(id)).toHaveLength(3);
  });

  it('machine B (its ledger never seeded, its base stale) posts none of the history the remote holds; a new entry still posts', async () => {
    const id = await vaultAfter033();
    const r = foldTaskJournals(ctx);
    // A teammate's machine: the same folded card, the ledger as 0.33.0 left it there.
    cpSync(join(r.backupDir!, '.tasks-sync.json'), join(ctx, 'state', '.tasks-sync.json'));
    fake.requests.length = 0;
    const report = await backend().sync('push');
    expect(report.errors).toEqual([]);
    expect(commentPosts()).toEqual([]);
    expect(fake.comments.get(id)).toHaveLength(3);

    const fresh = '### 2026-10-21 - Session Update\n- tiles ship at 1440';
    await backend().addChangelog('orbit-tiles', fresh);
    fake.requests.length = 0;
    expect((await backend().sync('push')).errors).toEqual([]);
    expect(commentPosts().map((q) => (q.body as { comment_text: string }).comment_text)).toEqual([fresh]);
    expect(fake.comments.get(id)).toHaveLength(4);
  });

  it('reads every page of a long history (ClickUp sends 25 comments a page) before deciding what is new', async () => {
    fake = makeFakeClickUp();
    clock = 1000;
    // Real ClickUp paging: newest first, 25 a page, `start`/`start_id` = the oldest comment of the page before.
    let pagesRead = 0;
    const paged = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const m = u.pathname.match(/\/task\/([^/]+)\/comment$/);
      if (!m || (init?.method ?? 'GET').toUpperCase() !== 'GET') return fake.fetchImpl(url, init);
      const all = [...(fake.comments.get(m[1]) ?? [])].reverse();
      const startId = u.searchParams.get('start_id');
      const from = startId ? all.findIndex((c) => c.id === startId) + 1 : 0;
      const comments = all.slice(from, from + 25);
      pagesRead++;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ comments }) } as unknown as Response;
    }) as typeof fetch;
    const pagedBackend = () => {
      const now = () => (clock += 7);
      const sleep = async () => { clock += 1; };
      const adapter = new ApiAdapter({ baseUrl: 'https://api.clickup.com/api/v2', authHeaders: () => ({ Authorization: 'pk_test' }), fetchImpl: paged, now, sleep });
      return new ClickUpTaskBackend(ctx, CONFIG, { adapter, now, sleep });
    };
    const cu = pagedBackend();
    await cu.create({ name: 'Orbit tiles', variant: 'cli' });
    for (let d = 1; d <= 30; d++) await cu.addChangelog('orbit-tiles', `### 2026-09-${String(d).padStart(2, '0')} - Session Update\n- tile pass ${d}`);
    await cu.sync('push');
    const id = JSON.parse(readFileSync(join(ctx, 'state', '.tasks-map.json'), 'utf-8'))[0].remoteId as string;
    expect(fake.comments.get(id)).toHaveLength(31);

    // Machine B: the base lost its Changelog (as 0.33.0 left it), the card still holds all 31.
    const syncPath = join(ctx, 'state', '.tasks-sync.json');
    const state = JSON.parse(readFileSync(syncPath, 'utf-8'));
    const e = state.tasks['orbit-tiles'];
    const base = e.base_snapshot.body.slice(0, e.base_snapshot.body.indexOf('## Changelog')).replace(/\s+$/, '\n');
    e.base_snapshot = { hash: hashContent(base), body: base };
    e.localHash = 'stale';
    writeFileSync(syncPath, JSON.stringify(state, null, 2));
    fake.requests.length = 0;
    pagesRead = 0;

    const report = await pagedBackend().sync('push');
    expect(report.errors).toEqual([]);
    expect(commentPosts()).toEqual([]);
    expect(fake.comments.get(id)).toHaveLength(31);
    expect(pagesRead).toBe(2);
  });

  it('queue/rank frontmatter never reaches the wire on an update push', async () => {
    await vaultAfter033();
    foldTaskJournals(ctx);
    addQueueRank('orbit-tiles');
    await backend().updateFields('orbit-tiles', { priority: 'high' });
    fake.requests.length = 0;

    const report = await backend().sync('push');
    expect(report.errors).toEqual([]);
    expect(report.pushed).toBe(1);
    expect(commentPosts()).toEqual([]);
    expect(wireMentions(fake.requests, /queue|rank/)).toEqual([]);
    expect(wireMentions(fake.requests, /Orbit tiles/).length).toBeGreaterThan(0); // the task itself did travel
  });
});
