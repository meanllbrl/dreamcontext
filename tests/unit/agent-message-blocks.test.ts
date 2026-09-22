import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The #agents message's RICH CONTENT, pinned by parsing the source as TEXT.
 *
 * Text-shape only, and deliberately so (`mirror-with-drift-test`): these are
 * dashboard-bundle `.tsx` files and root vitest cannot import them — it has no
 * JSX transform and no React environment. What a text parse CAN prove is the
 * class of regression this lane is most exposed to: a component quietly
 * replaced by a hand-rolled copy, a route swapped for the wrong one, or an
 * extension list drifting from the server's allowlist. None of those are caught
 * by `tsc`, and all three have shipped in this repo before.
 *
 * It cannot prove anything renders. `scripts/verify/agent-threads.mjs` drives
 * the real surface in Chromium for that.
 */

const DASHBOARD = join(import.meta.dirname, '..', '..', 'dashboard', 'src');
const AGENTS = join(DASHBOARD, 'components', 'agents');

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('AgentMessage — the rich blocks are mounted, not re-implemented', () => {
  const source = read(join(AGENTS, 'AgentMessage.tsx'));

  /**
   * MUTATION 17 from the plan, and the reason it is the one worth writing: a
   * board drawn by a local copy would typecheck, render something board-shaped,
   * and drift from the chat's real canvas from that day on
   * (`component-reuse-over-reimplementation`). The import IS the assertion.
   */
  it('imports the chat BoardEmbed rather than drawing its own board', () => {
    expect(source).toMatch(/import\s*\{\s*BoardEmbed\s*\}\s*from\s*'\.\.\/sleepy\/chat\/BoardEmbed'/);
    expect(source).toContain('<BoardEmbed');
  });

  it('mounts the summary and question blocks it does not own', () => {
    expect(source).toMatch(/import\s*\{\s*AgentQuestionBlock\s*\}\s*from\s*'\.\/AgentQuestionBlock'/);
    expect(source).toMatch(/import\s*\{\s*AgentSummaryBlock\s*\}\s*from\s*'\.\/AgentSummaryBlock'/);
    expect(source).toContain('<AgentSummaryBlock');
    expect(source).toContain('<AgentQuestionBlock');
  });

  /**
   * THE ROUTE CHOICE IS THE SECURITY-RELEVANT ONE. `/api/agent/file` is
   * desktop-gated; `/api/graph/content` (what `graphContentUrl` builds) is
   * vault-scoped and is not. An image posted by an agent has to be visible in a
   * browser tab and on a phone over the tailnet, so it must go through the
   * latter — and swapping them back is a silent 403 nobody sees until a user is
   * away from their Mac.
   */
  it('serves posted images through the vault route, not the desktop-gated one', () => {
    expect(source).toMatch(/import\s*\{\s*graphContentUrl\s*\}\s*from\s*'\.\.\/\.\.\/api\/client'/);
    expect(source).toContain('graphContentUrl(vault, f.path, { raw: true })');
    expect(source).not.toContain('agentFileUrl');
  });

  /**
   * `.svg` is absent on BOTH sides on purpose: an SVG is a script-bearing
   * document and `/api/graph/content` is generic (the Knowledge page hands its
   * URL to an iframe). Adding it here would draw one inline; adding it server-
   * side would serve it as `image/svg+xml`. This pins the client half.
   */
  it('mirrors the server raster allowlist exactly, and never adds .svg', () => {
    const block = /const RASTER_EXTENSIONS = \[([^\]]*)\]/.exec(source);
    expect(block, 'RASTER_EXTENSIONS must stay a plain array literal so this can parse it').toBeTruthy();
    const mirrored = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(mirrored).toEqual(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

    // The source of truth, parsed from the route itself rather than restated.
    const graph = read(join(import.meta.dirname, '..', '..', 'src', 'server', 'routes', 'graph.ts'));
    const table = /GRAPH_RAW_CONTENT_TYPE: Record<string, string> = \{([\s\S]*?)\}/.exec(graph);
    expect(table).toBeTruthy();
    const served = [...table![1].matchAll(/'(\.[a-z0-9]+)':\s*'([^']+)'/g)];
    const rasterServed = served.filter(([, , type]) => type.startsWith('image/')).map(([, ext]) => ext);
    expect(new Set(rasterServed)).toEqual(new Set(mirrored));
    expect(served.map(([, ext]) => ext)).not.toContain('.svg');
  });

  /** A board off-desktop must say where it opens, not paint an empty canvas. */
  it('degrades a board to a chip off-desktop', () => {
    expect(source).toContain('isDesktop()');
    expect(source).toContain("t('agents.boardDesktopOnly')");
  });

  /**
   * The status word describes the RUN; "Needs you" says the reader still owes
   * it something. Both can be true at once (a finished run with an open
   * question), and the guard is what stops it being said twice on one row.
   */
  it('shows the Needs-you word only when the status word does not already say it', () => {
    expect(source).toContain("message.needsYou && message.status !== 'needs-you'");
    expect(source).toContain("t('agents.needsYou')");
    // Its own class: a second `.agent-msg-status` makes the feed's verify
    // locator multi-match, and innerText() on that is a strict-mode violation.
    expect(source).toContain('agent-msg-needs');
  });
});

describe('AgentQuestionBlock — answers through the existing HITL route', () => {
  const source = read(join(AGENTS, 'AgentQuestionBlock.tsx'));

  /**
   * `flow-hitl` ALWAYS. The answer route's two kinds are not interchangeable:
   * `approval` is the manifest-diff ask raised BEFORE a run, whose session is
   * forced null, and it never reaches a run's thread. Sending it from here
   * would answer a question this block is not showing.
   */
  it('answers as flow-hitl through useAnswerQuestion, never approval', () => {
    expect(source).toContain('useAnswerQuestion');
    expect(source).toMatch(/kind:\s*'flow-hitl'/);
    expect(source).not.toMatch(/kind:\s*'approval'/);
  });

  /** Both producers are real: buttons for an option set, a field for none. */
  it('renders buttons for choices and a free-text field without them', () => {
    expect(source).toContain('question.choices.length > 0');
    expect(source).toContain('agent-msg-question-choice');
    expect(source).toContain('agent-msg-question-input');
  });

  /**
   * The receipt must not outlive a failed send — the run would still be waiting
   * while the channel claimed it had been answered. `AskBlock`'s machine.
   */
  it('clears the receipt when the answer could not be recorded', () => {
    expect(source).toContain('setDecided(null)');
    expect(source).toContain('onToast(');
  });

  /** Turkish survives: no user-facing prose baked into the component. */
  it('takes its copy from I18nContext', () => {
    expect(source).toContain("t('agents.question.sent')");
    expect(source).toContain("t('agents.question.answer')");
  });
});

describe('the reply hook — frozen for T9 and T10', () => {
  const source = read(join(DASHBOARD, 'hooks', 'useAutomations.ts'));

  it('posts to the reply route and polls the reply job', () => {
    expect(source).toContain('export function useReplyToAgentThread()');
    expect(source).toContain('/thread/reply');
    expect(source).toContain('/automations/reply-job/');
    expect(source).toContain('REPLY_POLL_MS = 2_000');
  });

  /**
   * A 404 means the server restarted mid-reply, so NOTHING on this machine will
   * ever report the outcome. Polling on would spin against an id nothing can
   * answer; re-sending would deliver the same instruction twice.
   */
  it('treats a 404 as terminal and never re-sends', () => {
    expect(source).toMatch(/status\s*===\s*404/);
    expect(source).toContain("settle({ status: 'unknown', reason: null })");
  });

  it('invalidates the thread and the feed when a turn settles', () => {
    expect(source).toContain("queryKey: ['automations', slug, 'thread']");
    expect(source).toContain("queryKey: ['automations-feed']");
  });

  /** The wire types have to mirror what `buildFeed` actually sends. */
  it('mirrors T4s feed fields', () => {
    expect(source).toContain('needsYouTotal: number');
    expect(source).toContain('summary: ThreadSummaryRow[] | null');
    expect(source).toContain('needsYou: boolean');
  });
});
