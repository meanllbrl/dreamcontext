/**
 * Mechanical enforcement of `chat-surface.ts`'s own standing rule: "A capability named here
 * that the view doesn't render is worse than one left unnamed." Two directions, both pinned:
 *
 *   1. Every `dream-view` example the briefing shows the agent is actually accepted by the
 *      real client parser (`parseChatActions` → `parseViewBlock`) — a typo or a schema drift
 *      would otherwise ship a briefing that promises a view the app silently drops.
 *   2. Every `type` the client actually understands (`VIEW_TYPES`) is named somewhere in the
 *      briefing — an unnamed type is a capability the agent can never reach.
 *
 * `tests/unit/chat-actions.test.ts` already owns the `BoardCanvas`-removal regression lock
 * (Capability 3, criterion 10) — this file does not duplicate it, only the `dream-view`
 * lockstep the plan assigns to T9.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_SURFACE_BRIEFING } from '../../src/server/chat-surface.js';
import { parseChatActions } from '../../dashboard/src/components/sleepy/chat/chatActions.js';
import { VIEW_TYPES } from '../../dashboard/src/lib/chatViewSpec.js';

/** Every fenced ```dream-view block the briefing actually shows the agent, in order. */
function extractViewExamples(briefing: string): string[] {
  const re = /```dream-view\r?\n([\s\S]*?)\r?\n```/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(briefing))) blocks.push(m[1]);
  return blocks;
}

describe('CHAT_SURFACE_BRIEFING <-> dream-view parser lockstep', () => {
  const examples = extractViewExamples(CHAT_SURFACE_BRIEFING);

  it('shows at least one dream-view example per type the client understands', () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it('every dream-view example in the briefing is accepted by the real parser, unmodified', () => {
    for (const json of examples) {
      const fenced = '```dream-view\n' + json + '\n```';
      const result = parseChatActions(fenced);
      expect(result.views.length, `rejected example:\n${json}\nnotices: ${result.notices.join(' | ')}`).toBe(1);
      // A rejected/unknown-type block never reaches `views` — it only ever produces a
      // notice — so a non-empty `views` above already proves the type was recognized. This
      // also checks the block round-trips as the SAME type it was written as.
      const declaredType = (JSON.parse(json) as { type: string }).type;
      expect(result.views[0].type).toBe(declaredType);
    }
  });

  it('every type named in the briefing examples is one parseViewBlock actually accepts', () => {
    const typesInBriefing = examples.map((json) => (JSON.parse(json) as { type: string }).type);
    for (const t of typesInBriefing) {
      expect(VIEW_TYPES as readonly string[], t).toContain(t);
    }
  });

  it('every VIEW_TYPES member is demonstrated somewhere in the briefing', () => {
    const typesInBriefing = new Set(examples.map((json) => (JSON.parse(json) as { type: string }).type));
    for (const t of VIEW_TYPES) {
      expect(typesInBriefing.has(t), `VIEW_TYPES has "${t}" but no briefing example uses it`).toBe(true);
    }
    // Bidirectional: the briefing never demonstrates a type the client doesn't have either.
    expect(typesInBriefing.size).toBe(VIEW_TYPES.length);
  });

  it('the fence name itself is named in prose, not just shown in examples', () => {
    expect(CHAT_SURFACE_BRIEFING).toContain('dream-view');
  });

  /**
   * "Progress is DERIVED, never asserted" is the whole reason the user can trust that
   * number, and the briefing is where an agent learns what to send. A `percent` shown in an
   * example would teach exactly the habit `validateProgress` then has to punish — so the
   * rule is pinned here rather than left to whoever next edits the prose.
   */
  it('no progress example ever shows a percent — it is derived, not asserted', () => {
    const progress = examples
      .map((json) => JSON.parse(json) as Record<string, unknown>)
      .filter((v) => v.type === 'progress');
    expect(progress.length, 'the briefing demonstrates no progress block at all').toBeGreaterThan(0);
    for (const p of progress) {
      for (const key of ['percent', 'pct', 'done', 'total']) {
        expect(p[key], `a progress example carries "${key}"`).toBeUndefined();
      }
    }
  });
});

/**
 * The SURFACE GATE. `dream-view` is a Chat-view capability and must stay one: the briefing is
 * what tells an agent the fence exists, so it may only ever be appended to a CHAT spawn. A
 * terminal-spawned agent (Claude Code, the legacy Terminal view) that learned about the fence
 * would emit raw JSON in front of the user — the precise failure `chat-surface.ts`'s header
 * calls "worse than one left unnamed".
 *
 * This is pinned mechanically rather than by convention because the leak is silent: nothing
 * fails, the user just sees a JSON blob where an answer should be.
 */
describe('dream-view is surface-gated to the Chat spawn', () => {
  const root = new URL('../../', import.meta.url).pathname;
  const read = (p: string) => readFileSync(join(root, p), 'utf-8');

  it('only the chat route imports the briefing — the terminal route never does', () => {
    expect(read('src/server/routes/agent-chat.ts')).toContain('CHAT_SURFACE_BRIEFING');
    expect(read('src/server/routes/agent-terminal.ts')).not.toContain('CHAT_SURFACE_BRIEFING');
    expect(read('src/server/routes/agent-terminal.ts')).not.toContain('append-system-prompt-file');
  });

  it('no other server route smuggles the briefing into a non-chat spawn', () => {
    const routes = readdirSync(join(root, 'src/server/routes')).filter((f) => f.endsWith('.ts'));
    const carriers = routes.filter((f) => read(join('src/server/routes', f)).includes('CHAT_SURFACE_BRIEFING'));
    expect(carriers, `only agent-chat.ts may carry the briefing, found: ${carriers.join(', ')}`).toEqual(['agent-chat.ts']);
  });

  it('SKILL.md never instructs an agent to emit a view without naming the surface gate', () => {
    const skill = read('skill/SKILL.md');
    if (!skill.includes('dream-view')) return; // capability not mentioned there at all — fine
    // Mentioning it is fine (the dashboard capabilities row describes what the app CAN do);
    // what must never happen is a bare instruction with no surface condition attached.
    expect(
      /SURFACE-GATED|surface briefing|Chat view only/i.test(skill),
      'skill/SKILL.md names dream-view but states no surface gate — a Claude Code or legacy-Terminal agent could emit the fence into a surface that renders it as raw JSON',
    ).toBe(true);
  });
});

// Criterion 10 ("dashboard/src contains no reference to BoardCanvas") is already asserted by
// `tests/unit/chat-actions.test.ts`'s "BoardCanvas — fully removed (Capability 3, criterion
// 10)" describe block, added alongside the board-fullscreen change itself. Not duplicated here.
