/** A shell step from the bridge: T3's fallback title is no description of the step (toolAction.ts reads one). */
import { describe, expect, it } from 'vitest';
import { toolCallFor } from '../../../src/lib/t3-bridge/to-wire.js';

describe('a command_execution item as a Bash call', () => {
  it('drops T3\'s generic "Ran command" title, so a failed row says "Couldn\'t run a command" with the command', () => {
    const call = toolCallFor({ type: 'command_execution', id: 'i1', input: 'pwd', title: 'Ran command' } as never);
    expect(call).toEqual({ name: 'Bash', input: { command: 'pwd' } });
  });

  it('keeps a title that says what the step does', () => {
    const call = toolCallFor({ type: 'command_execution', id: 'i2', input: 'npm test', title: 'Run the unit tests' } as never);
    expect(call?.input).toEqual({ command: 'npm test', description: 'Run the unit tests' });
  });
});
