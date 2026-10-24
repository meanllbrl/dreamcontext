import { createHash } from 'node:crypto';
import { sanitizeModel } from '../claude-args.js';
import { MAX_BRIEF, MAX_TITLE, SUPER_SLUG_RE, TASK_SLUG_RE } from './types.js';
import { parseMcpNames } from './lean-mcp.js';

/**
 * One job as `super delegate`, `super pool add` and `delegate --from` take it (plan r4 D9): ONE
 * parser for all three, and the store's pool sanitizer reads every pooled row back through it,
 * so a row on disk can never hold a field a verb would refuse.
 */

export const JOB_MODES = ['basic', 'plan', 'develop'] as const;
export const JOB_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** The longest prompt `delegate` takes (a pooled one is capped lower, MAX_POOL_PROMPT bytes). */
export const MAX_JOB_PROMPT = 100_000;
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BASE_RE = /^[A-Za-z0-9._/-]{1,200}$/;

export interface Job {
  prompt: string;
  title: string;
  brief: string;
  mode: string;
  model?: string;
  effort?: string;
  /** The linked repo to make a worktree of. */
  worktree?: string;
  slug?: string;
  base?: string;
  task?: string;
  /** The user's MCP servers this child may use (`--mcp a,b`, orchestration plan r5 D14); a
   *  delegated child gets ONLY these. Syntax here; existence is the route's (it needs the vault). */
  mcp?: string[];
}

// eslint-disable-next-line no-control-regex
export const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function firstLine(text: string, max: number): string {
  const line = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function promptHash(prompt: string): string {
  return createHash('sha1').update(prompt).digest('hex');
}

/** The job in `b`, or why it is refused. The task FILE is checked by the route (it needs the
 *  vault); here only its slug. */
export function parseJob(b: Record<string, unknown>): { job: Job } | { error: string } {
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  if (!prompt.trim()) return { error: '--prompt is required' };
  if (prompt.length > MAX_JOB_PROMPT) return { error: 'the prompt is too long' };
  const mode = str(b.mode) ?? 'basic';
  if (!(JOB_MODES as readonly string[]).includes(mode)) return { error: `mode must be one of ${JOB_MODES.join(' | ')}` };
  const model = str(b.model);
  if (model && !sanitizeModel(model)) return { error: 'model is not a model id' };
  const effort = str(b.effort);
  if (effort && !(JOB_EFFORTS as readonly string[]).includes(effort)) return { error: `effort must be one of ${JOB_EFFORTS.join(' | ')}` };
  const worktree = str(b.worktree);
  if (worktree && !REPO_NAME_RE.test(worktree)) return { error: 'worktree names a linked repo' };
  const slug = str(b.slug);
  if (slug && !SUPER_SLUG_RE.test(slug)) return { error: 'slug must be a-z, 0-9 and -, starting with a letter or digit, at most 60 characters' };
  const base = str(b.base);
  if (base && (!BASE_RE.test(base) || base.startsWith('-') || base.includes('..'))) return { error: 'base must be a branch, tag or commit' };
  const task = str(b.task);
  if (task && !TASK_SLUG_RE.test(task)) return { error: 'task is a task slug (a-z, 0-9, -)' };
  const mcp = parseMcpNames(b.mcp);
  if ('error' in mcp) return { error: mcp.error };
  const brief = oneLine(str(b.brief) ?? '').slice(0, MAX_BRIEF);
  const title = (brief || firstLine(prompt, 60)).slice(0, MAX_TITLE);
  return {
    job: {
      prompt, title, brief, mode,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      ...(worktree ? { worktree } : {}), ...(slug ? { slug } : {}), ...(base ? { base } : {}),
      ...(task ? { task } : {}),
      ...(mcp.names.length ? { mcp: mcp.names } : {}),
    },
  };
}
