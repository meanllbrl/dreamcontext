import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { resolveContextRoot } from '../../lib/context-path.js';
import { header } from '../../lib/format.js';
import { listUnfencedDataStructures } from '../../lib/data-structures-migration.js';
import { hasTaskOverride, loadTaskOverride } from '../../lib/overrides.js';
import { listObjectives, isSafeObjectiveSlug, isCalendarDate, OBJECTIVE_STATUSES } from '../../lib/objectives-store.js';
import { buildRoadmapModel } from '../../lib/roadmap-model.js';

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

interface CheckResult {
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

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Validate _dream_context/ structure and report issues')
    .action(() => {
      const root = resolveContextRoot();
      if (!root) {
        console.log(chalk.red('✗') + ' _dream_context/ not found. Run `dreamcontext init` to create it.');
        process.exit(1);
      }

      console.log(header('Doctor'));

      const results: CheckResult[] = [
        // Directories
        checkDirectory(root, 'core', 'Core directory'),
        checkDirectory(root, 'core/features', 'Features directory'),
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
