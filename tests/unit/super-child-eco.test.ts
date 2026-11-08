/**
 * A Super child's Eco handoff (field 2026-11-08: of 41 children past the 300k line, 28 never handed
 * off). Three of the four causes are pinned here; the fourth, the nudge riding every Bash and Agent
 * call, is pinned by spawning the built hook:
 *   - the fresh session opens in the brain's folder, so the record, its continue prompt and its
 *     banner name the child's worktree and branch;
 *   - the Super hears that a child rotated, on its next event about that child;
 *   - PreToolUse carries the nudge (additionalContext) at the threshold and again per remindEvery,
 *     never to a sub-agent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handoffContinuePrompt, readHandoffRecord, renderHandoffBanner, writeHandoffRecord, type HandoffRecord,
} from '../../src/lib/context-watch.js';
import { childHandoffLine } from '../../src/lib/super/inbox.js';

const PANE = '11111111-2222-3333-4444-555555555555';
const SES = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-child-eco-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

const WT = join(homedir(), '.claude-worktrees', 'p-super-odev');
const base: HandoffRecord = { task: 'odev-ver-akisi', title: 'Ödev Ver akışı', at: '2026-11-08T15:00:00.000Z', contextTokens: 412_000, fromSession: SES, tab: PANE };

describe('the record sends a child\'s fresh session back to its worktree', () => {
  it('worktree and branch round-trip and are named in the continue prompt and the banner', () => {
    writeHandoffRecord(contextRoot, PANE, { ...base, worktree: WT, branch: 'super/odev' });
    const rec = readHandoffRecord(contextRoot, PANE)!;
    expect(rec.worktree).toBe(WT);
    expect(rec.branch).toBe('super/odev');
    const prompt = handoffContinuePrompt(rec);
    expect(prompt).toContain('Read _dream_context/state/odev-ver-akisi.md first');
    expect(prompt).toContain(`worktree ${WT} (branch super/odev): cd there first`);
    expect(renderHandoffBanner(rec)).toContain('cd there first');
  });

  it('a record with no worktree reads exactly as before', () => {
    writeHandoffRecord(contextRoot, PANE, base);
    const rec = readHandoffRecord(contextRoot, PANE)!;
    expect(rec).not.toHaveProperty('worktree');
    expect(handoffContinuePrompt(rec)).toBe('Handoff: continue task Ödev Ver akışı (odev-ver-akisi). Read _dream_context/state/odev-ver-akisi.md first, then carry on from its latest changelog entry.');
  });

  it('a record read through a symlink is not read at all', () => {
    const real = join(projectRoot, 'elsewhere.json');
    writeFileSync(real, JSON.stringify({ ...base, worktree: WT }));
    mkdirSync(join(contextRoot, 'state', '.handoff-requests'), { recursive: true });
    symlinkSync(real, join(contextRoot, 'state', '.handoff-requests', `${PANE}.json`));
    expect(readHandoffRecord(contextRoot, PANE)).toBeNull();
  });

  it('a worktree that is not a plain absolute path is dropped, and a branch never rides alone', () => {
    writeHandoffRecord(contextRoot, PANE, { ...base, worktree: '/tmp/a"; rm -rf ~', branch: 'super/x' });
    const rec = readHandoffRecord(contextRoot, PANE)!;
    expect(rec).not.toHaveProperty('worktree');
    expect(rec).not.toHaveProperty('branch');
    expect(handoffContinuePrompt(rec)).not.toContain('rm -rf');
  });
});

describe('the Super hears that a child handed off', () => {
  it('one line once the pane rotated (actedAt), none before, none for the Super\'s own record', () => {
    writeHandoffRecord(contextRoot, PANE, base);
    expect(childHandoffLine(contextRoot, PANE)).toBeNull();
    writeHandoffRecord(contextRoot, PANE, { ...base, actedAt: '2026-11-08T15:01:30.000Z' });
    expect(childHandoffLine(contextRoot, PANE)).toBe('It handed off at ~412k tokens (2026-11-08 15:01 UTC): a fresh session continues in the same pane as the same child, nothing to do.');
    writeHandoffRecord(contextRoot, PANE, { ...base, kind: 'super', actedAt: '2026-11-08T15:01:30.000Z' });
    expect(childHandoffLine(contextRoot, PANE)).toBeNull();
    expect(childHandoffLine(contextRoot, 'no-such-pane')).toBeNull();
  });
});

const CLI = join(__dirname, '../../dist/index.js');

describe('PreToolUse carries the nudge (built CLI)', () => {
  const run = (payload: Record<string, unknown>) => spawnSync(process.execPath, [CLI, 'hook', 'pre-tool-use'], {
    cwd: projectRoot,
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, HOME: projectRoot },
    timeout: 30_000,
  });
  const transcript = (tokens: number) => {
    const p = join(projectRoot, 't.jsonl');
    writeFileSync(p, `${JSON.stringify({ message: { usage: { cache_read_input_tokens: tokens } } })}\n`);
    return p;
  };
  const bash = (p: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: SES, transcript_path: p, ...extra });
  const nudgeOf = (out: string): string | null => {
    if (!out.trim()) return null;
    const j = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string; permissionDecision?: string } };
    expect(j.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(j.hookSpecificOutput?.permissionDecision).toBeUndefined();
    return j.hookSpecificOutput?.additionalContext ?? null;
  };

  it.skipIf(!existsSync(CLI))('fires at the threshold before a Bash call, then again only per remindEvery; a sub-agent never hears it', () => {
    writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '1', contextHandoff: { enabled: true, nudgeAt: 3000, hardAt: 9000, remindEvery: 2000 } }));
    expect(nudgeOf(run(bash(transcript(2900))).stdout)).toBeNull();
    const first = nudgeOf(run(bash(transcript(3500))).stdout);
    expect(first).toContain('[context handoff]');
    expect(nudgeOf(run(bash(transcript(4000))).stdout)).toBeNull();
    expect(nudgeOf(run(bash(transcript(5600))).stdout)).toContain('~6k context tokens');
    expect(nudgeOf(run(bash(transcript(9000), { agent_id: 'sub-1', agent_type: 'reviewer' })).stdout)).toBeNull();
    // The Agent tool is gated by the same hook: it carries the nudge too.
    expect(nudgeOf(run({ tool_name: 'Agent', tool_input: { subagent_type: 'reviewer' }, session_id: SES, transcript_path: transcript(9500) }).stdout)).toContain('HAND OFF NOW');
  }, 60_000);

  it.skipIf(!existsSync(CLI))('Eco off: a Bash call prints nothing at all', () => {
    writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '1', contextHandoff: { enabled: false } }));
    expect(run(bash(transcript(900_000))).stdout).toBe('');
  });
});
