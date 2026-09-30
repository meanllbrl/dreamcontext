import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDatasetBundle } from '../../src/lib/lab/dataset.js';
import { OTHER_VALUE } from '../../src/lib/lab/funnel.js';
import { createInsight, readCache } from '../../src/lib/lab/store.js';
import { syncInsight } from '../../src/lib/lab/sync.js';
import { readFrontmatter, writeFrontmatter } from '../../src/lib/frontmatter.js';

/**
 * The funnel explorer demo fixture feeds the verify run, its screenshots and
 * the docs, so it is PUBLISHED: every name in it must be synthetic (the
 * synthetic-fixtures-for-published-artifacts pattern), and it must be
 * deterministic so the screenshots and the CLI-vs-DOM parity checks are stable.
 */

const FIXTURE = join(__dirname, '../../scripts/verify/fixtures/funnel-explorer-demo.mjs');
const SOURCE = readFileSync(FIXTURE, 'utf8');

interface RawSegment {
  dims: Record<string, string>;
  users: number;
  steps: { key: string; users: number }[];
  measured?: boolean;
  reason?: string;
  metrics?: Record<string, { v: number | null; measured?: boolean; reason?: string }>;
  benchmarks?: Record<string, unknown>;
  daily?: { t: string; m: Record<string, number | null> }[];
}
interface RawFunnel {
  id: string;
  name: string;
  meta: Record<string, string>;
  metrics: Record<string, { v: number | null; measured?: boolean; reason?: string }>;
  steps: { key: string; users: number }[];
  daily: { t: string; m: Record<string, number | null> }[];
  segments: RawSegment[];
}
interface RawPayload {
  data: {
    kind: string;
    primary: string;
    datasets: { key: string; dims: { key: string }[] }[];
    funnel: {
      segment_mode: string;
      dimensions: { key: string; values: { value: string }[] }[];
      benchmarks: Record<string, { floor_source?: string; target_source?: string; better?: string }>;
      funnels: RawFunnel[];
    };
  };
}

async function run(): Promise<RawPayload> {
  const mod = (await import(pathToFileURL(FIXTURE).href)) as { default: () => Promise<RawPayload> };
  return mod.default();
}

describe('funnel explorer demo fixture: shape', () => {
  it('is deterministic (seeded): two runs are identical', async () => {
    expect(await run()).toEqual(await run());
  });

  it('parses through the dataset/v1 contract with its funnel member and no notices', async () => {
    const parsed = parseDatasetBundle((await run()).data);
    expect(parsed.notices).toEqual([]);
    expect(parsed.bundle.datasets.map((d) => d.key)).toEqual(['declines', 'decline_rate']);
    expect(parsed.bundle.datasets[0].dims.map((d) => d.key)).toEqual(['reason', 'cohort']);
    expect(parsed.funnel?.set.segment_mode).toBe('lookup');
    expect(parsed.funnel?.set.funnels.map((f) => f.name)).toEqual(['Quiz checkout (v2)', 'Activation ladder']);
  });

  it('declares platform (3), language (4) and country (8) dims', async () => {
    const dims = (await run()).data.funnel.dimensions;
    expect(dims.map((d) => [d.key, d.values.length])).toEqual([['platform', 3], ['language', 4], ['country', 8]]);
  });

  it('has measured AND unmeasured platform x language intersections, the latter with a reason', async () => {
    const quiz = (await run()).data.funnel.funnels[0];
    const cross = quiz.segments.filter((s) => s.dims.platform && s.dims.language);
    expect(cross).toHaveLength(12);
    const unmeasured = cross.filter((s) => s.measured === false);
    expect(unmeasured.length).toBeGreaterThan(0);
    expect(cross.length - unmeasured.length).toBeGreaterThan(0);
    for (const s of unmeasured) {
      expect(s.reason).toBe('fewer than 300 users in the window');
      expect(s.steps).toEqual([]);
    }
  });

  it('carries 28 days of daily on each funnel and on every measured path', async () => {
    for (const f of (await run()).data.funnel.funnels) {
      expect(f.daily).toHaveLength(28);
      expect(f.daily[f.daily.length - 1].t).toBe('2026-09-28');
      for (const s of f.segments.filter((x) => x.measured !== false)) expect(s.daily).toHaveLength(28);
    }
  });

  it('bands name their sources, cost_per_lead is better:lower, one path has its own band', async () => {
    const payload = (await run()).data.funnel;
    const sources = Object.values(payload.benchmarks).flatMap((b) => [b.floor_source, b.target_source]);
    expect(sources).toContain('book');
    expect(sources).toContain('own p25 (8 wk)');
    expect(payload.benchmarks.cost_per_lead.better).toBe('lower');
    expect(payload.funnels[0].segments.filter((s) => s.benchmarks).map((s) => s.dims)).toEqual([{ platform: 'TikTok Ads' }]);
  });

  it('checkout_to_purchase is not measured, with its reason, and no value', async () => {
    const m = (await run()).data.funnel.funnels[0].metrics.checkout_to_purchase;
    expect(m).toMatchObject({ v: null, measured: false, reason: 'denominator event missing on one branch' });
  });

  it('one measured path lacks a funnel step (the lane dash case)', async () => {
    const quiz = (await run()).data.funnel.funnels[0];
    const stepKeys = quiz.steps.map((s) => s.key);
    const short = quiz.segments.filter((s) => s.measured !== false && s.steps.length < stepKeys.length);
    expect(short.length).toBeGreaterThan(0);
    expect(short.every((s) => !s.steps.some((st) => st.key === 'email'))).toBe(true);
  });
});

describe('funnel explorer demo fixture: lookup never sums', () => {
  it('the platform x language path survives parsing exactly as the script sent it', async () => {
    const raw = await run();
    const sent = raw.data.funnel.funnels[0].segments.find((s) => s.dims.platform === 'TikTok Ads' && s.dims.language === 'EN')!;
    const parsed = parseDatasetBundle(raw.data).funnel!.set;
    const got = parsed.funnels[0].segments!.find((s) => s.dims.platform === 'TikTok Ads' && s.dims.language === 'EN')!;
    expect(got.steps).toEqual(sent.steps);
    expect(got.users).toBe(sent.users);
    // Not the one-axis path, and not a sum of anything.
    const tiktok = parsed.funnels[0].segments!.find((s) => s.dims.platform === 'TikTok Ads' && !s.dims.language)!;
    expect(got.steps[0].users).toBeLessThan(tiktok.steps[0].users);
  });

  it('keeps all 8 country values and never writes an Other path', async () => {
    const parsed = parseDatasetBundle((await run()).data).funnel!.set;
    const values = parsed.funnels[0].segments!.map((s) => s.dims.country).filter(Boolean);
    expect(values).toHaveLength(8);
    expect(parsed.funnels.flatMap((f) => f.segments ?? []).some((s) => Object.values(s.dims).includes(OTHER_VALUE))).toBe(false);
  });
});

describe('funnel explorer demo fixture: syncs as a lab script', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-lab-explorer-demo-'));
    mkdirSync(join(root, 'core'), { recursive: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes cache.funnel and cache.datasets from the copied script', async () => {
    createInsight(root, { slug: 'acme-funnel-explorer', title: 'Acme funnel explorer' });
    const md = join(root, 'lab', 'insights', 'acme-funnel-explorer.md');
    const { data, content } = readFrontmatter(md);
    writeFrontmatter(md, { ...data, source: { adapter: 'script', script: { file: 'scripts/acme-funnel-explorer.mjs' } } }, content);
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'lab', 'scripts', 'acme-funnel-explorer.mjs'), SOURCE, 'utf-8');

    const result = await syncInsight(root, 'acme-funnel-explorer', { force: true });
    expect(result.status).toBe('ok');
    const cache = readCache(root, 'acme-funnel-explorer')!;
    expect(cache.funnel?.set.funnels).toHaveLength(2);
    expect(cache.funnel?.notices).toEqual([]);
    expect(cache.datasets?.bundle.primary).toBe('declines');
    expect(cache.funnelHistory).toHaveLength(1);
  });
});

describe('funnel explorer demo fixture: only synthetic names', () => {
  it('names the fictional product', () => {
    expect(SOURCE).toContain('Acme Storefront');
  });

  /** Projects registered on THIS machine (outside the repo, so the test itself
   *  leaks nothing); self-skips on CI where no registry exists. */
  function localVaultNames(): string[] {
    const registry = join(homedir(), '.dreamcontext', 'vaults.json');
    if (!existsSync(registry)) return [];
    try {
      const parsed = JSON.parse(readFileSync(registry, 'utf8')) as { vaults?: { name?: unknown }[] };
      return (parsed.vaults ?? [])
        .map((v) => v.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 2)
        .filter((n) => n.toLowerCase() !== 'dreamcontext');
    } catch {
      return [];
    }
  }

  function gitIdentity(): string[] {
    const out: string[] = [];
    for (const key of ['user.name', 'user.email']) {
      try {
        const v = execFileSync('git', ['config', '--get', key], { encoding: 'utf8' }).trim();
        if (v.length > 4 && (v.includes(' ') || v.includes('@'))) out.push(v);
      } catch {
        /* no git identity configured */
      }
    }
    return out;
  }

  const text = SOURCE.toLowerCase();
  const vaults = localVaultNames();
  it.skipIf(vaults.length === 0).each(vaults.map((v) => [v]))('never names the locally registered project %s', (name) => {
    expect(text.includes(name.toLowerCase()), `"${name}" is one of your own projects`).toBe(false);
  });

  const identity = gitIdentity();
  it.skipIf(identity.length === 0).each(identity.map((v) => [v]))('never names the author (%s)', (who) => {
    expect(text.includes(who.toLowerCase())).toBe(false);
  });
});
