import { describe, it, expect } from 'vitest';
import type { DistilledSection } from '../../src/cli/commands/transcript.js';
import {
  detectSalience, detectSalienceFromMessage, MESSAGE_ONLY_MOMENT_CAP,
  leadingClause, CORRECTION_SCAN_MAX_CHARS,
} from '../../src/lib/salience.js';

function empty(): DistilledSection {
  return {
    userMessages: [],
    agentDecisions: [],
    codeChanges: [],
    errors: [],
    bookmarks: [],
  };
}

describe('detectSalience', () => {
  it('detects a user correction at salience 2 (EN)', () => {
    const d = empty();
    d.userMessages = ['No, actually use yarn instead of npm here.'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 2 && m.message.includes('User correction'))).toBe(true);
  });

  it('detects a user correction in Turkish', () => {
    const d = empty();
    d.userMessages = ['Hayır, bu yanlış, başka bir yaklaşım kullan.'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 2)).toBe(true);
  });

  it('detects error → fix at salience 1 when an error and a code change coexist', () => {
    const d = empty();
    d.errors = ['Error: undefined is not a function in handler.ts'];
    d.codeChanges = ['EDIT src/handler.ts\n--- OLD ---\nx()\n--- NEW ---\nx?.()'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 1 && m.message.includes('Error resolved'))).toBe(true);
  });

  it('does NOT fire error→fix when there is an error but no code change', () => {
    const d = empty();
    d.errors = ['Error: transient network blip'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.message.includes('Error resolved'))).toBe(false);
  });

  it('detects a decision keyword at salience 2 (EN)', () => {
    const d = empty();
    d.agentDecisions = ['We switched to a queue-based architecture for resilience.'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 2 && m.message.includes('Decision'))).toBe(true);
  });

  it('detects a decision keyword in Turkish', () => {
    const d = empty();
    d.agentDecisions = ['Sonunda Redis kullanmaya karar verdik.'];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 2)).toBe(true);
  });

  it('ignores [thinking] blocks for decision detection', () => {
    const d = empty();
    d.agentDecisions = ['[thinking] I decided internally to maybe chose Redis but it is just reasoning.'];
    const moments = detectSalience(d);
    expect(moments).toEqual([]);
  });

  it('yields ZERO bookmarks on a clean session (no false positives)', () => {
    const d = empty();
    d.userMessages = ['Please add a health-check endpoint to the API.'];
    d.agentDecisions = ['Added GET /health returning 200 with uptime.'];
    d.codeChanges = ['WRITE src/health.ts (12 lines)'];
    const moments = detectSalience(d);
    expect(moments).toEqual([]);
  });

  it('does NOT classify a sub-agent task-notification as a User correction', () => {
    const d = empty();
    // task-notifications contain words like "no"/"instead" but are pure noise.
    d.userMessages = ['<task-notification>Agent foo finished; no further action instead.</task-notification>'];
    const moments = detectSalience(d);
    expect(moments).toEqual([]);
  });

  it('does NOT classify agent-resume JSON as a User correction', () => {
    const d = empty();
    d.userMessages = ['{"success":true,"message":"Agent abc had no active task; resumed instead."}'];
    const moments = detectSalience(d);
    expect(moments).toEqual([]);
  });

  it('does NOT classify a skill-loader header as a User correction', () => {
    const d = empty();
    d.userMessages = ['Base directory for this skill: /home/u/.claude/skills/no-instead'];
    const moments = detectSalience(d);
    expect(moments).toEqual([]);
  });

  it('does NOT classify a bare mid-sentence "no"/"not" as a correction', () => {
    const d = empty();
    // Tool-output-flavoured prose that trips the OLD bare-word regex.
    d.userMessages = [
      'There are no open tabs in the browser right now.',
      'The endpoint returned 404 not found.',
    ];
    const moments = detectSalience(d);
    expect(moments).toEqual([]);
  });

  it('does NOT classify a bare Turkish "değil" as a correction', () => {
    const d = empty();
    d.userMessages = ['Bu bir hata değil, beklenen davranış.'];
    const moments = detectSalience(d);
    expect(moments).toEqual([]);
  });

  it('still detects a real correction that sits alongside coordination noise', () => {
    const d = empty();
    d.userMessages = [
      '<task-notification>Agent done; resumed</task-notification>',
      'No, actually use yarn instead of npm here.',
    ];
    const moments = detectSalience(d);
    expect(moments.some(m => m.salience === 2 && m.message.includes('User correction'))).toBe(true);
    expect(moments).toHaveLength(1);
  });

  it('dedupes and caps at 5 moments', () => {
    const d = empty();
    d.userMessages = Array.from({ length: 10 }, () => 'No, actually wrong instead.');
    d.agentDecisions = Array.from({ length: 10 }, (_, i) => `We decided option ${i}.`);
    const moments = detectSalience(d);
    expect(moments.length).toBeLessThanOrEqual(5);
    // the 10 identical correction messages collapse to one
    const corrections = moments.filter(m => m.message.includes('User correction'));
    expect(corrections.length).toBe(1);
  });
});

describe('detectSalience: leading-clause gate (orchestrator briefs are not corrections)', () => {
  const brief = [
    'You are builder w1-A (Lane A, server) on task demo-task.',
    'Read _dream_context/state/demo-task.md first.',
    'Use the cached index instead of re-reading every file, and actually run the tests.',
    'If a plan step is wrong, stop and report it.',
    'The lead decided the wave map; you will use the lane files only.',
  ].join(' ') + ' ' + 'Context. '.repeat(600);

  it('a 5k-char brief with correction and decision words past its first sentence yields nothing', () => {
    expect(brief.length).toBeGreaterThan(5000);
    const d = empty();
    d.userMessages = [brief];
    expect(detectSalience(d)).toEqual([]);
  });

  it('a short correction still fires', () => {
    const d = empty();
    d.userMessages = ['no, use the staging endpoint'];
    const moments = detectSalience(d);
    expect(moments).toEqual([{ message: 'User correction: no, use the staging endpoint', salience: 2 }]);
  });

  it('a long message whose FIRST sentence carries the marker still fires', () => {
    const d = empty();
    d.userMessages = ['Actually the retry belongs in the client. ' + 'Here is the context. '.repeat(40)];
    const moments = detectSalience(d);
    expect(moments.filter(m => m.message.startsWith('User correction:'))).toHaveLength(1);
  });

  it('a short message is scanned whole, so a mid-message "instead of" still counts', () => {
    const d = empty();
    d.userMessages = ['Looks good. Use pnpm instead of npm though.'];
    expect(detectSalience(d).some(m => m.message.startsWith('User correction:'))).toBe(true);
  });

  it('a long user message with a decision word past its first sentence is not a Decision', () => {
    const d = empty();
    d.userMessages = ['Here is the full brief for this run. ' + 'Filler text. '.repeat(40) + 'We decided on X.'];
    expect(detectSalience(d)).toEqual([]);
  });
});

describe('leadingClause', () => {
  it('returns short messages whole (trimmed)', () => {
    expect(leadingClause('  no, not that one. Try again.  ')).toBe('no, not that one. Try again.');
  });

  it('cuts a long message at the end of its first sentence', () => {
    const long = 'First sentence here. ' + 'x'.repeat(400);
    expect(leadingClause(long)).toBe('First sentence here.');
  });

  it('cuts at a newline too', () => {
    const long = 'Heading line\n' + 'y'.repeat(400);
    expect(leadingClause(long)).toBe('Heading line\n');
  });

  it('caps an unpunctuated long message at CORRECTION_SCAN_MAX_CHARS', () => {
    const long = 'z'.repeat(1000);
    expect(leadingClause(long)).toHaveLength(CORRECTION_SCAN_MAX_CHARS);
  });
});

describe('detectSalience: sub-agent paperwork is not a Decision', () => {
  it('skips [subagent…] agent decisions', () => {
    const d = empty();
    d.agentDecisions = [
      '[subagent:a1b2] ## sleep-product report: we decided to merge the two PRDs.',
      '[subagent-task] You are the sleep-state specialist; we will use the standard depth.',
    ];
    expect(detectSalience(d)).toEqual([]);
  });

  it('still detects the main agent\'s own decision', () => {
    const d = empty();
    d.agentDecisions = ['We decided to keep the regex as the fallback.'];
    expect(detectSalience(d).some(m => m.message.startsWith('Decision:'))).toBe(true);
  });
});

describe('detectSalienceFromMessage (AC2 — transcript-less salience)', () => {
  it('null → []', () => {
    expect(detectSalienceFromMessage(null)).toEqual([]);
  });

  it('empty string → []', () => {
    expect(detectSalienceFromMessage('')).toEqual([]);
  });

  it('whitespace-only string → []', () => {
    expect(detectSalienceFromMessage('   \n\t  ')).toEqual([]);
  });

  it('a decision-marker message (EN) → one salience-2 Decision moment', () => {
    const moments = detectSalienceFromMessage('We decided to switch to BM25 for recall.');
    expect(moments).toHaveLength(1);
    expect(moments[0].salience).toBe(2);
    expect(moments[0].message).toContain('Decision');
  });

  it('a decision-marker message (TR) → matches "karar"', () => {
    const moments = detectSalienceFromMessage('Postgres kullanmaya karar verdik.');
    expect(moments.some(m => m.salience === 2)).toBe(true);
  });

  it('a message with no marker → [] (conservative)', () => {
    expect(detectSalienceFromMessage('Done. All tests pass.')).toEqual([]);
  });

  it('CORRECTION_RE does NOT apply — this is the agent\'s own message, not a user correction', () => {
    // Leading "No, actually" would trip CORRECTION_RE if it were treated as a
    // user message; detectSalienceFromMessage wraps it as an agentDecision, so
    // only DECISION_RE (via the decision-keyword pass) can match it.
    const moments = detectSalienceFromMessage('No, actually the tests are still failing.');
    expect(moments.every(m => !m.message.startsWith('User correction'))).toBe(true);
  });

  it('caps at MESSAGE_ONLY_MOMENT_CAP even with multiple decision markers', () => {
    const message = 'We decided X. We chose Y. We switched to Z. We will use W.';
    const moments = detectSalienceFromMessage(message);
    expect(moments.length).toBeLessThanOrEqual(MESSAGE_ONLY_MOMENT_CAP);
  });

  it('clamps an over-long message to 200 chars with an ellipsis', () => {
    const long = 'We decided to do the following: ' + 'x'.repeat(500);
    const moments = detectSalienceFromMessage(long);
    expect(moments.length).toBeGreaterThan(0);
    expect(moments[0].message.length).toBeLessThanOrEqual(200);
    expect(moments[0].message.endsWith('…')).toBe(true);
  });
});
