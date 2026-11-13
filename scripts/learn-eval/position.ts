/**
 * E6 position (plan D6, criterion 9). Model runs; run by the lead right after W1, beside W2.
 * NO product code: the two arms are scratch hooks in a scratch project.
 *
 *   npx vite-node scripts/learn-eval/position.ts -- [--runs 4] [--arm p2] [--dry-run] [--max-run-usd 2.5]
 *
 * The loaded session: a Super-like briefing and 30 rules in the SessionStart block (3 report
 * rules, 1 control rule, 26 others), then one owner turn whose job makes the agent read ten frozen
 * synthetic build logs (about 250,000 characters, read with tools) and report to him.
 *   A "session start only": the rules only in the SessionStart hook's output.
 *   B "P1": the same plus a UserPromptSubmit hook adding "Before you answer him:" report lines.
 *   C "P2" (only with --arm p2, 12 more runs): B, then one forced check pass on the same session.
 * Scored mechanically on the FIRST answer (lib.ts scoreRule): the target rule of the run
 * (4 runs per rule per arm), every report rule, and the control (over-applied when it shows).
 * Bar (criterion 9): B obeys at least 10 of 12, at least 4 more than A, over-applied at most 1 of 12.
 *
 * Spend: estimate printed first, every run checked against the shared ledger and the cap
 * (DREAMCONTEXT_EVAL_MAX_USD, default and maximum 60), each run capped by --max-budget-usd.
 * Results: ~/.dreamcontext/eval-frozen/learn-202611/results/e6-<stamp>.{json,md}.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  E6_CONTROL, E6_JOBS, E6_RULES, SpendGuard, cleanEnv, denyRules, e6Filler, e6P1Block, e6P2Prompt, e6StartBlock, evalClaudeArgs,
  fillerDigest, flagNum, overApplied, parseArgs, resultsDir, runClaude, scoreRule, spendLedgerPath, stamp, table, writePrivate,
  type ErrorType, type ReportRule,
} from './lib.js';

const { flags } = parseArgs(process.argv.slice(2));
const runsPerRule = flagNum(flags, 'runs', 4);
const withP2 = flags.arm === 'p2';
const dryRun = flags['dry-run'] === true;
const maxRunUsd = flagNum(flags, 'max-run-usd', 2.5);
const PER_RUN_ESTIMATE = 0.8;

type Arm = 'A' | 'B' | 'C';
const arms: Arm[] = withP2 ? ['C'] : ['A', 'B'];
interface Plan { arm: Arm; rule: ReportRule; i: number; job: string }
const plan: Plan[] = [];
E6_RULES.forEach((rule, r) => {
  for (let i = 0; i < runsPerRule; i++) for (const arm of arms) plan.push({ arm, rule, i, job: E6_JOBS[(r * 4 + i) % E6_JOBS.length]! });
});
// Arm C costs two calls per plan row (the answer and the forced pass).
const calls = plan.length * (withP2 ? 2 : 1);

const guard = new SpendGuard({ plan: { script: 'position', runs: calls, perRunEstimateUsd: PER_RUN_ESTIMATE, perRunMaxUsd: maxRunUsd }, ledgerPath: spendLedgerPath() });
guard.announce();
const filler = e6Filler();
console.log(`Plan: arms ${arms.join('+')}, ${E6_RULES.length} rules x ${runsPerRule} runs per arm = ${plan.length} runs (${calls} calls). Filler: ${filler.length} logs, ${filler.reduce((n, f) => n + f.text.length, 0)} chars, sha256 ${fillerDigest(filler)}.`);
if (dryRun) {
  console.log(table(['arm', 'rule', 'run', 'job'], plan.map((p) => [p.arm, p.rule.key, p.i + 1, p.job.slice(0, 70)])));
  console.log('Dry run: nothing spent.');
  process.exit(0);
}

// ─── Scratch project ────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'learn-e6-'));
const proj = join(dir, 'lumen-ledger');
mkdirSync(join(proj, 'logs'), { recursive: true });
for (const f of filler) writeFileSync(join(proj, 'logs', f.name), f.text);
const hooks = join(dir, 'hooks');
mkdirSync(hooks, { recursive: true });
writeFileSync(join(hooks, 'start.txt'), e6StartBlock());
writeFileSync(join(hooks, 'p1.txt'), e6P1Block());
const hookScript = (event: string, file: string): string =>
  `import { readFileSync } from 'node:fs';\nprocess.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ${JSON.stringify(event)}, additionalContext: readFileSync(${JSON.stringify(join(hooks, file))}, 'utf-8') } }));\n`;
writeFileSync(join(hooks, 'start.mjs'), hookScript('SessionStart', 'start.txt'));
writeFileSync(join(hooks, 'p1.mjs'), hookScript('UserPromptSubmit', 'p1.txt'));
const node = JSON.stringify(process.execPath);
const settingsFor = (arm: Arm): string => {
  const s = {
    permissions: { allow: ['Read', 'Glob', 'Grep'], deny: denyRules(homedir()) },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `${node} ${JSON.stringify(join(hooks, 'start.mjs'))}` }] }],
      ...(arm === 'A' ? {} : { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${node} ${JSON.stringify(join(hooks, 'p1.mjs'))}` }] }] }),
    },
  };
  const p = join(dir, `settings-${arm}.json`);
  writeFileSync(p, JSON.stringify(s, null, 2));
  return p;
};
const settings: Record<Arm, string> = { A: settingsFor('A'), B: settingsFor('B'), C: settingsFor('C') };
const env = cleanEnv();

// ─── Runs ───────────────────────────────────────────────────────────────────
interface Row {
  arm: Arm; rule: ReportRule['key']; i: number; job: string;
  target: ErrorType; all: Record<ReportRule['key'], ErrorType>; overApplied: boolean;
  usd: number; ms: number; ok: boolean; answer: string;
  p2?: { corrected: boolean; final: Record<ReportRule['key'], ErrorType>; usd: number; ms: number; answer: string };
}
const rows: Row[] = [];
let stopped = '';
const scoreAll = (answer: string): Record<ReportRule['key'], ErrorType> =>
  Object.fromEntries(E6_RULES.map((r) => [r.key, scoreRule(r.key, answer)])) as Record<ReportRule['key'], ErrorType>;

for (const p of plan) {
  const c = guard.check(withP2 ? 2 * maxRunUsd : maxRunUsd);
  if (!c.ok) { stopped = c.reason ?? 'cap'; console.log(`STOP before ${p.arm}/${p.rule.key}/${p.i + 1}: ${stopped}`); break; }
  const sid = withP2 ? randomUUID() : undefined;
  const first = await runClaude(evalClaudeArgs({ prompt: p.job, settings: settings[p.arm], maxUsd: maxRunUsd, tools: 'Read,Glob,Grep', allowed: ['Read', 'Glob', 'Grep'], persist: withP2, sessionId: sid }), { cwd: proj, env, guard, run: `${p.arm}/${p.rule.key}/${p.i + 1}` });
  const row: Row = {
    arm: p.arm, rule: p.rule.key, i: p.i, job: p.job, target: scoreRule(p.rule.key, first.result), all: scoreAll(first.result),
    overApplied: overApplied(first.result), usd: first.costUsd, ms: first.durationMs, ok: first.ok, answer: first.result,
  };
  if (withP2 && first.ok) {
    const second = await runClaude(evalClaudeArgs({ prompt: e6P2Prompt(), settings: settings.C, maxUsd: maxRunUsd, tools: 'Read,Glob,Grep', allowed: ['Read', 'Glob', 'Grep'], resume: first.sessionId || sid }), { cwd: proj, env, guard, run: `C-pass/${p.rule.key}/${p.i + 1}` });
    const corrected = second.ok && second.result.trim() !== '' && !/^OK\.?$/i.test(second.result.trim());
    const finalText = corrected ? second.result : first.result;
    row.p2 = { corrected, final: scoreAll(finalText), usd: second.costUsd, ms: second.durationMs, answer: second.result };
  }
  rows.push(row);
  console.log(`${p.arm} ${p.rule.key} #${p.i + 1}: ${row.target}${row.overApplied ? ' (over-applied control)' : ''} $${row.usd.toFixed(2)} ${Math.round(row.ms / 1000)}s${row.ok ? '' : ' [run error]'}`);
}

// ─── Score ──────────────────────────────────────────────────────────────────
const armStats = (arm: Arm) => {
  const xs = rows.filter((r) => r.arm === arm && r.ok);
  const by = (t: ErrorType): number => xs.filter((r) => r.target === t).length;
  return {
    runs: xs.length, obeyed: by('obeyed'), unaware: by('unaware'), misapplied: by('misapplied'),
    overApplied: xs.filter((r) => r.overApplied).length,
    allRules: Object.fromEntries(E6_RULES.map((r) => [r.key, xs.filter((x) => x.all[r.key] === 'obeyed').length])),
    usd: xs.reduce((n, r) => n + r.usd + (r.p2?.usd ?? 0), 0), medianS: Math.round((xs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0) / 1000),
    errors: rows.filter((r) => r.arm === arm && !r.ok).length,
  };
};
const stats = Object.fromEntries(arms.map((a) => [a, armStats(a)])) as Record<Arm, ReturnType<typeof armStats>>;
let verdict = '';
if (!withP2) {
  const A = stats.A; const B = stats.B;
  const enough = B.runs >= 12 && B.obeyed >= 10 && B.obeyed - A.obeyed >= 4 && B.overApplied <= 1;
  verdict = enough
    ? `P1 is enough: obeys ${B.obeyed}/${B.runs}, ${B.obeyed - A.obeyed} more than session start only, over-applied ${B.overApplied}. Nothing else happens (P2 is not put to him).`
    : `P1 is NOT enough (obeys ${B.obeyed}/${B.runs}, ${B.obeyed - A.obeyed} more than session start only, over-applied ${B.overApplied}${B.runs < 12 ? `, only ${B.runs} scored runs` : ''}). Next: run this script with --arm p2 and put every arm's numbers on the owner card.`;
} else {
  const xs = rows.filter((r) => r.arm === 'C' && r.ok);
  const finalObeyed = xs.filter((r) => r.p2 && r.p2.final[r.rule] === 'obeyed').length;
  verdict = `P2: obeyed in the first answer ${stats.C.obeyed}/${xs.length}, after the forced pass ${finalObeyed}/${xs.length}; corrections sent ${xs.filter((r) => r.p2?.corrected).length}; one extra pass per turn; added seconds median ${Math.round((xs.map((r) => r.p2?.ms ?? 0).sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0) / 1000)}; added cost $${xs.reduce((n, r) => n + (r.p2?.usd ?? 0), 0).toFixed(2)} over ${xs.length} turns.`;
}

const s = stamp();
const out = { at: new Date().toISOString(), arms, runsPerRule, fillerSha256: fillerDigest(filler), rules: E6_RULES, control: E6_CONTROL, stats, verdict, stopped: stopped || null, rows, scratch: dir };
const md = [
  `# E6 position (${arms.join('+')})`,
  '',
  `Loaded session: 30 rules at session start, ${filler.length} logs (${filler.reduce((n, f) => n + f.text.length, 0)} chars) read with tools, then a report. Model opus. Scored on the first answer.`,
  '',
  table(['arm', 'scored runs', 'obeyed (target)', 'unaware', 'misapplied', 'over-applied (control)', ...E6_RULES.map((r) => `all-runs ${r.key}`), 'run errors', 'cost', 'median s'],
    arms.map((a) => { const x = stats[a]; return [a, x.runs, x.obeyed, x.unaware, x.misapplied, x.overApplied, ...E6_RULES.map((r) => x.allRules[r.key] ?? 0), x.errors, `$${x.usd.toFixed(2)}`, x.medianS]; })),
  '',
  verdict,
  stopped ? `\nStopped early: ${stopped}` : '',
].join('\n');
writePrivate(join(resultsDir(), `e6-${s}.json`), JSON.stringify(out, null, 2));
writePrivate(join(resultsDir(), `e6-${s}.md`), md + '\n');
console.log(`\n${md}\n\nWrote ${join(resultsDir(), `e6-${s}.md`)}`);
