import { quoteTooThin } from './filing-basis.js';
import { spawnMarkerFromEnv } from './session-origin.js';

/**
 * agent-filing-guard — what an AWAKE agent may file with `tasks create` (audit TK-1, TK-2).
 *
 * The sleep filing bar (task-filing-bar.ts) gates only the cycle. Before this guard every awake
 * agent passed like the owner, and 88% of the board came through that door: the Super opened a
 * task per delegated job, its children opened one when their brief named none, and plans opened
 * wave sub-tasks. The owner's rule (2026-11-09) is "a task only for big work, ONE task, a
 * sub-task only when I ask". Prose alone did not hold it, so two mechanical refusals do:
 *
 *   1. A Super Agent's child never files. Only the Super or the owner opens the one task.
 *   2. An agent never opens a sub-task (`--parent`), a plan's wave included.
 *
 * Each refusal names its reason and the way out (owner rule: a guard asks or explains, it never
 * silently locks). The way out for both is the owner's own words: `--owner-asked "<words>"`
 * records an ask basis and lifts the guard. A batch the owner confirmed (the initializer's
 * manifest, a curator plan, waves he asked for) is his ask too: each filing quotes his
 * confirmation. An agent can lie there, but the lie is on the record
 * (the task page shows the quote) and the owner can object to it.
 * There is no daily count (owner, 2026-11-12: the budget was removed).
 *
 * WHO IS AN AGENT is read from the environment, never from `--by`: an agent told to "pass
 * `--by human`" mid-cycle would otherwise walk straight past. The owner at his own terminal has
 * none of these variables; the dashboard's form goes through POST /api/tasks, which this guard
 * does not touch.
 */

export type AgentSessionKind = 'claude' | 'codex' | 'brain-mcp' | 'spawned';

/**
 * Is this CLI call running inside an agent's session? Claude Code sets `CLAUDECODE` and
 * `CLAUDE_CODE_SESSION_ID` in every Bash tool's env; a Codex chat's shell has `CODEX_THREAD_ID`;
 * the brain MCP (Antigravity, Codex) marks its CLI children `DREAMCONTEXT_VIA_BRAIN_MCP`; a
 * spawned builder, automation or background sleep carries a spawn marker (session-origin.ts).
 */
export function agentSessionOf(env: NodeJS.ProcessEnv): AgentSessionKind | null {
  if (env.DREAMCONTEXT_VIA_BRAIN_MCP === '1') return 'brain-mcp';
  if (env.CLAUDECODE !== undefined || (env.CLAUDE_CODE_SESSION_ID ?? '').trim()) return 'claude';
  if ((env.CODEX_THREAD_ID ?? '').trim()) return 'codex';
  if (spawnMarkerFromEnv(env)) return 'spawned';
  return null;
}

export interface AgentGuardInput {
  /** Who decideFiling says is filing. Only `agent` and `plan` are guarded. */
  filedBy: string;
  /** The parent slug when this would be a sub-task. */
  parent: string | null;
  /** `--owner-asked`, already trimmed; null when absent. */
  ownerAsked: string | null;
  /** This session is a live child of a Super Agent (super/handoff-task.ts `superChildContext`). */
  superChild: boolean;
}

export type AgentGuardCode = 'owner_asked_too_thin' | 'super_child' | 'parent_needs_owner';

export type AgentGuardVerdict =
  | { ok: true; ownerAsked: boolean }
  | { ok: false; code: AgentGuardCode; message: string };

const OWNER_WAY = 'If the owner asked for this task in his own words, re-run with --owner-asked "<his words, verbatim>".';

/** Pure: may this awake agent file this task? Call only when {@link agentSessionOf} is non-null. */
export function checkAgentFiling(input: AgentGuardInput): AgentGuardVerdict {
  if (input.filedBy !== 'agent' && input.filedBy !== 'plan') return { ok: true, ownerAsked: false };

  if (input.ownerAsked !== null) {
    const thin = quoteTooThin(input.ownerAsked);
    if (thin) {
      return {
        ok: false,
        code: 'owner_asked_too_thin',
        message: `--owner-asked: ${thin}. Quote what the owner wrote, verbatim; your own summary is not his ask.`,
      };
    }
    return { ok: true, ownerAsked: true };
  }

  if (input.superChild) {
    return {
      ok: false,
      code: 'super_child',
      message: 'Not filed: you are a Super Agent\'s child, and only the Super or the owner opens a task. '
        + 'Small work needs none: build from your brief and report in your last reply (the release note carries it). '
        + 'If the work turned out big (it needs a plan or several lanes), stop and tell the Super with an AskUserQuestion card: '
        + 'it opens the ONE task and hands it to you. ' + OWNER_WAY,
    };
  }

  if (input.parent) {
    return {
      ok: false,
      code: 'parent_needs_owner',
      message: `Not filed: an agent opens a sub-task only when the owner asks for one (owner rule, 2026-11-09). `
        + `Add it to ${input.parent} as a criterion instead: dreamcontext tasks insert ${input.parent} acceptance_criteria "…"; `
        + 'a plan\'s waves are logged on that one task. ' + OWNER_WAY,
    };
  }

  return { ok: true, ownerAsked: false };
}
