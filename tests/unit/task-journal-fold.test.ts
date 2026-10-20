import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { convertJournalHeading, canonicalEntry } from '../../src/lib/task-backend/legacy-journal.js';
import { foldJournalIntoCard, foldTaskJournals } from '../../src/lib/task-journal-fold.js';
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
    const out = foldJournalIntoCard(misfiled, LEGACY_JOURNAL, { rescueSince: '2026-10-19' });
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
    const before = buildCorpus(ctx, { types: ['task'] });
    expect(before.some((d) => d.relPath.startsWith('state/journal/'))).toBe(true);
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

  it('a vault that never had journals gets no ledger entry and no ledger file', () => {
    expect(runMigrations(ctx, '0.31.0', '0.32.0').applied).toEqual([]);
    expect(existsSync(join(ctx, 'state', '.migrations.json'))).toBe(false);
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

  it('control: the same fold WITHOUT the seeded ledger would post the whole history again', async () => {
    await vaultAfter033();
    const r = foldTaskJournals(ctx);
    cpSync(join(r.backupDir!, '.tasks-sync.json'), syncFile()); // the ledger as 0.33.0 left it
    fake.requests.length = 0;

    const report = await backend().sync('push');
    expect(commentPosts().length).toBe(3);
    expect(report.commentsAdded).toBe(3);
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

  it('posts no comment for the folded history, and the control without the seeded ledger would', async () => {
    const id = await vaultAfter033();
    const r = foldTaskJournals(ctx);
    expect(r.ledgerSeeded).toBe(1);
    fake.requests.length = 0;
    const report = await backend().sync('push');
    expect(report.errors).toEqual([]);
    expect(commentPosts()).toEqual([]);
    expect(fake.comments.get(id)).toHaveLength(3);

    cpSync(join(r.backupDir!, '.tasks-sync.json'), join(ctx, 'state', '.tasks-sync.json'));
    fake.requests.length = 0;
    await backend().sync('push');
    expect(commentPosts().length).toBe(3);
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
