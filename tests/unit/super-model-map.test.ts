/**
 * The Super's model map (owner, 2026-11-08): the always-on briefing carries the work → model
 * rows in short, super-orchestration.md §3 holds the detail. Mirror-with-drift-test: the sonnet
 * row (small fix, merge, build, install, chores) must read the same in both.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { modeBriefing } from '../../src/server/chat-modes.js';

const guide = readFileSync('skill/references/super-orchestration.md', 'utf8');
const section3 = guide.slice(guide.indexOf('## 3. Models and effort'), guide.indexOf('## 4. Flow map'));

describe('super model map: briefing and §3 agree', () => {
  const brief = modeBriefing('super', { worktreeAllowed: true });

  it('decides the model for every job, cheapest that fits, never by habit or handoff', () => {
    expect(brief).toContain('decided for EVERY job before you delegate, the cheapest that fits');
    expect(brief).toContain('a habit or a handoff line never sets');
  });

  it('the sonnet and haiku rows name the same work in both', () => {
    expect(brief).toMatch(/small clear fix \(1-3 files[^)]*\), merge, build,\s+install, chores `sonnet` `medium`/);
    expect(section3).toMatch(/merge, build, install, brain chores, a small clear fix \(1-3 files\)[\s\S]*`sonnet` \/ `medium`/);
    expect(section3).toContain('long research that changes nothing');
    expect(section3).toMatch(/`haiku` \/ `low` child;\s+haiku never writes or edits anything/);
    expect(section3).toMatch(/anything that writes or edits, even a mechanical edit with an exact spec, a rename or formatting/);
    expect(section3).not.toMatch(/mechanical edit with an exact spec[^\n]*`haiku`/);
    expect(brief).toMatch(/haiku\s+`low` child ONLY for long multi-source research that changes nothing/);
    expect(brief).toMatch(/any job that writes or edits,\s+even a mechanical edit with an exact spec/);
  });

  it('a short lookup is a haiku sub-agent, never a child (owner, 2026-11-22)', () => {
    expect(brief).toMatch(/a short lookup \(a path, a line, a status\) is no child: your own `haiku` sub-agent that only locates/);
    expect(section3).toMatch(/a short lookup \(find a file, a line, a status\) is NOT a child/);
    expect(section3).toMatch(/`model: haiku`[\s\S]*only\s+LOCATES/);
    expect(section3).toContain('a running child does the same for its own lookups');
  });

  it('other tools get the same rows in their own small/mid/large model', () => {
    expect(brief).toContain("that tool's small, mid, large model (small: read-only research only)");
  });

  it('the handoff never records a fixed model per job kind', () => {
    expect(brief).toContain('never fixes a model per kind of job');
    expect(guide).toContain('never records a fixed model per kind of job');
  });
});

describe('§3 has one row per kind of work (super-cocuk-tasarruf D4)', () => {
  const brief = modeBriefing('super', { worktreeAllowed: true });
  const bullets = section3.split(/\n(?=- )/).filter((b) => b.startsWith('- ') && b.includes('→'));

  it('research sits in exactly one row per purpose: gathering is haiku, a judgement is opus', () => {
    expect(bullets.filter((b) => /research/.test(b) && /`haiku` \/ `low`/.test(b))).toHaveLength(1);
    expect(bullets.filter((b) => /`opus` \/ `medium`/.test(b) && /\bresearch\b/.test(b))).toHaveLength(0);
    expect(section3).toContain('research ending in a judgement is `opus`, research that only gathers is `haiku`');
  });

  it('each model/effort lead appears in one row only', () => {
    for (const lead of ['`haiku` / `low`', '`sonnet` / `medium`', '`opus` / `medium`', '`fable` / `high`']) {
      expect(bullets.filter((b) => b.includes(`→ ${lead}`) || b.includes(`→ a ${lead}`))).toHaveLength(1);
    }
  });

  it('the briefing agrees: a diagnosis or recommendation is opus medium', () => {
    expect(brief).toContain('a diagnosis or recommendation `opus` `medium`');
    expect(brief).not.toMatch(/analysis `opus` `medium`/);
  });

  it('the guide says when to use --keep and what a HANDOFF: reply means', () => {
    expect(guide).toContain('`--keep` drops it (its own question, a reply needing the live\nconversation)');
    expect(guide).toContain('opening `HANDOFF:` = `super delegate --succeeds <child>`');
  });
});

describe('read-only lookup helper runs on haiku and only locates (owner, 2026-11-22)', () => {
  const skill = readFileSync('skill/SKILL.md', 'utf8');
  const explore = readFileSync('agents/dreamcontext-explore.md', 'utf8');
  it('the agent is pinned to haiku and answers with locations', () => {
    expect(explore).toMatch(/^model: haiku$/m);
    expect(explore).toContain('the Answer is locations: `path:line` and a short quote each, never a summary');
  });
  it('the skill says no model override and no new child for a short lookup', () => {
    expect(skill).toContain('dispatch it with no model override (never `opus`)');
    expect(skill).toContain('A short lookup is this sub-agent, never a new chat or Super child');
  });
});
