/**
 * The funnel explorer SNAPSHOT fixture feeds `npm run verify:funnel-explorer`,
 * the explorer cases of `verify:lab-boards` and their screenshots, so it is
 * PUBLISHED: every name in it must be synthetic (the
 * synthetic-fixtures-for-published-artifacts pattern), it must be deterministic
 * so the UI-vs-CLI parity checks and the shots are stable, and it must pass the
 * same gate an agent's snapshot meets (`lab data check`) with nothing trimmed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFunnelSet } from '../../src/lib/lab/funnel.js';
import { checkLabSnapshot, MAX_LAB_DATA_BYTES } from '../../src/lib/lab/labData.js';
import { funnelSlice, hasAccess, knOf, orderedNotes, paymentView, stepDrops } from '../../src/lib/lab/frameOps.js';
import type { FunnelFrame } from '../../src/lib/lab/frameOps.js';
import { resolveFrame } from '../../src/lib/lab/frames.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import type { InsightCache } from '../../src/lib/lab/types.js';

const FIXTURE = join(__dirname, '../../scripts/verify/fixtures/acme-funnel-snapshot.mjs');
const SOURCE = readFileSync(FIXTURE, 'utf8');

interface Snapshot {
  source: Record<string, unknown> & { pulled_at: string };
  data: Record<string, unknown> & {
    kind: string;
    window: { from: string; to: string };
    funnels: {
      id: string;
      steps: { key: string; users: number; basis?: string; measured?: boolean; reason?: string }[];
      segments: { dims: Record<string, string>; users: number }[];
      notes?: { code?: string; level?: string }[];
      payment?: unknown;
      daily?: unknown[];
    }[];
    notes: { code?: string; level?: string }[];
    payment?: unknown;
    access?: unknown;
    hints: Record<string, string>;
  };
}

async function snap(variant: 'full' | 'bare'): Promise<Snapshot> {
  const mod = (await import(pathToFileURL(FIXTURE).href)) as { snapshot: (v: string) => Snapshot };
  return mod.snapshot(variant);
}

describe('acme funnel snapshot fixture: deterministic, and clean through the gate', () => {
  it('two calls return the same payload byte for byte', async () => {
    expect(JSON.stringify(await snap('full'))).toBe(JSON.stringify(await snap('full')));
    expect(JSON.stringify(await snap('bare'))).toBe(JSON.stringify(await snap('bare')));
  });

  it('full: parses as a funnel set with no notice (nothing capped, trimmed or dropped)', async () => {
    const { data } = await snap('full');
    const parsed = parseFunnelSet(data);
    expect(parsed.notices).toEqual([]);
    expect(parsed.set.funnels.map((f) => f.id)).toEqual(['quiz-v3', 'trial-start', 'gift-card']);
    // weekly is a band input only: consumed, never stored; the ladder leaves bands behind.
    expect((parsed.set as { weekly?: unknown }).weekly).toBeUndefined();
    expect(parsed.set.funnels.every((f) => (f as { weekly?: unknown }).weekly === undefined)).toBe(true);
    expect(parsed.set.benchmarks && Object.keys(parsed.set.benchmarks).length).toBeGreaterThan(0);
  });

  it('full and bare pass `lab data check` for a preset insight, under the byte caps', async () => {
    for (const v of ['full', 'bare'] as const) {
      const check = checkLabSnapshot(await snap(v), { requireFunnel: true });
      expect(check.problems, v).toEqual([]);
      expect(check.notices, v).toEqual([]);
      expect(check.ok, v).toBe(true);
      expect(check.kind, v).toBe('funnel-set/v1');
      expect(check.summary!.bytes).toBeLessThan(MAX_LAB_DATA_BYTES);
      expect(check.summary!.storedBytes!).toBeLessThan(400_000);
      expect(check.summary!.window).toEqual({ from: '2026-08-31', to: '2026-09-27' });
    }
  });

  it('full carries every explorer part; bare drops daily, payment and access and keeps the hints', async () => {
    const full = (await snap('full')).data;
    const bare = (await snap('bare')).data;
    expect(full.access).toBeDefined();
    expect(full.payment).toBeDefined();
    expect(full.funnels.filter((f) => f.payment).length).toBe(2);
    expect(full.funnels.filter((f) => (f.daily ?? []).length > 0).length).toBe(2);
    expect(bare.access).toBeUndefined();
    expect(bare.payment).toBeUndefined();
    expect(bare.funnels.every((f) => !f.payment && !f.daily)).toBe(true);
    expect(Object.keys(bare.hints).sort()).toEqual(['access', 'daily', 'intersections', 'payment', 'segments', 'weekly']);
  });
});

describe('acme funnel snapshot fixture: the honesty cases the explorer must show', () => {
  /** The parsed set as the board reads it: a cache in a scratch vault, resolved by the real frame builder. */
  async function frame(): Promise<FunnelFrame> {
    const root = mkdtempSync(join(tmpdir(), 'dc-acme-snapshot-'));
    try {
      createInsight(root, { slug: 'acme-funnel-snapshot', title: 'Acme funnel snapshot', preset: 'funnel-explorer' });
      const parsed = parseFunnelSet((await snap('full')).data);
      const cache: InsightCache = {
        slug: 'acme-funnel-snapshot', fetchedAt: '2026-09-28T09:00:00Z', tweaks: {}, granularity: 'daily', unit: null,
        series: [], latest: null, error: null, errorAt: null, scriptHash: null,
        funnel: { set: parsed.set, notices: parsed.notices, range: { fromISO: '2026-08-31', toISO: '2026-09-27' } },
      };
      writeCache(root, 'acme-funnel-snapshot', cache);
      const f = resolveFrame(root, 'acme-funnel-snapshot', ['funnel']);
      expect(f.kind).toBe('funnel');
      return f as FunnelFrame;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('derived steps are labelled and the trial funnel has an unmeasured lead step with its reason', async () => {
    const { data } = await snap('full');
    const quiz = data.funnels[0];
    expect(quiz.steps.filter((s) => s.basis === 'derived').map((s) => s.key)).toEqual(['page2', 'lead', 'finish']);
    const lead = data.funnels[1].steps.find((s) => s.key === 'lead')!;
    expect(lead.measured).toBe(false);
    expect(lead.reason).toMatch(/not recorded/);
  });

  it('a path under 100 users exists (gift-card x PT): its rates read as k/n', async () => {
    const f = await frame();
    const slice = funnelSlice(f, 'gift-card', { language: 'PT' });
    expect(slice.measured).toBe(true);
    expect(slice.users).toBeLessThan(100);
    expect(knOf(f, slice, 'page2_rate')).not.toBeNull();
  });

  it('the worst drop of the quiz funnel is a real step (the CLI and DOM parity anchor)', async () => {
    const { data } = await snap('full');
    const drops = stepDrops(data.funnels[0].steps);
    expect(drops.filter((d) => d.worst)).toHaveLength(1);
  });

  it('payment: a k/n cell (under 100 attempts), a clipped cell, and the set scope for the funnel without payment', async () => {
    const f = await frame();
    const quiz = paymentView(f, 'quiz-v3', {});
    const cells = quiz.byDim.flatMap((g) => g.rows);
    expect(cells.some((r) => r.kn !== null)).toBe(true);
    expect(cells.some((r) => r.clipped)).toBe(true);
    expect(quiz.cohorts.length).toBe(2);
    expect(paymentView(f, 'gift-card', {}).scope).toBe('set');
    expect(hasAccess(f)).toBe(true);
  });

  it('notes: every funnel trap is among the first 4 lines, in order funnel traps, set traps, info', async () => {
    const f = await frame();
    for (const id of ['quiz-v3', 'trial-start', 'gift-card']) {
      const lines = orderedNotes(f, id);
      const traps = lines.filter((n) => n.scope === 'funnel' && n.level === 'trap');
      expect(traps.length, id).toBeGreaterThan(0);
      expect(lines.slice(0, 4).filter((n) => n.scope === 'funnel' && n.level === 'trap').length, id).toBe(traps.length);
      const rank = (n: { scope: string; level: string }) => (n.level === 'trap' ? (n.scope === 'funnel' ? 0 : 1) : n.scope === 'funnel' ? 2 : 3);
      const ranks = lines.map(rank);
      expect(ranks, id).toEqual([...ranks].sort((a, b) => a - b));
    }
  });
});

describe('acme funnel snapshot fixture: only synthetic names', () => {
  it('names the fictional product', () => {
    expect(SOURCE).toContain('Acme Storefront');
  });

  /** Projects registered on THIS machine (outside the repo, so the test itself
   *  leaks nothing); self-skips where no registry exists. */
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

  it('carries no /Users/ path, no e-mail address and no em dash', () => {
    expect(SOURCE).not.toMatch(/\/Users\//);
    expect(SOURCE).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(SOURCE).not.toMatch(/—/);
  });
});
