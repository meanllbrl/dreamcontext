/**
 * Unit tests for chatEntities.ts — the pure logic shared by the Agent Chat (beta)
 * redesign's card components (task T1, plan rev.3). Covers the tool glyph map (incl.
 * the Agent/Task alias — the sub-agent-spawning tool streams as `Agent` on the
 * empirically verified CLI 2.1.218 protocol), reference classification for every
 * `RefKind`, Edit/Write diff parsing, and the sub-agent summary/suppression helpers
 * (frame-driven, per the plan's round-3 correction — NOT parentToolUseId-driven).
 */
import { describe, it, expect } from 'vitest';
import {
  toolGlyph, classifyReference, parseEditDiff, summarizeSubAgents, subAgentToolUseIds,
  deriveDiffStartLine, estimateTokens, formatTokenCount, formatDuration, classifyOutputLine,
  formatClock, splitInlineCode, isGuardedCommand, avatarHue,
  turnHasVisibleProgress, nextStickToBottom, nextRestoreTop, isAtBottom, BOTTOM_SLACK,
  wheelIntent, keyIntent, touchIntent,
  isAgentRun, runDurationMs, formatModelName, runMetaChips,
  isRunFinished, runGroupPhase, isGroupOpen, groupOutcomeNote, startSubAgentRun,
  nextFirstShown, splitWindow, revealScrollCorrection, WINDOW_TAIL, WINDOW_STEP, clampLines,
  type SubAgentRun, type ProgressProbe,
} from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

// ─── toolGlyph ──────────────────────────────────────────────────────────────────

describe('toolGlyph', () => {
  it('maps known tools to their glyph', () => {
    expect(toolGlyph('Read')).toBe('📄');
    expect(toolGlyph('Bash')).toBe('▶');
    expect(toolGlyph('Edit')).toBe('✎');
    expect(toolGlyph('Grep')).toBe('🔎');
  });

  it('aliases Agent and Task to the SAME glyph (the sub-agent-spawning tool streams as "Agent" on 2.1.218; "Task" is kept as a synonym)', () => {
    expect(toolGlyph('Agent')).toBe('⚡');
    expect(toolGlyph('Task')).toBe('⚡');
    expect(toolGlyph('Agent')).toBe(toolGlyph('Task'));
  });

  it('falls back to a default glyph for an unrecognized tool name', () => {
    expect(toolGlyph('SomeFutureTool')).toBe('✦');
    expect(toolGlyph('')).toBe('✦');
  });
});

// ─── classifyReference ──────────────────────────────────────────────────────────

describe('classifyReference', () => {
  it('classifies an image by extension, case-insensitively, with no appNav', () => {
    for (const ext of ['png', 'JPG', 'jpeg', 'gif', 'webp', 'svg']) {
      const ref = classifyReference(`assets/photo.${ext}`);
      expect(ref.kind).toBe('image');
      expect(ref.isImage).toBe(true);
      expect(ref.appNav).toBeUndefined();
    }
  });

  it('classifies a dreamcontext board (.excalidraw / .excalidraw.md under _dream_context) with no appNav', () => {
    const ref = classifyReference('_dream_context/inbox/goal-skill-v2/goal-skill-v2.board.excalidraw.md');
    expect(ref.kind).toBe('board');
    expect(ref.isImage).toBe(false);
    expect(ref.appNav).toBeUndefined();
  });

  it('classifies a task file (_dream_context/state/<slug>.md) with appNav to the tasks page', () => {
    const ref = classifyReference('_dream_context/state/feat-sleepy-agent-surface-ux-redesign.md');
    expect(ref.kind).toBe('task');
    expect(ref.label).toBe('feat-sleepy-agent-surface-ux-redesign.md');
    expect(ref.appNav).toEqual({ page: 'tasks', id: 'feat-sleepy-agent-surface-ux-redesign' });
  });

  it('classifies a knowledge file (_dream_context/knowledge/**.md) with appNav to the knowledge page, preserving subfolder in the id', () => {
    const ref = classifyReference('_dream_context/knowledge/features/in-app-agent-terminal.md');
    expect(ref.kind).toBe('knowledge');
    expect(ref.appNav).toEqual({ page: 'knowledge', id: 'features/in-app-agent-terminal' });
  });

  it('classifies a core file (_dream_context/core/<filename>) with appNav to the core page', () => {
    const ref = classifyReference('_dream_context/core/soul.md');
    expect(ref.kind).toBe('core');
    expect(ref.appNav).toEqual({ page: 'core', id: 'soul.md' });
  });

  it('classifies an inbox item with no appNav (no dedicated inbox page exists)', () => {
    const ref = classifyReference('_dream_context/inbox/some-capture.md');
    expect(ref.kind).toBe('inbox');
    expect(ref.appNav).toBeUndefined();
  });

  it('classifies an arbitrary project file as "file" with no appNav', () => {
    const ref = classifyReference('src/server/routes/agent-chat.ts');
    expect(ref.kind).toBe('file');
    expect(ref.label).toBe('agent-chat.ts');
    expect(ref.appNav).toBeUndefined();
  });

  it('label is always the basename, regardless of kind', () => {
    expect(classifyReference('a/b/c/readme.md').label).toBe('readme.md');
    expect(classifyReference('lonefile.txt').label).toBe('lonefile.txt');
  });
});

// ─── parseEditDiff ──────────────────────────────────────────────────────────────

describe('parseEditDiff', () => {
  it('an Edit/MultiEdit-shaped input (old_string/new_string) → removed/added line arrays + counts', () => {
    const diff = parseEditDiff({ old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' });
    expect(diff).toEqual({
      removed: ['a', 'b', 'c'],
      added: ['a', 'B', 'c', 'd'],
      removedN: 3,
      addedN: 4,
    });
  });

  it('a Write-shaped input (content only) → wholly added, nothing removed', () => {
    const diff = parseEditDiff({ content: 'line1\nline2' });
    expect(diff).toEqual({ removed: [], added: ['line1', 'line2'], removedN: 0, addedN: 2 });
  });

  it('empty old_string/new_string produce empty arrays, not [""]', () => {
    const diff = parseEditDiff({ old_string: '', new_string: '' });
    expect(diff).toEqual({ removed: [], added: [], removedN: 0, addedN: 0 });
  });

  it('a non-edit tool input (neither shape) → null', () => {
    expect(parseEditDiff({ file_path: '/tmp/x.txt' })).toBeNull();
    expect(parseEditDiff({ command: 'ls -la' })).toBeNull();
  });

  it('a malformed/partial input (not an object, or fields not strings) → null, never throws', () => {
    expect(parseEditDiff(undefined)).toBeNull();
    expect(parseEditDiff(null)).toBeNull();
    expect(parseEditDiff('a string')).toBeNull();
    expect(parseEditDiff({ old_string: 1, new_string: 2 })).toBeNull();
    expect(() => parseEditDiff(42)).not.toThrow();
  });
});

// ─── summarizeSubAgents / subAgentToolUseIds ─────────────────────────────────────

function run(overrides: Partial<SubAgentRun>): SubAgentRun {
  return {
    taskId: 'task-1',
    name: 'Investigate the flaky test',
    status: 'running',
    startedAt: 1000,
    ...overrides,
  };
}

describe('summarizeSubAgents', () => {
  it('empty list → zero running/total, no earliestStart', () => {
    expect(summarizeSubAgents([])).toEqual({ running: 0, total: 0, agents: 0, earliestStart: undefined });
  });

  it('counts running vs total, and reports the earliest startedAt across all runs', () => {
    const runs = [
      run({ taskId: 'a', status: 'running', startedAt: 2000 }),
      run({ taskId: 'b', status: 'completed', startedAt: 1000, endedAt: 1500 }),
      run({ taskId: 'c', status: 'running', startedAt: 3000 }),
    ];
    expect(summarizeSubAgents(runs)).toEqual({ running: 2, total: 3, agents: 3, earliestStart: 1000 });
  });

  it('an all-completed set still reports total + earliestStart with running:0', () => {
    const runs = [run({ status: 'completed', startedAt: 500 }), run({ status: 'error', startedAt: 700 })];
    expect(summarizeSubAgents(runs)).toEqual({ running: 0, total: 2, agents: 2, earliestStart: 500 });
  });
});

// ─── startSubAgentRun (the double-row regression) ────────────────────────────────
//
// Captured live from the CLI on a two-agent BACKGROUND fan-out (the Agent tool's default,
// and what every fan-out skill dispatches): the `background_tasks_changed` roster announces
// each agent BEFORE its own `task_started` frame arrives —
//
//   roster [A] → task_started A → roster [A,B] → task_started B
//
// so the roster arm has already adopted the run by the time the start frame lands. When that
// arm appended blindly, every backgrounded agent got two rows: the adopted one collected all
// the progress (each later frame patches the FIRST match by task_id) and its twin sat at
// "Working…" with only a clock, so a 2-agent fan-out's card read "4 agents running".
// A FOREGROUND agent emits no roster frame at all — which is why this only ever showed up on
// backgrounded dispatches.

describe('startSubAgentRun', () => {
  it('a task_started for a task the roster already adopted MERGES — one row, not two', () => {
    // What the roster arm builds: name + taskType, and nothing else the roster doesn't carry.
    const adopted = run({ taskId: 'a5e40', name: 'Review round-2 plan — security lens', taskType: 'local_agent', startedAt: 1000 });
    const started = run({
      taskId: 'a5e40', name: 'Review round-2 plan — security lens', taskType: 'local_agent',
      toolUseId: 'toolu_01', subagentType: 'goal-plan-reviewer', prompt: 'Review the plan…', startedAt: 1200,
    });
    const next = startSubAgentRun([adopted], started);
    expect(next).toHaveLength(1);
    // Identity comes from the start frame — the roster carries none of these.
    expect(next[0].toolUseId).toBe('toolu_01');
    expect(next[0].subagentType).toBe('goal-plan-reviewer');
    expect(next[0].prompt).toBe('Review the plan…');
    // The clock measures the run, so the EARLIER of the two stamps wins.
    expect(next[0].startedAt).toBe(1000);
  });

  it('a start frame never resets live state a progress frame already wrote', () => {
    const live = run({
      taskId: 'a5e40', taskType: 'local_agent', status: 'completed', endedAt: 9000,
      activity: 'Running grep', summary: 'Found 2 issues', usage: { totalTokens: 79000, toolUses: 13 },
    });
    const next = startSubAgentRun([live], run({ taskId: 'a5e40', subagentType: 'goal-plan-reviewer', startedAt: 5000 }));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      status: 'completed', endedAt: 9000, activity: 'Running grep', summary: 'Found 2 issues',
      subagentType: 'goal-plan-reviewer',
    });
    expect(next[0].usage).toEqual({ totalTokens: 79000, toolUses: 13 });
  });

  it('an unknown task_id is appended — a foreground agent has no roster frame to be adopted by', () => {
    const existing = run({ taskId: 'a5e40' });
    const next = startSubAgentRun([existing], run({ taskId: 'a85d4', name: 'critic lens' }));
    expect(next.map((r) => r.taskId)).toEqual(['a5e40', 'a85d4']);
  });

  it('the whole captured background fan-out reduces to exactly one row per agent', () => {
    // roster [A] → started A → roster [A,B] → started B, with the roster arm's own adopt rule.
    const adopt = (runs: SubAgentRun[], taskId: string, name: string): SubAgentRun[] => (
      runs.some((r) => r.taskId === taskId) ? runs : [...runs, run({ taskId, name, taskType: 'local_agent' })]
    );
    let runs: SubAgentRun[] = [];
    runs = adopt(runs, 'A', 'security lens');
    runs = startSubAgentRun(runs, run({ taskId: 'A', name: 'security lens', taskType: 'local_agent', toolUseId: 'toolu_a', subagentType: 'goal-plan-reviewer' }));
    runs = adopt(runs, 'A', 'security lens');
    runs = adopt(runs, 'B', 'critic lens');
    runs = startSubAgentRun(runs, run({ taskId: 'B', name: 'critic lens', taskType: 'local_agent', toolUseId: 'toolu_b', subagentType: 'goal-plan-reviewer' }));
    expect(summarizeSubAgents(runs)).toMatchObject({ running: 2, total: 2, agents: 2 });
    expect(subAgentToolUseIds(runs)).toEqual(new Set(['toolu_a', 'toolu_b']));
  });
});

describe('subAgentToolUseIds', () => {
  it('returns the set of spawning tool_use_ids, one per run', () => {
    const runs = [
      run({ taskId: 'a', toolUseId: 'toolu_a' }),
      run({ taskId: 'b', toolUseId: 'toolu_b' }),
    ];
    expect(subAgentToolUseIds(runs)).toEqual(new Set(['toolu_a', 'toolu_b']));
  });

  it('runs with no toolUseId yet (task_started arrived, but no tool_use_id on the frame) are excluded, not undefined-keyed', () => {
    const runs = [run({ taskId: 'a', toolUseId: 'toolu_a' }), run({ taskId: 'b', toolUseId: undefined })];
    const ids = subAgentToolUseIds(runs);
    expect(ids).toEqual(new Set(['toolu_a']));
    expect(ids.has(undefined as unknown as string)).toBe(false);
  });

  it('empty input → empty set', () => {
    expect(subAgentToolUseIds([])).toEqual(new Set());
  });
});

// ─── Group collapse (SubAgentCard / BackgroundShellsTray) ────────────────────────
//
// The rule both background-work surfaces share: open while the group is live, collapsed to
// its summary header once every run has landed — and a user's explicit toggle outranks that,
// but only for the phase they made it in. These tests pin the three cases the phase stamp
// exists for; a plain sticky boolean fails one of them whichever way it is set.

describe('runGroupPhase / isRunFinished', () => {
  it('every terminal status counts as finished — including `stopped`, which is its own', () => {
    expect(isRunFinished(run({ status: 'running' }))).toBe(false);
    expect(isRunFinished(run({ status: 'completed' }))).toBe(true);
    expect(isRunFinished(run({ status: 'error' }))).toBe(true);
    expect(isRunFinished(run({ status: 'stopped' }))).toBe(true);
  });

  it('one still-running run keeps the whole group live', () => {
    expect(runGroupPhase([
      run({ taskId: 'a', status: 'completed' }),
      run({ taskId: 'b', status: 'running' }),
    ])).toBe('running');
  });

  it('all-terminal (mixed completed / error / stopped) → done', () => {
    expect(runGroupPhase([
      run({ taskId: 'a', status: 'completed' }),
      run({ taskId: 'b', status: 'error' }),
      run({ taskId: 'c', status: 'stopped' }),
    ])).toBe('done');
  });

  it('an empty group is done (neither surface renders one)', () => {
    expect(runGroupPhase([])).toBe('done');
  });
});

describe('isGroupOpen', () => {
  it('no user toggle: running is open, done is collapsed', () => {
    expect(isGroupOpen('running', null)).toBe(true);
    expect(isGroupOpen('done', null)).toBe(false);
  });

  it('a user who collapsed a RUNNING group keeps it collapsed — no later frame pops it open', () => {
    const toggle = { phase: 'running' as const, open: false };
    expect(isGroupOpen('running', toggle)).toBe(false);
  });

  it('a user who opened a FINISHED group keeps it open — no re-render slams it shut', () => {
    const toggle = { phase: 'done' as const, open: true };
    expect(isGroupOpen('done', toggle)).toBe(true);
  });

  it('the override is released when the group actually crosses running → done, so the auto-collapse still fires', () => {
    // The user merely re-opened a live group (which was already open by default). Pinning
    // that forever would defeat the whole feature.
    expect(isGroupOpen('done', { phase: 'running', open: true })).toBe(false);
  });

  it('a new run in a landed group re-opens it, whatever the user had chosen while it was done', () => {
    expect(isGroupOpen('running', { phase: 'done', open: false })).toBe(true);
  });
});

describe('groupOutcomeNote', () => {
  it('says nothing when everything landed cleanly', () => {
    expect(groupOutcomeNote([run({ status: 'completed' }), run({ taskId: 'b', status: 'completed' })])).toBe('');
  });

  it('names failures and user-killed runs separately — `stopped` is neither a failure nor a success', () => {
    const runs = [
      run({ taskId: 'a', status: 'completed' }),
      run({ taskId: 'b', status: 'error' }),
      run({ taskId: 'c', status: 'error' }),
      run({ taskId: 'd', status: 'stopped' }),
    ];
    expect(groupOutcomeNote(runs)).toBe('2 failed · 1 stopped');
  });

  it('a still-running run contributes nothing to the outcome', () => {
    expect(groupOutcomeNote([run({ status: 'running' })])).toBe('');
  });
});

// ─── Sub-agent row readout (duration / model / tokens / tools) ───────────────────
//
// What the row is allowed to CLAIM. The rule these tests pin: only what the CLI actually
// reported is shown. Duration and token/tool totals ride the `task_*` frames; the model
// arrives separately (`resolvedModel` off the Agent tool's own result) and is simply absent
// until it does; reasoning effort is on no channel at all, so no chip ever claims one.

describe('isAgentRun', () => {
  it('a dispatched sub-agent is an agent', () => {
    expect(isAgentRun(run({ taskType: 'local_agent' }))).toBe(true);
  });

  it('a shell command the CLI auto-backgrounded is NOT an agent (it has no model to show)', () => {
    expect(isAgentRun(run({ taskType: 'local_bash' }))).toBe(false);
  });

  it('a workflow run counts as an agent', () => {
    expect(isAgentRun(run({ taskType: 'local_workflow' }))).toBe(true);
  });

  it('no taskType at all → treated as an agent (under-reporting a real agent is the worse error)', () => {
    expect(isAgentRun(run({ taskType: undefined }))).toBe(true);
  });
});

describe('runDurationMs', () => {
  it("prefers the CLI's own measure over wall-clock — it times the run, not the queue wait", () => {
    const r = run({ startedAt: 1000, usage: { durationMs: 4200 } });
    expect(runDurationMs(r, 99_000)).toBe(4200);
  });

  it('a running task with no reported duration counts from startedAt to now', () => {
    expect(runDurationMs(run({ status: 'running', startedAt: 1000 }), 6000)).toBe(5000);
  });

  it('a finished task is frozen at endedAt and ignores `now` entirely', () => {
    const r = run({ status: 'completed', startedAt: 1000, endedAt: 3500 });
    expect(runDurationMs(r, 99_000)).toBe(2500);
  });

  it('never reports a negative duration (a clock that went backwards reads as 0, not "-3s")', () => {
    expect(runDurationMs(run({ status: 'running', startedAt: 5000 }), 2000)).toBe(0);
  });
});

describe('formatModelName', () => {
  it('drops the 8-digit build stamp and joins the version segments', () => {
    expect(formatModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(formatModelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
  });

  it('handles an id with no build stamp', () => {
    expect(formatModelName('claude-opus-5')).toBe('Opus 5');
    expect(formatModelName('claude-fable-5')).toBe('Fable 5');
  });

  it('an unknown family is returned VERBATIM — never blanked, never relabelled', () => {
    expect(formatModelName('gpt-4o')).toBe('gpt-4o');
    expect(formatModelName('some-internal-build')).toBe('some-internal-build');
  });

  it('empty in, empty out', () => {
    expect(formatModelName('')).toBe('');
    expect(formatModelName('   ')).toBe('');
  });
});

describe('runMetaChips', () => {
  it('duration is the one chip every run always has', () => {
    const r = run({ status: 'running', startedAt: 1000 });
    expect(runMetaChips(r, 13_000)).toEqual(['12s']);
  });

  it('a full sub-agent readout: duration, model, tokens, tool uses — in that order', () => {
    const r = run({
      status: 'completed', startedAt: 1000, endedAt: 13_000,
      model: 'claude-haiku-4-5-20251001',
      usage: { durationMs: 12_000, totalTokens: 2400, toolUses: 3 },
    });
    expect(runMetaChips(r, 99_000)).toEqual(['12s', 'Haiku 4.5', '2.4k tokens', '3 tools']);
  });

  it('a bash task contributes duration alone — no model, no token accounting to claim', () => {
    const r = run({ taskType: 'local_bash', status: 'completed', startedAt: 1000, endedAt: 5000 });
    expect(runMetaChips(r, 99_000)).toEqual(['4.0s']);
  });

  it('a sub-agent whose result has not landed yet shows no model chip rather than a guess', () => {
    const r = run({ status: 'running', startedAt: 1000, usage: { durationMs: 2000, totalTokens: 900 } });
    expect(runMetaChips(r, 99_000)).toEqual(['2.0s', '900 tokens']);
  });

  it('a mid-run model swap is called out, not silently reduced to the last model', () => {
    const r = run({
      status: 'completed', startedAt: 1000, endedAt: 3000,
      model: 'claude-opus-5',
      modelsUsed: ['claude-haiku-4-5-20251001', 'claude-opus-5'],
      usage: { durationMs: 2000 },
    });
    expect(runMetaChips(r, 99_000)).toEqual(['2.0s', 'Opus 5 +1']);
  });

  it('one tool use reads "1 tool", not "1 tools"', () => {
    const r = run({ status: 'completed', startedAt: 1000, usage: { durationMs: 1000, toolUses: 1 } });
    expect(runMetaChips(r, 99_000)).toEqual(['1.0s', '1 tool']);
  });

  it('zero tokens / zero tools are omitted — a chip that reads "0 tools" is noise, not data', () => {
    const r = run({ status: 'completed', startedAt: 1000, usage: { durationMs: 1000, totalTokens: 0, toolUses: 0 } });
    expect(runMetaChips(r, 99_000)).toEqual(['1.0s']);
  });
});

// ─── deriveDiffStartLine (the diff gutter's numbers — never invented) ────────────

describe('deriveDiffStartLine', () => {
  const result = [
    "The file /repo/src/a.ts has been updated. Here's the result of running `cat -n` on a snippet of the edited file:",
    '    59→  const prev = 1',
    '    60→',
    '    61→  const stream = renderStream(msg)',
    '    62→  for await (const t of stream) res.write(t)',
  ].join('\n');

  it('recovers the hunk start line from the cat -n snippet the CLI echoes back', () => {
    expect(deriveDiffStartLine(result, '  const stream = renderStream(msg)')).toBe(61);
  });

  it('matches on trimmed content, so re-indentation in the snippet does not break it', () => {
    expect(deriveDiffStartLine(result, 'const stream = renderStream(msg)')).toBe(61);
  });

  it('accepts tab- and space-separated numbering, not just the arrow form', () => {
    expect(deriveDiffStartLine('  12\tconst a = 1', 'const a = 1')).toBe(12);
    expect(deriveDiffStartLine('  12   const a = 1', 'const a = 1')).toBe(12);
  });

  it('returns undefined rather than guessing when the line is absent from the snippet', () => {
    expect(deriveDiffStartLine(result, 'something that was never written')).toBeUndefined();
  });

  it('returns undefined for a non-string result, a missing/blank added line, or a still-running edit', () => {
    expect(deriveDiffStartLine(undefined, 'const a = 1')).toBeUndefined();
    expect(deriveDiffStartLine({ ok: true }, 'const a = 1')).toBeUndefined();
    expect(deriveDiffStartLine(result, undefined)).toBeUndefined();
    expect(deriveDiffStartLine(result, '   ')).toBeUndefined();
  });
});

// ─── Display formatting ─────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates ~4 chars per token and never returns 0 for non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('ab')).toBe(1);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});

describe('formatTokenCount', () => {
  it('prints exact counts below 1k, singular at one', () => {
    expect(formatTokenCount(1)).toBe('1 token');
    expect(formatTokenCount(0)).toBe('0 tokens');
    expect(formatTokenCount(842)).toBe('842 tokens');
  });

  it('switches to one-decimal k, then whole k once the decimal stops carrying signal', () => {
    expect(formatTokenCount(2400)).toBe('2.4k tokens');
    expect(formatTokenCount(9950)).toBe('10k tokens');
    expect(formatTokenCount(12300)).toBe('12k tokens');
  });

  it('never prints a negative or fractional count', () => {
    expect(formatTokenCount(-5)).toBe('0 tokens');
    expect(formatTokenCount(12.6)).toBe('13 tokens');
  });
});

describe('formatDuration', () => {
  it('uses one decimal under 10s, whole seconds under a minute, m+ss above', () => {
    expect(formatDuration(300)).toBe('0.3s');
    expect(formatDuration(4100)).toBe('4.1s');
    expect(formatDuration(12400)).toBe('12s');
    expect(formatDuration(64000)).toBe('1m 04s');
  });

  it('clamps a negative elapsed (clock skew between start and end) to zero', () => {
    expect(formatDuration(-100)).toBe('0.0s');
  });
});

describe('classifyOutputLine', () => {
  it('tones passing lines green', () => {
    expect(classifyOutputLine('✓ streams tokens without layout shift (28ms)')).toBe('ok');
    expect(classifyOutputLine('  PASS tests/unit/a.test.ts')).toBe('ok');
  });

  it('tones failures red, whether glyph- or word-prefixed, or an inline error:', () => {
    expect(classifyOutputLine('✗ closes code fences on flush')).toBe('error');
    expect(classifyOutputLine('FAILED 2 tests')).toBe('error');
    expect(classifyOutputLine('src/a.ts(3,1): error TS6133: unused')).toBe('error');
  });

  it('dims progress chatter and echoed commands', () => {
    expect(classifyOutputLine('> vitest run agent-chat')).toBe('dim');
    expect(classifyOutputLine('running 6 more…')).toBe('dim');
    expect(classifyOutputLine('# comment')).toBe('dim');
  });

  it('leaves ordinary and blank output plain — nothing is ever hidden', () => {
    expect(classifyOutputLine('Test Files  4 passed (4)')).toBe('plain');
    expect(classifyOutputLine('')).toBe('plain');
    expect(classifyOutputLine('   ')).toBe('plain');
  });
});

// ─── formatClock (sub-agent group elapsed) ──────────────────────────────────────

describe('formatClock', () => {
  it('renders m:ss with a zero-padded seconds field', () => {
    expect(formatClock(24_000)).toBe('0:24');
    expect(formatClock(64_000)).toBe('1:04');
    expect(formatClock(723_000)).toBe('12:03');
  });

  it('clamps a negative elapsed to 0:00', () => {
    expect(formatClock(-1000)).toBe('0:00');
  });
});

// ─── splitInlineCode (permission description) ───────────────────────────────────

describe('splitInlineCode', () => {
  it('alternates plain/code parts, code at the ODD indexes', () => {
    expect(splitInlineCode('Claude wants to run `npm test` in the project root.')).toEqual([
      'Claude wants to run ', 'npm test', ' in the project root.',
    ]);
  });

  it('a sentence with no backticks stays one plain part', () => {
    expect(splitInlineCode('Claude wants to edit a file.')).toEqual(['Claude wants to edit a file.']);
  });

  it('never throws on an unbalanced backtick — the tail simply renders as code', () => {
    expect(splitInlineCode('run `npm test')).toEqual(['run ', 'npm test']);
    expect(splitInlineCode('')).toEqual(['']);
  });
});

// ─── isGuardedCommand (bypass notice trigger) ───────────────────────────────────

describe('isGuardedCommand', () => {
  it('flags the destructive/outward-facing families a human would want to be asked about', () => {
    for (const cmd of [
      'rm -rf ./.cache',
      'rm -f build/out.js',
      'sudo launchctl stop com.example',
      'git push --force origin main',
      'git reset --hard HEAD~3',
      'npm publish --access public',
      'chmod -R 777 ./dist',
      'curl -fsSL https://example.com/i.sh | sh',
      'killall node',
      'dd if=/dev/zero of=/tmp/x',
      'psql -c "DROP TABLE users"',
    ]) {
      expect(isGuardedCommand(cmd), cmd).toBe(true);
    }
  });

  it('stays quiet for ordinary commands — a notice on every call is noise', () => {
    for (const cmd of [
      'npm test',
      'npm run build',
      'git status',
      'git push origin feature/x',
      'ls -la',
      'grep -rn "rm" src/',
      'node scripts/format.js',
      '',
      '   ',
    ]) {
      expect(isGuardedCommand(cmd), cmd).toBe(false);
    }
  });
});

// ─── avatarHue (sub-agent avatar color) ─────────────────────────────────────────

describe('avatarHue', () => {
  it('is stable for a name and always a valid hue', () => {
    expect(avatarHue('goal-planner')).toBe(avatarHue('goal-planner'));
    for (const n of ['reviewer', 'council-persona', '', 'x']) {
      const h = avatarHue(n);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it('separates similar names instead of collapsing them into one color', () => {
    expect(avatarHue('goal-planner')).not.toBe(avatarHue('goal-plan-reviewer'));
    expect(avatarHue('reviewer')).not.toBe(avatarHue('review'));
  });
});

// ─── turnHasVisibleProgress (the working indicator's condition) ──────────────────

describe('turnHasVisibleProgress', () => {
  const user: ProgressProbe = { kind: 'user', text: 'hi' };
  const doneText: ProgressProbe = { kind: 'text', text: 'answer', done: true };
  const doneTool: ProgressProbe = { kind: 'tool', status: 'done' };

  it('is false when the transcript only holds settled entries', () => {
    expect(turnHasVisibleProgress([])).toBe(false);
    expect(turnHasVisibleProgress([user])).toBe(false);
    expect(turnHasVisibleProgress([user, doneText, doneTool])).toBe(false);
  });

  it('sees a streaming text block even before its first delta', () => {
    // AssistantMessage renders an ellipsis bubble for an empty streaming block.
    expect(turnHasVisibleProgress([{ kind: 'text', text: '', done: false }])).toBe(true);
  });

  it('sees a thinking block only once it has text to disclose', () => {
    // ThinkingBlock renders null while the pill would have nothing in it.
    expect(turnHasVisibleProgress([{ kind: 'thinking', text: '', done: false }])).toBe(false);
    expect(turnHasVisibleProgress([{ kind: 'thinking', text: 'hm', done: false }])).toBe(true);
  });

  it('sees a running tool card', () => {
    expect(turnHasVisibleProgress([{ kind: 'tool', status: 'running' }])).toBe(true);
    expect(turnHasVisibleProgress([{ kind: 'tool', status: 'error' }])).toBe(false);
  });

  it('sees a card awaiting an answer', () => {
    expect(turnHasVisibleProgress([user], 1)).toBe(true);
  });
});

// ─── Scroll intent (which way the user asked the transcript to move) ─────────────

describe('scroll intent', () => {
  it('reads a wheel notch\'s direction, in every delta mode (only the sign matters)', () => {
    expect(wheelIntent(-3)).toBe('up');
    expect(wheelIntent(-0.5)).toBe('up');
    expect(wheelIntent(120)).toBe('down');
    // A horizontal-only wheel says nothing about vertical intent — it must neither open the
    // window nor close one a real upward flick just opened.
    expect(wheelIntent(0)).toBeNull();
  });

  it('reads a key\'s direction and ignores everything else', () => {
    for (const k of ['ArrowUp', 'PageUp', 'Home']) expect(keyIntent(k)).toBe('up');
    for (const k of ['ArrowDown', 'PageDown', 'End']) expect(keyIntent(k)).toBe('down');
    // Space is deliberately not a scroll key here: every Space reaching the pane is typing.
    for (const k of [' ', 'a', 'Enter', 'Escape', 'ArrowLeft']) expect(keyIntent(k)).toBeNull();
  });

  it('inverts a touch drag: the finger moving DOWN scrolls the transcript UP', () => {
    expect(touchIntent(24)).toBe('up');
    expect(touchIntent(-24)).toBe('down');
    expect(touchIntent(0)).toBeNull();
  });
});

// ─── nextStickToBottom (transcript auto-scroll) ──────────────────────────────────

describe('nextStickToBottom', () => {
  /** A scroll event with an UPWARD user gesture behind it — wheel/touch/key up, or a live
   *  scrollbar drag (whose direction the metrics supply). */
  const at = (scrollTop: number, prevScrollTop = scrollTop) => ({
    scrollTop, scrollHeight: 2000, clientHeight: 500, prevScrollTop, userDriven: true,
  });
  /** The same event with no upward gesture behind it: the content moved, not the user —
   *  or the user was moving DOWN, which never licenses leaving the bottom. */
  const churn = (scrollTop: number, prevScrollTop = scrollTop) => ({
    ...at(scrollTop, prevScrollTop), userDriven: false,
  });

  it('sticks at the bottom and within the slack window', () => {
    expect(nextStickToBottom(false, at(1500))).toBe(true);
    expect(nextStickToBottom(false, at(1500 - BOTTOM_SLACK))).toBe(true);
  });

  it('unsticks only on an upward move', () => {
    expect(nextStickToBottom(true, at(900, 1400))).toBe(false);
  });

  it('keeps sticking while growing content pushes the bottom away', () => {
    // The scroll event that a token lands in: position unchanged (or moved DOWN by our own
    // programmatic scroll), distance suddenly > slack. This is the case that used to kill
    // auto-scroll mid-answer.
    expect(nextStickToBottom(true, at(900, 900))).toBe(true);
    expect(nextStickToBottom(true, at(1200, 900))).toBe(true);
  });

  it('keeps sticking when a shrink clamps the view backwards mid-stream', () => {
    // Owner report 07-25: a tool card collapses under a pinned view, so the browser clamps
    // `scrollTop` down; the next block renders before that scroll event dispatches, and the
    // handler sees a position both far from the bottom AND lower than last time. Identical
    // to scrolling up — except no one scrolled, so the view must stay pinned.
    expect(nextStickToBottom(true, churn(900, 1400))).toBe(true);
  });

  it('leaves an intentionally parked view parked while content churns', () => {
    expect(nextStickToBottom(false, churn(900, 1400))).toBe(false);
    // Reaching the bottom still re-sticks, however it happened.
    expect(nextStickToBottom(false, churn(1500, 1000))).toBe(true);
  });

  it('re-sticks when the user scrolls back down to the bottom', () => {
    expect(nextStickToBottom(false, at(1490, 1000))).toBe(true);
  });

  it('keeps sticking when the turn ends under a reader who was scrolling DOWN', () => {
    // Owner report 07-25 (second pass): "when the agent finishes, the scroll jumps to
    // somewhere in the middle". Following the answer means flicking DOWN, whose trackpad
    // momentum used to hold the direction-blind gesture window open for the whole turn — so
    // the turn-end collapse's clamp arrived LOOKING user-driven and unpinned the view, and
    // the re-pin never came because scroll events fire before ResizeObserver callbacks.
    // A downward gesture now leaves `userDriven` false, so the clamp is churn again.
    expect(nextStickToBottom(true, churn(900, 1400))).toBe(true);
  });

  it('keeps the previous state for an unmeasurable (detached) scroller', () => {
    const detached = {
      scrollTop: 0, scrollHeight: 0, clientHeight: 0, prevScrollTop: 1400, userDriven: true,
    };
    expect(nextStickToBottom(true, detached)).toBe(true);
    expect(nextStickToBottom(false, detached)).toBe(false);
  });
});

// ─── isAtBottom (the re-measurement a "pinned" view cannot do without) ───────────────
//
// Owner report 07-25: "when the background-agent pin is up the scroll goes too far down, an
// update fixes it, then it slides down again". The mechanism, measured in Chromium: docked
// furniture BELOW the scroller (the background-shells tray, the auto-growing composer) grows,
// the scroller shrinks under a view that was at its maximum, and the maximum moves out from
// under a `scrollTop` that is still perfectly valid — so NO scroll event is dispatched and
// nothing in the event path can notice. A tray growing 186px left 174px of transcript below
// the fold with the view still believing it was pinned (hence no Latest pill to get back with).
// Only a re-measurement of the live geometry finds that, which is what the pin's own
// next-frame re-assert does with this predicate.

describe('isAtBottom', () => {
  it('true at the bottom and anywhere inside the slack window', () => {
    expect(isAtBottom({ scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 })).toBe(true);
    expect(isAtBottom({ scrollTop: 1500 - BOTTOM_SLACK, scrollHeight: 2000, clientHeight: 500 })).toBe(true);
  });

  it('false one pixel past the slack window', () => {
    expect(isAtBottom({ scrollTop: 1499 - BOTTOM_SLACK, scrollHeight: 2000, clientHeight: 500 })).toBe(false);
  });

  it('catches the silent unpin: furniture grew, scrollTop never moved', () => {
    // Same scrollTop before and after; only the scroller's own height changed.
    const before = { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 };
    const after = { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 - 186 };
    expect(isAtBottom(before)).toBe(true);
    expect(isAtBottom(after)).toBe(false);   // 186px of transcript now below the fold
  });

  it('agrees with nextStickToBottom rule 1 — one definition of "at the bottom"', () => {
    for (const scrollTop of [0, 900, 1451, 1452, 1499, 1500]) {
      const m = { scrollTop, scrollHeight: 2000, clientHeight: 500 };
      expect(nextStickToBottom(false, { ...m, prevScrollTop: scrollTop, userDriven: false }))
        .toBe(isAtBottom(m) ? true : false);
    }
  });
});

// ─── nextRestoreTop (what a re-home puts back for a view that is NOT at the bottom) ──

describe('nextRestoreTop', () => {
  const at = (scrollTop: number, prevScrollTop = scrollTop) => ({
    scrollTop, scrollHeight: 2000, clientHeight: 500, prevScrollTop, userDriven: true,
  });
  const churn = (scrollTop: number, prevScrollTop = scrollTop) => ({
    ...at(scrollTop, prevScrollTop), userDriven: false,
  });

  it('follows the reader wherever they scroll', () => {
    expect(nextRestoreTop(0, at(900, 1400))).toBe(900);
    expect(nextRestoreTop(900, at(1200, 900))).toBe(1200);
  });

  it('records a clamp too — the content moved the reader, and that IS where they are now', () => {
    // A tool card collapsing under the view genuinely relocates it; coming back to the
    // pre-clamp offset would scroll past content that no longer exists.
    expect(nextRestoreTop(1400, churn(900, 1400))).toBe(900);
  });

  it('records a deliberate scroll to the very top', () => {
    // The reader asked for the top (upward intent), so 0 is a real reading position.
    expect(nextRestoreTop(900, at(0, 400))).toBe(0);
  });

  it('ignores a jump to 0 that no gesture asked for — that is a re-home reset', () => {
    // `appendChild`-ing the session container into another slot zeroes `scrollTop`. Chromium
    // dispatches no scroll event for it, but an engine that does must not be allowed to
    // overwrite the reader's offset with the reset, or the restore would put back 0.
    expect(nextRestoreTop(1441, churn(0, 1441))).toBe(1441);
  });

  it('keeps the last known offset for an unmeasurable (garaged) scroller', () => {
    // A backgrounded tab's container is detached: 0 there means "cannot be measured", not
    // "the reader is at the top". This is the state the whole restore exists to survive.
    const garaged = {
      scrollTop: 0, scrollHeight: 0, clientHeight: 0, prevScrollTop: 0, userDriven: false,
    };
    expect(nextRestoreTop(1441, garaged)).toBe(1441);
  });

  it('accepts 0 from a scroller whose content simply fits', () => {
    // Short transcript, nothing to scroll: 0 is the only honest offset, and `prevScrollTop`
    // being 0 keeps it out of the re-home guard.
    expect(nextRestoreTop(1441, { scrollTop: 0, scrollHeight: 400, clientHeight: 500, prevScrollTop: 0, userDriven: false })).toBe(0);
  });
});

// ─── Transcript window ──────────────────────────────────────────────────────────
//
// The window is what bounds a ChatPane's mounted DOM (and therefore its memory) no matter
// how long a conversation runs. Its two invariants are asserted directly below, because
// both are silent when broken: a window that slides while UNPINNED yanks content out from
// above a reader mid-sentence, and a window that never slides while PINNED is just the
// unbounded mount it replaced, wearing a slice.

describe('nextFirstShown — pinned (following the conversation)', () => {
  it('keeps exactly the last WINDOW_TAIL entries mounted', () => {
    expect(nextFirstShown(0, { total: 500, pinned: true })).toBe(500 - WINDOW_TAIL);
  });

  it('slides forward as the conversation grows — the memory release valve', () => {
    const a = nextFirstShown(0, { total: 200, pinned: true });
    const b = nextFirstShown(a, { total: 260, pinned: true });
    expect(b - a).toBe(60);
    expect(260 - b).toBe(WINDOW_TAIL);   // still exactly a tail's worth mounted
  });

  it('mounts everything while the conversation is shorter than the window', () => {
    expect(nextFirstShown(0, { total: 0, pinned: true })).toBe(0);
    expect(nextFirstShown(0, { total: 1, pinned: true })).toBe(0);
    expect(nextFirstShown(0, { total: WINDOW_TAIL, pinned: true })).toBe(0);
    expect(nextFirstShown(0, { total: WINDOW_TAIL + 1, pinned: true })).toBe(1);
  });

  it('re-pinning after reading far back shrinks the window straight back to the tail', () => {
    expect(nextFirstShown(0, { total: 400, pinned: true })).toBe(400 - WINDOW_TAIL);
  });
});

describe('nextFirstShown — unpinned (someone is reading)', () => {
  it('FREEZES the head: a growing conversation never moves it forward', () => {
    const head = 120;
    for (const total of [400, 401, 450, 900]) {
      expect(nextFirstShown(head, { total, pinned: false })).toBe(head);
    }
  });

  it('a whole streamed turn cannot take one entry off the top', () => {
    let head = 300;
    for (let total = 500; total < 600; total += 1) {
      head = nextFirstShown(head, { total, pinned: false });
    }
    expect(head).toBe(300);
  });

  it('clamps a rewind (the one thing that shrinks total) to a still-populated window', () => {
    const head = nextFirstShown(300, { total: 120, pinned: false });
    expect(head).toBe(120 - WINDOW_TAIL);
    expect(120 - head).toBe(WINDOW_TAIL);   // never an empty transcript
  });

  it('a rewind past the window size lands at the beginning', () => {
    expect(nextFirstShown(300, { total: 10, pinned: false })).toBe(0);
    expect(nextFirstShown(300, { total: 0, pinned: false })).toBe(0);
  });

  it('is idempotent — the render-time normalization converges in one pass', () => {
    const once = nextFirstShown(77, { total: 500, pinned: false });
    expect(nextFirstShown(once, { total: 500, pinned: false })).toBe(once);
    const pinnedOnce = nextFirstShown(77, { total: 500, pinned: true });
    expect(nextFirstShown(pinnedOnce, { total: 500, pinned: true })).toBe(pinnedOnce);
  });
});

describe('nextFirstShown — reveal', () => {
  it('steps back WINDOW_STEP at a time', () => {
    const start = nextFirstShown(0, { total: 500, pinned: true });
    const a = nextFirstShown(start, { total: 500, pinned: false, reveal: true });
    const b = nextFirstShown(a, { total: 500, pinned: false, reveal: true });
    expect(start - a).toBe(WINDOW_STEP);
    expect(a - b).toBe(WINDOW_STEP);
  });

  it('stops at the beginning instead of going negative', () => {
    expect(nextFirstShown(10, { total: 500, pinned: false, reveal: true })).toBe(0);
    expect(nextFirstShown(0, { total: 500, pinned: false, reveal: true })).toBe(0);
  });

  it('reaches the beginning in ceil(total / WINDOW_STEP) steps and then stays there', () => {
    let head = nextFirstShown(0, { total: 500, pinned: true });
    let steps = 0;
    while (head > 0 && steps < 100) {
      head = nextFirstShown(head, { total: 500, pinned: false, reveal: true });
      steps += 1;
    }
    expect(head).toBe(0);
    expect(steps).toBe(Math.ceil((500 - WINDOW_TAIL) / WINDOW_STEP));
  });

  it('wins over the pinned rule — a reveal came from the user asking', () => {
    const head = nextFirstShown(200, { total: 500, pinned: true, reveal: true });
    expect(head).toBeLessThan(500 - WINDOW_TAIL);
  });
});

describe('splitWindow', () => {
  it('items only (a fresh conversation): the head indexes straight into items', () => {
    expect(splitWindow(0, 100, 60)).toEqual({
      hiddenCount: 60, historyFrom: 0, itemsFrom: 60, showsHistory: false,
    });
  });

  it('history only (a resumed conversation with no new turn yet)', () => {
    expect(splitWindow(100, 0, 60)).toEqual({
      hiddenCount: 60, historyFrom: 60, itemsFrom: 0, showsHistory: true,
    });
  });

  it('straddling: the window starts inside history and runs through into items', () => {
    expect(splitWindow(100, 50, 80)).toEqual({
      hiddenCount: 80, historyFrom: 80, itemsFrom: 0, showsHistory: true,
    });
  });

  it('history entirely below the window: no divider, items sliced from their own offset', () => {
    expect(splitWindow(100, 50, 120)).toEqual({
      hiddenCount: 120, historyFrom: 100, itemsFrom: 20, showsHistory: false,
    });
  });

  it('exactly at the history/items boundary hides all history and no items', () => {
    expect(splitWindow(100, 50, 100)).toEqual({
      hiddenCount: 100, historyFrom: 100, itemsFrom: 0, showsHistory: false,
    });
  });

  it('a zero head shows everything, and the divider only when history exists', () => {
    expect(splitWindow(0, 0, 0)).toEqual({
      hiddenCount: 0, historyFrom: 0, itemsFrom: 0, showsHistory: false,
    });
    expect(splitWindow(3, 4, 0)).toEqual({
      hiddenCount: 0, historyFrom: 0, itemsFrom: 0, showsHistory: true,
    });
  });

  it('clamps a head past the end rather than producing negative slices', () => {
    expect(splitWindow(10, 10, 999)).toEqual({
      hiddenCount: 20, historyFrom: 10, itemsFrom: 10, showsHistory: false,
    });
  });
});

describe('revealScrollCorrection', () => {
  it('corrects by exactly how far the anchor row moved', () => {
    expect(revealScrollCorrection({ anchorTopBefore: 1200, anchorTopAfter: 6200 })).toBe(5000);
  });

  it('IGNORES an append that lands in the same commit — the regression this exists for', () => {
    // One commit prepends 5000px of revealed entries ABOVE the reader and appends a 700px
    // tool card BELOW them (a frame arriving while the reveal was still being scheduled).
    // The anchor moved by the prepend alone; scrollHeight grew by prepend + append, and
    // correcting by THAT would scroll the reader 700px past where they were reading.
    const prepend = 5000;
    const append = 700;
    const byAnchor = revealScrollCorrection({ anchorTopBefore: 1200, anchorTopAfter: 1200 + prepend });
    const byScrollHeight = (40_000 + prepend + append) - 40_000;
    expect(byAnchor).toBe(prepend);
    expect(byScrollHeight).toBe(prepend + append);
    expect(byAnchor).not.toBe(byScrollHeight);
  });

  it('corrects nothing when the anchor did not move, or moved up', () => {
    expect(revealScrollCorrection({ anchorTopBefore: 800, anchorTopAfter: 800 })).toBe(0);
    // Only reachable if something else re-laid the transcript out; guessing would be worse.
    expect(revealScrollCorrection({ anchorTopBefore: 800, anchorTopAfter: 400 })).toBe(0);
  });

  it('ANY surviving row below the prepend gives the same answer — why spare anchors work', () => {
    // The captured anchors all sit below where the revealed entries land, so a prepend moves
    // every one of them by the same amount. That is what lets the layout effect fall through
    // to a spare when its first choice is unmounted by the commit (the combined SubAgentCard
    // is keyed by the earliest suppressed tool item in the window, so a reveal that mounts an
    // older fan-out migrates its key and replaces the node).
    const prepend = 3200;
    for (const before of [1200, 2100, 4800]) {
      expect(revealScrollCorrection({ anchorTopBefore: before, anchorTopAfter: before + prepend }))
        .toBe(prepend);
    }
  });

  it('the "show earlier" button unmounting on the last reveal is absorbed automatically', () => {
    // The final step reveals 900px of entries AND removes the 32px button above them, so the
    // net movement is 868px. An anchor measure reports the net; a height measure would not.
    expect(revealScrollCorrection({ anchorTopBefore: 1000, anchorTopAfter: 1868 })).toBe(868);
  });
});

describe('transcript window ↔ stick-to-bottom', () => {
  it('the reveal prepend, once compensated, does not read as the user scrolling up', () => {
    // Reader parked 200px down; revealing older entries adds 5000px ABOVE them, and the
    // layout effect adds the same 5000 to scrollTop. Both the position and the recorded
    // previous position move together, so the resulting scroll event is a no-op.
    const before = { scrollTop: 200, prevScrollTop: 200 };
    const grown = 5000;
    const m = {
      scrollTop: before.scrollTop + grown,
      scrollHeight: 20_000,
      clientHeight: 600,
      prevScrollTop: before.prevScrollTop + grown,   // written in the SAME layout effect
      userDriven: true,
    };
    expect(nextStickToBottom(false, m)).toBe(false);   // still unpinned, not re-pinned
    expect(nextRestoreTop(before.scrollTop, m)).toBe(m.scrollTop);
  });

  it('an UNcompensated prepend is what would strand the reader — the regression this guards', () => {
    // Same reveal, but without the scrollTop write: prevScrollTop stays at the old value
    // while the content above grew, so the reading position is recorded 5000px too high.
    const m = {
      scrollTop: 200, scrollHeight: 20_000, clientHeight: 600, prevScrollTop: 200, userDriven: true,
    };
    expect(nextRestoreTop(5200, m)).toBe(200);
  });
});

// ─── clampLines (bounded card bodies) ───────────────────────────────────────────

describe('clampLines', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);

  it('returns short input whole, with nothing hidden and an empty tail', () => {
    expect(clampLines(lines(5), 20, 20)).toEqual({ head: lines(5), tail: [], hidden: 0 });
    expect(clampLines([], 20, 20)).toEqual({ head: [], tail: [], hidden: 0 });
  });

  it('does not clamp at exactly head + tail', () => {
    const input = lines(40);
    expect(clampLines(input, 20, 20)).toEqual({ head: input, tail: [], hidden: 0 });
  });

  it('clamps one line past the budget', () => {
    const r = clampLines(lines(41), 20, 20);
    expect(r.hidden).toBe(1);
    expect(r.head).toHaveLength(20);
    expect(r.tail).toHaveLength(20);
  });

  it('keeps BOTH ends — a shell failure lives at the end, its command at the start', () => {
    const r = clampLines(lines(1000), 20, 20);
    expect(r.head[0]).toBe('line 0');
    expect(r.head.at(-1)).toBe('line 19');
    expect(r.tail[0]).toBe('line 980');
    expect(r.tail.at(-1)).toBe('line 999');
    expect(r.hidden).toBe(960);
  });

  it('accounts for every line: head + tail + hidden === input length', () => {
    for (const n of [0, 1, 39, 40, 41, 500, 100_000]) {
      const r = clampLines(lines(n), 20, 20);
      expect(r.head.length + r.tail.length + r.hidden).toBe(n);
    }
  });

  it('head-only (tail 0) is a plain truncation', () => {
    const r = clampLines(lines(100), 10, 0);
    expect(r.head).toHaveLength(10);
    expect(r.tail).toEqual([]);
    expect(r.hidden).toBe(90);
  });

  it('treats negative budgets as zero rather than producing reversed slices', () => {
    const r = clampLines(lines(10), -5, -5);
    expect(r).toEqual({ head: [], tail: [], hidden: 10 });
  });
});
