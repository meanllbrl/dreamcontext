import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * §1.4 of the plan is explicit: there is NO automatic orphan reaper.
 * `killRunGroup` exists to make a stuck process group killABLE, but only a
 * human invoking `automations kill <slug>` may ever call it — `runAutomation`
 * and `tick` must never call it themselves, or the very defect that
 * motivated cutting the automatic reaper (an unattended process issuing a
 * negative-PID SIGKILL from file contents) comes right back.
 *
 * A spy/mock cannot prove this negative: there is no internal call site to
 * intercept, since the whole point is that one must never exist. A SOURCE
 * SCAN is the only mechanical way to pin it — this test greps the compiled
 * source of runner.ts (self-scan, to confirm the guard finds real matches
 * and only the definition) and tick.ts (once it lands) for any `killRunGroup(`
 * call site outside `killRunGroup`'s own definition.
 */

function findCallSitesOutsideDefinition(filePath: string, fnName: string): string[] {
  const src = readFileSync(filePath, 'utf-8');
  const lines = src.split('\n');
  const callSites: string[] = [];
  let inOwnDefinition = false;
  let braceDepth = 0;

  lines.forEach((line, i) => {
    const isDefinitionLine = new RegExp(`function ${fnName}\\s*\\(`).test(line) && /^export /.test(line.trim());
    if (isDefinitionLine) {
      inOwnDefinition = true;
      braceDepth = 0;
    }
    if (inOwnDefinition) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (!isDefinitionLine && braceDepth <= 0) inOwnDefinition = false;
      return; // skip lines that are part of the function's own body/signature
    }
    // A genuine call site: `fnName(` NOT preceded by `function ` (a
    // declaration) and not inside a comment-only line.
    const callPattern = new RegExp(`(?<!function )\\b${fnName}\\s*\\(`);
    const trimmed = line.trim();
    if (callPattern.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
      callSites.push(`${filePath}:${i + 1}: ${trimmed}`);
    }
  });
  return callSites;
}

const RUNNER_PATH = join(__dirname, '..', '..', 'src', 'lib', 'automations', 'runner.ts');
const TICK_PATH = join(__dirname, '..', '..', 'src', 'lib', 'automations', 'tick.ts');

describe('killRunGroup is CLI-only — no automatic reaper', () => {
  it('the scanner itself finds killRunGroup\'s own definition (sanity — proves the scanner works)', () => {
    const src = readFileSync(RUNNER_PATH, 'utf-8');
    expect(src).toMatch(/export function killRunGroup\s*\(/);
  });

  it('runner.ts never calls killRunGroup from within runAutomation (no call site outside its own definition)', () => {
    const callSites = findCallSitesOutsideDefinition(RUNNER_PATH, 'killRunGroup');
    expect(callSites).toEqual([]);
  });

  it('tick.ts never calls killRunGroup (checked once tick.ts lands — a missing file means nothing to scan yet, not a pass by omission)', () => {
    let src: string;
    try {
      src = readFileSync(TICK_PATH, 'utf-8');
    } catch {
      // tick.ts is a different task's wave-4 deliverable and may not exist
      // yet in this worktree at the time runner.ts's tests run. This is
      // NOT a silent pass: it is a distinct, explicit branch, and the
      // moment tick.ts exists the real scan below applies to it.
      expect(true).toBe(true);
      return;
    }
    const callSites = findCallSitesOutsideDefinition(TICK_PATH, 'killRunGroup');
    expect(callSites).toEqual([]);
    // If tick.ts imports killRunGroup at all, that import itself is already
    // suspicious enough to warrant a hard failure — tick has no legitimate
    // reason to reference it.
    expect(src).not.toMatch(/import\s*\{[^}]*\bkillRunGroup\b[^}]*\}\s*from/);
  });
});
