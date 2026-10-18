import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { ensureContextRoot } from '../../lib/context-path.js';
import { error, info, success, warn } from '../../lib/format.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { executeClaudeDetached } from '../../lib/automations/runner.js';
import { addEvalSource, buildEvalSet, readEvalSet, readRound } from '../../lib/sleep-eval/fixtures.js';
import { extractRoundCandidates } from '../../lib/sleep-eval/candidates.js';
import { LabelError, labelQueue, recordLabel } from '../../lib/sleep-eval/labels.js';
import { listRuns, readRunMeta, runEval } from '../../lib/sleep-eval/runner.js';
import {
  readBaseline,
  readStoredScore,
  renderReport,
  scoreRun,
  writeBaseline,
  writeReport,
} from '../../lib/sleep-eval/report.js';
import { FEEDBACK_REASONS, LABEL_CATEGORIES, sleepEvalRoot, type LabelCategory } from '../../lib/sleep-eval/types.js';

/**
 * `dreamcontext sleep eval …` — measure how sleep files tasks on a fixed set of this brain's
 * past rounds, before and after a change. Registered onto the `sleep` command from
 * program.ts, so the sleep command itself stays untouched.
 */

const CANDIDATE_MODEL = 'opus';
const CANDIDATE_TIMEOUT_MS = 10 * 60 * 1000;

function cliRepoSha(): string | null {
  try {
    // The bin is a symlink (npm link/global install): resolve it, or this reads the wrong repo.
    const repo = dirname(dirname(realpathSync(process.argv[1] ?? '')));
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** One prompt through claude -p with no tools and no project settings: a pure text answer. */
function candidateRunner(contextRoot: string) {
  const cwd = join(sleepEvalRoot(contextRoot), 'cwd');
  mkdirSync(cwd, { recursive: true });
  return async (prompt: string): Promise<string> => {
    const exec = await executeClaudeDetached(
      ['-p', prompt, '--model', CANDIDATE_MODEL, '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--tools', ''],
      { cwd, timeoutMs: CANDIDATE_TIMEOUT_MS },
    );
    const result = exec.result as { result?: unknown } | null;
    if (!exec.spawned || exec.exitCode !== 0 || typeof result?.result !== 'string') {
      throw new Error(`candidate extraction failed (exit ${exec.exitCode}): ${exec.stderrTail.slice(-300)}`);
    }
    return result.result;
  };
}

async function scoreAndReport(root: string, runId: string): Promise<void> {
  const meta = readRunMeta(root, runId);
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  const s = await scoreRun(root, runId);
  const baseline = readBaseline(root);
  let base = null;
  if (baseline && baseline.runId !== runId) {
    const stored = readStoredScore(root, baseline.runId);
    base = stored && stored.labelsHash === s.labelsHash ? stored : await scoreRun(root, baseline.runId);
  }
  const path = writeReport(root, runId, renderReport(meta, s, base, labelQueue(root).pending.length));
  const pctv = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  success(`Scored ${runId} (${s.matcher}, ${s.labelled} labels): composite ${pctv(s.score.composite)}${base ? ` vs baseline ${pctv(base.score.composite)}` : ''}`);
  info(`precision ${pctv(s.score.precision)} (${s.score.kept}/${s.score.opened}) · asks ${pctv(s.score.askRecall)} · parent ${pctv(s.score.parentRate)} · pattern ${pctv(s.score.patternRate)} · duplicates ${s.score.duplicates} · abandoned ${s.score.abandoned}`);
  info(`Report: ${path}`);
}

export function registerSleepEvalCommand(sleep: Command): void {
  const ev = sleep
    .command('eval')
    .description('Measure how sleep files tasks: a fixed test set from this brain\'s past rounds, scored before and after a change');

  ev.command('build')
    .description('Freeze the test set (>= 10 past rounds) and propose label candidates for each round')
    .option('--min <n>', 'Minimum number of rounds', '10')
    .option('--force', 'Rebuild the set (existing labels and candidates are kept)')
    .option('--no-candidates', 'Skip the model pass that proposes label candidates')
    .option('--add-source <dir>', 'Add rounds cut from ANOTHER brain on this machine (its project dir or _dream_context)')
    .option('--name <name>', 'Short name for the added source (default: its folder name)')
    .action(async (opts: { min: string; force?: boolean; candidates: boolean; addSource?: string; name?: string }) => {
      const root = ensureContextRoot();
      try {
        let set;
        if (opts.addSource) {
          const dir = resolve(opts.addSource);
          const srcCtx = existsSync(join(dir, '_dream_context')) ? join(dir, '_dream_context') : dir;
          const name = opts.name ?? basename(dirname(srcCtx)).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
          set = addEvalSource(root, srcCtx, name, { min: Math.max(1, Number(opts.min) || 10), log: info });
        } else {
          set = buildEvalSet(root, { min: Math.max(1, Number(opts.min) || 10), force: !!opts.force, log: info });
        }
        success(`Test set: ${set.rounds.length} rounds in ${sleepEvalRoot(root)}`);
        if (opts.candidates) {
          const run = candidateRunner(root);
          for (const id of set.rounds) {
            if (readRound(root, id)?.candidates.length) continue;
            const r = await extractRoundCandidates(root, id, run);
            info(`${id}: ${r.candidates.length} candidates`);
          }
        }
        const q = labelQueue(root);
        info(`${q.pending.length} of ${q.total} items wait for your verdict on the Tasks screen.`);
      } catch (e) {
        error((e as Error).message);
        process.exitCode = 1;
      }
    });

  ev.command('candidates [round]')
    .description('Re-run the candidate pass for one round (or every round without candidates)')
    .option('--force', 'Replace existing candidates (new ones get new ids, so old labels never attach to them)')
    .option('--focus <kinds>', 'Append a narrower pass for these kinds only (e.g. abandoned,other-project)')
    .action(async (round: string | undefined, opts: { force?: boolean; focus?: string }) => {
      const root = ensureContextRoot();
      const set = readEvalSet(root);
      if (!set) { error('No test set yet.', 'Run `dreamcontext sleep eval build` first.'); process.exitCode = 1; return; }
      const run = candidateRunner(root);
      for (const id of round ? [round] : set.rounds) {
        try {
          const focus = (opts.focus ?? '').split(',').map((x) => x.trim()).filter((x): x is LabelCategory => (LABEL_CATEGORIES as readonly string[]).includes(x) && x !== 'opened');
          const r = await extractRoundCandidates(root, id, run, { force: !!opts.force, focus });
          info(`${id}: ${r.candidates.length} candidates`);
        } catch (e) {
          warn(`${id}: ${(e as Error).message}`);
        }
      }
    });

  ev.command('status')
    .description('The set, label progress, runs and the baseline')
    .option('--json', 'Emit JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const set = readEvalSet(root);
      const q = labelQueue(root);
      const runs = listRuns(root).map((r) => ({ id: r.id, for: r.for, label: r.label, rounds: r.rounds.length, finished: !!r.finishedAt, composite: readStoredScore(root, r.id)?.score.composite ?? null }));
      const baseline = readBaseline(root);
      if (opts.json) {
        console.log(JSON.stringify({ set, labels: { total: q.total, labelled: q.labelled }, runs, baseline }, null, 2));
        return;
      }
      if (!set) { info('No test set yet: `dreamcontext sleep eval build`.'); return; }
      info(`Set: ${set.rounds.length} rounds (frozen ${set.createdAt.slice(0, 10)})`);
      info(`Labels: ${q.labelled}/${q.total}`);
      for (const r of runs) info(`${r.id}${r.id === baseline?.runId ? ' [baseline]' : ''}${r.for ? ` for ${r.for}` : ''}: ${r.rounds} rounds${r.finished ? '' : ' (unfinished)'}, composite ${r.composite === null ? '—' : `${Math.round(r.composite * 100)}%`}`);
    });

  ev.command('label <id> <answer>')
    .description(`Answer a card: what sleep should have done (new-task | add-to-task | nothing), or keep | reject for a repeated correction; "nothing" needs --reason (${FEEDBACK_REASONS.join(', ')})`)
    .option('--reason <reason>', 'Why sleep should have done nothing')
    .option('--note <note>', 'Free note')
    .action((id: string, answer: string, opts: { reason?: string; note?: string }) => {
      const root = ensureContextRoot();
      const verdict = answer === 'keep' || answer === 'reject' ? answer : undefined;
      try {
        recordLabel(root, { id, verdict, outcome: verdict ? null : answer, reason: opts.reason ?? null, note: opts.note });
        const q = labelQueue(root);
        success(`Labelled ${id}: ${answer}. ${q.pending.length} left.`);
      } catch (e) {
        error((e as Error).message);
        process.exitCode = e instanceof LabelError ? 1 : 2;
      }
    });

  ev.command('run')
    .description('Replay every round through the sleep-tasks specialist, one at a time, each in its own scratch vault')
    .option('--rounds <ids>', 'Comma-separated round ids (default: the whole set)')
    .option('--for <task>', 'The sub-task this run measures (the close gate reads it)')
    .option('--label <text>', 'A note on what changed since the last run')
    .option('--agents <names>', 'Specialists to run in order', 'sleep-tasks')
    .option('--keep-scratch', 'Keep each round\'s scratch vault for inspection')
    .option('--retry <run>', 'Re-run, inside that finished run, each of its rounds that did not end ok (e.g. a timeout under load); refused if the agent or CLI changed since')
    .option('--round-timeout <minutes>', 'Per-round ceiling in minutes (default 45)')
    .option('--no-score', 'Do not score at the end')
    .action(async (opts: { rounds?: string; for?: string; label?: string; agents: string; keepScratch?: boolean; score: boolean; retry?: string; roundTimeout?: string }) => {
      const root = ensureContextRoot();
      if (opts.retry && (opts.rounds || opts.for)) {
        error('--retry repairs an existing run as it was made: drop --rounds and --for.');
        process.exitCode = 1;
        return;
      }
      if (opts.for && opts.rounds) {
        error('--for measures a sub-task against the baseline, so it runs the whole set: drop --rounds.');
        process.exitCode = 1;
        return;
      }
      try {
        const meta = await runEval(root, {
          brainProject: dirname(root),
          cliEntry: process.argv[1] ?? '',
          nodeBin: process.execPath,
          cliVersion: dreamcontextVersion(),
          gitSha: cliRepoSha(),
          agents: opts.agents.split(',').map((s) => s.trim()).filter(Boolean),
          rounds: opts.rounds ? opts.rounds.split(',').map((s) => s.trim()) : undefined,
          for: opts.for ?? null,
          label: opts.label ?? null,
          keepScratch: !!opts.keepScratch,
          retry: opts.retry ?? null,
          ...(opts.roundTimeout && Number(opts.roundTimeout) > 0 ? { roundTimeoutMs: Math.min(180, Number(opts.roundTimeout)) * 60_000 } : {}),
          log: info,
        });
        success(`Run ${meta.id}: ${meta.rounds.filter((r) => r.status === 'ok').length}/${meta.rounds.length} rounds ok`);
        if (opts.score) await scoreAndReport(root, meta.id);
      } catch (e) {
        error((e as Error).message);
        process.exitCode = 1;
      }
    });

  ev.command('score [run]')
    .description('Score a run (default: the newest) against the current labels; re-scores the baseline on the same labels and writes the report')
    .action(async (run: string | undefined) => {
      const root = ensureContextRoot();
      const id = run ?? listRuns(root).at(-1)?.id;
      if (!id) { error('No runs yet.', 'Run `dreamcontext sleep eval run` first.'); process.exitCode = 1; return; }
      try {
        await scoreAndReport(root, id);
      } catch (e) {
        error((e as Error).message);
        process.exitCode = 1;
      }
    });

  ev.command('baseline <run>')
    .description('Make a run the baseline, gate the children of --parent on it, and write the score into that parent task')
    .requiredOption('--parent <task>', 'The parent task whose sub-tasks may not close below the baseline')
    .action(async (run: string, opts: { parent: string }) => {
      const root = ensureContextRoot();
      const meta = readRunMeta(root, run);
      if (!meta) { error(`Unknown run: ${run}`); process.exitCode = 1; return; }
      if (meta.rounds.some((r) => r.status !== 'ok') || !meta.finishedAt) {
        error(`Run ${run} did not finish cleanly: a baseline must cover every round.`);
        process.exitCode = 1;
        return;
      }
      const prev = readBaseline(root);
      const parents = [...new Set([...(prev?.runId === run ? prev.parents : []), opts.parent])];
      writeBaseline(root, { runId: run, parents, at: new Date().toISOString() });
      await scoreAndReport(root, run);
      const s = readStoredScore(root, run)!;
      const p = (x: number | null) => (x === null ? '—' : `%${Math.round(x * 100)}`);
      const line = `**Uyku ölçümü tabanı (${run}, ${s.score.rounds.length} tur, ${s.labelled} etiket):** bileşik ${p(s.score.composite)}; isabet ${p(s.score.precision)} (${s.score.kept}/${s.score.opened}), açık istek yakalama ${p(s.score.askRecall)}, doğru ana görev ${p(s.score.parentRate)}, pattern ${p(s.score.patternRate)}; ${s.score.duplicates} kopya, ${s.score.abandoned} vazgeçilmiş iş. Alt görevler \`sleep eval run --for <alt-görev>\` ile ölçülür; skor tabanın ${Math.round(s.scoring.gateTolerance * 100)} puan altına düşerse kapanamaz. Rapor: tmp/sleep-eval/runs/${run}/report.md`;
      try {
        execFileSync(process.execPath, [process.argv[1] ?? '', 'tasks', 'insert', opts.parent, 'notes', '--', line], { stdio: 'inherit' });
      } catch {
        warn(`Could not write the baseline into ${opts.parent}; the gate is active anyway.`);
      }
      success(`Baseline ${run} gates the sub-tasks of ${opts.parent}.`);
    });
}
