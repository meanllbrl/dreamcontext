import { describe, expect, it } from 'vitest';
import { agentRunRunning, type SubAgentRun } from '../../dashboard/src/components/sleepy/chat/chatEntities';
import { readFileSync } from 'node:fs';

const run = (o: Partial<SubAgentRun>): SubAgentRun => ({ taskId: 't', name: 'x', status: 'running', startedAt: 1, ...o });

describe('agentsWorking is read, never remembered', () => {
  it('a finished agent or a plain shell is not work; a running agent is', () => {
    expect(agentRunRunning([run({ status: 'completed' })])).toBe(false);
    expect(agentRunRunning([run({ taskType: 'local_bash', name: 'npm run dev' })])).toBe(false);
    expect(agentRunRunning([run({})])).toBe(true);
  });

  it('the session derives it: the pane only reports teammates', () => {
    const src = readFileSync('dashboard/src/components/sleepy/chatSession.ts', 'utf8');
    expect(src).toContain('get agentsWorking() { return teammatesWorking || agentRunRunning(conv.subAgents); }');
    expect(src).not.toContain('session.agentsWorking = ');
  });
});
