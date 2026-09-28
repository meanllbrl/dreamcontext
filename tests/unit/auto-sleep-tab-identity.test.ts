/**
 * THE FAILURE THESE GUARDS EXIST FOR (owner, 2026-09-21): "otosleep bazen var olan
 * session'ı devralıyor ve o session sıfırlanıyor — ben oraya geldiğim zaman eski
 * chat'lerim kaybolmuş oluyor."
 *
 * THE MECHANISM, end to end. Background auto-sleep is dispatched from the Stop hook,
 * which runs INSIDE the tab's own `claude` — so its env carries DREAMCONTEXT_TAB_SESSION.
 * `spawnAutoSleep` spawned the dispatcher with no env of its own, and
 * `executeClaudeDetached` spreads `process.env` into the cycle's `claude`, so the
 * background cycle booted wearing the USER'S TAB IDENTITY. Its own SessionStart hook
 * then called `recordTabSessionFromHook`, whose only ownership guard is
 * `isNestedClaudeHook` — an ancestry walk that structurally cannot see this case: the
 * cycle is spawned DETACHED (the child reparents to pid 1) and `… sleep auto-run` is
 * not a claude-like command, so the walk counts ONE claude and answers "not nested".
 * `recordAgentSession` then repointed the tab at the consolidation conversation and
 * dropped its `firstPrompt` (carried only while `current` is unchanged). The tab
 * resumed the sleep run, `chat-history` replayed that transcript, and the user's chat
 * read as lost. The same hole let the cycle overwrite a tab's captured first prompt
 * and consume a human's pending handoff banner.
 *
 * WHY THIS IS A SOURCE-SHAPE TEST. Reproducing it means spawning a real detached
 * `claude` from a real Stop hook and waiting out a consolidation cycle; the
 * re-implementation needed to fake it is exactly what would drift. So this pins the
 * structural properties, comment-stripped so no assertion can be satisfied by prose
 * ABOUT the code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOOK = readFileSync(join(process.cwd(), 'src/cli/commands/hook.ts'), 'utf-8');
const RUNNER = readFileSync(join(process.cwd(), 'src/lib/automations/runner.ts'), 'utf-8');

/** Strip comments, so an assertion can never be satisfied by prose ABOUT the code. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found — the guard moved`).toBeGreaterThan(-1);
  const rest = code(src.slice(start));
  return rest.slice(0, rest.indexOf('\n}') + 2);
}

describe('spawnAutoSleep — the background cycle does not inherit the tab it was triggered from', () => {
  const body = fnBody(HOOK, 'function spawnAutoSleep()');

  it('passes an env of its own rather than inheriting the hook process env wholesale', () => {
    expect(body, 'no env option means the tab identity rides along')
      .toMatch(/env,?\s*$/m);
    expect(body).toMatch(/const env = \{ \.\.\.process\.env \}/);
  });

  it('strips the tab identity, which is what the session map is keyed by', () => {
    expect(body).toMatch(/delete env\.DREAMCONTEXT_TAB_SESSION/);
  });

  it('strips the conversation id, so nothing downstream resolves the human transcript', () => {
    expect(body).toMatch(/delete env\.CLAUDE_CODE_SESSION_ID/);
  });

  it('is still detached — which is WHY the ancestry guard cannot cover this', () => {
    expect(body).toMatch(/detached: true/);
  });
});

describe('the record gates refuse a background cycle by flag, not by ancestry', () => {
  it('the tab→conversation map refuses before recording', () => {
    const body = fnBody(HOOK, 'function recordTabSessionFromHook(');
    expect(body).toMatch(/if \(isBackgroundAutoSleep\(\)\) return;/);
    // Order matters only in that the refusal must precede the write.
    expect(body.indexOf('isBackgroundAutoSleep()'))
      .toBeLessThan(body.indexOf('recordAgentSession('));
  });

  it('reads the flag the auto-sleep runner actually sets', () => {
    const body = fnBody(HOOK, 'function isBackgroundAutoSleep()');
    expect(body).toMatch(/process\.env\.DREAMCONTEXT_AUTO_SLEEP === '1'/);
    const runner = readFileSync(join(process.cwd(), 'src/lib/auto-sleep-runner.ts'), 'utf-8');
    expect(code(runner)).toMatch(/DREAMCONTEXT_AUTO_SLEEP: '1'/);
  });
});

describe('the premise the fix rests on', () => {
  it('executeClaudeDetached really does spread process.env into the spawned claude', () => {
    expect(code(RUNNER), 'if this stops inheriting, the spawn-site strip is no longer the root fix')
      .toMatch(/env: \{ \.\.\.process\.env/);
  });
});
