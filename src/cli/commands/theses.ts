import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { header, success, error } from '../../lib/format.js';
import { readSetupConfig, updateSetupConfig, isLearningEnabled } from '../../lib/setup-config.js';
import { today } from '../../lib/id.js';
import {
  createThesis,
  getThesis,
  listTheses,
  addPrediction,
  addEvidence,
  setStatus,
  linkThesis,
  unlinkThesis,
  appendChangelogEntry,
  setBlocked,
  promoteThesis,
  thesesDir,
  type ThesisLinkKind,
} from '../../lib/theses/store.js';
import {
  THESIS_STATUSES,
  THESIS_KINDS,
  EVIDENCE_VERDICTS,
  EVIDENCE_SOURCES,
  ThesisError,
  type ThesisStatus,
  type ThesisKind,
  type EvidenceVerdict,
  type EvidenceSource,
  type PredictionStanding,
} from '../../lib/theses/types.js';

/**
 * `dreamcontext theses` — the proactive learning layer CLI. Mirrors `lab`: a
 * thin renderer over the same store the dashboard's `/api/theses*` routes
 * call, so behaviour never drifts between CLI and UI. Gated end-to-end by the
 * `learning.enabled` config switch (default OFF) — commands stay callable
 * when disabled (a dim hint is printed), but sleep dispatch/snapshot/dashboard
 * nav all gate hard on the flag elsewhere.
 */

/** Resolve the project root that holds `_dream_context/` (config file location). */
function projectRootFor(contextRoot: string): string {
  return dirname(contextRoot);
}

function handleThesesError(err: unknown): void {
  if (err instanceof ThesisError) {
    error(err.message);
    process.exitCode = 1;
    return;
  }
  error((err as Error).message ?? String(err));
  process.exitCode = 1;
}

/** Prints a one-line dim hint when the layer is off; the command still proceeds. */
function learningHint(contextRoot: string): void {
  const cfg = readSetupConfig(projectRootFor(contextRoot));
  if (!isLearningEnabled(cfg)) {
    console.log(chalk.dim('⚗ Learning layer is off — run `dreamcontext theses enable` to turn it on.'));
  }
}

/** Generic repeatable-option accumulator (mirrors memory.ts's collectVault). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const THESIS_STATUS_COLORS: Record<ThesisStatus, (s: string) => string> = {
  draft: (s) => chalk.gray(s),
  open: (s) => chalk.blue(s),
  validated: (s) => chalk.green(s),
  invalidated: (s) => chalk.red(s),
  retired: (s) => chalk.dim(s),
};

function statusBadge(status: ThesisStatus): string {
  return THESIS_STATUS_COLORS[status](`[${status}]`);
}

function verdictLabel(verdict: EvidenceVerdict): string {
  if (verdict === 'supports') return chalk.green('supports');
  if (verdict === 'contradicts') return chalk.red('contradicts');
  return chalk.dim('no-signal');
}

function standingBadge(standing: PredictionStanding): string {
  if (standing === 'supported') return chalk.green('✓');
  if (standing === 'contradicted') return chalk.red('✕');
  return chalk.dim('○');
}

/** Exactly one of --insight/--objective/--task must be given for link/unlink. */
function resolveLinkKind(opts: {
  insight?: string;
  objective?: string;
  task?: string;
}): { kind: ThesisLinkKind; target: string } | null {
  const picked = [
    opts.insight ? { kind: 'insight' as ThesisLinkKind, target: opts.insight } : null,
    opts.objective ? { kind: 'objective' as ThesisLinkKind, target: opts.objective } : null,
    opts.task ? { kind: 'task' as ThesisLinkKind, target: opts.task } : null,
  ].filter((x): x is { kind: ThesisLinkKind; target: string } => x !== null);
  return picked.length === 1 ? picked[0]! : null;
}

export function registerThesesCommand(program: Command): void {
  const theses = program
    .command('theses')
    .description('Proactive learning layer: falsifiable theses validated across sleep cycles (opt-in — see `dreamcontext theses enable`)');

  theses
    .command('list')
    .description('List theses')
    .option('--status <status>', 'Filter by status: draft|open|validated|invalidated|retired')
    .option('--kind <kind>', 'Filter by kind: observational|experimental')
    .option('--objective <slug>', 'Filter to theses linked to this objective')
    .option('--blocked', 'Only theses blocked on instrumentation')
    .option('--all', 'Include retired theses (excluded by default)')
    .option('--json', 'Emit as JSON')
    .action((opts: { status?: string; kind?: string; objective?: string; blocked?: boolean; all?: boolean; json?: boolean }) => {
      const root = ensureContextRoot();
      learningHint(root);
      let items = listTheses(root);
      if (!opts.all) items = items.filter((t) => t.status !== 'retired');
      if (opts.status) items = items.filter((t) => t.status === opts.status);
      if (opts.kind) items = items.filter((t) => t.kind === opts.kind);
      if (opts.objective) items = items.filter((t) => t.objectives.includes(opts.objective!));
      if (opts.blocked) items = items.filter((t) => t.blocked_on_instrumentation);
      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      console.log(header('Theses (Hypotheses)'));
      if (items.length === 0) {
        console.log(chalk.dim('  (none yet — dreamcontext theses create "<claim>")'));
        return;
      }
      for (const t of items) {
        const glyph = t.kind === 'experimental' ? '⚗' : '👁';
        const pct = Math.round(t.confidence * 100);
        const blockedBadge = t.blocked_on_instrumentation ? chalk.yellow(' ⚑') : '';
        console.log(`  ${statusBadge(t.status)} ${glyph} ${chalk.magentaBright(t.slug)} — ${t.claim} ${chalk.dim(`(${pct}%)`)}${blockedBadge}`);
      }
    });

  theses
    .command('show')
    .argument('<slug>', 'Thesis slug')
    .option('--json', 'Emit as JSON')
    .description('Show a thesis: claim, status, derived confidence, predictions, evidence, links, changelog')
    .action((slug: string, opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      learningHint(root);
      const t = getThesis(root, slug);
      if (!t) {
        error(`Thesis not found: ${slug}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(t, null, 2));
        return;
      }
      console.log(header(`Thesis: ${slug}`));
      console.log(`  claim:       ${t.claim}`);
      console.log(`  status:      ${statusBadge(t.status)}`);
      console.log(`  kind:        ${t.kind}`);
      console.log(`  confidence:  ${(t.confidence * 100).toFixed(1)}%`);
      console.log(`  created by:  ${t.created_by}`);
      console.log(`  cycles:      ${t.cycles_checked}${t.checked_at ? ` (last checked ${t.checked_at})` : ''}`);
      if (t.blocked_on_instrumentation) console.log(chalk.yellow(`  blocked:     needs a metric — ${t.blocked_metric}`));
      if (t.promoted_to) console.log(chalk.green(`  promoted to: ${t.promoted_to}`));

      console.log(`\n  Predictions (${t.predictions.length}):`);
      if (t.predictions.length === 0) console.log(chalk.dim('    (none yet — at least one is required to promote to open)'));
      for (const p of t.predictions) console.log(`    ${standingBadge(p.standing)} [${p.id}] ${p.text}`);

      console.log(`\n  Evidence (${t.evidence.length}, oldest first):`);
      if (t.evidence.length === 0) console.log(chalk.dim('    (none yet)'));
      t.evidence.forEach((e, i) => {
        console.log(
          `    [${i}] ${e.date} · ${verdictLabel(e.verdict)} · ${e.source}${e.ref ? `:${e.ref}` : ''}${e.quantitative ? ' (quant)' : ''}${e.note ? ` — ${e.note}` : ''}`,
        );
      });

      console.log(
        `\n  Links: insights=${t.insights.join(', ') || '(none)'}  objectives=${t.objectives.join(', ') || '(none)'}  tasks=${t.related_tasks.join(', ') || '(none)'}`,
      );

      if (t.changelog.length > 0) {
        console.log(`\n  Understanding changelog (${t.changelog.length} entries, newest first):`);
        for (const c of t.changelog) {
          const label = c.condensed ? 'CONDENSED' : c.cycle !== null ? `CYCLE ${c.cycle}` : 'MANUAL';
          console.log(`    ${chalk.dim(`[${label} · ${c.when}]`)} ${c.text}`);
        }
      }
    });

  theses
    .command('create')
    .argument('<claim...>', 'The falsifiable claim (multiple words OK, no quotes needed)')
    .option('--slug <slug>', 'Kebab-case slug override (default: derived from the claim)')
    .option('--kind <kind>', 'observational|experimental (default observational)')
    .option('--prediction <text>', 'Pre-registered falsifiable prediction (repeatable)', collect, [])
    .option('--insight <slug>', 'Link to an insight slug (repeatable)', collect, [])
    .option('--objective <slug>', 'Link to an objective slug (repeatable)', collect, [])
    .option('--task <slug>', 'Link to a task slug (repeatable)', collect, [])
    .option('--open', 'Promote straight to open — requires at least one --prediction')
    .option('--by <who>', 'user|sleep-learn (default user)', 'user')
    .description('Scaffold a new thesis in theses/<slug>.md (default status: draft)')
    .action((claimParts: string[], opts: {
      slug?: string;
      kind?: string;
      prediction: string[];
      insight: string[];
      objective: string[];
      task: string[];
      open?: boolean;
      by?: string;
    }) => {
      const root = ensureContextRoot();
      learningHint(root);
      const claim = claimParts.join(' ').trim();
      if (!claim) {
        error('A thesis claim is required.');
        process.exitCode = 1;
        return;
      }
      if (opts.kind && !(THESIS_KINDS as readonly string[]).includes(opts.kind)) {
        error(`--kind must be one of: ${THESIS_KINDS.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      if (opts.by && opts.by !== 'user' && opts.by !== 'sleep-learn') {
        error('--by must be "user" or "sleep-learn".');
        process.exitCode = 1;
        return;
      }
      try {
        const t = createThesis(root, {
          slug: opts.slug,
          claim,
          kind: opts.kind as ThesisKind | undefined,
          createdBy: opts.by as 'user' | 'sleep-learn' | undefined,
          predictions: opts.prediction,
          insights: opts.insight,
          objectives: opts.objective,
          relatedTasks: opts.task,
          open: opts.open,
        });
        success(`Thesis created: theses/${t.slug}.md (${t.status})`);
        console.log(chalk.dim(`  Claim: ${t.claim}`));
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('predict')
    .argument('<slug>', 'Thesis slug')
    .argument('<text...>', 'The falsifiable prediction text')
    .description('Add a pre-registered prediction to a thesis')
    .action((slug: string, textParts: string[]) => {
      const root = ensureContextRoot();
      learningHint(root);
      const text = textParts.join(' ').trim();
      if (!text) {
        error('Prediction text is required.');
        process.exitCode = 1;
        return;
      }
      try {
        const t = addPrediction(root, slug, text);
        success(`${slug}: prediction added (${t.predictions.length} total).`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('evidence')
    .argument('<slug>', 'Thesis slug')
    .requiredOption('--verdict <verdict>', 'supports|contradicts|no-signal')
    .requiredOption('--source <source>', 'insight|task|objective|changelog|external')
    .option('--ref <ref>', 'Slug/path/URL of the cited source')
    .option('--note <note>', 'Free-text note')
    .option('--cycle <n>', 'Sleep cycle number this event was recorded in')
    .option('--quantitative', 'Mark as a numeric series/metric-delta event (feeds the workflow-rule promotion threshold)')
    .option('--date <date>', 'Override the recorded date (YYYY-MM-DD, default today)')
    .description('Append a discrete evidence event to the ledger (recomputes derived confidence)')
    .action((slug: string, opts: {
      verdict: string;
      source: string;
      ref?: string;
      note?: string;
      cycle?: string;
      quantitative?: boolean;
      date?: string;
    }) => {
      const root = ensureContextRoot();
      learningHint(root);
      if (!(EVIDENCE_VERDICTS as readonly string[]).includes(opts.verdict)) {
        error(`--verdict must be one of: ${EVIDENCE_VERDICTS.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      if (!(EVIDENCE_SOURCES as readonly string[]).includes(opts.source)) {
        error(`--source must be one of: ${EVIDENCE_SOURCES.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      let cycle: number | null = null;
      if (opts.cycle !== undefined) {
        cycle = Number(opts.cycle);
        if (!Number.isFinite(cycle)) {
          error('--cycle must be a number.');
          process.exitCode = 1;
          return;
        }
      }
      try {
        const t = addEvidence(root, slug, {
          verdict: opts.verdict as EvidenceVerdict,
          source: opts.source as EvidenceSource,
          ref: opts.ref ?? null,
          note: opts.note,
          cycle,
          quantitative: opts.quantitative === true,
          date: opts.date,
        });
        success(`${slug}: evidence added — confidence now ${(t.confidence * 100).toFixed(1)}% (${t.evidence.length} event(s)).`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('status')
    .argument('<slug>', 'Thesis slug')
    .argument('<status>', 'draft|open|validated|invalidated|retired')
    .option('--cite <index>', 'Evidence index (0-based) cited for a manual flip — repeatable', collect, [])
    .option('--prediction <idEqualsStanding>', '"<id>=<standing>" (untested|supported|contradicted) — repeatable', collect, [])
    .option('--force', 'Bypass the manual-flip citation gate (agent/data-driven path)')
    .description('Flip a thesis status — draft→open needs ≥1 prediction; a manual flip to validated/invalidated needs ≥1 --cite unless --force')
    .action((slug: string, status: string, opts: { cite: string[]; prediction: string[]; force?: boolean }) => {
      const root = ensureContextRoot();
      learningHint(root);
      if (!(THESIS_STATUSES as readonly string[]).includes(status)) {
        error(`status must be one of: ${THESIS_STATUSES.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      const citations: number[] = [];
      for (const raw of opts.cite) {
        const n = Number(raw);
        if (!Number.isInteger(n)) {
          error(`--cite must be an integer index, got "${raw}".`);
          process.exitCode = 1;
          return;
        }
        citations.push(n);
      }
      const predictionStandings: Record<string, PredictionStanding> = {};
      for (const raw of opts.prediction) {
        const eq = raw.indexOf('=');
        if (eq === -1) {
          error(`--prediction must be "<id>=<standing>", got "${raw}".`);
          process.exitCode = 1;
          return;
        }
        const id = raw.slice(0, eq).trim();
        const standing = raw.slice(eq + 1).trim();
        predictionStandings[id] = standing as PredictionStanding;
      }
      try {
        const t = setStatus(root, slug, status as ThesisStatus, {
          citations,
          predictionStandings: Object.keys(predictionStandings).length > 0 ? predictionStandings : undefined,
          force: opts.force,
        });
        success(`${slug}: status → ${t.status}.`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('link')
    .argument('<slug>', 'Thesis slug')
    .option('--insight <slug>', 'Link to an insight slug')
    .option('--objective <slug>', 'Link to an objective slug')
    .option('--task <slug>', 'Link to a task slug')
    .description('Link a thesis to an insight, objective, or task (exactly one target per call)')
    .action((slug: string, opts: { insight?: string; objective?: string; task?: string }) => {
      const root = ensureContextRoot();
      learningHint(root);
      const picked = resolveLinkKind(opts);
      if (!picked) {
        error('Provide exactly one of --insight, --objective, --task.');
        process.exitCode = 1;
        return;
      }
      try {
        linkThesis(root, slug, picked.kind, picked.target);
        success(`${slug}: linked to ${picked.kind} "${picked.target}".`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('unlink')
    .argument('<slug>', 'Thesis slug')
    .option('--insight <slug>', 'Unlink an insight slug')
    .option('--objective <slug>', 'Unlink an objective slug')
    .option('--task <slug>', 'Unlink a task slug')
    .description('Remove a thesis link to an insight, objective, or task (exactly one target per call)')
    .action((slug: string, opts: { insight?: string; objective?: string; task?: string }) => {
      const root = ensureContextRoot();
      learningHint(root);
      const picked = resolveLinkKind(opts);
      if (!picked) {
        error('Provide exactly one of --insight, --objective, --task.');
        process.exitCode = 1;
        return;
      }
      try {
        unlinkThesis(root, slug, picked.kind, picked.target);
        success(`${slug}: unlinked from ${picked.kind} "${picked.target}".`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('changelog')
    .argument('<slug>', 'Thesis slug')
    .argument('<text...>', 'Reasoning entry text')
    .option('--cycle <n>', 'Sleep cycle number (omit for a manual/awake entry)')
    .option('--condensed', 'Mark as an already-condensed summary entry (rare — normally computed)')
    .description('Append a per-cycle reasoning entry to the understanding changelog (LIFO, newest 10 kept, older condensed)')
    .action((slug: string, textParts: string[], opts: { cycle?: string; condensed?: boolean }) => {
      const root = ensureContextRoot();
      learningHint(root);
      const text = textParts.join(' ').trim();
      if (!text) {
        error('Changelog entry text is required.');
        process.exitCode = 1;
        return;
      }
      let cycle: number | null = null;
      if (opts.cycle !== undefined) {
        cycle = Number(opts.cycle);
        if (!Number.isFinite(cycle)) {
          error('--cycle must be a number.');
          process.exitCode = 1;
          return;
        }
      }
      try {
        const t = appendChangelogEntry(root, slug, { text, cycle, condensed: opts.condensed });
        success(`${slug}: changelog entry appended (${t.changelog.length} entries).`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('block')
    .argument('<slug>', 'Thesis slug')
    .argument('<metric...>', 'What metric/insight is missing')
    .description('Mark a thesis blocked on instrumentation (needs a metric nobody tracks yet)')
    .action((slug: string, metricParts: string[]) => {
      const root = ensureContextRoot();
      learningHint(root);
      const metric = metricParts.join(' ').trim();
      if (!metric) {
        error('A metric description is required.');
        process.exitCode = 1;
        return;
      }
      try {
        setBlocked(root, slug, metric);
        success(`${slug}: blocked on instrumentation — "${metric}".`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('unblock')
    .argument('<slug>', 'Thesis slug')
    .description('Clear the instrumentation-blocked flag')
    .action((slug: string) => {
      const root = ensureContextRoot();
      learningHint(root);
      try {
        setBlocked(root, slug, null);
        success(`${slug}: unblocked.`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('promote')
    .argument('<slug>', 'Thesis slug')
    .requiredOption('--knowledge <path>', 'Path (relative to context root) of the knowledge doc this thesis promoted into')
    .option('--retire', 'Retire the thesis (leave a pointer) once promoted')
    .description('Record that a validated/invalidated thesis was promoted into a knowledge doc')
    .action((slug: string, opts: { knowledge: string; retire?: boolean }) => {
      const root = ensureContextRoot();
      learningHint(root);
      try {
        const t = promoteThesis(root, slug, { knowledgePath: opts.knowledge, retire: opts.retire });
        success(`${slug}: promoted to ${t.promoted_to}${opts.retire ? ' (retired)' : ''}.`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('retire')
    .argument('<slug>', 'Thesis slug')
    .description('Retire a thesis (e.g. kept as anti-knowledge, or superseded by a promotion)')
    .action((slug: string) => {
      const root = ensureContextRoot();
      learningHint(root);
      try {
        setStatus(root, slug, 'retired');
        success(`${slug}: retired.`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('restore')
    .argument('<slug>', 'Thesis slug')
    .description('Restore a retired thesis back to draft')
    .action((slug: string) => {
      const root = ensureContextRoot();
      learningHint(root);
      try {
        setStatus(root, slug, 'draft');
        success(`${slug}: restored to draft.`);
      } catch (err) {
        handleThesesError(err);
      }
    });

  theses
    .command('enable')
    .description('Turn the proactive learning layer on (learning.enabled = true)')
    .action(() => {
      const root = ensureContextRoot();
      const projectRoot = projectRootFor(root);
      updateSetupConfig(projectRoot, { learning: { enabled: true } });
      success('Learning layer enabled — theses CLI/snapshot/sleep-learn/dashboard board are now active.');
    });

  theses
    .command('disable')
    .description('Turn the proactive learning layer off (learning.enabled = false)')
    .action(() => {
      const root = ensureContextRoot();
      const projectRoot = projectRootFor(root);
      updateSetupConfig(projectRoot, { learning: { enabled: false } });
      success('Learning layer disabled — no sleep dispatch, CLI/snapshot noise, or dashboard page.');
    });

  theses
    .command('candidates')
    .argument('[file]', 'JSON file with { note?, items: (string | { claim: string })[] } — candidate claims extracted from source material')
    .option('--clear', 'Clear staged candidates instead of loading from <file>')
    .description('Stage meeting-note candidate theses for the dashboard review flow (theses/.candidates.json)')
    .action((file: string | undefined, opts: { clear?: boolean }) => {
      const root = ensureContextRoot();
      learningHint(root);
      const candidatesPath = join(thesesDir(root), '.candidates.json');
      if (opts.clear) {
        if (existsSync(candidatesPath)) {
          writeFileSync(candidatesPath, JSON.stringify({ note: null, items: [], staged_at: null }, null, 2) + '\n', 'utf-8');
        }
        success('Staged candidates cleared.');
        return;
      }
      if (!file) {
        error('Provide a JSON file, or pass --clear.');
        process.exitCode = 1;
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, 'utf-8'));
      } catch (err) {
        error(`Could not read/parse "${file}": ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const r = (raw ?? {}) as Record<string, unknown>;
      const rawItems = Array.isArray(r.items) ? r.items : [];
      // Server contract (server/routes/theses.ts readCandidates) requires each
      // staged item to be an OBJECT with a string `claim` field — a bare string
      // is silently dropped. Accept either shape on input, normalize to {claim}.
      const items: { claim: string }[] = [];
      for (const raw of rawItems) {
        let claim = '';
        if (typeof raw === 'string') {
          claim = raw.trim();
        } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const ro = raw as Record<string, unknown>;
          claim = typeof ro.claim === 'string' ? ro.claim.trim() : '';
        }
        if (claim) items.push({ claim });
      }
      if (items.length === 0) {
        error('The candidates file must have a non-empty "items" array of claim strings or { claim } objects.');
        process.exitCode = 1;
        return;
      }
      const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : null;
      mkdirSync(thesesDir(root), { recursive: true });
      const tmp = `${candidatesPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ note, items, staged_at: today() }, null, 2) + '\n', 'utf-8');
      renameSync(tmp, candidatesPath);
      success(`Staged ${items.length} candidate thesis claim(s)${note ? ` from "${note}"` : ''}.`);
    });
}
