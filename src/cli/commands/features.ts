import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { ensureContextRoot } from '../../lib/context-path.js';
import { updateFrontmatterFields } from '../../lib/frontmatter.js';
import { insertToSection } from '../../lib/markdown.js';
import { prepareSectionInsert, SECTION_MAP } from '../../lib/section-insert.js';
import { promptInput } from '../../lib/prompt.js';
import { generateId, slugify, today } from '../../lib/id.js';
import { success, error } from '../../lib/format.js';

const VALID_FEATURE_STATUSES = ['planning', 'in_progress', 'in_review', 'active', 'shipped', 'deprecated'];

function parseCsv(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function getFeaturesDir(): string {
  const root = ensureContextRoot();
  return join(root, 'core', 'features');
}

function findFeatureFile(name: string): string | null {
  const dir = getFeaturesDir();
  const slug = slugify(name);

  // Try exact match first
  const exact = join(dir, `${slug}.md`);
  if (existsSync(exact)) return exact;

  // Try glob match: prefer exact, then prefix, then substring
  const files = fg.sync('*.md', { cwd: dir, absolute: true });

  const exactGlob = files.find((f) => basename(f, '.md') === slug);
  if (exactGlob) return exactGlob;

  const prefixMatches = files.filter((f) => basename(f, '.md').startsWith(slug));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    error(`Ambiguous feature name "${name}". Did you mean: ${prefixMatches.map(f => basename(f, '.md')).join(', ')}?`);
    return null;
  }

  const substringMatches = files.filter((f) => basename(f, '.md').includes(slug));
  if (substringMatches.length === 1) return substringMatches[0];
  if (substringMatches.length > 1) {
    error(`Ambiguous feature name "${name}". Did you mean: ${substringMatches.map(f => basename(f, '.md')).join(', ')}?`);
    return null;
  }

  return null;
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
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .option('-s, --status <status>', `Status (${VALID_FEATURE_STATUSES.join(', ')})`)
    .option('--related-tasks <slugs>', 'Comma-separated related task slugs')
    .description('Create a new feature document')
    .action(async (name: string, opts: { why?: string; tags?: string; status?: string; relatedTasks?: string }) => {
      const dir = getFeaturesDir();
      const slug = slugify(name);
      const filePath = join(dir, `${slug}.md`);

      if (existsSync(filePath)) {
        error(`Feature already exists: ${slug}.md`);
        return;
      }

      if (opts.status && !VALID_FEATURE_STATUSES.includes(opts.status)) {
        error(`Status must be one of: ${VALID_FEATURE_STATUSES.join(', ')}`);
        return;
      }

      const why = opts.why || await promptInput({ message: 'Why are we building this?' });

      const template = getFeatureTemplate();
      const content = template
        .replaceAll('{{ID}}', generateId('feat'))
        .replaceAll('{{DATE}}', today())
        .replaceAll('{{WHY}}', why || '(To be defined)');

      writeFileSync(filePath, content, 'utf-8');

      const fields: Record<string, unknown> = {};
      if (opts.tags) fields.tags = parseCsv(opts.tags);
      if (opts.status) fields.status = opts.status;
      if (opts.relatedTasks) fields.related_tasks = parseCsv(opts.relatedTasks);
      if (Object.keys(fields).length > 0) {
        updateFrontmatterFields(filePath, fields);
      }

      success(`Feature created: ${slug}.md`);
    });

  // Set a feature's frontmatter field (tags / status / related_tasks)
  features
    .command('set')
    .argument('<name>')
    .argument('<field>', 'tags | status | related_tasks')
    .argument('<value...>', 'Value (comma-separated for tags / related_tasks)')
    .description('Set a feature frontmatter field without hand-editing')
    .action((name: string, field: string, valueParts: string[]) => {
      const file = findFeatureFile(name);
      if (!file) {
        error(`Feature not found: ${name}`);
        return;
      }

      const key = field.toLowerCase();
      const value = valueParts.join(' ').trim();
      const updates: Record<string, unknown> = {};

      if (key === 'tags' || key === 'related_tasks' || key === 'related-tasks') {
        updates[key === 'tags' ? 'tags' : 'related_tasks'] = parseCsv(value);
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
      success(`Set ${key} on ${basename(file, '.md')}`);
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
        success(`Inserted into ${prep.sectionName} in ${basename(file)}`);
      } catch (err: any) {
        error(err.message);
      }
    });
}
