import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPAWNED_ENV,
  SPAWN_ENV_KEYS,
  spawnMarkerFromEnv,
  scrubSpawnEnv,
  prepareDashboardEnv,
  parsePsTable,
  isNestedInProcessTable,
  resolveSpawnMarker,
  type PsRow,
} from '../../src/lib/session-origin.js';
import { findRegisteredActor } from '../../src/lib/goal-live.js';

const ORCH = '11111111-1111-4111-8111-111111111111';
const BUILDER = '22222222-2222-4222-8222-222222222222';
const HUMAN = '33333333-3333-4333-8333-333333333333';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A throwaway context root with an optional goal-live file registering BUILDER under ORCH. */
function contextRoot(opts: { mode?: 'develop'; register?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-origin-'));
  dirs.push(root);
  mkdirSync(join(root, 'tmp'));
  if (opts.register !== false) {
    writeFileSync(join(root, 'tmp', `.goal-skill-live.${ORCH}.json`), JSON.stringify({
      phase: 'impl',
      session: ORCH,
      ...(opts.mode ? { mode: opts.mode } : {}),
      lineage: [
        { a: 'planner', role: 'planner', k: 'spawn' },
        { a: 'w1-A', role: 'implementer', k: 'spawn', sid: BUILDER },
      ],
    }));
  }
  return root;
}

const never = (): boolean => { throw new Error('isNested must not be called'); };

describe('spawnMarkerFromEnv', () => {
  it('reads background sleep, automation runs and DREAMCONTEXT_SPAWNED', () => {
    expect(spawnMarkerFromEnv({ DREAMCONTEXT_AUTO_SLEEP: '1' })).toEqual({ by: 'auto-sleep', via: 'env' });
    expect(spawnMarkerFromEnv({ DREAMCONTEXT_AUTOMATION_RUN: '2026-09-29T08:00:00.000Z' }))
      .toEqual({ by: 'automation', via: 'env' });
    for (const by of ['develop', 'goal-skill', 'peer', 'lab'] as const) {
      expect(spawnMarkerFromEnv({ [SPAWNED_ENV]: by })).toEqual({ by, via: 'env' });
    }
    expect(spawnMarkerFromEnv({ [SPAWNED_ENV]: 'something-else' })).toEqual({ by: 'other', via: 'env' });
  });

  it('is null for a human env, a blank value, and AUTO_SLEEP other than "1"', () => {
    expect(spawnMarkerFromEnv({})).toBeNull();
    expect(spawnMarkerFromEnv({ [SPAWNED_ENV]: '   ', DREAMCONTEXT_AUTOMATION_RUN: '' })).toBeNull();
    expect(spawnMarkerFromEnv({ DREAMCONTEXT_AUTO_SLEEP: '0' })).toBeNull();
  });
});

describe('scrubSpawnEnv / prepareDashboardEnv', () => {
  it('scrub removes every spawn key and nothing else', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin' };
    for (const k of SPAWN_ENV_KEYS) env[k] = 'x';
    scrubSpawnEnv(env);
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('prepareDashboardEnv scrubs and stamps the server pid as the walk boundary', () => {
    const env: NodeJS.ProcessEnv = { [SPAWNED_ENV]: 'develop', DREAMCONTEXT_SERVER_PID: '1' };
    prepareDashboardEnv(env, 4242);
    expect(env[SPAWNED_ENV]).toBeUndefined();
    expect(env.DREAMCONTEXT_SERVER_PID).toBe('4242');
  });

  it("prepareDashboardEnv drops the launcher's session and tab ids, leaving SPAWN_ENV_KEYS alone", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/bin',
      CLAUDE_CODE_SESSION_ID: HUMAN,
      DREAMCONTEXT_TAB_SESSION: ORCH,
    };
    prepareDashboardEnv(env, 4242);
    expect(env).toEqual({ PATH: '/bin', DREAMCONTEXT_SERVER_PID: '4242' });
    expect(SPAWN_ENV_KEYS).not.toContain('CLAUDE_CODE_SESSION_ID');
    expect(SPAWN_ENV_KEYS).not.toContain('DREAMCONTEXT_TAB_SESSION');
  });
});

describe('findRegisteredActor', () => {
  it('finds a registered builder with its run mode and orchestrator', () => {
    expect(findRegisteredActor(contextRoot({ mode: 'develop' }), BUILDER)).toEqual({ mode: 'develop', orchestrator: ORCH });
    expect(findRegisteredActor(contextRoot(), BUILDER)).toEqual({ mode: 'goal', orchestrator: ORCH });
  });

  it('never matches the orchestrator itself or an unregistered session', () => {
    const root = contextRoot();
    expect(findRegisteredActor(root, ORCH)).toBeNull();
    expect(findRegisteredActor(root, HUMAN)).toBeNull();
    expect(findRegisteredActor(root, '')).toBeNull();
  });

  it('refuses a file whose own session is the id, even if its lineage names it', () => {
    const root = contextRoot({ register: false });
    writeFileSync(join(root, 'tmp', `.goal-skill-live.${ORCH}.json`), JSON.stringify({
      phase: 'impl', session: ORCH, lineage: [{ a: 'lead', role: 'lead', k: 'spawn', sid: ORCH }],
    }));
    expect(findRegisteredActor(root, ORCH)).toBeNull();
  });

  it('skips malformed files and never throws on a missing tmp/', () => {
    const root = contextRoot({ register: false });
    writeFileSync(join(root, 'tmp', '.goal-skill-live.bad.json'), '{not json');
    expect(findRegisteredActor(root, BUILDER)).toBeNull();
    expect(findRegisteredActor(join(root, 'nope'), BUILDER)).toBeNull();
  });

  it('refuses a symlinked live file and a symlinked tmp/ directory', () => {
    const elsewhere = contextRoot();
    const root = contextRoot({ register: false });
    symlinkSync(join(elsewhere, 'tmp', `.goal-skill-live.${ORCH}.json`), join(root, 'tmp', `.goal-skill-live.${ORCH}.json`));
    expect(findRegisteredActor(root, BUILDER)).toBeNull();

    const linkedRoot = mkdtempSync(join(tmpdir(), 'dc-origin-link-'));
    dirs.push(linkedRoot);
    symlinkSync(join(elsewhere, 'tmp'), join(linkedRoot, 'tmp'));
    expect(findRegisteredActor(linkedRoot, BUILDER)).toBeNull();
  });
});

// ─── The ancestry walk ────────────────────────────────────────────────────────

function table(rows: Array<[number, number, string]>): Map<number, PsRow> {
  return new Map(rows.map(([pid, ppid, command]) => [pid, { ppid, command }]));
}

const SERVER = 500;

/** Unpinned pane: the human's own claude under the server, with a Claude Code session ABOVE
 *  the server (this repo's dogfooding setup). */
const UNPINNED_PANE = table([
  [110, 100, '/bin/sh -c dreamcontext hook stop'],
  [100, SERVER, '/Users/x/.local/bin/claude --input-format stream-json'],
  [SERVER, 400, 'node dist/index.js dashboard'],
  [400, 300, 'zsh'],
  [300, 1, 'claude'],
]);

/** Pinned pane: an ad-hoc synchronous `claude -p` the pane's agent ran through Bash. */
const PINNED_NESTED = table([
  [110, 100, '/bin/sh -c dreamcontext hook stop'],
  [100, 90, 'claude -p "summarize this"'],
  [90, 80, '/bin/zsh -c claude -p "summarize this"'],
  [80, SERVER, '/Users/x/.local/bin/claude --resume abc'],
  [SERVER, 1, 'node dist/index.js dashboard'],
]);

describe('parsePsTable / isNestedInProcessTable', () => {
  it('parses ps output and skips junk lines', () => {
    const t = parsePsTable('  100   90 claude -p hi\nnot a row\n   90    1 /bin/zsh\n');
    expect(t.get(100)).toEqual({ ppid: 90, command: 'claude -p hi' });
    expect(t.get(90)).toEqual({ ppid: 1, command: '/bin/zsh' });
    expect(t.size).toBe(2);
  });

  it('an unpinned pane with a claude above the server is NOT nested when the boundary is set', () => {
    expect(isNestedInProcessTable(UNPINNED_PANE, 110, SERVER)).toBe(false);
  });

  it('the same pane without a boundary reads as nested (why the server stamps its pid)', () => {
    expect(isNestedInProcessTable(UNPINNED_PANE, 110, null)).toBe(true);
  });

  it('a claude -p nested under a pinned pane is nested', () => {
    expect(isNestedInProcessTable(PINNED_NESTED, 110, SERVER)).toBe(true);
  });

  it('does not count path fragments like ~/.claude/ as a claude', () => {
    const t = table([
      [110, 100, '/bin/sh'],
      [100, 90, 'claude'],
      [90, 1, 'node /Users/x/.claude/plugins/thing.js'],
    ]);
    expect(isNestedInProcessTable(t, 110, null)).toBe(false);
  });
});

describe('resolveSpawnMarker precedence', () => {
  it('env wins over everything, without consulting the rest', () => {
    const known = { spawn: undefined };
    expect(resolveSpawnMarker({
      env: { [SPAWNED_ENV]: 'develop' }, contextRoot: contextRoot(), sessionId: BUILDER, isNested: never, known,
    })).toEqual({ by: 'develop', via: 'env' });
  });

  it('a stored record short-circuits goal-live and the walk', () => {
    const root = contextRoot();
    expect(resolveSpawnMarker({ env: {}, contextRoot: root, sessionId: BUILDER, isNested: never, known: {} })).toBeNull();
    expect(resolveSpawnMarker({
      env: {}, contextRoot: root, sessionId: HUMAN, isNested: never, known: { spawn: { by: 'goal-skill', via: 'goal-live' } },
    })).toEqual({ by: 'goal-skill', via: 'goal-live' });
  });

  it('goal-live registration beats ancestry and maps the run mode', () => {
    expect(resolveSpawnMarker({ env: {}, contextRoot: contextRoot({ mode: 'develop' }), sessionId: BUILDER, isNested: never }))
      .toEqual({ by: 'develop', via: 'goal-live' });
    expect(resolveSpawnMarker({ env: {}, contextRoot: contextRoot(), sessionId: BUILDER, isNested: never }))
      .toEqual({ by: 'goal-skill', via: 'goal-live' });
  });

  it('ancestry is last, called once, and applies regardless of DREAMCONTEXT_TAB_SESSION', () => {
    const isNested = vi.fn(() => true);
    expect(resolveSpawnMarker({
      env: { DREAMCONTEXT_TAB_SESSION: HUMAN }, contextRoot: contextRoot(), sessionId: HUMAN, isNested,
    })).toEqual({ by: 'nested', via: 'ancestry' });
    expect(isNested).toHaveBeenCalledTimes(1);
  });

  it('the orchestrator itself is never marked', () => {
    expect(resolveSpawnMarker({ env: {}, contextRoot: contextRoot(), sessionId: ORCH, isNested: () => false })).toBeNull();
  });

  it('boundary tables end to end: unpinned human pane is null, pinned nested child is nested', () => {
    const root = contextRoot({ register: false });
    expect(resolveSpawnMarker({
      env: {}, contextRoot: root, sessionId: HUMAN, isNested: () => isNestedInProcessTable(UNPINNED_PANE, 110, SERVER),
    })).toBeNull();
    expect(resolveSpawnMarker({
      env: { DREAMCONTEXT_TAB_SESSION: HUMAN }, contextRoot: root, sessionId: HUMAN,
      isNested: () => isNestedInProcessTable(PINNED_NESTED, 110, SERVER),
    })).toEqual({ by: 'nested', via: 'ancestry' });
  });

  it('a null context root or session id skips goal-live without throwing', () => {
    expect(resolveSpawnMarker({ env: {}, contextRoot: null, sessionId: null, isNested: () => false })).toBeNull();
  });
});

// Pins tests/setup/isolate-spawn-env.ts. Re-run with an inherited marker and a foreign boundary
// to prove the setup overwrites rather than defaults:
//   DREAMCONTEXT_SERVER_PID=1 DREAMCONTEXT_SPAWNED=develop npx vitest run tests/unit/session-origin.test.ts
describe('test env isolation', () => {
  it('the walk boundary is this worker and no spawn marker survives into the suite', () => {
    expect(process.env.DREAMCONTEXT_SERVER_PID).toBe(String(process.pid));
    for (const key of SPAWN_ENV_KEYS) expect(process.env[key], key).toBeUndefined();
  });
});
