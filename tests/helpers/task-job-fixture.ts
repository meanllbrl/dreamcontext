/**
 * A scratch project for task-job tests (AI Team v2 C1): a brain with `state/` and
 * `automations/`, a fake $HOME (the machine-local store, the registry, the machine id), agents
 * created and approved here, and a stand-in claude for the runner's `spawnImpl` whose children
 * can call `tasks deliver` / `tasks review` / `automations propose` with the env the host gave
 * them, the way a real run does.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { vi } from 'vitest';
import type { SpawnImpl } from '../../src/lib/automations/runner.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { registerProject } from '../../src/lib/automations/registry.js';
import type { AgentAutonomy } from '../../src/lib/automations/types.js';

export interface Fixture {
  projectRoot: string;
  contextRoot: string;
  home: string;
  cleanup: () => void;
}

const ORIGINAL_HOME = process.env.HOME;

/** A fresh project + home. `process.env.HOME` points at the fake home until `cleanup`. */
export function makeFixture(prefix = 'dc-taskjob'): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  process.env.HOME = home;
  registerProject(projectRoot, home);
  return {
    projectRoot,
    contextRoot,
    home,
    cleanup: () => {
      process.env.HOME = ORIGINAL_HOME;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function writeTask(f: Fixture, slug: string, opts: { id?: string; name?: string; status?: string; extra?: Record<string, unknown> } = {}): void {
  const data: Record<string, unknown> = {
    id: opts.id ?? `task_${slug.replace(/[^a-z0-9]/g, '').slice(0, 10)}`,
    name: opts.name ?? `Task ${slug}`,
    status: opts.status ?? 'todo',
    created_at: '2026-10-20',
    updated_at: '2026-10-20',
    ...(opts.extra ?? {}),
  };
  const body = ['', '## Why', 'Because.', '', '## Acceptance Criteria', '- [ ] it works', '', '## Changelog', ''].join('\n');
  writeFileSync(join(f.contextRoot, 'state', `${slug}.md`), matter.stringify(body, data));
}

export function taskData(f: Fixture, slug: string): Record<string, unknown> {
  return matter(readFileSync(join(f.contextRoot, 'state', `${slug}.md`), 'utf-8')).data as Record<string, unknown>;
}

export function taskText(f: Fixture, slug: string): string {
  return readFileSync(join(f.contextRoot, 'state', `${slug}.md`), 'utf-8');
}

export function makeAgent(f: Fixture, slug: string, autonomy: AgentAutonomy = 'balanced', now = new Date('2026-10-25T09:00:00.000Z')): void {
  createAgent(f.contextRoot, { slug, title: `Agent ${slug}`, prompt: `You are ${slug}.`, autonomy }, { approve: { now, home: f.home } });
}

export interface SpawnCall {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface ChildScript {
  /** The stdout JSON envelope the child prints. */
  result?: string;
  is_error?: boolean;
  session_id?: string;
  num_turns?: number;
  /** Runs before the child "exits": the place a stand-in delivers, reviews or proposes. */
  during?: (call: SpawnCall) => void;
  /** Never exits on its own: only `killChild(pid)` ends it (a stall, a Stop). */
  hang?: boolean;
}

const hanging = new Map<number, () => void>();

/** End a hanging stand-in child, as a SIGKILL to its group would. */
export function killChild(pid: number): void {
  hanging.get(pid)?.();
  hanging.delete(pid);
}

/** A stand-in claude: one scripted child per spawn, every call recorded. */
export function standInClaude(scripts: Array<ChildScript | ((call: SpawnCall) => ChildScript)>): { impl: SpawnImpl; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const impl = vi.fn((_bin: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined> }) => {
    // With no claude on the fake HOME the runner wraps it in a login shell: record claude's own argv.
    const argv = args[0] === '-ilc' ? args.slice(3) : args;
    const call: SpawnCall = { args: argv, cwd: options.cwd ?? '', env: options.env ?? {} };
    const n = calls.length;
    calls.push(call);
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    // A pid no real process has: the runner writes it into the sidecar.
    const child = Object.assign(new EventEmitter(), { pid: 3_900_000 + n, stdout, stderr, kill: () => {} });
    const entry = scripts[n] ?? { result: 'unexpected extra spawn' };
    const script = typeof entry === 'function' ? entry(call) : entry;
    const sessionAt = argv.indexOf('--session-id');
    const resumeAt = argv.indexOf('--resume');
    const sid = script.session_id ?? (sessionAt >= 0 ? argv[sessionAt + 1] : resumeAt >= 0 ? argv[resumeAt + 1] : 'sess_standin');
    if (script.hang) {
      hanging.set(child.pid, () => { child.emit('close', null, 'SIGKILL'); });
      return child;
    }
    setImmediate(() => {
      try { script.during?.(call); } catch (err) { stderr.emit('data', Buffer.from(String(err))); }
      const json = JSON.stringify({
        session_id: sid, result: script.result ?? 'Done.', is_error: script.is_error ?? false, permission_denials: [],
        total_cost_usd: 0.01, num_turns: script.num_turns ?? 3, duration_ms: 1000, subtype: 'success',
      });
      stdout.emit('data', Buffer.from(json, 'utf-8'));
      child.emit('close', 0);
    });
    return child;
  }) as unknown as SpawnImpl;
  return { impl, calls };
}

/** The value after `flag` in an argv. */
export function argAfter(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? null : null;
}
