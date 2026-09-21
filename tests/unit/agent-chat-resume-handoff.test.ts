/**
 * The two guards that stand between a respawn and a LOST CONVERSATION.
 *
 * THE FAILURE THEY EXIST FOR (owner, 2026-09-18): "auto→bypass geçişi sonrası session kaybı
 * yaşanıyor, tüm geçmiş text yok oluyor." Switching permission mode respawns the session —
 * CLI 2.1.220+ refuses every live switch INTO bypass, so the respawn IS the switch — and the
 * conversation came back empty.
 *
 * THE MECHANISM, end to end. A respawn disposes the old session and opens the new socket in
 * the SAME tick. `startChatSession` then picks a resume target, and all three of its options
 * can come up empty at once: `resumeTarget` is skipped while the conversation is still held
 * by the outgoing process, and `freshPin` is skipped because a transcript for that id EXISTS.
 * `idArg` therefore came out `[]` and the spawn started a brand-new, UNPINNED conversation.
 * The tab kept its pinned id, the live conversation was elsewhere, and `chat-history` —
 * resolving through the tab-session map the new process's SessionStart hook had just
 * rewritten — replayed the new empty file. A blank pane, permanently.
 *
 * WHY THIS IS A SOURCE-SHAPE TEST. Both guards are about a RACE inside a live WebSocket
 * upgrade against a real `claude` child; reproducing the losing interleaving in a unit test
 * would mean re-implementing the upgrade path, and the re-implementation is exactly what
 * would drift. So this pins the two structural properties that make the race survivable, and
 * `scripts/verify/chat-composer-ui.mjs` (§9c, §10, §10b, §12) drives the real respawn paths
 * end to end against a real server. Neither alone is enough; this one is the cheap half that
 * fails the moment somebody deletes the guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESUME_HANDOFF_WAIT_MS } from '../../src/server/routes/agent-chat.js';

const SRC = readFileSync(join(process.cwd(), 'src/server/routes/agent-chat.ts'), 'utf-8');

/** Strip comments, so an assertion can never be satisfied by prose ABOUT the code. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('awaitResumeHandoff — the wait budget counts POLLS, not wall-clock', () => {
  // A wall-clock deadline alone is the wrong instrument. The permission switch used to respawn
  // EVERY chat in the vault at once, so the event loop went into a burst of synchronous
  // `child_process.spawn` + briefing-file writes. Nothing polls while the loop is blocked and
  // `Date.now()` keeps moving, so the whole budget could be spent inside one block: the loop
  // exits on its first check with the conversation still held, and the silent fall-through
  // below is taken. Counting polls makes the budget mean "we looked this many times".
  const fn = code(SRC.slice(SRC.indexOf('async function awaitResumeHandoff')));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);

  it('keeps the documented 1.5s budget', () => {
    expect(RESUME_HANDOFF_WAIT_MS).toBe(1500);
  });

  it('will not give up before a minimum number of polls have actually run', () => {
    expect(body).toMatch(/polls\s*<\s*RESUME_HANDOFF_MIN_POLLS/);
    expect(body, 'a wall-clock-only deadline is starved by a blocked event loop')
      .toMatch(/polls\s*\+=\s*1/);
  });

  it('derives that floor from the budget and the poll interval, so the two cannot drift', () => {
    expect(code(SRC)).toMatch(
      /RESUME_HANDOFF_MIN_POLLS\s*=\s*Math\.ceil\(RESUME_HANDOFF_WAIT_MS\s*\/\s*RESUME_HANDOFF_POLL_MS\)/,
    );
  });

  it('reports giving up while the conversation is still held — the failure is otherwise invisible', () => {
    expect(body).toMatch(/console\.warn/);
  });
});

describe('startChatSession — a resume that cannot take its conversation REFUSES', () => {
  const body = code(SRC);

  it('refuses instead of silently starting an unpinned conversation', () => {
    // The exact condition matters: `resumeId` was asked for, but neither a resume target nor a
    // fresh pin survived — i.e. somebody else is holding this conversation. That is precisely
    // the state in which `idArg` is `[]`.
    expect(body).toMatch(/if\s*\(resumeId\s*&&\s*!resumeTarget\s*&&\s*!freshPin\)/);
  });

  it('the refusal comes BEFORE the child is spawned, and returns', () => {
    const guardAt = body.indexOf('if (resumeId && !resumeTarget && !freshPin)');
    const spawnAt = body.indexOf('const child = spawn(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(spawnAt).toBeGreaterThan(-1);
    expect(guardAt, 'a guard after the spawn has already started the orphan').toBeLessThan(spawnAt);
    // The arm itself: say why, close, and stop.
    const arm = body.slice(guardAt, guardAt + 700);
    expect(arm).toMatch(/subtype: 'error'/);
    expect(arm).toMatch(/ws\.close\(\)/);
    expect(arm).toMatch(/\breturn;/);
  });

  it('names the state in a sentence a user can act on, and says nothing was lost', () => {
    // The refusal is recoverable — the pane raises "Session ended · Resume" and the button
    // works the moment the other holder lets go. A bare error would read as the data loss it
    // exists to prevent.
    const guardAt = SRC.indexOf('if (resumeId && !resumeTarget && !freshPin)');
    const arm = SRC.slice(guardAt, guardAt + 700);
    expect(arm).toMatch(/Nothing was lost/);
    expect(arm).toMatch(/Resume/);
  });

  it('is scoped to a RESUME — a brand-new session has no transcript to lose', () => {
    expect(body).not.toMatch(/if\s*\(!resumeTarget\s*&&\s*!freshPin\)\s*\{/);
  });
});
