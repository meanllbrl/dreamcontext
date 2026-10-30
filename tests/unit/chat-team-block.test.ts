/**
 * The chat spawn and the AI Team (task super-agent-isi-bolerken-…, plan r8 §A/§D): the Super Agent
 * gets its own `## Your AI Team` block and no `--agents`; a resumed or compacted Super gets the
 * block on the owner's next message once per change; an ordinary tab gets the routing rule; a
 * Super's child keeps today's wording; DREAMCONTEXT_TEAM_ROUTE is set on every spawn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/chat-team-block-home-`);
});

const spawned: Array<{ child: FakeChild; script: string; env: Record<string, string | undefined> }> = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4250;
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((_shell: string, args: string[], opts?: { env?: Record<string, string | undefined> }) => {
      const child = new FakeChild();
      // win32 spawns the chat's claude directly (argv starts with -p, chatSpawnCommand): present it
      // as the POSIX login-shell script these tests read.
      const script = process.platform === 'win32' && args?.[0] === '-p'
        ? `exec claude ${args.map((x) => `"${x}"`).join(' ')}`
        : String(args?.[1] ?? '');
      spawned.push({ child, script, env: opts?.env ?? {} });
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});
// A single-account machine: `maybeSwitchAccount` never probes or holds.
vi.mock('../../src/lib/claude-accounts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-accounts.js')>();
  return { ...real, listClaudeAccounts: vi.fn(() => []) };
});
vi.mock('../../src/lib/claude-limit-rejections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-limit-rejections.js')>();
  return { ...real, readAccountRejections: vi.fn(() => ({})) };
});
vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  const probe = vi.fn(async () => ({ status: 'healthy-unmeasured', reason: 'test' }));
  return { ...real, probeAccountUsage: probe, probeAccountForDecision: probe };
});

const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { SUPER_STATE_REL, readSuperState, resetSuperIndex } = await import('../../src/lib/super/store.js');
const { emptySuperState, SUPER_BRIEF_MARKER } = await import('../../src/lib/super/types.js');
const { _resetSuperInbox } = await import('../../src/lib/super/inbox.js');
const { cpSync } = await import('node:fs');
const { homedir } = await import('node:os');
const { getAutomation } = await import('../../src/lib/automations/store.js');
const { approveAutomation } = await import('../../src/lib/automations/registry.js');
const { ORBIT_FIXTURE, TEAM_OVERLAY } = await import('../../eval/super-team-routing/setup.js');
const { SUPER_ORCHESTRATION_GUIDE_PATH, superBriefing } = await import('../../src/server/chat-modes.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const SUPER = '11111111-2222-4333-8444-555555555555';
const CHILD = '66666666-7777-4888-8999-aaaaaaaaaaaa';
let project: string;
let root: string;

async function record(state: Record<string, unknown>): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, ...state }));
  await readSuperState(root);
}

function start(o: { sessionId: string; mode: string; bypass?: boolean; resumeId?: string; leanMcp?: string[] }) {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, project, {
    bypass: o.bypass ?? false, sessionId: o.sessionId, resumeId: o.resumeId ?? '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode: o.mode as never, vault: 'acme', ...(o.leanMcp ? { leanMcp: o.leanMcp } : {}),
  });
  return { ws, ...spawned[spawned.length - 1] };
}

/** Every user frame the child's stdin received, as its content blocks' texts. */
function userFrames(child: FakeChild): string[][] {
  return child.stdin.write.mock.calls
    .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
    .filter((f) => f?.type === 'user')
    .map((f) => (f.message.content as Array<{ text: string }>).map((b) => b.text));
}
const owner = (ws: FakeWs, text: string) => ws.emit('message', JSON.stringify({ type: 'user', text }));


const SUPER_ID = SUPER;
let teamOn = false;
/** The eval's Orbit fixture, its team approved in this HOME (Atlas not). */
function orbit(team: boolean): void {
  cpSync(ORBIT_FIXTURE, project, { recursive: true });
  if (!team) return;
  cpSync(TEAM_OVERLAY, project, { recursive: true });
  for (const slug of ['ledger', 'probe', 'lookout']) approveAutomation(project, getAutomation(root, slug)!, new Date());
  teamOn = true;
}
const argvOf = (script: string): string[] => [...script.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
function briefingOf(script: string): string {
  const a = argvOf(script);
  const i = a.indexOf('--append-system-prompt-file');
  return i >= 0 ? readFileSync(a[i + 1], 'utf-8') : '';
}
const agentsArg = (script: string): boolean => argvOf(script).includes('--agents');
/** A transcript claude would resume: its system-prompt snapshot (a Super born before this change). */
function transcript(id: string, systemPrompt: string, extra: string[] = []): void {
  const dir = join(homedir(), '.claude', 'projects', 'x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), [JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt } }), ...extra].join('\n') + '\n');
}
const lastFrame = (proc: FakeChild): string[] => { const f = userFrames(proc); return f[f.length - 1] ?? []; };

beforeEach(() => {
  spawned.length = 0;
  teamOn = false;
  project = mkdtempSync(join(tmpdir(), 'chat-team-block-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
});
afterEach(() => {
  while (spawned.length) spawned.shift()!.child.emit('close', 0);
  _resetSuperInbox();
  rmSync(project, { recursive: true, force: true });
  rmSync(join(homedir(), '.claude'), { recursive: true, force: true });
});

describe('the Super Agent\'s spawn: its own team block, no --agents, the super route', () => {
  it('a project with a team: one ## Your AI Team block, no generic roster, no --agents, DREAMCONTEXT_TEAM_ROUTE=super', { timeout: 30_000 }, async () => {
    orbit(true);
    await record({ enabled: true });
    const { script, env } = start({ sessionId: SUPER_ID, mode: 'super' });
    const brief = briefingOf(script);
    expect(brief.match(/^## Your AI Team <!-- fp=[0-9a-f]{12} -->$/gm)).toHaveLength(1);
    expect(brief).not.toMatch(/^## This project's agents/m);
    expect(brief).toContain('- `ledger` Ledger · ready:');
    expect(brief).toContain('- `atlas` Atlas · needs approval:');
    expect(agentsArg(script)).toBe(false);
    expect(env.DREAMCONTEXT_TEAM_ROUTE).toBe('super');
  });

  it('a team-less project: no block, no --agents, no roster', { timeout: 30_000 }, async () => {
    orbit(false);
    await record({ enabled: true });
    const { script, env } = start({ sessionId: SUPER_ID, mode: 'super' });
    const brief = briefingOf(script);
    expect(brief).not.toContain('Your AI Team <!--');
    expect(brief).not.toMatch(/^## This project's agents/m);
    expect(agentsArg(script)).toBe(false);
    expect(env.DREAMCONTEXT_TEAM_ROUTE).toBe('super');
  });

  it('a fresh Super holds its team: the next owner message carries no <super-team>; a changed team rides once', { timeout: 30_000 }, async () => {
    orbit(true);
    await record({ enabled: true });
    const { ws, child: proc } = start({ sessionId: SUPER_ID, mode: 'super' });
    owner(ws, 'hello');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(1), { timeout: 10_000 });
    expect(lastFrame(proc).some((t) => t.startsWith('<super-team'))).toBe(false);
    // Atlas approved since: the team changed.
    approveAutomation(project, getAutomation(root, 'atlas')!, new Date());
    owner(ws, 'and now?');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(2), { timeout: 10_000 });
    const team = lastFrame(proc).filter((t) => t.startsWith('<super-team fp='));
    expect(team).toHaveLength(1);
    expect(team[0]).toContain('- `atlas` Atlas · ready:');
    owner(ws, 'again');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(3), { timeout: 10_000 });
    expect(lastFrame(proc).some((t) => t.startsWith('<super-team'))).toBe(false);
    // A `/clear` starts a conversation on the SPAWN's prompt (the old team): the new one rides again (review E3).
    owner(ws, '/clear');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(4), { timeout: 10_000 });
    expect(lastFrame(proc)).toEqual(['/clear']);
    owner(ws, 'fresh conversation');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(5), { timeout: 10_000 });
    expect(lastFrame(proc).filter((t) => t.startsWith('<super-team fp=') && t.includes('- `atlas` Atlas · ready:'))).toHaveLength(1);
  });

  it('resume -> compaction -> the next owner message: a Super born before the change gets the block, again after a compaction', { timeout: 30_000 }, async () => {
    orbit(true);
    await record({ enabled: true });
    const RESUMED = '22222222-3333-4444-8555-666666666666';
    transcript(RESUMED, `${SUPER_BRIEF_MARKER}\n## This project's agents\n- \`ledger\` Ledger: …`);
    const { ws, child: proc } = start({ sessionId: RESUMED, mode: 'super', resumeId: RESUMED });
    owner(ws, "What's this month's revenue?");
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(1), { timeout: 10_000 });
    const first = lastFrame(proc);
    expect(first[0]).toBe("What's this month's revenue?");
    expect(first.filter((t) => /^<super-team fp=[0-9a-f]{12}>\n## Your AI Team/.test(t))).toHaveLength(1);
    owner(ws, 'next');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(2), { timeout: 10_000 });
    expect(lastFrame(proc).some((t) => t.startsWith('<super-team'))).toBe(false);
    proc.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`));
    owner(ws, 'after the compaction');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(3), { timeout: 10_000 });
    expect(lastFrame(proc).filter((t) => t.startsWith('<super-team fp='))).toHaveLength(1);
  });

  it('a resumed team-less Super never gets a <super-team> block', { timeout: 30_000 }, async () => {
    orbit(false);
    await record({ enabled: true });
    const RESUMED = '33333333-3333-4444-8555-666666666666';
    transcript(RESUMED, 'born before, no team');
    const { ws, child: proc } = start({ sessionId: RESUMED, mode: 'super', resumeId: RESUMED });
    owner(ws, 'hello');
    await vi.waitFor(() => expect(userFrames(proc)).toHaveLength(1), { timeout: 10_000 });
    expect(lastFrame(proc).some((t) => t.startsWith('<super-team'))).toBe(false);
  });
});

describe('the other chats', () => {
  it('an ordinary Chat tab: --agents and the routing rule, DREAMCONTEXT_TEAM_ROUTE=offer', { timeout: 30_000 }, async () => {
    orbit(true);
    const { script, env } = start({ sessionId: CHILD, mode: 'basic' });
    const brief = briefingOf(script);
    expect(agentsArg(script)).toBe(true);
    expect(brief).toContain('say in one line which agent knows it best and offer to ask it');
    expect(env.DREAMCONTEXT_TEAM_ROUTE).toBe('offer');
  });

  it('a Super Agent\'s child keeps today\'s wording byte for byte and gets no route', { timeout: 30_000 }, async () => {
    orbit(true);
    const { script, env } = start({ sessionId: CHILD, mode: 'basic', leanMcp: [] });
    const brief = briefingOf(script);
    const frozen = readFileSync(join(__dirname, '..', '..', 'eval', 'super-team-routing', 'frozen', 'roster.md'), 'utf-8');
    expect(brief.endsWith(frozen)).toBe(true);
    expect(brief).not.toContain('offer to ask it');
    expect(env.DREAMCONTEXT_TEAM_ROUTE).toBe('');
  });

  it('a team-less ordinary tab: no roster, no route', { timeout: 30_000 }, async () => {
    orbit(false);
    const { script, env } = start({ sessionId: CHILD, mode: 'basic' });
    expect(agentsArg(script)).toBe(false);
    expect(env.DREAMCONTEXT_TEAM_ROUTE).toBe('');
  });
});

describe('T07: a team-less Super\'s spawn prompt differs from the frozen 0.36.1 one only by the AI Team bullet and the brief rev', () => {
  it('the exact diff', () => {
    const before = readFileSync(join(__dirname, '..', '..', 'eval', 'super-team-routing', 'frozen', 'super-briefing.md'), 'utf-8').split('\n');
    const after = superBriefing(SUPER_ORCHESTRATION_GUIDE_PATH).split('\n');
    const gone = before.filter((l) => !after.includes(l));
    const added = after.filter((l) => !before.includes(l));
    // The base also carries super-plan-ozeti (merged into the new shell base, 2026-10-30): a start
    // or approve question carries its summary on the card and in the text. That one line grows.
    const PLAN_SUMMARY_GONE = 'unseen): the text says in one line that a question waits. Plain words, no inside jargon ("its own copy", not worktree). Say plainly';
    const PLAN_SUMMARY_ADDED = [
      'unseen): the text says in one line that a question waits. Asking him to approve or start a plan',
      "or any work: the card carries what he says yes to (the yes option's `preview`: the problem in",
      'one sentence, 3-6 short bullets of what will be done, his decisions, cost or risk in money, never',
      'time) and your text gives the same summary, as long as it needs (the exception to 2-4). Plain words, no inside jargon ("its own copy", not worktree). Say plainly',
    ];
    expect(gone).toEqual([
      PLAN_SUMMARY_GONE,
      '- The AI Team (`dreamcontext agents list`): `super team ask <member> "<job>"` hands an approved',
      '  member recurring or field work in its own thread; `super state` shows how it goes.',
      expect.stringContaining('<super-brief rev=16>'),
    ]);
    expect(added).toEqual([
      ...PLAN_SUMMARY_ADDED,
      '- Your AI Team, when the project has one, is listed under `## Your AI Team` (and in `super state`',
      "  members): check it first for every job; a member's field is that member's job",
      '  (`super team ask <member> "<job>"`, in its own thread), never a sub-agent.',
      expect.stringContaining('<super-brief rev=17>'),
    ]);
    expect(after.length).toBe(before.length + 1 + PLAN_SUMMARY_ADDED.length - 1);
  });
});
