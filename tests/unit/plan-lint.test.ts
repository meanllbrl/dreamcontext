import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { lintWaveMap } from '../../src/lib/plan-lint.js';
import { planLink, planOpen, planPacket } from '../../src/cli/commands/plan.js';
import { planFilePath } from '../../src/lib/plan-store.js';
import { makePlanVault, makeReadyTask, writePlan, type PlanVault } from '../helpers/plan-vault.js';

const plan = (map: string, contracts = '- c'): string =>
  ['# P', '', '## Contracts', contracts, '', '## Wave map', map, '', '## Build notes', '- none'].join('\n');

describe('lintWaveMap', () => {
  it('is silent for a clean one-lane-per-file map, and for a plan with no wave map', () => {
    expect(lintWaveMap('# P\n\n## Decisions\n- x\n')).toEqual([]);
    const map = [
      '| Wave | After | Lanes and files |',
      '|---|---|---|',
      '| **W1 Core** | none | **L1 lib:** `src/lib/a.ts`, `src/lib/b.ts`. **L2 cli:** `src/cli/c.ts` |',
      '| **W2 Docs** | W1 | **L1 docs:** `src/lib/a.ts`, `README.md` |',
    ].join('\n');
    expect(lintWaveMap(plan(map, '- `src/lib/a.ts` holds it'))).toEqual([]);
  });

  it('names a file claimed by two lanes of one wave (also by path suffix), not across waves', () => {
    const map = [
      '| **W1 Core** | none | **L1 rust:** `desktop/src-tauri/src/lib.rs` **L2 ci:** `src-tauri/src/lib.rs`, `x.sh` |',
      '| **W2 Next** | W1 | **L1 a:** `x.sh` |',
    ].join('\n');
    const out = lintWaveMap(plan(map));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^W1: `desktop\/src-tauri\/src\/lib\.rs` is in lane L1 and lane L2/);
  });

  it('names a file the Contracts or criteria cite that no lane owns, ignoring tmp/assets paths and versions', () => {
    const map = '| **W1** | none | **L1 a:** `src/lib/a.ts` |';
    const out = lintWaveMap(plan(map, '- `src/lib/a.ts` ok, `src/lib/orphan.ts` and `tmp/plans/x.md` and `0.41.17` too'));
    expect(out).toEqual(['`src/lib/orphan.ts` is named in Contracts or criteria but no lane of the wave map owns it.']);
  });

  it('reads a bullet wave map with no lane markers as one lane per wave', () => {
    expect(lintWaveMap(plan('EXECUTION: lead\n- W1 `src/lib/a.ts`\n- W2 `src/lib/a.ts`'))).toEqual([]);
  });

  it('caps the output', () => {
    const files = Array.from({ length: 12 }, (_, i) => `\`src/f${i}.ts\``);
    const map = `| **W1** | none | **L1 a:** ${files.join(' ')} **L2 b:** ${files.join(' ')} |`;
    const out = lintWaveMap(plan(map));
    expect(out).toHaveLength(9);
    expect(out[8]).toBe('(+4 more)');
  });
});

describe('plan packet and link', () => {
  let v: PlanVault;
  beforeEach(() => { v = makePlanVault(); });
  afterEach(() => v.cleanup());

  it('packet returns the lint, writes it into the packet, and stays silent on a clean plan', async () => {
    const slug = await makeReadyTask(v, 'Lint task');
    await planOpen(v.deps, 'lp', { task: slug, goal: 'Ship it', lenses: 'critic,edge-cases' });
    writePlan(v, 'lp', 1);
    const clean = await planPacket(v.deps, 'lp', 'critic');
    expect(clean.lint).toEqual([]);
    expect(clean.text).not.toMatch(/Wave map lint/);
  });

  it('a lane clash shows in the packet text and the returned lint', async () => {
    const slug = await makeReadyTask(v, 'Lint task 2');
    await planOpen(v.deps, 'lq', { task: slug, goal: 'Ship it', lenses: 'critic,edge-cases' });
    writePlan(v, 'lq', 1);
    writeFileSync(planFilePath(v.root, 'lq'), plan('| **W1** | none | **L1 a:** `src/a.ts` **L2 b:** `src/a.ts` |'));
    const r = await planPacket(v.deps, 'lq', 'critic');
    expect(r.lint).toHaveLength(1);
    expect(r.text).toMatch(/## Wave map lint[\s\S]*- W1: `src\/a\.ts` is in lane L1 and lane L2/);
  });

  it('a refused link tells the Super the bypass is an owner card', async () => {
    const slug = await makeReadyTask(v, 'Lint task 3');
    await planOpen(v.deps, 'lr', { task: slug, goal: 'Ship it', lenses: 'critic,edge-cases' });
    writePlan(v, 'lr', 1);
    await planPacket(v.deps, 'lr', 'critic');
    await expect(planLink(v.deps, 'lr')).rejects.toThrow(/owner's call, never the Super's: ask him as an owner card/);
  });
});
