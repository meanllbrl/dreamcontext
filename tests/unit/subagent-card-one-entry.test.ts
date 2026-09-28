/**
 * One entry per agent (owner 2026-09-27 11:28): a party card never shows more agent entries
 * than agents ran. With the rows open, a landed run's report lives INSIDE its own row; with
 * the rows hidden, the per-run reports are the resting list, one per run. The owner's card had
 * a row per builder AND, below the rows, a second avatar-and-title report per builder, which
 * read as twice the agents.
 *
 * Rendered to static markup with the dashboard's own React. The open/closed state is the one
 * thing SSR cannot click, so `useGroupCollapse` is pinned per test; everything else is real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { SubAgentRun } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

const state = vi.hoisted(() => ({ open: true }));
vi.mock('../../dashboard/src/components/sleepy/chat/chatEntities.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../dashboard/src/components/sleepy/chat/chatEntities.js')>();
  return { ...real, useGroupCollapse: () => ({ open: state.open, onToggle: () => {} }) };
});

const { SubAgentCard } = await import('../../dashboard/src/components/sleepy/chat/SubAgentCard.js');
const { partyBatches } = await import('../../dashboard/src/components/sleepy/chat/questModel.js');

const T0 = Date.parse('2026-09-27T10:00:00Z');
const MIN = 60_000;

/** Three landed builders of one wave, registered teammates as a Develop run makes them. */
function builders(): SubAgentRun[] {
  return ['A', 'B', 'C'].map((lane, i) => ({
    taskId: `run-${lane}`,
    name: `lane ${lane}: the fictional widget shelf`,
    taskType: 'headless_session',
    session: `0000000${i}-aaaa-4bbb-8ccc-00000000000${i}`,
    role: 'implementer',
    joined: 'spawn',
    status: 'completed',
    startedAt: T0 + i * MIN,
    endedAt: T0 + (5 + i) * MIN,
    summary: `Report ${lane}: the shelf part ${lane} is built and its tests pass.`,
    wave: 7,
    round: 1,
  }));
}

function render(runs: SubAgentRun[], superseded = false): string {
  const base = partyBatches([], runs)[0]!;
  const party = superseded ? { ...base, superseded: true } : base;
  return renderToStaticMarkup(createElement(SubAgentCard, {
    runs, party, conversationId: 'conv-1', onDrillIn: () => {},
  }));
}

/** Every element carrying data-agent-entry, with the markup up to the next entry. */
function entries(html: string): { id: string; body: string }[] {
  const re = /data-agent-entry="([^"]+)"/g;
  const hits = [...html.matchAll(re)];
  return hits.map((m, i) => ({ id: m[1]!, body: html.slice(m.index!, hits[i + 1]?.index ?? html.length) }));
}

describe('SubAgentCard: one entry per agent', () => {
  beforeEach(() => { state.open = true; });

  it('expanded, three landed runs are three entries, each holding its own report', () => {
    const html = render(builders());
    const list = entries(html);
    expect(list.map((e) => e.id)).toEqual(['run-A', 'run-B', 'run-C']);
    for (const { id, body } of list) {
      const lane = id.slice(-1);
      expect(body).toContain('class="chat-subagents-row"');
      expect(body).toContain(`Report ${lane}: the shelf part ${lane} is built`);
      expect(body).toContain('read the full report');
    }
    // No second, agent-looking report list under the rows.
    expect(html).not.toContain('chat-subagents-reports"');
    expect(html.match(/chat-subreport-name/g) ?? []).toHaveLength(0);
  });

  it('collapsed, the resting list is one report entry per run', () => {
    state.open = false;
    const html = render(builders());
    expect(html).not.toContain('class="chat-subagents-row"');
    const list = entries(html);
    expect(list.map((e) => e.id)).toEqual(['run-A', 'run-B', 'run-C']);
    for (const { id, body } of list) expect(body).toContain(`Report ${id.slice(-1)}:`);
  });

  it('a superseded round still folds its reports behind one toggle, open or collapsed', () => {
    for (const open of [true, false]) {
      state.open = open;
      const html = render(builders(), true);
      expect(html).toContain('Show the 3 reports from this round');
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain('read the full report');
      // Open, the rows are still one per agent; folding never adds or drops an entry.
      expect(entries(html)).toHaveLength(open ? 3 : 0);
    }
  });

  it('a running run has its row and no report; entries never outnumber agents', () => {
    const runs = builders();
    runs[2] = { ...runs[2]!, status: 'running', endedAt: undefined };
    const html = render(runs);
    const list = entries(html);
    expect(list).toHaveLength(3);
    expect(list[2]!.body).not.toContain('read the full report');
  });
});
