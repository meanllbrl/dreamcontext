import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';
import {
  renderDatesBlock,
  parseDatesBlock,
  stripDatesBlock,
  composeIssueBody,
} from '../../src/lib/task-backend/github-map.js';

/**
 * GitHub Issues have NO native date fields, so start/due are persisted INSIDE
 * the issue body as a marked block. These tests pin (1) the pure block codec and
 * (2) a full push→pull round-trip proving the dates reliably survive the remote.
 */

// ─── Pure block codec ────────────────────────────────────────────────────────

describe('github dates block codec', () => {
  it('renders nothing when neither date is set', () => {
    expect(renderDatesBlock(null, null)).toBe('');
    expect(renderDatesBlock(undefined, undefined)).toBe('');
  });

  it('renders start, due, or both', () => {
    expect(renderDatesBlock('2026-07-01', null)).toContain('**Start:** 2026-07-01');
    expect(renderDatesBlock(null, '2026-07-15')).toContain('**Due:** 2026-07-15');
    const both = renderDatesBlock('2026-07-01', '2026-07-15');
    expect(both).toContain('**Start:** 2026-07-01');
    expect(both).toContain('**Due:** 2026-07-15');
  });

  it('parse(render(x)) round-trips both dates', () => {
    const body = renderDatesBlock('2026-07-01', '2026-07-15');
    expect(parseDatesBlock(body)).toEqual({ start: '2026-07-01', due: '2026-07-15' });
  });

  it('parses dates embedded in a larger body and ignores prose dates', () => {
    const body = composeIssueBody('## Why\n\nShip by 2099-01-01 ideally.\n', '2026-07-01', '2026-07-15');
    expect(parseDatesBlock(body)).toEqual({ start: '2026-07-01', due: '2026-07-15' });
  });

  it('parses missing block as nulls', () => {
    expect(parseDatesBlock('## Why\n\nNo dates here.')).toEqual({ start: null, due: null });
    expect(parseDatesBlock('')).toEqual({ start: null, due: null });
  });

  it('strips the block and leaves clean prose', () => {
    const prose = '## Why\n\nDo the thing.\n';
    const composed = composeIssueBody(prose, '2026-07-01', '2026-07-15');
    expect(composed).toContain('dc:dates');
    expect(stripDatesBlock(composed).trim()).toBe(prose.trim());
  });

  it('composeIssueBody is idempotent (never stacks duplicate blocks)', () => {
    const once = composeIssueBody('## Why\n\nx\n', '2026-07-01', '2026-07-15');
    const twice = composeIssueBody(once, '2026-07-01', '2026-07-15');
    expect(twice).toBe(once);
    // exactly one OPEN marker (the close marker is `<!-- /dc:dates -->`)
    expect(twice.match(/<!-- dc:dates -->/g)?.length).toBe(1);
  });

  it('a task with no dates yields a date-free body (byte-stable)', () => {
    const prose = '## Why\n\nNothing scheduled.\n';
    expect(composeIssueBody(prose, null, null)).toBe(prose);
  });
});

// ─── Full push → pull round-trip through the fake remote ─────────────────────

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

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-ghd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeGitHub();
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function mirror(slug: string): string {
  return readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
}

describe('github date sync (encoded in the issue body)', () => {
  it('pushes start+due into the issue body and they survive the remote', async () => {
    await backend.create({ name: 'Dated GH', start_date: '2026-07-01', due_date: '2026-07-15', variant: 'cli' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    const issue = [...fake.issues.values()][0];
    expect(parseDatesBlock(issue.body)).toEqual({ start: '2026-07-01', due: '2026-07-15' });
  });

  it('a remote-created issue with a date block pulls dates into the mirror', async () => {
    const issue = fake.seedIssue({
      title: 'Remote Dated',
      body: composeIssueBody('## Why\n\nremote work\n', '2026-08-01', '2026-08-20'),
    });
    expect(issue.number).toBeGreaterThan(0);
    await backend.sync('pull');
    const slug = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'))[0].slug;
    const file = mirror(slug);
    expect(file).toContain("start_date: '2026-08-01'");
    expect(file).toContain("due_date: '2026-08-20'");
    // the date block must NOT leak into the local prose
    expect(file).not.toContain('dc:dates');
  });

  it('clearing a due date locally removes it from the remote body on push', async () => {
    await backend.create({ name: 'Clearable GH', due_date: '2026-07-15', variant: 'cli' });
    await backend.sync('push');
    const num = [...fake.issues.keys()][0];
    expect(parseDatesBlock(fake.issues.get(num)!.body).due).toBe('2026-07-15');

    await backend.updateFields('clearable-gh', { due_date: null, updated_at: '2026-06-11' });
    await backend.sync('push');
    expect(parseDatesBlock(fake.issues.get(num)!.body).due).toBeNull();
  });

  it('a date round-trip converges (follow-up sync is a no-op)', async () => {
    await backend.create({ name: 'Conv GH', start_date: '2026-07-01', due_date: '2026-07-09', variant: 'cli' });
    await backend.sync('both');
    fake.requests.length = 0;
    const again = await backend.sync('both');
    expect(again.pushed).toBe(0);
    expect(again.pulled).toBe(0);
  });
});
