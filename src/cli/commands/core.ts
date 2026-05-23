import { Command } from 'commander';
import { join } from 'node:path';
import { input, select, checkbox } from '@inquirer/prompts';
import { ensureContextRoot } from '../../lib/context-path.js';
import { insertToJsonArray } from '../../lib/json-file.js';
import { generateId, today } from '../../lib/id.js';
import { success, error, info, header, formatTable } from '../../lib/format.js';
import {
  getExistingReleases,
  findUnreleasedTasks,
  findUnreleasedFeatures,
  findUnreleasedChangelog,
} from '../../lib/release-discovery.js';
import type { ReleaseEntry } from '../../lib/release-discovery.js';
import { backPopulateFeatures } from '../../lib/release-backpopulate.js';
import {
  getActivePlanningVersion,
  setActivePlanningVersion,
  clearActivePlanningVersion,
} from '../../lib/active-version.js';

export function registerCoreCommand(program: Command): void {
  const core = program
    .command('core')
    .description('Add changelog and release entries');

  // Changelog operations
  const changelog = core
    .command('changelog')
    .description('Manage CHANGELOG.json');

  changelog
    .command('add')
    .description('Add a changelog entry')
    .option('--type <type>', 'Type (feat|fix|refactor|chore|docs|perf|test|change)')
    .option('--scope <scope>', 'Scope (e.g., auth, ui, api)')
    .option('--description <desc>', 'Description (long-form, full body)')
    .option('--summary <summary>', 'Optional ≤200-char one-liner for snapshot display')
    .option('--references <refs>', 'Optional comma-separated references (commit:<sha>, file:<path>, knowledge:<slug>, feature:<slug>, task:<slug>, url:<href>)')
    .option('--supersedes <key>', 'Optional pointer to prior entry this supersedes (e.g., "2026-05-09|sleep")')
    .option('--breaking', 'Mark as a breaking change', false)
    .action(async (opts: { type?: string; scope?: string; description?: string; summary?: string; references?: string; supersedes?: string; breaking?: boolean }) => {
      const root = ensureContextRoot();
      const filePath = join(root, 'core', 'CHANGELOG.json');

      const type = opts.type ?? await select({
        message: 'Type:',
        choices: [
          { value: 'feat', name: 'feat - New feature' },
          { value: 'fix', name: 'fix - Bug fix' },
          { value: 'refactor', name: 'refactor - Code restructure' },
          { value: 'chore', name: 'chore - Maintenance' },
          { value: 'docs', name: 'docs - Documentation' },
          { value: 'perf', name: 'perf - Performance' },
          { value: 'test', name: 'test - Tests' },
          { value: 'change', name: 'change - Behavior change or reversal' },
        ],
      });

      const scope = opts.scope ?? await input({ message: 'Scope (e.g., auth, ui, api):' });
      const description = opts.description ?? await input({ message: 'Description:' });
      const summary = opts.summary;
      if (summary && summary.length > 200) {
        info(`Warning: summary is ${summary.length} chars (soft target ≤200). Will be stored as-is; snapshot may truncate.`);
      }
      const references = opts.references
        ? opts.references.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      if (references) {
        const validPrefixes = ['commit:', 'file:', 'knowledge:', 'feature:', 'task:', 'url:'];
        const bad = references.filter((r) => !validPrefixes.some((p) => r.startsWith(p)));
        if (bad.length > 0) {
          info(`Warning: ${bad.length} reference(s) missing a known prefix (${validPrefixes.join('|')}): ${bad.join(', ')}. Stored anyway.`);
        }
      }
      const supersedes = opts.supersedes ?? undefined;
      const breaking = opts.breaking ?? (typeof opts.breaking === 'boolean'
        ? opts.breaking
        : await select({
            message: 'Breaking change?',
            choices: [
              { value: false, name: 'No' },
              { value: true, name: 'Yes' },
            ],
          })
      );

      const entry: Record<string, unknown> = {
        date: today(),
        type,
        scope,
        description,
        breaking: !!breaking,
      };
      if (summary) entry.summary = summary;
      if (references && references.length > 0) entry.references = references;
      if (supersedes) entry.supersedes = supersedes;

      insertToJsonArray(filePath, entry);

      success('Changelog entry added.');
    });

  // Releases operations
  const releases = core
    .command('releases')
    .description('Manage RELEASES.json');

  releases
    .command('add')
    .description('Create a release with auto-discovered tasks, features, and changelog entries')
    .option('-V, --ver <version>', 'Version string (e.g., 1.2.0)')
    .option('-s, --summary <summary>', 'Release summary')
    .option('--status <status>', 'Release status: planning or released (default: released)')
    .option('-y, --yes', 'Skip interactive selection, include all discovered items')
    .action(async (opts) => {
      const root = ensureContextRoot();
      const releasesPath = join(root, 'core', 'RELEASES.json');
      const auto = !!opts.yes;
      const releaseStatus = opts.status === 'planning' ? 'planning' : 'released' as const;

      // 1. Version
      const version = opts.ver ?? (auto ? '' : await input({ message: 'Version (e.g., 1.2.0):' }));
      if (!version.trim()) {
        error('Version is required.');
        return;
      }

      // Check for duplicate version
      const existing = getExistingReleases(root);
      if (existing.some(r => r.version === version.trim())) {
        error(`Release ${version} already exists.`);
        return;
      }

      // 2. Summary
      const summary = opts.summary ?? (auto ? '' : await input({ message: 'Summary:' }));

      // For planning releases, skip auto-discovery
      if (releaseStatus === 'planning') {
        const releaseEntry: ReleaseEntry = {
          id: generateId('rel'),
          version: version.trim(),
          date: '',
          summary: summary.trim(),
          breaking: false,
          status: 'planning',
          features: [],
          tasks: [],
          changelog: [],
        };
        insertToJsonArray(releasesPath, releaseEntry);
        // Only auto-activate if no active planning version is currently set, to avoid
        // silently clobbering an intentional choice. User can switch with `releases active <ver>`.
        const currentActive = getActivePlanningVersion();
        if (!currentActive) {
          try {
            setActivePlanningVersion(version.trim());
            success(`Planning version ${version.trim()} created and set as active.`);
          } catch (err: any) {
            error(`Created planning version but could not set as active: ${err.message}`);
          }
        } else {
          success(`Planning version ${version.trim()} created. Active planning version remains ${currentActive} — switch with: dreamcontext core releases active ${version.trim()}`);
        }
        return;
      }

      // 3. Breaking?
      const breaking = auto
        ? false
        : await select({
            message: 'Breaking change?',
            choices: [
              { value: false, name: 'No' },
              { value: true, name: 'Yes' },
            ],
          });

      // 4. Auto-discover tasks
      const unreleasedTasks = findUnreleasedTasks(root);
      let selectedTaskIds: string[] = [];
      if (unreleasedTasks.length > 0) {
        if (auto) {
          selectedTaskIds = unreleasedTasks.map(t => t.id);
        } else {
          selectedTaskIds = await checkbox({
            message: `Include completed tasks? (${unreleasedTasks.length} unreleased)`,
            choices: unreleasedTasks.map(t => ({
              value: t.id,
              name: `${t.slug} - ${t.name}`,
              checked: true,
            })),
          });
        }
      }

      // 5. Auto-discover features
      const unreleasedFeatures = findUnreleasedFeatures(root);
      let selectedFeatureIds: string[] = [];
      if (unreleasedFeatures.length > 0) {
        if (auto) {
          selectedFeatureIds = unreleasedFeatures.map(f => f.id);
        } else {
          selectedFeatureIds = await checkbox({
            message: `Include unreleased features? (${unreleasedFeatures.length} available)`,
            choices: unreleasedFeatures.map(f => ({
              value: f.id,
              name: `${f.slug} (${f.status})`,
              checked: true,
            })),
          });
        }
      }

      // 6. Auto-discover changelog entries
      const unreleasedChangelog = findUnreleasedChangelog(root);
      let selectedChangelog: typeof unreleasedChangelog = [];
      if (unreleasedChangelog.length > 0) {
        if (auto) {
          selectedChangelog = unreleasedChangelog;
        } else {
          const selectedIndices: number[] = await checkbox({
            message: `Include changelog entries? (${unreleasedChangelog.length} since last release)`,
            choices: unreleasedChangelog.map(c => ({
              value: c.index,
              name: `${c.entry.date} [${c.entry.type}] ${c.entry.scope}: ${c.entry.description.slice(0, 80)}`,
              checked: true,
            })),
          });
          selectedChangelog = unreleasedChangelog.filter(c => selectedIndices.includes(c.index));
        }
      }

      // 7. Build release entry
      const releaseEntry: ReleaseEntry = {
        id: generateId('rel'),
        version: version.trim(),
        date: today(),
        summary: summary.trim(),
        breaking,
        status: 'released',
        features: selectedFeatureIds,
        tasks: selectedTaskIds,
        changelog: selectedChangelog.map(c => c.entry),
      };

      // 8. Write to RELEASES.json
      insertToJsonArray(releasesPath, releaseEntry);

      // 9. Back-populate features
      if (selectedFeatureIds.length > 0) {
        backPopulateFeatures(root, selectedFeatureIds, version.trim());
        info(`Set released_version="${version.trim()}" on ${selectedFeatureIds.length} feature(s).`);
      }

      success(`Release ${version.trim()} recorded (${selectedTaskIds.length} tasks, ${selectedFeatureIds.length} features, ${selectedChangelog.length} changelog entries).`);
    });

  releases
    .command('list')
    .description('List recent releases')
    .option('-n, --count <n>', 'Number of releases to show', '10')
    .action((opts) => {
      const root = ensureContextRoot();
      const allReleases = getExistingReleases(root);
      const count = parseInt(opts.count, 10) || 10;
      const recent = allReleases.slice(0, count);

      if (recent.length === 0) {
        info('No releases recorded yet.');
        return;
      }

      console.log(header('Releases'));
      console.log(formatTable(
        ['Version', 'Date', 'Summary', 'Tasks', 'Features', 'Breaking'],
        recent.map(r => [
          r.version,
          r.date,
          r.summary.length > 40 ? r.summary.slice(0, 37) + '...' : r.summary,
          String(r.tasks?.length ?? 0),
          String(r.features?.length ?? 0),
          r.breaking ? 'YES' : 'no',
        ]),
      ));
    });

  releases
    .command('active')
    .argument('[version]', 'Version to set as active planning version (omit to print current)')
    .option('--clear', 'Unset the active planning version')
    .description('Get or set the active planning version (used as default for new tasks)')
    .action((version: string | undefined, opts: { clear?: boolean }) => {
      if (opts.clear) {
        clearActivePlanningVersion();
        success('Active planning version cleared.');
        return;
      }
      if (!version) {
        const current = getActivePlanningVersion();
        if (current) {
          console.log(current);
        } else {
          info('No active planning version set.');
        }
        return;
      }
      try {
        setActivePlanningVersion(version);
        success(`Active planning version set to ${version}.`);
      } catch (err: any) {
        error(err.message);
      }
    });

  releases
    .command('show')
    .argument('<version>', 'Release version to show')
    .description('Show details of a specific release')
    .action((version: string) => {
      const root = ensureContextRoot();
      const allReleases = getExistingReleases(root);
      const release = allReleases.find(r => r.version === version);

      if (!release) {
        error(`Release not found: ${version}`);
        return;
      }

      console.log(header(`Release ${release.version}`));
      console.log(`  Date:     ${release.date}`);
      console.log(`  Summary:  ${release.summary}`);
      console.log(`  Breaking: ${release.breaking ? 'Yes' : 'No'}`);
      console.log(`  ID:       ${release.id}`);

      if (release.tasks.length > 0) {
        console.log(`\n  Tasks (${release.tasks.length}):`);
        for (const id of release.tasks) console.log(`    - ${id}`);
      }

      if (release.features.length > 0) {
        console.log(`\n  Features (${release.features.length}):`);
        for (const id of release.features) console.log(`    - ${id}`);
      }

      if (release.changelog.length > 0) {
        console.log(`\n  Changelog (${release.changelog.length}):`);
        for (const e of release.changelog) {
          console.log(`    - ${e.date} [${e.type}] ${e.scope}: ${e.description.slice(0, 80)}`);
        }
      }
    });
}
