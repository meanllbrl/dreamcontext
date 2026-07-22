import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import matter from 'gray-matter';

import { planDedup, applyDedup, type DedupPlan } from '../../src/lib/task-backend/dedup.js';
import { SyncLedger, type TaskMapEntry } from '../../src/lib/task-backend/sync-state.js';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';

/**
 * Scope D (#204) — `dreamcontext tasks dedup`: heals `-2/-3/-4` duplicate
 * mirror families created by a lost `.tasks-map.json` mapping, and repairs
 * dcId↔remoteId cross-wiring (D7). LOCAL ONLY — asserted directly below (no
 * remote-backend module is ever imported by dedup.ts).
 */

let projectRoot: string;
let contextRoot: string;
let stateDir: string;

function mapPath(): string {
  return join(contextRoot, 'state', '.tasks-map.json');
}

function readMapRaw(): TaskMapEntry[] {
  return JSON.parse(readFileSync(mapPath(), 'utf-8'));
}

function writeMap(entries: TaskMapEntry[]): void {
  writeFileSync(mapPath(), JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

function entry(overrides: Partial<TaskMapEntry>): TaskMapEntry {
  return { slug: 'foo', dcId: 'task_D1', backend: 'clickup', remoteId: 'R1', ...overrides };
}

function writeTask(
  slug: string,
  opts: { id: string; name: string; updatedAt: string; changelog?: string[]; marker?: string },
): void {
  const fm: Record<string, unknown> = {
    id: opts.id,
    name: opts.name,
    description: opts.name,
    priority: 'medium',
    urgency: 'medium',
    status: 'todo',
    created_at: '2026-01-01',
    updated_at: opts.updatedAt,
    tags: [],
    parent_task: null,
    related_feature: null,
    version: null,
    rice: null,
    start_date: null,
    due_date: null,
  };
  const changelogSection = opts.changelog && opts.changelog.length > 0
    ? `\n\n## Changelog\n<!-- LIFO: newest at top -->\n\n${opts.changelog.join('\n\n')}\n`
    : '';
  const body = `Body marker: ${opts.marker ?? opts.id}.${changelogSection}`;
  writeFileSync(join(stateDir, `${slug}.md`), matter.stringify(body, fm), 'utf-8');
}

function readTaskRaw(slug: string): { data: Record<string, unknown>; content: string } {
  return matter(readFileSync(join(stateDir, `${slug}.md`), 'utf-8'));
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  stateDir = join(contextRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

// ───────────────────────────── LOCAL ONLY (static) ─────────────────────────

describe('LOCAL ONLY guarantee', () => {
  it('dedup.ts never imports a remote-backend/adapter module', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'task-backend', 'dedup.ts'), 'utf-8');
    expect(src).not.toMatch(/clickup\.js|github\.js|api-adapter\.js/);
  });
});

// ───────────────────────────── D1 / D2 — basic family merge ───────────────

describe('planDedup + applyDedup — family merge (D1, D2)', () => {
  it('D1: three same-name unmapped duplicates merge into one file, changelogs unioned, newest body kept', () => {
    writeTask('foo', { id: 'task_A', name: 'Fix login', updatedAt: '2026-07-01', changelog: ['### 2026-07-01 — created\nfirst.'], marker: 'OLDEST' });
    writeTask('foo-2', { id: 'task_B', name: 'Fix login', updatedAt: '2026-07-10', changelog: ['### 2026-07-10 — updated\nsecond.'], marker: 'NEWEST' });
    writeTask('foo-3', { id: 'task_C', name: 'Fix login', updatedAt: '2026-07-05', changelog: ['### 2026-07-05 — touched\nthird.'], marker: 'MIDDLE' });

    const plan = planDedup(contextRoot);
    expect(plan.families).toHaveLength(1);
    expect(plan.families[0].skippedReason).toBeUndefined();
    expect(plan.families[0].keptBodyFrom).toBe('foo-2'); // newest updated_at

    const result = applyDedup(contextRoot, plan);
    expect(result.merged).toBe(1);
    expect(result.filesRemoved).toBe(2);

    expect(existsSync(join(stateDir, 'foo.md'))).toBe(true);
    expect(existsSync(join(stateDir, 'foo-2.md'))).toBe(false);
    expect(existsSync(join(stateDir, 'foo-3.md'))).toBe(false);

    const { data, content } = readTaskRaw('foo');
    expect(data.id).toBe('task_B'); // kept the newest body's own identity
    expect(content).toContain('NEWEST');
    expect(content).not.toContain('OLDEST');
    expect(content).toContain('first.');
    expect(content).toContain('second.');
    expect(content).toContain('third.');
  });

  it('D2: map ends with one entry at canonical slug, newest remoteId, stale entries + sync state gone', () => {
    writeTask('foo', { id: 'task_A', name: 'Fix login', updatedAt: '2026-07-01' });
    writeTask('foo-2', { id: 'task_B', name: 'Fix login', updatedAt: '2026-07-10' });
    writeMap([
      entry({ slug: 'foo', dcId: 'task_A', remoteId: 'R1' }),
      entry({ slug: 'foo-2', dcId: 'task_B', remoteId: 'R1' }),
    ]);
    const ledger = new SyncLedger(contextRoot);
    ledger.updateTaskSync('foo', { last_synced_at: 1 });
    ledger.updateTaskSync('foo-2', { last_synced_at: 2 });

    const plan = planDedup(contextRoot);
    applyDedup(contextRoot, plan);

    const map = readMapRaw();
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({ slug: 'foo', dcId: 'task_B', remoteId: 'R1' });

    expect(ledger.taskSync('foo-2')).toBeNull();
  });
});

// ───────────────────────────── D3 — dry-run mutates nothing ───────────────

describe('D3 — --dry-run mutates nothing', () => {
  it('planDedup alone leaves files and a clean map byte-identical', () => {
    writeTask('foo', { id: 'task_A', name: 'Fix login', updatedAt: '2026-07-01' });
    writeTask('foo-2', { id: 'task_B', name: 'Fix login', updatedAt: '2026-07-10' });
    writeMap([entry({ slug: 'foo', dcId: 'task_A', remoteId: 'R1' }), entry({ slug: 'foo-2', dcId: 'task_B', remoteId: 'R1' })]);

    const beforeMap = readFileSync(mapPath(), 'utf-8');
    const beforeFoo = readFileSync(join(stateDir, 'foo.md'), 'utf-8');
    const beforeFoo2 = readFileSync(join(stateDir, 'foo-2.md'), 'utf-8');

    const plan = planDedup(contextRoot);
    expect(plan.families).toHaveLength(1);

    expect(readFileSync(mapPath(), 'utf-8')).toBe(beforeMap);
    expect(readFileSync(join(stateDir, 'foo.md'), 'utf-8')).toBe(beforeFoo);
    expect(readFileSync(join(stateDir, 'foo-2.md'), 'utf-8')).toBe(beforeFoo2);
  });
});

// ───────────────────────────── D4 — distinct-remote-ids skip ──────────────

describe('D4 — distinct remoteIds are never merged', () => {
  it('skips the family, files and map untouched', () => {
    writeTask('foo', { id: 'task_A', name: 'Fix login', updatedAt: '2026-07-01' });
    writeTask('foo-2', { id: 'task_B', name: 'Fix login', updatedAt: '2026-07-10' });
    writeMap([entry({ slug: 'foo', dcId: 'task_A', remoteId: 'R1' }), entry({ slug: 'foo-2', dcId: 'task_B', remoteId: 'R2' })]);

    const plan = planDedup(contextRoot);
    expect(plan.families).toHaveLength(1);
    expect(plan.families[0].skippedReason).toBe('distinct-remote-ids');

    const result = applyDedup(contextRoot, plan);
    expect(result.merged).toBe(0);
    expect(result.filesRemoved).toBe(0);

    expect(existsSync(join(stateDir, 'foo.md'))).toBe(true);
    expect(existsSync(join(stateDir, 'foo-2.md'))).toBe(true);
    const map = readMapRaw();
    expect(map).toHaveLength(2);
    expect(map.map((e) => e.slug).sort()).toEqual(['foo', 'foo-2']);
  });
});

// ───────────────────────────── D5 — heals a markered map first ────────────

describe('D5 — conflict-markered map: in-memory heal for planning, physical heal only on apply', () => {
  function writeMarkeredMap(): void {
    const ours = [entry({ slug: 'foo', dcId: 'task_A', remoteId: 'R1' })];
    const theirs = [entry({ slug: 'bar', dcId: 'task_X', remoteId: 'R9' })];
    const markered = ['<<<<<<< HEAD', JSON.stringify(ours), '=======', JSON.stringify(theirs), '>>>>>>> theirs', ''].join('\n');
    writeFileSync(mapPath(), markered, 'utf-8');
  }

  it('(a) --dry-run: planDedup reports mapHealed + a full plan, but leaves the file BYTE-IDENTICAL', () => {
    writeTask('foo', { id: 'task_A', name: 'Fix login', updatedAt: '2026-07-01' });
    writeTask('bar', { id: 'task_X', name: 'Other task', updatedAt: '2026-07-01' });
    writeMarkeredMap();
    const before = readFileSync(mapPath(), 'utf-8');

    const plan = planDedup(contextRoot);

    // Full plan computed from the in-memory-healed map — an honest preview
    // even though nothing was written.
    expect(plan.mapHealed).toBe(true);
    expect(plan.families).toEqual([]);
    expect(plan.mapRepairs).toEqual([]);

    // The critical guarantee: planning never touches the git-tracked bytes.
    expect(readFileSync(mapPath(), 'utf-8')).toBe(before);
    expect(readFileSync(mapPath(), 'utf-8')).toContain('<<<<<<<');
  });

  it('(b) apply run: applyDedup performs the physical heal — the map is rewritten marker-free', () => {
    writeTask('foo', { id: 'task_A', name: 'Fix login', updatedAt: '2026-07-01' });
    writeTask('bar', { id: 'task_X', name: 'Other task', updatedAt: '2026-07-01' });
    writeMarkeredMap();

    const plan = planDedup(contextRoot);
    expect(readFileSync(mapPath(), 'utf-8')).toContain('<<<<<<<'); // still markered — plan alone never wrote

    applyDedup(contextRoot, plan);

    expect(readFileSync(mapPath(), 'utf-8')).not.toContain('<<<<<<<');
    const map = readMapRaw();
    expect(map.map((e) => e.slug).sort()).toEqual(['bar', 'foo']);
  });
});

// ───────────────────────────── D7 — dcId↔remoteId cross-wiring ────────────

describe('D7 — dcId cross-wiring detection/repair', () => {
  it('D7(a,b): a single-file mismatch repoints cleanly — one entry per identity, nothing dangles', () => {
    writeTask('foo', { id: 'task_D2', name: 'Fix login', updatedAt: '2026-07-01' }); // file at foo carries D2
    writeTask('bar', { id: 'task_D1', name: 'Other task', updatedAt: '2026-07-01' }); // bar.md is genuinely D1, unmapped
    writeMap([
      entry({ slug: 'foo', dcId: 'task_D1', remoteId: 'R1' }), // map says foo→D1, but foo.md is actually D2
    ]);

    const plan = planDedup(contextRoot);
    const repair = plan.mapRepairs.find((r) => r.dcId === 'task_D1');
    expect(repair).toMatchObject({ fromSlug: 'foo', toSlug: 'bar', disposition: 'repaired' });

    const result = applyDedup(contextRoot, plan);
    expect(result).toBeDefined();
    const map = readMapRaw();
    const slugs = map.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // no duplicate slug
    expect(map.find((e) => e.dcId === 'task_D1')?.slug).toBe('bar');
    expect(map.some((e) => e.slug === 'foo' && e.dcId === 'task_D1')).toBe(false); // nothing dangles at the old slug
  });

  it('D7(c): swap-shaped double-mismatch resolves BOTH entries, no loss', () => {
    writeTask('foo', { id: 'task_D1', name: 'Task One', updatedAt: '2026-07-01' });
    writeTask('bar', { id: 'task_D2', name: 'Task Two', updatedAt: '2026-07-01' });
    writeMap([
      entry({ slug: 'foo', dcId: 'task_D2', remoteId: 'R2' }), // scrambled: foo→D2 but foo.md is D1
      entry({ slug: 'bar', dcId: 'task_D1', remoteId: 'R1' }), // scrambled: bar→D1 but bar.md is D2
    ]);

    const plan = planDedup(contextRoot);
    const result = applyDedup(contextRoot, plan);
    expect(result).toBeDefined();

    const map = readMapRaw();
    expect(map).toHaveLength(2); // no entry lost
    expect(map.find((e) => e.remoteId === 'R1')?.slug).toBe('foo'); // D1 now maps to the slug whose file IS D1
    expect(map.find((e) => e.remoteId === 'R2')?.slug).toBe('bar');
    const slugs = map.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('D7(e): a dcId matching no live file is left intact and flagged unrepairable', () => {
    writeTask('foo', { id: 'task_D1', name: 'Fix login', updatedAt: '2026-07-01' });
    writeMap([entry({ slug: 'foo', dcId: 'task_GHOST', remoteId: 'R1' })]); // no file anywhere has id: task_GHOST

    const plan = planDedup(contextRoot);
    const repair = plan.mapRepairs.find((r) => r.dcId === 'task_GHOST');
    expect(repair).toMatchObject({ fromSlug: 'foo', disposition: 'unrepairable' });
    expect(repair!.toSlug).toBeUndefined();

    applyDedup(contextRoot, plan);
    const map = readMapRaw();
    expect(map).toEqual([entry({ slug: 'foo', dcId: 'task_GHOST', remoteId: 'R1' })]); // untouched
  });

  it('D7(f): duplicate dcId with distinct remoteIds — both remain at original slugs, both flagged, no duplicate slug in output', () => {
    writeTask('foo', { id: 'task_SHARED', name: 'Task One', updatedAt: '2026-07-01' });
    writeTask('bar', { id: 'task_OTHER', name: 'Task Two', updatedAt: '2026-07-01' });
    writeMap([
      entry({ slug: 'foo', dcId: 'task_SHARED', remoteId: 'R1' }),
      entry({ slug: 'bar', dcId: 'task_SHARED', remoteId: 'R2' }), // same dcId as foo's entry, different remoteId
    ]);

    const plan = planDedup(contextRoot);
    const collisions = plan.mapRepairs.filter((r) => r.dcId === 'task_SHARED');
    expect(collisions).toHaveLength(2);
    expect(collisions.every((r) => r.disposition === 'dcId-collision')).toBe(true);
    expect(collisions.map((r) => r.fromSlug).sort()).toEqual(['bar', 'foo']);

    applyDedup(contextRoot, plan);
    const map = readMapRaw();
    expect(map).toHaveLength(2);
    expect(map.find((e) => e.remoteId === 'R1')?.slug).toBe('foo'); // unchanged
    expect(map.find((e) => e.remoteId === 'R2')?.slug).toBe('bar'); // unchanged
    const slugs = map.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // never two entries sharing a slug
  });

  it('D7-unit determinism: repairs are order-independent (shuffled map input, same result)', () => {
    // Two INDEPENDENT mismatches whose repointed targets don't collide with
    // each other or with any other entry — isolates order-independence from
    // the (separately-covered) collision/unrepairable dispositions.
    writeTask('foo', { id: 'task_D2', name: 'Fix login', updatedAt: '2026-07-01' });
    writeTask('bar', { id: 'task_D1', name: 'Other task', updatedAt: '2026-07-01' });
    writeTask('baz', { id: 'task_D4', name: 'Third task', updatedAt: '2026-07-01' });
    writeTask('qux', { id: 'task_D3', name: 'Fourth task', updatedAt: '2026-07-01' });
    const mapA = [
      entry({ slug: 'foo', dcId: 'task_D1', remoteId: 'R1' }), // mismatched → repoints to 'bar'
      entry({ slug: 'baz', dcId: 'task_D3', remoteId: 'R3' }), // mismatched → repoints to 'qux'
    ];
    const mapB = [...mapA].reverse();

    writeMap(mapA);
    const planA = planDedup(contextRoot);
    writeMap(mapB);
    const planB = planDedup(contextRoot);

    expect(planA.mapRepairs).toEqual(planB.mapRepairs);
    expect(planA.mapRepairs.map((r) => `${r.fromSlug}->${r.toSlug}`).sort()).toEqual(['baz->qux', 'foo->bar']);
  });
});

// ───────────────────────────── D6 — CLI --yes gate ─────────────────────────

/** Build a fresh Command, register `tasks`, parse argv from cwd (mirrors the multi-people-awareness harness). */
async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
}

describe('D6 — tasks dedup CLI --yes gate', () => {
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(origCwd);
  });

  it('refuses without --yes in a non-interactive session: exits non-zero, prints plan only, mutates nothing', async () => {
    writeTask('foo', { id: 'task_A', name: 'Fix login', updatedAt: '2026-07-01' });
    writeTask('foo-2', { id: 'task_B', name: 'Fix login', updatedAt: '2026-07-10' });
    writeMap([entry({ slug: 'foo', dcId: 'task_A', remoteId: 'R1' }), entry({ slug: 'foo-2', dcId: 'task_B', remoteId: 'R1' })]);
    const beforeMap = readFileSync(mapPath(), 'utf-8');

    expect(process.stdin.isTTY).toBeFalsy(); // vitest stdin is not a TTY

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;
    try {
      await runCli(['tasks', 'dedup']);
      expect(process.exitCode).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Refusing to dedup without --yes in a non-interactive session.'));
    } finally {
      process.exitCode = 0; // don't poison the test runner's own exit code
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(existsSync(join(stateDir, 'foo.md'))).toBe(true);
    expect(existsSync(join(stateDir, 'foo-2.md'))).toBe(true);
    expect(readFileSync(mapPath(), 'utf-8')).toBe(beforeMap);
  });

  it('--dry-run never asks for --yes and mutates nothing', async () => {
    writeTask('foo', { id: 'task_A', name: 'Fix login', updatedAt: '2026-07-01' });
    writeTask('foo-2', { id: 'task_B', name: 'Fix login', updatedAt: '2026-07-10' });
    writeMap([entry({ slug: 'foo', dcId: 'task_A', remoteId: 'R1' }), entry({ slug: 'foo-2', dcId: 'task_B', remoteId: 'R1' })]);
    const beforeMap = readFileSync(mapPath(), 'utf-8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = 0;
    try {
      await runCli(['tasks', 'dedup', '--dry-run']);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = 0;
      logSpy.mockRestore();
    }

    expect(existsSync(join(stateDir, 'foo-2.md'))).toBe(true);
    expect(readFileSync(mapPath(), 'utf-8')).toBe(beforeMap);
  });

  it('--yes applies without prompting', async () => {
    writeTask('foo', { id: 'task_A', name: 'Fix login', updatedAt: '2026-07-01' });
    writeTask('foo-2', { id: 'task_B', name: 'Fix login', updatedAt: '2026-07-10' });
    writeMap([entry({ slug: 'foo', dcId: 'task_A', remoteId: 'R1' }), entry({ slug: 'foo-2', dcId: 'task_B', remoteId: 'R1' })]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCli(['tasks', 'dedup', '--yes']);
    } finally {
      logSpy.mockRestore();
    }

    expect(existsSync(join(stateDir, 'foo.md'))).toBe(true);
    expect(existsSync(join(stateDir, 'foo-2.md'))).toBe(false);
  });
});

// Keep the DedupPlan import exercised (type-only usage still catches signature drift).
function _typeCheck(p: DedupPlan): number {
  return p.families.length;
}
