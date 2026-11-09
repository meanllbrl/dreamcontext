import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_REVIEW_RULES } from '../../lib/code-review-rules.js';
import { ensureContextRoot } from '../../lib/context-path.js';
import { repoToplevel } from '../../lib/builder-tools.js';
import {
  classResolver, computePlanState, CODE_LENSES, loopCommand, nextRoundLenses, nextSeq, normClass, noteLines, ownerOf, renderNextAction, renderStopCard,
  GIT_OBJECT_RE, PLAN_LEDGER_VERSION, type Ledger, type LedgerRound, type PlanState,
} from '../../lib/plan-ledger.js';
import {
  ensureReviewLoopDir, PlanStoreError, readExternalNoLink, readLedgerAt, readSafe, reviewLoopDir, reviewLoopsDir, sha, withLockFile, writeSafe,
} from '../../lib/plan-store.js';
import { shellQuote } from '../../lib/run-budget.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import type { TaskBackend } from '../../lib/task-backend/types.js';
import {
  collect, decideIn, DECIDE_KINDS, event, latestRound, mergeClassIn, partialPath, PlanRefusal, recordIn, run, type LoopStore, type PlanDeps,
} from './plan.js';

/**
 * `dreamcontext builder review …` — a Develop run's code review loop, on the plan's engine.
 *
 * The same ledger, class counts and stops as `dreamcontext plan` (lib/plan-ledger.ts, `mode:
 * "code"`): a class in its 2nd counted round asks for a redesign, in its 3rd it stops the loop
 * with the owner's card, and rounds are never capped. What is Develop's own: the reviewers are
 * the end review's (`reviewer`, or the team review-pick names), the packet carries exact
 * `git diff` ranges instead of a plan file, the lead's fix note must say how each open class was
 * swept, and a blocking finding needs a concrete harm. Measured over 390 Develop runs
 * (task develop-inceleme-dongusu-…): 42% of the loop findings were holes the previous fix
 * opened and 32% another site of the same class; the re-reviewer got the previous findings
 * by hand, in 17 of 34 long loops not word for word.
 *
 * The loop lives in the CODE repo (`tmp/develop/<task>/review/<loop>/`) because a code worktree
 * holds no brain. Every verb is a CLI call, so Claude Code, Codex and Antigravity run it alike.
 */

export interface ReviewDeps {
  /** The code repo the loop lives in. */
  repo: string;
  now: () => Date;
  /** The brain, for the criteria at open and for split / --cancel-task. */
  brain: () => { root: string; backend: TaskBackend };
  /** The paths that differ between two trees; throws when either is no object of the repo. */
  diffNames?: (base: string, tree: string) => string[];
}

function gitDiffNames(repo: string, base: string, tree: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', '-z', base, tree], { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw new PlanRefusal(`git cannot diff ${base} against ${tree} in ${repo}: give the snapshot trees of this repo (START, NOW, FIX).`);
  }
  return out.split('\0').filter(Boolean);
}

/**
 * Every path a round or a reviewer's scope carries is a path the trees really changed, so the
 * `git diff` a packet prints can never come back empty. The one guard for every way a path
 * enters a round: round 1's paths, a fix round's paths, and a team member's own scope. Returns
 * the changed paths left out, which the lead hears about (another session's work, or a miss).
 */
function checkPaths(deps: ReviewDeps, base: string, tree: string, paths: string[], what: string): string[] {
  const changed = new Set((deps.diffNames ?? ((b, t) => gitDiffNames(deps.repo, b, t)))(base, tree));
  const unknown = paths.filter((p) => !changed.has(p));
  if (unknown.length > 0) {
    const joined = unknown.filter((p) => /\s/.test(p) && p.split(/\s+/).every((x) => changed.has(x)));
    throw new PlanRefusal([
      `${what}: ${unknown.map((p) => `"${p}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not changed between ${base} and ${tree}, so a reviewer would read an empty diff.`,
      joined.length > 0 ? 'Several paths arrived as one argument: pass each path as its own argument (in zsh an unquoted $VAR is not split; use ${=VAR} or an array).' : 'Name the paths exactly as `git diff --name-only` prints them.',
    ].join(' '));
  }
  const given = new Set(paths);
  return [...changed].filter((p) => !given.has(p));
}



function store(deps: ReviewDeps, task: string, loop: string): LoopStore {
  const dir = reviewLoopDir(deps.repo, task, loop);
  const ledgerFile = join(dir, 'ledger.json');
  return {
    root: deps.repo,
    dir,
    lock: (fn) => {
      ensureReviewLoopDir(deps.repo, task, loop);
      return withLockFile(join(reviewLoopsDir(deps.repo, task), `${loop}.lock`), `review loop ${loop} of ${task}`, fn);
    },
    load: () => {
      const r = readLedgerAt(deps.repo, ledgerFile, loop, 'code');
      if (r.ok) {
        if (r.ledger.task !== task) throw new PlanRefusal(`${ledgerFile} belongs to task ${r.ledger.task}, not ${task}.`);
        return r.ledger;
      }
      if (r.missing) throw new PlanRefusal(`No review loop "${loop}" for ${task} in ${deps.repo}. Open it: \`dreamcontext builder review open ${task}${loop === 'end' ? '' : ` --loop ${loop}`} --lenses <reviewer|the team> --start <START>\`.`);
      throw new PlanRefusal(`The review ledger cannot be read, so nothing runs on it: ${r.problem}. Repair it, or move the folder away.`);
    },
    write: (ledger) => writeSafe(deps.repo, ledgerFile, JSON.stringify(ledger, null, 2) + '\n'),
    reviewPath: (n, lens) => join(dir, `r${n}-${lens}.md`),
  };
}

/** The deps decide needs: the brain only when split or --cancel-task writes a task. */
function planDepsOf(deps: ReviewDeps): PlanDeps {
  return {
    get root() { return deps.brain().root; },
    now: deps.now,
    backend: () => deps.brain().backend,
  };
}

function parseLenses(raw: string): string[] {
  const lenses = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  const bad = lenses.filter((l) => !(CODE_LENSES as readonly string[]).includes(l));
  if (lenses.length === 0 || bad.length > 0) throw new PlanRefusal(`--lenses must be the end review's reviewers, from ${CODE_LENSES.join(', ')}${bad.length > 0 ? ` (unknown: ${bad.join(', ')})` : ''}.`);
  return lenses;
}

function cleanPaths(paths: string[] | undefined): string[] {
  const out = [...new Set((paths ?? []).flatMap((p) => p.split('\n')).map((p) => p.trim()).filter(Boolean))];
  for (const p of out) if (p.startsWith('-')) throw new PlanRefusal(`"${p}" is not a path.`);
  return out;
}

// ─── open ───────────────────────────────────────────────────────────────────

export async function reviewOpen(deps: ReviewDeps, task: string, loop: string, opts: { lenses: string; start: string; criteriaFile?: string; goal?: string }): Promise<string> {
  const s = store(deps, task, loop);
  const lenses = parseLenses(opts.lenses);
  if (!GIT_OBJECT_RE.test(opts.start ?? '')) throw new PlanRefusal('--start <tree> must be the run\'s START tree (a git object id).');
  if (opts.criteriaFile && opts.goal !== undefined) throw new PlanRefusal('Give the criteria one way: --criteria-file <file> or --goal "<what the fix must do>".');
  let criteria = '';
  if (opts.criteriaFile) criteria = readExternalNoLink(opts.criteriaFile).trim();
  // Small work opens no task (owner, 2026-11-09): the loop's key is then just a name (the
  // branch's, say), and --goal says what the fix must do, so a review never forces a task.
  else if (opts.goal !== undefined) criteria = opts.goal.trim() ? `- [ ] ${opts.goal.trim()}` : '';
  else {
    try {
      criteria = ((await deps.brain().backend.get(task))?.acceptance_criteria ?? '').trim();
    } catch { /* no brain reachable from here: --criteria-file says it */ }
  }
  if (!criteria) throw new PlanRefusal(`No criteria for "${task}" could be read here (no brain in ${deps.repo}, no such task, or a task with no criteria). Small work needs no task: pass --goal "<what the fix must do>" (the loop's name can be the branch's, without its prefix). Otherwise write the criteria to a file and pass --criteria-file <file>.`);
  return s.lock(() => {
    const existing = readLedgerAt(deps.repo, join(s.dir, 'ledger.json'), loop, 'code');
    if (existing.ok || !existing.missing) throw new PlanRefusal(`Review loop "${loop}" of ${task} already exists: \`${loopCommand({ mode: 'code', plan: loop, task } as Ledger, 'status')}\`. A new end review after an abandoned loop takes another --loop name.`);
    const ledger: Ledger = {
      v: PLAN_LEDGER_VERSION, mode: 'code', plan: loop, goal: '', task, lenses,
      budget: { base: 0, extra: 0, unlimited: true }, createdAt: deps.now().toISOString(), seq: 0, events: [], rounds: [],
      start: opts.start, criteria,
    };
    s.write(ledger);
    return [
      `Review loop ${loop} opened for ${task} (${lenses.join(' + ')}; rounds are counted, never capped; a class in its 3rd round stops for the owner).`,
      `Folder: ${s.dir}`,
      renderNextAction(ledger, computePlanState(ledger)).replace('Next: review', 'Next: review (round 1 needs --tree <NOW> --paths <every path of the run>, a team member\'s own scope by --paths on its packet)'),
    ].join('\n');
  });
}

// ─── packet ─────────────────────────────────────────────────────────────────

export interface CodePacketInput {
  ledger: Ledger;
  state: PlanState;
  round: LedgerRound;
  lens: string;
  changes: string | null;
  prevReviews: Array<{ name: string; text: string }>;
  partial: string | null;
}

/** Everything a code reviewer reads, in one text. The lead adds only "read this file". */
export function buildCodePacketText(p: CodePacketInput): string {
  const { ledger, state, round, lens } = p;
  const paths = round.lenses[lens]?.paths ?? round.paths ?? [];
  const diff = (from: string, to: string): string[] => paths.map((f) => `  git diff ${from} ${to} -- ${shellQuote(f)}`);
  const own = state.open.filter((f) => f.lens === lens);
  const out = [
    `# Code review packet: ${ledger.task}, loop ${ledger.plan}, round ${round.n}, reviewer ${lens}`,
    '',
    `Task: ${ledger.task}. Its acceptance criteria, as read when the loop opened:`,
    '',
    ledger.criteria ?? '(none recorded)',
    '',
    '## What to read (run these yourself)',
  ];
  if (round.n === 1) {
    out.push(
      `The run: start tree ${ledger.start}, current tree ${round.tree}. Your scope, one diff per path:`,
      ...diff(ledger.start!, round.tree!),
      `Which are new (status A, read them whole): git diff --name-status ${ledger.start} ${round.tree} -- ${paths.map(shellQuote).join(' ')}`,
    );
  } else {
    out.push(
      `The fix: it changed the tree you reviewed (${round.base}) into ${round.tree}. Read it, one diff per path:`,
      ...diff(round.base!, round.tree!),
      `The whole run, when a finding needs context: git diff ${ledger.start} ${round.tree} -- <path>`,
      '',
      '## The lead\'s fix note (changes.md, verbatim)',
      '',
      (p.changes ?? '').trim() || '(none written)',
    );
  }
  out.push('', `## Previous round${p.prevReviews.length > 0 ? ` (r${round.n - 1})` : ''}: raw reviews of every reviewer, verbatim`);
  if (p.prevReviews.length === 0) out.push('(none: this is the first round)');
  for (const r of p.prevReviews) out.push('', `### ${r.name}`, '', r.text.trim());
  if (p.partial) {
    out.push('', '## Your earlier PARTIAL review in this round, verbatim (re-state its findings that still hold, then read its `Not reviewed:` paths)', '', p.partial.trim());
  }
  out.push(
    '',
    '## Open findings (ids)',
    ...(state.open.length > 0 ? state.open.map((f) => `- ${f.id} [${f.level}] class: ${f.cls} (${f.lens})`) : ['(none)']),
    '',
    '## Owner-accepted ids (not findings; re-list one only at a higher level)',
    ...(state.accepted.length > 0 ? state.accepted.map((id) => `- ${id}`) : ['(none)']),
  );
  if (state.moved.length > 0) {
    out.push('', '## Moved by a split (each owed to its reviewer: `closed: <id> | cut` when the change no longer carries it, else re-state it)',
      ...state.moved.map((id) => `- ${id} (${ownerOf(id) ?? '?'})`));
  }
  out.push(
    '',
    '## Known classes (reuse a name when it fits; `origin: same-class` must use one)',
    ...(state.knownClasses.length > 0 ? state.knownClasses.map((c) => `- ${c} (${state.classCounts[c] ?? 0} counted round${(state.classCounts[c] ?? 0) === 1 ? '' : 's'})`) : ['(none yet)']),
    '',
    CODE_REVIEW_RULES,
    '',
    '## Your output',
    `Reviewer: ${lens}. Your own open ids: ${own.length > 0 ? own.map((f) => f.id).join(', ') : 'none'}. Each is re-stated or closed.`,
    'Reply with the review only; the lead saves it verbatim and records it.',
  );
  return out.join('\n') + '\n';
}

export async function reviewPacket(deps: ReviewDeps, task: string, loop: string, lens: string, opts: { tree?: string; paths?: string[] }): Promise<{ text: string; path: string; round: number; opened: boolean; leftOut: string[] }> {
  if (!(CODE_LENSES as readonly string[]).includes(lens)) throw new PlanRefusal(`--lens must be one of ${CODE_LENSES.join(', ')}.`);
  const s = store(deps, task, loop);
  const paths = cleanPaths(opts.paths);
  if (opts.tree !== undefined && !GIT_OBJECT_RE.test(opts.tree)) throw new PlanRefusal('--tree <tree> must be a git object id (the NOW or FIX snapshot).');
  return s.lock(() => {
    const ledger = s.load();
    let state = computePlanState(ledger);
    if (state.abandoned) throw new PlanRefusal(`Review loop ${loop} of ${task} was abandoned.`);
    if (state.done) throw new PlanRefusal(`Review loop ${loop} of ${task} is done (every reviewer PASS, nothing open). Next: record review-end, then the final check.`);
    const now = deps.now().toISOString();
    let round = latestRound(ledger);
    let opened = false;
    let leftOut: string[] = [];

    if (round && !state.roundComplete) {
      const rec = round.lenses[lens];
      if (!rec) throw new PlanRefusal(`Round ${round.n} waits on ${Object.keys(round.lenses).join(', ')}, not ${lens}.`);
      if (['PASS', 'FAIL'].includes(rec.verdict)) throw new PlanRefusal(`${lens} already reported in round ${round.n} (${rec.verdict}); waiting on ${state.next.kind === 'review' ? state.next.lenses.join(', ') : 'nothing'}.`);
      if (opts.tree && opts.tree !== round.tree) throw new PlanRefusal(`Round ${round.n} reviews tree ${round.tree}; --tree ${opts.tree} differs. Finish this round first.`);
      // A team member's own scope is its packet's --paths; a re-dispatch keeps it.
      const lensPaths = paths.length > 0 ? paths : rec.paths;
      if (paths.length > 0) checkPaths(deps, round.base ?? ledger.start ?? '', round.tree ?? '', paths, `${lens}'s scope`);
      round.lenses[lens] = { verdict: 'PENDING', dispatchedAt: now, findings: [], seq: nextSeq(ledger), ...(lensPaths ? { paths: lensPaths } : {}) };
    } else {
      const blocking = state.stops.filter((x) => x.kind !== 'redesign');
      if (blocking.length > 0) throw new PlanRefusal(`The next round is refused: a stop stands. Ask the owner (an owner card; a Super Agent never answers it):\n\n${renderStopCard(ledger, state)}`);
      if (!opts.tree) throw new PlanRefusal(`Opening round ${(round?.n ?? 0) + 1} needs --tree <${round ? 'FIX' : 'NOW'}> and --paths <${round ? 'the files the fix changed' : 'every path of the run'}>.`);
      if (paths.length === 0) throw new PlanRefusal(`Opening a round needs --paths: ${round ? 'the files the fix changed' : 'every path of the run'}, by name.`);
      const lenses = nextRoundLenses(ledger, state);
      if (!lenses.includes(lens)) throw new PlanRefusal(`Round ${(round?.n ?? 0) + 1} is for ${lenses.join(', ')} (${round ? 'each reviewer that still owns an open id' : 'the reviewers chosen at open'}); start it with one of them.`);
      if (round && opts.tree === round.tree) throw new PlanRefusal(`Tree ${opts.tree} is the one round ${round.n} reviewed: nothing was fixed. Fix, take the FIX snapshot, then open the round.`);
      leftOut = checkPaths(deps, round?.tree ?? ledger.start ?? '', opts.tree, paths, `Round ${(round?.n ?? 0) + 1}'s --paths`);
      let changes = '';
      if (round) {
        const notePath = join(s.dir, 'changes.md');
        if (!existsSync(notePath)) throw new PlanRefusal(`Write the fix note first: ${notePath}\n\n${renderNextAction(ledger, state)}`);
        changes = readSafe(deps.repo, notePath);
        if (sha(changes) === round.snapshotSha) throw new PlanRefusal(`changes.md is unchanged since round ${round.n}: write it whole for this fix.`);
        const resolve = classResolver(ledger.events);
        const swept = new Set(noteLines(changes, 'sweep', 3).map((p) => resolve(p[0])));
        const openClasses = [...new Set(state.open.map((f) => f.cls))];
        const unswept = openClasses.filter((c) => !swept.has(c));
        if (unswept.length > 0) {
          throw new PlanRefusal(`Fix by class: changes.md has no sweep line for ${unswept.map((c) => `"${c}"`).join(', ')}. Search every sibling path of the class, fix it in one place, then add:\n${unswept.map((c) => `  sweep: ${c} | <every sibling path you checked> | <the one place you fixed it>`).join('\n')}`);
        }
        const redesigns = state.stops.filter((x) => x.kind === 'redesign').map((x) => x.cls!);
        const named = new Set(noteLines(changes, 'redesign', 2).map((p) => resolve(p[0])));
        const missing = redesigns.filter((c) => !named.has(c));
        if (missing.length > 0) {
          throw new PlanRefusal(`Redesign first: ${missing.length === 1 ? 'this class is' : 'these classes are'} in a 2nd counted round, so the fix moves to the one place covering the whole class. changes.md must carry:\n${missing.map((c) => `  redesign: ${c} | <the one layer that now covers the whole class>`).join('\n')}`);
        }
        if (state.splitPending) {
          const splitNamed = new Set(noteLines(changes, 'split', 2).flatMap((p) => p[0].split(',')).map((c) => resolve(normClass(c))));
          const notNamed = state.splitPending.classes.filter((c) => !splitNamed.has(c));
          if (notNamed.length > 0) throw new PlanRefusal(`After the split, changes.md must carry: split: ${state.splitPending.classes.join(', ')} | <what this run no longer carries>`);
        }
        for (const cls of redesigns) event(deps, ledger, 'redesign', { cls });
      }
      const n = (round?.n ?? 0) + 1;
      if (round) writeSafe(deps.repo, join(s.dir, `changes.r${n}.md`), changes);
      const openSeq = nextSeq(ledger);
      const recs: LedgerRound['lenses'] = {};
      for (const l of lenses) recs[l] = { verdict: 'PENDING', dispatchedAt: now, findings: [], seq: openSeq };
      round = { n, openedAt: now, snapshotSha: sha(changes), openSeq, lenses: recs, tree: opts.tree, base: round?.tree ?? ledger.start, paths };
      ledger.rounds.push(round);
      opened = true;
    }
    s.write(ledger);
    state = computePlanState(ledger);
    const prevReviews: CodePacketInput['prevReviews'] = [];
    const prev = ledger.rounds.find((r) => r.n === round!.n - 1);
    for (const l of prev ? Object.keys(prev.lenses) : []) {
      const p = s.reviewPath(prev!.n, l);
      if (existsSync(p)) prevReviews.push({ name: `r${prev!.n}-${l}.md`, text: readSafe(deps.repo, p) });
    }
    const pp = partialPath(s, round.n, lens);
    const partial = existsSync(pp) ? readSafe(deps.repo, pp) : null;
    const changesSnap = round.n > 1 ? join(s.dir, `changes.r${round.n}.md`) : null;
    const text = buildCodePacketText({
      ledger, state, round, lens, prevReviews, partial,
      changes: changesSnap && existsSync(changesSnap) ? readSafe(deps.repo, changesSnap) : null,
    });
    const path = join(s.dir, `r${round.n}-${lens}.packet.md`);
    writeSafe(deps.repo, path, text);
    return { text, path, round: round.n, opened, leftOut };
  });
}

// ─── status ─────────────────────────────────────────────────────────────────

export function reviewStatus(deps: ReviewDeps, task: string, loop: string): { state: PlanState; text: string; json: Record<string, unknown> } {
  const s = store(deps, task, loop);
  const ledger = s.load();
  const st = computePlanState(ledger);
  const byClass = new Map<string, string[]>();
  for (const f of st.open) byClass.set(f.cls, [...(byClass.get(f.cls) ?? []), `${f.id} ${f.level} (${f.lens})`]);
  const minors = ledger.rounds.flatMap((r) => Object.values(r.lenses).flatMap((l) => l.downgraded ?? []).map((d) => `r${r.n} ${d.id} (${d.cls})`));
  const text = [
    `Review loop ${loop} of ${task} (${s.dir})`,
    `Round ${st.round}${st.round > 0 ? (st.roundComplete ? ' (complete)' : ' (in progress)') : ''}; rounds are counted, never capped.`,
    `Reviewers: ${Object.entries(st.verdicts).map(([l, v]) => `${l} ${v}`).join(', ')}`,
    'Open findings by class:',
    ...(byClass.size > 0 ? [...byClass].map(([c, ids]) => `- ${c} [${st.classCounts[c] ?? 0} counted round${(st.classCounts[c] ?? 0) === 1 ? '' : 's'}]: ${ids.join(', ')}`) : ['- none']),
    ...(st.accepted.length > 0 ? [`Owner-accepted: ${st.accepted.join(', ')}`] : []),
    ...(minors.length > 0 ? [`Recorded as Minor (no concrete harm): ${minors.join(', ')}`] : []),
    '',
    renderNextAction(ledger, st),
  ].join('\n');
  const json = {
    task, loop, dir: s.dir, lenses: ledger.lenses, start: ledger.start, round: st.round, roundComplete: st.roundComplete,
    verdicts: st.verdicts, open: st.open, accepted: st.accepted, moved: st.moved, classCounts: st.classCounts, stops: st.stops,
    done: st.done, abandoned: st.abandoned, next: st.next.kind, nextText: renderNextAction(ledger, st), minors,
    ...(st.next.kind === 'stop' ? { card: renderStopCard(ledger, st) } : {}),
  };
  return { state: st, text, json };
}

export async function reviewRecord(deps: ReviewDeps, task: string, loop: string, lens: string, opts: { file?: string; abandon?: boolean; note?: string }): Promise<string> {
  return recordIn(store(deps, task, loop), deps, lens, opts);
}

export async function reviewDecide(deps: ReviewDeps, task: string, loop: string, kind: string, opts: Parameters<typeof decideIn>[3]): Promise<string> {
  return decideIn(store(deps, task, loop), planDepsOf(deps), kind, opts);
}

export async function reviewMergeClass(deps: ReviewDeps, task: string, loop: string, from: string, into: string): Promise<string> {
  return mergeClassIn(store(deps, task, loop), deps, from, into);
}

// ─── Commander ──────────────────────────────────────────────────────────────

function depsFor(repo?: string): ReviewDeps {
  const at = repo ?? repoToplevel(process.cwd());
  return {
    repo: at,
    now: () => new Date(),
    brain: () => {
      let root: string;
      try {
        root = ensureContextRoot();
      } catch {
        throw new PlanRefusal('This step writes a task, and no brain is reachable from here: run it from the brain folder with --repo <the code repo>.');
      }
      return { root, backend: getTaskBackend(root) };
    },
  };
}

interface Common { loop: string; repo?: string }

export function registerReviewLoopCommands(builder: Command): void {
  const review = builder
    .command('review')
    .description('A Develop run\'s code review loop on the plan\'s engine: packet from the CLI, class stops, harm-backed Majors (open/packet/record/status/decide/merge-class)');
  const common = (c: Command): Command => c
    .option('--loop <name>', 'The loop: end (the end review) or w<N> (a fan-out wave\'s reviewer)', 'end')
    .option('--repo <path>', 'The code repo the loop lives in (default: this checkout)');

  common(review.command('open').argument('<task>', 'The task slug, or for small work with no task any a-z0-9- name (e.g. the branch\'s, without its prefix)'))
    .requiredOption('--lenses <list>', `The end review's reviewers: reviewer, or the team review-pick names (${CODE_LENSES.join(', ')})`)
    .requiredOption('--start <tree>', 'The run\'s START tree')
    .option('--criteria-file <path>', 'The task\'s criteria, when no brain is reachable from here')
    .option('--goal <text>', 'Small work with no task: what the fix must do, the reviewer\'s one criterion')
    .description('Open the review loop of a run (its ledger beside the run, in tmp/develop/<task>/review/)')
    .action((task: string, o: Common & { lenses: string; start: string; criteriaFile?: string; goal?: string }) => run(() => reviewOpen(depsFor(o.repo), task, o.loop, o)));

  common(review.command('packet').argument('<task>'))
    .requiredOption('--lens <reviewer>', CODE_LENSES.join(' | '))
    .option('--tree <tree>', 'Opening a round: the tree it reviews (NOW in round 1, FIX after)')
    .option('--paths <paths...>', 'Opening a round: every path (round 1) or the files the fix changed; in round 1 also a team member\'s own scope')
    .option('--print', 'Print the whole packet instead of its path')
    .description('Write the packet a reviewer reads; opens the next round when nothing stops it')
    .action((task: string, o: Common & { lens: string; tree?: string; paths?: string[]; print?: boolean }) => run(async () => {
      const r = await reviewPacket(depsFor(o.repo), task, o.loop, o.lens, o);
      if (o.print) return r.text;
      const left = r.leftOut.length > 0 ? `\nChanged but not in --paths (another session's work? otherwise this round misses them): ${r.leftOut.join(', ')}` : '';
      return `${r.opened ? `Round ${r.round} opened.` : `Round ${r.round}.`} Packet for ${o.lens}: ${r.path}\nDispatch prompt: "Read ${r.path} and follow it."${left}`;
    }));

  common(review.command('record').argument('<task>'))
    .requiredOption('--lens <reviewer>', 'The reviewer whose review this is')
    .option('--file <path>', 'The raw review, verbatim (default: the round\'s r<N>-<lens>.md in the loop folder)')
    .option('--abandon', 'The review did not land: mark it ABANDONED')
    .option('--note <why>', 'With --abandon: why')
    .description('Record a reviewer\'s raw review (parsed; a malformed one is UNPARSED and re-dispatched)')
    .action((task: string, o: Common & { lens: string; file?: string; abandon?: boolean; note?: string }) => run(() => reviewRecord(depsFor(o.repo), task, o.loop, o.lens, o)));

  common(review.command('status').argument('<task>'))
    .option('--json', 'Emit the state as JSON')
    .description('Round, reviewers, open findings by class, and the ONE next action')
    .action((task: string, o: Common & { json?: boolean }) => run(() => {
      const r = reviewStatus(depsFor(o.repo), task, o.loop);
      return o.json ? JSON.stringify(r.json, null, 2) : r.text;
    }));

  common(review.command('decide').argument('<task>').argument('<decision>', DECIDE_KINDS.filter((k) => k !== 'add').join(' | ')))
    .requiredOption('--note <words>', 'The owner\'s words')
    .option('--finding <id>', 'accept: the Major finding the owner accepts')
    .option('--cancel-task', 'abandon: also cancel the task (required while a Critical is open)')
    .option('--task <slug>', 'split: the follow-up task that takes the moved findings')
    .option('--class <class>', 'split: a whole class to move (repeatable)', collect)
    .description('Record the owner\'s decision at a stop card: continue | narrow | split | accept | abandon')
    .action((task: string, decision: string, o: Common & { note: string; finding?: string; cancelTask?: boolean; task?: string; class?: string[] }) => run(() =>
      reviewDecide(depsFor(o.repo), task, o.loop, decision, { note: o.note, finding: o.finding, cancelTask: o.cancelTask, task: o.task, classes: o.class })));

  common(review.command('merge-class').argument('<task>').argument('<from>').argument('<into>'))
    .description('Merge one finding class into another (counts only grow)')
    .action((task: string, from: string, into: string, o: Common) => run(() => reviewMergeClass(depsFor(o.repo), task, o.loop, from, into)));
}

export { PlanStoreError };
