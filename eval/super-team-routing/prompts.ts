/**
 * What each arm hands `claude`, built the way the app builds it. Pure but for reads (the fixture,
 * the frozen baseline); shared by the runner and the unit tests, so neither keeps its own copy.
 *
 *   before  = the frozen 0.36.1 prompt: superBriefing rev 16 + "## This project's agents" roster and
 *             `--agents` for the Super; the plain roster for a chat (frozen/).
 *   after   = this build: superBriefing + `## Your AI Team` (superSpawnTeamBlock), no `--agents`, for
 *             the Super; the routing roster (chatSpawnRoster routing:true) and `--agents` for a chat.
 *   resume  = an old Super session (turn 1 on the before prompt) that gets the owner's next message
 *             the way agent-chat.ts assembles it now: his text, SUPER_BRIEF_TEXT, `<super-team>`
 *             (superOwnerTurnBlocks).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPER_BRIEF_TEXT, SUPER_ORCHESTRATION_GUIDE_PATH, superBriefing } from '../../src/server/chat-modes.js';
import {
  chatSpawnRoster, collectTeam, superOwnerTurnBlocks, superSpawnTeamBlock, teamFingerprint,
} from '../../src/lib/agents/team-roster.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { emptySuperState, type SuperState, type SuperTeamJob } from '../../src/lib/super/types.js';
import { nextBatch, superBatchText } from '../../src/lib/super/inbox.js';
import { noteTeamJobEnd } from '../../src/lib/super/team.js';
import { T09_FIGURE } from './scorer.js';
import type { TeamProject } from './setup.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const frozen = (f: string): string => readFileSync(join(HERE, 'frozen', f), 'utf-8');
export const VAULT = 'orbit';

export type Arm = 'before' | 'after' | 'resume';
export interface SpawnPrompt { briefing: string; agents: Record<string, unknown> | null }

/** The Super Agent's appended system prompt (and `--agents`), per arm. */
export function superSpawn(arm: 'before' | 'after', tp: TeamProject, team: boolean): SpawnPrompt {
  if (arm === 'before') {
    return team
      ? { briefing: `${frozen('super-briefing.md')}\n\n${frozen('roster.md')}`, agents: JSON.parse(frozen('agents.json')) }
      : { briefing: frozen('super-briefing.md'), agents: null };
  }
  const block = superSpawnTeamBlock(tp.contextRoot, VAULT, tp.home);
  return { briefing: [superBriefing(SUPER_ORCHESTRATION_GUIDE_PATH), block].filter(Boolean).join('\n\n'), agents: null };
}

/** An ordinary (basic) Chat tab's roster and `--agents`, per arm. */
export function chatSpawn(arm: 'before' | 'after', tp: TeamProject): SpawnPrompt {
  if (arm === 'before') return { briefing: frozen('roster.md'), agents: JSON.parse(frozen('agents.json')) };
  const r = chatSpawnRoster(tp.contextRoot, { home: tp.home, routing: true });
  if (!r) throw new Error('the fixture team has no callable agent');
  return { briefing: r.roster, agents: r.agents };
}

/** The guide installed in the scratch vault: the frozen one before, this build's after. */
export function guideFor(arm: Arm): string {
  return arm === 'before' ? frozen('guide.md') : readFileSync(join(HERE, '..', '..', 'skill', 'references', 'super-orchestration.md'), 'utf-8');
}

/** Turn 2 of the resume arm: the owner's message as agent-chat.ts writes it to a born-before Super
 *  (its system prompt has no `## Your AI Team`, so nothing counts as delivered). */
export function resumeOwnerTurn(tp: TeamProject, text: string): Array<{ type: 'text'; text: string }> {
  const members = collectTeam(tp.contextRoot, tp.home);
  const { blocks } = superOwnerTurnBlocks({
    text, briefText: SUPER_BRIEF_TEXT, teamBlock: superSpawnTeamBlock(tp.contextRoot, VAULT, tp.home),
    fingerprint: teamFingerprint(members), teamDelivered: null,
  });
  return [{ type: 'text', text }, ...blocks];
}

/** T09: the `[super events]` turn the real renderer writes when Ledger finished a job the owner
 *  waits on (its thread written into the scratch vault first). */
export function t09EventText(tp: TeamProject): string {
  const runId = '2026-10-29T10:00:00.000Z';
  const ask = appendThreadEntry(tp.contextRoot, 'ledger', { runId, kind: 'user', text: "What's this month's revenue?", via: 'super', now: new Date(runId) });
  appendThreadEntry(tp.contextRoot, 'ledger', {
    runId, kind: 'agent', via: 'cli', now: new Date('2026-10-29T10:02:00.000Z'),
    text: `October revenue so far (to 29 Oct): ${T09_FIGURE} net, up 3.1% on September. Refunds: $640. MRR now: $51,900 (mrr-now).`,
  });
  appendThreadEntry(tp.contextRoot, 'ledger', { runId, kind: 'system', event: 'ok', text: 'ok', via: 'runner', now: new Date('2026-10-29T10:02:05.000Z') });
  const job: SuperTeamJob = {
    id: 'team-eval1', member: 'ledger', runId, entryId: ask.id, jobKind: 'run', queued: false,
    brief: 'This month\'s revenue', startedAt: Date.parse(runId), awaited: true, open: true,
  };
  const s: SuperState = { ...emptySuperState(), session: 'sup-eval', enabled: true, team: [job] };
  if (!noteTeamJobEnd(tp.contextRoot, s, job.id, null)) throw new Error('T09: the job did not end');
  return superBatchText(tp.contextRoot, s, nextBatch(s).items, 'b-eval');
}
