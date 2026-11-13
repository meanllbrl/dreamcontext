/**
 * A quick edit knows the project (owner, 2026-11-13: "quick edit'e de memory olsun ve arama
 * yapabilsin ki context'de arayabilsin").
 *
 * Two halves, both read-only:
 *  1. MEMORY, on every tool: the same recall block an ordinary agent's prompt hook injects for
 *     these words (`selectPromptRecall` + its gate + `renderRecallBlock`), computed here in the
 *     server, where a hybrid vault's model is already warm. The Haiku mode is a `claude` call of
 *     its own, too slow for a fast edit: such a vault gets the BM25 block instead. Bounded by
 *     TIME: a recall that has not answered by {@link QUICK_RECALL_DEADLINE_MS} is dropped and the
 *     edit goes on without it. Only THIS vault (the hook's block never spans peers either) and only quick-readable pages.
 *  2. SEARCH, on Claude: the run may call `dreamcontext memory recall` and read the brain's pages.
 *     The envelope ({@link quickBrainToolArgs}) opens exactly that: `dontAsk` denies every tool
 *     that is not listed; reads are the ALLOWLIST of quick-readable.ts (the brain's shared pages,
 *     never its machine-local or private files: a board syncs to teammates); Bash runs only the
 *     recall command, and the run's env scopes that recall to this vault and the same pages
 *     ({@link QUICK_RECALL_SCOPE_ENV}), whatever flag it passes. The memory block is filtered
 *     by the same list. The `dreamcontext` it runs is the running CLI ({@link quickCliShimDir}).
 *     Codex and Antigravity do not search: neither can deny a read by path (the S3 spike; the
 *     Antigravity gate guards writes only), so a run in the brain could read those secrets, and a
 *     Codex run started inside a project runs its hooks. They keep their empty temp folder.
 */
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDENTIAL_ANYWHERE, absRule, credentialReadDenies, forbiddenPathReason } from '../automations/board-scope.js';
import { LIGHT_DISALLOWED_TOOLS } from '../automations/light-run.js';
import { renderCliShim } from '../automations/cli-path.js';
import { QUICK_DOT_DENY_GLOBS, QUICK_READABLE_GLOBS, quickReadable } from './quick-readable.js';

export { QUICK_RECALL_SCOPE, QUICK_RECALL_SCOPE_ENV } from './quick-readable.js';

/** This product's own secret files, anywhere: the same list as `APP_CREDENTIAL_FILES` (apps/assistant.ts,
 *  too heavy to import here; the unit test keeps the two equal). */
export const QUICK_SECRET_FILES = ['**/.secrets.json', '**/lab/credentials.json', '**/.mcp.json'] as const;


/** How long a quick edit waits for its memory block before it goes on without one. */
export const QUICK_RECALL_DEADLINE_MS = 1500;

/** The one command a Claude quick edit may run. */
export const QUICK_RECALL_COMMAND = 'dreamcontext memory recall';

/**
 * The recall block for `request` in the vault at `root` (its `_dream_context`), or '' when recall
 * is off, nothing passes the hook's gate, it errs, or it is late. Never throws.
 */
export async function quickRecallBlock(root: string, request: string, deadlineMs: number = QUICK_RECALL_DEADLINE_MS): Promise<string> {
  const words = request.trim();
  if (!words) return '';
  const work = (async (): Promise<string> => {
    // Loaded on first use: the recall stack is large, and quick-edit.ts imports this file for its argv.
    const [{ resolveRecallMode }, { recallGatePasses, renderRecallBlock, selectPromptRecall }] = await Promise.all([
      import('../../cli/commands/sleep.js'),
      import('../../cli/commands/hook.js'),
    ]);
    const mode = resolveRecallMode(root);
    if (mode === 'off') return '';
    // `env: {}`: the server's own env must not downgrade the tier as a spawned session's would;
    // `viaDashboard: null`: this IS the server.
    const r = await selectPromptRecall(words, root, mode === 'haiku' ? 'raw' : mode, { env: {}, viaDashboard: null });
    // Only the brain's shared pages (quick-readable.ts), then the hook's own gate.
    const hits = r.hits.filter((h) => quickReadable(h.doc.relPath));
    if (!recallGatePasses(hits, r.haiku, words)) return '';
    return renderRecallBlock(hits, r.label).join('\n').trim();
  })().catch(() => '');
  let timer: NodeJS.Timeout | null = null;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(''), deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The brain folder as a permission rule may hold it: its real path (a symlinked vault is held to
 * where it really lives), or null when it cannot be resolved or a rule cannot carry it safely.
 * Null = the run keeps the old no-tool envelope.
 */
export function quickBrainRoot(root: string): string | null {
  let real: string;
  try { real = realpathSync(root); } catch { return null; }
  return forbiddenPathReason('brain', real) ? null : real;
}

/**
 * Claude's read-only search envelope for a quick edit: Read, Grep and Glob on the brain's Markdown
 * pages and recall's two JSON files, minus its private folders and every credential file; Bash
 * only for {@link QUICK_RECALL_COMMAND}. Claude Code checks each part of a chained command against
 * the rules, so `recall x; touch y`, a redirect and `$(...)` are refused (measured on 2.1.323).
 */
export function quickBrainToolArgs(brainReal: string, home?: string): string[] {
  const pages = (tool: string) => QUICK_READABLE_GLOBS.map((g) => absRule(tool, brainReal, g));
  return [
    '--tools', 'Read,Grep,Glob,Bash',
    '--permission-mode', 'dontAsk',
    '--allowedTools', ...pages('Read'), ...pages('Grep'), ...pages('Glob'),
    `Bash(${QUICK_RECALL_COMMAND}:*)`,
    '--disallowedTools', ...LIGHT_DISALLOWED_TOOLS.filter((t) => t !== 'Bash'),
    ...QUICK_DOT_DENY_GLOBS.flatMap((g) => ['Read', 'Grep', 'Glob'].map((t) => absRule(t, brainReal, g))),
    ...credentialReadDenies(home),
    ...[...CREDENTIAL_ANYWHERE, ...QUICK_SECRET_FILES].map((g) => `Read(//${g})`),
  ];
}

/**
 * A folder holding `dreamcontext` = THIS running CLI, for the run's PATH: a quick edit must search
 * with the CLI that knows {@link QUICK_RECALL_SCOPE_ENV}, not whichever older one a PATH
 * finds first, nor none (a Finder-started app's PATH). Written into the run's own temp folder;
 * null on Windows (no sh shim) or when the entry is unknown, and the run then uses its PATH.
 */
export function quickCliShimDir(tempDir: string, execPath: string = process.execPath, entry: string | undefined = process.env.DREAMCONTEXT_CLI || process.argv[1]): string | null {
  if (process.platform === 'win32' || !entry) return null;
  try {
    const dir = join(tempDir, 'bin');
    mkdirSync(dir, { recursive: true });
    const shim = join(dir, 'dreamcontext');
    writeFileSync(shim, renderCliShim(execPath, entry));
    chmodSync(shim, 0o755);
    return dir;
  } catch {
    return null;
  }
}
