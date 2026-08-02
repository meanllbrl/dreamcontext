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
  isAgentRun, isDispatchedAgent, isBackgroundShell, isHeadlessAgentShell, looksLikeHeadlessClaude,
  bashCommandFor, runDurationMs, formatModelName, runMetaChips,
  isRunFinished, runGroupPhase, isGroupOpen, groupOutcomeNote, startSubAgentRun,
  nextFirstShown, splitWindow, anchorHoldCorrection, WINDOW_TAIL, WINDOW_STEP, clampLines,
  rememberMediaBox, knownMediaBox, shouldAutoReveal, WINDOW_REVEAL_PX, TRIM_SLACK,
  remainingSettleMs, SCROLL_SETTLE_MS,
  countCards, headForCards, WINDOW_TAIL_CARDS, WINDOW_STEP_CARDS, WINDOW_MAX_ENTRIES,
  promptHistory, canRecallHistory, stepHistory, NO_HISTORY_NAV,
  pathChipLabel, toolSubject, isDreamcontextSkill,
  segmentToolRuns, toolRunPhase, toolRunKeyItem, summarizeToolRun, toolRunHeadline, MIN_TOOL_RUN,
  condenseCommand, COMMAND_LABEL_CAP,
  type SubAgentRun, type ProgressProbe, type HistoryNav, type AutoRevealMetrics,
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

  it('a headless `claude` run does NOT suppress its own Bash card, even though it renders as an agent', () => {
    // The regression this guards: promoting these runs into the sub-agent card made them
    // pass `isAgentRun`, and suppression keyed off that predicate would have hidden the
    // `Bash` tool card whose id this is — erasing the command the user most wants to read.
    const runs = [
      run({ taskId: 'a', toolUseId: 'toolu_agent', taskType: 'local_agent' }),
      run({ taskId: 'b', toolUseId: 'toolu_bash', taskType: 'local_bash', command: 'claude -p "go"' }),
    ];
    expect(isAgentRun(runs[1])).toBe(true);
    expect(subAgentToolUseIds(runs)).toEqual(new Set(['toolu_agent']));
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

  it('a plain shell command the CLI auto-backgrounded is NOT an agent (it has no model to show)', () => {
    expect(isAgentRun(run({ taskType: 'local_bash', command: 'npm test' }))).toBe(false);
  });

  it('a workflow run counts as an agent', () => {
    expect(isAgentRun(run({ taskType: 'local_workflow' }))).toBe(true);
  });

  it('no taskType at all → treated as an agent (under-reporting a real agent is the worse error)', () => {
    expect(isAgentRun(run({ taskType: undefined }))).toBe(true);
  });

  it('a backgrounded headless `claude` IS an agent, even though the CLI calls it local_bash', () => {
    const r = run({ taskType: 'local_bash', command: 'claude -p "review the diff" --output-format json' });
    expect(isAgentRun(r)).toBe(true);
    expect(isHeadlessAgentShell(r)).toBe(true);
    // …and is therefore NOT the tray's business any more.
    expect(isBackgroundShell(r)).toBe(false);
  });

  it('a local_bash run whose command was never resolved stays a shell (no command → no claim)', () => {
    const r = run({ taskType: 'local_bash', command: undefined });
    expect(isAgentRun(r)).toBe(false);
    expect(isBackgroundShell(r)).toBe(true);
  });

  it('isDispatchedAgent is narrower than isAgentRun: a headless run is an agent but was NOT dispatched', () => {
    const r = run({ taskType: 'local_bash', command: 'claude -p "go"' });
    expect(isAgentRun(r)).toBe(true);
    expect(isDispatchedAgent(r)).toBe(false);
  });
});

// ─── looksLikeHeadlessClaude (owner report 08-01) ────────────────────────────────
//
// The whole promotion hangs on this one predicate, and it is parsed rather than pattern-
// matched precisely because the false positives are the interesting cases: a command that
// merely MENTIONS `claude -p` must stay a shell, since the tray is the only surface that
// offers it a Stop.

describe('looksLikeHeadlessClaude', () => {
  it('recognizes the invocations this project actually spawns', () => {
    expect(looksLikeHeadlessClaude('claude -p "<brief>" --model opus --output-format json')).toBe(true);
    expect(looksLikeHeadlessClaude('claude -p --resume abc123 "round 2 delta"')).toBe(true);
    expect(looksLikeHeadlessClaude('claude -p --resume abc --fork-session "task T3"')).toBe(true);
    expect(looksLikeHeadlessClaude('claude --print "summarize" < /dev/null')).toBe(true);
    expect(looksLikeHeadlessClaude('claude -p --input-format stream-json --output-format stream-json')).toBe(true);
    expect(looksLikeHeadlessClaude('claude --permission-mode bypassPermissions -p "go"')).toBe(true);
  });

  it('sees through env assignments, wrappers, and a path-qualified binary', () => {
    expect(looksLikeHeadlessClaude('ANTHROPIC_MODEL=opus claude -p "go"')).toBe(true);
    expect(looksLikeHeadlessClaude('nohup claude -p "go" &')).toBe(true);
    expect(looksLikeHeadlessClaude('npx -y claude -p "go"')).toBe(true);
    expect(looksLikeHeadlessClaude('~/.local/bin/claude -p "go"')).toBe(true);
    expect(looksLikeHeadlessClaude('/usr/local/bin/claude --print "go"')).toBe(true);
  });

  it('finds it after a pipe — the prompt is often fed in on stdin', () => {
    expect(looksLikeHeadlessClaude('cat brief.md | claude -p --output-format json')).toBe(true);
    expect(looksLikeHeadlessClaude('cd /tmp && claude -p "go"')).toBe(true);
  });

  it('a command that only MENTIONS the invocation is still a shell', () => {
    expect(looksLikeHeadlessClaude('grep -rn "claude -p" src/')).toBe(false);
    expect(looksLikeHeadlessClaude('echo "run claude -p later"')).toBe(false);
    expect(looksLikeHeadlessClaude('git commit -m "use claude -p; fix"')).toBe(false);
  });

  it('interactive or non-agent `claude` invocations are not headless runs', () => {
    expect(looksLikeHeadlessClaude('claude')).toBe(false);
    expect(looksLikeHeadlessClaude('claude --version')).toBe(false);
    expect(looksLikeHeadlessClaude('claude mcp list')).toBe(false);
    // `--resume` alone is a modifier on either mode, not a headless marker.
    expect(looksLikeHeadlessClaude('claude --resume abc123')).toBe(false);
  });

  it('ordinary shells stay shells, and a missing command is never a match', () => {
    expect(looksLikeHeadlessClaude('npm test')).toBe(false);
    expect(looksLikeHeadlessClaude('')).toBe(false);
    expect(looksLikeHeadlessClaude(undefined)).toBe(false);
  });
});

// ─── bashCommandFor ──────────────────────────────────────────────────────────────
//
// The step the whole promotion depends on: no `task_*` frame carries the command, so a run
// is only ever recognized as headless if this recovers it off the spawning `Bash` call.

describe('bashCommandFor', () => {
  const tool = (over: Partial<{ toolUseId: string; name: string; input: unknown }>) => ({
    kind: 'tool', toolUseId: 'toolu_x', name: 'Bash', input: {}, ...over,
  });
  const text = { kind: 'text', text: 'claude -p "not a tool call"' };

  it('resolves by tool_use_id — the exact link the task_started frame provides', () => {
    const items = [
      text,
      tool({ toolUseId: 'toolu_a', input: { command: 'npm test' } }),
      tool({ toolUseId: 'toolu_b', input: { command: 'claude -p "go"' } }),
    ];
    expect(bashCommandFor([items], 'toolu_b')).toBe('claude -p "go"');
  });

  it('falls back to the Bash description for a roster-adopted run, which has no tool_use_id', () => {
    const items = [
      tool({ toolUseId: 'toolu_a', input: { command: 'npm test', description: 'Run the tests' } }),
      tool({ toolUseId: 'toolu_b', input: { command: 'claude -p "audit"', description: 'Audit the diff' } }),
    ];
    expect(bashCommandFor([items], undefined, 'Audit the diff')).toBe('claude -p "audit"');
  });

  it('searches items before history, and each list newest-first — a re-run resolves to the latest', () => {
    const history = [tool({ toolUseId: 'toolu_old', input: { command: 'claude -p "v1"', description: 'Review' } })];
    const items = [
      tool({ toolUseId: 'toolu_new1', input: { command: 'claude -p "v2"', description: 'Review' } }),
      tool({ toolUseId: 'toolu_new2', input: { command: 'claude -p "v3"', description: 'Review' } }),
    ];
    expect(bashCommandFor([items, history], undefined, 'Review')).toBe('claude -p "v3"');
  });

  it('an unknown id with no description falls through to undefined rather than the wrong command', () => {
    const items = [tool({ toolUseId: 'toolu_a', input: { command: 'claude -p "go"' } })];
    expect(bashCommandFor([items], 'toolu_missing')).toBeUndefined();
    expect(bashCommandFor([items], undefined, undefined)).toBeUndefined();
  });

  it('a non-tool item is never mistaken for a command, however it reads', () => {
    expect(bashCommandFor([[text]], undefined, 'anything')).toBeUndefined();
  });

  it('a tool call with no command in its input (Read, Edit) contributes nothing', () => {
    const items = [tool({ toolUseId: 'toolu_a', name: 'Read', input: { file_path: '/tmp/x' } })];
    expect(bashCommandFor([items], 'toolu_a')).toBeUndefined();
  });
});

// ─── Captured end-to-end: a real backgrounded `claude -p` ────────────────────────
//
// Frames below are VERBATIM from two live CLI spikes (2026-08-01, `claude -p --output-format
// stream-json --verbose`), one backgrounding `sleep 8` and one backgrounding a nested
// `claude -p`. They pin the two facts the whole promotion rests on, neither of which is
// documented anywhere and both of which would silently break it:
//
//   1. ORDER — the `Bash` tool_use frame lands BEFORE `task_started` (13 → 15 → 16 and
//      15 → 17 → 18 in the two captures), so the tool item is always already in the
//      transcript when the reducer goes looking for its command.
//   2. `task_started.tool_use_id` is exactly the `Bash` call's own id.
//
// The second capture also produced the surprise the `name` fallback exists for: that Bash
// call carried NO `description`, and the CLI used the COMMAND ITSELF as the task description.

describe('captured: a backgrounded `claude -p` reduces to a headless agent run', () => {
  // Spike 2, frame 15 — note the absent `description`.
  const BASH_TOOL_USE = {
    kind: 'tool',
    toolUseId: 'toolu_01C8ibKVzKw5ZUMc28b5QPuh',
    name: 'Bash',
    input: { command: "claude -p 'reply with the word hi only' --output-format json .", run_in_background: true },
  };
  // Spike 2, frame 18, as `fromTaskStarted` maps it.
  const TASK_STARTED = {
    taskId: 'b6do09grx',
    toolUseId: 'toolu_01C8ibKVzKw5ZUMc28b5QPuh',
    description: "claude -p 'reply with the word hi only' --output-format json .",
    taskType: 'local_bash',
  };

  it('resolves the command off the spawning Bash call and classifies the run as an agent', () => {
    const command = bashCommandFor([[BASH_TOOL_USE]], TASK_STARTED.toolUseId, TASK_STARTED.description);
    expect(command).toBe("claude -p 'reply with the word hi only' --output-format json .");
    const r = run({ taskId: TASK_STARTED.taskId, name: TASK_STARTED.description, taskType: 'local_bash', command });
    expect(isHeadlessAgentShell(r)).toBe(true);
    expect(isAgentRun(r)).toBe(true);
    expect(isBackgroundShell(r)).toBe(false);
    // Its Bash card must survive — the command is the point.
    expect(subAgentToolUseIds([r])).toEqual(new Set());
  });

  it('classifies from the name alone when the command could not be correlated', () => {
    // The roster-adopted / resumed case: no tool_use_id, nothing in the transcript to match.
    // The CLI named the task after its command, so the run is still recognized.
    const r = run({ taskId: TASK_STARTED.taskId, name: TASK_STARTED.description, taskType: 'local_bash', command: undefined });
    expect(isHeadlessAgentShell(r)).toBe(true);
  });

  it('a PROSE description naming claude is not an invocation, and stays a shell', () => {
    const r = run({ name: 'Run headless claude -p for the audit', taskType: 'local_bash', command: undefined });
    expect(isHeadlessAgentShell(r)).toBe(false);
    expect(isBackgroundShell(r)).toBe(true);
  });

  it('the `sleep 8` capture — a described, non-claude shell — is untouched by any of this', () => {
    // Spike 1, frames 13/15/16: the Bash call DID carry a description, and the roster echoed it.
    const items = [{
      kind: 'tool',
      toolUseId: 'toolu_01B8kcNw93fSALQKjMYAwhKP',
      name: 'Bash',
      input: { command: 'sleep 8', description: 'Sleep for 8 seconds in the background', run_in_background: true },
    }];
    const command = bashCommandFor([items], 'toolu_01B8kcNw93fSALQKjMYAwhKP', 'Sleep for 8 seconds in the background');
    expect(command).toBe('sleep 8');
    const r = run({ taskId: 'b3tcflkjd', name: 'Sleep for 8 seconds in the background', taskType: 'local_bash', command });
    expect(isBackgroundShell(r)).toBe(true);
    expect(isAgentRun(r)).toBe(false);
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
  it('snaps to the last WINDOW_TAIL entries once it lags by TRIM_SLACK', () => {
    expect(nextFirstShown(0, { total: 500, pinned: true })).toBe(500 - WINDOW_TAIL);
  });

  it('slides forward as the conversation grows — the memory release valve', () => {
    const a = nextFirstShown(0, { total: 200, pinned: true });
    const b = nextFirstShown(a, { total: 260, pinned: true });
    expect(b - a).toBe(60);
    expect(260 - b).toBe(WINDOW_TAIL);   // still exactly a tail's worth mounted
  });

  it('holds still while the lag is inside TRIM_SLACK — no per-token unmount churn', () => {
    // One unmount per streamed frame shrank scrollHeight every event: clamp, re-pin,
    // scrollbar wobbling on every token (part of the 08-01 flicker report). The window
    // sheds a chunk at once instead, so mounted rows drift WINDOW_TAIL..WINDOW_TAIL+SLACK.
    const start = nextFirstShown(0, { total: 500, pinned: true });
    let head = start;
    for (let total = 501; total < 500 + TRIM_SLACK; total += 1) {
      head = nextFirstShown(head, { total, pinned: true });
      expect(head).toBe(start);   // frozen while the lag is under the slack
    }
    head = nextFirstShown(head, { total: 500 + TRIM_SLACK, pinned: true });
    expect(head).toBe(500 + TRIM_SLACK - WINDOW_TAIL);   // then one whole-chunk snap
  });

  it('never mounts more than WINDOW_TAIL + TRIM_SLACK while pinned', () => {
    let head = 0;
    for (let total = 0; total <= 2000; total += 1) {
      head = nextFirstShown(head, { total, pinned: true });
      expect(total - head).toBeLessThanOrEqual(WINDOW_TAIL + TRIM_SLACK);
    }
  });

  it('mounts everything while the conversation is shorter than the window (plus its slack)', () => {
    expect(nextFirstShown(0, { total: 0, pinned: true })).toBe(0);
    expect(nextFirstShown(0, { total: 1, pinned: true })).toBe(0);
    expect(nextFirstShown(0, { total: WINDOW_TAIL, pinned: true })).toBe(0);
    // One entry past the tail is inside the slack: nothing is shed for it.
    expect(nextFirstShown(0, { total: WINDOW_TAIL + 1, pinned: true })).toBe(0);
    expect(nextFirstShown(0, { total: WINDOW_TAIL + TRIM_SLACK, pinned: true })).toBe(TRIM_SLACK);
  });

  it('re-pinning after reading far back shrinks the window straight back to the tail', () => {
    expect(nextFirstShown(0, { total: 400, pinned: true })).toBe(400 - WINDOW_TAIL);
  });

  it('a rewind past the head still lands on a populated tail, never an over-trimmed one', () => {
    // prev beyond the new tail clamps back to the tail (rule 4) — the slack must not read
    // that as "lagging by less than TRIM_SLACK is fine" and leave fewer than a tail mounted.
    expect(nextFirstShown(300, { total: 120, pinned: true })).toBe(120 - WINDOW_TAIL);
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

describe('anchorHoldCorrection', () => {
  it('corrects by exactly how far the anchor row moved', () => {
    expect(anchorHoldCorrection({ anchorTopBefore: 1200, anchorTopAfter: 6200 })).toBe(5000);
  });

  it('IGNORES an append that lands in the same commit — the regression this exists for', () => {
    // One commit prepends 5000px of revealed entries ABOVE the reader and appends a 700px
    // tool card BELOW them (a frame arriving while the reveal was still being scheduled).
    // The anchor moved by the prepend alone; scrollHeight grew by prepend + append, and
    // correcting by THAT would scroll the reader 700px past where they were reading.
    const prepend = 5000;
    const append = 700;
    const byAnchor = anchorHoldCorrection({ anchorTopBefore: 1200, anchorTopAfter: 1200 + prepend });
    const byScrollHeight = (40_000 + prepend + append) - 40_000;
    expect(byAnchor).toBe(prepend);
    expect(byScrollHeight).toBe(prepend + append);
    expect(byAnchor).not.toBe(byScrollHeight);
  });

  it('corrects nothing when the anchor did not move', () => {
    expect(anchorHoldCorrection({ anchorTopBefore: 800, anchorTopAfter: 800 })).toBe(0);
  });

  it('follows the row UP as well as down — the half a reveal-only correction never saw', () => {
    // The hold outlives the reveal now, so it meets the other direction for real: a tool card
    // above the reader collapsing to its done card, an image failing and shrinking to its alt
    // text, a rewind dropping rows above them. Holding still means following the row up too;
    // clamping at zero (which the reveal-only correction did, because a reveal can only ever
    // ADD above) would leave the reader sitting exactly that far down the page from where
    // they were.
    expect(anchorHoldCorrection({ anchorTopBefore: 800, anchorTopAfter: 400 })).toBe(-400);
    expect(anchorHoldCorrection({ anchorTopBefore: 6200, anchorTopAfter: 6060 })).toBe(-140);
  });

  it('ignores sub-pixel wobble, so a stream does not write scrollTop every frame', () => {
    // Zoom and fractional layout make an untouched row's measured offset drift by fractions
    // of a pixel. Correcting for those is invisible and endless.
    expect(anchorHoldCorrection({ anchorTopBefore: 1000, anchorTopAfter: 1000.4 })).toBe(0);
    expect(anchorHoldCorrection({ anchorTopBefore: 1000, anchorTopAfter: 999.6 })).toBe(0);
    expect(anchorHoldCorrection({ anchorTopBefore: 1000, anchorTopAfter: 1000.5 })).toBe(0.5);
  });

  it('is idempotent once the hold is re-measured — why two callers cannot double-correct', () => {
    // The reveal's layout effect and the ResizeObserver both fire for the same commit. The
    // first applies the delta and re-measures the anchor against the layout it produced; the
    // second therefore sees before === after and does nothing. Native `overflow-anchor` is off
    // for exactly this reason (it would have been a third, uncoordinated corrector).
    const before = 1200;
    const after = 1200 + 5000;
    expect(anchorHoldCorrection({ anchorTopBefore: before, anchorTopAfter: after })).toBe(5000);
    expect(anchorHoldCorrection({ anchorTopBefore: after, anchorTopAfter: after })).toBe(0);
  });

  it('ANY surviving row below the prepend gives the same answer — why spare anchors work', () => {
    // The captured anchors all sit below where the revealed entries land, so a prepend moves
    // every one of them by the same amount. That is what lets the layout effect fall through
    // to a spare when its first choice is unmounted by the commit (the combined SubAgentCard
    // is keyed by the earliest suppressed tool item in the window, so a reveal that mounts an
    // older fan-out migrates its key and replaces the node).
    const prepend = 3200;
    for (const before of [1200, 2100, 4800]) {
      expect(anchorHoldCorrection({ anchorTopBefore: before, anchorTopAfter: before + prepend }))
        .toBe(prepend);
    }
  });

  it('the "show earlier" button unmounting on the last reveal is absorbed automatically', () => {
    // The final step reveals 900px of entries AND removes the 32px button above them, so the
    // net movement is 868px. An anchor measure reports the net; a height measure would not.
    expect(anchorHoldCorrection({ anchorTopBefore: 1000, anchorTopAfter: 1868 })).toBe(868);
  });

  it('an image decoding LONG after the reveal is the same measurement — the 07-28 report', () => {
    // The reveal itself was already corrected: 40 entries prepended, anchor moved 5000px,
    // scrollTop pushed back by 5000. Three hundred milliseconds later two images inside those
    // revealed entries finish decoding and grow 720px between them, above the reader. Nothing
    // used to be holding by then (the anchor was released at the end of the reveal commit), so
    // the reader travelled 720px down the transcript for no reason they could see. A held
    // anchor measures it as the same kind of movement and absorbs it the same way.
    expect(anchorHoldCorrection({ anchorTopBefore: 6200, anchorTopAfter: 6920 })).toBe(720);
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

// ─── Prompt history (composer ↑/↓ recall) ───────────────────────────────────────

const userMsg = (text: string) => ({ kind: 'user', text });
const assistantMsg = (text: string) => ({ kind: 'text', text });

describe('promptHistory', () => {
  it('returns this conversation\'s prompts NEWEST first', () => {
    const items = [userMsg('one'), assistantMsg('reply'), userMsg('two'), userMsg('three')];
    expect(promptHistory([], items)).toEqual(['three', 'two', 'one']);
  });

  it('covers a RESUMED conversation: replayed history before live items', () => {
    // The whole point of resuming is that the earlier turns are yours to re-run, and a resumed
    // chat keeps them in `history`, separate from `items`.
    expect(promptHistory([userMsg('old')], [userMsg('new')])).toEqual(['new', 'old']);
  });

  it('ignores everything that is not a user message', () => {
    const items = [assistantMsg('a'), { kind: 'tool', text: 'Bash' }, { kind: 'thinking', text: 'hm' }];
    expect(promptHistory([], items)).toEqual([]);
  });

  it('drops empty/whitespace prompts and trims what it keeps', () => {
    expect(promptHistory([], [userMsg('  spaced  '), userMsg('   '), { kind: 'user' }]))
      .toEqual(['spaced']);
  });

  it('collapses CONSECUTIVE duplicates — three "npm test"s cost one ↑, not three', () => {
    const items = [userMsg('npm test'), userMsg('npm test'), userMsg('npm test')];
    expect(promptHistory([], items)).toEqual(['npm test']);
  });

  it('keeps NON-adjacent duplicates: the positions between them are what make the walk legible', () => {
    const items = [userMsg('build'), userMsg('fix'), userMsg('build')];
    expect(promptHistory([], items)).toEqual(['build', 'fix', 'build']);
  });

  it('collapses a duplicate that straddles the history/items seam', () => {
    expect(promptHistory([userMsg('go')], [userMsg('go')])).toEqual(['go']);
  });
});

describe('canRecallHistory', () => {
  it('recalls on an empty draft', () => {
    expect(canRecallHistory('', 0, 0, NO_HISTORY_NAV)).toBe(true);
  });

  it('recalls from the very start of a non-empty draft (the shell rule)', () => {
    expect(canRecallHistory('half typed', 0, 0, NO_HISTORY_NAV)).toBe(true);
  });

  it('does NOT hijack ↑ mid-draft — losing what you just typed is unrecoverable', () => {
    expect(canRecallHistory('half typed', 4, 4, NO_HISTORY_NAV)).toBe(false);
    expect(canRecallHistory('line one\nline two', 12, 12, NO_HISTORY_NAV)).toBe(false);
  });

  it('does not recall while text is selected from position 0 (that is a shift-select)', () => {
    expect(canRecallHistory('half typed', 0, 4, NO_HISTORY_NAV)).toBe(false);
  });

  it('always recalls once a walk is in progress, wherever the caret sits', () => {
    const walking: HistoryNav = { index: 0, stash: '' };
    expect(canRecallHistory('a recalled prompt', 17, 17, walking)).toBe(true);
  });
});

describe('stepHistory', () => {
  const entries = ['newest', 'middle', 'oldest'];

  it('the first ↑ recalls the newest prompt and stashes the draft', () => {
    expect(stepHistory(entries, NO_HISTORY_NAV, 'back', 'wip')).toEqual({
      nav: { index: 0, stash: 'wip' }, text: 'newest',
    });
  });

  it('walks back through every entry, keeping the original stash', () => {
    let nav: HistoryNav = NO_HISTORY_NAV;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const step = stepHistory(entries, nav, 'back', 'wip');
      expect(step).not.toBeNull();
      nav = step!.nav;
      seen.push(step!.text);
    }
    expect(seen).toEqual(entries);
    expect(nav).toEqual({ index: 2, stash: 'wip' });
  });

  it('returns null at the oldest entry so the keystroke stays the textarea\'s', () => {
    expect(stepHistory(entries, { index: 2, stash: 'wip' }, 'back', 'oldest')).toBeNull();
  });

  it('returns null for ↑ with no history at all', () => {
    expect(stepHistory([], NO_HISTORY_NAV, 'back', '')).toBeNull();
  });

  it('↓ while not browsing is not a history key at all', () => {
    expect(stepHistory(entries, NO_HISTORY_NAV, 'forward', 'wip')).toBeNull();
  });

  it('↓ walks forward towards the newest entry', () => {
    expect(stepHistory(entries, { index: 2, stash: 'wip' }, 'forward', 'oldest')).toEqual({
      nav: { index: 1, stash: 'wip' }, text: 'middle',
    });
  });

  it('stepping forward past the newest restores the stashed draft VERBATIM and ends the walk', () => {
    expect(stepHistory(entries, { index: 0, stash: 'half typed thing' }, 'forward', 'newest')).toEqual({
      nav: NO_HISTORY_NAV, text: 'half typed thing',
    });
  });

  it('restores an EMPTY stash (started from a blank composer) rather than leaving the prompt', () => {
    expect(stepHistory(entries, { index: 0, stash: '' }, 'forward', 'newest')).toEqual({
      nav: NO_HISTORY_NAV, text: '',
    });
  });

  it('a fresh walk after a restore re-stashes whatever is in the box now', () => {
    const restored = stepHistory(entries, { index: 0, stash: 'first draft' }, 'forward', 'newest')!;
    expect(stepHistory(entries, restored.nav, 'back', 'second draft')).toEqual({
      nav: { index: 0, stash: 'second draft' }, text: 'newest',
    });
  });
});

// ─── remembered image boxes ─────────────────────────────────────────────────────
//
// The cache that stops a revealed block growing under a reader who has scrolled up: an
// `<img>` with no width/height is 0px tall until its bits land, so ChatPane's hold measures
// the prepend without it and the image's real height arrives as a shove a frame later.
// Replaying a known natural size reserves the box up front. (Measured: an unreserved image
// in this transcript's CSS goes 2px → 420px on load; a reserved one is 420px throughout.)

describe('remembered image boxes', () => {
  it('an image never displayed has no remembered box', () => {
    expect(knownMediaBox('never/seen/at/all.png')).toBeNull();
  });

  it('remembers a natural size and replays it for the next element built for that path', () => {
    rememberMediaBox('shots/a.png', 1200, 800);
    expect(knownMediaBox('shots/a.png')).toEqual({ w: 1200, h: 800 });
  });

  it('a file that changed shape overwrites the stale box rather than keeping it', () => {
    rememberMediaBox('shots/b.png', 800, 600);
    rememberMediaBox('shots/b.png', 640, 640);
    expect(knownMediaBox('shots/b.png')).toEqual({ w: 640, h: 640 });
  });

  it('refuses a size that is not an aspect ratio — a NaN box would reserve unpredictable height', () => {
    for (const [w, h] of [[0, 100], [100, 0], [-5, 5], [Number.NaN, 10], [10, Number.POSITIVE_INFINITY]]) {
      rememberMediaBox('shots/bad.png', w, h);
      expect(knownMediaBox('shots/bad.png')).toBeNull();
    }
  });

  it('a decode that reports 0x0 (a failed image) never displaces a good remembered box', () => {
    rememberMediaBox('shots/c.png', 900, 300);
    rememberMediaBox('shots/c.png', 0, 0);
    expect(knownMediaBox('shots/c.png')).toEqual({ w: 900, h: 300 });
  });

  it('is bounded — the oldest box goes, not the newest arrival', () => {
    rememberMediaBox('evict/oldest.png', 10, 10);
    for (let i = 0; i < 420; i += 1) rememberMediaBox(`evict/filler-${i}.png`, 30, 40);
    expect(knownMediaBox('evict/oldest.png')).toBeNull();
    expect(knownMediaBox('evict/filler-419.png')).toEqual({ w: 30, h: 40 });
  });

  it('re-seeing an UNCHANGED image refreshes its place in the queue', () => {
    // Sizes are re-reported on every mount, so an unchanged report is the common case — and
    // it is exactly the signal that this image is still being looked at. Without the refresh
    // a screenshot the reader keeps scrolling past is evicted by images they passed once,
    // and the reveal it is mounted in grows under them again.
    rememberMediaBox('lru/kept.png', 20, 20);
    for (let i = 0; i < 399; i += 1) rememberMediaBox(`lru/fill-a-${i}.png`, 30, 40);
    expect(knownMediaBox('lru/kept.png')).toEqual({ w: 20, h: 20 }); // at the cap, still in
    rememberMediaBox('lru/kept.png', 20, 20);                        // same size — a refresh
    for (let i = 0; i < 300; i += 1) rememberMediaBox(`lru/fill-b-${i}.png`, 30, 40);
    expect(knownMediaBox('lru/kept.png')).toEqual({ w: 20, h: 20 });
  });
});

// ─── shouldAutoReveal ───────────────────────────────────────────────────────────
//
// The gate that stopped the transcript teleporting while it loaded history. `userDriven` was
// the whole condition, and a scrollbar drag is the case where that is most true and least
// useful: the browser keeps deriving `scrollTop` from the thumb, so the hold's correction is
// overwritten on the next drag update and the view snaps back to the ceiling — which reads as
// user-driven again, and reveals again. Traced on a real 500-item transcript: 42 mounted rows
// became 282 in one drag.

describe('shouldAutoReveal', () => {
  const at = (o: Partial<AutoRevealMetrics> = {}): AutoRevealMetrics => ({
    hiddenCount: 200, scrollTop: 100, userDriven: true, dragging: false, settled: true, ...o,
  });

  it('reveals when the reader has read up to the ceiling under their own steam', () => {
    expect(shouldAutoReveal(at())).toBe(true);
  });

  it('never reveals while the scrollbar thumb is held — the correction cannot survive a drag', () => {
    expect(shouldAutoReveal(at({ dragging: true }))).toBe(false);
  });

  it('a drag does not become acceptable just by being at the very top', () => {
    expect(shouldAutoReveal(at({ dragging: true, scrollTop: 0 }))).toBe(false);
  });

  it('never reveals while the scroller is still in motion — momentum is the drag with a different animator', () => {
    // WKWebView's out-of-process animator overwrites (or is killed by) a mid-momentum
    // correction exactly as the thumb overwrote it. The reveal waits for quiet; being
    // user-driven or at the very top buys no exception (owner report 08-01, the flicker).
    expect(shouldAutoReveal(at({ settled: false }))).toBe(false);
    expect(shouldAutoReveal(at({ settled: false, scrollTop: 0 }))).toBe(false);
    expect(shouldAutoReveal(at({ settled: false, userDriven: true }))).toBe(false);
  });

  it('refuses an offset the user did not ask for — our own correction, a clamp, a re-home', () => {
    expect(shouldAutoReveal(at({ userDriven: false }))).toBe(false);
    expect(shouldAutoReveal(at({ userDriven: false, scrollTop: 0 }))).toBe(false);
  });

  it('does nothing when the window has nothing left above it', () => {
    expect(shouldAutoReveal(at({ hiddenCount: 0 }))).toBe(false);
    expect(shouldAutoReveal(at({ hiddenCount: -1 }))).toBe(false);
  });

  it('only fires within the reveal band, so scrolling mid-transcript never extends the window', () => {
    expect(shouldAutoReveal(at({ scrollTop: WINDOW_REVEAL_PX - 1 }))).toBe(true);
    expect(shouldAutoReveal(at({ scrollTop: WINDOW_REVEAL_PX }))).toBe(false);
    expect(shouldAutoReveal(at({ scrollTop: 9999 }))).toBe(false);
  });
});

// ─── remainingSettleMs (the quiet timer's arithmetic) ───────────────────────────
//
// The pane's settle timer sleeps, wakes, asks this how much quiet is still owed, and
// re-arms for exactly that. The arithmetic lives here because the timer itself needs a
// document and a WebSocket to exist at all.

describe('remainingSettleMs', () => {
  it('is settled once a full quiet period has passed', () => {
    expect(remainingSettleMs(1000, 1000 - SCROLL_SETTLE_MS)).toBe(0);
    expect(remainingSettleMs(1000, 0)).toBe(0);
  });

  it('owes the remainder while activity is fresher than the quiet period', () => {
    expect(remainingSettleMs(1000, 1000)).toBe(SCROLL_SETTLE_MS);
    expect(remainingSettleMs(1000, 990)).toBe(SCROLL_SETTLE_MS - 10);
    expect(remainingSettleMs(1000, 1000 - SCROLL_SETTLE_MS + 1)).toBe(1);
  });

  it('treats "no activity ever" (-Infinity) as settled — a fresh pane may reveal at once', () => {
    expect(remainingSettleMs(1000, -Infinity)).toBe(0);
  });

  it('clamps activity stamped in the future to one full quiet period, never more', () => {
    // performance.now() going backwards across a re-home should cost at most one settle,
    // not a timer armed for a negative-since eternity.
    expect(remainingSettleMs(1000, 5000)).toBe(SCROLL_SETTLE_MS);
  });

  it('honours a caller-supplied quiet period', () => {
    expect(remainingSettleMs(1000, 950, 200)).toBe(150);
    expect(remainingSettleMs(1000, 700, 200)).toBe(0);
  });
});

// ─── pathChipLabel + toolSubject (owner report 08-01) ───────────────────────────
//
// The row names its OBJECT, not its type. Three screenshots drove this: seven `Read`
// rows whose chips all read `/Users/<me>/proje…` (right-truncated, so the filename —
// the only differing part — was the part thrown away), and a `Skill · 1 lines` row
// that named neither the skill nor anything useful.

describe('pathChipLabel', () => {
  it('keeps the filename and exactly ONE parent for context', () => {
    expect(pathChipLabel('/Users/me/projects/dc/dashboard/src/chat/chatEntities.ts'))
      .toEqual({ dir: 'chat', name: 'chatEntities.ts' });
  });

  it('has no parent to show at the root, or for a bare filename', () => {
    expect(pathChipLabel('/foo.txt')).toEqual({ dir: null, name: 'foo.txt' });
    expect(pathChipLabel('foo.txt')).toEqual({ dir: null, name: 'foo.txt' });
  });

  it('names a directory by its own last segment, not the trailing slash', () => {
    expect(pathChipLabel('/a/b/c/')).toEqual({ dir: 'b', name: 'c' });
    expect(pathChipLabel('/a/b/c///')).toEqual({ dir: 'b', name: 'c' });
  });

  it('normalises a leading ./ and windows separators', () => {
    expect(pathChipLabel('./src/app.ts')).toEqual({ dir: 'src', name: 'app.ts' });
    expect(pathChipLabel('src\\lib\\app.ts')).toEqual({ dir: 'lib', name: 'app.ts' });
  });

  it('never returns an empty name — a degenerate path still says something', () => {
    expect(pathChipLabel('/').name).toBeTruthy();
    expect(pathChipLabel('').name).toBe('');
  });

  it('is the fix: the differing half survives, the shared prefix is what goes', () => {
    const rows = [
      '/Users/me/dc/dashboard/src/components/sleepy/chat/ToolCard.tsx',
      '/Users/me/dc/dashboard/src/components/sleepy/chat/atoms.tsx',
      '/Users/me/dc/dashboard/src/components/sleepy/ChatPane.tsx',
    ].map(pathChipLabel);
    // Every row is now distinguishable by its name alone — which is what the raw-path
    // chip could not do, because CSS ellipsis cut from the right.
    expect(new Set(rows.map((r) => r.name)).size).toBe(3);
  });
});

describe('toolSubject', () => {
  it('Skill names the SKILL, which is sitting right there in the input', () => {
    expect(toolSubject('Skill', { skill: 'excalidraw', args: 'x' }))
      .toEqual({ kind: 'text', text: 'excalidraw' });
  });

  it('Read/Edit/Write name the file, and the chip stays openable', () => {
    expect(toolSubject('Read', { file_path: '/a/b.ts' })).toEqual({ kind: 'path', path: '/a/b.ts' });
    expect(toolSubject('Write', { file_path: '/a/b.ts' })).toEqual({ kind: 'path', path: '/a/b.ts' });
    expect(toolSubject('NotebookEdit', { notebook_path: '/a/n.ipynb' }))
      .toEqual({ kind: 'path', path: '/a/n.ipynb' });
  });

  it('Grep/Glob name the pattern — the question being asked', () => {
    expect(toolSubject('Grep', { pattern: 'useGroupCollapse', path: '/repo' }))
      .toEqual({ kind: 'text', text: 'useGroupCollapse' });
    expect(toolSubject('Glob', { pattern: '**/*.tsx' })).toEqual({ kind: 'text', text: '**/*.tsx' });
  });

  it('Grep falls back to its path when it somehow has no pattern', () => {
    expect(toolSubject('Grep', { path: '/repo/src' })).toEqual({ kind: 'path', path: '/repo/src' });
  });

  it('WebFetch names the host, not the whole url', () => {
    expect(toolSubject('WebFetch', { url: 'https://docs.anthropic.com/en/api/x?y=1' }))
      .toEqual({ kind: 'text', text: 'docs.anthropic.com' });
  });

  it('a url the URL parser rejects still names itself rather than vanishing', () => {
    expect(toolSubject('WebFetch', { url: 'not a url' })).toEqual({ kind: 'text', text: 'not a url' });
  });

  it('WebSearch names the query', () => {
    expect(toolSubject('WebSearch', { query: 'excalidraw plugin format' }))
      .toEqual({ kind: 'text', text: 'excalidraw plugin format' });
  });

  it('Agent/Task name WHICH agent — for the case its group card never materialised', () => {
    expect(toolSubject('Agent', { subagent_type: 'reviewer', description: 'review it' }))
      .toEqual({ kind: 'text', text: 'reviewer' });
    expect(toolSubject('Task', { description: 'review it' }))
      .toEqual({ kind: 'text', text: 'review it' });
  });

  it('Bash is prose, never a chip — and the description wins over the raw command', () => {
    // Superseded "no subject at all": a Bash row without one rendered as the bare word
    // "Bash" (owner report 08-01, second pass). The full behaviour is pinned in the
    // dedicated `toolSubject — Bash` describe below.
    expect(toolSubject('Bash', { command: 'ls -la', description: 'List files' }))
      .toEqual({ kind: 'prose', text: 'List files' });
  });

  it('returns null rather than an empty chip when the input holds nothing to name', () => {
    expect(toolSubject('Skill', {})).toBeNull();
    expect(toolSubject('Skill', { skill: '   ' })).toBeNull();
    expect(toolSubject('Read', {})).toBeNull();
    expect(toolSubject('TodoWrite', undefined)).toBeNull();
    expect(toolSubject('Anything', null)).toBeNull();
  });

  it('an unknown tool still shows its path if it has one', () => {
    expect(toolSubject('SomeMcpTool', { path: '/x/y.md' })).toEqual({ kind: 'path', path: '/x/y.md' });
  });
});

describe('isDreamcontextSkill', () => {
  it('recognises our own skills — the ones install-skill writes', () => {
    for (const s of ['dreamcontext', 'initializer', 'curator', 'dreamcontext-deep-research',
      'dream-sync', 'announcements', 'patterns', 'task-manager']) {
      expect(isDreamcontextSkill(s)).toBe(true);
    }
  });

  it('does NOT brand the skill-packs library — distributing a skill is not being it', () => {
    expect(isDreamcontextSkill('brand-voice')).toBe(false);
    expect(isDreamcontextSkill('council')).toBe(false);
    expect(isDreamcontextSkill('business-idea-discovery')).toBe(false);
  });

  it('does not brand an unrelated third-party skill', () => {
    expect(isDreamcontextSkill('remotion-render')).toBe(false);
    expect(isDreamcontextSkill('')).toBe(false);
  });

  it('is tolerant of casing and stray whitespace from the wire', () => {
    expect(isDreamcontextSkill('  Dreamcontext  ')).toBe(true);
    expect(isDreamcontextSkill('Task-Manager')).toBe(true);
  });
});

// ─── Tool runs (owner report 08-01) ─────────────────────────────────────────────
//
// A contiguous stretch of tool calls renders as ONE collapsing card. The two things
// that can go wrong are (a) a run swallowing an item that renders as something else,
// and (b) the group flickering open/closed once per tool call.

const tool = (id: string, over: Partial<{ name: string; status: 'running' | 'done' | 'error'; startedAt: number; endedAt: number }> = {}) => ({
  kind: 'tool' as const, id, name: 'Read', status: 'done' as const, startedAt: 0, endedAt: 1, ...over,
});
const text = (id: string) => ({ kind: 'text' as const, id });
const isTool = (i: { kind: string }) => i.kind === 'tool';

describe('segmentToolRuns', () => {
  it('folds a stretch of adjacent tool calls into one run', () => {
    const segs = segmentToolRuns([tool('a'), tool('b'), tool('c')], isTool);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('run');
  });

  it('leaves a run shorter than MIN_TOOL_RUN as plain singles — chrome must earn its place', () => {
    expect(segmentToolRuns([tool('a'), tool('b')], isTool).every((s) => s.kind === 'single')).toBe(true);
    expect(segmentToolRuns([tool('a')], isTool).every((s) => s.kind === 'single')).toBe(true);
    expect(MIN_TOOL_RUN).toBe(3);
  });

  it('a non-groupable item BREAKS the run — it never disappears into one', () => {
    const segs = segmentToolRuns(
      [tool('a'), tool('b'), tool('c'), text('t'), tool('d'), tool('e'), tool('f')],
      isTool,
    );
    expect(segs.map((s) => s.kind)).toEqual(['run', 'single', 'run']);
  });

  it('preserves every item, in order, exactly once', () => {
    const items = [tool('a'), text('t1'), tool('b'), tool('c'), tool('d'), text('t2'), tool('e')];
    const flat = segmentToolRuns(items, isTool)
      .flatMap((s) => (s.kind === 'run' ? s.items : [s.item]));
    expect(flat).toEqual(items);
  });

  it('the predicate is the CALLER\'s — an item that renders as a board or a bypass receipt is not groupable', () => {
    // Mirrors ChatPane's isPlainToolCard: kind==='tool' is necessary, not sufficient.
    const notBoard = (i: { kind: string; id: string }) => i.kind === 'tool' && i.id !== 'board';
    const segs = segmentToolRuns(
      [tool('a'), tool('b'), tool('board'), tool('c'), tool('d'), tool('e')],
      notBoard,
    );
    expect(segs.map((s) => s.kind)).toEqual(['single', 'single', 'single', 'run']);
  });

  it('handles an empty transcript', () => {
    expect(segmentToolRuns([], isTool)).toEqual([]);
  });
});

// ─── Invisible items are not boundaries (owner report 08-02) ───────────────────────
//
// What shipped broken: a thinking model opens a thinking block before nearly every tool
// call, and the encrypted kind arrives with NO text — an item drawing zero pixels. It
// counted as a run breaker, so a 19-call stretch became runs of one and two, all under
// MIN_TOOL_RUN, and the reader saw 19 ungrouped rows with visibly nothing between them.

describe('segmentToolRuns · an item that renders NOTHING', () => {
  const ghost = (id: string) => ({ kind: 'thinking' as const, id });
  const isGhost = (i: { kind: string }) => i.kind === 'thinking';

  it('does not break the run — the field case, one empty thinking block per call', () => {
    const items = [tool('a'), ghost('g1'), tool('b'), ghost('g2'), tool('c')];
    const segs = segmentToolRuns(items, isTool, MIN_TOOL_RUN, isGhost);
    const run = segs.find((s) => s.kind === 'run');
    expect(run && run.kind === 'run' && run.items).toEqual([tool('a'), tool('b'), tool('c')]);
  });

  it('is still emitted — held, never dropped or duplicated', () => {
    const items = [tool('a'), ghost('g1'), tool('b'), ghost('g2'), tool('c')];
    const flat = segmentToolRuns(items, isTool, MIN_TOOL_RUN, isGhost)
      .flatMap((s) => (s.kind === 'run' ? s.items : [s.item]));
    expect([...flat].sort((x, y) => x.id.localeCompare(y.id)))
      .toEqual([...items].sort((x, y) => x.id.localeCompare(y.id)));
  });

  it('keeps VISIBLE order exact — the ghosts come back out after the run they sat in', () => {
    const segs = segmentToolRuns(
      [tool('a'), ghost('g'), tool('b'), tool('c'), text('t'), tool('d')],
      isTool, MIN_TOOL_RUN, isGhost,
    );
    expect(segs.map((s) => (s.kind === 'run' ? `run:${s.items.map((i) => i.id).join('')}` : s.item.id)))
      .toEqual(['run:abc', 'g', 't', 'd']);
  });

  it('outside a run it is a plain single — output identical to before the fix', () => {
    const items = [ghost('g'), tool('a'), tool('b')];
    expect(segmentToolRuns(items, isTool, MIN_TOOL_RUN, isGhost))
      .toEqual(segmentToolRuns(items, isTool));
  });

  it('a stretch still under MIN_TOOL_RUN stays singles, in exact original order', () => {
    const items = [tool('a'), ghost('g'), tool('b')];
    expect(segmentToolRuns(items, isTool, MIN_TOOL_RUN, isGhost).map((s) => s.kind === 'single' && s.item.id))
      .toEqual(['a', 'g', 'b']);
  });

  it('a VISIBLE non-groupable item still breaks the run — the fix widened nothing else', () => {
    const segs = segmentToolRuns(
      [tool('a'), tool('b'), tool('c'), text('t'), tool('d'), tool('e'), tool('f')],
      isTool, MIN_TOOL_RUN, isGhost,
    );
    expect(segs.map((s) => s.kind)).toEqual(['run', 'single', 'run']);
  });

  it('defaults to opaque — a caller that passes no predicate behaves exactly as before', () => {
    const items = [tool('a'), ghost('g'), tool('b'), ghost('g2'), tool('c')];
    expect(segmentToolRuns(items, isTool).every((s) => s.kind === 'single')).toBe(true);
  });
});

// ─── toolRunKeyItem (owner report 08-01, second pass) ───────────────────────────
//
// The run card's React key must come from the run edge the window cannot move. Keyed on the
// first item, a reveal that merged 40 older calls into the head run was a key change: the
// card REMOUNTED, the user's open toggle reset (the card snapped back to its collapsed first
// frame), and the revealed history sat invisible inside it — "load older messages does
// nothing". Keyed on the last item, the accruing live tail would remount on every call.

describe('toolRunKeyItem', () => {
  const run = ['a', 'b', 'c', 'd'];

  it('a landed run keys off its LAST item — the edge a reveal cannot move', () => {
    expect(toolRunKeyItem(run, false)).toBe('d');
    // The reveal's merge: 40 older entries prepend, the tail stays — SAME key, no remount.
    expect(toolRunKeyItem(['x', 'y', ...run], false)).toBe('d');
  });

  it('the accruing tail keys off its FIRST item — the edge an append cannot move', () => {
    expect(toolRunKeyItem(run, true)).toBe('a');
    // The stream's append: a new call joins at the end — SAME key, no per-call remount.
    expect(toolRunKeyItem([...run, 'e'], true)).toBe('a');
  });

  it('the two rules cross over exactly when the run lands (accruing → false)', () => {
    // One remount at landing, which is when the phase-stamped toggle is released and the
    // auto-collapse fires anyway — the reader never sees a state this reset could lose.
    expect(toolRunKeyItem(run, true)).not.toBe(toolRunKeyItem(run, false));
  });
});

describe('toolRunPhase', () => {
  const done = [{ status: 'done' as const }, { status: 'done' as const }];

  it('is running while any call is still in flight', () => {
    expect(toolRunPhase([{ status: 'done' }, { status: 'running' }], false)).toBe('running');
  });

  it('stays running in the GAP between two calls — this is the anti-flicker rule', () => {
    // Every item is momentarily `done` between calls. Reading liveness off the items alone
    // would collapse the group here and re-open it a frame later, once per tool call.
    expect(toolRunPhase(done, true)).toBe('running');
  });

  it('lands the moment the run stops being the tail of a live turn', () => {
    expect(toolRunPhase(done, false)).toBe('done');
  });

  it('an errored call does not hold the group open', () => {
    expect(toolRunPhase([{ status: 'error' }, { status: 'done' }], false)).toBe('done');
  });

  it('drives the SAME phase-stamped override the sub-agent group card uses', () => {
    // Collapsing a live run sticks while it is live, and is released when it lands.
    expect(isGroupOpen(toolRunPhase(done, true), { phase: 'running', open: false })).toBe(false);
    expect(isGroupOpen(toolRunPhase(done, false), { phase: 'running', open: false })).toBe(false);
    // Re-opening a landed run sticks — the auto-collapse does not fire twice.
    expect(isGroupOpen(toolRunPhase(done, false), { phase: 'done', open: true })).toBe(true);
  });
});

describe('summarizeToolRun / toolRunHeadline', () => {
  const run = [
    tool('1', { name: 'Read', startedAt: 100, endedAt: 900 }),
    tool('2', { name: 'Read', startedAt: 200, endedAt: 1000 }),
    tool('3', { name: 'Bash', startedAt: 300, endedAt: 1200 }),
    tool('4', { name: 'Edit', startedAt: 400, endedAt: 1500 }),
    tool('5', { name: 'Grep', status: 'error', startedAt: 500, endedAt: 1400 }),
  ];

  it('counts what the reader actually wants to know', () => {
    const s = summarizeToolRun(run);
    expect(s).toMatchObject({ steps: 5, reads: 2, commands: 1, edits: 1, failed: 1 });
  });

  it('measures the run\'s wall-clock SPAN, not the sum of its parts', () => {
    // Sum would be 800+800+900+1100+900 = 4500ms for a run that took 1400ms of real time.
    expect(summarizeToolRun(run).durationMs).toBe(1400);
  });

  it('has no duration to report until something has finished', () => {
    expect(summarizeToolRun([tool('1', { name: 'Read', startedAt: 5, endedAt: undefined })]).durationMs).toBeNull();
  });

  it('says only the counts that are non-zero', () => {
    expect(toolRunHeadline(summarizeToolRun(run)))
      .toBe('5 steps · 2 files read · 1 command · 1 edited · 1 failed');
    expect(toolRunHeadline(summarizeToolRun([tool('1'), tool('2'), tool('3')])))
      .toBe('3 steps · 3 files read');
  });

  it('never claims a failure that did not happen', () => {
    expect(toolRunHeadline(summarizeToolRun([tool('1', { name: 'Bash' })]))).not.toContain('failed');
  });
});

// ─── Bash rows are never nameless (owner report 08-01, second pass) ─────────────
//
// `description` is OPTIONAL on the wire. Three rows in the original screenshot read as
// the bare word "Bash" with nothing beside them, because the card only ever looked at
// `description`. A row is not allowed to be nameless when its input says what it did.

describe('toolSubject — Bash', () => {
  it('prefers the description the CLI gave it', () => {
    expect(toolSubject('Bash', { command: 'git status', description: 'Show working tree status' }))
      .toEqual({ kind: 'prose', text: 'Show working tree status' });
  });

  it('falls back to the COMMAND when there is no description — the nameless-row fix', () => {
    expect(toolSubject('Bash', { command: 'git rev-parse HEAD' }))
      .toEqual({ kind: 'prose', text: 'git rev-parse HEAD' });
  });

  it('is prose, not a chip — a command is a sentence, a filename is a label', () => {
    expect(toolSubject('Bash', { command: 'ls' })?.kind).toBe('prose');
    expect(toolSubject('Read', { file_path: '/a.ts' })?.kind).toBe('path');
    expect(toolSubject('Skill', { skill: 'curator' })?.kind).toBe('text');
  });

  it('an empty description does not beat a real command', () => {
    expect(toolSubject('Bash', { command: 'make', description: '   ' }))
      .toEqual({ kind: 'prose', text: 'make' });
  });

  it('only returns null when the input genuinely names nothing', () => {
    expect(toolSubject('Bash', {})).toBeNull();
  });
});

describe('condenseCommand', () => {
  it('flattens a multi-line command into one line of header prose', () => {
    expect(condenseCommand('cat <<EOF\nhello\nworld\nEOF')).toBe('cat <<EOF hello world EOF');
    expect(condenseCommand('a &&\n  b   &&\tc')).toBe('a && b && c');
  });

  it('trims, so a row never starts with whitespace', () => {
    expect(condenseCommand('   npm test   ')).toBe('npm test');
  });

  it('caps its length — the DOM bound, not the visible one (CSS still ellipsizes)', () => {
    const long = 'x'.repeat(500);
    const out = condenseCommand(long);
    expect(out).toHaveLength(COMMAND_LABEL_CAP);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a command that already fits completely alone', () => {
    expect(condenseCommand('npm run build')).toBe('npm run build');
  });
});

// ─── The window measured in CARDS (owner report 08-02) ──────────────────────────
//
// Grouping broke the entry count as a proxy for height: a 40-entry window that folds
// into one collapsed run card is SHORTER than the scroller, so there is nothing to
// scroll while the pane still offers "scroll up and I'll load more" as the way back.
// `countCards`/`headForCards` are what let the window bound itself in what the reader
// can actually see, and `nextFirstShown` carries both floors so they inherit the
// hysteresis and the unpinned freeze instead of being applied beside them.

const ghostItem = (id: string) => ({ kind: 'thinking' as const, id });
const isGhostItem = (i: { kind: string }) => i.kind === 'thinking';
type CardItem = { kind: string; id: string };

const cardWin = (items: CardItem[]) => ({
  total: items.length,
  entryAt: (i: number) => items[i],
  isGroupable: isTool,
  rendersNothing: isGhostItem,
});

/** What the transcript actually renders for `items`: the segments that draw something. */
const renderedCards = (items: CardItem[]) => segmentToolRuns(items, isTool, MIN_TOOL_RUN, isGhostItem)
  .filter((s) => s.kind === 'run' || !isGhostItem(s.item)).length;

describe('countCards', () => {
  it('agrees with segmentToolRuns on what the slice renders as — for every head', () => {
    const items: CardItem[] = [
      text('t1'), tool('a'), tool('b'), tool('c'), tool('d'), ghostItem('g1'), tool('e'),
      text('t2'), tool('f'), tool('g'), text('t3'), ghostItem('g2'), tool('h'), tool('i'), tool('j'),
    ];
    for (let from = 0; from <= items.length; from += 1) {
      expect(countCards(from, cardWin(items))).toBe(renderedCards(items.slice(from)));
    }
  });

  it('a fold counts ONCE however many calls are in it', () => {
    const many = Array.from({ length: 60 }, (_, i) => tool(`t${i}`));
    expect(countCards(0, cardWin([text('x'), ...many]))).toBe(2);
  });

  it('a stretch under MIN_TOOL_RUN counts as its own plain cards', () => {
    expect(countCards(0, cardWin([tool('a'), tool('b')]))).toBe(2);
    expect(countCards(0, cardWin([tool('a'), tool('b'), tool('c')]))).toBe(1);
  });

  it('an item that renders nothing counts as nothing, and breaks no fold', () => {
    const items = [tool('a'), ghostItem('g1'), tool('b'), ghostItem('g2'), tool('c')];
    expect(countCards(0, cardWin(items))).toBe(1);
    expect(countCards(0, cardWin([ghostItem('g')]))).toBe(0);
  });

  it('an empty conversation renders nothing', () => {
    expect(countCards(0, cardWin([]))).toBe(0);
  });
});

describe('headForCards', () => {
  it('an ordinary conversation pays a card per entry — the entry tail stays the wider bound', () => {
    const items = Array.from({ length: 500 }, (_, i) => text(`t${i}`));
    const head = headForCards(WINDOW_TAIL_CARDS, WINDOW_MAX_ENTRIES, cardWin(items));
    expect(500 - head).toBe(WINDOW_TAIL_CARDS);
    expect(head).toBeGreaterThan(500 - WINDOW_TAIL);   // …so nextFirstShown's entry tail wins
  });

  it('walks PAST a fold that renders as one card — the report: nothing to scroll', () => {
    // 50 messages, then 200 contiguous calls: the last 40 entries are one collapsed card.
    const items = [
      ...Array.from({ length: 50 }, (_, i) => text(`t${i}`)),
      ...Array.from({ length: 200 }, (_, i) => tool(`c${i}`)),
    ];
    const head = headForCards(WINDOW_TAIL_CARDS, WINDOW_MAX_ENTRIES, cardWin(items));
    expect(countCards(head, cardWin(items))).toBe(WINDOW_TAIL_CARDS);
    expect(items.length - head).toBeGreaterThan(WINDOW_TAIL);   // it had to reach much further
  });

  it('stops at maxEntries when no amount of walking finds another card', () => {
    const items = Array.from({ length: 900 }, (_, i) => tool(`c${i}`));
    const head = headForCards(WINDOW_TAIL_CARDS, WINDOW_MAX_ENTRIES, cardWin(items));
    expect(items.length - head).toBe(WINDOW_MAX_ENTRIES);
    expect(countCards(head, cardWin(items))).toBe(1);   // honestly one card; the reveal is the way on
  });

  it('stops at the beginning of a short conversation instead of inventing entries', () => {
    const items = [text('a'), tool('b'), tool('c'), tool('d')];
    expect(headForCards(WINDOW_TAIL_CARDS, WINDOW_MAX_ENTRIES, cardWin(items))).toBe(0);
    expect(headForCards(5, WINDOW_MAX_ENTRIES, cardWin([]))).toBe(0);
  });

  it('asks for nothing → mounts nothing: the floor is a floor, not a target', () => {
    const items = Array.from({ length: 30 }, (_, i) => text(`t${i}`));
    expect(headForCards(0, WINDOW_MAX_ENTRIES, cardWin(items))).toBe(30);
  });

  it('always delivers the cards it promises when the conversation has them', () => {
    const items: CardItem[] = [];
    for (let turn = 0; turn < 40; turn += 1) {
      items.push(text(`u${turn}`));
      for (let c = 0; c < 7; c += 1) items.push(tool(`t${turn}-${c}`));
      items.push(ghostItem(`g${turn}`));
    }
    const head = headForCards(WINDOW_TAIL_CARDS, WINDOW_MAX_ENTRIES, cardWin(items));
    expect(renderedCards(items.slice(head))).toBeGreaterThanOrEqual(WINDOW_TAIL_CARDS);
  });
});

describe('nextFirstShown — the card floor (tailHead)', () => {
  it('widens the following window when the entry tail would leave nothing to scroll', () => {
    // The card floor reaches 300 entries back; the entry tail would have stopped at 40.
    const head = nextFirstShown(0, { total: 500, pinned: true, tailHead: 200 });
    expect(head).toBe(200);
  });

  it('never NARROWS it — rule 4 holds whatever the floor says', () => {
    expect(nextFirstShown(0, { total: 500, pinned: true, tailHead: 499 })).toBe(500 - WINDOW_TAIL);
    expect(nextFirstShown(0, { total: 500, pinned: true, tailHead: 500 })).toBe(500 - WINDOW_TAIL);
  });

  it('inherits TRIM_SLACK — a floor that drifts forward does not shed a row per card', () => {
    let head = nextFirstShown(0, { total: 500, pinned: true, tailHead: 200 });
    expect(head).toBe(200);
    for (let drift = 1; drift < TRIM_SLACK; drift += 1) {
      head = nextFirstShown(head, { total: 500, pinned: true, tailHead: 200 + drift });
      expect(head).toBe(200);                       // held: no unmount at all
    }
    head = nextFirstShown(head, { total: 500, pinned: true, tailHead: 200 + TRIM_SLACK });
    expect(head).toBe(200 + TRIM_SLACK);            // then one whole-chunk snap
  });

  it('inherits the unpinned freeze — a reader never has content taken from above them', () => {
    let head = nextFirstShown(0, { total: 500, pinned: true, tailHead: 200 });
    for (const tailHead of [210, 240, 300, 460]) {
      head = nextFirstShown(head, { total: 500, pinned: false, tailHead });
      expect(head).toBe(200);
    }
  });

  it('omitted, the entry tail decides exactly as it always did', () => {
    expect(nextFirstShown(0, { total: 500, pinned: true }))
      .toBe(nextFirstShown(0, { total: 500, pinned: true, tailHead: 500 - WINDOW_TAIL }));
  });
});

describe('nextFirstShown — the card step (revealHead)', () => {
  it('takes whichever step reaches further back', () => {
    // Stepping 40 entries would land inside the same fold; the card step reaches past it.
    expect(nextFirstShown(300, { total: 500, pinned: false, reveal: true, revealHead: 120 })).toBe(120);
    // …and a card step that is already satisfied leaves the entry step alone.
    expect(nextFirstShown(300, { total: 500, pinned: false, reveal: true, revealHead: 290 }))
      .toBe(300 - WINDOW_STEP);
  });

  it('still stops at the beginning', () => {
    expect(nextFirstShown(30, { total: 500, pinned: false, reveal: true, revealHead: -50 })).toBe(0);
  });

  it('always makes progress while anything is hidden — the button can never be inert', () => {
    const items = [
      ...Array.from({ length: 30 }, (_, i) => text(`t${i}`)),
      ...Array.from({ length: 400 }, (_, i) => tool(`c${i}`)),
    ];
    const w = cardWin(items);
    let head = nextFirstShown(0, { total: items.length, pinned: true, tailHead: headForCards(WINDOW_TAIL_CARDS, WINDOW_MAX_ENTRIES, w) });
    let steps = 0;
    while (head > 0 && steps < 100) {
      const before = head;
      const revealHead = headForCards(
        countCards(head, w) + WINDOW_STEP_CARDS, (items.length - head) + WINDOW_MAX_ENTRIES, w,
      );
      head = nextFirstShown(head, { total: items.length, pinned: false, reveal: true, revealHead });
      expect(head).toBeLessThan(before);
      steps += 1;
    }
    expect(head).toBe(0);
  });
});
