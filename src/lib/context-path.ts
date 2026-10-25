import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const CONTEXT_DIR = '_dream_context';
const MAX_WALK_UP = 5;

/** The brain a task step's run writes to, set by its host (AI Team v2 C1-7). */
export const TASK_CONTEXT_ROOT_ENV = 'DREAMCONTEXT_CONTEXT_ROOT';
/** The task step's worktree, set by its host next to the brain root. */
export const TASK_WORKTREE_ENV = 'DREAMCONTEXT_TASK_WORKTREE';

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function insideOrEqual(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The project roots this machine's scheduler ticks (`~/.dreamcontext/automations.json`), real paths. */
function registeredProjectRoots(): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(process.env.HOME || homedir(), '.dreamcontext', 'automations.json'), 'utf-8')) as { projects?: unknown };
    // `{ projects: { <projectRoot>: { approvals } } }` (automations/registry.ts); read here
    // directly, since this module sits below the registry and must not import it.
    const projects = raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects) ? Object.keys(raw.projects) : [];
    return projects.map((p) => realOrNull(p)).filter((p): p is string => !!p);
  } catch {
    return [];
  }
}

/**
 * The live brain of a code task step run from its worktree, or null. The host sets the brain
 * root and the worktree in the env; the env root is used ONLY when every one holds:
 *   - the real cwd (or `from`) is inside the task worktree;
 *   - the ordinary walk finds no `_dream_context/`, or finds exactly `<worktree>/_dream_context`
 *     (a brain that lives in the code repo is checked out in the worktree too, and that copy
 *     must never be written);
 *   - the env root's parent is a project this machine's scheduler ticks.
 * Otherwise the walk resolves as it always did, so a fixture vault stays the fixture.
 */
function taskStepContextRoot(start: string, walked: string | null): string | null {
  const envRoot = process.env[TASK_CONTEXT_ROOT_ENV];
  const worktree = process.env[TASK_WORKTREE_ENV];
  if (!envRoot || !worktree) return null;
  const realStart = realOrNull(start);
  const realWorktree = realOrNull(worktree);
  if (!realStart || !realWorktree || !insideOrEqual(realStart, realWorktree)) return null;
  if (walked !== null && realOrNull(walked) !== realOrNull(join(realWorktree, CONTEXT_DIR))) return null;
  const realProject = realOrNull(dirname(envRoot));
  if (!realProject || !registeredProjectRoots().includes(realProject)) return null;
  return existsSync(envRoot) ? envRoot : null;
}

/**
 * Walk up from cwd to find _dream_context/ directory.
 * Returns the absolute path to _dream_context/ or null if not found.
 */
export function resolveContextRoot(from?: string): string | null {
  const start = from ?? process.cwd();
  const walked = walkUp(start);
  return taskStepContextRoot(start, walked) ?? walked;
}

function walkUp(from: string): string | null {
  let dir = from;
  for (let i = 0; i <= MAX_WALK_UP; i++) {
    const candidate = join(dir, CONTEXT_DIR);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Resolve _dream_context/ or throw with a helpful message.
 */
export function ensureContextRoot(from?: string): string {
  const root = resolveContextRoot(from);
  if (!root) {
    throw new Error(
      '_dream_context/ not found. Run `dreamcontext init` to create it.',
    );
  }
  return root;
}

/**
 * Join path segments within the _dream_context/ directory.
 */
export function contextPath(...segments: string[]): string {
  const root = ensureContextRoot();
  return join(root, ...segments);
}

/**
 * Check if _dream_context/ exists in the given directory (default: cwd).
 */
export function contextExists(from?: string): boolean {
  return resolveContextRoot(from) !== null;
}

/**
 * Get the expected _dream_context/ path in cwd (for init).
 */
export function getInitPath(): string {
  return join(process.cwd(), CONTEXT_DIR);
}
