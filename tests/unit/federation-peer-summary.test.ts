import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { addConnection } from '../../src/lib/connections.js';
import {
  buildPeerSummary,
  refreshPeerSummaries,
  readPeerSummaryCache,
  peerSummaryCachePath,
} from '../../src/lib/federation-peer-summary.js';

const BASE: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.8.0',
  disableNativeMemory: true,
};

function makeDir(prefix: string): string {
  const dir = join(tmpdir(), `dc-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface SeedOpts {
  shareable?: boolean;
  soul?: string;
  changelog?: Array<Record<string, unknown>>;
  task?: { name: string; status: string };
  knowledgeTags?: string[][];
  /** Titles to write as `pinned: true` knowledge docs under `knowledge/`. */
  pinnedKnowledge?: string[];
  /** Titles to write as `pinned: true` feature docs under `knowledge/features/`
   *  (migrated location — exercises the recursive scan). */
  pinnedFeatures?: string[];
}

/** Turn a doc title into a filesystem-safe slug. */
function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'doc';
}

/** Create a vault on disk, register it, and seed peer content. */
function makeVault(base: string, name: string, home: string, opts: SeedOpts = {}): string {
  const projectRoot = join(base, name);
  const ctx = join(projectRoot, '_dream_context');
  mkdirSync(join(ctx, 'knowledge'), { recursive: true });
  mkdirSync(join(ctx, 'core', 'features'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeSetupConfig(projectRoot, { ...BASE, shareable: opts.shareable ?? true });
  addVault(name, projectRoot, home);

  if (opts.soul !== undefined) {
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      `---\nname: "${name}"\ntype: soul\n---\n\n## Project Identity\n\n${opts.soul}\n`,
      'utf-8',
    );
  }
  if (opts.changelog) {
    writeFileSync(join(ctx, 'core', 'CHANGELOG.json'), JSON.stringify(opts.changelog, null, 2), 'utf-8');
  }
  if (opts.task) {
    writeFileSync(
      join(ctx, 'state', `${opts.task.name}.md`),
      `---\nname: ${opts.task.name}\nstatus: ${opts.task.status}\nupdated_at: '2026-06-14'\n---\n\nbody\n`,
      'utf-8',
    );
  }
  for (const tags of opts.knowledgeTags ?? []) {
    const slug = tags.join('-') || 'doc';
    writeFileSync(
      join(ctx, 'knowledge', `${slug}.md`),
      `---\nname: ${slug}\ntype: knowledge\ntags: [${tags.join(', ')}]\n---\n\nbody\n`,
      'utf-8',
    );
  }
  for (const title of opts.pinnedKnowledge ?? []) {
    writeFileSync(
      join(ctx, 'knowledge', `${slugify(title)}.md`),
      `---\nname: "${title}"\ntype: knowledge\npinned: true\n---\n\nbody\n`,
      'utf-8',
    );
  }
  if (opts.pinnedFeatures?.length) {
    mkdirSync(join(ctx, 'knowledge', 'features'), { recursive: true });
    for (const title of opts.pinnedFeatures) {
      writeFileSync(
        join(ctx, 'knowledge', 'features', `${slugify(title)}.md`),
        `---\nname: "${title}"\ntype: feature\npinned: true\n---\n\nbody\n`,
        'utf-8',
      );
    }
  }
  return projectRoot;
}

describe('buildPeerSummary', () => {
  let home: string;
  let base: string;

  beforeEach(() => {
    home = makeDir('ps-home');
    base = makeDir('ps-base');
    process.env.HOME = home;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('produces a compact summary from a seeded peer', () => {
    const root = makeVault(base, 'apollo', home, {
      soul: 'Apollo is a rocket-telemetry dashboard for launch operators.',
      changelog: [
        { date: '2026-06-14', type: 'feat', scope: 'ui', summary: 'Added live burn-rate chart' },
        { date: '2026-06-13', type: 'fix', scope: 'api', summary: 'Fixed stale token refresh' },
        { date: '2026-06-10', type: 'chore', scope: 'ci', summary: 'should not appear (3rd)' },
      ],
      task: { name: 'live-telemetry', status: 'in_progress' },
      knowledgeTags: [['telemetry', 'backend'], ['telemetry', 'ui'], ['auth']],
    });

    const summary = buildPeerSummary(join(root, '_dream_context'), 'apollo');

    expect(summary.vault).toBe('apollo');
    expect(summary.whatItIs).toContain('rocket-telemetry');
    // Latest 1-2 changelog headlines only — never the 3rd.
    expect(summary.lastActivity).toHaveLength(2);
    expect(summary.lastActivity[0]).toContain('2026-06-14');
    expect(summary.lastActivity[0]).toContain('burn-rate');
    expect(summary.lastActivity.join(' ')).not.toContain('3rd');
    expect(summary.activeTask).toBe('live-telemetry');
    // top tags: telemetry appears most → ranked first.
    expect(summary.topTags[0]).toBe('telemetry');
    expect(summary.topTags).toContain('backend');
    // Compact: a handful of tags, not a dump.
    expect(summary.topTags.length).toBeLessThanOrEqual(5);
  });

  it('surfaces pinned knowledge + feature titles (both locations), excludes un-pinned, sorts + caps at 5', () => {
    const root = makeVault(base, 'orion', home, {
      // Un-pinned knowledge — must NOT appear in pinnedKnowledge.
      knowledgeTags: [['telemetry', 'backend'], ['auth']],
      // Six pinned knowledge docs — cap should drop one; sort is alphabetical.
      pinnedKnowledge: ['Zeta Doc', 'Alpha Model', 'Mu Spec', 'Kappa Policy', 'Delta Guide', 'Omega Overview'],
      // Pinned feature under knowledge/features/ — proves recursion + "both".
      pinnedFeatures: ['Beta Feature PRD'],
    });

    const summary = buildPeerSummary(join(root, '_dream_context'), 'orion');

    // Both a pinned knowledge doc and a pinned feature are surfaced.
    expect(summary.pinnedKnowledge).toContain('Beta Feature PRD');
    expect(summary.pinnedKnowledge).toContain('Alpha Model');
    // Un-pinned docs never leak in.
    expect(summary.pinnedKnowledge).not.toContain('telemetry-backend');
    expect(summary.pinnedKnowledge).not.toContain('auth');
    // Capped at 5 (7 pinned docs seeded).
    expect(summary.pinnedKnowledge).toHaveLength(5);
    // Alphabetically sorted for a stable glance.
    expect(summary.pinnedKnowledge).toEqual([...summary.pinnedKnowledge].sort((a, b) => a.localeCompare(b)));
    expect(summary.pinnedKnowledge[0]).toBe('Alpha Model');
  });

  it('never throws on an empty / missing peer (returns blank fields)', () => {
    const root = makeVault(base, 'empty', home, {});
    const summary = buildPeerSummary(join(root, '_dream_context'), 'empty');
    expect(summary.vault).toBe('empty');
    expect(summary.whatItIs).toBe('');
    expect(summary.lastActivity).toEqual([]);
    expect(summary.activeTask).toBe('');
    expect(summary.topTags).toEqual([]);
    expect(summary.pinnedKnowledge).toEqual([]);
  });
});

describe('refreshPeerSummaries', () => {
  let home: string;
  let base: string;

  beforeEach(() => {
    home = makeDir('rps-home');
    base = makeDir('rps-base');
    process.env.HOME = home;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('includes a readable peer (out/both + shareable) and writes the cache', () => {
    const cur = makeVault(base, 'cur', home, {});
    makeVault(base, 'readable', home, { shareable: true, soul: 'Readable peer purpose line.' });
    const curCtx = join(cur, '_dream_context');
    addConnection(curCtx, 'cur', 'readable', 'both', null, home);

    const peers = refreshPeerSummaries(curCtx, home);

    expect(peers.map((p) => p.vault)).toEqual(['readable']);
    // Cache file written with the documented shape.
    const cachePath = peerSummaryCachePath(curCtx);
    expect(existsSync(cachePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(typeof parsed.generatedAt).toBe('string');
    expect(parsed.peers).toHaveLength(1);
    expect(parsed.peers[0].vault).toBe('readable');
    expect(parsed.peers[0].whatItIs).toContain('Readable peer');
  });

  it('excludes non-shareable peers', () => {
    const cur = makeVault(base, 'cur', home, {});
    makeVault(base, 'private', home, { shareable: false, soul: 'Private peer.' });
    const curCtx = join(cur, '_dream_context');
    addConnection(curCtx, 'cur', 'private', 'both', null, home);

    const peers = refreshPeerSummaries(curCtx, home);
    expect(peers).toEqual([]);
  });

  it('excludes in-only connections (no out/both reach across)', () => {
    const cur = makeVault(base, 'cur', home, {});
    makeVault(base, 'inbound', home, { shareable: true, soul: 'Inbound peer.' });
    const curCtx = join(cur, '_dream_context');
    addConnection(curCtx, 'cur', 'inbound', 'in', null, home);

    const peers = refreshPeerSummaries(curCtx, home);
    expect(peers).toEqual([]);
  });

  it('excludes stale connections', () => {
    const cur = makeVault(base, 'cur', home, {});
    makeVault(base, 'gone', home, { shareable: true, soul: 'Gone peer.' });
    const curCtx = join(cur, '_dream_context');
    addConnection(curCtx, 'cur', 'gone', 'both', null, home);
    // Hand-mark the connection stale.
    const connPath = join(curCtx, 'state', '.connections.json');
    const file = JSON.parse(readFileSync(connPath, 'utf-8'));
    file.connections[0].status = 'stale';
    writeFileSync(connPath, JSON.stringify(file, null, 2) + '\n', 'utf-8');

    const peers = refreshPeerSummaries(curCtx, home);
    expect(peers).toEqual([]);
  });

  it('never includes the current vault as a peer', () => {
    const cur = makeVault(base, 'cur', home, { shareable: true });
    makeVault(base, 'other', home, { shareable: true });
    const curCtx = join(cur, '_dream_context');
    addConnection(curCtx, 'cur', 'other', 'both', null, home);

    const peers = refreshPeerSummaries(curCtx, home);
    expect(peers.map((p) => p.vault)).not.toContain('cur');
  });
});

describe('readPeerSummaryCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeDir('readcache');
    mkdirSync(join(dir, 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the cache is absent', () => {
    expect(readPeerSummaryCache(dir)).toBeNull();
  });

  it('returns null on corrupt JSON (never throws)', () => {
    writeFileSync(peerSummaryCachePath(dir), '{ not valid json', 'utf-8');
    expect(readPeerSummaryCache(dir)).toBeNull();
  });

  it('reads a well-formed cache', () => {
    writeFileSync(
      peerSummaryCachePath(dir),
      JSON.stringify({
        generatedAt: '2026-06-15T00:00:00Z',
        peers: [{ vault: 'p', whatItIs: 'x', lastActivity: ['a'], activeTask: 't', topTags: ['tag'], pinnedKnowledge: ['Canonical Doc'] }],
      }),
      'utf-8',
    );
    const cache = readPeerSummaryCache(dir);
    expect(cache).not.toBeNull();
    expect(cache!.peers[0].vault).toBe('p');
    expect(cache!.peers[0].topTags).toEqual(['tag']);
    expect(cache!.peers[0].pinnedKnowledge).toEqual(['Canonical Doc']);
  });

  it('defaults pinnedKnowledge to [] for a legacy cache entry missing the field', () => {
    writeFileSync(
      peerSummaryCachePath(dir),
      JSON.stringify({
        generatedAt: '2026-06-15T00:00:00Z',
        peers: [{ vault: 'old', whatItIs: 'x', lastActivity: [], activeTask: '', topTags: [] }],
      }),
      'utf-8',
    );
    const cache = readPeerSummaryCache(dir);
    expect(cache!.peers[0].pinnedKnowledge).toEqual([]);
  });
});
