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
import { inspectJsonArray } from '../../lib/json-file.js';
import { readSetupConfig, isLearningEnabled } from '../../lib/setup-config.js';
import { hasPeopleLayout, listPeople, personFilePath } from '../../lib/people-store.js';
import { resolveActivePerson } from '../../lib/people-resolve.js';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { listTheses, isSafeThesisSlug, thesesDir } from '../../lib/theses/store.js';
import { THESIS_STATUSES, THESIS_KINDS, EVIDENCE_VERDICTS, EVIDENCE_SOURCES } from '../../lib/theses/types.js';
import {
  auditCoreFileSizes, CORE_FILE_CHAR_CEILING, CORE_FILE_LINE_CEILING,
  type CoreFileSizeAudit,
} from '../../lib/core-index.js';
import { measureSnapshot, type SnapshotMeasurement } from './snapshot.js';
import { resolveBudget, HARNESS_PERSIST_CHAR_LIMIT, HARNESS_PREVIEW_CHARS } from '../../lib/snapshot-budget.js';
import type { NeverEvictSectionId } from '../../lib/snapshot-caps.js';

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
  /** Stable diagnostic slug (e.g. `doctor/core-file-ceiling`). Derived from `name` when unset. */
  code?: string;
  /** What is broken — file, entity, field. */
  subject?: Record<string, unknown>;
  /** Measured proof — bytes, counts, matched text, unresolved refs. */
  evidence?: Record<string, unknown>;
  /** Concrete repairs to choose from. A consumer repairs by picking one, not by guessing. */
  supportedFixes?: string[];
}

export interface DoctorReport {
  version: 1;
  summary: { ok: number; warn: number; error: number };
  checks: Array<CheckResult & { code: string }>;
}

/** Fallback so every reported check carries a stable code even before it is hand-annotated. */
export function deriveCode(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `doctor/${slug || 'check'}`;
}

export function buildDoctorReport(results: CheckResult[]): DoctorReport {
  const checks = results.map((r) => ({ ...r, code: r.code ?? deriveCode(r.name) }));
  return {
    version: 1,
    summary: {
      ok: checks.filter((r) => r.status === 'ok').length,
      warn: checks.filter((r) => r.status === 'warn').length,
      error: checks.filter((r) => r.status === 'error').length,
    },
    checks,
  };
}

function checkFile(root: string, relPath: string, label: string, required: boolean): CheckResult {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) {
    return {
      name: label,
      status: required ? 'error' : 'warn',
      message: required ? `Missing: ${relPath}` : `Optional file not found: ${relPath}`,
      code: 'doctor/missing-file',
      subject: { file: relPath },
      supportedFixes: required
        ? [`create ${relPath} with real content`, 'run `dreamcontext init` if the whole scaffold is missing']
        : undefined,
    };
  }

  const stat = statSync(fullPath);
  if (stat.size === 0) {
    return {
      name: label,
      status: 'warn',
      message: `Empty file: ${relPath}`,
      code: 'doctor/empty-file',
      subject: { file: relPath },
      supportedFixes: [`write real content into ${relPath} — an empty file is worse than none`],
    };
  }

  // Check for placeholder content in markdown files.
  // Ignore mentions that appear inside fenced code blocks, inline-code spans,
  // or double-quoted strings — those are documented examples, not real stubs.
  if (relPath.endsWith('.md')) {
    const content = readFileSync(fullPath, 'utf-8');
    const stripped = stripDocumentedMentions(content);
    const markers = ['(Add your', '{{', '(To be defined)'].filter((m) => stripped.includes(m));
    if (markers.length > 0) {
      return {
        name: label,
        status: 'warn',
        message: `Contains placeholder content: ${relPath}`,
        code: 'doctor/placeholder-content',
        subject: { file: relPath },
        evidence: { placeholders: markers },
        supportedFixes: [
          `replace the placeholder text in ${relPath} with real project content`,
          'delete the templated section if there is nothing real to say',
        ],
      };
    }
  }

  return { name: label, status: 'ok', message: relPath };
}

/**
 * Validate a JSON data file: it parses, AND its top-level shape is the one the
 * readers require.
 *
 * Parsing alone is not enough. `core/CHANGELOG.json` and `core/RELEASES.json`
 * are read by `readJsonArray()`, which needs a **bare array** — a vault
 * scaffolded by hand as `{"entries": []}` / `{"releases": []}` parses fine,
 * so a parse-only check reported OK while `core releases add` failed loudly
 * and the snapshot's recent-changelog section came back empty in silence.
 * `expect` closes that gap; the recoverable wrapper shape is a `warn` (readers
 * unwrap it, the next write normalises it) and an unreadable shape is an
 * `error`.
 */
export function checkJson(
  root: string,
  relPath: string,
  label: string,
  expect: 'array' | 'object',
): CheckResult {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) {
    return {
      name: label, status: 'error', message: `Missing: ${relPath}`,
      code: 'doctor/missing-file',
      subject: { file: relPath },
      supportedFixes: [`create ${relPath}`, 'run `dreamcontext init` if the whole scaffold is missing'],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf-8'));
  } catch (err) {
    return {
      name: label, status: 'error', message: `Malformed JSON: ${relPath}`,
      code: 'doctor/malformed-json',
      subject: { file: relPath },
      evidence: { parseError: err instanceof Error ? err.message : String(err) },
      supportedFixes: [`repair the JSON syntax in ${relPath} at the position named by the parse error`],
    };
  }

  if (expect === 'array') {
    const shape = inspectJsonArray(parsed);
    if (shape.kind === 'wrapped') {
      return {
        name: label, status: 'warn',
        message:
          `Wrapped JSON array: ${relPath} holds {"${shape.wrapperKey}": [...]}, not a bare array `
          + '— readers unwrap it and the next write normalises the file, but fix it to be sure',
        code: 'doctor/json-wrapped-array',
        subject: { file: relPath, expected: 'array' },
        evidence: {
          wrapperKey: shape.wrapperKey,
          topLevelKeys: Object.keys(parsed as Record<string, unknown>),
          items: shape.array.length,
        },
        supportedFixes: [
          `rewrite ${relPath} as the bare array under its "${shape.wrapperKey}" key, dropping the wrapper object`,
          `write to it once (e.g. \`dreamcontext core changelog add …\`) — the write normalises ${relPath} in place`,
        ],
      };
    }
    if (shape.kind === 'invalid') {
      return {
        name: label, status: 'error',
        message: `Expected a JSON array in ${relPath}, got ${shape.actual}`,
        code: 'doctor/json-not-array',
        subject: { file: relPath, expected: 'array' },
        evidence: { actual: shape.actual },
        supportedFixes: [
          `rewrite ${relPath} as a bare JSON array ([...]) holding the entries it should have`,
          `reset it to \`[]\` if it holds nothing worth keeping`,
        ],
      };
    }
    return { name: label, status: 'ok', message: relPath };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const actual = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    return {
      name: label, status: 'error',
      message: `Expected a JSON object in ${relPath}, got ${actual}`,
      code: 'doctor/json-not-object',
      subject: { file: relPath, expected: 'object' },
      evidence: { actual },
      supportedFixes: [`rewrite ${relPath} as a JSON object ({...})`],
    };
  }

  return { name: label, status: 'ok', message: relPath };
}

function checkDirectory(root: string, relPath: string, label: string): CheckResult {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) {
    return {
      name: label, status: 'error', message: `Missing directory: ${relPath}`,
      code: 'doctor/missing-directory',
      subject: { directory: relPath },
      supportedFixes: ['run `dreamcontext init` to scaffold the missing directories'],
    };
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
      results.push({
        name: 'Objectives', status: 'warn', message: `Objective slug not kebab-case: ${o.slug}`,
        code: 'doctor/objective-slug', subject: { objective: o.slug },
        supportedFixes: ['rename the objective file to a kebab-case slug'],
      });
    }
    if (o.target_date !== null && !isCalendarDate(o.target_date)) {
      results.push({
        name: 'Objectives', status: 'warn', message: `Objective ${o.slug}: invalid target_date "${o.target_date}"`,
        code: 'doctor/objective-target-date', subject: { objective: o.slug, field: 'target_date' },
        evidence: { target_date: o.target_date },
        supportedFixes: ['set target_date to a YYYY-MM-DD calendar date or null'],
      });
    }
    // A raw status string outside the enum reads back as null; catch hand-edits.
    const raw = readFileSync(o.path, 'utf-8');
    const m = /^status:\s*(\S+)\s*$/m.exec(raw);
    if (m && m[1] !== 'null' && !(OBJECTIVE_STATUSES as readonly string[]).includes(m[1].replace(/['"]/g, ''))) {
      results.push({
        name: 'Objectives',
        status: 'warn',
        message: `Objective ${o.slug}: status "${m[1]}" is not one of ${OBJECTIVE_STATUSES.join('|')} — treated as computed`,
        code: 'doctor/objective-status-enum',
        subject: { objective: o.slug, field: 'status' },
        evidence: { status: m[1], allowed: OBJECTIVE_STATUSES },
        supportedFixes: [`set status to one of ${OBJECTIVE_STATUSES.join('|')}, or null to keep it computed`],
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
        code: 'doctor/objective-metric-malformed',
        subject: { objective: o.slug, field: 'metric' },
        supportedFixes: ['give the metric block a label and a numeric target different from the baseline', 'remove the metric block to let progress fall back to tasks'],
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

// ─── Snapshot health ───────────────────────────────────────────────────────

/**
 * Group digits so a size reads at a glance. Duplicated (one line) from
 * `snapshot-compress.ts` rather than exported from it: that copy is private to
 * the compressor's provenance footer, and a shared formatting util is not worth
 * a new module boundary.
 */
function withThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The never-evict tier, as a runtime list.
 *
 * Typed `Record<NeverEvictSectionId, true>` on purpose: a section added to (or
 * removed from) the union in `snapshot-caps.ts` without updating this list is a
 * COMPILE error, so the message below can never name a tier that no longer
 * matches the snapshot builder.
 */
const NEVER_EVICT_SECTIONS: Record<NeverEvictSectionId, true> = {
  header: true,
  'linked-repos': true,
  soul: true,
  person: true,
  'task-override': true,
  'product-and-nudge': true,
  awareness: true,
  marketing: true,
  federation: true,
};

/**
 * The people-first layout, end to end: is there a user constitution at all, is
 * the roster readable, does every roster entry have its file, and does THIS
 * machine know who it is?
 *
 * The matrix, and why each row is the severity it is:
 *   - ERROR: neither `people/people.json` nor `core/1.user.md` — the vault has no
 *     user constitution at all, so every session starts knowing nothing about
 *     the person.
 *   - ERROR: a roster that parses to ZERO people. An empty roster is
 *     unrepresentable state, not a valid solo vault: nothing can resolve against
 *     it, and it is indistinguishable from a half-finished migration.
 *   - ERROR: a roster slug with no `people/<slug>.md`, naming each missing file —
 *     that person's constitution is the thing the snapshot renders verbatim, and
 *     its absence is silent everywhere else.
 *   - WARN + exit 0: `core/1.user.md` still present, with or without `people/`.
 *     This is D15's migration window (CLI upgraded, project not yet updated). A
 *     vault in it is working correctly, so hard-failing here would break `doctor`
 *     in CI on a healthy project.
 *   - WARN (multi-person only): the active person is unresolved on this machine,
 *     printing the resolution SOURCE so an unexpected identity is self-diagnosing.
 *
 * `readPeople` THROWS on a present-but-unparseable roster (D17). That throw is
 * caught here and reported as an error like any other: `doctor` is the tool
 * people run *because* something is wrong, so it must never die with a stack
 * trace on the very file it is diagnosing.
 */
export function checkPeople(root: string): CheckResult[] {
  const NAME = 'People';
  const results: CheckResult[] = [];
  const hasLegacyUser = existsSync(join(root, 'core', '1.user.md'));
  const retiredLayoutWarning: CheckResult = {
    name: NAME,
    status: 'warn',
    message: 'core/1.user.md — retired layout — run `dreamcontext update` to migrate to people/',
  };

  if (!hasPeopleLayout(root)) {
    if (!hasLegacyUser) {
      return [{
        name: NAME,
        status: 'error',
        message:
          'Missing: people/people.json AND core/1.user.md — this vault has no user constitution at all. '
          + 'Run `dreamcontext update` to migrate a legacy vault, or '
          + '`dreamcontext people add "<Your Name>" --email <email>` to create one.',
      }];
    }
    return [retiredLayoutWarning];
  }

  let roster: Array<{ slug: string; name: string }>;
  try {
    roster = listPeople(root);
  } catch (err) {
    results.push({
      name: NAME,
      status: 'error',
      message: `people/people.json could not be read: ${errorText(err)}`,
    });
    if (hasLegacyUser) results.push(retiredLayoutWarning);
    return results;
  }

  if (roster.length === 0) {
    results.push({
      name: NAME,
      status: 'error',
      message:
        'people/people.json lists no people — an empty roster is unrepresentable state, not a solo '
        + 'vault. Add yourself: `dreamcontext people add "<Your Name>" --email <email>`.',
    });
  } else {
    const missing = roster.filter((p) => !existsSync(personFilePath(root, p.slug)));
    if (missing.length > 0) {
      results.push({
        name: NAME,
        status: 'error',
        message:
          `Missing ${missing.length} person constitution${missing.length === 1 ? '' : 's'}: `
          + `${missing.map((p) => `people/${p.slug}.md`).join(', ')} — every roster entry needs its file `
          + '(re-create it with `dreamcontext people add "<Name>"`, which never overwrites existing prose).',
      });
    } else {
      results.push({
        name: NAME,
        status: 'ok',
        message: `people/ (${roster.length} person${roster.length === 1 ? '' : 's'}), each with a constitution`,
      });
    }

    // Only multi-person vaults can be genuinely ambiguous: a solo roster is
    // trivially implied, so an "unresolved" warning there would be noise.
    if (roster.length > 1) {
      const active = resolveActivePerson(root);
      results.push(active.slug
        ? {
            name: NAME,
            status: 'ok',
            message: `Active person: ${active.name} (\`person:${active.slug}\`, source: ${active.source})`,
          }
        : {
            name: NAME,
            status: 'warn',
            message:
              `Active person unresolved on this machine (source: ${active.source}) — ${active.reason}. `
              + 'The snapshot renders no constitution until you run '
              + '`dreamcontext people whoami --set <slug>` or add this machine\'s git email to a person.',
          });
    }
  }

  if (hasLegacyUser) results.push(retiredLayoutWarning);
  return results;
}

/**
 * Anti-bloat ceilings for the constitution-class core files.
 *
 * Reports BOTH axes, chars first, because the line ceiling the skill has always
 * stated is not a usable size proxy on its own: measured on this repo,
 * `core/0.soul.md` is 69 lines but 13,573 chars and `core/2.memory.md` is 165
 * lines / 92,249 chars — a line-only check calls the two worst offenders fine.
 *
 * The remedy text is TIER-AWARE (`audit.alwaysLoaded`). Files 0–2 and the active
 * `people/*.md` render verbatim, so their chars are a per-session bill. Extended
 * files (3+) are one index line in the snapshot no matter their size — telling
 * the user those are billed every session is simply false, and it was: the
 * warning drove an extraction plan for two files that together cost 297 chars
 * per session against 27,005 on disk.
 */
export function checkCoreFileSizes(root: string): CheckResult[] {
  const NAME = 'Core file size';
  let audits: CoreFileSizeAudit[];
  try {
    audits = auditCoreFileSizes(root);
  } catch (err) {
    return [{ name: NAME, status: 'warn', message: `Could not measure core files: ${errorText(err)}` }];
  }
  if (audits.length === 0) return [];

  const over = audits.filter((a) => a.overChars || a.overLines);
  if (over.length === 0) {
    return [{
      name: NAME,
      status: 'ok',
      message:
        `core/ (${audits.length} file${audits.length === 1 ? '' : 's'}) within the `
        + `${withThousands(CORE_FILE_CHAR_CEILING)}-char / ${CORE_FILE_LINE_CEILING}-line ceilings`,
    }];
  }

  return over.map((a) => {
    const exceeded: string[] = [];
    if (a.overChars) exceeded.push(`${withThousands(CORE_FILE_CHAR_CEILING)}-char`);
    if (a.overLines) exceeded.push(`${CORE_FILE_LINE_CEILING}-line`);
    // Only the verbatim tier is billed per session. Saying so about an extended
    // file (3+) overstates the cost by two orders of magnitude — the snapshot
    // carries ~150 chars of index for it however big it gets — and pushes the
    // user to gut a file that was never the problem.
    const cost = a.alwaysLoaded
      ? 'The SessionStart snapshot pays this every session; '
        + 'extract detail to knowledge/ and keep a summary + reference.'
      : 'Read on demand — the snapshot carries only a one-line summary, so this '
        + 'costs nothing per session; it costs when the agent opens it.';
    return {
      name: NAME,
      status: 'warn' as const,
      message:
        `${a.relPath}: ${withThousands(a.chars)} chars / ${withThousands(a.lines)} lines — over the `
        + `${exceeded.join(' and ')} ceiling. ${cost}`,
      code: 'doctor/core-file-ceiling',
      subject: { file: a.relPath },
      evidence: {
        chars: a.chars,
        lines: a.lines,
        charCeiling: CORE_FILE_CHAR_CEILING,
        lineCeiling: CORE_FILE_LINE_CEILING,
        alwaysLoaded: a.alwaysLoaded,
      },
      supportedFixes: [`extract detail from ${a.relPath} to knowledge/ and keep a summary + reference`],
    };
  });
}

/**
 * Does the rendered snapshot actually reach the agent?
 *
 * Past HARNESS_PERSIST_CHAR_LIMIT the harness writes the whole snapshot to a
 * file and injects only a blind positional preview — the failure is invisible
 * from the outside, because the snapshot prints fine on the terminal and is
 * absent exactly when the agent needs it. This is what makes it noticeable
 * without measuring by hand.
 *
 * Measures with `fireTriggers: false`: rendering the snapshot is the only write
 * in that whole path (a matched contextual reminder consumes one of its finite
 * firings), and a health check must not spend one.
 */
export function checkSnapshotSize(root: string): CheckResult[] {
  const NAME = 'Snapshot size';
  let measured: SnapshotMeasurement;
  try {
    measured = measureSnapshot(root, { fireTriggers: false });
  } catch (err) {
    return [{
      name: NAME,
      status: 'warn',
      message: `Could not render the snapshot to measure it: ${errorText(err)}`,
    }];
  }

  const chars = measured.text.length;
  const { neverEvictChars } = measured.budget;
  const pct = Math.round((chars / HARNESS_PERSIST_CHAR_LIMIT) * 100);

  // BudgetResult does not carry the budget it ran against, so resolve it here
  // exactly as the snapshot does. `null` means the ladder is switched OFF.
  const budgetTokens = resolveBudget(process.env.DREAMCONTEXT_SNAPSHOT_BUDGET);
  const ladderOff = budgetTokens === null;
  const budgetChars = ladderOff
    ? Math.floor(HARNESS_PERSIST_CHAR_LIMIT * 0.9)
    : budgetTokens * 4;

  // The one state the ladder genuinely cannot fix: the pinned tier alone busts
  // the limit, so no amount of demotion helps. Everything else is a warning.
  if (neverEvictChars > HARNESS_PERSIST_CHAR_LIMIT) {
    return [{
      name: NAME,
      status: 'error',
      message:
        `Never-evict tier is ${withThousands(neverEvictChars)} chars — past the `
        + `${withThousands(HARNESS_PERSIST_CHAR_LIMIT)}-char harness limit on its own, so the demotion `
        + `ladder cannot fix this. The never-evict sections (${Object.keys(NEVER_EVICT_SECTIONS).join(', ')}) `
        + 'are pinned by design; the usual cause is an oversized core/0.soul.md or people/<active>.md, which '
        + 'both render verbatim and must be slimmed by moving content OUT — conditional "when X, do Y" '
        + 'rules into knowledge/patterns, and anything that is not about the person out of that person\'s '
        + 'constitution. '
        + 'Otherwise check overrides/task.md and state/.sleep.json (contextual reminders, automations) '
        + 'for an oversized block.',
      code: 'doctor/snapshot-never-evict-overflow',
      subject: { tier: 'never-evict', sections: Object.keys(NEVER_EVICT_SECTIONS) },
      evidence: { neverEvictChars, harnessLimit: HARNESS_PERSIST_CHAR_LIMIT },
      supportedFixes: [
        'slim core/0.soul.md — move conditional "when X, do Y" rules into knowledge/patterns',
        'slim people/<active>.md — move anything not about the person out of the constitution',
        'check overrides/task.md and state/.sleep.json for an oversized block',
      ],
    }];
  }

  if (chars > HARNESS_PERSIST_CHAR_LIMIT) {
    // A disabled ladder renders everything at full size by design. Blaming the
    // core files for that would send the user to trim files that are fine.
    const message = ladderOff
      ? `Snapshot renders at ${withThousands(chars)} chars — over the `
        + `${withThousands(HARNESS_PERSIST_CHAR_LIMIT)}-char harness limit, but DREAMCONTEXT_SNAPSHOT_BUDGET `
        + 'is set to off, so the demotion ladder is disabled. Unset it to restore the budgeted render '
        + 'before reading this as core-file bloat.'
      : `Snapshot renders at ${withThousands(chars)} chars — over the `
        + `${withThousands(HARNESS_PERSIST_CHAR_LIMIT)}-char harness limit. Claude Code persists it to a `
        + `file and injects only a ${withThousands(HARNESS_PREVIEW_CHARS)}-char blind preview, so the agent `
        + `starts near-blind. Never-evict tier: ${withThousands(neverEvictChars)} chars. Trim the core `
        + 'files flagged above — extract detail to knowledge/.';
    return [{
      name: NAME, status: 'warn', message,
      code: 'doctor/snapshot-over-harness-limit',
      evidence: { chars, harnessLimit: HARNESS_PERSIST_CHAR_LIMIT, neverEvictChars, ladderOff },
      supportedFixes: ladderOff
        ? ['unset DREAMCONTEXT_SNAPSHOT_BUDGET to restore the budgeted render']
        : ['trim the core files flagged by doctor/core-file-ceiling — extract detail to knowledge/'],
    }];
  }

  if (chars > budgetChars) {
    const message = ladderOff
      ? `Snapshot renders at ${withThousands(chars)} chars — ${pct}% of the `
        + `${withThousands(HARNESS_PERSIST_CHAR_LIMIT)}-char harness limit, with little headroom left. `
        + '(DREAMCONTEXT_SNAPSHOT_BUDGET is off, so the demotion ladder is disabled.)'
      : `Snapshot renders at ${withThousands(chars)} chars — past the ladder's `
        + `${withThousands(budgetChars)}-char target (${withThousands(budgetTokens)} tok x 4), so sections `
        + `are already demoting, though it still lands inline under the `
        + `${withThousands(HARNESS_PERSIST_CHAR_LIMIT)}-char harness limit.`;
    return [{
      name: NAME, status: 'warn', message,
      code: 'doctor/snapshot-over-budget',
      evidence: { chars, budgetChars, harnessLimit: HARNESS_PERSIST_CHAR_LIMIT, ladderOff },
    }];
  }

  return [{
    name: NAME,
    status: 'ok',
    message:
      `Snapshot size — ${withThousands(chars)} chars `
      + `(${pct}% of the ${withThousands(HARNESS_PERSIST_CHAR_LIMIT)}-char harness limit)`,
  }];
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
    for (const message of messages) results.push({ name: 'Task↔feature links', status: 'warn', message, code: 'doctor/link-drift' });
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
      results.push({
        name: 'Task↔feature links', status: 'warn',
        message: `${healable} of the above are deterministic — fix them all: dreamcontext doctor --heal-links`,
        code: 'doctor/link-drift-healable',
        evidence: { healable },
        supportedFixes: ['dreamcontext doctor --heal-links'],
      });
    }
  }
  return results;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Validate _dream_context/ structure and report issues')
    .option('--heal-links', 'Apply the deterministic task↔feature link fixes (adopt back-refs, drop ghost/foreign related_tasks entries, canonicalize slugs) before running the checks')
    .option('--json', 'Emit a machine-readable diagnostic report: every check carries a stable code, plus subject/evidence/supportedFixes where annotated')
    .action((opts: { healLinks?: boolean; json?: boolean }) => {
      const root = resolveContextRoot();
      if (!root) {
        if (opts.json) {
          console.log(JSON.stringify({ version: 1, error: '_dream_context/ not found — run `dreamcontext init` to create it' }, null, 2));
        } else {
          console.log(chalk.red('✗') + ' _dream_context/ not found. Run `dreamcontext init` to create it.');
        }
        process.exit(1);
      }

      if (!opts.json) console.log(header('Doctor'));

      let heal: Record<string, unknown> | undefined;
      if (opts.healLinks) {
        const report = reconcileFeatureLinks(root);
        const fixed =
          report.adopted.length + report.canonicalized.length + report.membershipsAdded.length
          + report.ghostTaskRefsDropped.length + report.foreignClaimsDropped.length;
        if (opts.json) {
          heal = {
            adopted: report.adopted.length,
            canonicalized: report.canonicalized.length,
            membershipsAdded: report.membershipsAdded.length,
            ghostTaskRefsDropped: report.ghostTaskRefsDropped.length,
            foreignClaimsDropped: report.foreignClaimsDropped.length,
            unresolved: report.unresolved,
          };
        } else {
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
      }

      const results: CheckResult[] = [
        // Directories
        checkDirectory(root, 'core', 'Core directory'),
        checkFeaturesMigrated(root),
        checkDirectory(root, 'knowledge', 'Knowledge directory'),
        checkDirectory(root, 'state', 'State directory'),

        // Required core files
        checkFile(root, 'core/0.soul.md', 'Soul file', true),
        // Slot 1's replacement, in place: the user constitution moved to
        // people/, and the legacy file became a warning rather than a
        // requirement (see checkPeople for the full matrix).
        ...checkPeople(root),
        checkFile(root, 'core/2.memory.md', 'Memory file', true),

        // JSON files
        checkJson(root, 'core/CHANGELOG.json', 'Changelog', 'array'),
        checkJson(root, 'core/RELEASES.json', 'Releases', 'array'),

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

        // Snapshot health. Core files FIRST so the snapshot-size message's
        // "trim the core files flagged above" points at lines already printed.
        ...checkCoreFileSizes(root),
        ...checkSnapshotSize(root),

        // Taxonomy vocabulary (non-fatal: absent means DEFAULT_VOCABULARY used)
        ...(!existsSync(join(root, 'core', 'taxonomy.json'))
          ? [{
              name: 'Taxonomy vocabulary',
              status: 'warn' as const,
              message: 'core/taxonomy.json not found — run `dreamcontext taxonomy init` to scaffold it',
              code: 'doctor/taxonomy-missing',
              subject: { file: 'core/taxonomy.json' },
              supportedFixes: ['dreamcontext taxonomy init'],
            }]
          : [checkJson(root, 'core/taxonomy.json', 'Taxonomy vocabulary', 'object')]),

        // Sleep state (optional — created on first Stop hook)
        ...(existsSync(join(root, 'state', '.sleep.json'))
          ? [checkJson(root, 'state/.sleep.json', 'Sleep state', 'object')]
          : []),
        ...(existsSync(join(root, 'state', '.platforms.json'))
          ? [checkJson(root, 'state/.platforms.json', 'Platform defaults', 'object')]
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

      if (opts.json) {
        const report: DoctorReport & { heal?: Record<string, unknown> } = buildDoctorReport(results);
        if (heal) report.heal = heal;
        console.log(JSON.stringify(report, null, 2));
        if (report.summary.error > 0) process.exit(1);
        return;
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
