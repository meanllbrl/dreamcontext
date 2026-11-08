import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builderHeavy, checksDir, HEAVY_DIED_EXIT, type BuilderDeps } from '../../src/cli/commands/builder.js';
import { HEAVY_LOCK_BUSY_EXIT, heavyLockPath, heavySlotPaths } from '../../src/lib/builder-tools.js';
import { releaseFileLock } from '../../src/lib/file-lock.js';
import { readSuiteRecord, suiteRecordId, writeSuiteRecord } from '../../src/lib/suite-record.js';

/**
 * `builder heavy --detach` + `--wait` (plan C4, 2026-11-08): a full suite runs as its own process,
 * outlives the session that started it, and is followed by id. Measured: 6 of 7 full runs left
 * the agent idle behind the 10-min foreground cap, and the 30-min background cap killed one with
 * nothing kept. The parent half is driven against a stand-in runner (this CLI re-run is the
 * built dist); the runner half (`--run-id`) is driven in process.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

describe('builder heavy --detach / --wait', () => {
  let root: string;
  let repo: string;
  let slots: string;
  let out: string[];
  let err: string[];
  let runner: string;
  const deps = (): BuilderDeps => ({
    cwd: () => repo, print: (l) => out.push(l), printErr: (l) => err.push(l), ps: () => '', kill: () => {},
    heavySlotDir: () => slots, heavyLimit: async () => 2, machineBusy: () => false,
    selfArgv: () => [process.execPath, runner],
  });
  const idOf = () => /detached as (h[0-9a-z]+)/.exec(out.join('\n'))![1];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-detach-')));
    repo = join(root, 'repo');
    slots = join(root, 'slots');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node -e "setTimeout(()=>process.exit(3), Number(process.env.T||1500))"' } }));
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'i');
    // A stand-in for `node dist/index.js builder heavy --run-id <id> ... -- <cmd>`: the same
    // state file protocol, then the command, then its exit.
    runner = join(root, 'runner.mjs');
    writeFileSync(runner, [
      "import { writeFileSync, mkdirSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "const a = process.argv.slice(2); const id = a[a.indexOf('--run-id') + 1]; const cmd = a.slice(a.indexOf('--') + 1);",
      `const dir = ${JSON.stringify('CHECKS')}; mkdirSync(dir, { recursive: true });`,
      "const state = (s) => writeFileSync(dir + '/' + id + '.json', JSON.stringify({ id, pid: process.pid, command: cmd.join(' '), log: dir + '/' + id + '.log', at: new Date().toISOString(), ...s }));",
      "state({ state: 'started' });",
      "const r = spawnSync(cmd.join(' '), { shell: true, stdio: 'inherit' });",
      "state({ state: 'done', exit: r.status ?? 1 });",
    ].join('\n').replace('"CHECKS"', JSON.stringify(checksDir(repo))));
    out = []; err = [];
  });
  afterEach(() => {
    for (const p of heavySlotPaths(slots)) releaseFileLock(p);
    releaseFileLock(heavyLockPath(repo));
    rmSync(root, { recursive: true, force: true });
  });

  it('prints the id at once, the check outlives the call, and --wait returns its exit as often as asked', async () => {
    const t0 = Date.now();
    expect(await builderHeavy(deps(), ['npm', 'test'], { detach: true })).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
    const id = idOf();
    expect(out.join('\n')).toContain(`dreamcontext builder heavy --wait ${id}`);
    expect(await builderHeavy(deps(), [], { wait: id })).toBe(3);
    expect(await builderHeavy(deps(), [], { wait: id })).toBe(3);
  }, 20_000);

  it('a wait slice ends with 75 while it still runs', async () => {
    process.env.T = '4000';
    try {
      expect(await builderHeavy(deps(), ['npm', 'test'], { detach: true })).toBe(0);
      expect(await builderHeavy(deps(), [], { wait: idOf(), maxWait: '1' })).toBe(HEAVY_LOCK_BUSY_EXIT);
      expect(await builderHeavy(deps(), [], { wait: idOf() })).toBe(3);
    } finally { delete process.env.T; }
  }, 20_000);

  it('a killed runner: --wait gives 4 and its running suite record becomes incomplete', async () => {
    process.env.T = '30000';
    try {
      expect(await builderHeavy(deps(), ['npm', 'test'], { detach: true })).toBe(0);
      const id = idOf();
      const state = JSON.parse(readFileSync(join(checksDir(repo), `${id}.json`), 'utf-8')) as { pid: number };
      const top = realpathSync(repo);
      writeSuiteRecord({ v: 1, id: suiteRecordId(top, 'main', 'suite'), state: 'running', pid: state.pid, toplevel: top, branch: 'main', target: 'suite', at: new Date().toISOString(), maxRunMs: 3_600_000, files: [], checkId: id });
      process.kill(state.pid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
      expect(await builderHeavy(deps(), [], { wait: id })).toBe(HEAVY_DIED_EXIT);
      expect(readSuiteRecord(top, 'main', 'suite').record).toMatchObject({ state: 'incomplete', reason: expect.stringMatching(/died/) });
      expect(await builderHeavy(deps(), [], { wait: id })).toBe(HEAVY_DIED_EXIT);
    } finally { delete process.env.T; }
  }, 20_000);

  it('the runner half: --run-id writes its state before the line and its exit at the end', async () => {
    const code = await builderHeavy(deps(), [process.execPath, '-e', 'process.exit(0)'], { runId: 'habc123de' });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(checksDir(repo), 'habc123de.json'), 'utf-8'))).toMatchObject({ state: 'done', exit: 0, pid: process.pid });
    expect(await builderHeavy(deps(), [], { wait: 'habc123de' })).toBe(0);
    expect(await builderHeavy(deps(), [], { wait: '../etc' })).toBe(2);
  });
});
