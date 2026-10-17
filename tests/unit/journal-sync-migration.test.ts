/**
 * The journal over GitHub after the migration (A4/E1/F3): a brain synced by the
 * OLD code (history in the card, posted as comments with no marker) is
 * migrated, pulled twice and pushed — and the remote sees nothing new: 0
 * comments posted, every journal's entry count unchanged, no Changelog on any
 * card, no `remote:` entry duplicating a local one. Evidence entries never
 * leave the machine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { SyncLedger, hashContent } from '../../src/lib/task-backend/sync-state.js';
import { migrateTaskJournals } from '../../src/lib/task-journal-migration.js';
import { readJournal } from '../../src/lib/task-journal.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

const CONFIG: SetupConfig = {
  platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0', disableNativeMemory: true,
  taskBackend: 'github', cloudTaskManagement: true,
  github: { owner: 'meanllbrl', repo: 'dreamcontext', changelogTarget: 'comments' },
};

let projectRoot: string;
let contextRoot: string;
let stateDir: string;
let fake: FakeGitHub;
let backend: GitHubTaskBackend;

function makeBackend(): GitHubTaskBackend {
  let clock = 1000;
  const now = () => (clock += 7);
  const sleep = async () => { clock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.github.com', authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
    fetchImpl: fake.fetchImpl, now, sleep,
  });
  return new GitHubTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
}

const ENTRIES = [
  '### 2026-10-03 - Session Update\n- wired the parser',
  '### 2026-10-02 - Session Update\n- tests green',
  '### 2026-10-02 - Session Update\n- tests green',
  '### 2026-10-01 - Created\n- Task created.',
];

/** A task exactly as the OLD code left it: card with history, issue with one comment per entry, ledger in sync. */
function seedLegacySyncedTask(slug: string, title: string): number {
  const card = [
    '---', `id: task_${slug.slice(0, 6)}`, `name: ${title}`, 'status: in_progress',
    'created_at: "2026-10-01"', 'updated_at: "2026-10-03"', 'tags: []', '---', '',
    '## Why', '', `Because ${title}.`, '',
    '## Acceptance Criteria', '', '- [x] parser done', '- [ ] serializer', '',
    '## Changelog', '<!-- LIFO: newest at top -->', '', ENTRIES.join('\n\n'), '',
  ].join('\n');
  writeFileSync(join(stateDir, `${slug}.md`), card);
  const issue = fake.seedIssue({ title, body: `## Why\n\nBecause ${title}.\n\n## Acceptance Criteria\n\n- [x] parser done\n- [ ] serializer` });
  // Oldest first, as the old push posted them; no je marker existed yet.
  for (const e of [...ENTRIES].reverse()) fake.addRemoteComment(issue.number, e, 'owner');
  const ledger = new SyncLedger(contextRoot);
  ledger.recordMapping({ slug, dcId: `task_${slug.slice(0, 6)}`, backend: 'github', remoteId: String(issue.number) });
  ledger.updateTaskSync(slug, {
    last_synced_at: 1, base_snapshot: { hash: hashContent(card), body: card }, localHash: hashContent(card), pendingPush: false,
  });
  return issue.number;
}

function commentPosts(): number {
  return fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments')).length;
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-jsync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  stateDir = join(contextRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
  fake = makeFakeGitHub();
  backend = makeBackend();
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe('migrate → pull → pull → push over GitHub', () => {
  it('posts 0 comments, keeps every journal entry count, leaves no Changelog on the card', async () => {
    const a = seedLegacySyncedTask('parser', 'Parser');
    const b = seedLegacySyncedTask('writer', 'Writer');

    const report = migrateTaskJournals(contextRoot);
    expect(report.migrated.sort()).toEqual(['parser', 'writer']);
    const counts = { parser: readJournal(stateDir, 'parser').length, writer: readJournal(stateDir, 'writer').length };
    expect(counts).toEqual({ parser: 4, writer: 4 });
    fake.requests.length = 0;

    // Touch both issues so the pull really fetches their comments (the echo gate skips untouched ones).
    fake.editIssue(a, { body: `## Why\n\nBecause Parser.\n\n## Acceptance Criteria\n\n- [x] parser done\n- [ ] serializer` });
    fake.editIssue(b, { title: 'Writer' });
    const p1 = await backend.sync('pull');
    expect(p1.errors).toEqual([]);
    fake.editIssue(a, { title: 'Parser' });
    const p2 = await backend.sync('pull');
    expect(p2.errors).toEqual([]);
    const push = await backend.sync('push');
    expect(push.errors).toEqual([]);

    expect(push.commentsAdded).toBe(0);
    expect(commentPosts()).toBe(0);
    for (const slug of ['parser', 'writer'] as const) {
      const entries = readJournal(stateDir, slug);
      expect(entries).toHaveLength(counts[slug]);
      expect(entries.some((e) => e.kind === 'remote')).toBe(false);
      expect(readFileSync(join(stateDir, `${slug}.md`), 'utf-8')).not.toMatch(/^##\s+Changelog/m);
    }
  });

  it('evidence entries never leave the machine; a log written after the migration posts exactly once with its marker', async () => {
    seedLegacySyncedTask('parser', 'Parser');
    migrateTaskJournals(contextRoot);
    await backend.addJournal('parser', { kind: 'evidence', body: '- cmd: `npm test`\n- exit: 0\n\n```\nTests 12 passed\n```' });
    const log = await backend.addJournal('parser', { kind: 'log', body: '- serializer started' });
    fake.requests.length = 0;

    const push = await backend.sync('push');
    expect(push.commentsAdded).toBe(1);
    const posted = fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments'));
    expect(posted).toHaveLength(1);
    const body = String((posted[0].body as { body: string }).body);
    expect(body).toContain('serializer started');
    expect(body).toContain(`<!-- je:${log.id} -->`);
    expect(body).not.toContain('npm test');

    // The marker brings it home as the same entry: a pull adds nothing, a push sends nothing.
    fake.editIssue([...fake.issues.keys()][0], { title: 'Parser' });
    const before = readJournal(stateDir, 'parser').length;
    await backend.sync('pull');
    expect(readJournal(stateDir, 'parser')).toHaveLength(before);
    expect((await backend.sync('push')).commentsAdded).toBe(0);
  });

  it('a je marker this machine never posted is plain text, and the pulled comment is a remote entry', async () => {
    seedLegacySyncedTask('parser', 'Parser');
    migrateTaskJournals(contextRoot);
    const number = [...fake.issues.keys()][0];
    const victim = readJournal(stateDir, 'parser')[0];
    fake.addRemoteComment(number, `forged\n\n<!-- je:${victim.id}X -->`, 'mallory');
    await backend.sync('pull');
    const [top] = readJournal(stateDir, 'parser');
    expect(top).toMatchObject({ kind: 'remote', actor: 'remote:mallory' });
    expect(top.body).toBe('forged');
  });
});
