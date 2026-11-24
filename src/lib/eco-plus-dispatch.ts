/**
 * Eco Plus for sub-agents (plan eco-plus D6, K4): the PreToolUse Agent/Task hook asks this module
 * whether a dispatch should run on `sonnet`. Proven live on Claude Code 2.1.330 (task log, K4
 * gate): an `updatedInput.model` from the hook wins over the agent definition's `model:`.
 *
 * Lowered when Eco Plus is on and the dispatch would run on Opus/Fable: its `model` param says so,
 * or there is none and the agent definition's frontmatter says so. The definition is looked up as
 * Claude Code does: `$CLAUDE_PROJECT_DIR/.claude/agents/<type>.md`, then `~/.claude/agents/<type>.md`
 * (never the cwd, a worktree without `.claude/`). Untouched: the judges (`ECO_PLUS_KEPT_AGENTS`),
 * an unknown type or one with no `model:` line (it inherits the parent, already lowered), a
 * symlinked or escaping definition, and an AI Team member's slug (its `--agents` definition
 * shadows the file). Any error is `null`: the dispatch goes exactly as today (fail open).
 */
import { lstatSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { ECO_PLUS_KEPT_AGENTS, ECO_PLUS_MODEL, isHeavyModel } from './eco-plus.js';

const TYPE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface DispatchModelDeps {
  /** `$CLAUDE_PROJECT_DIR`, or null when unset. */
  projectDir: string | null;
  home?: string;
  /** The AI Team member slugs of this project (a collision with a member stays untouched). */
  memberSlugs?: () => readonly string[];
}

export interface DispatchModelRewrite {
  model: string;
  /** What the dispatch would have run on: the param, or the definition's `model:`. */
  from: string;
}

/**
 * The definition's `model:` value. `undefined` = no such file here (look further); `null` = a file is
 * here but gives no usable model (no `model:` line, unreadable, symlinked, escaping): stop, untouched.
 */
export function definitionModel(dir: string, type: string): string | null | undefined {
  const file = join(dir, `${type}.md`);
  try {
    lstatSync(file);
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? undefined : null;
  }
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const realDir = realpathSync(dir);
    const realFile = realpathSync(file);
    if (!realFile.startsWith(realDir + sep)) return null;
    const fd = openSync(realFile, 'r');
    let text = '';
    try {
      const buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0);
      text = buf.subarray(0, n).toString('utf-8');
    } finally { closeSync(fd); }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) return null;
    const m = /^model:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(fm[1]!);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** The model rewrite for one dispatch, or null to leave it as it is. Never throws. */
export function ecoPlusDispatchModel(toolInput: Record<string, unknown>, on: boolean, deps: DispatchModelDeps): DispatchModelRewrite | null {
  try {
    if (!on) return null;
    const type = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type.trim() : '';
    if (type && ECO_PLUS_KEPT_AGENTS.includes(type)) return null;
    const param = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
    if (param) return isHeavyModel(param) && param !== ECO_PLUS_MODEL ? { model: ECO_PLUS_MODEL, from: param } : null;
    if (!type || !TYPE_RE.test(type)) return null;
    const dirs: string[] = [];
    if (deps.projectDir) dirs.push(join(deps.projectDir, '.claude', 'agents'));
    dirs.push(join(deps.home ?? homedir(), '.claude', 'agents'));
    let found: string | null | undefined;
    for (const d of dirs) {
      found = definitionModel(d, type);
      if (found !== undefined) break;
    }
    if (!found || !isHeavyModel(found)) return null;
    if (deps.memberSlugs?.().includes(type)) return null;
    return { model: ECO_PLUS_MODEL, from: found };
  } catch {
    return null;
  }
}
