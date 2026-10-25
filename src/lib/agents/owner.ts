import { homedir } from 'node:os';
import { readGlobalGitHubLogin } from '../git-sync/auth-store.js';
import { readMachineIdentity } from '../machine-id.js';
import { AutomationError } from '../automations/types.js';

/**
 * Who owns an agent or an automation, and whether this machine may write, run, talk to or assign
 * it (AI Team v2, wave B1). Every agent and automation belongs to its creator's GitHub login
 * (`owner:` on the manifest, unhashed, stamped at create); everyone else reads it, read-only.
 *
 * The login is the one the brain sync uses (`readGlobalGitHubLogin`). Before anyone signs in on a
 * machine, a member created there is stamped `machine:<id>`; the owner-stamping migration turns
 * it into the login at first sign-in, only for members created on that machine.
 *
 * Imports no store: `automations/registry.ts` reads this for its `not_owner` verdict, and that
 * module stays layout-independent.
 *
 * The identity is the PROCESS's machine (`homedir()`, i.e. `$HOME`), never a `home` a caller
 * injects for the approval registry or the M0 store: those are storage locations, while who this
 * machine is does not change with them. A test of two machines switches `$HOME`.
 */

/** A member whose creator could not be worked out: read-only on every machine. */
export const UNOWNED = 'unowned';

export const MACHINE_OWNER_PREFIX = 'machine:';

/** `machine:<id>`: the owner a member gets on a machine nobody has signed into yet. */
export function machineOwner(): string {
  return `${MACHINE_OWNER_PREFIX}${readMachineIdentity(homedir()).id}`;
}

/** The identity this machine writes as: the signed-in login, else `machine:<id>`. */
export function currentLogin(): string {
  return readGlobalGitHubLogin(homedir()) ?? machineOwner();
}

/** A manifest's `owner:` as written, trimmed, or null when it carries none. */
export function parseOwner(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 100) : null;
}

/**
 * Does `owner` belong to this machine's identity? An UNSTAMPED member (no `owner:`) counts as owned:
 * it predates owners, the every-run migration stamps it at the next start, and until then it is
 * still behind this machine's approval hash exactly as before. `unowned` is never owned.
 */
export function ownedBy(owner: string | null | undefined, login: string = currentLogin()): boolean {
  if (!owner) return true;
  if (owner === UNOWNED) return false;
  if (owner.toLowerCase() === login.toLowerCase()) return true;
  return owner.startsWith(MACHINE_OWNER_PREFIX) && owner === machineOwner();
}

/** The owners a run target answers to: its agent's, and its routine's when that differs. */
export interface OwnedTarget {
  owner?: string | null;
  jobOwner?: string | null;
}

/** The first owner of `m` that is not this machine's identity, or null when every one is. */
export function foreignOwner(m: OwnedTarget, login: string = currentLogin()): string | null {
  for (const o of [m.owner, m.jobOwner]) {
    if (!ownedBy(o ?? null, login)) return o as string;
  }
  return null;
}

/** How an owner reads in a sentence. */
export function ownerLabel(owner: string): string {
  if (owner === UNOWNED) return 'nobody (unowned)';
  if (owner.startsWith(MACHINE_OWNER_PREFIX)) return 'a machine nobody has signed into';
  return owner;
}

/** The refusal a write to someone else's member gets. `code` is what the CLI and routes key on. */
export class NotOwnerError extends AutomationError {
  readonly code = 'not_owner' as const;
  constructor(readonly owner: string, title: string) {
    super(`${title} belongs to ${ownerLabel(owner)}, so it is read-only here: only its owner can change it, run it, talk to it or give it a task.`);
    this.name = 'NotOwnerError';
  }
}

/** Throw `NotOwnerError` unless every owner of `m` is this machine's identity. */
export function assertOwned(m: OwnedTarget, title: string, login: string = currentLogin()): void {
  const owner = foreignOwner(m, login);
  if (owner) throw new NotOwnerError(owner, title);
}

export function isNotOwnerError(err: unknown): err is NotOwnerError {
  return err instanceof Error && (err as { code?: unknown }).code === 'not_owner';
}
