/**
 * "When every account is out → Continue at reset" (task settings-konuya-gore-17-menuye…,
 * wave 5): one timer per pane, at the reset plus a minute; it fires once, only into a living,
 * idle pane the owner has not written to since; an owner message or closing cancels it; under
 * `stop` (the default) nothing is armed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createResumeAtReset, RESUME_GRACE_MS, RESET_CONTINUE_TEXT, type ResumeAtResetDeps } from '../../src/lib/resume-at-reset.js';

function rig(over: Partial<ResumeAtResetDeps> = {}) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const state = { alive: true, idle: true, seq: 0, now: 1_000_000 };
  const r = createResumeAtReset({
    now: () => state.now,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    alive: () => state.alive,
    idle: () => state.idle,
    ownerSeq: () => state.seq,
    ...over,
  });
  const fireLast = () => { const t = timers[timers.length - 1]!; if (!t.cleared) t.fn(); };
  return { r, timers, state, fireLast };
}

describe('resume at reset', () => {
  it('arms one timer for the reset plus a minute, and fires once', () => {
    const { r, timers, state, fireLast } = rig();
    let fired = 0;
    expect(r.arm(state.now + 30_000, () => { fired += 1; })).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(30_000 + RESUME_GRACE_MS);
    expect(r.armed()).toBe(true);
    fireLast();
    expect(fired).toBe(1);
    expect(r.armed()).toBe(false);
  });

  it('re-arming replaces the earlier timer', () => {
    const { r, timers, state } = rig();
    r.arm(state.now + 10_000, () => {});
    r.arm(state.now + 20_000, () => {});
    expect(timers[0]!.cleared).toBe(true);
    expect(timers[1]!.cleared).toBe(false);
  });

  it('cancel (an owner message, the pane closing) clears it', () => {
    const { r, timers, state } = rig();
    r.arm(state.now + 10_000, () => {});
    r.cancel();
    expect(timers[0]!.cleared).toBe(true);
    expect(r.armed()).toBe(false);
  });

  it('an owner message since arming wins: it does not fire', () => {
    const { r, state, fireLast } = rig();
    let fired = 0;
    r.arm(state.now + 10_000, () => { fired += 1; });
    state.seq += 1;
    fireLast();
    expect(fired).toBe(0);
  });

  it('a busy or gone pane is never pushed', () => {
    const a = rig();
    let fired = 0;
    a.r.arm(a.state.now + 1, () => { fired += 1; });
    a.state.idle = false;
    a.fireLast();
    const b = rig();
    b.r.arm(b.state.now + 1, () => { fired += 1; });
    b.state.alive = false;
    b.fireLast();
    expect(fired).toBe(0);
  });

  it('an unusable reset arms nothing; a reset in the past fires after the grace', () => {
    const { r, timers, state } = rig();
    expect(r.arm(Number.NaN, () => {})).toBe(false);
    expect(r.arm(0, () => {})).toBe(false);
    expect(timers).toHaveLength(0);
    r.arm(state.now - 5 * 60_000, () => {});
    expect(timers[0]!.ms).toBe(0);
  });

  it('the text asks to continue without redoing work', () => {
    expect(RESET_CONTINUE_TEXT).toMatch(/Continue exactly where you stopped; do not redo finished work\./);
  });
});

describe('the route arms it only under Continue, and cancels it', () => {
  const route = readFileSync(join(__dirname, '..', '..', 'src', 'server', 'routes', 'agent-chat.ts'), 'utf-8');
  it('reads the tool\'s own rule; Stop arms nothing', () => {
    expect(route).toMatch(/if \(\(tool === 'codex' \? codexRules\(\) : claudeRules\(\)\)\.onExhausted !== 'continue'\) return;/);
    expect(route).toMatch(/if \(choice\.accountId === null\) armResumeAtReset\(choice\.earliestResetAt, activeAccountId, 'claude'\);/);
    expect(route).toMatch(/if \(!choice\.target\) armResumeAtReset\(choice\.earliestResetAt, codexAccountId, 'codex'\);/);
  });
  it('an owner turn and the pane ending cancel it', () => {
    const at = route.indexOf('const writeOwnerTurn = (text: string): void => {');
    expect(route.slice(at, at + 300)).toMatch(/ownerSeq \+= 1;\s*resumeAtReset\.cancel\(\);/);
    expect(route.match(/resumeAtReset\.cancel\(\);\n    stopPing\(\);/g)?.length).toBe(2);
  });
  it('the rule is read again when it fires: a switch to Stop since arming sends nothing', () => {
    const at = route.indexOf('resumeAtReset.arm(until, () => {');
    expect(at).toBeGreaterThan(0);
    expect(route.slice(at, at + 400)).toMatch(/onExhausted !== 'continue'\) return;/);
  });
  it('fires through the switch gate, and a wall still up (re-armed) sends nothing', () => {
    const at = route.indexOf('resumeAtReset.arm(until, () => {');
    const body = route.slice(at, at + 1400);
    expect(body).toMatch(/switchGate = switchGate\.then\(\(\) => \(ownerSeq !== seq \? false : maybeSwitchAccount\(RESET_CONTINUE_TEXT\)\)\)/);
    expect(body).toMatch(/if \(!alive \|\| resumeAtReset\.armed\(\)\) return;/);
  });
  it('a continue held for an account switch\'s restart gives way to an owner message', () => {
    const at = route.indexOf('resumeAtReset.arm(until, () => {');
    expect(route.slice(at, at + 1400)).toMatch(/if \(ownerSeq !== seq\) \{ if \(held\) dropHeldContinue\(\); return; \}/);
    expect(route).toMatch(/const at = heldTexts\.indexOf\(RESET_CONTINUE_TEXT\);\s*if \(at >= 0\) heldTexts\.splice\(at, 1\);/);
    const user = route.indexOf("const fromMirror = typeof raw !== 'string' && mirrorFrames.has(raw);");
    expect(route.slice(user - 400, user)).toMatch(/resumeAtReset\.cancel\(\);\s*dropHeldContinue\(\);\s*$/);
  });
  it('an owner message counts the moment it arrives, before the gate', () => {
    const at = route.indexOf("const fromMirror = typeof raw !== 'string' && mirrorFrames.has(raw);");
    expect(route.slice(at - 300, at)).toMatch(/ownerSeq \+= 1;\s*resumeAtReset\.cancel\(\);\s*dropHeldContinue\(\);\s*$/);
  });
  it('one account, or switching off: it still arms, on a reset the API stated only', () => {
    expect(route).toMatch(/if \(!recorded\.estimated\) armResumeAtReset\(recorded\.until, accountId, tool\);/);
    expect(route).toMatch(/if \(listClaudeAccounts\(\)\.length < 2\) \{ armOnRefusal\(recorded, activeAccountId, 'claude'\); return; \}/);
    expect(route).toMatch(/if \(listCodexAccounts\(\)\.length < 2\) \{ armOnRefusal\(recorded, codexAccountId, 'codex'\); return; \}/);
    expect(route.match(/armOnRefusal\(recorded, (activeAccountId, 'claude'|codexAccountId, 'codex')\);\n      return;/g)?.length).toBe(2);
  });
  it('says so to the pane', () => {
    expect(route).toMatch(/reason: 'resumed_at_reset'/);
    const proto = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'lib', 'chatProtocol.ts'), 'utf-8');
    expect(proto).toMatch(/\|\| reason === 'resumed_at_reset'/);
  });
});
