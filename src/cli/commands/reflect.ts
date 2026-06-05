import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureContextRoot } from '../../lib/context-path.js';
import { buildCorpus, tokenize } from '../../lib/recall.js';
import {
  detectPatterns,
  formatReflection,
  writeReflection,
} from '../../lib/reflection.js';
import { info } from '../../lib/format.js';

interface SleepBookmark {
  id: string;
  session_id?: string;
  [key: string]: unknown;
}

interface SleepState {
  bookmarks?: SleepBookmark[];
  [key: string]: unknown;
}

/**
 * Read .sleep.json and build a Map<bookmarkId, sessionId>.
 * Multiple bookmarks can share one session_id — the map collapses them naturally
 * since the DF counter uses Set<sessionKey>.
 */
function buildBookmarkSessions(root: string): Map<string, string> {
  const sleepPath = join(root, 'state', '.sleep.json');
  const result = new Map<string, string>();
  if (!existsSync(sleepPath)) return result;
  try {
    const parsed = JSON.parse(readFileSync(sleepPath, 'utf-8')) as SleepState;
    const bookmarks = parsed.bookmarks ?? [];
    for (const b of bookmarks) {
      if (b.id && b.session_id) {
        result.set(b.id, b.session_id);
      }
    }
  } catch {
    // malformed sleep.json — return empty map; detectPatterns degrades gracefully
  }
  return result;
}

/**
 * Tokenize soul + user files into a Set for the excludedExtra parameter.
 * These files are NOT in buildCorpus, so their terms must be passed in explicitly
 * to ensure they don't surface as spurious candidates.
 */
function buildExcludedExtra(root: string): Set<string> {
  const excluded = new Set<string>();
  const coreFiles = [
    join(root, 'core', '0.soul.md'),
    join(root, 'core', '1.user.md'),
  ];
  for (const filePath of coreFiles) {
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const tok of tokenize(content)) {
        excluded.add(tok);
      }
    } catch {
      // skip unreadable files
    }
  }
  return excluded;
}

export function registerReflectCommand(program: Command): void {
  program
    .command('reflect')
    .description('Detect recurring cross-session patterns as reflection candidates')
    .option('--min-sessions <n>', 'Minimum distinct sessions a term must appear in', '3')
    .option('--max <n>', 'Maximum number of candidates to surface', '12')
    .option('--write', 'Write output to state/.reflection.md instead of stdout')
    .action((opts: { minSessions: string; max: string; write: boolean }) => {
      const root = ensureContextRoot();

      const minSessions = Math.max(1, parseInt(opts.minSessions, 10) || 3);
      const maxCandidates = Math.max(1, parseInt(opts.max, 10) || 12);

      // Build corpus (all types — needed for exclusion set)
      const corpus = buildCorpus(root);

      // Build excludedExtra from soul + user files (not in buildCorpus)
      const excludedExtra = buildExcludedExtra(root);

      // Build bookmark -> session_id map from .sleep.json directly
      const bookmarkSessions = buildBookmarkSessions(root);

      const result = detectPatterns(corpus, {
        minSessions,
        maxCandidates,
        excludedExtra,
        bookmarkSessions,
      });

      const md = formatReflection(result);

      if (opts.write) {
        const outPath = writeReflection(root, md);
        info(`Reflection candidates written to: ${outPath}`);
        if (result.candidates.length === 0) {
          info('No recurring patterns found above the threshold.');
        } else {
          info(`${result.candidates.length} candidate(s) found.`);
        }
      } else {
        if (result.candidates.length === 0) {
          info('No recurring patterns found above the threshold.');
        }
        process.stdout.write(md);
      }
    });
}
