import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateFrontmatterFields } from '../../src/lib/frontmatter.js';
import {
  readVerdicts,
  writeVerdicts,
  acquireVerdictsLock,
  withVerdictsLock,
  getVerdictsLockPath,
  VerdictsLockError,
  parseOptionsSpec,
  resolveStanceKey,
  leadingStance,
  convergence,
  stanceShift,
  updateCouncilLive,
  clearCouncilLive,
  readCouncilLive,
  getCouncilLivePath,
  Verdict,
  VerdictsFile,
  VerdictOption,
} from '../../src/lib/council.js';

let root: string;
const origCwd = process.cwd();
const origSession = process.env.CLAUDE_CODE_SESSION_ID;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-council-verdicts-'));
  process.chdir(root);
  root = process.cwd(); // resolved path (macOS /var → /private/var)
  mkdirSync(join(root, '_dream_context', 'council'), { recursive: true });
  process.env.CLAUDE_CODE_SESSION_ID = 'test-session-uuid';
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
  if (origSession === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_ID;
  } else {
    process.env.CLAUDE_CODE_SESSION_ID = origSession;
  }
});

function scaffoldDebate(
  id: string,
  opts: {
    personas?: string[];
    rounds?: number;
    currentRound?: number;
    options?: VerdictOption[];
  } = {},
): string {
  const dir = join(root, '_dream_context', 'council', id);
  mkdirSync(dir, { recursive: true });
  const personas = opts.personas ?? [];
  const optionsYaml = opts.options
    ? `options:\n${opts.options.map((o) => `  - key: "${o.key}"\n    label: "${o.label}"`).join('\n')}\n`
    : '';
  writeFileSync(
    join(dir, 'debate.md'),
    `---
id: "${id}"
topic: "Should we drop ClickUp sync?"
status: "created"
rounds_planned: ${opts.rounds ?? 3}
current_round: ${opts.currentRound ?? 0}
interrupt_between_rounds: false
personas: [${personas.map((p) => `"${p}"`).join(', ')}]
${optionsYaml}promoted_to_knowledge: null
created_at: "2026-07-23"
updated_at: "2026-07-23"
---

## Question

Should we drop ClickUp sync?

## Constraints & Known Facts

(none)
`,
    'utf-8',
  );
  for (const p of personas) {
    const pd = join(dir, p);
    mkdirSync(pd, { recursive: true });
    writeFileSync(
      join(pd, 'context-and-persona.md'),
      `---\nname: "${p}"\nmodel: "sonnet"\naspects: []\nround_entries: 0\n---\n\n## Persona\n\nx\n`,
      'utf-8',
    );
  }
  return dir;
}

function v(stance: string, conviction: number, headline = 'h'): Verdict {
  return { stance, conviction, headline, at: '2026-07-23T00:00:00.000Z' };
}

// ─── verdicts.json IO ───────────────────────────────────────────────────────

describe('verdicts IO', () => {
  it('returns an empty structure for a v1 debate without verdicts.json', () => {
    scaffoldDebate('council_v1');
    expect(readVerdicts('council_v1')).toEqual({ options: [], rounds: {} });
  });

  it('roundtrips options and rounds', () => {
    scaffoldDebate('council_rt');
    const file: VerdictsFile = {
      options: [
        { key: 'A', label: 'Keep sync' },
        { key: 'B', label: 'Drop it' },
      ],
      rounds: { '1': { auditor: v('B', 82) } },
    };
    writeVerdicts('council_rt', file);
    expect(readVerdicts('council_rt')).toEqual(file);
  });

  it('rejects unsafe debate ids (path traversal)', () => {
    expect(() => readVerdicts('../evil')).toThrow(/path separator/);
  });
});

// ─── options parsing ────────────────────────────────────────────────────────

describe('parseOptionsSpec', () => {
  it('parses "A=Keep sync,B=Drop it"', () => {
    expect(parseOptionsSpec('A=Keep sync,B=Drop it')).toEqual([
      { key: 'A', label: 'Keep sync' },
      { key: 'B', label: 'Drop it' },
    ]);
  });

  it('trims whitespace around keys and labels', () => {
    expect(parseOptionsSpec(' A = Keep sync , B = Drop it ')).toEqual([
      { key: 'A', label: 'Keep sync' },
      { key: 'B', label: 'Drop it' },
    ]);
  });

  it('rejects a single option', () => {
    expect(() => parseOptionsSpec('A=Only one')).toThrow(/at least two/);
  });

  it('rejects entries without KEY=Label shape', () => {
    expect(() => parseOptionsSpec('A=Keep,Broken')).toThrow(/Invalid option/);
    expect(() => parseOptionsSpec('A=Keep,=NoKey')).toThrow(/Invalid option/);
  });

  it('rejects duplicate keys case-insensitively', () => {
    expect(() => parseOptionsSpec('A=Keep,a=Drop')).toThrow(/Duplicate option key/);
  });
});

// ─── stance resolution ──────────────────────────────────────────────────────

describe('resolveStanceKey', () => {
  const registered: VerdictsFile = {
    options: [
      { key: 'A', label: 'Keep sync' },
      { key: 'B', label: 'Drop it' },
    ],
    rounds: {},
  };

  it('matches registered keys case-insensitively and returns the canonical key', () => {
    expect(resolveStanceKey(registered, true, 'b')).toEqual({ key: 'B', addedOption: null });
  });

  it('rejects an unknown stance with a helpful listing', () => {
    expect(() => resolveStanceKey(registered, true, 'C')).toThrow(/A \(Keep sync\), B \(Drop it\)/);
  });

  it('free-form: first-seen stance becomes a dynamic option (slug key, original label)', () => {
    const file: VerdictsFile = { options: [], rounds: {} };
    const r = resolveStanceKey(file, false, 'Keep ClickUp Sync');
    expect(r.key).toBe('keep-clickup-sync');
    expect(r.addedOption).toEqual({ key: 'keep-clickup-sync', label: 'Keep ClickUp Sync' });
  });

  it('free-form: repeated stance strings reuse the existing dynamic option', () => {
    const file: VerdictsFile = {
      options: [{ key: 'keep-clickup-sync', label: 'Keep ClickUp Sync' }],
      rounds: {},
    };
    const r = resolveStanceKey(file, false, 'keep clickup SYNC');
    expect(r.key).toBe('keep-clickup-sync');
    expect(r.addedOption).toBeNull();
  });
});

// ─── derived metrics ────────────────────────────────────────────────────────

describe('leadingStance', () => {
  it('returns null for empty / missing rounds', () => {
    expect(leadingStance({})).toBeNull();
    expect(leadingStance(null)).toBeNull();
    expect(leadingStance(undefined)).toBeNull();
  });

  it('single persona: its stance leads', () => {
    expect(leadingStance({ solo: v('A', 10) })).toBe('A');
  });

  it('max summed conviction wins, not headcount', () => {
    expect(
      leadingStance({ p1: v('A', 40), p2: v('A', 40), p3: v('B', 90) }),
    ).toBe('B');
  });

  it('ties break deterministically (alphabetical)', () => {
    expect(leadingStance({ p1: v('B', 50), p2: v('A', 50) })).toBe('A');
  });
});

describe('convergence', () => {
  it('is 0 when the round is empty', () => {
    expect(convergence({})).toBe(0);
    expect(convergence(null)).toBe(0);
  });

  it('is 0 when all convictions are 0 (no NaN)', () => {
    expect(convergence({ p1: v('A', 0), p2: v('B', 0) })).toBe(0);
  });

  it('is 100 for a single persona', () => {
    expect(convergence({ solo: v('A', 42) })).toBe(100);
  });

  it('rounds the leading share of total conviction', () => {
    // B: 82 + 71 = 153, A: 45 → total 198 → 77.27 → 77
    expect(convergence({ a: v('B', 82), b: v('B', 71), c: v('A', 45) })).toBe(77);
  });
});

describe('stanceShift', () => {
  it('is null per persona when there is no prior round', () => {
    expect(stanceShift(null, { p1: v('A', 50) })).toEqual({ p1: null });
    expect(stanceShift(undefined, { p1: v('A', 50) })).toEqual({ p1: null });
  });

  it('is null for a persona missing from the prior round', () => {
    const out = stanceShift({ p1: v('A', 60) }, { p1: v('A', 70), late: v('B', 40) });
    expect(out.late).toBeNull();
    expect(out.p1).toEqual({ from: 'A', to: 'A', convictionDelta: 10 });
  });

  it('captures stance changes and conviction deltas', () => {
    const out = stanceShift({ p1: v('A', 64) }, { p1: v('B', 82) });
    expect(out.p1).toEqual({ from: 'A', to: 'B', convictionDelta: 18 });
  });

  it('handles an empty current round', () => {
    expect(stanceShift({ p1: v('A', 64) }, {})).toEqual({});
  });
});

// ─── verdicts lock ──────────────────────────────────────────────────────────

describe('verdicts lock', () => {
  const id = 'council_lock';

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  it('waits for a lock held by a live process, then succeeds', async () => {
    scaffoldDebate(id);
    const lockPath = getVerdictsLockPath(id);
    writeFileSync(lockPath, String(process.pid), 'utf-8'); // live holder
    setTimeout(() => rmSync(lockPath, { force: true }), 100); // holder releases

    let ran = false;
    await withVerdictsLock(id, () => { ran = true; }, { spinMs: 10, timeoutMs: 2000 });
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false); // released
  });

  it('fails loudly with a retry hint when the lock stays held past the timeout', async () => {
    scaffoldDebate(id);
    writeFileSync(getVerdictsLockPath(id), String(process.pid), 'utf-8');
    await expect(
      acquireVerdictsLock(id, { spinMs: 20, timeoutMs: 150 }),
    ).rejects.toThrow(VerdictsLockError);
    await expect(
      acquireVerdictsLock(id, { spinMs: 20, timeoutMs: 150 }),
    ).rejects.toThrow(/Retry the same/);
  });

  it('reclaims a stale lock left by a dead PID', async () => {
    scaffoldDebate(id);
    writeFileSync(getVerdictsLockPath(id), '999999999', 'utf-8'); // no such process
    let ran = false;
    await withVerdictsLock(id, () => { ran = true; }, { spinMs: 10, timeoutMs: 200 });
    expect(ran).toBe(true);
  });

  it('reclaims a lock past the TTL even when the holder PID is alive', async () => {
    scaffoldDebate(id);
    const lockPath = getVerdictsLockPath(id);
    writeFileSync(lockPath, String(process.pid), 'utf-8');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath, old, old); // 60s old
    let ran = false;
    await withVerdictsLock(id, () => { ran = true; }, { spinMs: 10, timeoutMs: 200, staleMs: 500 });
    expect(ran).toBe(true);
  });

  it('always releases: after success and after an error inside the critical section', async () => {
    scaffoldDebate(id);
    const lockPath = getVerdictsLockPath(id);

    await withVerdictsLock(id, () => 'ok');
    expect(existsSync(lockPath)).toBe(false);

    await expect(
      withVerdictsLock(id, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('serializes concurrent read-modify-writes (no lost update)', async () => {
    scaffoldDebate(id);
    writeVerdicts(id, { options: [{ key: 'A', label: 'Keep' }, { key: 'B', label: 'Drop' }], rounds: {} });

    const submit = (slug: string, stance: string) =>
      withVerdictsLock(
        id,
        async () => {
          const verdicts = readVerdicts(id);
          await sleep(30); // widen the race window: unlocked, one write clobbers the other
          if (!verdicts.rounds['1']) verdicts.rounds['1'] = {};
          verdicts.rounds['1'][slug] = v(stance, 50);
          writeVerdicts(id, verdicts);
        },
        { spinMs: 5, timeoutMs: 2000 },
      );

    await Promise.all([submit('auditor', 'A'), submit('advocate', 'B')]);
    const final = readVerdicts(id);
    expect(Object.keys(final.rounds['1']).sort()).toEqual(['advocate', 'auditor']);
  });
});

// ─── live-file lifecycle ────────────────────────────────────────────────────

describe('.council-live.json lifecycle', () => {
  const id = 'council_live1';

  function debateFile(): string {
    return join(root, '_dream_context', 'council', id, 'debate.md');
  }

  it('walks the phases create → round start → verdict → round end → synthesize → complete', () => {
    scaffoldDebate(id, { personas: ['auditor', 'advocate'], rounds: 2, currentRound: 0 });

    // create → setup
    updateCouncilLive(id, { phase: 'setup' });
    let live = readCouncilLive();
    expect(live).not.toBeNull();
    expect(live!.debate).toBe(id);
    expect(live!.topic).toBe('Should we drop ClickUp sync?');
    expect(live!.session).toBe('test-session-uuid');
    expect(live!.phase).toBe('setup');
    expect(live!.round).toBe(0);
    expect(live!.rounds).toBe(2);
    expect(live!.personas.map((p) => p.state)).toEqual(['wait', 'wait']);
    expect(live!.personas[0].model).toBe('sonnet');
    const started = live!.started;

    // round start → debate, all think
    updateFrontmatterFields(debateFile(), { current_round: 1, status: 'round_1_running' });
    updateCouncilLive(id, { phase: 'debate', setAll: 'think' });
    live = readCouncilLive();
    expect(live!.phase).toBe('debate');
    expect(live!.round).toBe(1);
    expect(live!.personas.map((p) => p.state)).toEqual(['think', 'think']);
    expect(live!.started).toBe(started); // preserved across updates

    // verdict → that persona done, verdict data on the row
    const verdicts: VerdictsFile = {
      options: [
        { key: 'A', label: 'Keep sync' },
        { key: 'B', label: 'Drop it' },
      ],
      rounds: { '1': { auditor: v('B', 82, 'drop it now') } },
    };
    writeVerdicts(id, verdicts);
    updateCouncilLive(id, { setPersona: { auditor: 'done' } });
    live = readCouncilLive();
    const auditor = live!.personas.find((p) => p.slug === 'auditor')!;
    const advocate = live!.personas.find((p) => p.slug === 'advocate')!;
    expect(auditor.state).toBe('done');
    expect(auditor.stance).toBe('B');
    expect(auditor.conviction).toBe(82);
    expect(auditor.headline).toBe('drop it now');
    expect(auditor.prevStance).toBeUndefined(); // no prior round — key omitted
    expect(advocate.state).toBe('think');
    expect(advocate.stance).toBeUndefined();
    expect(advocate.headline).toBeUndefined(); // no verdict → field absent
    expect(live!.convergence).toBe(100);
    expect(live!.leading).toBe('B');
    expect(live!.options).toHaveLength(2);

    // round end → interlude, all wait
    updateCouncilLive(id, { phase: 'interlude', setAll: 'wait' });
    live = readCouncilLive();
    expect(live!.phase).toBe('interlude');
    expect(live!.personas.map((p) => p.state)).toEqual(['wait', 'wait']);

    // round 2 with a stance shift → prev* populated; long headlines truncated
    verdicts.rounds['2'] = { auditor: v('A', 45, 'changed my mind'), advocate: v('A', 70, 'k'.repeat(120)) };
    writeVerdicts(id, verdicts);
    updateFrontmatterFields(debateFile(), { current_round: 2, status: 'round_2_running' });
    updateCouncilLive(id, { phase: 'debate', setAll: 'think' });
    live = readCouncilLive();
    const auditor2 = live!.personas.find((p) => p.slug === 'auditor')!;
    const advocate2 = live!.personas.find((p) => p.slug === 'advocate')!;
    expect(auditor2.stance).toBe('A');
    expect(auditor2.prevStance).toBe('B');
    expect(auditor2.prevConviction).toBe(82);
    expect(auditor2.headline).toBe('changed my mind');
    expect(advocate2.headline).toHaveLength(80); // 79 chars + ellipsis
    expect(advocate2.headline!.endsWith('…')).toBe(true);
    expect(live!.leading).toBe('A');

    // synthesize → synthesis; complete → done (file stays)
    updateCouncilLive(id, { phase: 'synthesis' });
    expect(readCouncilLive()!.phase).toBe('synthesis');
    updateCouncilLive(id, { phase: 'done' });
    live = readCouncilLive();
    expect(live!.phase).toBe('done');
    expect(existsSync(getCouncilLivePath())).toBe(true);
    expect(live!.started).toBe(started);
  });

  it('stamps an empty session when CLAUDE_CODE_SESSION_ID is unset', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    scaffoldDebate(id, { personas: ['auditor'] });
    updateCouncilLive(id, { phase: 'setup' });
    expect(readCouncilLive()!.session).toBe('');
  });

  it('re-creates the tmp dir when missing', () => {
    scaffoldDebate(id, { personas: ['auditor'] });
    rmSync(join(root, '_dream_context', 'tmp'), { recursive: true, force: true });
    updateCouncilLive(id, { phase: 'setup' });
    expect(existsSync(getCouncilLivePath())).toBe(true);
  });

  it('swallows write failures (tmp path blocked by a file)', () => {
    scaffoldDebate(id, { personas: ['auditor'] });
    rmSync(join(root, '_dream_context', 'tmp'), { recursive: true, force: true });
    writeFileSync(join(root, '_dream_context', 'tmp'), 'not a dir', 'utf-8');
    expect(() => updateCouncilLive(id, { phase: 'setup' })).not.toThrow();
    expect(() => clearCouncilLive()).not.toThrow();
  });

  it('never throws for a nonexistent debate (telemetry, not a gate)', () => {
    expect(() => updateCouncilLive('council_ghost', { phase: 'setup' })).not.toThrow();
  });

  it('live clear removes the file and is idempotent', () => {
    scaffoldDebate(id, { personas: ['auditor'] });
    updateCouncilLive(id, { phase: 'setup' });
    expect(existsSync(getCouncilLivePath())).toBe(true);
    clearCouncilLive();
    expect(existsSync(getCouncilLivePath())).toBe(false);
    expect(() => clearCouncilLive()).not.toThrow();
  });

  it('switching debates resets started and persona states', () => {
    scaffoldDebate(id, { personas: ['auditor'] });
    updateCouncilLive(id, { phase: 'debate', setAll: 'think' });
    const first = readCouncilLive()!;

    scaffoldDebate('council_live2', { personas: ['cfo'] });
    updateCouncilLive('council_live2');
    const second = readCouncilLive()!;
    expect(second.debate).toBe('council_live2');
    expect(second.phase).toBe('setup'); // no carry-over from the other debate
    expect(second.personas.map((p) => p.state)).toEqual(['wait']);
    expect(second.started >= first.started).toBe(true);
  });
});
