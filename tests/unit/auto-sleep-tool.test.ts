/** TABLO rows 6 and 15: the background sleep a turn starts runs on that turn's tool, in its words. */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stopTurnTool } from '../../src/cli/commands/hook.js';
import { setHookTool } from '../../src/lib/hook-tool.js';
import { buildAutoSleepPrompt } from '../../src/lib/sleep-prompt.js';
import { CLAUDE_ONLY, toolText } from '../../src/lib/tool-text.js';

const HOME = '/Users/someone';

describe('which tool a turn ended on', () => {
  afterEach(() => setHookTool(null));

  it('a Claude hook is Claude: no --tool, the cycle stays as it was', () => {
    expect(stopTurnTool({ transcript_path: join(HOME, '.claude/projects/x/s.jsonl') }, HOME)).toBeNull();
  });

  it('a bridge hook is Codex unless the turn says Antigravity', () => {
    setHookTool('codex');
    expect(stopTurnTool({ transcript_path: join(HOME, '.codex/sessions/2026/11/02/rollout-a.jsonl') }, HOME)).toBe('codex');
    expect(stopTurnTool({}, HOME)).toBe('codex');
    expect(stopTurnTool({ transcript_path: join(HOME, '.dreamcontext/t3/transcripts/thread-1.jsonl') }, HOME)).toBe('antigravity');
    expect(stopTurnTool({ dc_tool: 'antigravity' }, HOME)).toBe('antigravity');
    // A path that only looks like it (a sibling folder, a `..`) is not the transcripts folder.
    expect(stopTurnTool({ transcript_path: join(HOME, '.dreamcontext/t3/transcripts-evil/x.jsonl') }, HOME)).toBe('codex');
    expect(stopTurnTool({ transcript_path: join(HOME, '.dreamcontext/t3/transcripts/../x.jsonl') }, HOME)).toBe('codex');
  });

  it("the cycle's text names the tool's own sub-agent tool, never Claude's", () => {
    const prompt = buildAutoSleepPrompt([]);
    expect(prompt).toMatch(CLAUDE_ONLY);
    expect(toolText(prompt, 'codex')).not.toMatch(CLAUDE_ONLY);
    expect(toolText(prompt, 'codex')).toContain('spawn_agent');
    expect(toolText(prompt, 'antigravity')).not.toMatch(CLAUDE_ONLY);
  });
});
