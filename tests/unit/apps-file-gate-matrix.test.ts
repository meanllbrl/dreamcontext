import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { appFileGateHook } from '../../src/lib/apps/assistant.js';
import { classifyFileTool, WALK_LIMITS } from '../../src/lib/apps/write-gate.js';
import { classifyBash, type BashGateContext } from '../../src/lib/apps/bash-gate.js';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';

/**
 * The file gate judges the resource, not the spelling (one-more-way-in pattern): every tool x every
 * path shape, and only this app's own data folder, in its canonical spelling, passes. Another
 * app's data never does, whatever the shape.
 */

let base: string; let project: string; let apps: string; let own: string; let other: string; let free: string;
let neutral: string; let fakeHome: string; let ctx: BashGateContext; let gateFile: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-gmatrix-')));
  // A non-ASCII project folder, so an NFD spelling of it is a real second spelling.
  project = join(base, 'proj-ü'.normalize('NFC'));
  mkdirSync(join(project, '_dream_context', 'core'), { recursive: true });
  free = join(project, '_dream_context', 'core');
  writeFileSync(join(free, 'notes.md'), '# notes\n');
  own = ensureAppDataDir(project, 'yuk');
  other = ensureAppDataDir(project, 'crm');
  apps = join(project, '_dream_context', 'apps');
  writeFileSync(join(own, 'a.json'), '{}');
  writeFileSync(join(other, 'customers.csv'), 'name,amount\n');
  neutral = join(base, 'neutral'); mkdirSync(neutral);
  writeFileSync(join(neutral, 'n.txt'), 'n');
  fakeHome = join(base, 'home');
  mkdirSync(join(fakeHome, '.dreamcontext', 'apps', 'backup', 'h1'), { recursive: true });
  writeFileSync(join(fakeHome, '.dreamcontext', 'apps', 'backup', 'h1', 'a.json'), '{}');
  symlinkSync(own, join(base, 'link-own'));
  symlinkSync(other, join(base, 'link-other'));
  ctx = { slug: 'yuk', appRoot: join(base, 'proj-apps', 'yuk'), dataDir: own, projectRoot: project, home: fakeHome, actions: [] };
  mkdirSync(ctx.appRoot, { recursive: true });
  gateFile = join(base, 'chat.gate.json');
  writeFileSync(gateFile, JSON.stringify(ctx));
});
afterAll(() => { rmSync(base, { recursive: true, force: true }); });

type Target = 'own' | 'other';
const folderOf = (t: Target) => (t === 'own' ? own : other);
const slugOf = (t: Target) => (t === 'own' ? 'yuk' : 'crm');
const fileOf = (t: Target) => (t === 'own' ? 'a.json' : 'customers.csv');

/** Each shape spells `<target folder>/<tail>` (tail '' = the folder itself) another way. */
const SHAPES: Record<string, (t: Target, tail: string) => string> = {
  absolute: (t, tail) => folderOf(t) + tail,
  relative: (t, tail) => relative(project, folderOf(t) + tail),
  tilde: (t, tail) => `~/${relative(homedir(), folderOf(t) + tail)}`,
  trailingSpace: (t, tail) => `${folderOf(t)}${tail} `,
  leadingSpace: (t, tail) => ` ${folderOf(t)}${tail}`,
  segmentSpace: (t, tail) => `${folderOf(t)} ${tail || '/'}`,
  dotdot: (t, tail) => `${apps}/zzz/../${slugOf(t)}${tail}`,
  dot: (t, tail) => `${apps}/./${slugOf(t)}${tail}`,
  doubleSlash: (t, tail) => `${apps}//${slugOf(t)}${tail}`,
  wildcardFirst: (_t, tail) => `${apps}/*${tail}`,
  caseVariant: (t, tail) => `${project}/_DREAM_CONTEXT/Apps/${slugOf(t).toUpperCase()}${tail}`,
  nfd: (t, tail) => (folderOf(t) + tail).normalize('NFD'),
  symlink: (t, tail) => join(base, t === 'own' ? 'link-own' : 'link-other') + tail,
  zeroWidth: (t, tail) => `${apps}/${slugOf(t)}​${tail}`,
  nbsp: (t, tail) => `${folderOf(t)}${tail} `,
  tab: (t, tail) => `${folderOf(t)}\t${tail}`,
  backslash: (t, tail) => `${apps}\\${slugOf(t)}${tail}`,
};

/** One call per tool, aimed at the target through one shape. */
function calls(t: Target, shape: (t: Target, tail: string) => string): Array<[string, Record<string, unknown>]> {
  const file = shape(t, `/${fileOf(t)}`);
  const fresh = shape(t, '/fresh.json');
  const dir = shape(t, '');
  return [
    ['Read', { file_path: file }],
    ['Read', { file_path: dir }],
    ['Write', { file_path: fresh, content: '{}' }],
    ['Edit', { file_path: file, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: file, edits: [] }],
    ['NotebookEdit', { notebook_path: shape(t, '/n.ipynb'), new_source: '' }],
    ['Grep', { pattern: 'x', path: dir }],
    ['Grep', { pattern: 'x', path: file }],
    ['Glob', { pattern: '**/*', path: dir }],
    ['Glob', { pattern: `${dir}/**/*`, path: neutral }],
  ];
}

const decide = (tool: string, input: Record<string, unknown>) => classifyFileTool(tool, input, ctx, project).decision;

describe.skipIf(process.platform === 'win32')('the file gate, every tool x every path shape', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`another app's data is refused: ${name}`, () => {
      for (const [tool, input] of calls('other', shape)) {
        // A relative pattern under a neutral path walks only that path, which holds no app data:
        // nothing is reachable (the same pattern under the project is refused, see review C1).
        const walksNeutral = name === 'relative' && tool === 'Glob' && input.path === neutral;
        expect(decide(tool, input), `${tool} ${JSON.stringify(input)}`).toBe(walksNeutral ? 'pass' : 'deny');
      }
    });
  }

  it('its own folder, spelled as given, passes for every tool', () => {
    for (const [tool, input] of calls('own', SHAPES.absolute)) {
      expect(decide(tool, input), `${tool} ${JSON.stringify(input)}`).toBe('pass');
    }
  });

  // A spelling of the OWN folder that is not the canonical one: refused, except that a read may
  // spell the same folder in another letter case or Unicode form (the file system says it is it).
  const READ_SAME_FOLDER = new Set(['caseVariant', 'nfd']);
  for (const [name, shape] of Object.entries(SHAPES)) {
    if (name === 'absolute') continue;
    it(`its own folder in another shape is refused for writes and, unless the same folder, for reads: ${name}`, () => {
      for (const [tool, input] of calls('own', shape)) {
        const isWrite = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool);
        const walksNeutral = name === 'relative' && tool === 'Glob' && input.path === neutral;
        const expected = walksNeutral || (!isWrite && READ_SAME_FOLDER.has(name)) ? 'pass' : 'deny';
        expect(decide(tool, input), `${name}: ${tool} ${JSON.stringify(input)}`).toBe(expected);
      }
    });
  }

  it('a search is judged by the tree it walks: a link to another app anywhere in it refuses it', () => {
    const tree = join(base, 'tree'); mkdirSync(join(tree, 'deep', 'er'), { recursive: true });
    writeFileSync(join(tree, 'deep', 'x.txt'), 'x');
    expect(decide('Grep', { pattern: 'x', path: tree })).toBe('pass');
    expect(decide('Glob', { pattern: '**/*.txt', path: tree })).toBe('pass');
    symlinkSync(other, join(tree, 'deep', 'er', 'innocent'));
    expect(decide('Grep', { pattern: 'x', path: tree })).toBe('deny');
    expect(decide('Glob', { pattern: '**/*.txt', path: tree })).toBe('deny');
    expect(decide('Read', { file_path: tree })).toBe('deny');
    rmSync(join(tree, 'deep', 'er', 'innocent'));
    // A link to a folder that HOLDS the apps folder is the same thing one step up.
    symlinkSync(join(project, '_dream_context'), join(tree, 'up'));
    expect(decide('Grep', { pattern: 'x', path: tree })).toBe('deny');
    rmSync(join(tree, 'up'));
    // A link to a plain folder is followed and that folder judged too.
    const elsewhere = join(base, 'elsewhere'); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(tree, 'side'));
    expect(decide('Grep', { pattern: 'x', path: tree })).toBe('pass');
    symlinkSync(join(project, '_dream_context'), join(elsewhere, 'sneak'));
    expect(decide('Grep', { pattern: 'x', path: tree })).toBe('deny');
  });

  it('no symlink inside its own folder: reads, searches and writes through it are refused', () => {
    const inner = join(own, 'inner'); mkdirSync(inner);
    symlinkSync(free, join(inner, 'to-core'));
    expect(decide('Grep', { pattern: 'x', path: own })).toBe('deny');
    expect(decide('Glob', { pattern: '**/*', path: own })).toBe('deny');
    expect(decide('Read', { file_path: join(inner, 'to-core', 'notes.md') })).toBe('deny');
    expect(decide('Write', { file_path: join(inner, 'to-core', 'x.md') })).toBe('deny');
    rmSync(join(inner, 'to-core'));
    expect(decide('Grep', { pattern: 'x', path: own })).toBe('pass');
  });

  it('every apps folder is protected: another project\'s, the same slug elsewhere, the home backups', () => {
    const otherProject = join(base, 'other-proj', '_dream_context', 'apps', 'yuk'); mkdirSync(otherProject, { recursive: true });
    writeFileSync(join(otherProject, 'secret.json'), '{}');
    expect(decide('Read', { file_path: join(otherProject, 'secret.json') })).toBe('deny');
    expect(decide('Grep', { pattern: 'x', path: join(base, 'other-proj') })).toBe('deny');
    expect(decide('Read', { file_path: join(fakeHome, '.dreamcontext', 'apps', 'backup', 'h1', 'a.json') })).toBe('deny');
    expect(decide('Grep', { pattern: 'x', path: fakeHome })).toBe('deny');
    expect(decide('Glob', { pattern: `${apps}/**/*`, path: own })).toBe('deny');
    expect(decide('Read', { file_path: apps })).toBe('deny');
  });

  it('a search above the apps folder, at the root, or with no path (the cwd is the project) is refused', () => {
    expect(decide('Grep', { pattern: 'x' })).toBe('deny');
    expect(decide('Glob', { pattern: '**/*.csv' })).toBe('deny');
    expect(decide('Glob', { pattern: '/**/customers.csv', path: neutral })).toBe('deny');
    expect(decide('Glob', { pattern: `{${apps}/crm,x}/**`, path: neutral })).toBe('deny');
    expect(decide('Glob', { pattern: '@(/tmp)/**', path: neutral })).toBe('deny');
    expect(decide('Grep', { pattern: 'x', path: neutral, glob: `${apps}/**` })).toBe('deny');
    expect(decide('Grep', { pattern: 'x', path: '/' })).toBe('deny');
    expect(decide('Grep', { pattern: 'x', path: project })).toBe('deny');
  });

  it('a relative Glob pattern is judged by the whole path it walks (Claude Code rewrites it: review C1)', () => {
    expect(decide('Glob', { path: project, pattern: `${basename(project)}/_dream_context/app[s]/crm/*` })).toBe('deny');
    expect(decide('Glob', { path: fakeHome, pattern: `${basename(fakeHome)}/.dreamcontext/app[s]/**` })).toBe('deny');
    expect(decide('Glob', { pattern: `${basename(project)}/_dream_context/*/crm/*` })).toBe('deny');
    expect(decide('Glob', { path: neutral, pattern: 'deep/**/*.txt' })).toBe('pass');
  });

  const dataVolume = '/System/Volumes/Data';
  it.skipIf(process.platform !== 'darwin' || !existsSync(dataVolume + realpathSync(tmpdir())))('the disk\'s second name on macOS reaches nothing (review C2)', () => {
    const alias = (p: string) => dataVolume + p;
    expect(decide('Read', { file_path: alias(join(fakeHome, '.dreamcontext', 'apps', 'backup', 'h1', 'a.json')) })).toBe('deny');
    expect(decide('Grep', { pattern: 'x', path: alias(join(fakeHome, '.dreamcontext')) })).toBe('deny');
    expect(decide('Glob', { pattern: '**/*', path: alias(join(fakeHome, '.dreamcontext', 'apps')) })).toBe('deny');
    expect(decide('Read', { file_path: alias(join(free, 'notes.md')) })).toBe('deny');
    // A link whose target keeps the second name is caught by the folder's identity, not its spelling.
    const via = join(base, 'via-alias'); mkdirSync(via);
    symlinkSync(alias(join(fakeHome, '.dreamcontext')), join(via, 'dc'));
    try {
      expect(decide('Grep', { pattern: 'x', path: via })).toBe('deny');
      expect(decide('Read', { file_path: join(via, 'dc', 'apps', 'backup', 'h1', 'a.json') })).toBe('deny');
    } finally { rmSync(join(via, 'dc')); }
  });

  it('an instruction name spelled with a character the disk folds (long s) is refused (review M1)', () => {
    expect(decide('Write', { file_path: join(own, 'agent\u017f.md') })).toBe('deny');
    expect(decide('Write', { file_path: join(own, '.cur\u017for', 'rules') })).toBe('deny');
    expect(decide('Write', { file_path: join(own, '\u017fub', 'ok.json') })).toBe('pass');
  });

  it('a tree too big to prove clean is refused, not guessed', () => {
    const big = join(base, 'big'); mkdirSync(big);
    for (let i = 0; i < 30; i++) writeFileSync(join(big, `f${i}`), '');
    const saved = { ...WALK_LIMITS };
    try {
      WALK_LIMITS.entries = 10;
      expect(decide('Grep', { pattern: 'x', path: big })).toBe('deny');
    } finally { Object.assign(WALK_LIMITS, saved); }
    expect(decide('Grep', { pattern: 'x', path: big })).toBe('pass');
  });

  it('a project file reads and searches; it is never written', () => {
    expect(decide('Read', { file_path: join(free, 'notes.md') })).toBe('pass');
    expect(decide('Grep', { pattern: 'x', path: free })).toBe('pass');
    expect(decide('Glob', { pattern: `${free}/*.md`, path: neutral })).toBe('pass');
    expect(decide('Write', { file_path: join(free, 'x.md') })).toBe('deny');
    expect(decide('Edit', { file_path: join(free, 'notes.md') })).toBe('deny');
    expect(decide('Write', { file_path: join(ctx.appRoot, 'server.mjs') })).toBe('deny');
  });

  it('a write call with no path, or a second path field pointing elsewhere, is refused', () => {
    expect(decide('Write', { content: 'x' })).toBe('deny');
    expect(decide('NotebookEdit', { notebook_path: join(own, 'n.ipynb'), file_path: join(other, 'x') })).toBe('deny');
  });

  it('Bash (the own assistant\'s gate): `ls` passes only on its own folder, never another app\'s', () => {
    const ls = (p: string) => classifyBash(`ls ${p}`, ctx).decision;
    expect(ls(own)).toBe('pass');
    for (const [name, shape] of Object.entries(SHAPES)) {
      const p = shape('other', '');
      if (/[\s\\]/.test(p)) continue; // a space or backslash is not one `ls` argument; covered by the parser
      expect(ls(p), name).not.toBe('pass');
    }
    // A link in its own folder could list another app's names with `ls -L`: no pass then.
    symlinkSync(other, join(own, 'peek'));
    try { expect(ls(`-L ${own}`)).not.toBe('pass'); } finally { rmSync(join(own, 'peek')); }
  });
});

const cli = resolve('dist/index.js');

function runHook(stdin: unknown): Promise<{ status: number | null; out: string }> {
  const entry = appFileGateHook([process.execPath, cli], gateFile).PreToolUse[0] as { hooks: Array<{ command: string }> };
  return new Promise((res, rej) => {
    const p = spawn('bash', ['-c', entry.hooks[0].command], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.setEncoding('utf-8');
    p.stdout.on('data', (c: string) => { out += c; });
    p.on('error', rej);
    p.on('close', (status) => res({ status, out }));
    p.stdin.end(JSON.stringify(stdin));
  });
}

/**
 * Every call is its own `bash -c '<node> <cli> hook app-write-gate …'` and decides alone (the gate
 * only reads), so the ~180 of them run a few at a time; they ran one after another before and the
 * test outgrew its timeout on a loaded box. Results come back in call order and are asserted in
 * that order, exactly as before.
 */
async function runHooks(stdins: unknown[], parallel = 8): Promise<Array<{ status: number | null; out: string }>> {
  const results: Array<{ status: number | null; out: string }> = new Array(stdins.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < stdins.length) {
      const i = next++;
      results[i] = await runHook(stdins[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, stdins.length) }, worker));
  return results;
}

describe.skipIf(process.platform === 'win32' || !existsSync(cli))('the same matrix through the real `hook app-write-gate` command', () => {
  it('another app\'s data is refused for every tool and shape; its own canonical folder passes', { timeout: 120_000 }, async () => {
    const otherCalls: Array<{ name: string; tool: string; input: Record<string, unknown> }> = [];
    for (const [name, shape] of Object.entries(SHAPES)) {
      for (const [tool, input] of calls('other', shape)) {
        if (name === 'relative' && tool === 'Glob' && input.path === neutral) continue; // walks only neutral
        otherCalls.push({ name, tool, input });
      }
    }
    const ownCalls = calls('own', SHAPES.absolute);
    const results = await runHooks([
      ...otherCalls.map(({ tool, input }) => ({ tool_name: tool, tool_input: input, cwd: project })),
      ...ownCalls.map(([tool, input]) => ({ tool_name: tool, tool_input: input, cwd: project })),
    ]);
    otherCalls.forEach(({ name, tool, input }, i) => {
      const r = results[i];
      expect(r.status, `${name} ${tool}`).toBe(0);
      expect(JSON.parse(r.out).hookSpecificOutput?.permissionDecision, `${name} ${tool} ${JSON.stringify(input)}`).toBe('deny');
    });
    ownCalls.forEach(([tool, input], j) => {
      const r = results[otherCalls.length + j];
      expect(r.status, tool).toBe(0);
      expect(r.out, `${tool} ${JSON.stringify(input)}`).toBe('{}');
    });
  });
});
