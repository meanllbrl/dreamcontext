import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';

import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';
import {
  statusToGitHub,
  statusFromGitHub,
  subStatusLabel,
  statusFromLabels,
  unknownDcLabels,
  labelsToGitHub,
  DELETED_SENTINEL,
} from '../../src/lib/task-backend/github-map.js';
import { recommendedLabels } from '../../src/lib/task-backend/github-fields.js';
import { DEFAULT_STATUSES, type StatusDef } from '../../src/lib/task-status.js';

/**
 * Declared statuses over the GitHub wire (task_adYgpCxk, plan v3).
 *
 * THE LOAD-BEARING RULE: `not_planned` is EXCLUSIVELY the soft-delete signal
 * and its code path is untouched. A cancelled-kind status closes the issue as
 * `completed` and is told apart by its `dc:<key>` label. Everything below is
 * either that rule, the "we did not break delete" proof, or the schema-drift
 * guarantees (non-destructive, self-correcting, named in the SyncReport).
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

const OVERRIDE = [
  '---',
  'statuses:',
  '  - { name: Planned, key: planned, kind: open, order: 5, color: c5def5 }',
  '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99, color: cfd3d7 }',
  '---',
  '',
].join('\n');

const DECLARED: StatusDef[] = [
  ...DEFAULT_STATUSES,
  { key: 'planned', label: 'Planned', kind: 'open', order: 5, color: 'c5def5' },
  { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99, color: 'cfd3d7' },
];

let projectRoot: string;
let contextRoot: string;
let fake: FakeGitHub;
let localClock: number;

function makeBackend(): GitHubTaskBackend {
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  return new GitHubTaskBackend(contextRoot, CONFIG, { adapter, fetchImpl: fake.fetchImpl, now, sleep });
}

function declareStatuses(): void {
  mkdirSync(join(contextRoot, 'overrides'), { recursive: true });
  writeFileSync(join(contextRoot, 'overrides', 'task.md'), OVERRIDE, 'utf-8');
}

function labelNames(issue: { labels: Array<{ name: string }> }): string[] {
  return issue.labels.map((l) => l.name).sort();
}

function localStatus(slug: string): string {
  return String(matter(readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8')).data.status);
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-ghst-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeGitHub();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('pure wire mapping (github-map) with a declared set', () => {
  it('cancelled pushes as closed + completed (NEVER not_planned) with a dc:cancelled label', () => {
    expect(statusToGitHub('cancelled', { statuses: DECLARED })).toEqual({ state: 'closed', state_reason: 'completed' });
    expect(subStatusLabel('cancelled', DECLARED)).toBe('dc:cancelled');
    expect(labelsToGitHub({ status: 'cancelled' })).toEqual(['dc:cancelled']);
  });

  it('a declared open-kind status pushes open + dc:<key>', () => {
    expect(statusToGitHub('planned', { statuses: DECLARED })).toEqual({ state: 'open' });
    expect(statusToGitHub('planned', { statuses: DECLARED, reopen: true })).toEqual({ state: 'open', state_reason: 'reopened' });
    expect(subStatusLabel('planned', DECLARED)).toBe('dc:planned');
  });

  it('an UNKNOWN key OMITS state/state_reason entirely — even with reopen requested', () => {
    expect(statusToGitHub('cancelled')).toEqual({});
    expect(statusToGitHub('on_hold', { reopen: true })).toEqual({});
    expect(statusToGitHub('on_hold', { statuses: DECLARED })).toEqual({});
  });

  it('subStatusLabel is STRING-DERIVED: emits dc:<key> for a key absent from the loaded set (anti-strip)', () => {
    expect(subStatusLabel('cancelled')).toBe('dc:cancelled');
    expect(subStatusLabel('planned')).toBe('dc:planned');
    expect(subStatusLabel('on_hold', DECLARED)).toBe('dc:on-hold');
    expect(subStatusLabel('todo', DECLARED)).toBeNull();
    expect(subStatusLabel('completed', DECLARED)).toBeNull();
    expect(labelsToGitHub({ status: 'cancelled', tags: ['keep'] })).toEqual(['keep', 'dc:cancelled']);
  });

  it('pull: closed+completed+dc:cancelled → cancelled with the set; → completed WITHOUT it (schema drift, no delete)', () => {
    const issue = { state: 'closed' as const, state_reason: 'completed' as const, labels: [{ name: 'dc:cancelled' }] };
    expect(statusFromGitHub(issue, DECLARED)).toBe('cancelled');
    expect(statusFromGitHub(issue)).toBe('completed');
    expect(statusFromGitHub(issue)).not.toBe(DELETED_SENTINEL);
    expect(unknownDcLabels(issue.labels)).toEqual(['dc:cancelled']);
    expect(unknownDcLabels(issue.labels, DECLARED)).toEqual([]);
  });

  it('pull: closed+not_planned is the delete sentinel WITH and WITHOUT a stale dc:* label, with and without the set', () => {
    for (const labels of [[], [{ name: 'dc:in-progress' }], [{ name: 'dc:cancelled' }]]) {
      for (const set of [undefined, DECLARED]) {
        expect(statusFromGitHub({ state: 'closed', state_reason: 'not_planned', labels }, set)).toBe(DELETED_SENTINEL);
      }
    }
  });

  it('pull: an OPEN issue ignores a stale terminal label (reopened on github.com) and reads the live one', () => {
    expect(statusFromLabels(['dc:cancelled'], DECLARED)).toBe('todo');
    expect(statusFromLabels(['dc:planned'], DECLARED)).toBe('planned');
    expect(statusFromLabels(['dc:planned'])).toBe('todo'); // unknown to the shipped set → todo, never a guess
    expect(statusFromGitHub({ state: 'open', state_reason: null, labels: [{ name: 'dc:planned' }] }, DECLARED)).toBe('planned');
  });

  it('recommendedLabels provisions dc:<key> for every declared status in its declared colour; shipped set unchanged', () => {
    const shipped = recommendedLabels().map((l) => l.name);
    expect(shipped.filter((n) => n.startsWith('dc:'))).toEqual(['dc:in-progress', 'dc:in-review']);
    const declared = recommendedLabels(DECLARED);
    expect(declared.find((l) => l.name === 'dc:planned')).toMatchObject({ color: 'c5def5' });
    expect(declared.find((l) => l.name === 'dc:cancelled')).toMatchObject({ color: 'cfd3d7' });
    expect(declared.some((l) => l.name === 'dc:todo' || l.name === 'dc:completed')).toBe(false);
  });
});

describe('backend round-trip with a declared cancelled status (mocked transport)', () => {
  it('todo → in_progress → cancelled → reopened → completed → cancelled, every hop honest on the wire', async () => {
    declareStatuses();
    const backend = makeBackend();
    await backend.create({ name: 'Round Trip', variant: 'cli' });
    await backend.sync('push');
    const number = [...fake.issues.keys()][0];
    const issue = () => fake.issues.get(number)!;
    expect(issue().state).toBe('open');

    await backend.updateFields('round-trip', { status: 'in_progress', updated_at: '2026-09-01' });
    await backend.sync('push');
    expect(labelNames(issue())).toContain('dc:in-progress');

    // → cancelled: closed as COMPLETED (never not_planned) + dc:cancelled.
    fake.requests.length = 0;
    await backend.updateFields('round-trip', { status: 'cancelled', updated_at: '2026-09-02' });
    let report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(issue().state).toBe('closed');
    expect(issue().state_reason).toBe('completed');
    expect(labelNames(issue())).toContain('dc:cancelled');
    expect(labelNames(issue())).not.toContain('dc:in-progress');
    expect(fake.requests.some((r) => JSON.stringify(r.body ?? {}).includes('not_planned'))).toBe(false);

    // → reopened from cancelled: state open + state_reason reopened (github.ts wasClosed by kind).
    fake.requests.length = 0;
    await backend.updateFields('round-trip', { status: 'in_progress', updated_at: '2026-09-03' });
    report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(issue().state).toBe('open');
    expect(issue().state_reason).toBe('reopened');
    const reopenPatch = fake.requests.find((r) => r.method === 'PATCH');
    expect(reopenPatch?.body).toMatchObject({ state: 'open', state_reason: 'reopened' });

    // → completed: closed, no dc:* label.
    await backend.updateFields('round-trip', { status: 'completed', updated_at: '2026-09-04' });
    await backend.sync('push');
    expect(issue().state).toBe('closed');
    expect(labelNames(issue()).some((l) => l.startsWith('dc:'))).toBe(false);

    // → back to cancelled, then PULL it on a fresh backend: the mirror reads cancelled.
    await backend.updateFields('round-trip', { status: 'cancelled', updated_at: '2026-09-05' });
    await backend.sync('push');
    expect(issue().state_reason).toBe('completed');
    expect(labelNames(issue())).toContain('dc:cancelled');

    // Simulate a remote touch so the delta pull re-reads it, then pull.
    fake.editIssue(number, { body: '## Why\n\nremote nudge\n' });
    report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(report.mirrorDeleted).toBe(0);
    expect(existsSync(join(contextRoot, 'state', 'round-trip.md'))).toBe(true);
    expect(localStatus('round-trip')).toBe('cancelled');
  });

  it('the declared dc:cancelled label is provisioned in its colour BEFORE the closing PATCH, bypassing the hourly throttle', async () => {
    const backend = makeBackend();
    await backend.create({ name: 'Late Declare', variant: 'cli' });
    await backend.sync('push'); // provisions the shipped labels; throttle window opens
    expect(fake.labels.has('dc:cancelled')).toBe(false);

    // The status is declared AFTER that provision pass (a fresh backend reads it).
    declareStatuses();
    const backend2 = makeBackend();
    fake.requests.length = 0;
    await backend2.updateFields('late-declare', { status: 'cancelled', updated_at: '2026-09-02' });
    const report = await backend2.sync('push');
    expect(report.errors).toEqual([]);

    const label = fake.labels.get('dc:cancelled');
    expect(label).toBeDefined();
    expect(label!.color).toBe('cfd3d7');
    const labelPost = fake.requests.findIndex((r) => r.method === 'POST' && r.path.endsWith('/labels') && (r.body as { name: string }).name === 'dc:cancelled');
    const closePatch = fake.requests.findIndex((r) => r.method === 'PATCH' && (r.body as { state?: string }).state === 'closed');
    expect(labelPost).toBeGreaterThanOrEqual(0);
    expect(closePatch).toBeGreaterThan(labelPost);
  });

  it('DID-NOT-BREAK-DELETE: a closed+not_planned issue still deletes the mirror, with and without a stale dc:* label, with and without the override', async () => {
    for (const withOverride of [false, true]) {
      for (const staleLabel of [null, 'dc:in-progress', 'dc:cancelled']) {
        rmSync(contextRoot, { recursive: true, force: true });
        mkdirSync(join(contextRoot, 'state'), { recursive: true });
        fake = makeFakeGitHub();
        if (withOverride) declareStatuses();
        const backend = makeBackend();
        await backend.create({ name: 'Gone', variant: 'cli' });
        await backend.sync('push');
        const number = [...fake.issues.keys()][0];
        fake.editIssue(number, {
          state: 'closed',
          state_reason: 'not_planned',
          ...(staleLabel ? { labels: [{ name: staleLabel }] } : {}),
        });
        const report = await backend.sync('pull');
        expect(report.errors, `override=${withOverride} label=${staleLabel}`).toEqual([]);
        expect(report.mirrorDeleted, `override=${withOverride} label=${staleLabel}`).toBe(1);
        expect(existsSync(join(contextRoot, 'state', 'gone.md'))).toBe(false);
      }
    }
  });

  it('`tasks delete` still soft-closes as not_planned and touches no label (path unchanged)', async () => {
    declareStatuses();
    const backend = makeBackend();
    await backend.create({ name: 'Bye', tags: ['keep'], variant: 'cli' });
    await backend.sync('push');
    const number = [...fake.issues.keys()][0];
    await backend.delete('bye');
    fake.requests.length = 0;
    const report = await backend.sync('push');
    expect(report.deleted).toBe(1);
    const issue = fake.issues.get(number)!;
    expect(issue.state_reason).toBe('not_planned');
    const patch = fake.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body).toEqual({ state: 'closed', state_reason: 'not_planned' });
    expect(labelNames(issue)).toContain('keep');
  });

  it('SCHEMA DRIFT is non-destructive: a machine WITHOUT the override records completed, never deletes, and warns', async () => {
    // Machine A (override) cancels and pushes.
    declareStatuses();
    const a = makeBackend();
    await a.create({ name: 'Drift', variant: 'cli' });
    await a.sync('push');
    const number = [...fake.issues.keys()][0];
    await a.updateFields('drift', { status: 'cancelled', updated_at: '2026-09-02' });
    await a.sync('push');
    expect(labelNames(fake.issues.get(number)!)).toContain('dc:cancelled');

    // Machine B: same remote, NO override, fresh brain.
    const rawB = join(tmpdir(), `dc-ghst-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(rawB, '_dream_context', 'state'), { recursive: true });
    const rootB = realpathSync(rawB);
    const now = () => (localClock += 7);
    const sleep = async () => { localClock += 1; };
    const adapterB = new ApiAdapter({ baseUrl: 'https://api.github.com', authHeaders: () => ({ Authorization: 'Bearer ghp_test' }), fetchImpl: fake.fetchImpl, now, sleep });
    const b = new GitHubTaskBackend(join(rootB, '_dream_context'), CONFIG, { adapter: adapterB, fetchImpl: fake.fetchImpl, now, sleep });
    try {
      const report = await b.sync('pull');
      expect(report.errors).toEqual([]);
      expect(report.mirrorDeleted).toBe(0);
      const mirror = join(rootB, '_dream_context', 'state', 'drift.md');
      expect(existsSync(mirror)).toBe(true);
      expect(String(matter(readFileSync(mirror, 'utf-8')).data.status)).toBe('completed');
      expect(report.warnings.some((w) => w.includes('dc:cancelled') && w.includes('does not declare'))).toBe(true);

      // Self-correction: B pulls the override; the next pull that re-reads the issue records cancelled.
      mkdirSync(join(rootB, '_dream_context', 'overrides'), { recursive: true });
      writeFileSync(join(rootB, '_dream_context', 'overrides', 'task.md'), OVERRIDE, 'utf-8');
      const b2 = new GitHubTaskBackend(join(rootB, '_dream_context'), CONFIG, { adapter: adapterB, fetchImpl: fake.fetchImpl, now, sleep });
      fake.editIssue(number, { body: '## Why\n\nnudge\n' });
      const report2 = await b2.sync('pull');
      expect(report2.errors).toEqual([]);
      expect(String(matter(readFileSync(mirror, 'utf-8')).data.status)).toBe('cancelled');
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it('a task whose file carries a status this machine does not know never reopens the closed issue and keeps the label', async () => {
    // Machine A cancels (override), machine B (no override) shares the brain via git.
    declareStatuses();
    const a = makeBackend();
    await a.create({ name: 'Keep Closed', variant: 'cli' });
    await a.sync('push');
    const number = [...fake.issues.keys()][0];
    await a.updateFields('keep-closed', { status: 'cancelled', updated_at: '2026-09-02' });
    await a.sync('push');
    expect(fake.issues.get(number)!.state).toBe('closed');

    // B: same files (git), override removed, edits the title → pushes.
    rmSync(join(contextRoot, 'overrides'), { recursive: true, force: true });
    const b = makeBackend();
    fake.requests.length = 0;
    await b.updateFields('keep-closed', { name: 'Keep Closed (renamed)', updated_at: '2026-09-03' });
    const report = await b.sync('push');
    expect(report.errors).toEqual([]);
    const issue = fake.issues.get(number)!;
    expect(issue.state).toBe('closed');
    expect(labelNames(issue)).toContain('dc:cancelled');
    const patch = fake.requests.find((r) => r.method === 'PATCH')!;
    expect((patch.body as Record<string, unknown>).state).toBeUndefined();
    expect((patch.body as Record<string, unknown>).state_reason).toBeUndefined();
  });
});
