import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub, type FakeIssue } from './github-fake.js';

/**
 * GitHub PULL (A4 / A5 / A7): closed+completed → completed; closed+not_planned
 * → mirror removed; open → status from dc:* label; changelog comment
 * union-merge with no dup; assignees → person tags; PRs filtered out;
 * page-number pagination drains multiple pages. Mocked HTTP transport.
 */

const CONFIG: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.0.0',
  disableNativeMemory: true,
  taskBackend: 'github',
  cloudTaskManagement: true,
  github: { owner: 'meanllbrl', repo: 'dreamcontext', changelogTarget: 'comments' },
};

let projectRoot: string;
let contextRoot: string;
let fake: FakeGitHub;
let backend: GitHubTaskBackend;
let localClock: number;

function makeBackend(): GitHubTaskBackend {
  localClock = 1000;
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  return new GitHubTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
}

function mirror(slug: string): string {
  return readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-ghpl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  fake = makeFakeGitHub();
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('github PULL + merge (A4/A5/A7, mocked transport)', () => {
  it('PULL is a delta sync by `since` (server time); a clean re-run pulls nothing', async () => {
    fake.seedIssue({ title: 'Remote One', body: '## Why\n\nfirst\n' });
    fake.seedIssue({ title: 'Remote Two', body: '## Why\n\nsecond\n' });

    const first = await backend.sync('pull');
    expect(first.errors).toEqual([]);
    expect(first.pulled).toBe(2);
    expect(existsSync(join(contextRoot, 'state', 'remote-one.md'))).toBe(true);

    const second = await backend.sync('pull');
    expect(second.pulled).toBe(0);
  });

  it('open issue → status from the dc:* label (default todo)', async () => {
    fake.seedIssue({ title: 'In Prog', labels: [{ name: 'dc:in-progress' }] });
    fake.seedIssue({ title: 'Just Todo' });

    await backend.sync('pull');
    expect(mirror('in-prog')).toContain('status: in_progress');
    expect(mirror('just-todo')).toContain('status: todo');
  });

  it('closed + completed → status completed', async () => {
    fake.seedIssue({ title: 'Done', state: 'closed', state_reason: 'completed' });
    await backend.sync('pull');
    expect(mirror('done')).toContain('status: completed');
  });

  it('A4: closed + not_planned → the local mirror is REMOVED (soft-delete symmetry)', async () => {
    // First mirror it (open), then close it as not_planned remotely.
    const issue = fake.seedIssue({ title: 'Cancelled' });
    await backend.sync('pull');
    expect(existsSync(join(contextRoot, 'state', 'cancelled.md'))).toBe(true);

    fake.editIssue(issue.number, { state: 'closed', state_reason: 'not_planned' });
    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(report.mirrorDeleted).toBe(1);
    expect(existsSync(join(contextRoot, 'state', 'cancelled.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'))).toEqual([]);
  });

  it('priority / urgency / version / tags labels decode back into frontmatter', async () => {
    fake.seedIssue({
      title: 'Rich',
      labels: [
        { name: 'priority:critical' },
        { name: 'urgency:high' },
        { name: 'version:v2' },
        { name: 'mytag' },
      ],
    });
    await backend.sync('pull');
    const m = mirror('rich');
    expect(m).toContain('priority: critical');
    expect(m).toContain('urgency: high');
    expect(m).toContain('version: v2');
    expect(m).toContain('mytag');
    // dc:/priority:/urgency:/version: are NOT leaked as user tags.
    expect(m).not.toContain('- priority:critical');
  });

  it('changelog comments union-merge into the mirror with no duplication on re-pull', async () => {
    const issue = fake.seedIssue({ title: 'Talky', body: '## Why\n\nx\n' });
    fake.addRemoteComment(issue.number, '### 2026-06-21 - Note\n- alpha');
    fake.addRemoteComment(issue.number, '### 2026-06-21 - Note\n- beta');

    await backend.sync('pull');
    let m = mirror('talky');
    expect(m).toContain('alpha');
    expect(m).toContain('beta');
    expect(occurrences(m, '- alpha')).toBe(1);

    // Re-pull after a remote touch: the same comments must not duplicate.
    fake.editIssue(issue.number, { body: '## Why\n\nx edited\n' });
    await backend.sync('pull');
    m = mirror('talky');
    expect(occurrences(m, '- alpha')).toBe(1);
    expect(occurrences(m, '- beta')).toBe(1);
  });

  it('A7: issue assignees map back to person:<slug> tags', async () => {
    fake.seedIssue({ title: 'Assigned', assignees: [{ login: 'alice' }] });
    await backend.sync('pull');
    expect(mirror('assigned')).toContain('person:alice');
  });

  it('A7: an unknown / non-collaborator assignee login is handled gracefully (no crash)', async () => {
    fake.seedIssue({ title: 'Weird Owner', assignees: [{ login: 'ghost-user' }] });
    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    // ghost-user is not a collaborator → folds to its own slug, still a person tag.
    expect(mirror('weird-owner')).toContain('person:ghost-user');
  });

  it('GOTCHA: pull-request items are filtered out (only real issues are mirrored)', async () => {
    fake.seedIssue({ title: 'Real Issue', body: '## Why\n\nreal\n' });
    fake.seedIssue({ title: 'A Pull Request', pull_request: { url: 'https://api.github.com/pr/1' } });

    const report = await backend.sync('pull');
    expect(report.pulled).toBe(1);
    expect(existsSync(join(contextRoot, 'state', 'real-issue.md'))).toBe(true);
    expect(existsSync(join(contextRoot, 'state', 'a-pull-request.md'))).toBe(false);
  });

  it('page-number pagination drains MULTIPLE pages (per_page=100 sliced by the fake)', async () => {
    // 150 issues → 2 pages of the 100-per-page query.
    for (let i = 0; i < 150; i++) fake.seedIssue({ title: `Bulk ${i}` });
    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(report.pulled).toBe(150);

    // The backend must have requested at least page 1 and page 2 of the list.
    const listPages = fake.requests
      .filter((r) => r.path === '/repos/meanllbrl/dreamcontext/issues' && r.method === 'GET')
      .map((r) => r.query.page);
    expect(listPages).toContain('1');
    expect(listPages).toContain('2');
  });
});
