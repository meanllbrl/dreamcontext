import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import { insertToSection } from '../../lib/markdown.js';
import { prepareSectionInsert, SECTION_MAP } from '../../lib/section-insert.js';
import { promptInput } from '../../lib/prompt.js';
import { generateId, slugify, today } from '../../lib/id.js';
import { success, error, header, warn, info } from '../../lib/format.js';
import { analyzeFeatures, type FeatureRef, type TaskRef } from '../../lib/feature-freshness.js';
import { featuresDir, featureSlug, featureProduct, FEATURES_SUBDIR, FEATURES_TYPE } from '../../lib/features-path.js';
import { resolveFeature, taskExists, applyFeatureTaskList, healFeatureRename } from '../../lib/feature-links.js';
import { moveKnowledgeFile } from '../../lib/knowledge-move.js';
import { migrateKnowledgeAccessKey } from './sleep.js';

/**
 * Normalise a free-form feature subfolder path (relative to knowledge/features/):
 * forward-slash separators, trimmed, no leading/trailing slashes, each segment
 * slugified. Returns '' for an empty/whitespace input. Nothing is reserved —
 * folders are free-form topical groupings (typically per product).
 */
function normalizeFeatureFolder(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) => slugify(seg))
    .filter(Boolean)
    .join('/');
}

/** A path segment is unsafe when it is empty, '.', or '..'. */
function hasUnsafeSegment(p: string): boolean {
  return p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

const VALID_FEATURE_STATUSES = ['planning', 'in_progress', 'in_review', 'active', 'shipped', 'deprecated'];

function parseCsv(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function getFeaturesDir(): string {
  const root = ensureContextRoot();
  return featuresDir(root);
}

// Features are typed knowledge now (migration 0.10.7) — `dreamcontext features`
// remains a compat alias. Print the notice once per process invocation (a
// single CLI call never spams it twice even if multiple actions run).
let deprecationPrinted = false;
function printDeprecation(): void {
  if (deprecationPrinted) return;
  deprecationPrinted = true;
  warn(
    'dreamcontext features is deprecated — features are now typed knowledge under knowledge/features/. This alias will be removed in a future release.',
  );
}

// Resolution lives in the link engine (src/lib/feature-links.ts) so the CLI,
// server, and healing paths all match feature references identically.
function findFeatureFile(name: string): string | null {
  const resolved = resolveFeature(ensureContextRoot(), name);
  if (resolved.ok) return resolved.path;
  if (resolved.reason === 'ambiguous') {
    error(`Ambiguous feature name "${name}". Did you mean: ${resolved.candidates.join(', ')}?`);
  }
  return null;
}

/**
 * Validate a related_tasks list against the task store and apply it through
 * the bidirectional link engine (each added task's `related_feature` is set,
 * each removed task's is cleared). Prints what changed. Returns false when a
 * slug is unknown — the write is refused, mirroring `tasks objectives`.
 */
function setRelatedTasksValidated(file: string, taskSlugs: string[]): boolean {
  const root = ensureContextRoot();
  const slug = featureSlug(featuresDir(root), file);
  const unknown = taskSlugs.filter((t) => !taskExists(root, t));
  if (unknown.length > 0) {
    error(
      `Unknown task slug(s): ${unknown.join(', ')}. `
      + 'related_tasks entries must be existing task slugs (state/<slug>.md) — check: dreamcontext tasks list',
    );
    return false;
  }
  const result = applyFeatureTaskList(root, { slug, path: file }, taskSlugs);
  for (const t of result.linked) info(`  linked: ${t} → related_feature: ${slug}`);
  for (const r of result.relinked) info(`  re-linked: ${r.task} (was → ${r.from})`);
  for (const t of result.unlinked) info(`  unlinked: ${t} (related_feature cleared)`);
  return true;
}

function getFeatureTemplate(): string {
  // Try to load from templates directory
  const candidates = [
    join(new URL('.', import.meta.url).pathname, '..', '..', 'templates', 'feature.md'),
    join(new URL('.', import.meta.url).pathname, '..', 'templates', 'feature.md'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8');
    }
  }

  // Inline fallback
  return `---
id: "{{ID}}"
type: "${FEATURES_TYPE}"
name: "{{NAME}}"
description: "{{DESCRIPTION}}"
pinned: false
date: "{{DATE}}"
status: "planning"
created: "{{DATE}}"
updated: "{{DATE}}"
released_version: null
tags: []
related_tasks: []
---

## Why

{{WHY}}

## User Stories

- [ ] As a [user], I want [action] so that [outcome]

## Acceptance Criteria

- (Specific, testable conditions for this feature to be complete)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

## Technical Details

(How this feature is wired. Key files, services, dependencies, flows.)

## Notes

(Edge cases, open questions, future considerations.)

## Changelog
<!-- LIFO: newest entry at top -->

### {{DATE}} - Created
- Feature PRD created.
`;
}

export function registerFeaturesCommand(program: Command): void {
  const features = program
    .command('features')
    .description('Create features and insert into sections');

  // Create a feature
  features
    .command('create')
    .argument('<name>')
    .option('-w, --why <why>', 'Why are we building this?')
    .option('-d, --description <description>', 'One-line description (knowledge-index display)')
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .option('-s, --status <status>', `Status (${VALID_FEATURE_STATUSES.join(', ')})`)
    .option('--related-tasks <slugs>', 'Comma-separated related task slugs')
    .option('--folder <path>', 'Topical subfolder under knowledge/features/ (e.g. a product name like "lina" or "lina/billing")')
    .description('Create a new feature document (typed knowledge under knowledge/features/)')
    .action(async (name: string, opts: { why?: string; description?: string; tags?: string; status?: string; relatedTasks?: string; folder?: string }) => {
      printDeprecation();
      const dir = getFeaturesDir();
      const base = slugify(name);

      let folder = '';
      if (opts.folder) {
        folder = normalizeFeatureFolder(opts.folder);
        if (!folder || hasUnsafeSegment(folder)) {
          error(`Invalid --folder "${opts.folder}". Use a relative path under knowledge/features/ with no "..".`);
          return;
        }
      }

      const relSlug = folder ? `${folder}/${base}` : base;
      const targetDir = folder ? join(dir, folder) : dir;
      const filePath = join(targetDir, `${base}.md`);

      if (existsSync(filePath)) {
        error(`Feature already exists: ${relSlug}.md`);
        return;
      }

      if (opts.status && !VALID_FEATURE_STATUSES.includes(opts.status)) {
        error(`Status must be one of: ${VALID_FEATURE_STATUSES.join(', ')}`);
        return;
      }

      const why = opts.why || await promptInput({ message: 'Why are we building this?' });
      const date = today();

      const template = getFeatureTemplate();
      const content = template
        .replaceAll('{{ID}}', generateId('feat'))
        .replaceAll('{{DATE}}', date)
        .replaceAll('{{NAME}}', name)
        .replaceAll('{{DESCRIPTION}}', opts.description ?? '')
        .replaceAll('{{WHY}}', why || '(To be defined)');

      if (folder) mkdirSync(targetDir, { recursive: true });
      writeFileSync(filePath, content, 'utf-8');

      const fields: Record<string, unknown> = {};
      if (opts.tags) fields.tags = parseCsv(opts.tags);
      if (opts.status) fields.status = opts.status;
      if (Object.keys(fields).length > 0) {
        updateFrontmatterFields(filePath, fields);
      }
      // related_tasks goes through the link engine: slugs are validated and each
      // task's `related_feature` is written back (bidirectional invariant).
      if (opts.relatedTasks) {
        setRelatedTasksValidated(filePath, parseCsv(opts.relatedTasks));
      }

      success(`Feature created: ${relSlug}.md`);
    });

  // Set a feature's frontmatter field (tags / status / related_tasks)
  features
    .command('set')
    .argument('<name>')
    .argument('<field>', 'tags | status | related_tasks')
    .argument('<value...>', 'Value (comma-separated for tags / related_tasks)')
    .description('Set a feature frontmatter field without hand-editing')
    .action((name: string, field: string, valueParts: string[]) => {
      printDeprecation();
      const file = findFeatureFile(name);
      if (!file) {
        error(`Feature not found: ${name}`);
        return;
      }

      const key = field.toLowerCase();
      const value = valueParts.join(' ').trim();
      const updates: Record<string, unknown> = {};

      if (key === 'related_tasks' || key === 'related-tasks') {
        // Validated + written through the link engine (sets/clears each task's
        // related_feature) — never a raw frontmatter write.
        if (setRelatedTasksValidated(file, parseCsv(value))) {
          success(`Set related_tasks on ${featureSlug(getFeaturesDir(), file)}`);
        }
        return;
      }
      if (key === 'tags') {
        updates.tags = parseCsv(value);
      } else if (key === 'status') {
        if (!VALID_FEATURE_STATUSES.includes(value)) {
          error(`Status must be one of: ${VALID_FEATURE_STATUSES.join(', ')}`);
          return;
        }
        updates.status = value;
      } else {
        error(`Unknown field: "${field}". Settable fields: tags, status, related_tasks`);
        return;
      }

      updates.updated = today();
      updateFrontmatterFields(file, updates);
      success(`Set ${key} on ${featureSlug(getFeaturesDir(), file)}`);
    });

  // Insert into a section
  features
    .command('insert')
    .argument('<name>')
    .argument(
      '<section>',
      'Section: changelog, notes, technical_details, constraints, user_stories, acceptance_criteria',
    )
    .argument('[content...]', 'Content to insert')
    .description('Insert content into a feature section')
    .action(async (name: string, section: string, contentParts: string[]) => {
      printDeprecation();
      const file = findFeatureFile(name);
      if (!file) {
        error(`Feature not found: ${name}`);
        return;
      }

      const sectionKey = section.toLowerCase();
      if (!SECTION_MAP[sectionKey]) {
        error(`Unknown section: "${section}". Valid sections: ${Object.keys(SECTION_MAP).join(', ')}`);
        return;
      }

      const rawContent = contentParts.length > 0
        ? contentParts.join(' ')
        : await promptInput({ message: `Content for ${SECTION_MAP[sectionKey]}:` });

      if (!rawContent.trim()) {
        error('No content provided.');
        return;
      }

      const prep = prepareSectionInsert(sectionKey, rawContent, today())!;

      try {
        insertToSection(file, prep.sectionName, prep.content, prep.position, true, prep.replacePlaceholders);
        updateFrontmatterFields(file, { updated: today() });
        success(`Inserted into ${prep.sectionName} in ${featureSlug(getFeaturesDir(), file)}`);
      } catch (err: any) {
        error(err.message);
      }
    });

  // Move a feature into a topical/product subfolder (or back to the root).
  features
    .command('move')
    .argument('<name>', 'Feature name or current slug (e.g. "checkout" or "lina/checkout")')
    .argument('<folder>', 'Destination subfolder under knowledge/features/ (free-form, e.g. a product name; "." or "/" moves back to the root)')
    .description('Move a feature into a topical subfolder, rewriting inbound [[wikilinks]] atomically')
    .action((name: string, folder: string) => {
      printDeprecation();
      const root = ensureContextRoot();
      const dir = getFeaturesDir();

      const file = findFeatureFile(name);
      if (!file) {
        error(`Feature not found: ${name}`);
        return;
      }
      const curRelSlug = featureSlug(dir, file);

      // Features are typed knowledge — reuse the knowledge move engine, scoping
      // both slugs under `features/`. A folder of "." / "" / "/" targets the
      // features root itself (move a nested feature back up).
      const destFolder = normalizeFeatureFolder(folder === '.' ? '' : folder);
      if (destFolder && hasUnsafeSegment(destFolder)) {
        error(`Invalid destination folder "${folder}". Use a relative path under knowledge/features/ with no "..".`);
        return;
      }
      const knowledgeSlug = `${FEATURES_SUBDIR}/${curRelSlug}`;
      const knowledgeFolder = destFolder ? `${FEATURES_SUBDIR}/${destFolder}` : FEATURES_SUBDIR;

      const result = moveKnowledgeFile(root, knowledgeSlug, knowledgeFolder);
      if (!result.ok) {
        error(result.message);
        return;
      }

      // Keep decay tracking continuous (best-effort — never undo a done move).
      try {
        migrateKnowledgeAccessKey(root, result.oldSlug, result.newSlug);
      } catch {
        /* access tracking is best-effort; the move already succeeded */
      }

      // Heal the TASK side of the bidirectional link: a feature move changes its
      // canonical slug, so every task whose `related_feature` pointed at the old
      // slug must be repointed at the new one (mirror of healTaskRename on task
      // rename/delete). Otherwise the link goes stale — invisible in the
      // dashboard picker + `tasks list --feature`, and it silently mis-resolves
      // once a same-basename feature exists elsewhere. Best-effort: a failure
      // here must never undo the completed on-disk move (doctor --heal-links is
      // the backstop). Feature slugs strip the `features/` knowledge prefix.
      let healedTasks: string[] = [];
      try {
        const prefix = `${FEATURES_SUBDIR}/`;
        const oldFeatureSlug = result.oldSlug.startsWith(prefix) ? result.oldSlug.slice(prefix.length) : result.oldSlug;
        const newFeatureSlug = result.newSlug.startsWith(prefix) ? result.newSlug.slice(prefix.length) : result.newSlug;
        healedTasks = healFeatureRename(root, oldFeatureSlug, newFeatureSlug);
      } catch {
        /* link healing is best-effort; the move already succeeded */
      }

      success(`Moved ${result.oldPath} → ${result.newPath}`);
      if (result.wikilinksRewritten.length > 0) {
        info(`Rewrote inbound [[wikilinks]] in ${result.wikilinksRewritten.length} file(s).`);
      } else {
        info('No inbound [[wikilinks]] needed rewriting.');
      }
      if (healedTasks.length > 0) {
        info(`Repointed related_feature on ${healedTasks.length} task(s): ${healedTasks.join(', ')}`);
      }
    });

  // Doctor: read-only freshness + linkage health check
  features
    .command('doctor')
    .description('Check feature PRDs for staleness, orphans, and dangling task references (read-only)')
    .action(() => {
      printDeprecation();
      const root = ensureContextRoot();
      const dir = getFeaturesDir();
      const stateDir = join(root, 'state');

      // Read all feature PRDs (recurse into topical/product subfolders).
      const featureFiles = existsSync(dir)
        ? fg.sync('**/*.md', { cwd: dir, absolute: true })
        : [];

      const featureRefs: FeatureRef[] = [];
      // SSOT guard: a feature's product is DERIVED from its folder, never stored.
      // A `product:` frontmatter field is a second source that can diverge from
      // the path — collect any so doctor can flag it.
      const productDrift: Array<{ slug: string; stored: string; folder: string | undefined }> = [];
      for (const file of featureFiles) {
        try {
          const { data } = readFrontmatter<Record<string, unknown>>(file);
          const slug = featureSlug(dir, file);
          featureRefs.push({
            slug,
            id: data.id ? String(data.id) : undefined,
            created: data.created ? String(data.created) : undefined,
            updated: data.updated ? String(data.updated) : undefined,
            related_tasks: Array.isArray(data.related_tasks)
              ? data.related_tasks.map(String)
              : [],
          });
          if (typeof data.product === 'string' && data.product.trim()) {
            productDrift.push({ slug, stored: data.product.trim(), folder: featureProduct(dir, file) });
          }
        } catch {
          // skip unreadable files
        }
      }

      // Read all task state files for related_feature back-refs
      const taskFiles = existsSync(stateDir)
        ? fg.sync('*.md', { cwd: stateDir, absolute: true })
        : [];

      const taskRefs: TaskRef[] = [];
      for (const file of taskFiles) {
        const taskSlug = basename(file, '.md');
        if (taskSlug.startsWith('.')) continue; // skip hidden files
        try {
          const { data } = readFrontmatter<Record<string, unknown>>(file);
          taskRefs.push({
            task: taskSlug,
            related_feature: data.related_feature ? String(data.related_feature) : null,
          });
        } catch {
          // skip unreadable files
        }
      }

      const { stale, orphaned, danglingTaskRefs } = analyzeFeatures(featureRefs, taskRefs);

      console.log(header('Features doctor'));

      const issueCount = stale.length + orphaned.length + danglingTaskRefs.length + productDrift.length;

      if (issueCount === 0) {
        success(`All ${featureRefs.length} feature(s) fresh and linked.`);
        return;
      }

      if (stale.length > 0) {
        console.log(`\n  ${chalk.yellow('STALE')} (${stale.length})`);
        for (const s of stale) {
          console.log(`    ${chalk.yellow('·')} ${chalk.bold(s.slug)}  ${chalk.dim(`${s.daysSinceUpdate}d`)}  ${chalk.dim(s.note)}`);
        }
      }

      if (orphaned.length > 0) {
        console.log(`\n  ${chalk.red('ORPHANED')} (${orphaned.length})  — no related tasks in either direction`);
        for (const o of orphaned) {
          console.log(`    ${chalk.red('·')} ${chalk.bold(o.slug)}`);
        }
      }

      if (danglingTaskRefs.length > 0) {
        console.log(`\n  ${chalk.red('DANGLING TASK REFS')} (${danglingTaskRefs.length})  — task points to missing feature PRD`);
        for (const d of danglingTaskRefs) {
          console.log(`    ${chalk.red('·')} ${chalk.bold(d.task)} → ${chalk.dim(d.missingFeature)}`);
        }
      }

      if (productDrift.length > 0) {
        console.log(`\n  ${chalk.yellow('STORED PRODUCT FIELD')} (${productDrift.length})  — a feature's product is derived from its folder; the frontmatter field is a divergence risk`);
        for (const p of productDrift) {
          const derived = p.folder ? `folder → ${p.folder}` : 'flat (no product)';
          const verdict = p.folder === p.stored
            ? chalk.dim('redundant — remove the field')
            : chalk.red(`conflicts with ${derived} — remove the field${p.folder ? '' : `, or move to features/${p.stored}/`}`);
          console.log(`    ${chalk.yellow('·')} ${chalk.bold(p.slug)}  ${chalk.dim(`product: ${p.stored}`)}  ${verdict}`);
        }
      }

      process.exitCode = 1;
    });
}
