/**
 * `resolveSpawnScope`'s `use` parameter.
 *
 * A RUN of an agent's call target is approved and scoped on the full target, call settings
 * included. A CONVERSATION (`'identity'`) is approved the same way or through a bound
 * automation (rule (c)), but scoped from `identityOnly`, so a call setting — a synced
 * `output_dir` above all — can never widen or refuse what a chat with the agent may do.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSpawnScope } from '../../src/lib/automations/board-scope.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { approveAutomation, manifestHash } from '../../src/lib/automations/registry.js';
import { composeRun, legacyPair } from '../../src/lib/agents/compose.js';
import { createWhiteboard } from '../../src/lib/whiteboards/store.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

const NOW = new Date('2026-10-11T09:00:00.000Z');
let projectRoot: string;
let contextRoot: string;
let home: string;
let board: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-scope-use-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-scope-use-home-'));
  board = createWhiteboard(contextRoot, 'Northwind Ops').slug;
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A home-board on-call agent, as its call target, with an output folder in its
 *  CALL settings (the shape a synced edit to `call.output_dir` produces). */
function boardAgentWithCallOutputDir(): AutomationManifest {
  const legacy = createAutomation(contextRoot, {
    slug: 'board-pilot',
    title: 'Board pilot',
    mode: 'call',
    prompt: 'Keep the board tidy.',
    whiteboard: board,
    boardOnly: true,
  });
  const { agent } = legacyPair(legacy);
  return composeRun({ ...agent, call: { ...agent.call, outputDir: 'reports/adhoc' } }, null);
}

describe("resolveSpawnScope(…, use)", () => {
  it("a RUN reads the call settings: a board agent with a call output folder is refused", () => {
    const target = boardAgentWithCallOutputDir();
    approveAutomation(projectRoot, target, NOW, home);
    expect(resolveSpawnScope(contextRoot, target, home, 'run')).toEqual({
      ok: false,
      reason: 'a board agent cannot also set an output folder',
    });
  });

  it('use defaults to the strict run', () => {
    const target = boardAgentWithCallOutputDir();
    approveAutomation(projectRoot, target, NOW, home);
    expect(resolveSpawnScope(contextRoot, target, home)).toEqual(resolveSpawnScope(contextRoot, target, home, 'run'));
  });

  it("a CONVERSATION is scoped from identityOnly: the call output folder neither refuses nor widens it", () => {
    const target = boardAgentWithCallOutputDir();
    approveAutomation(projectRoot, target, NOW, home);
    expect(resolveSpawnScope(contextRoot, target, home, 'identity')).toEqual({
      ok: true,
      scope: { board, self: 'board-pilot' },
      homeBoard: board,
    });
  });

  it("rule (c): a bound automation's approval lends the agent its identity for a conversation, never a run", () => {
    const legacy = createAutomation(contextRoot, {
      slug: 'board-pilot',
      title: 'Board pilot',
      mode: 'call',
      prompt: 'Keep the board tidy.',
      whiteboard: board,
      boardOnly: true,
    });
    const { agent } = legacyPair(legacy);
    const digestSrc = createAutomation(contextRoot, {
      slug: 'digest',
      title: 'Morning digest',
      prompt: 'unused: the agent prompt wins',
      days: 'daily',
      at: '08:00',
    });
    const job = { ...legacyPair(digestSrc).job!, agent: 'board-pilot' };
    const automation = composeRun(agent, job);
    approveAutomation(projectRoot, automation, NOW, home);

    const callTarget = composeRun(agent, null, [{ slug: 'digest', sha256: manifestHash(automation) }], false);
    expect(resolveSpawnScope(contextRoot, callTarget, home, 'identity')).toEqual({
      ok: true,
      scope: { board, self: 'board-pilot' },
      homeBoard: board,
    });
    const run = resolveSpawnScope(contextRoot, callTarget, home, 'run');
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toContain('never-approved');
  });

  it("rule (c) returns the binding's entry, so a board disagreement against it still refuses", () => {
    const legacy = createAutomation(contextRoot, {
      slug: 'board-pilot',
      title: 'Board pilot',
      mode: 'call',
      prompt: 'Keep the board tidy.',
      whiteboard: board,
      boardOnly: true,
    });
    const { agent } = legacyPair(legacy);
    const other = createWhiteboard(contextRoot, 'Other Board').slug;
    const digestSrc = createAutomation(contextRoot, { slug: 'digest', title: 'Digest', prompt: 'x', days: 'daily', at: '08:00' });
    // The automation was approved while its agent lived on ANOTHER board.
    const automation = composeRun({ ...agent, whiteboard: other }, { ...legacyPair(digestSrc).job!, agent: 'board-pilot' });
    approveAutomation(projectRoot, automation, NOW, home);
    // A call target whose binding hash matches that approval but whose own manifest
    // names a different board must still be refused by the board check.
    const callTarget = composeRun(agent, null, [{ slug: 'digest', sha256: manifestHash(automation) }], false);
    const r = resolveSpawnScope(contextRoot, callTarget, home, 'identity');
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('was approved') });
  });
});
