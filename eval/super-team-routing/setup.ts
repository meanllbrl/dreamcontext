/**
 * The scratch project every arm of the AI Team routing eval runs in, and the unit tests read:
 * the "Orbit" fixture of eval/super-orchestration, plus (with a team) `fixture-team/` on top of it:
 * four AI Team members and one Lab insight. Approvals are seeded in a scratch HOME, never the
 * real one: Ledger, Probe (its slot is the same-slug automation `automations/probe.md`) and
 * Lookout are approved; Atlas is not.
 */
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAutomation } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ORBIT_FIXTURE = resolve(HERE, '..', 'super-orchestration', 'fixture');
export const TEAM_OVERLAY = join(HERE, 'fixture-team');
/** The members `super team ask` takes on this machine. Atlas waits for its approval. */
export const APPROVED_MEMBERS = ['ledger', 'probe', 'lookout'] as const;
const SEEDED_AT = new Date('2026-10-29T09:00:00.000Z');

export interface TeamProject { proj: string; contextRoot: string; home: string }

/** A fresh copy under `root`: `team` adds the members. `home` is created beside it. */
export function makeTeamProject(root: string, opts: { team: boolean; proj?: string; home?: string }): TeamProject {
  const proj = opts.proj ?? mkdtempSync(join(root, opts.team ? 'team-' : 'noteam-'));
  const home = opts.home ?? join(dirname(proj), `${basename(proj)}-home`);
  mkdirSync(home, { recursive: true });
  cpSync(ORBIT_FIXTURE, proj, { recursive: true });
  const contextRoot = join(proj, '_dream_context');
  if (opts.team) {
    cpSync(TEAM_OVERLAY, proj, { recursive: true });
    for (const slug of APPROVED_MEMBERS) {
      const m = getAutomation(contextRoot, slug);
      if (!m) throw new Error(`fixture member ${slug} is missing`);
      approveAutomation(proj, m, SEEDED_AT, home);
    }
  }
  return { proj, contextRoot, home };
}
