import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDelegatePrompt,
  fitPromptForTransport,
  encodedPromptLen,
  MAX_PROMPT_ENCODED,
} from '../../dashboard/src/lib/delegateAgent';

/**
 * Guards the delegate prompt's TRANSPORT BUDGET.
 *
 * The initial prompt rides the agent WebSocket's upgrade URL as `&prompt=<encoded>`, so it
 * lands in the HTTP request line — which Node caps (with all headers) at
 * `--max-http-header-size`, default 16384 bytes. Overflow is silent and total: the parser
 * kills the socket with HPE_HEADER_OVERFLOW before the server's `upgrade` handler runs, so no
 * PTY spawns and no `claude` starts — the user just gets a dead chip and a lost prompt.
 *
 * Delegation is the first caller to put UNBOUNDED content (a task's description + why + user
 * stories + acceptance criteria) into that URL. When this guard was written, 2 of the 147 real
 * tasks in this vault already encoded past 16KB and would have failed outright. The server's
 * own `sanitizePrompt` 8000-char cap can't help — it runs after the request is parsed.
 *
 * `delegateAgent.ts` is pure (its only import of `Task` is type-only, so it erases at
 * transpile), which is why this suite can import the REAL shipped function rather than a
 * re-implementation that could silently drift from it.
 */

/** Minimal Task-shaped stub; the module only reads these fields. */
function task(over: Record<string, string> = {}) {
  return {
    slug: 'some-task', name: 'Some task', description: '', why: '',
    user_stories: '', acceptance_criteria: '', ...over,
  } as never;
}

describe('delegateAgent — transport budget', () => {
  it('leaves a short prompt untouched (idempotent under the budget)', () => {
    const p = 'Do the thing.';
    expect(fitPromptForTransport(p, 'slug')).toBe(p);
  });

  it('bounds an oversized prompt to MAX_PROMPT_ENCODED', () => {
    const huge = 'x '.repeat(20_000); // ~40k raw, encodes far past the limit
    expect(encodedPromptLen(huge)).toBeGreaterThan(MAX_PROMPT_ENCODED);
    const fitted = fitPromptForTransport(huge, 'my-slug');
    expect(encodedPromptLen(fitted)).toBeLessThanOrEqual(MAX_PROMPT_ENCODED);
  });

  it('keeps the budget even when every char inflates 3x when encoded', () => {
    // Newlines/spaces/non-ASCII each encode to 3+ bytes — the worst realistic case for a
    // markdown acceptance-criteria block.
    const inflating = '\n'.repeat(10_000);
    const fitted = fitPromptForTransport(inflating, 'my-slug');
    expect(encodedPromptLen(fitted)).toBeLessThanOrEqual(MAX_PROMPT_ENCODED);
  });

  it('names the slug in the truncation marker so the agent can always recover the full spec', () => {
    const fitted = fitPromptForTransport('y '.repeat(20_000), 'recover-me');
    expect(fitted).toContain('dreamcontext tasks show recover-me');
    expect(fitted).toContain('truncated');
  });

  it('is idempotent — re-fitting an already-fitted prompt is a no-op', () => {
    const once = fitPromptForTransport('z '.repeat(20_000), 'my-slug');
    expect(fitPromptForTransport(once, 'my-slug')).toBe(once);
  });

  it('does not throw on emoji at the truncation boundary (lone surrogate)', () => {
    // A naive slice can cut a surrogate pair in half; encodeURIComponent throws URIError on a
    // lone surrogate, which would crash the composer for any task containing an emoji.
    const emoji = '🎉'.repeat(8_000);
    expect(() => fitPromptForTransport(emoji, 'my-slug')).not.toThrow();
    expect(encodedPromptLen(fitPromptForTransport(emoji, 'my-slug'))).toBeLessThanOrEqual(MAX_PROMPT_ENCODED);
  });

  it('stays well under Node default max-http-header-size (16384) with room for other headers', () => {
    expect(MAX_PROMPT_ENCODED).toBeLessThan(16384 / 2);
  });

  // ── The marker embeds the slug, and NOTHING in the stack caps a slug's length ──────────
  // `slugify()` doesn't truncate and no task-name maxLength exists in the CLI or the create
  // modal. A pathological title once made the marker itself ~28KB — bigger than Node's whole
  // 16KB header limit — so the "fix" reproduced the very overflow it existed to prevent.
  describe('pathological slug (uncapped task name)', () => {
    const monsterSlug = 'a-'.repeat(15_000); // ~30k chars, as a pasted-paragraph title would yield

    it('still honours the budget when the slug alone would dwarf it', () => {
      const fitted = fitPromptForTransport('body '.repeat(5_000), monsterSlug);
      expect(encodedPromptLen(fitted)).toBeLessThanOrEqual(MAX_PROMPT_ENCODED);
    });

    it('drops the slug rather than emitting a truncated (wrong) tasks-show command', () => {
      const fitted = fitPromptForTransport('body '.repeat(5_000), monsterSlug);
      expect(fitted).not.toContain('dreamcontext tasks show');
      expect(fitted).toContain('truncated');
    });

    it('holds the budget even when the prompt AND the slug are both pathological', () => {
      const fitted = fitPromptForTransport('\n'.repeat(20_000), monsterSlug);
      expect(encodedPromptLen(fitted)).toBeLessThanOrEqual(MAX_PROMPT_ENCODED);
    });

    it('keeps naming the slug for any realistic length (the fallback is a last resort)', () => {
      // The vault's longest real slug is ~122 chars; the fallback must not fire for those.
      const longButReal = 'in-app-task-detail-inline-agent-curate-the-task-via-anchored-comments-revise-summarize-split-status-with-real-time-refresh';
      const fitted = fitPromptForTransport('body '.repeat(5_000), longButReal);
      expect(fitted).toContain(`dreamcontext tasks show ${longButReal}`);
    });
  });

  // The ceiling is what stands between a delegated agent and a silent HPE_HEADER_OVERFLOW,
  // so assert it as an UNCONDITIONAL property over adversarial prompt × slug combinations.
  it('PROPERTY: never exceeds the ceiling for any prompt × slug combination', () => {
    const prompts = ['', 'short', 'x'.repeat(50_000), '\n'.repeat(20_000), '🎉'.repeat(9_000), '%'.repeat(9_000)];
    const slugs = ['s', 'normal-task-slug', 'z-'.repeat(20_000), '🎉'.repeat(4_000)];
    for (const p of prompts) {
      for (const s of slugs) {
        const fitted = fitPromptForTransport(p, s);
        expect(
          encodedPromptLen(fitted),
          `prompt(${p.length}) × slug(${s.length}) overflowed the ceiling`,
        ).toBeLessThanOrEqual(MAX_PROMPT_ENCODED);
      }
    }
  });
});

describe('delegateAgent — buildDelegatePrompt', () => {
  it('includes the task context and the source-of-truth recovery instruction', () => {
    const p = buildDelegatePrompt(
      task({ slug: 'add-auth', name: 'Add auth', description: 'Ship login.', acceptance_criteria: '- [ ] It works' }),
      'Add auth',
    );
    expect(p).toContain('Add auth');
    expect(p).toContain('Ship login.');
    expect(p).toContain('- [ ] It works');
    expect(p).toContain('dreamcontext tasks show add-auth');
  });

  it('returns a transport-fitted prompt, so the composer shows exactly what is sent', () => {
    const p = buildDelegatePrompt(
      task({ slug: 'huge', name: 'Huge', acceptance_criteria: '- [ ] criterion\n'.repeat(5_000) }),
      'Huge',
    );
    expect(encodedPromptLen(p)).toBeLessThanOrEqual(MAX_PROMPT_ENCODED);
    expect(p).toContain('dreamcontext tasks show huge');
  });

  it('uses the caller-supplied title verbatim (no drift from the tab title)', () => {
    expect(buildDelegatePrompt(task({ slug: 'a-b-c', name: '' }), 'a b c')).toContain('Task: a b c');
  });
});

// ── The real corpus: every task in this vault must be delegable ────────────────────────
// The regression that motivated this suite was found in real data, so it is guarded against
// real data — not just synthetic strings.
describe('delegateAgent — every real task in the vault fits the transport budget', () => {
  const dir = join(process.cwd(), '_dream_context', 'state');

  function section(body: string, name: string): string {
    const re = new RegExp(`^## ${name}\\s*$`, 'i');
    const out: string[] = [];
    let cap = false;
    for (const line of body.split('\n')) {
      if (/^## /.test(line)) { cap = re.test(line); continue; }
      if (cap) out.push(line);
    }
    return out.join('\n').trim();
  }

  it('composes a within-budget prompt for every task file', () => {
    if (!existsSync(dir)) return; // vault-less checkout — nothing to assert
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);

    const overBudget: string[] = [];
    for (const f of files) {
      const raw = readFileSync(join(dir, f), 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
      if (!m) continue;
      const [, fm, body] = m;
      const slug = f.replace(/\.md$/, '');
      const name = /^name:\s*(.*)$/m.exec(fm)?.[1] ?? slug;
      const prompt = buildDelegatePrompt(
        task({
          slug,
          name,
          description: /^description:\s*(.*)$/m.exec(fm)?.[1] ?? '',
          why: section(body, 'Why'),
          user_stories: section(body, 'User Stories'),
          acceptance_criteria: section(body, 'Acceptance Criteria'),
        }),
        name,
      );
      if (encodedPromptLen(prompt) > MAX_PROMPT_ENCODED) overBudget.push(`${slug} (${encodedPromptLen(prompt)}B)`);
      // Every prompt must carry its own recovery pointer, truncated or not.
      expect(prompt).toContain(`dreamcontext tasks show ${slug}`);
    }
    expect(overBudget, `tasks whose delegate prompt would overflow the WS upgrade: ${overBudget.join(', ')}`).toEqual([]);
  });
});
