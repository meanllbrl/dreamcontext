/**
 * Who is calling an app tool (app-araclari plan r3 §4.2): the class a process's env puts it in.
 * The CLI (`apps do|call`) and the brain MCP `app` tool send it as the `x-dc-run` header; the
 * server uses a header only to RESTRICT (a missing header is never worth less than a present
 * one, and no header grants more than a headerless call has). First match wins:
 *
 *   spawned  DREAMCONTEXT_SPAWNED, DREAMCONTEXT_AUTO_SLEEP or DREAMCONTEXT_ASK_DEPTH set:
 *            peer delivery, a cross-tool ask, a builder, background sleep. A change: never.
 *   run*     DREAMCONTEXT_AUTOMATION_RUN set (only the runner sets it): a run, even when it
 *            inherited crew marks from the shell that started it (`automations run` from the
 *            Super Agent's shell copies its env). Checked before crew (app-arac-izin review).
 *   crew     DREAMCONTEXT_SUPER_CREW or DREAMCONTEXT_MEMBER_CREW set: the Super Agent and its
 *            children (the owner's own Super chat too, which carries the same mark). The main
 *            Super's own session passes (the owner is there, told by the server's own record); a
 *            member's Super or child (`member`, from DREAMCONTEXT_MEMBER_SUPER or _MEMBER_CREW)
 *            with the tools its approved member file names (`call.app_tools`); the rest never.
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
  /** The AI Team member a crew process belongs to (crew only): its Super or one of its children. */
  member?: string;
}

export const RUN_HEADER = 'x-dc-run';

/** Every env key `callClaim` reads: a launcher that filters the env (Codex's MCP servers) passes these. */
export const CLAIM_ENV_KEYS = [
  'DREAMCONTEXT_SPAWNED', 'DREAMCONTEXT_AUTO_SLEEP', 'DREAMCONTEXT_ASK_DEPTH',
  'DREAMCONTEXT_SUPER_CREW', 'DREAMCONTEXT_MEMBER_CREW', 'DREAMCONTEXT_MEMBER_SUPER', 'DREAMCONTEXT_AGENT_CHAT',
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
const MEMBER_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function callClaim(env: NodeJS.ProcessEnv = process.env): CallClaim {
  if (set(env, 'DREAMCONTEXT_SPAWNED') || set(env, 'DREAMCONTEXT_AUTO_SLEEP') || set(env, 'DREAMCONTEXT_ASK_DEPTH')) return { class: 'spawned' };
  if (set(env, 'DREAMCONTEXT_AUTOMATION_RUN')) return runClaim(env);
  if (set(env, 'DREAMCONTEXT_SUPER_CREW') || set(env, 'DREAMCONTEXT_MEMBER_CREW')) {
    // A member's own Super names it in _MEMBER_SUPER, its children in _MEMBER_CREW ('*' = unsure: none).
    const member = [(env.DREAMCONTEXT_MEMBER_SUPER ?? '').trim(), (env.DREAMCONTEXT_MEMBER_CREW ?? '').trim()].find((v) => MEMBER_RE.test(v));
    return { class: 'crew', ...(member ? { member } : {}) };
  }
  if (set(env, 'DREAMCONTEXT_AGENT_CHAT') && !set(env, 'DREAMCONTEXT_AUTOMATION_RUN')) return { class: 'chat' };
  if (set(env, 'DREAMCONTEXT_AUTOMATION_SLUG') || set(env, 'DREAMCONTEXT_AGENT_SELF')) return runClaim(env);
  return { class: 'owner' };
}

function runClaim(env: NodeJS.ProcessEnv): CallClaim {
  const automation = (env.DREAMCONTEXT_AUTOMATION_SLUG ?? '').trim() || (env.DREAMCONTEXT_AGENT_SELF ?? '').trim();
  const run = (env.DREAMCONTEXT_AUTOMATION_RUN ?? '').trim();
  return { class: 'run', ...(automation ? { automation } : {}), ...(run ? { run } : {}) };
}

/** The header value: compact JSON, slug and run id cut to safe lengths. */
export function encodeClaim(c: CallClaim): string {
  return JSON.stringify({ class: c.class, ...(c.automation ? { automation: c.automation.slice(0, 80) } : {}), ...(c.run ? { run: c.run.slice(0, 80) } : {}), ...(c.member ? { member: c.member.slice(0, 80) } : {}) });
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
    const member = cls === 'crew' && typeof o.member === 'string' && MEMBER_RE.test(o.member) ? o.member : undefined;
    return { class: cls, ...(slug ? { automation: slug } : {}), ...(run ? { run } : {}), ...(member ? { member } : {}) };
  } catch {
    return { class: 'spawned' };
  }
}
