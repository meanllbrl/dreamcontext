/**
 * Live runner for the AI Team routing eval. OWNER-TRIGGERED, NEVER IN CI, costs money.
 *
 *   npm run build:cli
 *   npx vite-node eval/super-team-routing/run.ts -- --arm after,resume,before [--only T01,T02] [--repeat 2]
 *        [--out dir] [--cli dist/index.js] [--max-usd 12]
 *   npx vite-node eval/super-team-routing/run.ts -- --rescore <runs-dir>
 *
 * Per scenario: a tmp copy of the Orbit fixture (with or without the team, approvals in a scratch
 * HOME), `claude -p` as the Super Agent or an ordinary chat (argv pinned in run-config.ts), the
 * `dreamcontext` shim recording every call, the pure scorer. One budget across every arm: a call
 * stops at $1, the run at --max-usd (default 12), checked before each call.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFUSED_PAIRS, REFUSED_VERBS } from '../../src/lib/sleep-eval/scratch.js';
import { scratchEnv } from '../../src/lib/sleep-eval/runner.js';
import { SUPER_ORCHESTRATION_GUIDE_PATH } from '../../src/server/chat-modes.js';
import { collectTeam } from '../../src/lib/agents/team-roster.js';
import { scratchSettings } from '../super-orchestration/run-config.js';
import { MAX_USD_PER_CALL, MAX_USD_PER_RUN, teamClaudeArgs } from './run-config.js';
import { chatSpawn, guideFor, resumeOwnerTurn, superSpawn, t09EventText, type Arm } from './prompts.js';
import { observeStream, scoreScenario, summarize, type CallRecord, type ScenarioResult } from './scorer.js';
import { makeTeamProject, type TeamProject } from './setup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

interface Scenario { id: string; kind: 'super' | 'chat' | 'event' | 'resume'; fixture: 'team' | 'noteam'; request: string; of?: string }

interface Args { arms: Arm[]; only: string[]; repeat: number; out: string; cli: string; maxUsd: number; rescore?: string }

function parseCli(argv: string[]): Args {
  const a: Args = { arms: [], only: [], repeat: 1, out: join(HERE, 'runs', new Date().toISOString().replace(/[:.]/g, '-')), cli: join(REPO, 'dist', 'index.js'), maxUsd: MAX_USD_PER_RUN };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--') continue;
    if (k === '--arm') a.arms = argv[++i].split(',').filter(Boolean) as Arm[];
    else if (k === '--only') a.only = argv[++i].split(',').filter(Boolean);
    else if (k === '--repeat') a.repeat = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    else if (k === '--out') a.out = resolve(argv[++i]);
    else if (k === '--cli') a.cli = resolve(argv[++i]);
    else if (k === '--max-usd') a.maxUsd = Math.min(MAX_USD_PER_RUN, Number(argv[++i]) || MAX_USD_PER_RUN);
    else if (k === '--rescore') a.rescore = resolve(argv[++i]);
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

const scenarios = (): Scenario[] => readFileSync(join(HERE, 'scenarios.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Scenario);
/** Which scenarios an arm runs: before/after every T, resume only the R ones. */
const inArm = (arm: Arm, s: Scenario): boolean => (arm === 'resume' ? s.kind === 'resume' : s.kind !== 'resume');

interface Vault { dir: string; tp: TeamProject; evalDir: string; bin: string }

function prepare(sc: Scenario, arm: Arm, cli: string, root: string): Vault {
  const dir = mkdtempSync(join(root, `${sc.id}-${arm}-`));
  const tp = makeTeamProject(dir, { team: sc.fixture === 'team', proj: join(dir, 'proj'), home: join(dir, 'home') });
  const evalDir = join(tp.proj, '.eval');
  const bin = join(dir, 'bin');
  mkdirSync(evalDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(tp.home, '.dreamcontext'), { recursive: true });
  const models = join(homedir(), '.dreamcontext', 'models');
  if (existsSync(models)) symlinkSync(models, join(tp.home, '.dreamcontext', 'models'));
  mkdirSync(join(tp.proj, '.claude'), { recursive: true });
  const real = denyDirs([join(homedir(), 'projects'), join(homedir(), '.claude-worktrees'), join(homedir(), '.dreamcontext')], REPO);
  writeFileSync(join(tp.proj, '.claude', 'settings.json'), JSON.stringify(scratchSettings(real), null, 2) + '\n');
  const guide = join(tp.proj, SUPER_ORCHESTRATION_GUIDE_PATH);
  mkdirSync(dirname(guide), { recursive: true });
  writeFileSync(guide, guideFor(arm));
  writeFileSync(join(evalDir, 'config.json'), JSON.stringify({
    members: sc.fixture === 'team' ? collectTeam(tp.contextRoot, tp.home) : [],
    // `super state` lists members only from this build on.
    showMembers: arm !== 'before',
    home: tp.home, nodeBin: process.execPath, cliEntry: cli, refusedVerbs: REFUSED_VERBS, refusedPairs: REFUSED_PAIRS,
  }));
  writeFileSync(join(evalDir, 'turn.json'), JSON.stringify({ turn: 1 }));
  const shim = join(bin, 'dreamcontext');
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(HERE, 'shim', 'dreamcontext.mjs'))} "$@"\n`);
  chmodSync(shim, 0o755);
  return { dir, tp, evalDir, bin };
}

/**
 * The real brains and checkouts the scratch vault must never touch, minus THIS checkout: the
 * `dreamcontext` shim and the CLI build it passes through to live here (a copy of `dist/` cannot
 * run: its runtime deps are not bundled). A root that holds this checkout is denied child by
 * child, every other child still denied; no Edit or Write tool is granted either way.
 */
function denyDirs(roots: string[], keep: string): string[] {
  const out: string[] = [];
  for (const r of roots) {
    if (!keep.startsWith(`${r}/`)) { out.push(r); continue; }
    let names: string[] = [];
    try { names = readdirSync(r); } catch { names = []; }
    for (const n of names) {
      const p = join(r, n);
      if (keep === p || keep.startsWith(`${p}/`)) continue;
      out.push(p);
    }
  }
  return out;
}

interface ClaudeRun { sessionId: string; costUsd: number; stream: string[] }

function runClaude(args: string[], v: Vault, stdinLine?: string): Promise<ClaudeRun> {
  return new Promise((res, rej) => {
    const env = { ...scratchEnv({ bin: v.bin } as never), SUPER_EVAL_DIR: v.evalDir };
    const child = spawn('claude', args, { cwd: v.tp.proj, env, stdio: [stdinLine ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (stdinLine && child.stdin) { child.stdin.write(`${stdinLine}\n`); child.stdin.end(); }
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
      let sessionId = ''; let costUsd = 0;
      for (const line of stream) {
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (typeof ev.session_id === 'string') sessionId = ev.session_id;
          if (ev.type === 'result') costUsd = Number(ev.total_cost_usd ?? 0);
        } catch { /* not json */ }
      }
      res({ sessionId, costUsd, stream });
    });
  });
}

function agentsFile(v: Vault, agents: Record<string, unknown> | null): string | undefined {
  if (!agents) return undefined;
  const f = join(v.dir, 'agents.json');
  writeFileSync(f, JSON.stringify(agents));
  return f;
}

function readCalls(v: Vault, turn?: number): CallRecord[] {
  const p = join(v.evalDir, 'calls.jsonl');
  const all = existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CallRecord) : [];
  return turn === undefined ? all : all.filter((c) => c.turn === turn);
}

interface RunRecord extends ScenarioResult { arm: Arm; run: number; costUsd: number; dir: string }

async function runOne(sc: Scenario, arm: Arm, run: number, a: Args, scratchRoot: string, budget: { spent: number }): Promise<RunRecord> {
  const v = prepare(sc, arm, a.cli, scratchRoot);
  const team = sc.fixture === 'team';
  let cost = 0;
  let stream: string[] = [];
  let calls: CallRecord[] = [];
  if (sc.kind === 'resume') {
    // Turn 1: a Super born before this change (the frozen prompt and --agents).
    const born = superSpawn('before', v.tp, team);
    const file = agentsFile(v, born.agents);
    const t1 = await runClaude(teamClaudeArgs({ prompt: 'The owner opened the app. Reply with one short line: ready.', briefing: born.briefing, agentsFile: file }), v);
    cost += t1.costUsd; budget.spent += t1.costUsd;
    writeFileSync(join(v.evalDir, 'turn.json'), JSON.stringify({ turn: 2 }));
    const content = resumeOwnerTurn(v.tp, sc.request);
    const t2 = await runClaude(
      teamClaudeArgs({ briefing: born.briefing, agentsFile: file, resume: t1.sessionId, streamInput: true }),
      v, JSON.stringify({ type: 'user', message: { role: 'user', content } }),
    );
    cost += t2.costUsd; budget.spent += t2.costUsd;
    stream = t2.stream;
    calls = readCalls(v, 2);
  } else {
    const spawnArm = arm === 'before' ? 'before' : 'after';
    const sp = sc.kind === 'chat' ? chatSpawn(spawnArm, v.tp) : superSpawn(spawnArm, v.tp, team);
    const prompt = sc.kind === 'event' ? t09EventText(v.tp) : sc.request;
    const t = await runClaude(teamClaudeArgs({ prompt, briefing: sp.briefing, agentsFile: agentsFile(v, sp.agents) }), v);
    cost += t.costUsd; budget.spent += t.costUsd;
    stream = t.stream;
    calls = readCalls(v);
  }
  const score = scoreScenario(sc.id, { calls, ...observeStream(stream) });
  const dir = join(a.out, arm, `${sc.id}-r${run}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'calls.jsonl'), calls.map((c) => JSON.stringify(c)).join('\n') + '\n');
  writeFileSync(join(dir, 'stream.jsonl'), stream.join('\n') + '\n');
  const rec: RunRecord = { ...score, arm, run, costUsd: Math.round(cost * 1000) / 1000, dir };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(rec, null, 2));
  return rec;
}

function line(r: RunRecord): string {
  const fails = r.checks.filter((c) => !c.ok).map((c) => c.name);
  return `${r.id.padEnd(4)} ${r.arm.padEnd(6)} r${r.run} ${String(r.total).padStart(3)}  ${r.unsafe.length ? 'UNSAFE ' : ''}$${r.costUsd.toFixed(3)}${fails.length ? `  failed: ${fails.join('; ')}` : ''}`;
}

function report(rows: RunRecord[]): void {
  for (const arm of ['before', 'after', 'resume'] as Arm[]) {
    const mine = rows.filter((r) => r.arm === arm);
    if (!mine.length) continue;
    const runs = [...new Set(mine.map((r) => r.run))];
    for (const run of runs) {
      const s = summarize(mine.filter((r) => r.run === run));
      console.log(`${arm} r${run}: routings ${s.routingsRight}/${s.routings}, false team asks ${s.falseAsks}, unsafe ${s.unsafe}, mean ${s.mean}`);
    }
  }
}

async function main(): Promise<void> {
  const a = parseCli(process.argv.slice(2));
  if (a.rescore) {
    const rows: RunRecord[] = [];
    for (const arm of readdirSync(a.rescore)) {
      const armDir = join(a.rescore, arm);
      if (!existsSync(armDir) || arm.endsWith('.json')) continue;
      for (const d of readdirSync(armDir)) {
        const prev = JSON.parse(readFileSync(join(armDir, d, 'run.json'), 'utf-8')) as RunRecord;
        const calls = readFileSync(join(armDir, d, 'calls.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CallRecord);
        const stream = readFileSync(join(armDir, d, 'stream.jsonl'), 'utf-8').split('\n');
        rows.push({ ...prev, ...scoreScenario(prev.id, { calls, ...observeStream(stream) }) });
      }
    }
    for (const r of rows) console.log(line(r));
    report(rows);
    return;
  }
  if (!a.arms.length || a.arms.some((x) => !['before', 'after', 'resume'].includes(x))) throw new Error('pass --arm after,resume,before (any of them)');
  if (!existsSync(a.cli)) throw new Error(`no CLI build at ${a.cli}: run \`npm run build:cli\` once`);
  const scratchRoot = mkdtempSync(join(tmpdir(), 'super-team-eval-'));
  const budget = { spent: 0 };
  const rows: RunRecord[] = [];
  try {
    outer: for (const arm of a.arms) {
      for (let run = 1; run <= a.repeat; run++) {
        for (const sc of scenarios().filter((s) => inArm(arm, s) && (a.only.length === 0 || a.only.includes(s.id)))) {
          // Each call may cost up to MAX_USD_PER_CALL (a resume two): never start one the budget cannot hold.
          const need = sc.kind === 'resume' ? 2 * MAX_USD_PER_CALL : MAX_USD_PER_CALL;
          if (budget.spent + need > a.maxUsd) { console.error(`stop: $${budget.spent.toFixed(2)} spent; the next call could pass the $${a.maxUsd} limit`); break outer; }
          const rec = await runOne(sc, arm, run, a, scratchRoot, budget);
          rows.push(rec);
          console.log(`${line(rec)}  (total $${budget.spent.toFixed(2)})`);
        }
      }
    }
    console.log(`total $${budget.spent.toFixed(3)}`);
    report(rows);
    mkdirSync(a.out, { recursive: true });
    writeFileSync(join(a.out, 'summary.json'), JSON.stringify({ spentUsd: budget.spent, rows }, null, 2));
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
