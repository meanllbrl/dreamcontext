import { Command } from 'commander';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ensureContextRoot } from '../../lib/context-path.js';
import { error, info, success } from '../../lib/format.js';
import { today } from '../../lib/id.js';
import { loadStatuses } from '../../lib/overrides.js';
import { prepareSectionInsert, SECTION_MAP } from '../../lib/section-insert.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import type { TaskBackend } from '../../lib/task-backend/types.js';
import { cliStatusAuthor, statusChangeEntry } from '../../lib/task-history.js';
import {
  changesLines, classResolver, computePlanState, FIXED_SECOND_LENSES, nextSeq, normClass, ownerOf, parseReview, planGateGaps, planSection,
  pragmatistAllowed, renderNextAction, renderStopCard, PLAN_BUDGET_BASE, PLAN_LEDGER_VERSION, PLAN_LENSES,
  type FindingLevel, type Ledger, type LedgerEvent, type LedgerRound, type PlanState,
} from '../../lib/plan-ledger.js';
import { PLAN_REVIEW_RULES } from '../../lib/plan-review-rules.js';
import {
  assertSafePath, ensurePlansDir, ledgerPath, packetPath, planDir, planFilePath, PlanStoreError, readExternalNoLink,
  readLedger, readPlanLedgers, readSafe, reviewPath, sha, snapshotPath, withPlanLock, writeLedger, writeSafe,
} from '../../lib/plan-store.js';

/**
 * `dreamcontext plan …` — the planning loop's ledger, packet, stops and gate.
 *
 * The lead never hand-writes a review prompt or counts rounds in its head: `open` binds a plan
 * to its task, `packet` prints what a lens reads (and opens a round only when nothing stops
 * it), `record` parses the lens's raw review into the ledger, `status` says the ONE next
 * action, `decide` records the owner's words, `link` writes the reviewed plan into the task.
 * State is computed (lib/plan-ledger.ts); files are lib/plan-store.ts. Every capability is a
 * CLI verb, so Claude Code, Codex and Antigravity run the same loop unchanged.
 */

export class PlanRefusal extends Error {}

export interface PlanDeps {
  root: string;
  now: () => Date;
  backend: () => TaskBackend;
}

const SECOND_LENSES: readonly string[] = FIXED_SECOND_LENSES;
const COMPLETE = ['SOLID', 'NEEDS_WORK'];

function loadLedger(deps: PlanDeps, plan: string): Ledger {
  const r = readLedger(deps.root, plan);
  if (!r.ok) {
    if (r.missing) throw new PlanRefusal(`No plan "${plan}". Start one with \`dreamcontext plan open ${plan} --task <slug> --goal "…" --lenses critic,<security|edge-cases>\`.`);
    throw new PlanRefusal(`The plan ledger cannot be read, so nothing runs on it: ${r.problem}. Repair it, or move the folder out of tmp/plans/.`);
  }
  return r.ledger;
}

/** Keep the ledger's `budget` field a true copy of the computed budget, then write. */
function save(deps: PlanDeps, ledger: Ledger): PlanState {
  const s = computePlanState(ledger);
  ledger.budget = { base: ledger.budget.base, extra: s.budget.extra, unlimited: s.budget.unlimited };
  writeLedger(deps.root, ledger);
  return s;
}

function event(deps: PlanDeps, ledger: Ledger, kind: LedgerEvent['kind'], extra: Partial<LedgerEvent> = {}): LedgerEvent {
  const e: LedgerEvent = { at: deps.now().toISOString(), round: ledger.rounds.length, kind, ...extra, seq: nextSeq(ledger) };
  ledger.events.push(e);
  return e;
}

const latestRound = (ledger: Ledger): LedgerRound | undefined => [...ledger.rounds].sort((a, b) => a.n - b.n).pop();

// ─── open ───────────────────────────────────────────────────────────────────

export async function planOpen(deps: PlanDeps, plan: string, opts: { task: string; goal: string; lenses: string }): Promise<string> {
  planDir(deps.root, plan); // validates the name
  const lenses = opts.lenses.split(',').map((s) => s.trim()).filter(Boolean);
  if (lenses.length !== 2 || lenses[0] !== 'critic' || !SECOND_LENSES.includes(lenses[1])) {
    throw new PlanRefusal('--lenses must be the fixed pair: critic,security (auth, money, secrets, migrations, outbound messages) or critic,edge-cases.');
  }
  if (!opts.goal?.trim()) throw new PlanRefusal('--goal "<one sentence>" is required.');
  const task = await deps.backend().get(opts.task);
  if (!task) throw new PlanRefusal(`No task "${opts.task}". Plan mode creates the task at intake: \`dreamcontext tasks create "<goal>"\`, then name it here.`);
  return withPlanLock(deps.root, plan, () => {
    const existing = readLedger(deps.root, plan);
    if (existing.ok || !existing.missing) throw new PlanRefusal(`Plan "${plan}" already exists: \`dreamcontext plan status ${plan}\`.`);
    for (const r of readPlanLedgers(deps.root)) {
      if (!r.ok || r.ledger.task !== opts.task) continue;
      const s = computePlanState(r.ledger);
      if (!s.done && !s.abandoned) throw new PlanRefusal(`Task ${opts.task} already has a live plan "${r.ledger.plan}" (not done, not abandoned): \`dreamcontext plan status ${r.ledger.plan}\`.`);
    }
    const now = deps.now().toISOString();
    const ledger: Ledger = {
      v: PLAN_LEDGER_VERSION, plan, goal: opts.goal.trim(), task: opts.task, lenses,
      budget: { base: PLAN_BUDGET_BASE, extra: 0, unlimited: false }, createdAt: now, seq: 0, events: [], rounds: [],
    };
    ensurePlansDir(deps.root);
    const dir = planDir(deps.root, plan);
    const body = JSON.stringify(ledger, null, 2) + '\n';
    if (existsSync(dir)) {
      writeSafe(deps.root, ledgerPath(deps.root, plan), body); // a folder the lead made first: the ledger lands atomically
    } else {
      // Folder and ledger appear in one rename: a folder without a ledger is not a plan.
      const tmp = join(dir, '..', `.${plan}.${process.pid}.${Date.now()}.tmp`);
      assertSafePath(deps.root, join(dir, '..'));
      mkdirSync(tmp);
      try {
        writeFileSync(join(tmp, 'ledger.json'), body);
        renameSync(tmp, dir);
      } catch (err) {
        rmSync(tmp, { recursive: true, force: true });
        throw err;
      }
    }
    return [
      `Plan ${plan} opened for task ${opts.task} (lenses ${lenses.join(' + ')}, budget ${PLAN_BUDGET_BASE} rounds).`,
      `Write the plan to ${planFilePath(deps.root, plan)}, then in ONE message: \`dreamcontext plan packet ${plan} --lens critic\`, \`--lens ${lenses[1]}\` and (round 1) \`--lens pragmatist\`.`,
    ].join('\n');
  });
}

// ─── packet ─────────────────────────────────────────────────────────────────

export interface PacketInput {
  ledger: Ledger;
  state: PlanState;
  round: number;
  lens: string;
  snapshotFile: string;
  snapshotText: string;
  prevReviews: Array<{ name: string; text: string }>;
}

/** Everything a lens reads, in one text. The lead adds only the lens name. */
export function buildPacketText(p: PacketInput): string {
  const sect = (title: string): string => planSection(p.snapshotText, title) || '(none written)';
  const own = p.state.open.filter((f) => f.lens === p.lens);
  const line = (f: { id: string; level: FindingLevel; cls: string; lens: string }): string => `- ${f.id} [${f.level}] class: ${f.cls} (${f.lens})`;
  const out = [
    `# Plan review packet: ${p.ledger.plan}, round ${p.round}, lens ${p.lens}`,
    '',
    `Task: ${p.ledger.task}. Goal: ${p.ledger.goal}`,
    `Plan snapshot (review THIS file, whole): ${p.snapshotFile}`,
    '',
    '## Decisions', sect('Decisions'), '',
    '## Out of scope', sect('Out of scope'), '',
    '## Environment', sect('Environment'), '',
    '## Changes in this revision', sect('Changes in this revision'), '',
    `## Previous round${p.prevReviews.length > 0 ? ` (r${p.round - 1})` : ''}: raw reviews of every lens, verbatim`,
  ];
  if (p.prevReviews.length === 0) out.push('(none: this is the first round)');
  for (const r of p.prevReviews) out.push('', `### ${r.name}`, '', r.text.trim());
  out.push(
    '',
    '## Open findings (ids)',
    ...(p.state.open.length > 0 ? p.state.open.map(line) : ['(none)']),
    '',
    '## Owner-accepted ids (not findings; re-list one only at a higher level)',
    ...(p.state.accepted.length > 0 ? p.state.accepted.map((id) => `- ${id}`) : ['(none)']),
  );
  if (p.state.splitPending || p.state.moved.length > 0) {
    out.push('', '## Moved by a split (each owed to its lens: `closed: <id> | cut` when the plan no longer carries it, else re-state it)',
      ...p.state.moved.map((id) => `- ${id} (${ownerOf(id) ?? '?'})`));
  }
  out.push(
    '',
    '## Known classes (reuse a name when it fits)',
    ...(p.state.knownClasses.length > 0 ? p.state.knownClasses.map((c) => `- ${c} (${p.state.classCounts[c] ?? 0} counted round${(p.state.classCounts[c] ?? 0) === 1 ? '' : 's'})`) : ['(none yet)']),
    '',
    PLAN_REVIEW_RULES,
    '',
    '## Your output',
    p.lens === 'pragmatist'
      ? 'Lens: pragmatist (scope: what is worth it in v1, a premise to question). First line `PROPOSALS`, then proposal lines. You never block.'
      : `Lens: ${p.lens}. Your own open ids: ${own.length > 0 ? own.map((f) => f.id).join(', ') : 'none'}. Each is re-stated or closed.`,
    'Reply with the review only; the lead saves it verbatim and records it.',
  );
  return out.join('\n') + '\n';
}

export async function planPacket(deps: PlanDeps, plan: string, lens: string): Promise<{ text: string; path: string; round: number; opened: boolean }> {
  if (!(PLAN_LENSES as readonly string[]).includes(lens)) throw new PlanRefusal(`--lens must be one of ${PLAN_LENSES.join(', ')}.`);
  return withPlanLock(deps.root, plan, () => {
    const ledger = loadLedger(deps, plan);
    let state = computePlanState(ledger);
    if (state.abandoned) throw new PlanRefusal(`Plan ${plan} was abandoned; nothing more is reviewed on it.`);
    if (state.done) throw new PlanRefusal(`Plan ${plan} is done (both lenses SOLID, nothing open). Next: \`dreamcontext plan link ${plan}\`.`);
    const fixed = ledger.lenses;
    if (lens !== 'pragmatist' && !fixed.includes(lens)) throw new PlanRefusal(`This plan's lenses are ${fixed.join(' + ')} (chosen at open).`);
    const now = deps.now().toISOString();
    let round = latestRound(ledger);
    let opened = false;

    if (round && !state.roundComplete) {
      const rec = round.lenses[lens];
      if (lens === 'pragmatist') {
        if (!pragmatistAllowed(ledger, round.n)) throw new PlanRefusal('The pragmatist joins only round 1 and the round after an owner addition (`plan decide add`).');
        if (rec && !['PENDING', 'UNPARSED', 'ABANDONED'].includes(rec.verdict)) throw new PlanRefusal(`The pragmatist already reported in round ${round.n}.`);
      } else if (rec && COMPLETE.includes(rec.verdict)) {
        throw new PlanRefusal(`${lens} already reported in round ${round.n} (${rec.verdict}); waiting on ${state.next.kind === 'review' ? state.next.lenses.join(', ') : 'nothing'}.`);
      }
      if (!rec || rec.verdict !== 'PENDING') round.lenses[lens] = { verdict: 'PENDING', dispatchedAt: now, findings: [], seq: nextSeq(ledger) };
    } else {
      if (lens === 'pragmatist') throw new PlanRefusal('A pragmatist packet never opens a round: run the fixed lenses\' packets first, then the pragmatist in the same message.');
      const blocking = state.stops.filter((s) => s.kind !== 'redesign');
      if (blocking.length > 0) throw new PlanRefusal(`The next round is refused: a stop stands. Ask the owner (an owner card; a Super Agent never answers it):\n\n${renderStopCard(ledger, state)}`);
      const planPath = planFilePath(deps.root, plan);
      if (!existsSync(planPath)) throw new PlanRefusal(`Write the plan first: ${planPath}`);
      const text = readSafe(deps.root, planPath);
      const digest = sha(text);
      if (round && round.snapshotSha === digest) throw new PlanRefusal(`plan.md is unchanged since round ${round.n}'s snapshot: revise it first (\`dreamcontext plan status ${plan}\` prints the recipe).`);
      const redesigns = state.stops.filter((s) => s.kind === 'redesign').map((s) => s.cls!);
      const named = new Set(changesLines(text, 'redesign').map(normClass));
      const missing = redesigns.filter((c) => !named.has(c));
      if (missing.length > 0) {
        throw new PlanRefusal(`Redesign first: ${missing.length === 1 ? 'this class is' : 'these classes are'} in a 2nd counted round. \`## Changes in this revision\` must carry:\n${missing.map((c) => `  redesign: ${c} | <the new layer that covers the whole class>`).join('\n')}`);
      }
      if (state.splitPending) {
        const splitNamed = new Set(changesLines(text, 'split').flatMap((l) => l.split(',')).map(normClass));
        const notNamed = state.splitPending.classes.filter((c) => !splitNamed.has(c));
        if (notNamed.length > 0) throw new PlanRefusal(`After the split, \`## Changes in this revision\` must carry: split: ${state.splitPending.classes.join(', ')} | <what was cut>`);
      }
      for (const cls of redesigns) event(deps, ledger, 'redesign', { cls });
      const n = (round?.n ?? 0) + 1;
      writeSafe(deps.root, snapshotPath(deps.root, plan, n), text);
      const openSeq = nextSeq(ledger);
      const lenses: LedgerRound['lenses'] = {};
      for (const l of fixed) lenses[l] = { verdict: 'PENDING', dispatchedAt: now, findings: [], seq: openSeq };
      round = { n, openedAt: now, snapshotSha: digest, openSeq, lenses };
      ledger.rounds.push(round);
      opened = true;
    }
    state = save(deps, ledger);
    const prevReviews: PacketInput['prevReviews'] = [];
    const prev = ledger.rounds.find((r) => r.n === round!.n - 1);
    for (const l of prev ? Object.keys(prev.lenses) : []) {
      const p = reviewPath(deps.root, plan, prev!.n, l);
      if (existsSync(p)) prevReviews.push({ name: `r${prev!.n}-${l}.md`, text: readSafe(deps.root, p) });
    }
    const snapFile = snapshotPath(deps.root, plan, round.n);
    const text = buildPacketText({ ledger, state, round: round.n, lens, snapshotFile: snapFile, snapshotText: readSafe(deps.root, snapFile), prevReviews });
    const path = packetPath(deps.root, plan, round.n, lens);
    writeSafe(deps.root, path, text);
    return { text, path, round: round.n, opened };
  });
}

// ─── record ─────────────────────────────────────────────────────────────────

export async function planRecord(deps: PlanDeps, plan: string, lens: string, opts: { file?: string; abandon?: boolean; note?: string }): Promise<string> {
  if (!(PLAN_LENSES as readonly string[]).includes(lens)) throw new PlanRefusal(`--lens must be one of ${PLAN_LENSES.join(', ')}.`);
  return withPlanLock(deps.root, plan, () => {
    const ledger = loadLedger(deps, plan);
    const before = computePlanState(ledger);
    if (before.abandoned) throw new PlanRefusal(`Plan ${plan} was abandoned.`);
    const round = latestRound(ledger);
    const rec = round?.lenses[lens];
    if (!round || !rec || rec.verdict !== 'PENDING') {
      throw new PlanRefusal(`${lens} is not PENDING in an open round of ${plan}: run \`dreamcontext plan packet ${plan} --lens ${lens}\` first.`);
    }
    const now = deps.now().toISOString();
    if (opts.abandon) {
      if (!opts.note?.trim()) throw new PlanRefusal('--abandon needs --note "<why the review did not land>".');
      round.lenses[lens] = { ...rec, verdict: 'ABANDONED', note: opts.note.trim(), recordedAt: now, seq: nextSeq(ledger) };
      save(deps, ledger);
      return `${lens} marked ABANDONED in round ${round.n} (not counted). Re-dispatch it: \`dreamcontext plan packet ${plan} --lens ${lens}\`.`;
    }
    const target = reviewPath(deps.root, plan, round.n, lens);
    const file = opts.file ? resolve(opts.file) : target;
    const inVault = !relative(deps.root, file).startsWith('..') && !isAbsolute(relative(deps.root, file));
    const text = inVault ? readSafe(deps.root, file) : readExternalNoLink(file);
    const ownOpen = new Map<string, FindingLevel>(before.open.filter((f) => f.lens === lens).map((f) => [f.id, f.level]));
    const otherOpen = new Set(before.open.filter((f) => f.lens !== lens).map((f) => f.id));
    const parsed = parseReview(text, { round: round.n, lens, ownOpen, otherOpen, accepted: new Set(before.accepted), cut: new Set(before.cut) });
    if (file !== target) writeSafe(deps.root, target, text);
    round.lenses[lens] = {
      ...rec,
      verdict: parsed.verdict,
      file: `r${round.n}-${lens}.md`,
      findings: parsed.findings,
      closed: parsed.closed,
      ...(parsed.proposals.length > 0 ? { proposals: parsed.proposals } : {}),
      ...(parsed.errors.length > 0 ? { note: parsed.errors.join('; ') } : {}),
      recordedAt: now,
      seq: nextSeq(ledger),
    };
    const after = save(deps, ledger);
    if (parsed.verdict === 'UNPARSED') {
      return [
        `${lens}'s review is UNPARSED (round ${round.n}, not counted):`,
        ...parsed.errors.map((e) => `- ${e}`),
        `Re-dispatch it into the same round: \`dreamcontext plan packet ${plan} --lens ${lens}\`.`,
      ].join('\n');
    }
    const counts = parsed.findings.length > 0 ? `, ${parsed.findings.length} blocking (${parsed.findings.map((f) => `${f.id} ${f.level}`).join(', ')})` : '';
    return `Recorded ${lens} ${parsed.verdict} for round ${round.n}${counts}.\n${renderNextAction(ledger, after)}`;
  });
}

// ─── status ─────────────────────────────────────────────────────────────────

export interface PlanStatusResult { state: PlanState; text: string; json: Record<string, unknown> }

export function planStatus(deps: PlanDeps, plan: string): PlanStatusResult {
  const ledger = loadLedger(deps, plan);
  const s = computePlanState(ledger);
  const flags: string[] = [];
  const latest = latestRound(ledger);
  const splitMoved = new Set(ledger.events.filter((e) => e.kind === 'split').flatMap((e) => e.moved ?? []));
  for (const r of ledger.rounds) {
    for (const l of ledger.lenses) {
      for (const c of r.lenses[l]?.closed ?? []) {
        if (splitMoved.has(c.id) && !/^cut\b/i.test(c.why)) flags.push(`moved id ${c.id} was closed "${c.why}", not \`cut\`: its follow-up criterion is now a duplicate; remove it from the follow-up task.`);
      }
    }
  }
  if (!s.splitPending) {
    for (const id of s.moved) if (s.open.some((f) => f.id === id)) flags.push(`moved id ${id} was re-stated after the split: it is open on this plan AND a criterion of the follow-up task.`);
  }
  const prag = [...ledger.rounds].sort((a, b) => b.n - a.n).find((r) => r.lenses.pragmatist?.proposals?.length);
  const proposals = prag && latest && prag.n === latest.n ? prag.lenses.pragmatist!.proposals! : [];
  const byClass = new Map<string, string[]>();
  for (const f of s.open) byClass.set(f.cls, [...(byClass.get(f.cls) ?? []), `${f.id} ${f.level} (${f.lens})`]);
  const lines = [
    `Plan ${plan} → task ${ledger.task}`,
    `Round ${s.round}${s.round > 0 ? (s.roundComplete ? ' (complete)' : ' (in progress)') : ''}. ${s.budget.unlimited ? `Budget: unlimited (owner: Devam), ${s.latestComplete} used.` : `Budget: ${s.latestComplete} / ${s.budget.limit} rounds used.`}`,
    `Lenses: ${Object.entries(s.verdicts).map(([l, v]) => `${l} ${v}`).join(', ')}`,
    'Open findings by class:',
    ...(byClass.size > 0 ? [...byClass].map(([c, ids]) => `- ${c} [${s.classCounts[c] ?? 0} counted round${(s.classCounts[c] ?? 0) === 1 ? '' : 's'}]: ${ids.join(', ')}`) : ['- none']),
    ...(s.accepted.length > 0 ? [`Owner-accepted: ${s.accepted.join(', ')}`] : []),
    ...flags.map((f) => `! ${f}`),
    ...(proposals.length > 0 ? ['Pragmatist proposals (for the owner, with your next summary):', ...proposals.map((p) => `- ${p}`)] : []),
    '',
    renderNextAction(ledger, s),
  ];
  const json = {
    plan, task: ledger.task, goal: ledger.goal, lenses: ledger.lenses, round: s.round, roundComplete: s.roundComplete,
    budget: s.budget, verdicts: s.verdicts, open: s.open, accepted: s.accepted, moved: s.moved, cut: s.cut,
    classCounts: s.classCounts, stops: s.stops, done: s.done, abandoned: s.abandoned, next: s.next.kind,
    nextText: renderNextAction(ledger, s), flags, proposals,
    ...(s.next.kind === 'stop' ? { card: renderStopCard(ledger, s) } : {}),
  };
  return { state: s, text: lines.join('\n'), json };
}

// ─── decide / merge-class ───────────────────────────────────────────────────

export type DecideKind = 'continue' | 'narrow' | 'accept' | 'add' | 'abandon' | 'split';
export const DECIDE_KINDS: readonly DecideKind[] = ['continue', 'narrow', 'accept', 'add', 'abandon', 'split'];

export interface DecideOpts { note?: string; finding?: string; cancelTask?: boolean; task?: string; classes?: string[] }

export async function planDecide(deps: PlanDeps, plan: string, kind: string, opts: DecideOpts): Promise<string> {
  if (!(DECIDE_KINDS as readonly string[]).includes(kind)) throw new PlanRefusal(`Decision must be one of ${DECIDE_KINDS.join(', ')}.`);
  if (!opts.note?.trim()) throw new PlanRefusal('--note "<the owner\'s words>" is required: a decision is the owner\'s.');
  const note = opts.note.trim();
  return withPlanLock(deps.root, plan, async () => {
    const ledger = loadLedger(deps, plan);
    const s = computePlanState(ledger);
    if (s.abandoned) throw new PlanRefusal(`Plan ${plan} was abandoned.`);
    switch (kind as DecideKind) {
      case 'accept': {
        const id = opts.finding?.trim();
        const f = s.open.find((x) => x.id === id);
        if (!id || !f) throw new PlanRefusal(`--finding <id> must name an open finding (${s.open.map((x) => x.id).join(', ') || 'none open'}).`);
        if (f.level === 'Critical') throw new PlanRefusal(`${id} is Critical: a Critical cannot be accepted. Fix it, or cut its part (narrow/split).`);
        event(deps, ledger, 'accept', { finding: id, note });
        save(deps, ledger);
        return `Accepted ${id} (Major) on the owner's word. It stays out of the open set unless a lens re-lists it at a higher level.`;
      }
      case 'add': {
        event(deps, ledger, 'add', { note });
        save(deps, ledger);
        return `Owner addition recorded: rewrite the plan whole; the pragmatist joins the next round. Rounds keep counting (${s.latestComplete} used).`;
      }
      case 'continue':
      case 'narrow': {
        const cleared = s.stops.filter((x) => x.kind !== 'redesign');
        event(deps, ledger, kind as 'continue' | 'narrow', { note });
        const after = save(deps, ledger);
        return `${kind === 'continue' ? 'Devam: rounds are unlimited for this plan; a recurring class still stops it.' : 'Daralt: cut the feature carrying the class, open a follow-up task for it, rewrite the plan whole.'}${cleared.length > 0 ? ` Cleared: ${cleared.map((x) => x.kind + (x.cls ? ` "${x.cls}"` : '')).join(', ')}.` : ''}\n${renderNextAction(ledger, after)}`;
      }
      case 'abandon': {
        const crit = [...new Set([...s.open.filter((f) => f.level === 'Critical').map((f) => f.id), ...s.pendingCriticals])];
        if (crit.length > 0 && !opts.cancelTask) {
          throw new PlanRefusal(`An open Critical (${crit.join(', ')}) cannot be dropped by abandoning the plan. Fix it, or abandon with --cancel-task (the task ${ledger.task} is cancelled with it).`);
        }
        if (opts.cancelTask) await cancelTask(deps, ledger.task, note);
        event(deps, ledger, 'abandon', { note });
        save(deps, ledger);
        return `Plan ${plan} abandoned${opts.cancelTask ? ` and task ${ledger.task} cancelled` : ''}. The gate skips it; \`plan open --task\` may start a new plan.`;
      }
      case 'split':
        return splitPlan(deps, ledger, s, note, opts);
    }
  });
}

async function cancelTask(deps: PlanDeps, slug: string, note: string): Promise<void> {
  const defs = loadStatuses(deps.root);
  const key = defs.find((d) => d.kind === 'cancelled')?.key;
  if (!key) throw new PlanRefusal('This project declares no cancelled-kind task status, so --cancel-task cannot run.');
  const backend = deps.backend();
  await backend.addChangelog(slug, statusChangeEntry(key, cliStatusAuthor(), defs, `plan abandoned: ${note}`), { createIfMissing: true });
  await backend.updateFields(slug, { status: key, updated_at: today() });
}

async function splitPlan(deps: PlanDeps, ledger: Ledger, s: PlanState, note: string, opts: DecideOpts): Promise<string> {
  const latest = latestRound(ledger);
  if (latest && !s.roundComplete) throw new PlanRefusal('A split waits for the round in progress to complete (stops stand only between rounds).');
  const follow = opts.task?.trim();
  if (!follow) throw new PlanRefusal('split needs --task <follow-up-task> (create it first).');
  if (follow === ledger.task) throw new PlanRefusal('The follow-up task must differ from this plan\'s task.');
  const backend = deps.backend();
  const target = await backend.get(follow);
  if (!target) throw new PlanRefusal(`No task "${follow}": create the follow-up task first.`);
  const classes = [...new Set((opts.classes ?? []).map(normClass))];
  if (classes.length === 0) throw new PlanRefusal('split needs --class <class> (repeatable): the whole classes to move.');
  const moved = s.open.filter((f) => classes.includes(f.cls));
  const empty = classes.filter((c) => !moved.some((f) => f.cls === c));
  if (empty.length > 0) throw new PlanRefusal(`No open finding of class ${empty.map((c) => `"${c}"`).join(', ')}: a split moves open findings.`);
  // Criteria first, the split event last: a crash leaves the ids open, and a re-run skips a
  // criterion already present for an id.
  const sectionName = SECTION_MAP.acceptance_criteria;
  const existing = target.acceptance_criteria ?? '';
  let inserted = 0;
  const planRel = relative(deps.root, planDir(deps.root, ledger.plan));
  for (const f of moved) {
    // Ids repeat across plans (every plan has an r1-critic-1): a criterion is this plan's only
    // when its line also names this plan's folder.
    const mine = existing.split('\n').some((l) => l.includes(`Resolve plan finding ${f.id} `) && l.includes(`raw review ${planRel}/`));
    if (mine) continue;
    const raw = join(planRel, `r${f.round}-${f.lens}.md`);
    const sentence = (f.text ?? '').replace(/\s+/g, ' ').trim() || '(see the raw review)';
    const prep = prepareSectionInsert('acceptance_criteria', `Resolve plan finding ${f.id} (${f.level}, ${f.cls}): ${sentence}; raw review ${raw}`, today())!;
    await backend.insertSection(follow, sectionName, prep.content, { position: prep.position, replacePlaceholders: prep.replacePlaceholders });
    inserted += 1;
  }
  event(deps, ledger, 'split', { note, classes, moved: moved.map((f) => f.id), task: follow });
  const after = save(deps, ledger);
  return [
    `Böl: ${moved.length} finding${moved.length === 1 ? '' : 's'} (${moved.map((f) => f.id).join(', ')}) moved to ${follow} as criteria (${inserted} inserted).`,
    renderNextAction(ledger, after),
  ].join('\n');
}

export async function planMergeClass(deps: PlanDeps, plan: string, from: string, into: string): Promise<string> {
  const a = normClass(from);
  const b = normClass(into);
  if (!a || !b || a === b) throw new PlanRefusal('merge-class needs two different class names.');
  return withPlanLock(deps.root, plan, () => {
    const ledger = loadLedger(deps, plan);
    const s = computePlanState(ledger);
    if (!s.knownClasses.includes(a)) throw new PlanRefusal(`"${a}" is not a known class of ${plan} (${s.knownClasses.join(', ') || 'none'}).`);
    // Merge into the class `into` already resolves to, and never back into `from`: a cycle
    // (a→b, then b→a) would split the counts again, which is the rename-to-dodge a merge exists to stop.
    const target = classResolver(ledger.events)(b);
    if (target === a) throw new PlanRefusal(`"${b}" already resolves to "${a}": merging back would split the counts. Merge only grows counts.`);
    event(deps, ledger, 'merge', { cls: a, into: target });
    const after = save(deps, ledger);
    return `Merged "${a}" into "${target}": ${after.classCounts[target] ?? 0} counted round(s). A merge only ever grows a count.`;
  });
}

// ─── link ───────────────────────────────────────────────────────────────────

const blockRe = (plan: string): RegExp => new RegExp(`<!-- dreamcontext-plan:${plan} sha:([0-9a-f]+) -->[\\s\\S]*?<!-- /dreamcontext-plan:${plan} -->`);

export async function planLink(deps: PlanDeps, plan: string): Promise<string> {
  return withPlanLock(deps.root, plan, async () => {
    const ledger = loadLedger(deps, plan);
    const gaps = planGateGaps(readPlanLedgers(deps.root), ledger.task);
    if (gaps.length > 0) throw new PlanRefusal(`Not linked: the plan gate refuses ${ledger.task}:\n${gaps.map((g) => `- ${g.problem}`).join('\n')}`);
    const s = computePlanState(ledger);
    if (s.abandoned) throw new PlanRefusal(`Plan ${plan} was abandoned; it is never linked.`);
    const snapFile = snapshotPath(deps.root, plan, s.latestComplete);
    const snap = readSafe(deps.root, snapFile);
    const digest = sha(snap).slice(0, 16);
    const sect = (t: string): string => planSection(snap, t) || '(none written)';
    const block = [
      `<!-- dreamcontext-plan:${plan} sha:${digest} -->`,
      `Reviewed plan ${plan}: round ${s.latestComplete}, ${ledger.lenses.join(' + ')} SOLID. Full plan: ${relative(deps.root, snapFile)} (machine-local).`,
      '', '### Contracts', sect('Contracts'),
      '', '### Wave map', sect('Wave map'),
      '', '### Build notes', sect('Build notes'),
      `<!-- /dreamcontext-plan:${plan} -->`,
    ].join('\n');
    const backend = deps.backend();
    const task = await backend.get(ledger.task);
    if (!task) throw new PlanRefusal(`Task ${ledger.task} no longer exists.`);
    const re = blockRe(plan);
    const found = re.exec(task.rawBody ?? '');
    if (found && found[1] === digest) return `Already linked: ${ledger.task} carries this snapshot (round ${s.latestComplete}).`;
    if (found) {
      await backend.updateFields(ledger.task, { updated_at: today() }, { body: (task.rawBody ?? '').replace(re, () => block) });
      return `Re-linked ${plan} into ${ledger.task} (snapshot of round ${s.latestComplete} replaces the earlier block).`;
    }
    await backend.insertSection(ledger.task, SECTION_MAP.technical_details, block, { position: 'bottom', replacePlaceholders: true });
    await backend.updateFields(ledger.task, { updated_at: today() });
    return `Linked ${plan} into ${ledger.task}'s technical details (round ${s.latestComplete} snapshot). Next: \`dreamcontext tasks ready ${ledger.task}\`.`;
  });
}

// ─── Commander ──────────────────────────────────────────────────────────────

function defaultDeps(): PlanDeps {
  const root = ensureContextRoot();
  return { root, now: () => new Date(), backend: () => getTaskBackend(root) };
}

async function run(fn: () => Promise<string | void> | string | void): Promise<void> {
  try {
    const out = await fn();
    if (out) console.log(out);
  } catch (err) {
    if (err instanceof PlanRefusal || err instanceof PlanStoreError) {
      error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

export function registerPlanCommand(program: Command): void {
  const plan = program
    .command('plan')
    .description('Plan review loop: ledger, packet, stops and the gate into Develop (open/packet/record/status/decide/merge-class/link)');

  plan
    .command('open')
    .argument('<plan>', 'Plan name ([a-z0-9-], 1-80)')
    .requiredOption('--task <slug>', 'The task this plan builds (created at intake)')
    .requiredOption('--goal <sentence>', 'The goal in one sentence')
    .requiredOption('--lenses <pair>', 'The fixed pair: critic,security or critic,edge-cases')
    .description('Open a plan: its folder and ledger under tmp/plans/, bound to a task')
    .action((name: string, opts: { task: string; goal: string; lenses: string }) => run(() => planOpen(defaultDeps(), name, opts)));

  plan
    .command('packet')
    .argument('<plan>')
    .requiredOption('--lens <lens>', 'critic | security | edge-cases | pragmatist')
    .option('--print', 'Print the whole packet instead of its path')
    .description('Write the review packet a lens reads; opens the next round when nothing stops it')
    .action((name: string, opts: { lens: string; print?: boolean }) => run(async () => {
      const r = await planPacket(defaultDeps(), name, opts.lens);
      if (opts.print) return r.text;
      return `${r.opened ? `Round ${r.round} opened.` : `Round ${r.round}.`} Packet for ${opts.lens}: ${r.path}\nDispatch prompt: "Lens: ${opts.lens}. Read ${r.path} and follow it."`;
    }));

  plan
    .command('record')
    .argument('<plan>')
    .requiredOption('--lens <lens>', 'The lens whose review this is')
    .option('--file <path>', 'The raw review, verbatim (default: the round\'s r<N>-<lens>.md in the plan folder)')
    .option('--abandon', 'The review did not land (died, ran out of turns): mark it ABANDONED')
    .option('--note <why>', 'With --abandon: why')
    .description('Record a lens\'s raw review into the ledger (parsed; a malformed one is UNPARSED and re-dispatched)')
    .action((name: string, opts: { lens: string; file?: string; abandon?: boolean; note?: string }) => run(() => planRecord(defaultDeps(), name, opts.lens, opts)));

  plan
    .command('status')
    .argument('<plan>')
    .option('--json', 'Emit the state as JSON')
    .description('Round, budget, verdicts, open findings by class, and the ONE next action')
    .action((name: string, opts: { json?: boolean }) => run(() => {
      const r = planStatus(defaultDeps(), name);
      return opts.json ? JSON.stringify(r.json, null, 2) : r.text;
    }));

  plan
    .command('decide')
    .argument('<plan>')
    .argument('<decision>', DECIDE_KINDS.join(' | '))
    .requiredOption('--note <words>', 'The owner\'s words')
    .option('--finding <id>', 'accept: the Major finding the owner accepts')
    .option('--cancel-task', 'abandon: also cancel the task (required while a Critical is open)')
    .option('--task <slug>', 'split: the follow-up task that takes the moved findings')
    .option('--class <class>', 'split: a whole class to move (repeatable)', collect)
    .description('Record the owner\'s decision: continue | narrow | accept | add | abandon | split')
    .action((name: string, decision: string, opts: { note: string; finding?: string; cancelTask?: boolean; task?: string; class?: string[] }) => run(() =>
      planDecide(defaultDeps(), name, decision, { note: opts.note, finding: opts.finding, cancelTask: opts.cancelTask, task: opts.task, classes: opts.class })));

  plan
    .command('merge-class')
    .argument('<plan>')
    .argument('<from>')
    .argument('<into>')
    .description('Merge one finding class into another (counts only grow)')
    .action((name: string, from: string, into: string) => run(() => planMergeClass(defaultDeps(), name, from, into)));

  plan
    .command('link')
    .argument('<plan>')
    .description('Write the reviewed plan (final snapshot) into its task\'s technical details; refused while the gate has gaps')
    .action((name: string) => run(() => planLink(defaultDeps(), name)));
}
