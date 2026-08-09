import { describe, it, expect, vi } from 'vitest';

/**
 * Guards the four delegate MODES — Autonomous / Discuss / Is it done? / Summarize.
 *
 * A mode is not just a prompt: it also decides whether bypass-permissions starts armed, where
 * the session lands, and what the tab is called. Those four have to stay consistent with each
 * other, because the failure is silent and expensive — a "Discuss" hand-off that quietly runs
 * with permissions bypassed can edit the repo while the user thinks they are only talking, and
 * a mode whose prompt drops the task's own body sends an agent off with nothing to read.
 *
 * The transport of these prompts is covered by delegate-agent.test.ts; what is pinned here is
 * the CONTENT and the per-mode settings.
 */

vi.mock('../../dashboard/src/api/client', () => ({
  api: { post: vi.fn() },
  getActiveVault: () => 'test-vault',
}));

const { DELEGATE_MODES, DEFAULT_DELEGATE_MODE, delegateMode, delegateTitle } =
  await import('../../dashboard/src/lib/delegateModes');
const { buildDelegatePrompt, taskSourcePath } = await import('../../dashboard/src/lib/delegateAgent');
const { isAgentRun, oneLine } = await import('../../src/lib/transcript-sessions.js');

/** Minimal Task-shaped stub; the modules only read these fields. */
function task(over: Record<string, string> = {}) {
  return {
    slug: 'add-auth', name: 'Add auth', description: 'Ship login.', why: 'Users cannot log in.',
    user_stories: '- As a user, I can log in', acceptance_criteria: '- [ ] It works', ...over,
  } as never;
}

describe('delegateModes — the roster', () => {
  it('offers exactly the four jobs, with unique ids and labels', () => {
    expect(DELEGATE_MODES.map((m) => m.id)).toEqual(['autonomous', 'discuss', 'verify', 'summarize']);
    expect(new Set(DELEGATE_MODES.map((m) => m.label)).size).toBe(DELEGATE_MODES.length);
  });

  it('opens on the autonomous mode — the common case stays the default', () => {
    expect(DEFAULT_DELEGATE_MODE).toBe('autonomous');
    expect(delegateMode(DEFAULT_DELEGATE_MODE).id).toBe('autonomous');
  });

  it('falls back to autonomous for an unknown id rather than throwing', () => {
    expect(delegateMode('nonsense' as never).id).toBe('autonomous');
  });
});

describe('delegateModes — every mode hands over the same task', () => {
  it.each(DELEGATE_MODES.map((m) => [m.id, m] as const))(
    '%s carries the title, the body and the source-of-truth pointer',
    (_id, mode) => {
      const p = mode.build(task(), 'Add auth');
      expect(p).toContain('Task: Add auth');
      expect(p).toContain('Ship login.');            // description
      expect(p).toContain('Users cannot log in.');   // why
      expect(p).toContain('- [ ] It works');         // acceptance criteria
      expect(p).toContain(taskSourcePath('add-auth'));
    },
  );

  it('omits empty sections instead of sending bare headings', () => {
    const p = delegateMode('summarize').build(task({ why: '', user_stories: '' }), 'Add auth');
    expect(p).not.toContain('Why:');
    expect(p).not.toContain('User stories:');
    expect(p).toContain('Description:');
  });
});

describe('delegateModes — each mode asks for its own job', () => {
  it('autonomous is the original delegate prompt, verbatim (no drift)', () => {
    expect(delegateMode('autonomous').build(task(), 'Add auth')).toBe(buildDelegatePrompt(task(), 'Add auth'));
  });

  it('discuss and summarize forbid editing; autonomous does not', () => {
    expect(delegateMode('discuss').build(task(), 'Add auth')).toMatch(/do NOT edit/i);
    expect(delegateMode('summarize').build(task(), 'Add auth')).toMatch(/do NOT edit/i);
    expect(delegateMode('autonomous').build(task(), 'Add auth')).not.toMatch(/do NOT edit/i);
  });

  it('verify checks the criteria without implementing them', () => {
    const p = delegateMode('verify').build(task(), 'Add auth');
    expect(p).toMatch(/do NOT build/i);
    expect(p).toContain('acceptance criteria');
    expect(p).toContain('dreamcontext tasks log add-auth');
  });

  it('autonomous is the only mode that tells the agent not to ask questions', () => {
    const asks = DELEGATE_MODES.filter((m) => /do NOT ask me questions/i.test(m.build(task(), 'Add auth')));
    expect(asks.map((m) => m.id)).toEqual(['autonomous']);
  });
});

describe('delegateModes — permissions and placement follow the job', () => {
  it('arms bypass only where the job needs to run commands unattended', () => {
    // Build it / prove it → unattended (a verification that stops for `npm test` is one you
    // have to babysit). Talk about it / read it back → no reason to act without approval.
    expect(delegateMode('autonomous').bypass).toBe(true);
    expect(delegateMode('verify').bypass).toBe(true);
    expect(delegateMode('discuss').bypass).toBe(false);
    expect(delegateMode('summarize').bypass).toBe(false);
  });

  it('forces reveal ONLY for discuss — a conversation cannot happen in a corner chip', () => {
    expect(DELEGATE_MODES.filter((m) => m.reveal).map((m) => m.id)).toEqual(['discuss']);
  });

  it('titles stay tellable apart when one task is delegated in several modes', () => {
    const titles = DELEGATE_MODES.map((m) => delegateTitle(m, 'Add auth'));
    expect(new Set(titles).size).toBe(DELEGATE_MODES.length);
    // The autonomous run IS the task, so it keeps the plain name; the rest say what they are.
    expect(delegateTitle(delegateMode('autonomous'), 'Add auth')).toBe('Add auth');
    for (const t of titles) expect(t).toContain('Add auth');
  });

  it('gives every mode a hint — the chip alone does not explain the job', () => {
    for (const m of DELEGATE_MODES) expect(m.hint.trim().length).toBeGreaterThan(10);
  });
});

/**
 * The cross-module invariant a new mode is most likely to break silently.
 *
 * The Past-chats picker classifies a conversation as machine-spawned by matching its FIRST
 * prompt against the briefs this project writes verbatim (`OWN_AGENT_BRIEFS`,
 * src/lib/transcript-sessions.ts) — there is no structural marker to read. Adding a mode
 * without adding its opening there is invisible until someone's history quietly fills with
 * "Summarize this dreamcontext task for me" rows they never typed.
 */
describe('delegateModes — no mode leaks into the past-chats list as a human conversation', () => {
  it.each(DELEGATE_MODES.map((m) => [m.id, m] as const))(
    "%s's brief is recognized as a machine-spawned run",
    (_id, mode) => {
      expect(isAgentRun(oneLine(mode.build(task(), 'Ship the login screen')))).toBe(true);
    },
  );

  it('does not flag a prompt a person actually typed', () => {
    expect(isAgentRun('bu taskı bitirelim mi, ne düşünüyorsun')).toBe(false);
  });
});
