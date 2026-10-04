// The REAL worker wire (not the in-process seam): dcserver spawns `node <entry> cloud worker
// <op>` through spawnAsWorker (here the same-uid test seam), frames the header on stdin, reads
// the binary output from stdout and the JSON result from fd 3.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setSameUidWorkerForTests } from '../../src/server/cloud-mode.js';
import { WorkerOpError, runWorkerOp, setWorkerEntry, setWorkerInProcessForTests } from '../../src/server/cloud-worker.js';

let dir: string;
let savedCloud: string | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloud-worker-spawn-'));
  const entrySrc = join(dir, 'entry.ts');
  writeFileSync(entrySrc, `import { workerMain } from ${JSON.stringify(resolve('src/server/cloud-worker.ts'))};\nawait workerMain(process.argv[4]);\n`);
  await build({
    entryPoints: [entrySrc], outfile: join(dir, 'entry.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node18',
    external: ['node-pty', '@huggingface/transformers'], logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  });
  savedCloud = process.env.DREAMCONTEXT_CLOUD;
  process.env.DREAMCONTEXT_CLOUD = '1';
  setSameUidWorkerForTests(true);
  setWorkerInProcessForTests(false);
  setWorkerEntry(join(dir, 'entry.mjs'));
}, 120_000);

afterAll(() => {
  if (savedCloud === undefined) delete process.env.DREAMCONTEXT_CLOUD;
  else process.env.DREAMCONTEXT_CLOUD = savedCloud;
  setSameUidWorkerForTests(false);
  rmSync(dir, { recursive: true, force: true });
});

describe('cloud worker over the real wire', () => {
  it('returns the result on fd 3', async () => {
    const file = join(dir, 'home', '.marker.json');
    await runWorkerOp({ op: 'marker', params: { action: 'write', file, data: { tripId: 'trip-x', rootIds: [] } }, timeoutMs: 60_000 });
    expect(JSON.parse(readFileSync(file, 'utf-8')).tripId).toBe('trip-x');
    const r = await runWorkerOp<{ present: boolean; tripId: string }>({ op: 'marker', params: { action: 'check', file }, timeoutMs: 60_000 });
    expect(r).toEqual({ present: true, tripId: 'trip-x' });
  }, 60_000);

  it('streams binary output from stdout into the dcserver file', async () => {
    const root = join(dir, 'root');
    mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(root, '_dream_context', 'state', 'a.md'), 'hello\n');
    const out = join(dir, 'out.pack');
    const r = await runWorkerOp<{ manifest: Array<{ path: string }>; packCreated: boolean }>({
      op: 'snapshot-files',
      params: { gitConfigPath: '/dev/null', workDir: join(dir, 'work'), mirrorPrefix: null, root, rootKind: 'vault', atGo: [] },
      outputFile: out,
      timeoutMs: 60_000,
    });
    expect(r.packCreated).toBe(true);
    expect(r.manifest.map((e) => e.path)).toEqual(['_dream_context/state/a.md']);
    expect(statSync(out).size).toBeGreaterThan(20);
    expect(readFileSync(out).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  }, 60_000);

  it('a refused op comes back as a WorkerOpError with its code', async () => {
    await expect(runWorkerOp({ op: 'no-such-op', params: {}, timeoutMs: 60_000 })).rejects.toBeInstanceOf(WorkerOpError);
    await expect(runWorkerOp({ op: 'marker', params: { action: 'check', file: 'relative' }, timeoutMs: 60_000 }))
      .rejects.toMatchObject({ code: 'bad_request' });
  }, 60_000);

  it('pipes an input payload after the header (files-receive applies a pack)', async () => {
    const src = join(dir, 'src-root');
    mkdirSync(join(src, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(src, '_dream_context', 'state', 'b.md'), 'from the laptop\n');
    const pack = join(dir, 'in.pack');
    const made = await runWorkerOp<{ manifest: unknown[] }>({
      op: 'snapshot-files',
      params: { gitConfigPath: '/dev/null', workDir: join(dir, 'work'), mirrorPrefix: null, root: src, rootKind: 'vault', atGo: [] },
      outputFile: pack, timeoutMs: 60_000,
    });
    const dest = join(dir, 'dest-root');
    const r = await runWorkerOp<{ refused: unknown[]; digest: string }>({
      op: 'files-receive',
      params: { gitConfigPath: '/dev/null', workDir: join(dir, 'work'), mirrorPrefix: null, trip: 'trip-w', rootId: 'r-00000000000000aa', root: dest, rootKind: 'vault', expected: made.manifest, maxBytes: 1 << 20, hasPack: true },
      inputFile: pack, timeoutMs: 60_000,
    });
    expect(r.refused).toEqual([]);
    expect(readFileSync(join(dest, '_dream_context', 'state', 'b.md'), 'utf-8')).toBe('from the laptop\n');
  }, 60_000);

  it('reads a background shell\'s output as the worker (the path is keyed by the reader\'s uid)', async () => {
    const project = join(dir, 'bgproj');
    mkdirSync(join(project, '_dream_context'), { recursive: true });
    const { realpathSync } = await import('node:fs');
    const slug = realpathSync(project).replace(/\//g, '-');
    const uuid = '6f1c2e9a-4444-4a5b-8c9d-0123456789ab';
    const outDir = join('/tmp', `claude-${process.getuid!()}`, slug, uuid, 'tasks');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'b7x1.output'), 'dev server ready\n');
    try {
      const r = await runWorkerOp<{ content: string; exists: boolean }>({
        op: 'read', params: { kind: 'bg-output', contextRoot: join(project, '_dream_context'), query: { taskId: 'b7x1', claudeId: uuid } }, timeoutMs: 60_000,
      });
      expect(r.exists).toBe(true);
      expect(r.content).toBe('dev server ready\n');
    } finally {
      rmSync(join('/tmp', `claude-${process.getuid!()}`, slug), { recursive: true, force: true });
    }
  }, 60_000);

  it('cut-scope ends every own process whose cwd is inside a root, SIGKILL for one that ignores SIGTERM (D22)', async () => {
    const { spawn } = await import('node:child_process');
    const root = join(dir, 'scope-root');
    const outside = join(dir, 'scope-outside');
    mkdirSync(join(root, 'deep'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    // A tree in its own group (a backgrounded sleep included), a stubborn process in another
    // group, and one outside the roots that must survive.
    const tree = spawn('/bin/sh', ['-c', 'sleep 60 & sleep 60'], { cwd: root, detached: true, stdio: 'ignore' });
    const stubborn = spawn('/bin/sh', ['-c', 'trap "" TERM; while true; do sleep 1; done'], { cwd: join(root, 'deep'), detached: true, stdio: 'ignore' });
    const bystander = spawn('/bin/sh', ['-c', 'sleep 60'], { cwd: outside, detached: true, stdio: 'ignore' });
    const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      await new Promise((r) => setTimeout(r, 300));
      const r = await runWorkerOp<{ cut: number[] }>({ op: 'cut-scope', params: { roots: [root], graceMs: 1500 }, timeoutMs: 60_000 });
      expect(r.cut).toEqual(expect.arrayContaining([tree.pid, stubborn.pid]));
      expect(r.cut).not.toContain(bystander.pid);
      expect(isAlive(tree.pid!)).toBe(false);
      expect(isAlive(stubborn.pid!)).toBe(false);
      expect(isAlive(bystander.pid!)).toBe(true);
    } finally {
      for (const c of [tree, stubborn, bystander]) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }
    }
  }, 60_000);
});

