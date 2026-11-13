/**
 * What of the brain a whiteboard quick edit may see: its SHARED pages, nothing machine-local or
 * private. ONE list, read by every way in (review r2, class quick-edit-secret-on-synced-board):
 *  - Claude's Read / Grep / Glob allow rules (quick-memory.ts `quickBrainToolArgs`);
 *  - the memory block the server puts in the message (quick-memory.ts `quickRecallBlock`);
 *  - the `memory recall` the run itself calls (memory.ts, under {@link QUICK_RECALL_SCOPE_ENV}).
 *
 * Why: an answer lands on a board that syncs to teammates, and board text (a teammate's) is part of
 * the input. A brain also keeps machine-local things recall indexes or a read could reach: session
 * digests (the owner's chat words verbatim), automation manifests, outputs and threads, conflict copies,
 * tmp drafts, private agent files, `state/.secrets.json`, `lab/credentials.json`. An ALLOWLIST,
 * like assistant/brains.ts, so a new local folder stays out by default.
 *
 * No imports: memory.ts loads this on every recall.
 */

/** Set on a quick edit's run: its `memory recall` searches this vault only, and only these pages. */
export const QUICK_RECALL_SCOPE_ENV = 'DREAMCONTEXT_RECALL_SCOPE';
export const QUICK_RECALL_SCOPE = 'quick-edit';

/** The two JSON files recall indexes and a quick edit may read. */
const READABLE_JSON = ['core/CHANGELOG.json', 'core/RELEASES.json'] as const;

/** Folders whose Markdown, at any depth, is shared brain content. */
const DEEP_DIRS = ['knowledge', 'core', 'theses', 'lab/insights'] as const;

/** Folders whose TOP-LEVEL Markdown only is shared: the task files. Below `state/` live
 *  machine-local folders (`state/.session-digests/`, `state/.conflicts/`, `state/.super/`).
 *  Never `automations/` or `agents/`: a manifest's body is the prompt a run executes, and both
 *  are private to the machine (agent-sync.ts `AGENT_PRIVATE_ENTRIES`, federation-digest.ts). */
const FLAT_DIRS = ['state'] as const;

/** The allow rules' globs, relative to the brain folder, each starting with `/`. Claude's rules
 *  match dot names with `*` too: {@link QUICK_DOT_DENY_GLOBS} take them back out. */
export const QUICK_READABLE_GLOBS: readonly string[] = [
  ...DEEP_DIRS.map((d) => `/${d}/**/*.md`),
  ...FLAT_DIRS.map((d) => `/${d}/*.md`),
  ...READABLE_JSON.map((f) => `/${f}`),
];

/** Deny globs for dot files and dot folders anywhere in the brain, as `quickReadable` refuses them. */
export const QUICK_DOT_DENY_GLOBS: readonly string[] = ['/**/.*', '/**/.*/**'];

/** Is `relPath` (relative to the brain, `/`-separated) a page a quick edit may see? */
export function quickReadable(relPath: string): boolean {
  const rel = relPath.replace(/\\/g, '/');
  if ((READABLE_JSON as readonly string[]).includes(rel)) return true;
  const parts = rel.split('/');
  if (!rel.endsWith('.md') || parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return false;
  if (DEEP_DIRS.some((d) => rel.startsWith(`${d}/`))) return true;
  return FLAT_DIRS.some((d) => parts.length === 2 && parts[0] === d);
}
