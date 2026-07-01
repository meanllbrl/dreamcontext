import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';
import {
  extractImageRefs,
  isLocalImageRef,
  resolveLocalImagePath,
  rewriteImageRefs,
  assetRemotePath,
  assetRemoteUrl,
  ASSETS_BRANCH,
} from '../../src/lib/task-backend/github-assets.js';

/**
 * A LOCAL image embedded in a task body (an agent-drop screenshot) can't render
 * on GitHub — the backend uploads it to a dedicated assets branch and rewrites
 * the reference to the hosted URL on the wire, while the mirror keeps the
 * canonical local path. These tests pin (1) the pure codec and (2) the full
 * push→pull round-trip proving images resolve remotely and never churn the merge.
 */

// A minimal but valid-enough PNG: the 8-byte signature is all sniffImageType reads.
function pngBytes(tag = 'x'): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`payload-${tag}`),
  ]);
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('github-assets pure codec', () => {
  it('extracts inline image references', () => {
    const refs = extractImageRefs('text\n![a](/p/one.png)\nmore ![b](/p/two.png "t")\n');
    expect(refs.map((r) => r.dest)).toEqual(['/p/one.png', '/p/two.png']);
  });

  it('does not match a normal link or a fenced code image', () => {
    expect(extractImageRefs('[link](/x.png)')).toEqual([]);
    expect(extractImageRefs('![alt](<with space.png>)')[0].dest).toBe('with space.png');
  });

  it('classifies local vs remote destinations', () => {
    expect(isLocalImageRef('/Users/me/a.png')).toBe(true);
    expect(isLocalImageRef('./rel/a.png')).toBe(true);
    expect(isLocalImageRef('_dream_context/tmp/agent-drops/x.png')).toBe(true);
    expect(isLocalImageRef('https://x.com/a.png')).toBe(false);
    expect(isLocalImageRef('http://x.com/a.png')).toBe(false);
    expect(isLocalImageRef('data:image/png;base64,AAAA')).toBe(false);
    expect(isLocalImageRef('//cdn/a.png')).toBe(false);
    expect(isLocalImageRef('#anchor')).toBe(false);
  });

  it('rewrites only mapped destinations, preserving alt + title', () => {
    const body = '![shot](/p/a.png "cap")\n![keep](https://x/y.png)';
    const out = rewriteImageRefs(body, (d) => (d === '/p/a.png' ? 'https://host/a.png' : null));
    expect(out).toBe('![shot](https://host/a.png "cap")\n![keep](https://x/y.png)');
  });

  it('round-trips a destination with whitespace through <> wrapping', () => {
    const out = rewriteImageRefs('![s](/p/a.png)', () => '/has space/b.png');
    expect(out).toBe('![s](</has space/b.png>)');
    expect(extractImageRefs(out)[0].dest).toBe('/has space/b.png');
  });

  it('builds a content-addressed path and a camo-friendly hosted URL', () => {
    expect(assetRemotePath('deadbeef', 'image/png')).toBe('assets/deadbeef.png');
    expect(assetRemoteUrl('o', 'r', 'assets/deadbeef.png')).toBe(
      `https://github.com/o/r/raw/${ASSETS_BRANCH}/assets/deadbeef.png`,
    );
  });

  it('resolves a relative destination against a base dir', () => {
    const base = join(tmpdir(), `dc-res-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(base, { recursive: true });
    const dir = realpathSync(base);
    const file = join(dir, 'shot.png');
    writeFileSync(file, pngBytes());
    expect(resolveLocalImagePath('shot.png', [dir])).toBe(file);
    expect(resolveLocalImagePath(file, [])).toBe(file);
    expect(resolveLocalImagePath('missing.png', [dir])).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('contains resolution to an allow-listed root (blocks absolute escape + ../ traversal)', () => {
    const base = join(tmpdir(), `dc-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(base, { recursive: true });
    const root = realpathSync(base);
    const inside = join(root, 'sub');
    mkdirSync(inside, { recursive: true });
    const ok = join(inside, 'shot.png');
    writeFileSync(ok, pngBytes());
    // A real image outside the root (sibling temp file).
    const outside = join(tmpdir(), `dc-out-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    writeFileSync(outside, pngBytes());

    // In-root absolute + in-root relative both resolve.
    expect(resolveLocalImagePath(ok, [root], root)).toBe(realpathSync(ok));
    expect(resolveLocalImagePath('sub/shot.png', [root], root)).toBe(realpathSync(ok));
    // Absolute path outside the root is rejected.
    expect(resolveLocalImagePath(outside, [root], root)).toBeNull();
    // `../` traversal escaping the root is rejected even though the file exists.
    expect(resolveLocalImagePath(`../${basename(outside)}`, [inside], root)).toBeNull();
    // A null byte is rejected.
    expect(resolveLocalImagePath('sub/shot.png\0.png', [root], root)).toBeNull();

    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
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
  const raw = join(tmpdir(), `dc-gha-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

/** Drop a real image on disk under the vault's agent-drops dir; return its abs path. */
function dropImage(name: string, tag = 'x'): string {
  const dir = join(contextRoot, 'tmp', 'agent-drops');
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, name);
  writeFileSync(abs, pngBytes(tag));
  return abs;
}

/** Inject an image reference into a created task's body (above ## Changelog). */
function injectImage(slug: string, imgPath: string): void {
  const path = join(contextRoot, 'state', `${slug}.md`);
  const raw = readFileSync(path, 'utf-8');
  const injected = raw.includes('## Changelog')
    ? raw.replace('## Changelog', `![screenshot](${imgPath})\n\n## Changelog`)
    : `${raw}\n![screenshot](${imgPath})\n`;
  writeFileSync(path, injected);
}

describe('github image asset sync', () => {
  it('uploads a local image, creates the assets branch, and rewrites the issue body', async () => {
    const img = dropImage('123-shot.png');
    await backend.create({ name: 'Has Image', variant: 'cli' });
    injectImage('has-image', img);

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);

    // The dedicated branch was created off the default branch.
    expect(fake.branches.has(ASSETS_BRANCH)).toBe(true);
    // Exactly one asset committed, under assets/<sha>.png on that branch.
    const committed = [...fake.contents.keys()];
    expect(committed.length).toBe(1);
    expect(committed[0]).toMatch(new RegExp(`^${ASSETS_BRANCH} assets/[0-9a-f]{40}\\.png$`));

    // The issue body references the hosted URL, NOT the local path.
    const issue = [...fake.issues.values()][0];
    expect(issue.body).toContain(`https://github.com/meanllbrl/dreamcontext/raw/${ASSETS_BRANCH}/assets/`);
    expect(issue.body).not.toContain(img);

    // The local mirror keeps the canonical local path (wire-only transform).
    expect(mirror('has-image')).toContain(img);
  });

  it('is idempotent: re-pushing the same task does not re-upload', async () => {
    const img = dropImage('123-shot.png');
    await backend.create({ name: 'Has Image', variant: 'cli' });
    injectImage('has-image', img);
    await backend.sync('push');

    const putsAfterFirst = fake.requests.filter((r) => r.method === 'PUT' && r.path.includes('/contents/')).length;
    expect(putsAfterFirst).toBe(1);

    // A later edit to the same task re-pushes the body but reuses the cached asset.
    await backend.addChangelog('has-image', '### 2026-06-30 - Update\n- touched');
    await backend.sync('push');
    const putsTotal = fake.requests.filter((r) => r.method === 'PUT' && r.path.includes('/contents/')).length;
    expect(putsTotal).toBe(1); // no second upload
  });

  it('dedupes identical bytes referenced from two tasks into one upload', async () => {
    const imgA = dropImage('a.png', 'same');
    const imgB = dropImage('b.png', 'same'); // identical content, different path
    await backend.create({ name: 'Task A', variant: 'cli' });
    await backend.create({ name: 'Task B', variant: 'cli' });
    injectImage('task-a', imgA);
    injectImage('task-b', imgB);

    await backend.sync('push');
    const puts = fake.requests.filter((r) => r.method === 'PUT' && r.path.includes('/contents/')).length;
    expect(puts).toBe(1); // content-addressed → one commit for both
    expect(fake.contents.size).toBe(1);
  });

  it('survives a wiped asset bridge: re-commit hits 422 (already present) and is reused, not an error', async () => {
    const img = dropImage('123-shot.png');
    await backend.create({ name: 'Has Image', variant: 'cli' });
    injectImage('has-image', img);
    await backend.sync('push');
    expect(fake.contents.size).toBe(1);

    // Simulate losing the gitignored sync cache (e.g. a fresh checkout): drop the
    // asset bridge + branch-ready flag so the next push re-derives everything.
    const syncPath = join(contextRoot, 'state', '.tasks-sync.json');
    const state = JSON.parse(readFileSync(syncPath, 'utf-8'));
    delete state.assets;
    delete state.assetsBranchReady;
    // Force a re-push of the body too (clear the per-task localHash/base).
    for (const slug of Object.keys(state.tasks ?? {})) delete state.tasks[slug].localHash;
    writeFileSync(syncPath, JSON.stringify(state, null, 2));

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(fake.contents.size).toBe(1); // the content-addressed path is reused, not duplicated
    const issue = [...fake.issues.values()][0];
    expect(issue.body).toContain(`/raw/${ASSETS_BRANCH}/assets/`);
  });

  it('round-trips: pulling the pushed issue keeps the local path and raises no conflict', async () => {
    const img = dropImage('123-shot.png');
    await backend.create({ name: 'Has Image', variant: 'cli' });
    injectImage('has-image', img);
    await backend.sync('push');

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(report.conflicts).toEqual([]);
    // Mirror body still carries the local path (mapped back from the hosted URL).
    const body = mirror('has-image');
    expect(body).toContain(img);
    expect(body).not.toContain('githubusercontent');
    expect(body).not.toContain('/raw/' + ASSETS_BRANCH + '/');
  });

  it('a non-image file referenced as an image is left as-is with a warning (never uploaded)', async () => {
    const dir = join(contextRoot, 'tmp', 'agent-drops');
    mkdirSync(dir, { recursive: true });
    const notImg = join(dir, 'notes.png');
    writeFileSync(notImg, 'this is plain text, not a PNG');
    await backend.create({ name: 'Fake Image', variant: 'cli' });
    injectImage('fake-image', notImg);

    const report = await backend.sync('push');
    expect(fake.contents.size).toBe(0); // nothing uploaded
    const issue = [...fake.issues.values()][0];
    expect(issue.body).toContain(notImg); // reference untouched
    expect(report.warnings.some((w) => w.includes('did not resolve to a local image file'))).toBe(true);
  });

  it('refuses an absolute image path OUTSIDE the project root (no read, no upload)', async () => {
    // A real image living outside the vault/project — the shape a remotely-pulled
    // issue body could inject to read an arbitrary local file.
    const outside = join(tmpdir(), `dc-evil-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    writeFileSync(outside, pngBytes('secret'));
    await backend.create({ name: 'Evil Path', variant: 'cli' });
    injectImage('evil-path', outside);

    const report = await backend.sync('push');
    expect(fake.contents.size).toBe(0); // nothing read or committed
    expect(fake.branches.has(ASSETS_BRANCH)).toBe(false);
    const issue = [...fake.issues.values()][0];
    expect(issue.body).toContain(outside); // reference left as-is
    expect(report.warnings.some((w) => w.includes('did not resolve to a local image file'))).toBe(true);
    rmSync(outside, { force: true });
  });

  it('pull recovers a wiped asset+base cache without churn or a spurious conflict', async () => {
    const img = dropImage('123-shot.png');
    await backend.create({ name: 'Has Image', variant: 'cli' });
    injectImage('has-image', img);
    await backend.sync('push');

    // Simulate a fresh checkout: lose BOTH the asset bridge AND the base snapshot
    // (the gitignored sync cache), keeping only the committed task↔issue map.
    const syncPath = join(contextRoot, 'state', '.tasks-sync.json');
    const state = JSON.parse(readFileSync(syncPath, 'utf-8'));
    delete state.assets;
    delete state.assetsBranchReady;
    for (const slug of Object.keys(state.tasks ?? {})) {
      delete state.tasks[slug].base_snapshot;
      delete state.tasks[slug].localHash;
    }
    writeFileSync(syncPath, JSON.stringify(state, null, 2));

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(report.conflicts).toEqual([]); // bridge re-derived from local → no missing_base
    const body = mirror('has-image');
    expect(body).toContain(img); // canonical local path preserved
    expect(body).not.toContain(`/raw/${ASSETS_BRANCH}/`);
  });

  it('leaves an https image untouched and uploads nothing', async () => {
    await backend.create({ name: 'Remote Image', variant: 'cli' });
    injectImage('remote-image', 'https://example.com/pic.png');

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(fake.contents.size).toBe(0);
    expect(fake.branches.has(ASSETS_BRANCH)).toBe(false); // no branch created
    const issue = [...fake.issues.values()][0];
    expect(issue.body).toContain('https://example.com/pic.png');
  });
});
