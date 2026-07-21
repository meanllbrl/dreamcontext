import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { resolveContextRoot } from '../../lib/context-path.js';
import { header } from '../../lib/format.js';
import { listUnfencedDataStructures } from '../../lib/data-structures-migration.js';
import { hasTaskOverride, loadTaskOverride } from '../../lib/overrides.js';
import { listObjectives, getObjective, isSafeObjectiveSlug, isCalendarDate, OBJECTIVE_STATUSES } from '../../lib/objectives-store.js';
import { auditFeatureLinks, reconcileFeatureLinks, type LinkAudit } from '../../lib/feature-links.js';
import { buildRoadmapModel } from '../../lib/roadmap-model.js';
import { listVaults, type Vault } from '../../lib/vaults.js';
import { dirname } from 'node:path';
import { listInsights, isSafeInsightSlug, getInsight, readCache } from '../../lib/lab/store.js';
import { parseFunnelSet, FUNNEL_HISTORY_MAX } from '../../lib/lab/funnel.js';
import { RENDERS } from '../../lib/lab/types.js';
import { gitignoreCovers } from '../../lib/gitignore.js';
import { readSetupConfig, isLearningEnabled } from '../../lib/setup-config.js';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { listTheses, isSafeThesisSlug, thesesDir } from '../../lib/theses/store.js';
import { THESIS_STATUSES, THESIS_KINDS, EVIDENCE_VERDICTS, EVIDENCE_SOURCES } from '../../lib/theses/types.js';

/**
 * Remove content that represents documented mentions of placeholder syntax
 * rather than actual unfilled placeholders. Strips:
 *   - fenced code blocks (```...```)
 *   - inline-code spans (`...`)
 *   - double-quoted strings ("...")
 *
 * What remains is plain prose where a bare `{{TOKEN}}`, `(Add your ...)`, or
 * `(To be defined)` is a genuine unfilled stub.
 */
function stripDocumentedMentions(content: string): string {
  // Remove fenced code blocks first (multi-line, greedy across newlines)
  let result = content.replace(/```[\s\S]*?```/g, '');
  // Remove inline-code spans
  result = result.replace(/`[^`]*`/g, '');
  // Remove double-quoted strings (single-line only to avoid runaway matches)
  result = result.replace(/"[^"\n]*"/g, '');
  return result;
}

export interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

function checkFile(root: string, relPath: string, label: string, required: boolean): CheckResult {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) {
    return {
      name: label,
      status: required ? 'error' : 'warn',
      message: required ? `Missing: ${relPath}` : `Optional file not found: ${relPath}`,
    };
  }

  const stat = statSync(fullPath);
  if (stat.size === 0) {
    return {
      name: label,
      status: 'warn',
      message: `Empty file: ${relPath}`,
    };
  }

  // Check for placeholder content in markdown files.
  // Ignore mentions that appear inside fenced code blocks, inline-code spans,
  // or double-quoted strings — those are documented examples, not real stubs.
  if (relPath.endsWith('.md')) {
    const content = readFileSync(fullPath, 'utf-8');
    const stripped = stripDocumentedMentions(content);
    if (stripped.includes('(Add your') || stripped.includes('{{') || stripped.includes('(To be defined)')) {
      return {
        name: label,
        status: 'warn',
        message: `Contains placeholder content: ${relPath}`,
      };
    }
  }

  return { name: label, status: 'ok', message: relPath };
}

function checkJson(root: string, relPath: string, label: string): CheckResult {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) {
    return { name: label, status: 'error', message: `Missing: ${relPath}` };
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    JSON.parse(content);
    return { name: label, status: 'ok', message: relPath };
  } catch {
    return { name: label, status: 'error', message: `Malformed JSON: ${relPath}` };
  }
}

function checkDirectory(root: string, relPath: string, label: string): CheckResult {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) {
    return { name: label, status: 'error', message: `Missing directory: ${relPath}` };
  }
  return { name: label, status: 'ok', message: relPath };
}

/**
 * Validate that knowledge/data-structures/ exists and contains at least one .md
 * file (default.md for single-product OR <product>.md for multi-product).
 *
 * Emits migration hints when the OLD core/data-structures/ (or the even-older
 * legacy core/5.data_structures.sql) is still present — both are left in place
 * by the migration so the user deletes them after confirming.
 */
function checkDataStructures(root: string): CheckResult[] {
  const results: CheckResult[] = [];
  const dirRel = 'knowledge/data-structures';
  const dirAbs = join(root, dirRel);
  const oldRel = 'core/data-structures';
  const oldAbs = join(root, oldRel);
  const oldExists = existsSync(oldAbs);
  const legacyRel = 'core/5.data_structures.sql';
  const legacyExists = existsSync(join(root, legacyRel));

  if (!existsSync(dirAbs)) {
    if (oldExists) {
      results.push({
        name: 'Data structures',
        status: 'warn',
        message:
          `Data structures still under ${oldRel}/; new home ${dirRel}/ missing. `
          + `Run a sleep cycle — \`sleep start\` migrates them to ${dirRel}/ (the old dir is left for you to delete).`,
      });
    } else if (legacyExists) {
      results.push({
        name: 'Data structures',
        status: 'warn',
        message:
          `Legacy ${legacyRel} present; ${dirRel}/ missing. `
          + `Run a sleep cycle — sleep-product migrates it to ${dirRel}/default.md.`,
      });
    } else {
      results.push({
        name: 'Data structures',
        status: 'warn',
        message: `Optional directory not found: ${dirRel}`,
      });
    }
    return results;
  }

  let mdCount = 0;
  try {
    mdCount = readdirSync(dirAbs).filter((f) => f.endsWith('.md')).length;
  } catch {
    results.push({
      name: 'Data structures',
      status: 'error',
      message: `Unreadable directory: ${dirRel}`,
    });
    return results;
  }

  if (mdCount === 0) {
    results.push({
      name: 'Data structures',
      status: 'warn',
      message: `${dirRel}/ exists but contains no .md files (expected default.md or <product>.md)`,
    });
  } else {
    results.push({
      name: 'Data structures',
      status: 'ok',
      message: `${dirRel}/ (${mdCount} file${mdCount > 1 ? 's' : ''})`,
    });
  }

  const unfenced = listUnfencedDataStructures(root);
  if (unfenced.length > 0) {
    results.push({
      name: 'Data structures (formatting)',
      status: 'warn',
      message:
        `${unfenced.length} file(s) not \`\`\`sql-fenced (won't render as SQL in the dashboard): ${unfenced.join(', ')}. `
        + 'Run `sleep start` to fence them.',
    });
  }

  if (oldExists) {
    results.push({
      name: 'Data structures (old location)',
      status: 'warn',
      message:
        `Old ${oldRel}/ still present alongside the new ${dirRel}/. `
        + `Migration leaves it in place; delete it once you've confirmed ${dirRel}/ is current.`,
    });
  }
  if (legacyExists) {
    results.push({
      name: 'Data structures (legacy)',
      status: 'warn',
      message:
        `Legacy ${legacyRel} still present. `
        + `Delete it once you've confirmed ${dirRel}/default.md is current.`,
    });
  }

  return results;
}

/**
 * Features are typed knowledge under knowledge/features/ (migration 0.10.7).
 * Non-fatal: PASS when core/features/ is absent or empty (fully migrated, or
 * a brain that never had features). WARN — never error — when *.md files
 * remain, since a partial migration failure must not fail `doctor` outright;
 * it points at `dreamcontext update` to retry the pending migration.
 */
function checkFeaturesMigrated(root: string): CheckResult {
  const oldRel = 'core/features';
  const oldAbs = join(root, oldRel);
  if (!existsSync(oldAbs)) {
    return { name: 'Features (migration)', status: 'ok', message: 'knowledge/features/' };
  }
  let mdFiles: string[] = [];
  try {
    mdFiles = readdirSync(oldAbs).filter((f) => f.endsWith('.md'));
  } catch {
    return { name: 'Features (migration)', status: 'ok', message: 'knowledge/features/' };
  }
  if (mdFiles.length === 0) {
    return { name: 'Features (migration)', status: 'ok', message: 'knowledge/features/' };
  }
  return {
    name: 'Features (migration)',
    status: 'warn',
    message:
      `${mdFiles.length} feature file(s) remain in ${oldRel}/ — migration incomplete. `
      + 'Run `dreamcontext update` to retry.',
  };
}

/**
 * Validate an optional `_dream_context/overrides/task.md` (task_dlhc0fFQ).
 * Silent when absent (it's opt-in); warns — never silently ignores — on a
 * malformed override (bad frontmatter, unknown field type, duplicate keys).
 */
function checkOverrides(root: string): CheckResult[] {
  if (!hasTaskOverride(root)) return [];
  const rel = 'overrides/task.md';
  const ov = loadTaskOverride(root);
  if (!ov) {
    return [{ name: 'Task override', status: 'warn', message: `${rel}: unreadable` }];
  }
  const results: CheckResult[] = ov.warnings.map((w) => ({
    name: 'Task override',
    status: 'warn' as const,
    message: w,
  }));
  if (ov.warnings.length === 0) {
    const n = ov.customFields.length;
    results.push({
      name: 'Task override',
      status: 'ok',
      message: `${rel} (${n} custom field${n === 1 ? '' : 's'})`,
    });
  }
  return results;
}

/**
 * Validate the OPTIONAL objectives store (core/objectives/ — roadmap feature).
 * Silent when absent; when present, checks slugs, target dates, status
 * overrides, dependency resolution + acyclicity, and that task `objectives:`
 * references resolve (surfaced via the roadmap builder's own warnings).
 */
function checkObjectives(root: string): CheckResult[] {
  const results: CheckResult[] = [];
  const objectives = listObjectives(root);
  let model: ReturnType<typeof buildRoadmapModel>;
  try {
    model = buildRoadmapModel(root);
  } catch (err) {
    return [{
      name: 'Objectives',
      status: 'error',
      message: `Roadmap model failed to build: ${err instanceof Error ? err.message : String(err)}`,
    }];
  }
  // Builder warnings cover: unknown objective refs on tasks, unknown deps, cycles.
  for (const w of model.warnings) {
    results.push({ name: 'Objectives', status: 'warn', message: w });
  }
  if (objectives.length === 0) return results;

  for (const o of objectives) {
    if (!isSafeObjectiveSlug(o.slug)) {
      results.push({ name: 'Objectives', status: 'warn', message: `Objective slug not kebab-case: ${o.slug}` });
    }
    if (o.target_date !== null && !isCalendarDate(o.target_date)) {
      results.push({ name: 'Objectives', status: 'warn', message: `Objective ${o.slug}: invalid target_date "${o.target_date}"` });
    }
    // A raw status string outside the enum reads back as null; catch hand-edits.
    const raw = readFileSync(o.path, 'utf-8');
    const m = /^status:\s*(\S+)\s*$/m.exec(raw);
    if (m && m[1] !== 'null' && !(OBJECTIVE_STATUSES as readonly string[]).includes(m[1].replace(/['"]/g, ''))) {
      results.push({
        name: 'Objectives',
        status: 'warn',
        message: `Objective ${o.slug}: status "${m[1]}" is not one of ${OBJECTIVE_STATUSES.join('|')} — treated as computed`,
      });
    }
    // A `metric:` block that parses to null (missing label, non-numeric target, or
    // target === baseline) is silently ignored at read time — surface it here so a
    // hand-edited KR that stopped driving progress doesn't fail invisibly.
    if (/^metric:\s*$/m.test(raw) && o.metric === null) {
      results.push({
        name: 'Objectives',
        status: 'warn',
        message: `Objective ${o.slug}: metric block is malformed (needs a label + numeric target ≠ baseline) — ignored, progress falls back to tasks`,
      });
    }
  }

  if (results.length === 0) {
    const slipping = model.objectives.filter((x) => x.slipping === true).length;
    results.push({
      name: 'Objectives',
      status: 'ok',
      message: `core/objectives/ (${objectives.length} objective(s)${slipping > 0 ? `, ${slipping} slipping` : ''})`,
    });
  }
  return results;
}

/**
 * Validate the OPTIONAL lab (analytics insights) store. Silent when
 * `lab/insights/` is empty. FAILS (self-healing net) when
 * `lab/credentials.json` exists but no governing gitignore covers it — this
 * catches a brain repo bootstrapped before Lab shipped (its gitignore predates
 * the lab entries) and points the user at the fix (`lab credentials set`
 * re-runs the gitignore-first ordering).
 */
export function checkLab(root: string): CheckResult[] {
  const results: CheckResult[] = [];
  const insights = listInsights(root);

  // The credentials-coverage check runs regardless of whether any insight
  // exists yet — a stale/uncovered credentials.json is a real exposure even
  // with zero manifests.
  const credentialsPath = join(root, 'lab', 'credentials.json');
  if (existsSync(credentialsPath)) {
    const projectRoot = dirname(root);
    const covered = gitignoreCovers(projectRoot, ['_dream_context/lab/credentials.json']);
    if (!covered) {
      results.push({
        name: 'Lab credentials',
        status: 'error',
        message: 'lab/credentials.json exists but is not covered by the root .gitignore — run `dreamcontext lab credentials set <key>` to self-heal the gitignore before this can be trusted.',
      });
    }
  }

  if (insights.length === 0) return results;

  for (const m of insights) {
    if (!isSafeInsightSlug(m.slug)) {
      results.push({ name: 'Lab', status: 'warn', message: `Insight slug not kebab-case: ${m.slug}` });
    }
    if (!(RENDERS as readonly string[]).includes(m.render)) {
      results.push({ name: 'Lab', status: 'warn', message: `Insight ${m.slug}: render "${m.render}" is not one of ${RENDERS.join('|')}` });
    }
    if (!m.source) {
      results.push({ name: 'Lab', status: 'warn', message: `Insight ${m.slug}: source block is malformed or missing (adapter must be http|script)` });
    }
    for (const t of m.tweaks) {
      if (t.type === 'enum' && (!t.options || t.options.length === 0)) {
        results.push({ name: 'Lab', status: 'warn', message: `Insight ${m.slug}: enum tweak "${t.key}" declares no options` });
      }
    }
    if (m.binding) {
      const objective = getObjective(root, m.binding.objective);
      if (!objective) {
        results.push({ name: 'Lab', status: 'warn', message: `Insight ${m.slug}: binding.objective "${m.binding.objective}" does not resolve` });
      }
    }
    // Funnel cache shape: a synced funnel insight's cache.funnel must re-validate
    // cleanly. Cap violations in a STORED set mean the cache was hand-edited or
    // written by an older build — warn so the next sync (which re-caps) is run.
    if (m.render === 'funnel') {
      const cache = readCache(root, m.slug);
      if (cache?.funnel) {
        try {
          const reparsed = parseFunnelSet(cache.funnel.set);
          for (const notice of reparsed.notices) {
            results.push({ name: 'Lab', status: 'warn', message: `Insight ${m.slug}: funnel cache violates a cap — ${notice} Re-run \`dreamcontext lab sync ${m.slug} --force\`.` });
          }
        } catch (err) {
          results.push({ name: 'Lab', status: 'warn', message: `Insight ${m.slug}: funnel cache is not a valid funnel-set (${(err as Error).message})` });
        }
        if (Array.isArray(cache.funnelHistory) && cache.funnelHistory.length > FUNNEL_HISTORY_MAX) {
          results.push({ name: 'Lab', status: 'warn', message: `Insight ${m.slug}: funnelHistory has ${cache.funnelHistory.length} snapshots (cap ${FUNNEL_HISTORY_MAX})` });
        }
      }
    }
    // A manifest that declares credentials_used but whose key is absent from
    // credentials.json can't sync — warn (not fail: not every insight has
    // synced yet, and this is fixable without touching gitignore state).
    if (m.credentials_used.length > 0) {
      const creds = existsSync(credentialsPath)
        ? (() => { try { return JSON.parse(readFileSync(credentialsPath, 'utf-8')); } catch { return {}; } })()
        : {};
      for (const key of m.credentials_used) {
        if (!(key in creds)) {
          results.push({ name: 'Lab', status: 'warn', message: `Insight ${m.slug}: credentials_used key "${key}" is absent from lab/credentials.json — run \`dreamcontext lab credentials set ${key}\`` });
        }
      }
    }
  }

  if (results.length === 0) {
    results.push({ name: 'Lab', status: 'ok', message: `lab/insights/ (${insights.length} insight(s))` });
  }
  return results;
}

/**
 * Validate the OPTIONAL theses (proactive learning layer) store. Silent when
 * the layer is disabled AND `theses/` has never been created — a fresh
 * project makes zero doctor noise for an opt-in layer nobody has touched yet.
 * Once files exist on disk (even with the layer since toggled off), their
 * referential integrity is still worth catching — data doesn't vanish when
 * the switch flips. Warn-never-fatal, mirroring `checkLab`: a malformed or
 * hand-edited thesis degrades to a warning, never breaks `doctor`.
 */
export function checkTheses(root: string): CheckResult[] {
  const results: CheckResult[] = [];
  const enabled = isLearningEnabled(readSetupConfig(dirname(root)));
  if (!enabled && !existsSync(thesesDir(root))) return results;

  const theses = listTheses(root);
  if (theses.length === 0) return results;

  for (const m of theses) {
    if (!isSafeThesisSlug(m.slug)) {
      results.push({ name: 'Theses', status: 'warn', message: `Thesis slug not kebab-case: ${m.slug}` });
    }

    // Raw frontmatter — the store's LENIENT reader silently coerces a bad
    // status/kind to a safe default and drops an unrecognised evidence
    // verdict, so a hand-edited/malformed value never surfaces via the
    // parsed manifest. Read it directly here to catch those cases.
    let raw: Record<string, unknown> = {};
    try {
      raw = readFrontmatter<Record<string, unknown>>(m.path).data;
    } catch {
      results.push({ name: 'Theses', status: 'warn', message: `Thesis ${m.slug}: frontmatter unreadable` });
      continue;
    }

    const rawStatus = typeof raw.status === 'string' ? raw.status.trim() : '';
    if (rawStatus && !(THESIS_STATUSES as readonly string[]).includes(rawStatus)) {
      results.push({
        name: 'Theses',
        status: 'warn',
        message: `Thesis ${m.slug}: status "${rawStatus}" is not one of ${THESIS_STATUSES.join('|')} — treated as draft`,
      });
    }
    const rawKind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    if (rawKind && !(THESIS_KINDS as readonly string[]).includes(rawKind)) {
      results.push({
        name: 'Theses',
        status: 'warn',
        message: `Thesis ${m.slug}: kind "${rawKind}" is not one of ${THESIS_KINDS.join('|')} — treated as observational`,
      });
    }

    for (const slug of m.insights) {
      if (!getInsight(root, slug)) {
        results.push({ name: 'Theses', status: 'warn', message: `Thesis ${m.slug}: linked insight "${slug}" does not resolve` });
      }
    }
    for (const slug of m.objectives) {
      if (!getObjective(root, slug)) {
        results.push({ name: 'Theses', status: 'warn', message: `Thesis ${m.slug}: linked objective "${slug}" does not resolve` });
      }
    }
    for (const slug of m.related_tasks) {
      if (!existsSync(join(root, 'state', `${slug}.md`))) {
        results.push({ name: 'Theses', status: 'warn', message: `Thesis ${m.slug}: linked task "${slug}" does not resolve` });
      }
    }

    const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
    for (const e of rawEvidence) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      const r = e as Record<string, unknown>;
      const verdict = typeof r.verdict === 'string' ? r.verdict.trim() : '';
      if (verdict && !(EVIDENCE_VERDICTS as readonly string[]).includes(verdict)) {
        results.push({
          name: 'Theses',
          status: 'warn',
          message: `Thesis ${m.slug}: evidence verdict "${verdict}" is not one of ${EVIDENCE_VERDICTS.join('|')} — entry dropped from the derived ledger`,
        });
      }
      const source = typeof r.source === 'string' ? r.source.trim() : '';
      if (source && !(EVIDENCE_SOURCES as readonly string[]).includes(source)) {
        results.push({
          name: 'Theses',
          status: 'warn',
          message: `Thesis ${m.slug}: evidence source "${source}" is not one of ${EVIDENCE_SOURCES.join('|')} — treated as external`,
        });
      }
    }

    const rawConfidence = typeof raw.confidence === 'number' ? raw.confidence : null;
    if (rawConfidence !== null && Math.abs(rawConfidence - m.confidence) > 0.001) {
      results.push({
        name: 'Theses',
        status: 'warn',
        message: `Thesis ${m.slug}: persisted confidence ${rawConfidence.toFixed(3)} drifted from the evidence-derived ${m.confidence.toFixed(3)} — self-heals on the next store write (evidence was likely hand-edited)`,
      });
    }

    if (m.status === 'open' && m.predictions.length === 0) {
      results.push({ name: 'Theses', status: 'warn', message: `Thesis ${m.slug}: status is open with zero pre-registered predictions` });
    }
    if (m.blocked_on_instrumentation && !m.blocked_metric) {
      results.push({ name: 'Theses', status: 'warn', message: `Thesis ${m.slug}: blocked_on_instrumentation is set but blocked_metric is empty` });
    }
  }

  if (results.length === 0) {
    results.push({ name: 'Theses', status: 'ok', message: `theses/ (${theses.length} thesis(es))` });
  }
  return results;
}


/**
 * Task↔feature link integrity: every `task.related_feature` must resolve to a
 * real feature (canonical slug) whose `related_tasks` lists the task back, and
 * every `related_tasks` entry must be a live task pointing here. Deterministic
 * drift is fixable in one shot with `doctor --heal-links`.
 */
/**
 * Two registered projects syncing against the SAME remote task container (#184/#177).
 *
 * A shared container has no per-project scoping, so each project pulls the other's
 * tasks into its own brain as ordinary local tasks — same frontmatter, no field
 * saying whose work they describe. A `completed` task then reads as evidence that
 * THIS project has the capability, when the work actually landed in a sibling repo.
 * Reported live: a sleep specialist read one and concluded "already done", nearly
 * dropping a whole work group. Nothing else surfaces this, so doctor names it.
 */
export function checkSharedTaskContainer(root: string): CheckResult[] {
  const NAME = 'Task backend scoping';
  let vaults: Vault[];
  try {
    vaults = listVaults();
  } catch {
    return []; // no registry (single-project install) — nothing to compare
  }
  if (vaults.length < 2) return [];

  const here = dirname(root);
  const containerOf = (projectRoot: string): { key: string; label: string } | null => {
    try {
      const cfg = readSetupConfig(projectRoot);
      if (cfg?.clickup?.listId) return { key: `clickup:${cfg.clickup.listId}`, label: `ClickUp list ${cfg.clickup.listId}` };
      if (cfg?.github?.owner && cfg?.github?.repo) return { key: `github:${cfg.github.owner}/${cfg.github.repo}`, label: `GitHub repo ${cfg.github.owner}/${cfg.github.repo}` };
    } catch { /* unreadable config — not this check's problem */ }
    return null;
  };

  const mine = containerOf(here);
  if (!mine) return [];

  const siblings = vaults
    .filter((v) => v.path !== here)
    .filter((v) => containerOf(v.path)?.key === mine.key)
    .map((v) => v.name);
  if (siblings.length === 0) {
    return [{ name: NAME, status: 'ok', message: `${mine.label} is not shared with another registered project.` }];
  }
  return [{
    name: NAME,
    status: 'warn',
    message:
      `${mine.label} is ALSO the sync target of: ${siblings.join(', ')}. ` +
      `Synced tasks carry no field saying which project's work they describe, so a ` +
      `'completed' task here may describe work done in a sibling — verify against this ` +
      `project's source before trusting it. Give each project its own list/repo, or scope ` +
      `the shared one per project.`,
  }];
}

function checkTaskFeatureLinks(root: string): CheckResult[] {
  const results: CheckResult[] = [];
  let audit: LinkAudit;
  try {
    audit = auditFeatureLinks(root);
  } catch (err) {
    return [{
      name: 'Task↔feature links',
      status: 'error',
      message: `Link audit failed: ${err instanceof Error ? err.message : String(err)}`,
    }];
  }
  const warnAll = (messages: string[]) => {
    for (const message of messages) results.push({ name: 'Task↔feature links', status: 'warn', message });
  };
  warnAll(audit.ghostFeatureRefs.map((g) => g.candidates
    ? `task '${g.task}' → related_feature '${g.feature}' is ambiguous across ${g.candidates.length} features (${g.candidates.join(', ')}) — qualify it: dreamcontext tasks feature ${g.task} <folder/slug>`
    : `task '${g.task}' → related_feature '${g.feature}' does not exist (fix: dreamcontext tasks feature ${g.task} <feature|clear>)`));
  warnAll(audit.conflictingClaims.map((c) => `task '${c.task}' is listed in related_tasks of ${c.features.length} features (${c.features.join(', ')}) but claims none (fix: dreamcontext tasks feature ${c.task} <feature>)`));
  warnAll(audit.ghostTaskRefs.map((g) => `feature '${g.feature}' lists unknown task '${g.task}' in related_tasks`));
  warnAll(audit.foreignClaims.map((f) => `feature '${f.feature}' lists task '${f.task}' which belongs to '${f.actual}'`));
  warnAll(audit.missingBackRefs.map((m) => `feature '${m.feature}' lists task '${m.task}' but the task's related_feature is empty`));
  warnAll(audit.missingMemberships.map((m) => `task '${m.task}' → feature '${m.feature}' but the feature's related_tasks misses it`));
  warnAll(audit.nonCanonicalFeatureRefs.map((n) => `task '${n.task}' → related_feature '${n.from}' should be the canonical slug '${n.to}'`));
  if (results.length === 0) {
    results.push({ name: 'Task↔feature links', status: 'ok', message: 'task.related_feature ↔ feature.related_tasks are consistent' });
  } else {
    const healable = results.length - audit.ghostFeatureRefs.length - audit.conflictingClaims.length;
    if (healable > 0) {
      results.push({ name: 'Task↔feature links', status: 'warn', message: `${healable} of the above are deterministic — fix them all: dreamcontext doctor --heal-links` });
    }
  }
  return results;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Validate _dream_context/ structure and report issues')
    .option('--heal-links', 'Apply the deterministic task↔feature link fixes (adopt back-refs, drop ghost/foreign related_tasks entries, canonicalize slugs) before running the checks')
    .action((opts: { healLinks?: boolean }) => {
      const root = resolveContextRoot();
      if (!root) {
        console.log(chalk.red('✗') + ' _dream_context/ not found. Run `dreamcontext init` to create it.');
        process.exit(1);
      }

      console.log(header('Doctor'));

      if (opts.healLinks) {
        const report = reconcileFeatureLinks(root);
        const fixed =
          report.adopted.length + report.canonicalized.length + report.membershipsAdded.length
          + report.ghostTaskRefsDropped.length + report.foreignClaimsDropped.length;
        console.log(chalk.bold('  Link heal'));
        for (const a of report.adopted) console.log(chalk.green('  ✓') + ` ${a.task} → related_feature: ${a.feature} (adopted from the feature's related_tasks)`);
        for (const c of report.canonicalized) console.log(chalk.green('  ✓') + ` ${c.task}: related_feature '${c.from}' → '${c.to}' (canonical slug)`);
        for (const m of report.membershipsAdded) console.log(chalk.green('  ✓') + ` ${m.feature}: related_tasks += ${m.task}`);
        for (const g of report.ghostTaskRefsDropped) console.log(chalk.green('  ✓') + ` ${g.feature}: dropped ghost task '${g.task}' from related_tasks`);
        for (const f of report.foreignClaimsDropped) console.log(chalk.green('  ✓') + ` ${f.feature}: dropped '${f.task}' (belongs to ${f.actual})`);
        for (const u of report.unresolved) console.log(chalk.yellow('  ⚠') + ` ${u}`);
        if (fixed === 0 && report.unresolved.length === 0) console.log(chalk.dim('  nothing to heal — links already consistent'));
        console.log();
      }

      const results: CheckResult[] = [
        // Directories
        checkDirectory(root, 'core', 'Core directory'),
        checkFeaturesMigrated(root),
        checkDirectory(root, 'knowledge', 'Knowledge directory'),
        checkDirectory(root, 'state', 'State directory'),

        // Required core files
        checkFile(root, 'core/0.soul.md', 'Soul file', true),
        checkFile(root, 'core/1.user.md', 'User file', true),
        checkFile(root, 'core/2.memory.md', 'Memory file', true),

        // JSON files
        checkJson(root, 'core/CHANGELOG.json', 'Changelog'),
        checkJson(root, 'core/RELEASES.json', 'Releases'),

        // Optional extended core files
        checkFile(root, 'core/3.style_guide_and_branding.md', 'Style guide', false),
        checkFile(root, 'core/4.tech_stack.md', 'Tech stack', false),
        ...checkDataStructures(root),
        ...checkOverrides(root),
        ...checkObjectives(root),
        ...checkTaskFeatureLinks(root),
        ...checkSharedTaskContainer(root),
        ...checkLab(root),
        ...checkTheses(root),

        // Taxonomy vocabulary (non-fatal: absent means DEFAULT_VOCABULARY used)
        ...(!existsSync(join(root, 'core', 'taxonomy.json'))
          ? [{
              name: 'Taxonomy vocabulary',
              status: 'warn' as const,
              message: 'core/taxonomy.json not found — run `dreamcontext taxonomy init` to scaffold it',
            }]
          : [checkJson(root, 'core/taxonomy.json', 'Taxonomy vocabulary')]),

        // Sleep state (optional — created on first Stop hook)
        ...(existsSync(join(root, 'state', '.sleep.json'))
          ? [checkJson(root, 'state/.sleep.json', 'Sleep state')]
          : []),
        ...(existsSync(join(root, 'state', '.platforms.json'))
          ? [checkJson(root, 'state/.platforms.json', 'Platform defaults')]
          : []),
      ];

      // Sleep state specific check: detect corruption
      const sleepPath = join(root, 'state', '.sleep.json');
      if (existsSync(sleepPath)) {
        try {
          const parsed = JSON.parse(readFileSync(sleepPath, 'utf-8'));
          if (typeof parsed.debt !== 'number' || parsed.debt < 0) {
            results.push({ name: 'Sleep debt', status: 'warn', message: 'Invalid debt value in .sleep.json' });
          }
          if (parsed.sessions && !Array.isArray(parsed.sessions)) {
            results.push({ name: 'Sleep sessions', status: 'error', message: 'sessions field is not an array in .sleep.json' });
          }
        } catch {
          // Already caught by checkJson above
        }
      }

      const icons = { ok: chalk.green('✓'), warn: chalk.yellow('⚠'), error: chalk.red('✗') };
      const errors = results.filter(r => r.status === 'error');
      const warnings = results.filter(r => r.status === 'warn');
      const ok = results.filter(r => r.status === 'ok');

      for (const r of results) {
        console.log(`  ${icons[r.status]} ${r.message}`);
      }

      console.log();
      const summary: string[] = [];
      if (ok.length > 0) summary.push(chalk.green(`${ok.length} ok`));
      if (warnings.length > 0) summary.push(chalk.yellow(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`));
      if (errors.length > 0) summary.push(chalk.red(`${errors.length} error${errors.length > 1 ? 's' : ''}`));
      console.log(`  ${summary.join(', ')}`);

      if (errors.length > 0) {
        process.exit(1);
      }
    });
}
