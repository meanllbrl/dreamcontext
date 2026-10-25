import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readMachineIdentity } from '../machine-id.js';
import { readVaultFileSafe, safeWriteTarget } from '../vault-read.js';
import { currentLogin, ownedBy } from './owner.js';
import { isSafeAutomationSlug } from './slot.js';
import { isGlobalAgentHere } from './scope.js';
import { AGENTS_DIR } from './types.js';

/**
 * Which of the owner's machines runs an agent (AI Team v2 B1-7): `agents/.active/<slug>.json`
 * `{machine, name, since, by, from?}`, synced like the agent itself. Only the active machine runs
 * it; "Bring it here" writes this machine and pushes at once; every unattended start re-reads it.
 * Merged by the `agent-active` class (later `since` wins). A record whose `by` is not the agent's
 * owner is ignored (a teammate cannot steer someone else's agent onto a machine). No record = the
 * agent has only ever run on one machine, which is free to run it.
 *
 * Residual (named): the machine that was active stops at its next pull, so until then both may run.
 */

export interface ActiveRecord {
  machine: string;
  name: string;
  since: string;
  by: string;
  /** The machine it was brought from, for the "N tasks were assigned on <machine>" row. */
  from?: { machine: string; name: string };
}

const SINCE_SLACK_MS = 5 * 60_000;

export function activePath(contextRoot: string, slug: string): string {
  return join(contextRoot, AGENTS_DIR, '.active', `${slug}.json`);
}

/** The record for `slug`, through the safe reader, or null when absent, unreadable, from the
 *  future, or written by someone other than `owner`. */
export function readActive(contextRoot: string, slug: string, owner: string | null, now: Date = new Date()): ActiveRecord | null {
  if (!isSafeAutomationSlug(slug)) return null;
  const raw = readVaultFileSafe(contextRoot, join(AGENTS_DIR, '.active', `${slug}.json`));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<ActiveRecord>;
    if (typeof o.machine !== 'string' || typeof o.since !== 'string' || typeof o.by !== 'string') return null;
    const since = Date.parse(o.since);
    if (!Number.isFinite(since) || since > now.getTime() + SINCE_SLACK_MS) return null;
    if (owner && o.by.toLowerCase() !== owner.toLowerCase()) return null;
    return {
      machine: o.machine,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 64) : 'another machine',
      since: o.since,
      by: o.by,
      ...(o.from && typeof o.from.machine === 'string' ? { from: { machine: o.from.machine, name: typeof o.from.name === 'string' ? o.from.name.slice(0, 64) : 'another machine' } } : {}),
    };
  } catch {
    return null;
  }
}

export type Placement =
  | { here: true }
  | { here: false; machine: string; name: string };

/** May THIS machine run `slug` right now? */
export function placement(contextRoot: string, slug: string, owner: string | null, home?: string, now: Date = new Date()): Placement {
  // A global agent lives on this machine only: no synced record can move it (D1).
  if (isGlobalAgentHere(contextRoot, slug)) return { here: true };
  const rec = readActive(contextRoot, slug, owner, now);
  if (!rec) return { here: true };
  const me = readMachineIdentity(home).id;
  return rec.machine === me ? { here: true } : { here: false, machine: rec.machine, name: rec.name };
}

/**
 * Make this machine the one that runs `slug` (the owner's "Bring it here", or this machine's
 * claim when it starts syncing an agent it created). Only the owner may write it. The caller
 * pushes the brain right after, so the other machine learns at its next pull.
 */
export function writeActiveHere(contextRoot: string, slug: string, owner: string | null, home?: string, now: Date = new Date()): ActiveRecord {
  const login = currentLogin();
  if (!ownedBy(owner, login)) throw new Error('Only the agent\'s owner chooses where it runs.');
  const me = readMachineIdentity(home);
  const prev = readActive(contextRoot, slug, owner, now);
  const rec: ActiveRecord = {
    machine: me.id,
    name: me.name,
    since: now.toISOString(),
    by: owner ?? login,
    ...(prev && prev.machine !== me.id ? { from: { machine: prev.machine, name: prev.name } } : {}),
  };
  const path = activePath(contextRoot, slug);
  if (!safeWriteTarget(contextRoot, path)) throw new Error('Refusing to write where the agent runs through a symlink.');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
  return rec;
}
