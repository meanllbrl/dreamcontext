/**
 * The ONE pane-level executor for moving a chat to another account or tool (plan r5 §4d, §4e).
 *
 * A pane runs one engine at a time: a `claude` CLI child, or a bridge child (`dreamcontext
 * t3-chat`). Moving it means closing that engine and opening the target's, and the only real
 * question is whether the conversation can come along:
 *   - same continuation key (Claude → Claude: every account shares `projects/` and `--resume`
 *     works; Codex → Codex: every account's sessions ARE `~/.codex/sessions`, T3's
 *     `codex:home:~/.codex` key) → the target resumes the SAME thread;
 *   - otherwise (another tool) → the Eco path: a handoff record for the pane, a FRESH thread on
 *     the target, and the continue prompt that record produces.
 *
 * No I/O of its own besides the handoff record: closing and opening are the caller's (the chat
 * server ends its child and the client reopens the pane on the target, the same restart Claude's
 * account switch already performs). For a Claude-on-Claude switch the chat server keeps calling
 * `spawnSuccessor` exactly as before; this module only DECIDES that case, it never re-implements it.
 *
 * In this task no chat changes tool through policy (`FallbackPolicy` is `'never'`): a cross-tool
 * target reaches this function only from a test (§4e criterion 8).
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { activeTaskForNudge, handoffContinuePrompt, writeHandoffRecord, type HandoffRecord } from '../context-watch.js';
import type { SwitchTarget, SwitchTool } from '../account-switch.js';

export interface PaneEngine {
  readonly tool: SwitchTool;
  readonly accountId: string;
  /** The conversation the pane holds now: a Claude session id or a native Codex thread id. */
  readonly threadId: string;
}

export interface ReplacementPlan {
  readonly target: SwitchTarget;
  /** The thread the target opens with, or '' for a fresh one. */
  readonly resume: string;
  /** True when the conversation cannot follow and goes through the Eco handoff path. */
  readonly handoff: boolean;
}

/**
 * Which conversations an engine can resume. Two engines with the same key read the same store.
 *  - Claude: every account's sandbox links the real `~/.claude/projects` (claude-account-sandbox.ts).
 *  - Codex: T3's `CodexHomeLayout` key for authOverlay homes, `codex:home:<~/.codex>`.
 */
export function continuationKey(tool: SwitchTool, _accountId: string, home: string = homedir()): string {
  return tool === 'codex' ? `codex:home:${join(home, '.codex')}` : `claude:projects:${join(home, '.claude', 'projects')}`;
}

/** How a key is read; tests pass one where two accounts do NOT share a store. */
export type KeyOf = (tool: SwitchTool, accountId: string) => string;

export function planReplacement(current: PaneEngine, target: SwitchTarget, home: string = homedir(), keyOf?: KeyOf): ReplacementPlan {
  const key: KeyOf = keyOf ?? ((tool, id) => continuationKey(tool, id, home));
  const same = key(current.tool, current.accountId) === key(target.tool, target.accountId);
  return same && current.threadId
    ? { target, resume: current.threadId, handoff: false }
    : { target, resume: '', handoff: true };
}

export interface ReplaceDeps {
  /** End whatever engine the pane runs (CLI child or bridge child). */
  readonly close: () => Promise<void> | void;
  /** Open the target's engine for this pane: resume `plan.resume`, or a fresh thread. */
  readonly open: (plan: ReplacementPlan, continuePrompt: string | null) => Promise<void> | void;
  /** The project's `_dream_context`, where the handoff record goes. */
  readonly contextRoot: string;
  /** The pane id: the handoff record's key, as `handoffKey` reads it from DREAMCONTEXT_TAB_SESSION. */
  readonly pane: string;
  readonly home?: string;
  readonly now?: () => Date;
  readonly keyOf?: KeyOf;
}

export interface ReplaceResult extends ReplacementPlan {
  /** The record written for an Eco handoff (null when the thread resumed, or no task to name). */
  readonly record: HandoffRecord | null;
  readonly continuePrompt: string | null;
}

/** Close the pane's engine and open the target's: resume when the key matches, Eco otherwise. */
export async function replaceSession(current: PaneEngine, target: SwitchTarget, deps: ReplaceDeps): Promise<ReplaceResult> {
  const plan = planReplacement(current, target, deps.home, deps.keyOf);
  let record: HandoffRecord | null = null;
  let continuePrompt: string | null = null;
  if (plan.handoff) {
    // The task the pane works on carries over; a pane on no task resumes nothing it can name.
    const task = activeTaskForNudge(deps.contextRoot);
    if (task) {
      record = {
        task: task.slug,
        title: task.title,
        at: (deps.now?.() ?? new Date()).toISOString(),
        contextTokens: null,
        fromSession: current.threadId,
        tab: deps.pane,
      };
      if (!writeHandoffRecord(deps.contextRoot, deps.pane, record)) record = null;
    }
    continuePrompt = record ? handoffContinuePrompt(record) : null;
  }
  await deps.close();
  await deps.open(plan, continuePrompt);
  return { ...plan, record, continuePrompt };
}
