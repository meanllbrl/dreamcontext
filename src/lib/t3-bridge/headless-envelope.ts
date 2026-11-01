/**
 * What each unattended surface may do on Codex (plan r5 §6, W4 Lane B). One row per surface, read
 * by the callers and pinned by `permission-envelope.test.ts`: a Codex run is never wider than the
 * same surface on Claude, and no row ever reaches full access, because the owner's rule is that
 * nothing outside the vault opens up (Claude's `bypassPermissions` for an automation stays a
 * Claude thing). `auto` = workspace-write on the project and its linked repos, network off, every
 * approval declined; `default` = read-only, every approval declined.
 *
 * `null` = Claude only, with the reason. The caller refuses rather than running the row wider.
 *
 * No Effect here: the runner, the server and the tests import it.
 */
export type HeadlessSurface =
  | 'automation' | 'agent' | 'light' | 'verdict' | 'sleep' | 'super-child'
  | 'board-agent' | 'task-step' | 'approval-question' | 'builder' | 'peer';

export interface HeadlessEnvelope {
  /** The rule this surface has on Claude. */
  readonly claude: string;
  /** Its Codex mode (policy.ts), or null when it stays on Claude. */
  readonly codex: 'auto' | 'default' | null;
  /** The brain's MCP write path. */
  readonly brain: boolean;
  /** No MCP from the owner's Codex config and no web search: Claude runs this surface so too. */
  readonly strict?: boolean;
  readonly why?: string;
}

export const HEADLESS_ENVELOPES: Readonly<Record<HeadlessSurface, HeadlessEnvelope>> = {
  automation: { claude: 'bypassPermissions', codex: 'auto', brain: true },
  agent: { claude: 'bypassPermissions', codex: 'auto', brain: true },
  light: { claude: 'read-only tools', codex: 'default', brain: false, strict: true },
  verdict: { claude: 'bypassPermissions, resumed', codex: 'auto', brain: true },
  sleep: { claude: 'bypassPermissions without WebFetch, WebSearch, MCP', codex: 'auto', brain: true, strict: true },
  'super-child': { claude: 'lean MCP, the chat mode', codex: 'auto', brain: true, strict: true },
  'board-agent': { claude: 'read denies on credential folders', codex: null, brain: false, why: 'Codex proved no read-denies (S3).' },
  'task-step': { claude: 'its level, a pinned session id', codex: null, brain: false, why: 'A task step pins a Claude session id before its first turn.' },
  'approval-question': { claude: 'plan mode, no orchestration tools', codex: null, brain: false, why: 'It runs before anything is approved; it stays on the narrowest envelope there is.' },
  builder: { claude: 'allowlisted tools, forked sessions', codex: null, brain: false, why: 'Builders resume and fork Claude sessions, which Codex threads cannot do.' },
  peer: { claude: 'auto, in the other project', codex: null, brain: false, why: 'A peer delivery has no tool choice of its own yet.' },
};

export interface CodexRunArgs {
  readonly surface: HeadlessSurface;
  readonly prompt: string;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly account?: string | null;
  /** A native thread to continue. */
  readonly resume?: string | null;
  readonly extraRoots?: readonly string[];
}

/** `dreamcontext t3-run …`, after the CLI's path. The prompt rides whole in one `=` argument, so a
 *  prompt that starts with a dash is still its value. */
export function codexRunArgs(a: CodexRunArgs): string[] {
  const out = ['t3-run', '--surface', a.surface, `--prompt=${a.prompt}`];
  if (a.model) out.push('--model', a.model);
  if (a.effort) out.push('--effort', a.effort);
  if (a.account) out.push('--account', a.account);
  if (a.resume) out.push('--resume', a.resume);
  // Last: `--extra-root` takes every value after it.
  if (a.extraRoots?.length) out.push('--extra-root', ...a.extraRoots);
  return out;
}

/** A Claude alias or id means nothing to Codex: the account's own default answers instead. */
export function codexModelOf(model: string | null | undefined): string | null {
  if (!model) return null;
  return /^(opus|sonnet|haiku|fable|claude)\b/i.test(model) ? null : model;
}
