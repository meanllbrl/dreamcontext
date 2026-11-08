/**
 * One sub-agent stops alone (2 Nov night, lane 3): a running row wears its own Stop when the pane
 * can stop one (Claude's `stop_task`), and none when it cannot (Codex, Antigravity: T3's adapters
 * have no single-sub-agent stop) or once the run has ended.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { SubAgentRun } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

vi.mock('../../dashboard/src/components/sleepy/chat/chatEntities.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../dashboard/src/components/sleepy/chat/chatEntities.js')>();
  return { ...real, useGroupCollapse: () => ({ open: true, onToggle: () => {} }) };
});
const { SubAgentCard } = await import('../../dashboard/src/components/sleepy/chat/SubAgentCard.js');
const { partyBatches } = await import('../../dashboard/src/components/sleepy/chat/questModel.js');

const T0 = Date.parse('2026-11-02T22:00:00Z');
const run = (taskId: string, status: SubAgentRun['status']): SubAgentRun => ({
  taskId, name: `look at the parrot feeder ${taskId}`, taskType: 'local_agent', subagentType: 'dreamcontext-explore',
  status, startedAt: T0, ...(status === 'running' ? {} : { endedAt: T0 + 60_000 }),
} as SubAgentRun);

function render(runs: SubAgentRun[], onStop?: (r: SubAgentRun) => void): string {
  return renderToStaticMarkup(createElement(SubAgentCard, { runs, party: partyBatches([], runs)[0]!, onDrillIn: () => {}, ...(onStop ? { onStop } : {}) }));
}

describe('a Stop on one sub-agent', () => {
  it('is drawn on a running row when the pane can stop one, and on no ended row', () => {
    const html = render([run('a1', 'running'), run('a2', 'completed')], () => {});
    expect(html).toContain('data-subagent-stop="a1"');
    expect(html).not.toContain('data-subagent-stop="a2"');
    // Beside the row, never inside its button: a button cannot hold a button.
    expect(html).toMatch(/<\/button><button[^>]*data-subagent-stop="a1"/);
  });

  it('is not drawn where the tool cannot stop one alone', () => {
    expect(render([run('a1', 'running')])).not.toContain('data-subagent-stop');
  });
});
