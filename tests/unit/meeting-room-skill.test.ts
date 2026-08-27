/**
 * Doc lock for the MEETING ROOM — item 8 of `feature-integration-pattern.md`.
 *
 * The room is deliberately UI-only: no CLI verbs, no menu item, one hidden entrance. That
 * makes its documentation MORE load-bearing than usual, not less — `integrations.md` is the
 * only place an agent can learn the room exists, who a message wakes, what `PASS` means, and
 * where the caps bite. Nothing mechanical connected that prose to the constants that
 * actually enforce it, so every number in the section could drift while `meeting-room` and
 * `meeting-delivery` stayed green.
 *
 * Every numeric claim below is asserted against the REAL exported constant, so raising a cap
 * in code forces the sentence to move with it.
 *
 * Companion: `peer-mail-skill.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_MENTION_RUNS_PER_THREAD,
  MAX_RUNS_PER_AGENT,
  threadsDir,
} from '../../src/lib/meeting-room.js';
import { MEETING_CONCURRENCY, MEETING_PASS } from '../../src/lib/meeting-delivery.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

const INTEGRATIONS_MD = readFileSync(join(ROOT, 'skill', 'references', 'integrations.md'), 'utf-8');
const CLI_REFERENCE_MD = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');
const DELIVERY_TS = readFileSync(join(ROOT, 'src', 'lib', 'meeting-delivery.ts'), 'utf-8');

/** The Meeting Room section of integrations.md, scoped the way a reader would scope it. */
function meetingSection(): string {
  const start = INTEGRATIONS_MD.indexOf('### Meeting Room');
  expect(start, 'the Meeting Room section is missing from integrations.md').toBeGreaterThan(-1);
  const nextHeading = INTEGRATIONS_MD.indexOf('\n## ', start);
  const section = INTEGRATIONS_MD.slice(start, nextHeading === -1 ? undefined : nextHeading);
  // Sanity floor: a broken scope returning a stub would make the rest vacuous.
  expect(section.length).toBeGreaterThan(800);
  return section;
}

/**
 * The section with every run of whitespace collapsed to one space. Prose here is hard
 * wrapped at ~90 columns, so a claim like "3 runs in parallel" is routinely split across
 * two lines — asserting on the raw text would fail on a reflow that changed nothing. The
 * lock is on the CLAIM, not on where the line happens to break.
 */
function flatSection(): string {
  return meetingSection().replace(/\s+/g, ' ');
}

describe('meeting room — the section exists and says what the room IS', () => {
  const section = meetingSection();

  it('distinguishes it from peer mail in the first breath', () => {
    expect(section).toContain('Peer mail addresses ONE vault');
    expect(section).toContain('**Not peer mail.**');
  });

  it('states the UI-only posture and the single hidden entrance', () => {
    // An agent that thinks a CLI verb exists will hallucinate one.
    expect(section).toContain('No CLI verbs');
    expect(section.toLowerCase()).toContain('core logo');
  });

  it('carries no CLI verb table anywhere, matching the UI-only claim', () => {
    expect(CLI_REFERENCE_MD).not.toMatch(/`meeting [a-z]+/);
    expect(CLI_REFERENCE_MD).toContain('has no CLI surface by design');
  });

  it('states the one-active-thread invariant and what happens to the previous one', () => {
    expect(section).toContain('Only ONE thread is active at a time');
    expect(section.toLowerCase()).toContain('archives the active one');
  });
});

describe('meeting room — every routing rule the orchestrator implements is documented', () => {
  const section = meetingSection();

  it('documents all four routing cases', () => {
    for (const phrase of [
      'Root announcement, no mentions',
      'Root announcement with `@Name`',
      'Thread reply, no mentions',
      'Thread reply with `@Name`',
    ]) {
      expect(section, `routing case "${phrase}" is undocumented`).toContain(phrase);
    }
  });

  it('names the engaged set — the case an agent would otherwise guess wrong', () => {
    expect(section).toContain('engaged set');
    expect(DELIVERY_TS).toContain('routeUserMessage');
  });

  it('states the mention parse is roster-driven and longest-name-first', () => {
    // A bare regex would break vault names with spaces; the doc promises it does not.
    expect(section).toContain('longest-name-first');
    expect(DELIVERY_TS).toContain('parseMentions');
  });
});

describe('meeting room — the docs quote the real constants, not a stale copy', () => {
  const section = meetingSection();

  it('the PASS token the docs teach IS the exported constant', () => {
    expect(MEETING_PASS).toBe('PASS');
    expect(section).toContain(`\`${MEETING_PASS}\``);
    expect(section).toContain('Reply-or-PASS protocol');
  });

  it('the parallelism claim matches MEETING_CONCURRENCY', () => {
    expect(flatSection()).toContain(`${MEETING_CONCURRENCY} runs in parallel`);
  });

  it('both hard caps match their constants', () => {
    const flat = flatSection();
    expect(flat).toContain(`max ${MAX_MENTION_RUNS_PER_THREAD} mention-triggered runs per thread`);
    expect(flat).toContain(`max ${MAX_RUNS_PER_AGENT} total runs per agent per thread`);
  });

  it('states a capped delivery is recorded visibly, never dropped in silence', () => {
    expect(section.toLowerCase()).toContain('never silently');
  });

  it('the thread path the docs name IS the path threadsDir() builds', () => {
    const rel = threadsDir('<home>').replace('<home>/', '');
    expect(rel).toBe(join('.dreamcontext', 'meeting-room', 'threads'));
    expect(section).toContain(`~/${rel}/<id>.json`);
  });

  it('states threads live outside every vault — the invariant that keeps the room global', () => {
    expect(section).toContain("never in any vault's `state/`");
  });
});

describe('meeting room — the permission posture is stated, not inherited silently', () => {
  const section = meetingSection();

  it('names the same auto-permission posture as peer mail', () => {
    expect(section).toContain('--permission-mode auto');
    expect(section.toLowerCase()).toContain('reports itself blocked');
  });

  it('the delivery prompt itself tells the agent that wall exists', () => {
    // The briefing is the only instruction a woken agent gets; if the wall is
    // undocumented there, it works around it instead of reporting it.
    expect(DELIVERY_TS).toContain('buildMeetingPrompt');
    expect(DELIVERY_TS.toLowerCase()).toContain('cannot be granted here');
  });
});
