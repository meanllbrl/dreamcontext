import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builderTest, type SessionDeps } from '../../src/cli/commands/builder-sessions.js';
import { RELATED_FILE_CEILING, incrementalTscArgv, tscBuildInfoFile, wideRelatedMessage } from '../../src/lib/builder-test.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });

describe('builder test sizes --related before it runs (OR-1)', () => {
  let root: string;
  let out: string[];
  let checks: string[][];
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-bt-size-')));
    out = []; checks = [];
    git(root, 'init', '-q');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '4' } }));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'src/hub.ts'), 'export const hub = 1;\n');
    writeFileSync(join(root, 'src/leaf.ts'), 'export const leaf = 1;\n');
    writeFileSync(join(root, 'tests/leaf.test.ts'), "import { leaf } from '../src/leaf';\nvoid leaf;\n");
    for (let i = 0; i < RELATED_FILE_CEILING + 5; i++) writeFileSync(join(root, `tests/h${i}.test.ts`), "import { hub } from '../src/hub';\nvoid hub;\n");
    git(root, 'add', '-A');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const deps = (): SessionDeps => ({
    root: () => root,
    now: () => Date.parse('2026-11-12T00:00:00Z'),
    print: (l: string) => out.push(l),
    printErr: (l: string) => out.push(`ERR ${l}`),
    runCheck: async (argv: string[], _cwd: string, log: string) => { checks.push(argv); writeFileSync(log, ''); return null; },
  } as unknown as SessionDeps);

  it('refuses a hub file before any check, names it and both ways out', async () => {
    await expect(builderTest(deps(), 'demo', { wave: '1', related: ['src/hub.ts', 'src/leaf.ts'] }))
      .rejects.toThrow(/Nothing was run[\s\S]*src\/hub\.ts[\s\S]*--also[\s\S]*--wide-related/);
    expect(checks).toEqual([]);
  });

  it('does not blame the small file that came with the hub', async () => {
    const err = await builderTest(deps(), 'demo', { wave: '1', related: ['src/hub.ts', 'src/leaf.ts'] }).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/src\/leaf\.ts \(/);
  });

  it('refuses before a --failed rerun too, and with no task', async () => {
    await expect(builderTest(deps(), 'demo', { wave: '1', failed: true, related: ['src/hub.ts'] })).rejects.toThrow(/Nothing was run/);
    await expect(builderTest(deps(), undefined, { failed: true, related: ['src/hub.ts'] })).rejects.toThrow(/Nothing was run/);
    expect(checks).toEqual([]);
  });

  it('a small related set runs as before', async () => {
    await builderTest(deps(), 'demo', { wave: '1', related: ['src/leaf.ts'] });
    expect(checks.some((a) => a[0] === 'tsc')).toBe(true);
  });

  it('--wide-related is the explicit override', async () => {
    await builderTest(deps(), 'demo', { wave: '1', related: ['src/hub.ts'], wideRelated: true });
    expect(checks.some((a) => a[0] === 'vitest')).toBe(true);
  });

  it('the message says what the file pulls in', () => {
    expect(wideRelatedMessage('.', 201, [{ file: 'src/x.ts', tests: 201 }])).toContain(`over ${RELATED_FILE_CEILING}`);
  });
});

describe('the type-check is incremental per worktree (OR-10)', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-bt-tsc-')));
    git(root, 'init', '-q');
    writeFileSync(join(root, 'tsconfig.json'), '{"a":1}');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('adds --incremental and a build-info file under the git dir', () => {
    const argv = incrementalTscArgv(['tsc', '--noEmit', '-p', 'tsconfig.json'], root);
    expect(argv.slice(0, 4)).toEqual(['tsc', '--noEmit', '-p', 'tsconfig.json']);
    expect(argv[4]).toBe('--incremental');
    expect(argv[5]).toBe('--tsBuildInfoFile');
    expect(argv[6]).toMatch(/\.git[\\/]dc-tsc[\\/][0-9a-f]{16}\.tsbuildinfo$/);
  });

  it('the file name follows the tsconfig and the package', () => {
    const a = tscBuildInfoFile('/g', '.:tsconfig.json', '{"a":1}');
    expect(tscBuildInfoFile('/g', '.:tsconfig.json', '{"a":2}')).not.toBe(a);
    expect(tscBuildInfoFile('/g', 'dashboard:tsconfig.json', '{"a":1}')).not.toBe(a);
    expect(tscBuildInfoFile('/g', '.:tsconfig.json', '{"a":1}')).toBe(a);
  });

  it('leaves other commands, builds and already incremental runs alone', () => {
    for (const argv of [['vitest', 'run'], ['tsc', '-p', 'tsconfig.json'], ['tsc', '--noEmit', '-p', 'tsconfig.json', '--incremental'], ['tsc', '--noEmit']]) {
      expect(incrementalTscArgv(argv, root)).toEqual(argv);
    }
  });

  it('fails open outside a git repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'dc-bt-plain-'));
    writeFileSync(join(plain, 'tsconfig.json'), '{}');
    const argv = ['tsc', '--noEmit', '-p', 'tsconfig.json'];
    expect(incrementalTscArgv(argv, plain)).toEqual(argv);
    rmSync(plain, { recursive: true, force: true });
  });
});
