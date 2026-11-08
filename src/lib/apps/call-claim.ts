/**
 * Who is calling an app tool (app-araclari plan r3 §4.2): the class a process's env puts it in.
 * The CLI (`apps do|call`) and the brain MCP `app` tool send it as the `x-dc-run` header; the
 * server uses a header only to RESTRICT (a missing header is never worth less than a present
 * one, and no header grants more than a headerless call has). First match wins:
 *
 *   spawned  DREAMCONTEXT_SPAWNED, DREAMCONTEXT_AUTO_SLEEP or DREAMCONTEXT_ASK_DEPTH set:
 *            peer delivery, a cross-tool ask, a builder, background sleep. A change: never.
 *   crew     DREAMCONTEXT_SUPER_CREW or DREAMCONTEXT_MEMBER_CREW set: the Super Agent and its
 *            children (the owner's own Super chat too, which carries the same mark). Never.
 *   chat     DREAMCONTEXT_AGENT_CHAT set and no DREAMCONTEXT_AUTOMATION_RUN: a conversation the
 *            owner types in (an app chat, a board card chat), even with DREAMCONTEXT_AGENT_SELF.
 *   run      DREAMCONTEXT_AUTOMATION_RUN, DREAMCONTEXT_AUTOMATION_SLUG or DREAMCONTEXT_AGENT_SELF
 *            set: an unattended run. A change only when the approved job names the tool, or the
 *            owner started this very job from the dashboard.
 *   owner    none of them: the owner's own Chat or terminal.
 *
 * An empty string counts as unset (the chat spawner writes `''` to clear a mark). The session
 * origin's SPAWN_ENV_KEYS is NOT used: it lists the run keys too and would make every run spawned.
 */

export type CallClass = 'spawned' | 'crew' | 'chat' | 'run' | 'owner';

export interface CallClaim {
  class: CallClass;
  /** The job's slug, from DREAMCONTEXT_AUTOMATION_SLUG or DREAMCONTEXT_AGENT_SELF (run only). */
  automation?: string;
  /** The run id, from DREAMCONTEXT_AUTOMATION_RUN (run only). */
  run?: string;
}

export const RUN_HEADER = 'x-dc-run';

/** Every env key `callClaim` reads: a launcher that filters the env (Codex's MCP servers) passes these. */
export const CLAIM_ENV_KEYS = [
  'DREAMCONTEXT_SPAWNED', 'DREAMCONTEXT_AUTO_SLEEP', 'DREAMCONTEXT_ASK_DEPTH',
  'DREAMCONTEXT_SUPER_CREW', 'DREAMCONTEXT_MEMBER_CREW', 'DREAMCONTEXT_AGENT_CHAT',
  'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTOMATION_SLUG', 'DREAMCONTEXT_AGENT_SELF',
] as const;

/** The set (non-empty) claim keys of `env`, values cut to 128 characters. */
export function claimEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CLAIM_ENV_KEYS) {
    const v = (env[k] ?? '').trim();
    if (v) out[k] = v.slice(0, 128);
  }
  return out;
}

const set = (env: NodeJS.ProcessEnv, k: string): boolean => !!(env[k] ?? '').trim();

export function callClaim(env: NodeJS.ProcessEnv = process.env): CallClaim {
  if (set(env, 'DREAMCONTEXT_SPAWNED') || set(env, 'DREAMCONTEXT_AUTO_SLEEP') || set(env, 'DREAMCONTEXT_ASK_DEPTH')) return { class: 'spawned' };
  if (set(env, 'DREAMCONTEXT_SUPER_CREW') || set(env, 'DREAMCONTEXT_MEMBER_CREW')) return { class: 'crew' };
  if (set(env, 'DREAMCONTEXT_AGENT_CHAT') && !set(env, 'DREAMCONTEXT_AUTOMATION_RUN')) return { class: 'chat' };
  if (set(env, 'DREAMCONTEXT_AUTOMATION_RUN') || set(env, 'DREAMCONTEXT_AUTOMATION_SLUG') || set(env, 'DREAMCONTEXT_AGENT_SELF')) {
    const automation = (env.DREAMCONTEXT_AUTOMATION_SLUG ?? '').trim() || (env.DREAMCONTEXT_AGENT_SELF ?? '').trim();
    const run = (env.DREAMCONTEXT_AUTOMATION_RUN ?? '').trim();
    return { class: 'run', ...(automation ? { automation } : {}), ...(run ? { run } : {}) };
  }
  return { class: 'owner' };
}

/** The header value: compact JSON, slug and run id cut to safe lengths. */
export function encodeClaim(c: CallClaim): string {
  return JSON.stringify({ class: c.class, ...(c.automation ? { automation: c.automation.slice(0, 80) } : {}), ...(c.run ? { run: c.run.slice(0, 80) } : {}) });
}

const CLASSES: readonly CallClass[] = ['spawned', 'crew', 'chat', 'run', 'owner'];

/**
 * The server's reading of the header. Absent → `owner` (a headerless call is the owner's: the
 * honest limit of plan §4.2). Present but unreadable or unknown → `spawned`: a header someone
 * wrote can only take rights away.
 */
export function decodeClaim(raw: string | string[] | undefined): CallClaim {
  if (raw === undefined) return { class: 'owner' };
  const v = Array.isArray(raw) ? raw[0] : raw;
  try {
    const o = JSON.parse(String(v)) as Record<string, unknown>;
    const cls = CLASSES.includes(o.class as CallClass) ? (o.class as CallClass) : null;
    if (!cls) return { class: 'spawned' };
    const slug = typeof o.automation === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(o.automation) ? o.automation : undefined;
    const run = typeof o.run === 'string' && o.run.length <= 80 ? o.run : undefined;
    return { class: cls, ...(slug ? { automation: slug } : {}), ...(run ? { run } : {}) };
  } catch {
    return { class: 'spawned' };
  }
}
