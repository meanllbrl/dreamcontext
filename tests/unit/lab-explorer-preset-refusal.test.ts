import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli/program.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { getBoard } from '../../src/lib/lab/boards.js';
import type { InsightCache } from '../../src/lib/lab/types.js';

/**
 * `lab board add-card --preset funnel-explorer` refuses with the message that
 * fits: no cache = "sync <slug> first"; synced but no funnel set = "<slug> has
 * no funnel data" (syncing again would not help).
 */

let projectRoot: string;
let root: string;
let cwd: string;

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const push = (...a: unknown[]): void => { lines.push(a.map(String).join(' ')); };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(push),
    vi.spyOn(console, 'error').mockImplementation(push),
    vi.spyOn(console, 'warn').mockImplementation(push),
  ];
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  // eslint-disable-next-line no-control-regex
  return { code, out: lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '') };
}

beforeEach(() => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lab-preset-refusal-')));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  process.chdir(projectRoot);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('lab board add-card --preset funnel-explorer refusals', () => {
  it('a synced insight without a funnel set says it has no funnel data, not "sync first"', async () => {
    createInsight(root, { slug: 'acme-signups', title: 'Acme signups', category: 'Growth' });
    writeCache(root, 'acme-signups', {
      slug: 'acme-signups', fetchedAt: '2026-09-28T00:00:00Z', tweaks: {}, granularity: 'daily', unit: 'users',
      series: [{ name: 'signups', points: [{ t: '2026-09-27', v: 4 }, { t: '2026-09-28', v: 6 }] }],
      latest: 6, error: null, errorAt: null, scriptHash: null,
    } as InsightCache);
    await run(['lab', 'board', 'create', 'ops', '--title', 'Ops']);
    const { code, out } = await run(['lab', 'board', 'add-card', 'ops', '--preset', 'funnel-explorer', '--insight', 'acme-signups']);
    expect(code).toBe(1);
    expect(out).toContain('acme-signups has no funnel data: the preset needs a funnel-set (funnel member)');
    expect(out).not.toContain('sync acme-signups first');
    expect(getBoard(root, 'ops')!.cards).toHaveLength(0);
  });

  it('an insight with no cache still says "sync <slug> first"', async () => {
    createInsight(root, { slug: 'acme-unsynced', title: 'Acme unsynced', category: 'Growth' });
    await run(['lab', 'board', 'create', 'ops', '--title', 'Ops']);
    const { code, out } = await run(['lab', 'board', 'add-card', 'ops', '--preset', 'funnel-explorer', '--insight', 'acme-unsynced']);
    expect(code).toBe(1);
    expect(out).toContain('sync acme-unsynced first');
    expect(out).not.toContain('has no funnel data');
  });
});
