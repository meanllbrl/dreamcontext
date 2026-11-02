import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appFileGateHook } from '../../src/lib/apps/assistant.js';
import { classifyFileTool } from '../../src/lib/apps/write-gate.js';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';
import type { BashGateContext } from '../../src/lib/apps/bash-gate.js';

/** plan-veri r3 K1, AC3: an app chat writes only in its own data folder, reads no other app's. */
let base: string; let project: string; let own: string; let other: string; let gateFile: string; let ctx: BashGateContext;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wgate-')));
  project = join(base, 'proj');
  mkdirSync(join(project, '_dream_context', 'core'), { recursive: true });
  own = ensureAppDataDir(project, 'yuk');
  other = ensureAppDataDir(project, 'crm');
  writeFileSync(join(other, 'customers.csv'), 'name,amount\n');
  ctx = { slug: 'yuk', appRoot: join(base, 'proj-apps', 'yuk'), dataDir: own, projectRoot: project, actions: [] };
  gateFile = join(base, 'chat.gate.json');
  writeFileSync(gateFile, JSON.stringify(ctx));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const decide = (tool: string, input: Record<string, unknown>) => classifyFileTool(tool, input, ctx, project).decision;

describe('the file gate, as a function', () => {
  it('a new file in its own folder passes; everything else written is denied', () => {
    expect(decide('Write', { file_path: join(own, 'notes', 'today.json') })).toBe('pass');
    expect(decide('Edit', { file_path: join(project, 'README.md') })).toBe('deny');
    expect(decide('Write', { file_path: join(project, '_dream_context', 'core', '0.soul.md') })).toBe('deny');
    expect(decide('Write', { file_path: join(other, 'customers.csv') })).toBe('deny');
    expect(decide('Write', { file_path: join(ctx.appRoot, 'server.mjs') })).toBe('deny');
    expect(decide('Write', { file_path: '/tmp/x' })).toBe('deny');
    expect(decide('Write', { file_path: 'relative.json' })).toBe('deny');
    expect(decide('NotebookEdit', { notebook_path: join(project, 'n.ipynb') })).toBe('deny');
  });
  it('a folder made after the chat started is covered too (no rule existed for it)', () => {
    mkdirSync(join(project, '_dream_context', 'later'));
    expect(decide('Write', { file_path: join(project, '_dream_context', 'later', 'x.md') })).toBe('deny');
  });
  it('instruction and ignore names are refused in any case, as files and as folders', () => {
    for (const name of ['CLAUDE.md', 'claude.md', 'AGENTS.md', 'GEMINI.md', 'CLAUDE.local.md', '.gitignore']) {
      expect(decide('Write', { file_path: join(own, 'sub', name) }), name).toBe('deny');
    }
    expect(decide('Write', { file_path: join(own, '.claude', 'settings.json') })).toBe('deny');
    expect(decide('Write', { file_path: join(own, '.Codex', 'x') })).toBe('deny');
  });
  it('a hard link and a symlinked target are refused', () => {
    const outside = join(base, 'outside.txt'); writeFileSync(outside, 'x');
    linkSync(outside, join(own, 'hard.txt'));
    expect(decide('Write', { file_path: join(own, 'hard.txt') })).toBe('deny');
    symlinkSync(outside, join(own, 'soft.txt'));
    expect(decide('Write', { file_path: join(own, 'soft.txt') })).toBe('deny');
  });
  it('a symlinked <slug> folder refuses every write through it', () => {
    rmSync(own, { recursive: true });
    const elsewhere = join(base, 'elsewhere'); mkdirSync(elsewhere);
    symlinkSync(elsewhere, own);
    expect(decide('Write', { file_path: join(own, 'x.json') })).toBe('deny');
  });
  it('reads: its own data and the project pass, another app\'s data does not, in any spelling', () => {
    expect(decide('Read', { file_path: join(own, 'a.json') })).toBe('pass');
    expect(decide('Read', { file_path: join(project, 'README.md') })).toBe('pass');
    expect(decide('Read', { file_path: join(other, 'customers.csv') })).toBe('deny');
    expect(decide('Read', { file_path: join(project, '_dream_context', 'APPS', 'crm', 'customers.csv') })).toBe('deny');
    expect(decide('Grep', { pattern: 'x', path: other })).toBe('deny');
    expect(decide('Glob', { pattern: `${other}/**/*.csv` })).toBe('deny');
    expect(decide('Glob', { pattern: '**/*.csv', path: join(project, '_dream_context', 'apps', 'crm') })).toBe('deny');
    // A search rooted at or above the apps folder would walk every app's data (security r1 M2).
    expect(decide('Grep', { pattern: 'x', path: join(project, '_dream_context', 'apps') })).toBe('deny');
    expect(decide('Grep', { pattern: 'x', path: join(project, '_dream_context') })).toBe('deny');
    expect(decide('Grep', { pattern: 'x' })).toBe('deny'); // no path: the cwd, the project root
    expect(decide('Glob', { pattern: '**/*.csv', path: project })).toBe('deny');
    expect(decide('Grep', { pattern: 'x', path: own })).toBe('pass');
    // The pattern's own start is a search root too (security r2): absolute, above apps/, or `..`.
    expect(decide('Glob', { pattern: `${join(project, '_dream_context', 'apps')}/**/*`, path: '/tmp' })).toBe('deny');
    expect(decide('Glob', { pattern: `${join(project, '_dream_context')}/**/*.csv`, path: '/tmp' })).toBe('deny');
    expect(decide('Glob', { pattern: `${project}/**/*`, path: join(project, '_dream_context', 'core') })).toBe('deny');
    expect(decide('Glob', { pattern: '../**/*', path: own })).toBe('deny');
    expect(decide('Glob', { pattern: '**/*.json', path: own })).toBe('pass');
    expect(decide('Glob', { pattern: `${own}/**/*.json`, path: own })).toBe('pass');
    expect(decide('Grep', { pattern: 'x', path: join(project, '_dream_context', 'core') })).toBe('pass');
    // A folder made later is still another app's.
    const later = ensureAppDataDir(project, 'later-app');
    expect(decide('Read', { file_path: join(later, 'x') })).toBe('deny');
  });
});

const cli = resolve('dist/index.js');

/** The command exactly as the chat's settings carry it, run through bash with the hook's stdin. */
function runHook(stdin: unknown, gate = gateFile): { status: number | null; out: string } {
  const entry = appFileGateHook([process.execPath, cli], gate).PreToolUse[0] as { matcher: string; hooks: Array<{ command: string }> };
  const r = spawnSync('bash', ['-c', entry.hooks[0].command], { input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin), encoding: 'utf-8' });
  return { status: r.status, out: r.stdout };
}

describe.skipIf(!existsSync(cli))('the file gate, through the real `hook app-write-gate` command', () => {
  it('passes a write in its own folder with `{}`', () => {
    const r = runHook({ tool_name: 'Write', tool_input: { file_path: join(own, 'new.json'), content: '{}' }, cwd: project });
    expect(r.status).toBe(0);
    expect(r.out).toBe('{}');
  });
  it('denies the project root, core, another app, a later folder, a hard link, CLAUDE.md, another app\'s read', () => {
    const outside = join(base, 'o.txt'); writeFileSync(outside, 'x'); linkSync(outside, join(own, 'hl.txt'));
    mkdirSync(join(project, '_dream_context', 'later'));
    const cases: Array<[string, Record<string, unknown>]> = [
      ['Write', { file_path: join(project, 'x.md') }],
      ['Edit', { file_path: join(project, '_dream_context', 'core', '0.soul.md') }],
      ['Write', { file_path: join(other, 'customers.csv') }],
      ['Write', { file_path: join(project, '_dream_context', 'later', 'x.md') }],
      ['Write', { file_path: join(own, 'hl.txt') }],
      ['Write', { file_path: join(own, 'CLAUDE.md') }],
      ['Write', { file_path: join(own, '.gitignore') }],
      ['Read', { file_path: join(other, 'customers.csv') }],
    ];
    for (const [tool, input] of cases) {
      const r = runHook({ tool_name: tool, tool_input: input, cwd: project });
      expect(r.status, `${tool} ${JSON.stringify(input)}`).toBe(0);
      expect(JSON.parse(r.out).hookSpecificOutput?.permissionDecision, `${tool} ${JSON.stringify(input)}`).toBe('deny');
    }
  });
  it('fails closed: no tool name, broken stdin or an unreadable gate file exit 2', () => {
    expect(runHook({ tool_input: {} }).status).toBe(2);
    expect(runHook('not json').status).toBe(2);
    expect(runHook({ tool_name: 'Write', tool_input: { file_path: join(own, 'a') } }, join(base, 'missing.gate.json')).status).toBe(2);
  });
});
