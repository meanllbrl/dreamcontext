import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { AGENT_BOARD_ENV, AGENT_SCRATCH_ENV, AGENT_SELF_ENV, AutomationError } from './types.js';

/** The real path of `dir`, or null when it is unset or does not resolve. */
function realDir(dir: string | undefined): string | null {
  if (!dir) return null;
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The path a CLI verb may read for a file flag (`--playbook-file`, `--body-file`). Unscoped
 * (no `AGENT_BOARD_ENV`) it is the path as given. While a board agent runs, the file may come
 * ONLY from its two writable folders, the scratch folder and `<brain>/automations/output/<self>/`:
 * the content lands in the synced brain, and the agent's Read deny rules bind Claude's tools,
 * not this child process, so `~/.ssh/id_rsa` or the project's `.env` would otherwise be copied
 * in. A symlink is refused outright and both sides are compared by real path. The same rule
 * `whiteboard --file` applies.
 */
export function scopedReadablePath(
  contextRoot: string,
  file: string,
  flag: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env[AGENT_BOARD_ENV] === undefined) return file;
  const self = env[AGENT_SELF_ENV]?.trim();
  const allowed = [
    realDir(env[AGENT_SCRATCH_ENV]?.trim()),
    self ? realDir(join(contextRoot, 'automations', 'output', self)) : null,
  ].filter((d): d is string => d !== null);
  const refuse = (why: string): never => {
    throw new AutomationError(
      `${flag} '${file}' ${why}. A board agent may only read files from its scratch folder ($${AGENT_SCRATCH_ENV}) `
      + `or _dream_context/automations/output/${self || '<self>'}/.`,
    );
  };
  let real: string;
  try {
    if (lstatSync(file).isSymbolicLink()) refuse('is a symlink');
    real = realpathSync(file);
  } catch (err) {
    if (err instanceof AutomationError) throw err;
    throw new AutomationError(`${flag} not found: ${file}`);
  }
  if (!allowed.some((dir) => isInside(dir, real))) refuse('is outside the folders this agent may read from');
  return real;
}
