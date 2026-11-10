/**
 * The grants engine's shapes (plan uye-bildirim K3). A grant is the owner's answer to ONE stored
 * item, written by a route that just verified owner proof (G2) and read by the two enforcers
 * (the PreToolUse hook and the t3 bridge, G1). Nothing here is synced: it lives in
 * `~/.dreamcontext/grants/` on this Mac only.
 */

/** `once`: one exact call of one session. `job`: the session that asked, until it ends.
 *  `member`: a saved rule for one AI Team member in one project, until the owner removes it. */
export const GRANT_SCOPES = ['once', 'job', 'member'] as const;
export type GrantScope = typeof GRANT_SCOPES[number];

/** `exact`: the call's whole canonical input. `script`: a pinned script run by a listed
 *  interpreter, with any arguments (the only form an always-rule may take for a shell). */
export const GRANT_FORMS = ['exact', 'script'] as const;
export type GrantForm = typeof GRANT_FORMS[number];

/** What a `script` grant names to run, pinned so it cannot be swapped under the rule. */
export interface ScriptPin {
  /** The bare interpreter name as the command wrote it (`node`, `python3`, ...). */
  interpreter: string;
  /** Where that name resolved on this Mac, as a real path, outside every agent-writable root. */
  interpreterPath: string;
  interpreterSha?: string;
  /** The script's real path, inside the project, a linked repo or a temp folder. */
  scriptPath: string;
  sha256: string;
}

export interface Grant {
  id: string;
  scope: GrantScope;
  /** Real path of the project root. */
  project: string;
  /** The registry id of the session that asked (once, job). */
  pin?: string;
  /** The AI Team member the rule belongs to (member). */
  member?: string;
  tool: string;
  /** Canonical input (canonical.ts). For a `script` form: the command as the owner saw it. */
  input: string;
  form: GrantForm;
  script?: ScriptPin;
  /** The owner item it was written for: a one-shot dies with it. */
  item?: string;
  /** A job grant on a member Super's own session: the requests open when it was given. */
  requests?: string[];
  createdAt: number;
  expiresAt: number;
}

export type CrewKind = 'main' | 'member' | 'child';

/** Written by the server for a process it spawned itself; the only source of identity (whoAmI). */
export interface Binding {
  pid: number;
  /** The process start time as the OS prints it (`ps -o lstart=`): a reused pid differs. */
  startedAt: string;
  pin: string;
  /** Real path of the project root. */
  project: string;
  crew: CrewKind;
  member?: string;
  /** Every conversation id the process reported at `init`, oldest first; the last is current. */
  conversationIds: string[];
  writtenAt: number;
}

/** Once and job grants never outlive a day, whatever their stored expiry says. */
export const GRANT_MAX_MS = 24 * 60 * 60_000;
/** A member rule's stored expiry: it ends only by removal. */
export const MEMBER_NO_EXPIRY = Number.MAX_SAFE_INTEGER;
