/**
 * Chat MODES — the sanitizer, the briefings, and the worktree gate that decides which
 * develop briefing a project gets.
 *
 * Two properties are load-bearing enough to be pinned mechanically rather than reviewed:
 *
 *   1. An unknown mode must degrade to `basic` (plain Claude Code), never to a half-applied
 *      one. `jarvis` is the interesting case: it is a real member of `CHAT_MODES` (the menu
 *      and the allowlist come from one list) but is rendered DISABLED with a "Soon" badge and
 *      has no behaviour — so a client that sends it anyway must get `basic`.
 *
 *   2. The develop briefing's worktree paragraph must follow THIS PROJECT's layout, in all
 *      four combinations of (brain isolated?) × (linked repo present?). Getting it wrong in
 *      the permissive direction forks the brain: `_dream_context/` lives in the code checkout
 *      by default, so a second worktree is a second copy of the brain that nobody reconciles.
 *      A briefing that merely stays SILENT about worktrees is not good enough — an unmentioned
 *      capability is one the agent reaches for anyway — so the forbidden case is asserted to
 *      carry an explicit prohibition, not just the absence of permission.
 *
 * The linked-repo arm drives `worktreeIsolationAllowed`'s `home` test seam so it reads a
 * scratch registry, never the developer's real `~/.dreamcontext/linked-repos.json`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_MODES, DEFAULT_CHAT_MODE, modeBriefing } from '../../src/server/chat-modes.js';
import { sanitizeChatMode } from '../../src/server/routes/agent-spawn-shared.js';
import { worktreeIsolationAllowed } from '../../src/lib/worktree-gate.js';
import { canonicalRemote } from '../../src/lib/git-sync/origin-setup.js';
import { linkedReposFilePath } from '../../src/lib/linked-repos.js';

describe('sanitizeChatMode', () => {
  it('passes the two modes that carry behaviour', () => {
    expect(sanitizeChatMode('plan')).toBe('plan');
    expect(sanitizeChatMode('develop')).toBe('develop');
    expect(sanitizeChatMode('basic')).toBe('basic');
  });

  it('coerces jarvis to basic — it is listed but unselectable, and has no behaviour', () => {
    expect(sanitizeChatMode('jarvis')).toBe('basic');
  });

  it('coerces everything unknown, empty or hostile to basic', () => {
    const rejected = [
      null, '', ' ', 'Plan', 'PLAN', 'DEVELOP', 'basic ', 'plan;rm -rf /', 'plan develop',
      '../plan', 'develop\n', '__proto__', 'constructor', 'toString',
    ];
    for (const input of rejected) {
      expect(sanitizeChatMode(input), `input: ${JSON.stringify(input)}`).toBe('basic');
    }
  });

  it('is exhaustive over CHAT_MODES — every listed mode round-trips or coerces, none throws', () => {
    for (const mode of CHAT_MODES) {
      const out = sanitizeChatMode(mode);
      expect(CHAT_MODES as readonly string[]).toContain(out);
    }
  });

  it('the default IS basic (there is no user-settable mode default)', () => {
    expect(DEFAULT_CHAT_MODE).toBe('basic');
    expect(sanitizeChatMode(null)).toBe(DEFAULT_CHAT_MODE);
  });
});

describe('modeBriefing', () => {
  // REVERSAL, 2026-08-24. This test used to assert `modeBriefing('basic', …) === ''` —
  // "basic adds NOTHING — plain Claude Code plus the surface briefing". The worktree
  // paragraph was appended only in `develop`, which left the prohibition that stops a second
  // checkout forking the brain absent from `basic`: the DEFAULT mode, the one a fresh chat is
  // in, carrying exactly the same tools. The guard was on the door nobody uses. Basic now
  // carries that paragraph and nothing else, so the mode is still plain Claude Code in
  // BEHAVIOUR — the assertions below pin both halves of that sentence.
  it('basic carries the worktree paragraph — and ONLY the worktree paragraph', () => {
    expect(modeBriefing('basic', { worktreeAllowed: true })).toMatch(PERMITS);
    expect(modeBriefing('basic', { worktreeAllowed: false })).toMatch(FORBIDS);
    for (const worktreeAllowed of [true, false]) {
      const brief = modeBriefing('basic', { worktreeAllowed });
      expect(brief).not.toContain('# Mode:');
      expect(brief).not.toContain('dreamcontext tasks log');
      expect(brief).not.toContain('"type":"progress"');
      expect(brief).not.toMatch(/Work in waves/);
    }
  });

  it('develop ends with the SAME paragraph basic gets — one constant, not two copies', () => {
    for (const worktreeAllowed of [true, false]) {
      const basic = modeBriefing('basic', { worktreeAllowed });
      expect(basic.length).toBeGreaterThan(0);
      expect(modeBriefing('develop', { worktreeAllowed }).endsWith(basic),
        `worktreeAllowed=${worktreeAllowed}`).toBe(true);
    }
  });

  it('plan is excluded from the worktree paragraph entirely', () => {
    for (const worktreeAllowed of [true, false]) {
      const brief = modeBriefing('plan', { worktreeAllowed });
      expect(brief).not.toMatch(PERMITS);
      expect(brief).not.toMatch(FORBIDS);
      expect(brief).not.toContain('EnterWorktree');
    }
  });

  // Both arms have to name the tool: the forbidden arm bans CREATING a worktree, it does not
  // stop a session being driven from one that already exists.
  //
  // The second assertion is a REVERSAL, and it is the point of this change. This paragraph used
  // to end "say so, and pin the checkout as a tag", because the server followed only the
  // EnterWorktree/ExitWorktree frames and was blind to every other move. Asking the agent to
  // paper over that produced the defect the owner photographed on 2026-08-25: three chips
  // reading `main` + `wt: eur-multicurrency` + `branch: feat/eur-multicurrency`. The server now
  // reads the checkout from the transcript (src/lib/session-transcript-cwd.ts), so the briefing
  // must ask for the OPPOSITE — and this test is what keeps the old instruction from drifting
  // back in.
  it('BOTH arms name EnterWorktree and forbid pinning the checkout by hand', () => {
    for (const worktreeAllowed of [true, false]) {
      const brief = modeBriefing('basic', { worktreeAllowed });
      expect(brief, `worktreeAllowed=${worktreeAllowed}`).toContain('EnterWorktree');
      expect(brief, `worktreeAllowed=${worktreeAllowed}`)
        .toMatch(/do not pin the branch or worktree/i);
      expect(brief, `worktreeAllowed=${worktreeAllowed}`).not.toMatch(/pin the checkout as a tag/);
    }
  });

  it('jarvis adds nothing either (defence in depth — the sanitizer coerces it away first)', () => {
    expect(modeBriefing('jarvis', { worktreeAllowed: true })).toBe('');
    expect(modeBriefing('jarvis', { worktreeAllowed: false })).toBe('');
  });

  it('plan is the planning half: ask first, ground it, end with a task', () => {
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toContain('# Mode: Plan');
    expect(brief).toMatch(/ask/i);
    expect(brief).toContain('dreamcontext tasks create');
  });

  it('plan ENDS by offering the develop handoff as a dream-actions button', () => {
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toContain('dream-actions');
    expect(brief).toContain('"action": "develop"');
    // The button carries the slug the agent just created — an id-less handoff has nothing
    // to hand off.
    expect(brief).toMatch(/"id":\s*"<the-task-slug>"/);
  });

  it('plan tells the agent to SHELVE the task it just created', () => {
    // The shelf is proactive or it is nothing: an agent that only mentions progress in prose
    // leaves the surface empty for the whole session.
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toContain('dream-view');
    expect(brief).toContain('"type":"progress"');
    expect(brief).toMatch(/"task":\s*"<the-slug>"/);
  });

  it('plan does not depend on the worktree gate (it never implements)', () => {
    expect(modeBriefing('plan', { worktreeAllowed: true }))
      .toBe(modeBriefing('plan', { worktreeAllowed: false }));
  });

  it('develop is the implementing half: waves, evidence, no silent redesign', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toContain('# Mode: Develop');
    expect(brief).toMatch(/waves/i);
    expect(brief).toMatch(/evidence/i);
    expect(brief).toContain('dreamcontext tasks log');
  });

  // `\s+`, not a literal space: the briefings are hand-wrapped prose, so the sentence can
  // break across a newline. The property under test is what the sentence SAYS, never where
  // the line happens to end.
  const PERMITS = /MAY\s+use\s+a\s+git\s+worktree/;
  const FORBIDS = /Do\s+NOT\s+create\s+a\s+git\s+worktree/;

  it('develop opens the run on the shelf BEFORE the first edit', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toContain('"type":"progress"');
    expect(brief).toMatch(/"task":\s*"<the-slug>"/);
    // It must land ahead of the wave instruction — "first action", not "somewhere".
    expect(brief.indexOf('"type":"progress"')).toBeLessThan(brief.indexOf('Work in waves'));
    // And it must say WHERE the percent comes from, or the agent will try to assert one.
    expect(brief).toMatch(/criteria\s+you\s+tick/i);
  });

  it('develop tells the agent to pin a dev-server URL as a tag', () => {
    // The port is the one session fact no server-side reader can attribute to a session —
    // only the agent that ran the command knows it.
    const brief = modeBriefing('develop', { worktreeAllowed: true });
    expect(brief).toContain('"type":"pin"');
    expect(brief).toContain('"weight":"tag"');
    expect(brief).toContain('http://localhost:PORT');
  });

  it('develop PERMITS a worktree only when the brain is isolated', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: true });
    expect(brief).toMatch(PERMITS);
    expect(brief).not.toMatch(FORBIDS);
  });

  it('develop FORBIDS a worktree explicitly otherwise — silence is not enough', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toMatch(FORBIDS);
    expect(brief).not.toMatch(PERMITS);
    // It says WHY, so the agent can tell this apart from an arbitrary rule.
    expect(brief).toContain('_dream_context/');
  });

  it('keeps every briefing short — it rides in the system prompt of every turn', () => {
    for (const mode of CHAT_MODES) {
      for (const worktreeAllowed of [true, false]) {
        expect(modeBriefing(mode, { worktreeAllowed }).length,
          `${mode} (worktreeAllowed=${worktreeAllowed})`).toBeLessThan(1600);
      }
    }
  });
});

// ── worktreeIsolationAllowed — criterion 18's four combinations ────────────────────────
//
// (brain isolated?) × (linked repo present?). Only the top-left cell forbids a worktree:
//
//                        no linked repo      linked repo present
//   brain in-tree            FORBID                 ALLOW
//   brain full-repo          ALLOW                  ALLOW

const LINKED_URL = 'https://github.com/acme/product.git';
const roots: string[] = [];

/** A project root with the given brain mode, plus an optional linked-repo config entry. */
function makeProject(brainMode: 'in-tree' | 'full-repo' | null, linked: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-worktree-gate-proj-'));
  roots.push(root);
  mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
  const config: Record<string, unknown> = { platforms: [], packs: [], setupVersion: '1' };
  if (brainMode) config.brainRepo = { mode: brainMode, enabled: brainMode === 'full-repo' };
  if (linked) config.linkedRepos = [{ name: 'product', gitRemoteUrl: LINKED_URL }];
  writeFileSync(join(root, '_dream_context', 'state', '.config.json'), JSON.stringify(config));
  return root;
}

/** A scratch HOME whose linked-repo registry maps LINKED_URL to a path that does/doesn't
 *  exist. The canonical key is computed with the SAME helper the resolver uses, so the
 *  fixture can't drift from the lookup. */
function makeHome(present: boolean): string {
  const home = mkdtempSync(join(tmpdir(), 'dc-worktree-gate-home-'));
  roots.push(home);
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  const checkout = join(home, 'code', 'product');
  if (present) mkdirSync(checkout, { recursive: true });
  const key = canonicalRemote(LINKED_URL) ?? LINKED_URL;
  writeFileSync(linkedReposFilePath(home), JSON.stringify({ repos: { [key]: checkout } }));
  return home;
}

let homeWithRepo: string;
let homeWithoutRepo: string;

beforeAll(() => {
  homeWithRepo = makeHome(true);
  homeWithoutRepo = makeHome(false);
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('worktreeIsolationAllowed (criterion 18 — all four combinations)', () => {
  it('in-tree brain + no linked repo → FORBIDDEN (the default layout: a worktree forks the brain)', () => {
    expect(worktreeIsolationAllowed(makeProject('in-tree', false), homeWithoutRepo)).toBe(false);
  });

  it('full-repo brain + no linked repo → allowed (the brain is its own repo)', () => {
    expect(worktreeIsolationAllowed(makeProject('full-repo', false), homeWithoutRepo)).toBe(true);
  });

  it('in-tree brain + linked repo present → allowed (the code has no brain of its own)', () => {
    expect(worktreeIsolationAllowed(makeProject('in-tree', true), homeWithRepo)).toBe(true);
  });

  it('full-repo brain + linked repo present → allowed', () => {
    expect(worktreeIsolationAllowed(makeProject('full-repo', true), homeWithRepo)).toBe(true);
  });

  it('a CONFIGURED linked repo that is not on THIS machine does not count', () => {
    // The shared config travels with the team; the local path registry does not. A teammate's
    // linked checkout must not unlock worktrees on a machine that never cloned it.
    expect(worktreeIsolationAllowed(makeProject('in-tree', true), homeWithoutRepo)).toBe(false);
  });

  it('no config at all → FORBIDDEN (absent brainRepo means in-tree, the safe default)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'dc-worktree-gate-bare-'));
    roots.push(bare);
    expect(worktreeIsolationAllowed(bare, homeWithoutRepo)).toBe(false);
  });

  it('a corrupt config degrades to FORBIDDEN rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-worktree-gate-bad-'));
    roots.push(root);
    mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(root, '_dream_context', 'state', '.config.json'), '{not json');
    expect(() => worktreeIsolationAllowed(root, homeWithoutRepo)).not.toThrow();
    expect(worktreeIsolationAllowed(root, homeWithoutRepo)).toBe(false);
  });
});
