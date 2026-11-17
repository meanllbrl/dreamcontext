/**
 * Mağaza D1 criterion 4: the CLI refuses a not-installed plugin's writes only (exit 3), and
 * `plugins` / `theses enable|disable` switch it. The decision is the command path, never args.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliPathOwner, cliRefusal, cliRefusalMessage } from '../../src/lib/plugins/gate.js';
import { getPlugin, PLUGINS } from '../../src/lib/plugins/registry.js';
import type { Command } from 'commander';
import { installPlugin, isPluginInstalled, readEntry } from '../../src/lib/plugins/store.js';
import { textRunsPlugin } from '../../src/lib/plugins/automations.js';
import { createProgram } from '../../src/cli/program.js';
import { readSetupConfig } from '../../src/lib/setup-config.js';

let project: string;
let ctx: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-plugins-cli-'));
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '0.41.22', disableNativeMemory: true }));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(project, { recursive: true, force: true });
});

const REFUSED: Array<[string, string]> = [
  ['roadmap', 'roadmap'],
  ['roadmap objective create', 'roadmap'],
  ['theses create', 'hypotheses'],
  ['lab sync', 'lab'],
  ['lab data write', 'lab'],
  ['lab credentials list', 'lab'],
  ['council create', 'council'],
  ['council round start', 'council'],
  ['council report append', 'council'],
  ['marketing cohort create', 'marketing'],
  ['marketing config check', 'marketing'],
  ['marketing learnings status', 'marketing'],
  ['theses candidates', 'hypotheses'],
];

const PASSES = [
  'roadmap objective list',
  'roadmap unscored',
  'tasks objectives',
  'tasks rice',
  'tasks create',
  'lab show',
  'theses list',
  'theses enable',
  'council show',
  'marketing today',
  'plugins install',
  'learn',
  'whiteboard add',
];

describe('the decision (path only)', () => {
  it.each(REFUSED)('%s is owned by %s and refused when not installed', (path, id) => {
    expect(cliPathOwner(path.split(' '))?.id).toBe(id);
    expect(cliRefusal(path.split(' '), ctx)?.id).toBe(id);
  });

  it.each(PASSES)('%s runs normally', (path) => {
    expect(cliRefusal(path.split(' '), ctx)).toBeNull();
  });

  it('nothing is refused outside a project or once installed', () => {
    expect(cliRefusal(['council', 'create'], null)).toBeNull();
    installPlugin(ctx, 'council', 'x');
    expect(cliRefusal(['council', 'create'], ctx)).toBeNull();
  });

  it('the message names the plugin and the install command', () => {
    expect(cliRefusalMessage(getPlugin('lab')!)).toMatch(/^plugin_not_installed: lab — .*dreamcontext plugins install lab$/);
  });
});

describe('the root hook', () => {
  async function run(argv: string[]): Promise<{ code: number | null; stderr: string }> {
    let stderr = '';
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { stderr += String(chunk); return true; }) as typeof process.stderr.write);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw Object.assign(new Error('exit'), { exitCode: code ?? 0 }); }) as typeof process.exit);
    const program = createProgram();
    program.exitOverride();
    try {
      await program.parseAsync(['node', 'dreamcontext', ...argv]);
      return { code: null, stderr };
    } catch (err) {
      const e = err as { exitCode?: number };
      return { code: exit.mock.calls.length > 0 ? (e.exitCode ?? null) : null, stderr };
    }
  }

  it('council create exits 3 with plugin_not_installed and writes nothing', async () => {
    const r = await run(['council', 'create', 'Should we?']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('plugin_not_installed: council');
    expect(existsSync(join(ctx, 'council'))).toBe(false);
  });

  it('the mk alias resolves to marketing', async () => {
    const r = await run(['mk', 'rem-sleep']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('plugin_not_installed: marketing');
  });

  it('theses enable installs hypotheses (the switch always passes)', async () => {
    const r = await run(['theses', 'enable']);
    expect(r.code).toBeNull();
    expect(isPluginInstalled(ctx, 'hypotheses')).toBe(true);
    expect(readEntry(ctx, 'hypotheses').entry?.state).toBe('installed');
    expect(readSetupConfig(project)?.learning?.enabled).toBe(true);
    await run(['theses', 'disable']);
    expect(isPluginInstalled(ctx, 'hypotheses')).toBe(false);
  });

  it('plugins install / remove write one owner entry', async () => {
    await run(['plugins', 'install', 'lab']);
    expect(isPluginInstalled(ctx, 'lab')).toBe(true);
    await run(['plugins', 'remove', 'lab']);
    expect(JSON.parse(readFileSync(join(ctx, 'overrides', 'plugins', 'lab.json'), 'utf-8')).state).toBe('removed');
  });
});

describe('a read leaf writes nothing', () => {
  function tree(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        const st = statSync(full);
        out.push(`${full.slice(project.length)}:${st.isDirectory() ? 'd' : st.size}`);
        if (st.isDirectory()) walk(full);
      }
    };
    walk(dir);
    return out.sort();
  }
  function leaf(path: string): Command {
    let c = createProgram() as Command;
    for (const name of path.split(' ')) c = c.commands.find((s) => s.name() === name)!;
    return c;
  }
  const READS = PLUGINS.flatMap((p) => p.cliReads);
  const VALID_ARGS: Record<string, () => string[]> = {
    'marketing learnings status': () => ['no-such-id', 'confirmed'],
    'theses candidates': () => {
      const file = join(project, 'claims.json');
      writeFileSync(file, JSON.stringify({ items: ['a claim'] }));
      return [file];
    },
  };

  it.each(READS)('%s leaves the brain unchanged when its plugin is not installed', async (path) => {
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw Object.assign(new Error('exit'), { exitCode: code ?? 0 }); }) as typeof process.exit);
    // A missing id still walks the leaf's path to its write, which is where a write leaf leaks.
    // A leaf that validates its arguments before writing gets valid ones (VALID_ARGS), else the
    // check would pass on a write leaf that simply refused the made-up input.
    const args = VALID_ARGS[path]?.() ?? leaf(path).registeredArguments.filter((a) => a.required).map(() => 'no-such-id');
    const before = tree(ctx);
    const program = createProgram();
    program.exitOverride();
    try { await program.parseAsync(['node', 'dreamcontext', ...path.split(' '), ...args]); } catch { /* exit or refusal */ }
    expect(tree(ctx)).toEqual(before);
  });
});

describe('automations that run a plugin', () => {
  it('matches the plugin root and its alias', () => {
    expect(textRunsPlugin('every hour: dreamcontext lab sync wau', 'lab')).toBe(true);
    expect(textRunsPlugin('run `dreamcontext mk today`', 'marketing')).toBe(true);
    expect(textRunsPlugin('dreamcontext labels', 'lab')).toBe(false);
    expect(textRunsPlugin('dreamcontext tasks list', 'lab')).toBe(false);
  });
});
