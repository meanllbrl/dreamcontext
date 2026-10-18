#!/usr/bin/env node
/**
 * What a Claude Code hook event costs the Mac: wall time, CPU-seconds and RSS, measured the way
 * Claude Code runs the hook, BEFORE and AFTER a change.
 *
 * Every event runs the EXACT command the build under test installs into `.claude/settings.json`
 * (`dreamcontext install-skill` writes it into a scratch project), through `sh -c`, with the
 * event's JSON on stdin, wrapped in `/usr/bin/time -l`. Nothing is called in-process: the cost
 * that heats the machine is the process chain (npx, node, the 6 MB bundle, tsc), not a function.
 *
 * Events (HOOK_COST_RUNS each, default 10): session-start, user-prompt-submit, pre-tool-use on
 * an unmatched file and on the protected marketing/.env, post-tool-use on a .ts file (a ~300-file
 * TS project with its own tsconfig and local tsc) and on a .md file, stop on 1 / 20 / 50 MB
 * transcripts (a turn appended before every run, as a live session grows), pre-compact.
 *
 * The '10 agents' scenario: 10 sessions edit 10 different .ts files of the same project and fire
 * post-tool-use at the same instant, then all 10 fire stop. A `ps` sample every 100 ms counts the
 * tsc processes alive at once and the `dreamcontext hook` processes (count, summed RSS, lifetime);
 * a second sample after everything exited lists anything a hook left behind. One agent's edit is a
 * type error: the scenario also proves that agent is still told about it.
 *
 * Usage:
 *   DC_VERIFY_PHASE=before DC_VERIFY_DIST=tmp/hook-cost-dist/before/index.js node scripts/verify/hook-cost.mjs
 *   node scripts/verify/hook-cost.mjs            # PHASE=after, dist/index.js; thresholds enforced
 *
 * Env:
 *   DC_VERIFY_PHASE / DC_VERIFY_DIST   which build, where the numbers go (scripts/verify/lib/measure.mjs)
 *   HOOK_COST_BRAIN   a `_dream_context` to freeze as the fixture brain (copied ONCE, minus tmp/ and
 *                     marketing/; both phases read the same frozen copy). Unset: a generated brain.
 *   HOOK_COST_MODELS  the embedding models dir linked into the scratch HOME (default ~/.dreamcontext/models)
 *                     so a hybrid vault recalls the way it does on this machine.
 *   HOOK_COST_RUNS    runs per event (default 10).
 *   HOOK_COST_ENFORCE_ONLY=1  re-judge the recorded after/numbers.json against before/ (no measuring).
 *
 * Output: tmp/verify-hook-cost/<phase>/numbers.json, plus the SessionStart and recall stdout of a
 * pristine fixture (session-start.out.txt, user-prompt-submit.out.txt) for the before/after diff.
 * PHASE=after reads before/numbers.json and exits 1 when a threshold fails.
 */
import { spawn, execFileSync, execFile } from 'node:child_process';
import {
  appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { cpus, homedir, loadavg, totalmem, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { PHASE, distIndex, shotsDir, scratchDir } from './lib/measure.mjs';

const execFileP = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = distIndex(REPO);
const OUT = shotsDir(REPO, 'hook-cost');
const SCRATCH = scratchDir('dc-hook-cost');
const FIXTURES = join(tmpdir(), 'dc-hook-cost-fixtures');
const RUNS = Number(process.env.HOOK_COST_RUNS || 10);
const MB = 1_000_000;
const STOP_SIZES = [1, 20, 50];
const AGENTS = 10;
const AGENT_TRANSCRIPT_MB = 20;
const TS_FILES = 300;

const log = (...a) => console.log('[hook-cost]', ...a);

// ─── Fixtures (shared by both phases, generated once) ──────────────────────────

/** Deterministic PRNG so BEFORE and AFTER read byte-identical fixtures. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ('the hook spawns npx for every event and the agent waits while tsc checks the whole project '
  + 'decided instead of reading transcript stop session recall memory knowledge task feature wave '
  + 'measure cost process memory resident cpu seconds lock pending marker incremental offset').split(' ');

function prose(rand, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  return out.join(' ');
}

/**
 * One turn of a Claude Code transcript: a typed user message, assistant records (one per content
 * block, `message.usage` repeated on each, as Claude Code writes them), tool results carrying file
 * text. Returns JSONL lines.
 */
function transcriptTurn(rand, sessionId, turn, startMs) {
  const lines = [];
  const at = (k) => new Date(startMs + turn * 60_000 + k * 1000).toISOString();
  const uuid = (k) => `${sessionId.slice(0, 8)}-${turn}-${k}`;
  lines.push(JSON.stringify({
    type: 'user', uuid: uuid(0), timestamp: at(0), sessionId,
    message: { role: 'user', content: `please ${prose(rand, 12)} instead of ${prose(rand, 6)}` },
  }));
  const tools = 1 + Math.floor(rand() * 4);
  for (let t = 0; t < tools; t++) {
    const msgId = `msg_${sessionId.slice(0, 6)}_${turn}_${t}`;
    const usage = { input_tokens: 4 + t, cache_creation_input_tokens: 800 + Math.floor(rand() * 4000), cache_read_input_tokens: 90000, output_tokens: 200 + Math.floor(rand() * 900) };
    lines.push(JSON.stringify({
      type: 'assistant', uuid: uuid(1 + t * 3), timestamp: at(1 + t * 3), sessionId,
      message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: prose(rand, 40 + Math.floor(rand() * 80)) }], usage },
    }));
    const pick = rand();
    const input = pick < 0.35
      ? { file_path: `/repo/src/lib/mod${Math.floor(rand() * 300)}.ts`, old_string: prose(rand, 8), new_string: prose(rand, 10) }
      : pick < 0.5
        ? { command: `dreamcontext tasks log fixture-task-${Math.floor(rand() * 5)} "${prose(rand, 6)}"` }
        : { command: `grep -rn ${WORDS[Math.floor(rand() * WORDS.length)]} src | head` };
    const name = pick < 0.35 ? 'Edit' : 'Bash';
    const toolId = `toolu_${sessionId.slice(0, 6)}_${turn}_${t}`;
    lines.push(JSON.stringify({
      type: 'assistant', uuid: uuid(2 + t * 3), timestamp: at(2 + t * 3), sessionId,
      message: { id: msgId, role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }], usage },
    }));
    // A tool result: the bulk of a real transcript is file text and command output.
    const body = Array.from({ length: 20 + Math.floor(rand() * 160) }, (_, i) => `${i + 1}\t${prose(rand, 9)}`).join('\n');
    lines.push(JSON.stringify({
      type: 'user', uuid: uuid(3 + t * 3), timestamp: at(3 + t * 3), sessionId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: body }] },
      toolUseResult: { stdout: body.slice(0, 2000) },
    }));
  }
  return lines;
}

/** Write a transcript of ~`bytes` (never above it), returning the next turn index. */
function writeTranscript(path, sessionId, bytes, seed) {
  const rand = rng(seed);
  const startMs = Date.parse('2026-10-18T15:00:00.000Z');
  const fd = openSync(path, 'w');
  let size = 0;
  let turn = 0;
  try {
    for (;;) {
      const chunk = transcriptTurn(rand, sessionId, turn, startMs).join('\n') + '\n';
      const len = Buffer.byteLength(chunk);
      if (size + len > bytes) break;
      writeSync(fd, chunk);
      size += len;
      turn++;
    }
  } finally {
    closeSync(fd);
  }
  return turn;
}

/** A turn appended to a live transcript (what grows between two Stops). */
function appendTurn(path, sessionId, turn) {
  const rand = rng(9000 + turn);
  appendFileSync(path, transcriptTurn(rand, sessionId, turn, Date.parse('2026-10-18T15:00:00.000Z')).join('\n') + '\n');
}

/** A ~300-file TS project: each module imports three others, so a check walks a real graph. */
function writeTsProject(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true,
      noEmit: true, skipLibCheck: true, lib: ['es2022'], types: [],
    },
    include: ['src'],
  }, null, 2));
  const name = (i) => `mod${String(i).padStart(3, '0')}`;
  for (let i = 0; i < TS_FILES; i++) {
    const deps = [i - 1, i - 7, i - 31].filter((d) => d >= 0);
    const src = [
      ...deps.map((d) => `import { ${name(d)}Make, type ${name(d)}Shape } from './${name(d)}';`),
      '',
      `export interface ${name(i)}Shape {`,
      ...Array.from({ length: 12 }, (_, f) => `  field${f}: ${['string', 'number', 'boolean', 'string[]'][f % 4]};`),
      ...deps.map((d) => `  dep${d}?: ${name(d)}Shape;`),
      '}',
      '',
      `export type ${name(i)}Keys = keyof ${name(i)}Shape;`,
      `export type ${name(i)}Partial = { [K in ${name(i)}Keys]?: ${name(i)}Shape[K] };`,
      '',
      `export function ${name(i)}Make(seed: number): ${name(i)}Shape {`,
      '  return {',
      ...Array.from({ length: 12 }, (_, f) => `    field${f}: ${['String(seed)', 'seed + ' + f, 'seed % 2 === 0', '[String(seed)]'][f % 4]},`),
      ...deps.map((d) => `    dep${d}: seed > 3 ? undefined : ${name(d)}Make(seed + 1),`),
      '  };',
      '}',
      '',
      `export class ${name(i)}Store<T extends ${name(i)}Partial = ${name(i)}Partial> {`,
      '  private readonly items = new Map<string, T>();',
      '  put(key: string, value: T): this { this.items.set(key, value); return this; }',
      '  get(key: string): T | undefined { return this.items.get(key); }',
      `  pick<K extends keyof T>(key: string, field: K): T[K] | undefined { return this.items.get(key)?.[field]; }`,
      '  map<U>(fn: (v: T, k: string) => U): U[] { return [...this.items].map(([k, v]) => fn(v, k)); }',
      '}',
      '',
      `export function ${name(i)}Total(xs: readonly ${name(i)}Shape[]): number {`,
      '  return xs.reduce((sum, x) => sum + x.field1 + x.field5 + x.field9 + (x.field2 ? 1 : 0), 0);',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'src', `${name(i)}.ts`), src);
  }
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
}

/** A brain without HOOK_COST_BRAIN: `init` plus a corpus big enough for recall to do work. */
function generateBrain(projectDir) {
  mkdirSync(projectDir, { recursive: true });
  execFileSync(process.execPath, [DIST, 'init', '--yes'], { cwd: projectDir, stdio: 'ignore', env: hookEnvBase(join(projectDir, '.home')) });
  const rand = rng(7);
  const kdir = join(projectDir, '_dream_context', 'knowledge');
  mkdirSync(kdir, { recursive: true });
  for (let i = 0; i < 120; i++) {
    writeFileSync(join(kdir, `topic-${i}.md`), `---\nname: Topic ${i}\ndescription: ${prose(rand, 10)}\ntags: []\n---\n\n${prose(rand, 400)}\n`);
  }
}

function ensureFixtures() {
  mkdirSync(FIXTURES, { recursive: true });
  const brain = join(FIXTURES, 'brain', '_dream_context');
  if (!existsSync(brain)) {
    if (process.env.HOOK_COST_BRAIN) {
      log(`freezing fixture brain from ${process.env.HOOK_COST_BRAIN}`);
      mkdirSync(dirname(brain), { recursive: true });
      execFileSync('rsync', ['-a', '--exclude', '/tmp/', '--exclude', '/marketing/', '--exclude', '.DS_Store',
        `${process.env.HOOK_COST_BRAIN.replace(/\/$/, '')}/`, `${brain}/`]);
    } else {
      log('generating a fixture brain (set HOOK_COST_BRAIN to freeze a real one)');
      generateBrain(join(FIXTURES, 'brain'));
    }
  }
  for (const mb of [...STOP_SIZES, AGENT_TRANSCRIPT_MB]) {
    const p = join(FIXTURES, `transcript-${mb}mb.jsonl`);
    if (!existsSync(p)) {
      log(`generating ${mb} MB transcript`);
      writeTranscript(p, 'fixture0-0000-4000-8000-000000000000', mb * MB, mb);
    }
  }
  const ts = join(FIXTURES, 'tsproj');
  if (!existsSync(join(ts, 'tsconfig.json'))) {
    log(`generating a ${TS_FILES}-file TS project`);
    writeTsProject(ts);
  }
  return { brain, ts };
}

// ─── Scratch project + the build's own install ────────────────────────────────

function hookEnvBase(home) {
  const nodeBin = dirname(process.execPath);
  return {
    HOME: home,
    USER: process.env.USER || 'fixture',
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/sh',
    PATH: [join(SCRATCH, 'prefix', 'bin'), nodeBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    TMPDIR: join(SCRATCH, 'tmp') + '/',
    // npx resolves `dreamcontext` from this prefix: the build under test, "installed globally".
    npm_config_prefix: join(SCRATCH, 'prefix'),
    npm_config_cache: join(homedir(), '.npm'),
    npm_config_update_notifier: 'false',
    // No network, no dashboard launch, no background upgrade: the cost of the hook alone.
    DREAMCONTEXT_VERSION_CHECK: '0',
    DREAMCONTEXT_AUTO_UPGRADE: '0',
    DREAMCONTEXT_AUTO_DASHBOARD: '0',
    // Never the Haiku path (a paid `claude -p` per prompt): the vault's own hybrid/raw mode.
    DREAMCONTEXT_RECALL_MODE: 'hybrid',
    // The ancestry walk stops here, as it stops at the dashboard server in the app.
    DREAMCONTEXT_SERVER_PID: String(process.pid),
    // "No dashboard running": a port nothing listens on, never this machine's real app on 4173.
    // The server-up event points it at the scratch server instead.
    DREAMCONTEXT_DASHBOARD_PORT: '1',
  };
}

function setupScratch(fx) {
  rmSync(SCRATCH, { recursive: true, force: true });
  const home = join(SCRATCH, 'home');
  const proj = join(SCRATCH, 'proj');
  for (const d of [home, proj, join(SCRATCH, 'tmp'), join(SCRATCH, 'transcripts'), join(SCRATCH, 'prefix', 'bin'), join(SCRATCH, 'prefix', 'lib', 'node_modules', 'dreamcontext')]) {
    mkdirSync(d, { recursive: true });
  }
  // The build under test as a global install: npx (BEFORE's command) and PATH (AFTER's) both find it.
  const pkgDir = join(SCRATCH, 'prefix', 'lib', 'node_modules', 'dreamcontext');
  cpSync(join(REPO, 'package.json'), join(pkgDir, 'package.json'));
  symlinkSync(dirname(DIST), join(pkgDir, 'dist'));
  symlinkSync(join('..', 'lib', 'node_modules', 'dreamcontext', 'dist', basename(DIST)), join(SCRATCH, 'prefix', 'bin', 'dreamcontext'));
  const models = process.env.HOOK_COST_MODELS || join(homedir(), '.dreamcontext', 'models');
  if (existsSync(models)) {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    symlinkSync(models, join(home, '.dreamcontext', 'models'));
  }
  execFileSync('rsync', ['-a', `${fx.brain}/`, `${join(proj, '_dream_context')}/`]);
  execFileSync('rsync', ['-a', `${fx.ts}/`, `${join(proj, 'tsproj')}/`]);
  mkdirSync(join(proj, 'tsproj', 'node_modules', '.bin'), { recursive: true });
  symlinkSync(join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), join(proj, 'tsproj', 'node_modules', '.bin', 'tsc'));
  writeFileSync(join(proj, 'README.md'), '# scratch project\n');
  const env = { ...hookEnvBase(home), CLAUDE_PROJECT_DIR: proj };
  execFileSync(process.execPath, [DIST, 'install-skill', '--platforms', 'claude'], { cwd: proj, env, stdio: 'ignore' });
  const settings = JSON.parse(readFileSync(join(proj, '.claude', 'settings.json'), 'utf-8'));
  return { home, proj, env, settings };
}

/** The installed command for an event (the first handler whose matcher accepts `probe`). */
function installedCommand(settings, event, probe = '') {
  for (const group of settings.hooks?.[event] ?? []) {
    const m = group.matcher;
    if (m && probe && !new RegExp(`^(?:${m})$`).test(probe)) continue;
    for (const h of group.hooks ?? []) {
      if (typeof h.command === 'string' && /dreamcontext hook (session-start|stop|pre-tool-use|user-prompt-submit|post-tool-use|pre-compact)\b/.test(h.command)) {
        if (event === 'SessionStart' && !/session-start/.test(h.command)) continue;
        return h.command;
      }
    }
  }
  throw new Error(`no installed ${event} command for ${probe || '(any)'}`);
}

// ─── Running one hook the way Claude Code does ────────────────────────────────

let timeSeq = 0;
/** sh -c '<command>' with the event JSON on stdin, under /usr/bin/time -l. */
function runHook(ctx, command, input) {
  const tfile = join(SCRATCH, 'tmp', `time-${process.pid}-${timeSeq++}.txt`);
  return new Promise((resolveRun) => {
    const started = performance.now();
    const child = spawn('/usr/bin/time', ['-l', '-o', tfile, 'sh', '-c', command], { cwd: ctx.proj, env: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end(JSON.stringify(input));
    child.on('close', (code) => {
      const wallMs = performance.now() - started;
      let cpuSec = NaN;
      let rssMB = NaN;
      try {
        const t = readFileSync(tfile, 'utf-8');
        const m = t.match(/([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/);
        if (m) cpuSec = Number(m[2]) + Number(m[3]);
        const r = t.match(/(\d+)\s+maximum resident set size/);
        if (r) rssMB = Number(r[1]) / (1024 * 1024);
        rmSync(tfile, { force: true });
      } catch { /* time output missing: the numbers stay NaN and the report shows it */ }
      resolveRun({ code, stdout, stderr, wallMs, cpuSec, rssMB });
    });
  });
}

const pct = (xs, p) => {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;

function summarize(runs) {
  return {
    n: runs.length,
    wallMs: { p50: r1(pct(runs.map((r) => r.wallMs), 50)), p95: r1(pct(runs.map((r) => r.wallMs), 95)) },
    cpuSec: { p50: r3(pct(runs.map((r) => r.cpuSec), 50)), p95: r3(pct(runs.map((r) => r.cpuSec), 95)) },
    maxRssMB: { p50: r1(pct(runs.map((r) => r.rssMB), 50)), max: r1(Math.max(...runs.map((r) => r.rssMB).filter(Number.isFinite))) },
    exitCodes: [...new Set(runs.map((r) => r.code))],
    firstRunWallMs: r1(runs[0]?.wallMs ?? NaN),
  };
}

async function measure(label, n, prepare, makeRun) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    if (prepare) prepare(i);
    runs.push(await makeRun(i));
  }
  const s = summarize(runs);
  log(`${label.padEnd(26)} p50 ${String(s.wallMs.p50).padStart(7)} ms  p95 ${String(s.wallMs.p95).padStart(7)} ms  cpu p50 ${String(s.cpuSec.p50).padStart(6)} s  rss p50 ${String(s.maxRssMB.p50).padStart(6)} MB  exit ${s.exitCodes.join(',')}`);
  return { summary: s, runs };
}

// ─── Process sampling (the '10 agents' scenario) ──────────────────────────────

const HOOK_RE = /dreamcontext hook (stop|post-tool-use|session-start|pre-tool-use|user-prompt-submit|pre-compact)\b/;
const TSC_RE = /(?:typescript\/bin\/tsc|\/\.bin\/tsc|\btsc\.js|_tsc\.js)\b/;

/** Ours = a descendant of this harness, or anything naming the scratch dir (a detached child). */
function ours(table, pid) {
  for (let p = pid, hops = 0; p > 1 && hops < 30; hops++) {
    if (p === process.pid) return true;
    const row = table.get(p);
    if (!row) return false;
    p = row.ppid;
  }
  return false;
}

async function psTable() {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,rss=,command='], { maxBuffer: 16 * 1024 * 1024 });
  const table = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), rssKB: Number(m[3]), command: m[4] });
  }
  return table;
}

function startSampler() {
  const stats = { samples: 0, maxTsc: 0, peakHookProcs: 0, peakHookRssMB: 0, peakNodeHookProcs: 0, lifetimes: new Map() };
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const t0 = performance.now();
      try {
        const table = await psTable();
        let tsc = 0;
        let hooks = 0;
        let nodeHooks = 0;
        let rss = 0;
        for (const [pid, row] of table) {
          if (pid === process.pid) continue;
          const mine = ours(table, pid) || row.command.includes(SCRATCH);
          if (!mine) continue;
          if (TSC_RE.test(row.command)) tsc++;
          // The /usr/bin/time wrapper is this harness's apparatus, not part of Claude Code's chain.
          if (HOOK_RE.test(row.command) && !row.command.startsWith('/usr/bin/time')) {
            hooks++;
            rss += row.rssKB / 1024;
            if (!/^(\/bin\/)?sh\b/.test(row.command)) nodeHooks++;
            const seen = stats.lifetimes.get(pid);
            const now = performance.now();
            if (seen) seen.last = now;
            else stats.lifetimes.set(pid, { first: now, last: now, command: row.command.slice(0, 160) });
          }
        }
        stats.samples++;
        stats.maxTsc = Math.max(stats.maxTsc, tsc);
        stats.peakHookProcs = Math.max(stats.peakHookProcs, hooks);
        stats.peakNodeHookProcs = Math.max(stats.peakNodeHookProcs, nodeHooks);
        stats.peakHookRssMB = Math.max(stats.peakHookRssMB, rss);
      } catch { /* one missed sample */ }
      const wait = 100 - (performance.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      let longest = 0;
      let longestCmd = '';
      for (const v of stats.lifetimes.values()) {
        if (v.last - v.first > longest) { longest = v.last - v.first; longestCmd = v.command; }
      }
      return {
        samples: stats.samples,
        maxConcurrentTsc: stats.maxTsc,
        peakHookProcs: stats.peakHookProcs,
        peakNodeHookProcs: stats.peakNodeHookProcs,
        peakHookRssMB: r1(stats.peakHookRssMB),
        longestHookMs: Math.round(longest),
        longestHookCommand: longestCmd,
      };
    },
  };
}

/** Anything of ours still alive once every hook returned (a hook must not outlive its work). */
async function leftovers() {
  await new Promise((r) => setTimeout(r, 750));
  const table = await psTable();
  const left = [];
  for (const [pid, row] of table) {
    if (pid === process.pid) continue;
    if (row.command.startsWith('ps ')) continue;
    if (ours(table, pid) || row.command.includes(SCRATCH)) left.push(`${pid} ${row.command.slice(0, 160)}`);
  }
  return left;
}

// ─── A running dashboard server (the warm-embedder recall path) ───────────────

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function cpuSecondsOf(pid) {
  try {
    const { stdout } = await execFileP('ps', ['-o', 'time=', '-p', String(pid)]);
    const parts = stdout.trim().split(':').map(Number);
    return parts.reduce((acc, x) => acc * 60 + x, 0);
  } catch {
    return NaN;
  }
}

/**
 * The build's own dashboard server on a free port, the scratch project registered as a vault the
 * way the app registers it, warmed by one recall so its embedder is loaded (a running app is).
 */
async function startDashboard(ctx) {
  const port = await freePort();
  mkdirSync(join(ctx.home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(ctx.home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'hookcost', path: ctx.proj }] }, null, 2));
  const child = spawn(process.execPath, [DIST, 'dashboard', '--port', String(port), '--no-open', '--vault', 'hookcost'], {
    cwd: ctx.proj, env: ctx.env, stdio: ['ignore', 'ignore', 'pipe'], detached: false,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Warm: the first hybrid query loads the embedder; a running app has done this long ago.
  try { await fetch(`${base}/api/recall?q=${encodeURIComponent('warm the embedder')}&top=5`); } catch { /* best-effort */ }
  return {
    port,
    pid: child.pid,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); });
      rmSync(join(ctx.home, '.dreamcontext', 'vaults.json'), { force: true });
      return stderr;
    },
  };
}

// ─── The scenario ─────────────────────────────────────────────────────────────

function sessionId(prefix, i) {
  return `${prefix}${String(i).padStart(4, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

function tsFile(ctx, i) {
  return join(ctx.proj, 'tsproj', 'src', `mod${String(i).padStart(3, '0')}.ts`);
}

/** Edit a TS file the way an agent does: rewrite it on disk, then the hook fires. */
function touchTs(ctx, i, marker, broken = false) {
  const p = tsFile(ctx, i);
  const src = readFileSync(p, 'utf-8').replace(/\nexport const touched[^\n]*\n/g, '\n');
  writeFileSync(p, `${src}\nexport const touched${marker}: number = ${broken ? '"not a number"' : marker.length};\n`);
}

function untouchTs(ctx, i) {
  const p = tsFile(ctx, i);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/\nexport const touched[^\n]*\n/g, '\n'));
}

async function tenAgents(ctx, commands) {
  const ids = Array.from({ length: AGENTS }, (_, i) => sessionId('agent', i));
  const transcripts = ids.map((id) => join(SCRATCH, 'transcripts', `${id}.jsonl`));
  for (const t of transcripts) cpSync(join(FIXTURES, `transcript-${AGENT_TRANSCRIPT_MB}mb.jsonl`), t);
  // Steady state: every agent has finished a turn before (one Stop each, unmeasured), so a cache
  // a Stop keeps is as warm as it is in a session that has been running.
  for (let i = 0; i < AGENTS; i++) {
    await runHook(ctx, commands.stop, { session_id: ids[i], transcript_path: transcripts[i], cwd: ctx.proj, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'warm-up turn done' });
  }
  // The files the agents edit (the first one breaks a type), written before the hooks fire.
  const edited = ids.map((_, i) => 40 + i * 13);
  edited.forEach((f, i) => touchTs(ctx, f, `Agent${i}`, i === 0));

  const sampler = startSampler();
  const t0 = performance.now();
  const editRuns = await Promise.all(ids.map((id, i) => runHook(ctx, commands.postToolUse, {
    session_id: id, transcript_path: transcripts[i], cwd: ctx.proj, hook_event_name: 'PostToolUse',
    tool_name: 'Edit', tool_input: { file_path: tsFile(ctx, edited[i]), old_string: 'a', new_string: 'b' }, tool_response: { success: true },
  })));
  const editWallMs = performance.now() - t0;
  transcripts.forEach((t, i) => appendTurn(t, ids[i], 100000 + i));
  const t1 = performance.now();
  const stopRuns = await Promise.all(ids.map((id, i) => runHook(ctx, commands.stop, {
    session_id: id, transcript_path: transcripts[i], cwd: ctx.proj, hook_event_name: 'Stop',
    stop_hook_active: false, last_assistant_message: 'done with the edit',
  })));
  const stopWallMs = performance.now() - t1;
  const proc = await sampler.stop();
  const left = await leftovers();
  edited.forEach((f) => untouchTs(ctx, f));

  const cpu = (runs) => r3(runs.reduce((s, r) => s + (Number.isFinite(r.cpuSec) ? r.cpuSec : 0), 0));
  const errorRe = /TypeScript errors in mod040\.ts|mod040\.ts\(\d+,\d+\): error TS2322/;
  const typeErrorSeen = errorRe.test(editRuns[0].stdout) || errorRe.test(stopRuns[0].stdout);
  const otherAgentsBlamed = [...editRuns.slice(1), ...stopRuns.slice(1)].some((r) => /mod040\.ts/.test(r.stdout));
  const result = {
    agents: AGENTS,
    editWallMs: Math.round(editWallMs),
    stopWallMs: Math.round(stopWallMs),
    editCpuSec: cpu(editRuns),
    stopCpuSec: cpu(stopRuns),
    totalCpuSec: r3(cpu(editRuns) + cpu(stopRuns)),
    ...proc,
    leftovers: left,
    typeErrorSeen,
    otherAgentsBlamed,
    exitCodes: [...new Set([...editRuns, ...stopRuns].map((r) => r.code))],
  };
  log(`10 agents: edit ${result.editWallMs} ms / ${result.editCpuSec} cpu-s, stop ${result.stopWallMs} ms / ${result.stopCpuSec} cpu-s, total ${result.totalCpuSec} cpu-s`);
  log(`10 agents: tsc at once ${result.maxConcurrentTsc}, hook procs peak ${result.peakHookProcs} (node ${result.peakNodeHookProcs}), hook RSS peak ${result.peakHookRssMB} MB, longest hook ${result.longestHookMs} ms, leftovers ${left.length}, type error seen ${typeErrorSeen}`);
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Re-judge numbers already recorded (a threshold or mask changed) without measuring again.
  if (process.env.HOOK_COST_ENFORCE_ONLY === '1') {
    return enforce(JSON.parse(readFileSync(join(OUT, 'numbers.json'), 'utf-8')));
  }
  if (!existsSync(DIST)) throw new Error(`no build at ${DIST} (npm run build:cli, or set DC_VERIFY_DIST)`);
  mkdirSync(OUT, { recursive: true });
  const fx = ensureFixtures();
  const ctx = setupScratch(fx);
  const commands = {
    sessionStart: installedCommand(ctx.settings, 'SessionStart', 'startup'),
    userPromptSubmit: installedCommand(ctx.settings, 'UserPromptSubmit'),
    preToolUseEdit: installedCommand(ctx.settings, 'PreToolUse', 'Edit'),
    postToolUse: installedCommand(ctx.settings, 'PostToolUse', 'Edit'),
    stop: installedCommand(ctx.settings, 'Stop'),
    preCompact: installedCommand(ctx.settings, 'PreCompact'),
  };
  log(`phase ${PHASE}, dist ${DIST}`);
  log(`installed Stop command: ${commands.stop}`);
  const load = loadavg().map(r1);
  log(`load average ${load.join(' ')}`);

  const events = {};
  const outputs = {};
  const sid = (name) => sessionId(name.slice(0, 8).padEnd(8, 'x'), 1);
  const transcriptOf = (mb, id) => {
    const p = join(SCRATCH, 'transcripts', `${id}.jsonl`);
    if (!existsSync(p)) cpSync(join(FIXTURES, `transcript-${mb}mb.jsonl`), p);
    return p;
  };

  // SessionStart: the FIRST run on the pristine fixture is the snapshot the diff compares.
  {
    const id = sid('sessstrt');
    const tp = transcriptOf(1, id);
    const m = await measure('session-start', RUNS, null, () => runHook(ctx, commands.sessionStart, { session_id: id, transcript_path: tp, cwd: ctx.proj, hook_event_name: 'SessionStart', source: 'startup' }));
    events['session-start'] = m.summary;
    outputs.sessionStart = m.runs[0].stdout;
  }
  {
    const id = sid('prompt00');
    const tp = transcriptOf(1, id);
    const prompt = 'the agent hooks are heating the mac: measure the npx spawn per hook event and the tsc check per edit, then cut them';
    const m = await measure('user-prompt-submit', RUNS, null, () => runHook(ctx, commands.userPromptSubmit, { session_id: id, transcript_path: tp, cwd: ctx.proj, hook_event_name: 'UserPromptSubmit', prompt }));
    events['user-prompt-submit'] = m.summary;
    outputs.userPromptSubmit = m.runs[0].stdout;
  }
  {
    // The same prompt with the app's dashboard server running (its embedder warm).
    const id = sid('prompt01');
    const tp = transcriptOf(1, id);
    const prompt = 'the agent hooks are heating the mac: measure the npx spawn per hook event and the tsc check per edit, then cut them';
    const server = await startDashboard(ctx);
    const env = { ...ctx.env, DREAMCONTEXT_DASHBOARD_PORT: String(server.port) };
    const cpu0 = await cpuSecondsOf(server.pid);
    const m = await measure('user-prompt-submit +srv', RUNS, null, () => runHook({ ...ctx, env }, commands.userPromptSubmit, { session_id: id, transcript_path: tp, cwd: ctx.proj, hook_event_name: 'UserPromptSubmit', prompt }));
    const serverCpuSec = r3((await cpuSecondsOf(server.pid)) - cpu0);
    await server.stop();
    events['user-prompt-submit-server'] = { ...m.summary, serverCpuSec, serverCpuSecPerRun: r3(serverCpuSec / RUNS) };
    outputs.userPromptSubmitServer = m.runs[0].stdout;
    log(`  dashboard server CPU during those runs: ${serverCpuSec} s`);
  }
  {
    const id = sid('pretool0');
    const m = await measure('pre-tool-use unmatched', RUNS, null, () => runHook(ctx, commands.preToolUseEdit, { session_id: id, cwd: ctx.proj, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(ctx.proj, 'README.md') } }));
    events['pre-tool-use-unmatched'] = m.summary;
    outputs.preToolUseUnmatched = m.runs[0].stdout;
  }
  {
    const id = sid('pretool1');
    const m = await measure('pre-tool-use protected', RUNS, null, () => runHook(ctx, commands.preToolUseEdit, { session_id: id, cwd: ctx.proj, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(ctx.proj, '_dream_context', 'marketing', '.env'), content: 'X=1' } }));
    events['pre-tool-use-protected'] = m.summary;
    outputs.preToolUseProtected = m.runs[0].stdout;
  }
  {
    const id = sid('posttsxx');
    const tp = transcriptOf(1, id);
    const m = await measure('post-tool-use .ts', RUNS, (i) => touchTs(ctx, 10 + i, `Single${i}`), (i) => runHook(ctx, commands.postToolUse, { session_id: id, transcript_path: tp, cwd: ctx.proj, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: tsFile(ctx, 10 + i) }, tool_response: { success: true } }));
    for (let i = 0; i < RUNS; i++) untouchTs(ctx, 10 + i);
    events['post-tool-use-ts'] = m.summary;
  }
  {
    const id = sid('postmdxx');
    const tp = transcriptOf(1, id);
    const m = await measure('post-tool-use .md', RUNS, null, () => runHook(ctx, commands.postToolUse, { session_id: id, transcript_path: tp, cwd: ctx.proj, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(ctx.proj, 'README.md') }, tool_response: { success: true } }));
    events['post-tool-use-md'] = m.summary;
  }
  for (const mb of STOP_SIZES) {
    const id = sessionId(`stop${String(mb).padStart(4, '0')}`, mb);
    const tp = transcriptOf(mb, id);
    const m = await measure(`stop ${mb} MB`, RUNS, (i) => { if (i > 0) appendTurn(tp, id, 50000 + i); }, () => runHook(ctx, commands.stop, { session_id: id, transcript_path: tp, cwd: ctx.proj, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'turn finished' }));
    events[`stop-${mb}mb`] = { ...m.summary, transcriptBytes: statSync(tp).size };
  }
  {
    const id = sid('compact0');
    const tp = transcriptOf(1, id);
    const m = await measure('pre-compact', RUNS, null, () => runHook(ctx, commands.preCompact, { session_id: id, transcript_path: tp, cwd: ctx.proj, hook_event_name: 'PreCompact', trigger: 'auto' }));
    events['pre-compact'] = m.summary;
  }

  const ten = await tenAgents(ctx, commands);

  const numbers = {
    phase: PHASE,
    dist: DIST,
    measuredAt: new Date().toISOString(),
    machine: { cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30), loadavg: load },
    runsPerEvent: RUNS,
    commands,
    events,
    tenAgents: ten,
  };
  writeFileSync(join(OUT, 'numbers.json'), JSON.stringify(numbers, null, 2) + '\n');
  writeFileSync(join(OUT, 'session-start.out.txt'), outputs.sessionStart);
  writeFileSync(join(OUT, 'user-prompt-submit.out.txt'), outputs.userPromptSubmit);
  writeFileSync(join(OUT, 'user-prompt-submit-server.out.txt'), outputs.userPromptSubmitServer);
  writeFileSync(join(OUT, 'pre-tool-use-protected.out.txt'), outputs.preToolUseProtected);
  writeFileSync(join(OUT, 'pre-tool-use-unmatched.out.txt'), outputs.preToolUseUnmatched);
  log(`wrote ${join(OUT, 'numbers.json')}`);

  if (PHASE !== 'after') return 0;
  return enforce(numbers);
}

/** PHASE=after only: every threshold of the task, against before/numbers.json. */
function enforce(after) {
  const beforeDir = join(dirname(OUT), 'before');
  const before = JSON.parse(readFileSync(join(beforeDir, 'numbers.json'), 'utf-8'));
  const read = (dir, f) => readFileSync(join(dir, f), 'utf-8');
  // BEFORE and AFTER run minutes apart: a countdown ("another 1h 39m") or an age ("1993h old")
  // moves with the clock and is not content. Only those tokens are masked; every other byte counts.
  const timeless = (text) => text
    .replace(/\b\d+[hm] old\b/g, '<age> old')
    .replace(/\b\d+h(?: \d+m)?\b|\b\d+m\b/g, '<duration>');
  const same = (f) => timeless(read(OUT, f)) === timeless(read(beforeDir, f));
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const b = before.events;
  const a = after.events;

  check('AC2 pre-tool-use unmatched p50 < 1/2 BEFORE', a['pre-tool-use-unmatched'].wallMs.p50 < b['pre-tool-use-unmatched'].wallMs.p50 / 2,
    `${a['pre-tool-use-unmatched'].wallMs.p50} ms vs ${b['pre-tool-use-unmatched'].wallMs.p50} ms`);
  check('AC2 protected gate: same exit code and stdout, still denies',
    read(OUT, 'pre-tool-use-protected.out.txt') === read(beforeDir, 'pre-tool-use-protected.out.txt')
      && JSON.stringify(a['pre-tool-use-protected'].exitCodes) === JSON.stringify(b['pre-tool-use-protected'].exitCodes)
      && /"permissionDecision":"deny"/.test(read(OUT, 'pre-tool-use-protected.out.txt')),
    `exit ${a['pre-tool-use-protected'].exitCodes} vs ${b['pre-tool-use-protected'].exitCodes}`);
  check('AC2 unmatched: same exit code and stdout',
    read(OUT, 'pre-tool-use-unmatched.out.txt') === read(beforeDir, 'pre-tool-use-unmatched.out.txt')
      && JSON.stringify(a['pre-tool-use-unmatched'].exitCodes) === JSON.stringify(b['pre-tool-use-unmatched'].exitCodes),
    `exit ${a['pre-tool-use-unmatched'].exitCodes} vs ${b['pre-tool-use-unmatched'].exitCodes}`);

  const ta = after.tenAgents;
  const tb = before.tenAgents;
  check('AC4 10 agents: tsc alive at once <= 1', ta.maxConcurrentTsc <= 1, `${ta.maxConcurrentTsc} (BEFORE ${tb.maxConcurrentTsc})`);
  check('AC4 10 agents: total CPU-seconds <= 1/3 BEFORE', ta.totalCpuSec <= tb.totalCpuSec / 3, `${ta.totalCpuSec} s vs ${tb.totalCpuSec} s`);
  check('AC4 the agent that broke a type still sees it', ta.typeErrorSeen && !ta.otherAgentsBlamed, `seen ${ta.typeErrorSeen}, others blamed ${ta.otherAgentsBlamed}`);

  check('AC5 stop 50 MB p50 < 1/2 BEFORE and <= 500 ms', a['stop-50mb'].wallMs.p50 < b['stop-50mb'].wallMs.p50 / 2 && a['stop-50mb'].wallMs.p50 <= 500,
    `${a['stop-50mb'].wallMs.p50} ms vs ${b['stop-50mb'].wallMs.p50} ms`);

  check('AC6 user-prompt-submit p50 not worse', a['user-prompt-submit'].wallMs.p50 <= b['user-prompt-submit'].wallMs.p50,
    `${a['user-prompt-submit'].wallMs.p50} ms vs ${b['user-prompt-submit'].wallMs.p50} ms`);
  check('AC6 user-prompt-submit CPU p50 not worse', a['user-prompt-submit'].cpuSec.p50 <= b['user-prompt-submit'].cpuSec.p50,
    `${a['user-prompt-submit'].cpuSec.p50} s vs ${b['user-prompt-submit'].cpuSec.p50} s`);

  const sa = a['user-prompt-submit-server'];
  const sb = b['user-prompt-submit-server'];
  check('AC6 user-prompt-submit with the app running: p50 not worse', sa.wallMs.p50 <= sb.wallMs.p50, `${sa.wallMs.p50} ms vs ${sb.wallMs.p50} ms`);
  check('AC6 user-prompt-submit with the app running: hook + server CPU not worse', sa.cpuSec.p50 + sa.serverCpuSecPerRun <= sb.cpuSec.p50 + sb.serverCpuSecPerRun,
    `${r3(sa.cpuSec.p50 + sa.serverCpuSecPerRun)} s vs ${r3(sb.cpuSec.p50 + sb.serverCpuSecPerRun)} s`);
  check('AC7 recall output with the app running identical to BEFORE', same('user-prompt-submit-server.out.txt'), 'user-prompt-submit-server.out.txt');
  check('AC7 SessionStart snapshot identical to BEFORE', same('session-start.out.txt'), 'session-start.out.txt');
  check('AC7 recall output identical to BEFORE', same('user-prompt-submit.out.txt'), 'user-prompt-submit.out.txt');

  // 1/2, owner decision 2026-10-18: in a burst every hook event is still one node process where
  // BEFORE was two (npx + node), so half is this design's floor.
  check('AC9 peak live hook processes <= 1/2 BEFORE', ta.peakHookProcs <= tb.peakHookProcs / 2, `${ta.peakHookProcs} vs ${tb.peakHookProcs}`);
  check('AC9 peak hook RSS <= 1/2 BEFORE', ta.peakHookRssMB <= tb.peakHookRssMB / 2, `${ta.peakHookRssMB} MB vs ${tb.peakHookRssMB} MB`);
  check('AC9 no hook outlives its work', ta.leftovers.length === 0, `leftovers ${ta.leftovers.length}; longest hook ${ta.longestHookMs} ms (BEFORE ${tb.longestHookMs} ms)`);

  console.log('\n' + checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`).join('\n'));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} thresholds met`);
  writeFileSync(join(OUT, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
