import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';

import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { createObjective } from '../../src/lib/objectives-store.js';
import { buildRoadmapModel } from '../../src/lib/roadmap-model.js';
import { objectiveLiveness } from '../../src/lib/scoring-work.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * A scoring pass (suggestions on every task) followed by a sync on BOTH remote
 * backends posts no comment and changes no remote content: `priority_suggestion`
 * is local-only and never reaches the remote render. It also survives a pull.
 */

const BASE = { platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0', disableNativeMemory: true, cloudTaskManagement: true } as const;
const GH: SetupConfig = { ...BASE, taskBackend: 'github', github: { owner: 'o', repo: 'r', changelogTarget: 'comments' } } as SetupConfig;
const CU: SetupConfig = { ...BASE, taskBackend: 'clickup', clickup: { teamId: 't', spaceId: 's', listId: 'list1', changelogTarget: 'comments' } } as SetupConfig;

let projectRoot: string;
let contextRoot: string;
let clock: number;

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-prio-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  createObjective(contextRoot, { slug: 'mrr', title: 'MRR' });
  clock = 1000;
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function adapter(baseUrl: string, fetchImpl: typeof fetch): { adapter: ApiAdapter; now: () => number; sleep: () => Promise<void> } {
  const now = () => (clock += 7);
  const sleep = async () => { clock += 1; };
  return { adapter: new ApiAdapter({ baseUrl, authHeaders: () => ({ Authorization: 'x' }), fetchImpl, now, sleep }), now, sleep };
}

const live = () => objectiveLiveness(buildRoadmapModel(contextRoot));
const fm = (slug: string) => matter(readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8')).data as Record<string, any>;

function githubContent(fake: FakeGitHub): unknown {
  return [...fake.issues.values()].map((i) => ({
    title: i.title, body: i.body, state: i.state, labels: (i.labels ?? []).map((l: { name: string }) => l.name).sort(),
  }));
}
function clickupContent(fake: FakeClickUp): unknown {
  return [...fake.tasks.values()].map((t) => ({
    name: t.name, description: t.description, status: t.status, priority: t.priority,
    tags: t.tags.map((x) => x.name).sort(), start: t.start_date ?? null, due: t.due_date ?? null,
    fields: t.custom_fields.map((f) => [f.id, f.value]),
  }));
}
const commentCount = (m: Map<unknown, unknown[]>) => [...m.values()].reduce((n, l) => n + l.length, 0);

async function scoringPass(b: GitHubTaskBackend | ClickUpTaskBackend): Promise<void> {
  await b.suggestPriority('unscored-a', { reach: 6, impact: 3, confidence: 75, effort: 0.5, objective: 'mrr', why: 'Serves MRR.' }, live());
  await b.suggestPriority('unscored-b', { reach: 2, impact: 1, confidence: 50, effort: 2, no_objective: true, why: 'Nothing fits.' }, live());
}

describe('a scoring pass never reaches the remote', () => {
  it('GitHub: no comment, no content change; the suggestion survives a pull', async () => {
    const fake = makeFakeGitHub();
    const a = adapter('https://api.github.com', fake.fetchImpl);
    const b = new GitHubTaskBackend(contextRoot, GH, a);
    await b.create({ name: 'Unscored A', variant: 'cli' });
    await b.create({ name: 'Unscored B', variant: 'cli' });
    expect((await b.sync('push')).errors).toEqual([]);
    const content = JSON.stringify(githubContent(fake));
    const comments = commentCount(fake.comments as Map<unknown, unknown[]>);

    await scoringPass(b);
    const report = await b.sync('both');
    expect(report.errors).toEqual([]);
    expect(report.commentsAdded).toBe(0);
    expect(commentCount(fake.comments as Map<unknown, unknown[]>)).toBe(comments);
    expect(JSON.stringify(githubContent(fake))).toBe(content);
    expect(JSON.stringify(githubContent(fake))).not.toContain('priority_suggestion');

    // A remote edit pulled into the mirror keeps the local-only suggestion.
    const number = [...fake.issues.values()].find((i) => i.title === 'Unscored A')!.number;
    fake.editIssue(number, { title: 'Unscored A renamed' });
    expect((await b.sync('pull')).errors).toEqual([]);
    expect(fm('unscored-a').name).toBe('Unscored A renamed');
    expect(fm('unscored-a').priority_suggestion).toMatchObject({ objective: 'mrr', reach: 6, why: 'Serves MRR.' });
  });

  it('ClickUp: no comment, no content change; the suggestion survives a pull', async () => {
    const fake = makeFakeClickUp();
    const a = adapter('https://api.clickup.com/api/v2', fake.fetchImpl);
    const b = new ClickUpTaskBackend(contextRoot, CU, a);
    await b.create({ name: 'Unscored A', variant: 'cli' });
    await b.create({ name: 'Unscored B', variant: 'cli' });
    expect((await b.sync('push')).errors).toEqual([]);
    const content = JSON.stringify(clickupContent(fake));
    const comments = commentCount(fake.comments as Map<unknown, unknown[]>);

    await scoringPass(b);
    const report = await b.sync('both');
    expect(report.errors).toEqual([]);
    expect(report.commentsAdded).toBe(0);
    expect(commentCount(fake.comments as Map<unknown, unknown[]>)).toBe(comments);
    expect(JSON.stringify(clickupContent(fake))).toBe(content);

    const id = [...fake.tasks.values()].find((t) => t.name === 'Unscored B')!.id;
    fake.editTask(id, { name: 'Unscored B renamed' });
    expect((await b.sync('pull')).errors).toEqual([]);
    expect(fm('unscored-b').name).toBe('Unscored B renamed');
    expect(fm('unscored-b').priority_suggestion).toMatchObject({ no_objective: true, reach: 2 });
  });

  it('a refused accept on a remote backend queues nothing; a landed one queues one push', async () => {
    const fake = makeFakeClickUp();
    const b = new ClickUpTaskBackend(contextRoot, CU, adapter('https://api.clickup.com/api/v2', fake.fetchImpl));
    await b.create({ name: 'Unscored A', variant: 'cli' });
    await b.create({ name: 'Unscored B', variant: 'cli' });
    await b.sync('push');
    await scoringPass(b);
    await b.sync('push');
    const queue = () => JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8'));
    const pendingOf = () => queue().tasks['unscored-a']?.pendingPush ?? false;
    expect(pendingOf()).toBe(false);
    await expect(b.acceptSuggestion('unscored-a', 'stale', {}, live())).rejects.toMatchObject({ code: 'suggestion_changed' });
    expect(pendingOf()).toBe(false);
    const at = fm('unscored-a').priority_suggestion.at as string;
    const out = await b.acceptSuggestion('unscored-a', at, {}, live());
    expect(out.outcome).toBe('applied');
    expect(pendingOf()).toBe(true);
    expect(fm('unscored-a').rice).toMatchObject({ score: 27 });
    expect(fm('unscored-a').objectives).toEqual(['mrr']);
  });
});
