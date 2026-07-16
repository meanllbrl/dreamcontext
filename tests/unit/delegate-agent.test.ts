import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the delegate prompt's TRANSPORT.
 *
 * History: the initial prompt used to ride the agent WebSocket's upgrade URL as
 * `&prompt=<encoded>`, landing it in the HTTP request line — which Node caps (with all
 * headers) at `--max-http-header-size`, default 16384 bytes. Overflow is silent and total:
 * the parser kills the socket with HPE_HEADER_OVERFLOW before the server's `upgrade` handler
 * runs, so no PTY spawns and no `claude` starts — a dead chip and a lost prompt. Delegation
 * was the first caller to put UNBOUNDED content (a task's description + why + user stories +
 * acceptance criteria) into that URL; 2 of the 147 real tasks in this vault already encoded
 * past 16KB. The guard was to hard-truncate to 6000 encoded bytes.
 *
 * That guard is GONE, and these tests now pin what replaced it: a prompt too big to inline is
 * POSTed and exchanged for a token, so nothing is truncated and the agent receives exactly
 * the brief the composer showed. What must still hold is that the INLINE path never exceeds
 * the ceiling — that is what keeps the socket alive.
 *
 * These modules are pure enough to import for real (the `Task` import is type-only, so it
 * erases at transpile), which is why this suite exercises the SHIPPED functions rather than a
 * re-implementation that could silently drift from them.
 */

const post = vi.fn();
vi.mock('../../dashboard/src/api/client', () => ({
  api: { post: (...a: unknown[]) => post(...a) },
  getActiveVault: () => 'test-vault',
}));

const { buildDelegatePrompt } = await import('../../dashboard/src/lib/delegateAgent');
const { encodedPromptLen, promptFitsInline, preparePrompt, MAX_PROMPT_ENCODED } =
  await import('../../dashboard/src/lib/agentPrompt');

/** Minimal Task-shaped stub; the module only reads these fields. */
function task(over: Record<string, string> = {}) {
  return {
    slug: 'some-task', name: 'Some task', description: '', why: '',
    user_stories: '', acceptance_criteria: '', ...over,
  } as never;
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ ok: true, token: 'tok-123', expiresInMs: 120_000 });
});

describe('agentPrompt — inline ceiling', () => {
  it('keeps the inline ceiling well under Node’s request-line limit', () => {
    // The budget covers the request line AND every header; half of it is ample headroom.
    expect(MAX_PROMPT_ENCODED).toBeLessThan(16384 / 2);
  });

  it('treats a short prompt as inlineable and a huge one as not', () => {
    expect(promptFitsInline('Do the thing.')).toBe(true);
    expect(promptFitsInline('x'.repeat(MAX_PROMPT_ENCODED + 1))).toBe(false);
  });

  it('counts ENCODED bytes, not characters — an all-escaping prompt is caught', () => {
    // Each newline encodes to '%0A' (3 bytes), so this is 3x its character length.
    const inflating = '\n'.repeat(MAX_PROMPT_ENCODED / 2);
    expect(inflating.length).toBeLessThan(MAX_PROMPT_ENCODED);
    expect(encodedPromptLen(inflating)).toBeGreaterThan(MAX_PROMPT_ENCODED);
    expect(promptFitsInline(inflating)).toBe(false);
  });

  it('does not throw on a lone surrogate (a task title with an emoji)', () => {
    const emoji = `${'🎉'.repeat(4000)}`.slice(0, 3001); // odd slice → dangling high surrogate
    expect(() => encodedPromptLen(emoji)).not.toThrow();
    expect(() => promptFitsInline(emoji)).not.toThrow();
  });
});

describe('agentPrompt — preparePrompt routing', () => {
  it('inlines a short prompt with NO server round-trip', async () => {
    const p = 'Do the thing.';
    await expect(preparePrompt(p)).resolves.toEqual({ inline: p, token: '' });
    expect(post).not.toHaveBeenCalled();
  });

  it('mints a token for an oversized prompt and inlines nothing', async () => {
    const huge = 'x'.repeat(MAX_PROMPT_ENCODED * 3);
    await expect(preparePrompt(huge)).resolves.toEqual({ inline: '', token: 'tok-123' });
    expect(post).toHaveBeenCalledWith('/agent/prompt', { vault: 'test-vault', prompt: huge });
  });

  it('sends the prompt WHOLE — the token path must not truncate', async () => {
    const huge = `HEAD${'x'.repeat(MAX_PROMPT_ENCODED * 3)}TAIL`;
    await preparePrompt(huge);
    const sent = (post.mock.calls[0][1] as { prompt: string }).prompt;
    expect(sent).toBe(huge);
    expect(sent).toContain('TAIL'); // the exact content the old truncation would have shed
  });

  it('REJECTS rather than degrading when the server refuses a token', async () => {
    post.mockRejectedValue(new Error('desktop_only'));
    await expect(preparePrompt('y'.repeat(MAX_PROMPT_ENCODED * 3))).rejects.toThrow('desktop_only');
  });

  it('rejects a malformed token response instead of returning an empty token', async () => {
    post.mockResolvedValue({ ok: true, token: '' });
    await expect(preparePrompt('z'.repeat(MAX_PROMPT_ENCODED * 3))).rejects.toThrow(/token/i);
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
    expect(p).toContain('_dream_context/state/add-auth.md');
  });

  it('does NOT truncate a huge task — the composer shows the whole brief, and so does the agent', () => {
    const criteria = '- [ ] criterion\n'.repeat(5_000);
    const p = buildDelegatePrompt(task({ slug: 'huge', name: 'Huge', acceptance_criteria: criteria }), 'Huge');
    expect(encodedPromptLen(p)).toBeGreaterThan(MAX_PROMPT_ENCODED); // would have been trimmed before
    expect(p).toContain(criteria.trim());
    expect(p).toContain('_dream_context/state/huge.md');
    expect(p).not.toContain('truncated');
  });

  it('uses the caller-supplied title verbatim (no drift from the tab title)', () => {
    expect(buildDelegatePrompt(task({ slug: 'a-b-c', name: '' }), 'a b c')).toContain('Task: a b c');
  });
});

// ── The real corpus: every task in this vault must be delegable, WHOLE ─────────────────
// The regression that motivated this suite was found in real data, so it is guarded against
// real data — not just synthetic strings. The assertion has changed with the transport: it is
// no longer "every prompt fits 6KB" (they don't, and no longer need to), it is "every prompt
// gets a transport that carries it intact".
describe('delegateAgent — every real task in the vault is delegable intact', () => {
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

  function promptFor(f: string): { slug: string; prompt: string } | null {
    const raw = readFileSync(join(dir, f), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    if (!m) return null;
    const [, fm, body] = m;
    const slug = f.replace(/\.md$/, '');
    const name = /^name:\s*(.*)$/m.exec(fm)?.[1] ?? slug;
    return {
      slug,
      prompt: buildDelegatePrompt(
        task({
          slug,
          name,
          description: /^description:\s*(.*)$/m.exec(fm)?.[1] ?? '',
          why: section(body, 'Why'),
          user_stories: section(body, 'User Stories'),
          acceptance_criteria: section(body, 'Acceptance Criteria'),
        }),
        name,
      ),
    };
  }

  it('routes every task file to a transport that carries the prompt WHOLE', async () => {
    if (!existsSync(dir)) return; // vault-less checkout — nothing to assert
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);

    const overInlineCeiling: string[] = [];
    for (const f of files) {
      const built = promptFor(f);
      if (!built) continue;
      const { slug, prompt } = built;

      post.mockClear();
      const { inline, token } = await preparePrompt(prompt);

      // Exactly one transport, and whichever it is must carry the prompt unmodified.
      if (token) {
        expect(inline, `${slug}: token path must not also inline`).toBe('');
        expect((post.mock.calls[0][1] as { prompt: string }).prompt, `${slug}: token prompt altered`).toBe(prompt);
      } else {
        expect(inline, `${slug}: inline path must carry the prompt verbatim`).toBe(prompt);
        // THE invariant that keeps the socket alive: nothing inlined may exceed the ceiling.
        if (encodedPromptLen(inline) > MAX_PROMPT_ENCODED) {
          overInlineCeiling.push(`${slug} (${encodedPromptLen(inline)}B)`);
        }
      }
      // Every prompt carries its own recovery pointer, whatever the transport.
      expect(prompt).toContain(`_dream_context/state/${slug}.md`);
    }
    expect(
      overInlineCeiling,
      `tasks inlined past the ceiling — these would overflow the WS upgrade: ${overInlineCeiling.join(', ')}`,
    ).toEqual([]);
  });

  it('actually exercises the token path — the vault really does contain oversized tasks', async () => {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const oversized = files
      .map(promptFor)
      .filter((b): b is { slug: string; prompt: string } => !!b)
      .filter((b) => !promptFitsInline(b.prompt));
    // If this ever hits zero the routing above is vacuously green; make that visible rather
    // than letting the suite quietly stop testing the interesting half.
    expect(oversized.length, 'no real task exceeds the inline ceiling — token path untested by real data').toBeGreaterThan(0);
  });
});
