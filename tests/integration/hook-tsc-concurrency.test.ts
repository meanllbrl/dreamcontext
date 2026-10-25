/**
 * The PostToolUse type-check across PROCESSES, through the built CLI: agents editing one project
 * at the same moment never run two type-checks at once, and the agent whose edit broke a type
 * still hears about it (in its own PostToolUse or at its Stop, which blocks once).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

let root: string;
let proj: string;
let env: NodeJS.ProcessEnv;
const runsLog = () => join(root, 'tsc-runs.log');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-hook-tsc-'));
  proj = join(root, 'proj');
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(root, 'tmp'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(join(proj, 'tsconfig.json'), '{}');
  for (const f of ['a', 'b', 'c', 'd', 'broken']) writeFileSync(join(proj, 'src', `${f}.ts`), 'export const x = 1;\n');
  // A fake tsc: logs its start and end, takes 700 ms, reports an error in src/broken.ts.
  const tsc = join(proj, 'node_modules', '.bin', 'tsc');
  writeFileSync(tsc, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `const log = ${JSON.stringify(runsLog())};`,
    "const start = Date.now();",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);",
    "fs.appendFileSync(log, JSON.stringify({ start, end: Date.now() }) + '\\n');",
    "process.stdout.write(\"src/broken.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\\n\");",
    'process.exit(2);',
  ].join('\n'));
  chmodSync(tsc, 0o755);
  env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp') + '/', DREAMCONTEXT_VERSION_CHECK: '0' };
});

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function hook(event: string, input: unknown): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', event], { cwd: proj, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

const edit = (session: string, file: string) => hook('post-tool-use', {
  session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(proj, 'src', file) },
});

describe.skipIf(!existsSync(CLI))('post-tool-use type-checks, five agents at once', () => {
  it('never two tsc at once, and the agent that broke a type is told (now or at Stop)', async () => {
    const agents = [['s-a', 'a.ts'], ['s-b', 'b.ts'], ['s-c', 'c.ts'], ['s-d', 'd.ts'], ['s-broken', 'broken.ts']];
    const results = await Promise.all(agents.map(([s, f]) => edit(s, f)));
    expect(results.every((r) => r.code === 0)).toBe(true);

    const runs = readFileSync(runsLog(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { start: number; end: number });
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.length).toBeLessThanOrEqual(2); // five edits, coalesced
    const sorted = [...runs].sort((x, y) => x.start - y.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);

    // Nobody else is blamed for broken.ts.
    for (const r of results.slice(0, 4)) expect(r.stdout).not.toContain('broken.ts');

    const brokenNow = results[4].stdout.includes('TypeScript errors in broken.ts');
    const stop = await hook('stop', { session_id: 's-broken', hook_event_name: 'Stop', stop_hook_active: false });
    expect(stop.code).toBe(0);
    if (brokenNow) {
      expect(stop.stdout).toBe('');
    } else {
      const block = JSON.parse(stop.stdout);
      expect(block.decision).toBe('block');
      expect(block.reason).toContain("TypeScript errors in broken.ts:\nsrc/broken.ts(1,14): error TS2322");
    }
    // The continuation of a block never blocks again.
    const again = await hook('stop', { session_id: 's-broken', hook_event_name: 'Stop', stop_hook_active: true });
    expect(again.stdout).toBe('');
  }, 30_000);

  it('a Stop blocks with the errors a check found for this session after its last edit', async () => {
    // s-late edits broken.ts while another holder's check is running: its answer waits for Stop.
    const [first, second] = await Promise.all([edit('s-first', 'a.ts'), new Promise<{ code: number | null; stdout: string }>((r) => setTimeout(() => r(edit('s-late', 'broken.ts')), 150))]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const stop = await hook('stop', { session_id: 's-late', hook_event_name: 'Stop', stop_hook_active: false });
    const told = second.stdout.includes('TypeScript errors in broken.ts') || stop.stdout.includes('TypeScript errors in broken.ts');
    expect(told).toBe(true);
  }, 30_000);
});

describe.skipIf(!existsSync(CLI))('Stop writes the session ledger before it type-checks', () => {
  it('a Stop killed by its timeout during a check has already recorded the session', async () => {
    const r2 = mkdtempSync(join(tmpdir(), 'dc-hook-ledger-'));
    try {
      const p2 = join(r2, 'proj');
      const home = join(r2, 'home');
      const tmp = join(r2, 'tmp');
      for (const d of [join(p2, 'src'), join(p2, 'node_modules', '.bin'), home, tmp]) mkdirSync(d, { recursive: true });
      const env2 = { PATH: process.env.PATH, HOME: home, TMPDIR: tmp + '/', DREAMCONTEXT_VERSION_CHECK: '0' };
      execFileSync(process.execPath, [CLI, 'init', '--yes'], { cwd: p2, env: env2, stdio: 'ignore' });
      writeFileSync(join(p2, 'tsconfig.json'), '{}');
      writeFileSync(join(p2, 'src', 'a.ts'), 'export const a = 1;\n');
      // A check that takes 3 s, and says when it has started.
      const started = join(r2, 'tsc-started');
      const tsc = join(p2, 'node_modules', '.bin', 'tsc');
      writeFileSync(tsc, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(started)}, '');\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);\nprocess.exit(0);\n`);
      chmodSync(tsc, 0o755);

      // The edit pends: another live process holds the project's lock right now.
      const uid = typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
      const stateDir = join(tmp, `dreamcontext-tsc${uid}`, createHash('sha1').update(join(p2, 'tsconfig.json')).digest('hex').slice(0, 16));
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      const sid = '11111111-2222-4333-8444-555555555555';
      const run = (event: string, input: unknown, killDuringCheck = false) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        const child = spawn(process.execPath, [CLI, 'hook', event], { cwd: p2, env: env2, stdio: ['pipe', 'ignore', 'ignore'] });
        // Killed once the check is running, not after a fixed delay: on a loaded machine the
        // CLI alone can take longer than any delay short enough to land inside the check.
        const poll = killDuringCheck ? setInterval(() => { if (existsSync(started)) child.kill('SIGKILL'); }, 20) : undefined;
        child.on('close', (code, signal) => { clearInterval(poll); resolve({ code, signal }); });
        child.stdin.end(JSON.stringify(input));
      });
      await run('post-tool-use', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: join(p2, 'src', 'a.ts') } });
      rmSync(join(stateDir, 'lock'));

      // Stop now has a 3 s check to run; Claude Code kills it partway through.
      const stop = await run('stop', { session_id: sid, hook_event_name: 'Stop', stop_hook_active: false }, true);
      expect(stop.signal).toBe('SIGKILL');
      const state = JSON.parse(readFileSync(join(p2, '_dream_context', 'state', '.sleep.json'), 'utf-8')) as { sessions: Array<{ session_id: string }> };
      expect(state.sessions.map((x) => x.session_id)).toContain(sid);
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  }, 30_000);
});
