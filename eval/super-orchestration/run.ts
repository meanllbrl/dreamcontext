/**
 * Live runner for the Super Agent orchestration eval. OWNER-TRIGGERED, NEVER IN CI, costs money.
 *
 *   npm run eval:super-orchestration -- --arm before|after [--only S01,S02] [--repeat n]
 *        [--out dir] [--cli dist/index.js] [--allow-home-churn]
 *   npm run eval:super-orchestration -- --smoke            one cheap call: isolation check only
 *   npm run eval:super-orchestration -- --rescore <runs-dir>   score recorded runs again, no calls
 *
 * ONE build for both arms. Arm `before` = `superBriefing(null)` and NO guide file in the scratch
 * vault; arm `after` = `superBriefing(SUPER_ORCHESTRATION_GUIDE_PATH)` + the guide installed. The
 * only difference is one bullet and one file: the eval measures the guide alone.
 *
 * Per scenario: a tmp copy of the fixture (repos without remotes), `claude -p` as the Super Agent
 * (argv and settings pinned in run-config.ts), the `dreamcontext` and `git` shims recording every
 * call, a Haiku extractor for the non-safety dimensions, the pure scorer. Cost comes from each
 * result's `total_cost_usd`; a call stops at $1 and the run at $12.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFUSED_PAIRS, REFUSED_VERBS } from '../../src/lib/sleep-eval/scratch.js';
import { scratchEnv } from '../../src/lib/sleep-eval/runner.js';
import { SUPER_ORCHESTRATION_GUIDE_PATH, superBriefing } from '../../src/server/chat-modes.js';
import { extract, EXTRACTOR_EFFORT, EXTRACTOR_MODEL } from './extract.js';
import {
  HOME_IGNORE, MAX_USD_PER_CALL, MAX_USD_PER_RUN, childDoneEvents, scratchSettings, superClaudeArgs,
} from './run-config.js';
import { scoreScenario, verdict, type CallRecord, type GoldFile, type GoldScenario, type ScenarioScore } from './scorer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const GUIDE_SOURCE = join(REPO, 'skill', 'references', 'super-orchestration.md');

interface Scenario {
  id: string; split: string; title: string; request: string; twoTurn: boolean;
  machine: 'ok' | 'overloaded';
  overlay?: Array<{ path: string; append?: string; content?: string }>;
  children?: Array<Record<string, unknown>>;
}

type Arm = 'before' | 'after';

interface Args {
  arm?: Arm; only: string[]; repeat: number; out: string; cli: string; smoke: boolean; rescore?: string; allowHomeChurn: boolean;
}

function parseCli(argv: string[]): Args {
  const a: Args = { only: [], repeat: 1, out: join(HERE, 'runs', new Date().toISOString().replace(/[:.]/g, '-')), cli: join(REPO, 'dist', 'index.js'), smoke: false, allowHomeChurn: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--arm') a.arm = argv[++i] as Arm;
    else if (k === '--only') a.only = argv[++i].split(',').filter(Boolean);
    else if (k === '--repeat') a.repeat = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    else if (k === '--out') a.out = resolve(argv[++i]);
    else if (k === '--cli') a.cli = resolve(argv[++i]);
    else if (k === '--smoke') a.smoke = true;
    else if (k === '--rescore') a.rescore = resolve(argv[++i]);
    else if (k === '--allow-home-churn') a.allowHomeChurn = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf-8')) as T;
const scenarios = (): Scenario[] => readFileSync(join(HERE, 'scenarios.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Scenario);
const gold = (): GoldFile => readJson<GoldFile>(join(HERE, 'gold.json'));

// ─── The real ~/.dreamcontext must come out untouched ───────────────────────────────────

function snapshotHome(): Map<string, number> {
  const root = join(homedir(), '.dreamcontext');
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      const rel = relative(root, p);
      if (HOME_IGNORE.some((re) => re.test(rel))) continue;
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p); else out.set(rel, st.mtimeMs);
    }
  };
  walk(root);
  return out;
}

function homeChanges(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = [];
  for (const [k, v] of after) if (before.get(k) !== v) changed.push(k);
  for (const k of before.keys()) if (!after.has(k)) changed.push(k);
  return changed;
}

// ─── One scratch vault ──────────────────────────────────────────────────────────────────

interface Vault { dir: string; proj: string; evalDir: string; bin: string; home: string }

function prepare(sc: Scenario, arm: Arm, cli: string, root: string): Vault {
  const dir = mkdtempSync(join(root, `${sc.id}-${arm}-`));
  const proj = join(dir, 'proj');
  const evalDir = join(proj, '.eval');
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  cpSync(join(HERE, 'fixture'), proj, { recursive: true });
  mkdirSync(evalDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  const models = join(homedir(), '.dreamcontext', 'models');
  if (existsSync(models)) symlinkSync(models, join(home, '.dreamcontext', 'models'));
  // The linked repos: real git repos with one commit and NO remotes.
  for (const repo of ['orbit-app', 'orbit-api']) {
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.com', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.com' };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: join(proj, repo), env: gitEnv });
    execFileSync('git', ['add', '-A'], { cwd: join(proj, repo), env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: join(proj, repo), env: gitEnv });
  }
  for (const o of sc.overlay ?? []) {
    const p = join(proj, o.path);
    mkdirSync(dirname(p), { recursive: true });
    if (o.append !== undefined) appendFileSync(p, o.append); else writeFileSync(p, o.content ?? '');
  }
  // The scratch project's own settings; the guide only in the after arm.
  mkdirSync(join(proj, '.claude'), { recursive: true });
  const real = [join(homedir(), 'projects'), join(homedir(), '.claude-worktrees'), join(homedir(), '.dreamcontext')];
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify(scratchSettings(real), null, 2) + '\n');
  if (arm === 'after') {
    const dest = join(proj, SUPER_ORCHESTRATION_GUIDE_PATH);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(GUIDE_SOURCE));
  }
  // Shims.
  const nodeBin = process.execPath;
  writeFileSync(join(evalDir, 'config.json'), JSON.stringify({
    machine: sc.machine, children: sc.children ?? [], home, nodeBin, cliEntry: cli,
    refusedVerbs: REFUSED_VERBS, refusedPairs: REFUSED_PAIRS, realGit: '/usr/bin/git',
  }));
  writeFileSync(join(evalDir, 'turn.txt'), '1');
  for (const [name, file] of [['dreamcontext', 'dreamcontext.mjs'], ['git', 'git.mjs']] as const) {
    const shim = join(bin, name);
    writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(nodeBin)} ${JSON.stringify(join(HERE, 'shim', file))} "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return { dir, proj, evalDir, bin, home };
}

// ─── `claude -p` ────────────────────────────────────────────────────────────────────────

interface ClaudeRun { sessionId: string; costUsd: number; stream: string[]; guideRead: boolean; result: string }

function runClaude(args: string[], v: Vault): Promise<ClaudeRun> {
  return new Promise((res, rej) => {
    const env = { ...scratchEnv({ bin: v.bin } as never), SUPER_EVAL_DIR: v.evalDir };
    const child = spawn('claude', args, { cwd: v.proj, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stream: string[] = [];
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf-8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { stream.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    child.on('error', rej);
    child.on('close', () => {
      if (buf.trim()) stream.push(buf);
      let sessionId = ''; let costUsd = 0; let result = '';
      let guideRead = false;
      for (const line of stream) {
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (typeof ev.session_id === 'string') sessionId = ev.session_id;
        if (ev.type === 'result') { costUsd = Number(ev.total_cost_usd ?? 0); result = String(ev.result ?? ''); }
        if (line.includes('super-orchestration.md') && ev.type === 'assistant') guideRead = true;
      }
      res({ sessionId, costUsd, stream, guideRead, result });
    });
  });
}

function readCalls(v: Vault): CallRecord[] {
  const p = join(v.evalDir, 'calls.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CallRecord) : [];
}

function readStarted(v: Vault): Array<{ id: string; brief: string; slug?: string; worktree?: string }> {
  const p = join(v.evalDir, 'started.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : [];
}

/** The Haiku extractor call: same isolation flags, no tools, a neutral cwd. */
async function askHaiku(prompt: string, root: string): Promise<{ text: string; cost: number }> {
  const cwd = mkdtempSync(join(root, 'extract-'));
  const out = await new Promise<string>((res, rej) => {
    const c = spawn('claude', [
      '-p', prompt, '--model', EXTRACTOR_MODEL, '--effort', EXTRACTOR_EFFORT, '--output-format', 'json',
      '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--tools', '',
      '--max-budget-usd', '0.05',
    ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (d: Buffer) => { o += d.toString('utf-8'); });
    c.on('error', rej);
    c.on('close', () => res(o));
  });
  try { const j = JSON.parse(out) as { result?: string; total_cost_usd?: number }; return { text: j.result ?? '', cost: Number(j.total_cost_usd ?? 0) }; } catch { return { text: '', cost: 0 }; }
}

// ─── The run ────────────────────────────────────────────────────────────────────────────

interface RunRecord extends ScenarioScore { arm: Arm; run: number; costUsd: number; guideRead: boolean; sessionId: string; dir: string }

async function runOne(sc: Scenario, g: GoldFile, arm: Arm, run: number, a: Args, scratchRoot: string, budget: { spent: number }): Promise<RunRecord> {
  const v = prepare(sc, arm, a.cli, scratchRoot);
  const briefing = superBriefing(arm === 'after' ? SUPER_ORCHESTRATION_GUIDE_PATH : null);
  let cost = 0;
  const t1 = await runClaude(superClaudeArgs({ prompt: sc.request, briefing }), v);
  cost += t1.costUsd; budget.spent += t1.costUsd;
  let guideRead = t1.guideRead;
  const streams = [...t1.stream];
  if (sc.twoTurn && budget.spent < MAX_USD_PER_RUN) {
    writeFileSync(join(v.evalDir, 'turn.txt'), '2');
    const done = readStarted(v).map((c) => ({ id: c.id, brief: c.brief, branch: c.slug ? `super/${c.slug}` : undefined }));
    const t2 = await runClaude(superClaudeArgs({ prompt: childDoneEvents(done) || '[super event] nothing finished', briefing, resume: t1.sessionId }), v);
    cost += t2.costUsd; budget.spent += t2.costUsd; guideRead ||= t2.guideRead; streams.push(...t2.stream);
  }
  const calls = readCalls(v);
  const goldSc = g.scenarios.find((s) => s.id === sc.id) as GoldScenario;
  // Units for the extractor, from the recorded argv (the scorer parses them again for the gates).
  const { parseCalls } = await import('./scorer.js');
  const units = parseCalls(calls).units;
  let extraction = null;
  if (units.length > 0) {
    extraction = await extract(goldSc, units, async (p) => { const r = await askHaiku(p, scratchRoot); budget.spent += r.cost; cost += r.cost; return r.text; });
  }
  const score = scoreScenario(g, goldSc, { calls, mapping: extraction?.mapping, selfContained: extraction?.selfContained });
  const dir = join(a.out, arm, `${sc.id}-r${run}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'calls.jsonl'), calls.map((c) => JSON.stringify(c)).join('\n') + '\n');
  writeFileSync(join(dir, 'stream.jsonl'), streams.join('\n') + '\n');
  writeFileSync(join(dir, 'extraction.json'), JSON.stringify(extraction));
  const rec: RunRecord = { ...score, arm, run, costUsd: Math.round(cost * 1000) / 1000, guideRead, sessionId: t1.sessionId, dir };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(rec, null, 2));
  return rec;
}

async function smoke(a: Args, scratchRoot: string): Promise<void> {
  const sc = scenarios()[0];
  const v = prepare(sc, 'before', a.cli, scratchRoot);
  const r = await runClaude(superClaudeArgs({ prompt: 'Reply with the single word ok.', briefing: superBriefing(null) }), v);
  const forbidden = ['NativeMinds KB', 'Memory recall', 'pre-authorized by the user for dreamcontext'];
  const leaks = forbidden.filter((f) => r.stream.some((l) => l.includes(f)));
  console.log(`smoke: cost $${r.costUsd.toFixed(3)}, leaks: ${leaks.length ? leaks.join(', ') : 'none'}`);
  if (leaks.length > 0) { console.error('the eval would see user CLAUDE.md or hook text: stop'); process.exit(4); }
}

function table(rows: RunRecord[]): void {
  console.log('scenario  arm     total  part ord mode band wt ask brief  unsafe  $');
  for (const r of rows) {
    const d = r.dims;
    console.log(`${r.id.padEnd(9)} ${r.arm.padEnd(7)} ${String(r.total).padStart(5)}  ${String(d.partition).padStart(4)} ${String(d.order).padStart(3)} ${String(d.mode).padStart(4)} ${String(d.band).padStart(4)} ${String(d.worktree).padStart(2)} ${String(d.asks).padStart(3)} ${String(d.brief).padStart(5)}  ${r.unsafe.length ? 'UNSAFE' : '-'}  ${r.costUsd}`);
  }
}

async function main(): Promise<void> {
  const a = parseCli(process.argv.slice(2));
  const g = gold();
  if (a.rescore) {
    const rows: RunRecord[] = [];
    for (const arm of ['before', 'after'] as Arm[]) {
      const armDir = join(a.rescore, arm);
      if (!existsSync(armDir)) continue;
      for (const d of readdirSync(armDir)) {
        const calls = readFileSync(join(armDir, d, 'calls.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CallRecord);
        const prev = readJson<RunRecord>(join(armDir, d, 'run.json'));
        const ex = JSON.parse(readFileSync(join(armDir, d, 'extraction.json'), 'utf-8')) as { mapping: string[][]; selfContained: boolean[] } | null;
        const s = scoreScenario(g, g.scenarios.find((x) => x.id === prev.id) as GoldScenario, { calls, mapping: ex?.mapping, selfContained: ex?.selfContained });
        rows.push({ ...prev, ...s });
      }
    }
    table(rows);
    const by = (arm: Arm) => ({ scenarios: rows.filter((r) => r.arm === arm) });
    if (by('before').scenarios.length && by('after').scenarios.length) console.log(JSON.stringify(verdict(by('before'), by('after')), null, 2));
    return;
  }
  const scratchRoot = mkdtempSync(join(tmpdir(), 'super-orch-eval-'));
  const homeBefore = snapshotHome();
  try {
    if (a.smoke) { await smoke(a, scratchRoot); return; }
    if (a.arm !== 'before' && a.arm !== 'after') throw new Error('pass --arm before|after (or --smoke / --rescore)');
    if (!existsSync(a.cli)) throw new Error(`no CLI build at ${a.cli}: run \`npm run build:cli\` once`);
    const budget = { spent: 0 };
    const rows: RunRecord[] = [];
    for (const sc of scenarios().filter((s) => a.only.length === 0 || a.only.includes(s.id))) {
      for (let run = 1; run <= a.repeat; run++) {
        if (budget.spent >= MAX_USD_PER_RUN) { console.error(`stop: $${budget.spent.toFixed(2)} spent (limit $${MAX_USD_PER_RUN}, per call $${MAX_USD_PER_CALL})`); break; }
        const rec = await runOne(sc, g, a.arm, run, a, scratchRoot, budget);
        rows.push(rec);
        table([rec]);
      }
    }
    console.log(`total $${budget.spent.toFixed(3)}`);
    table(rows);
  } finally {
    const changed = homeChanges(homeBefore, snapshotHome());
    rmSync(scratchRoot, { recursive: true, force: true });
    if (changed.length > 0) {
      console.error(`the real ~/.dreamcontext changed during the run: ${changed.slice(0, 10).join(', ')}`);
      if (!a.allowHomeChurn) process.exitCode = 3;
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
