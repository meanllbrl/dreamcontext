/**
 * Unit tests for `parseChatActions` — the split between what an assistant answer wants the
 * Chat view to READ, to CLICK, and to DRAW.
 *
 * Two things carry real risk here and are pinned hardest:
 *   • the STREAMING path — this runs on every token, and a fence that hasn't closed yet must
 *     be hidden, not shown as raw JSON to the user mid-write;
 *   • the VALIDATION path — a button with no target behind it is a dead end the user still
 *     clicks, so a malformed entry must be dropped rather than rendered inert.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseChatActions, parseActionBlock, toAction, MAX_UIS_PER_MESSAGE, MAX_UI_BYTES,
} from '../../dashboard/src/components/sleepy/chat/chatActions.js';

const fence = (json: string) => '```dream-actions\n' + json + '\n```';

describe('parseChatActions — actions', () => {
  it('lifts a closed fence out of the prose entirely', () => {
    const text = `Done.\n\n${fence('[{"label":"Open the board","action":"board","path":"a/b.excalidraw.md"}]')}\n\nAnything else?`;
    const r = parseChatActions(text);
    expect(r.actions).toEqual([{ label: 'Open the board', action: 'board', path: 'a/b.excalidraw.md' }]);
    expect(r.body).toBe('Done.\n\nAnything else?');
    expect(r.body).not.toContain('dream-actions');
    expect(r.body).not.toContain('{');
  });

  it('accepts every kind with its own payload field', () => {
    // Split across two parses because the row is capped at 6 (see the cap test below) and
    // there are 7 kinds — the point here is that each kind is honoured, not the cap.
    const entities = parseChatActions(fence(JSON.stringify([
      { label: 'T', action: 'task', id: 'my-task' },
      { label: 'K', action: 'knowledge', id: 'recall-engine-v2' },
      { label: 'C', action: 'core', id: '1.soul.md' },
    ])));
    expect(entities.actions.map((a) => a.action)).toEqual(['task', 'knowledge', 'core']);
    expect(entities.actions[0]).toEqual({ label: 'T', action: 'task', id: 'my-task' });

    const paths = parseChatActions(fence(JSON.stringify([
      { label: 'F', action: 'file', path: 'src/a.ts' },
      { label: 'B', action: 'board', path: 'x.excalidraw.md' },
      { label: 'R', action: 'reveal', path: '/tmp/x.mp4' },
      { label: 'A', action: 'ask', text: 'run npm test' },
    ])));
    expect(paths.actions.map((a) => a.action)).toEqual(['file', 'board', 'reveal', 'ask']);
    expect(paths.actions[3]).toEqual({ label: 'A', action: 'ask', text: 'run npm test' });
  });

  it('drops an entry whose payload is missing — a button with nothing behind it', () => {
    const r = parseChatActions(fence(JSON.stringify([
      { label: 'no id', action: 'task' },
      { label: 'no path', action: 'board' },
      { label: 'blank ask', action: 'ask', text: '   ' },
      { label: 'wrong field', action: 'task', path: 'src/a.ts' },
      { label: 'good', action: 'task', id: 'ok' },
    ])));
    expect(r.actions).toEqual([{ label: 'good', action: 'task', id: 'ok' }]);
  });

  it('drops an unknown action, an empty label, and an over-long label', () => {
    const r = parseChatActions(fence(JSON.stringify([
      { label: 'rm', action: 'exec', path: '/bin/sh' },
      { label: '', action: 'task', id: 'x' },
      { label: 'x'.repeat(81), action: 'task', id: 'x' },
    ])));
    expect(r.actions).toEqual([]);
  });

  it('caps the row so an answer cannot turn into a menu', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, action: 'task', id: `t${i}` }));
    expect(parseChatActions(fence(JSON.stringify(many))).actions).toHaveLength(6);
  });

  it('survives malformed JSON without eating the answer', () => {
    const r = parseChatActions(`Here.\n\n${fence('[{"label": broken')}\n\nTail.`);
    expect(r.actions).toEqual([]);
    // The fence is still removed — half-written JSON is never prose.
    expect(r.body).toBe('Here.\n\nTail.');
  });

  it('accepts a single object as well as an array', () => {
    expect(parseActionBlock('{"label":"T","action":"task","id":"x"}')).toHaveLength(1);
  });

  it('leaves an ordinary code fence completely alone', () => {
    const text = 'Run this:\n\n```bash\nnpm test\n```\n';
    const r = parseChatActions(text);
    expect(r.actions).toEqual([]);
    expect(r.body).toContain('```bash');
    expect(r.body).toContain('npm test');
  });
});

describe('parseChatActions — streaming', () => {
  it('hides a fence that is still being written', () => {
    const partial = 'Done.\n\n```dream-actions\n[{"label":"Open the bo';
    const r = parseChatActions(partial);
    expect(r.body).toBe('Done.');
    expect(r.body).not.toContain('label');
    expect(r.actions).toEqual([]);
  });

  it('hides the fence marker the instant it opens, before any JSON exists', () => {
    expect(parseChatActions('Done.\n\n```dream-actions').body).toBe('Done.');
  });

  it('renders the buttons as soon as the fence closes', () => {
    const done = 'Done.\n\n' + fence('[{"label":"Go","action":"task","id":"t"}]');
    expect(parseChatActions(done).actions).toHaveLength(1);
  });
});

describe('parseChatActions — boards', () => {
  it('extracts an image-syntax board reference and removes it from the prose', () => {
    const r = parseChatActions('Here it is:\n\n![board](docs/launch.excalidraw.md)\n\nDone.');
    expect(r.boards).toEqual(['docs/launch.excalidraw.md']);
    expect(r.body).toBe('Here it is:\n\nDone.');
  });

  it('extracts a link-syntax board reference and a bare .excalidraw file', () => {
    const r = parseChatActions('[the board](a/b.excalidraw) and ![x](c/d.excalidraw.md)');
    expect(r.boards).toEqual(['a/b.excalidraw', 'c/d.excalidraw.md']);
  });

  it('de-duplicates a board named twice', () => {
    const r = parseChatActions('![a](x.excalidraw.md)\n\n![again](x.excalidraw.md)');
    expect(r.boards).toEqual(['x.excalidraw.md']);
  });

  it('leaves an ordinary image alone — that path already renders inline', () => {
    const r = parseChatActions('![shot](docs/shot.png)');
    expect(r.boards).toEqual([]);
    expect(r.body).toContain('docs/shot.png');
  });

  it('handles an answer that is ONLY a board reference', () => {
    const r = parseChatActions('![board](x.excalidraw.md)');
    expect(r.body).toBe('');
    expect(r.boards).toEqual(['x.excalidraw.md']);
  });
});

describe('parseChatActions — dream-ui (OpenUI mode, experimental)', () => {
  const ui = (src: string) => '```dream-ui\n' + src + '\n```';

  it('lifts a closed fence out of the prose and keeps the SOURCE, not markup', () => {
    const r = parseChatActions(`Here:\n\n${ui('root = Stack([chart])')}\n\nThat is the shape.`);
    expect(r.blocks).toEqual([{ kind: 'ui', source: 'root = Stack([chart])' }]);
    expect(r.body).toBe('Here:\n\nThat is the shape.');
    expect(r.body).not.toContain('dream-ui');
    expect(r.body).not.toContain('Stack');
  });

  it('keeps WRITTEN ORDER against the other two fences — one alternation, not three passes', () => {
    const text = [
      'One.',
      ui('root = Stack([a])'),
      'Two.',
      '```dream-html\n<p>x</p>\n```',
      'Three.',
      ui('root = Stack([b])'),
    ].join('\n\n');
    const r = parseChatActions(text);
    expect(r.blocks.map((b) => b.kind)).toEqual(['ui', 'html', 'ui']);
    expect(r.segments.map((s) => s.kind)).toEqual(['prose', 'ui', 'prose', 'html', 'prose', 'ui']);
  });

  it('hides a still-open fence and reports it as pending, carrying the partial source', () => {
    const r = parseChatActions('Drawing it.\n\n```dream-ui\nroot = Stack([\n  Chart(');
    expect(r.body).toBe('Drawing it.');
    expect(r.body).not.toContain('Stack');
    expect(r.pendingView).toBe(true);
    const last = r.segments[r.segments.length - 1];
    expect(last.kind).toBe('pending');
    if (last.kind === 'pending') {
      expect(last.fence).toBe('ui');
      // Threaded now so the streaming exception (Wave 3) is a change to the view alone.
      expect(last.partial).toContain('Stack');
    }
  });

  it('caps how many one answer may draw, and says so', () => {
    const text = Array.from({ length: MAX_UIS_PER_MESSAGE + 2 }, (_, i) => ui(`root = Stack([${i}])`)).join('\n\n');
    const r = parseChatActions(text);
    expect(r.blocks.filter((b) => b.kind === 'ui')).toHaveLength(MAX_UIS_PER_MESSAGE);
    expect(r.notices.some((n) => /more than \d+ UI blocks/.test(n))).toBe(true);
  });

  it('drops an over-sized body with a notice rather than mounting it', () => {
    const r = parseChatActions(ui('x'.repeat(MAX_UI_BYTES + 1)));
    expect(r.blocks).toHaveLength(0);
    expect(r.notices.some((n) => /over the \d+KB limit/.test(n))).toBe(true);
  });

  it('counts its cap SEPARATELY from dream-html — one kind cannot exhaust the other', () => {
    const html = Array.from({ length: 5 }, (_, i) => '```dream-html\n<p>' + i + '</p>\n```').join('\n\n');
    const r = parseChatActions(`${html}\n\n${ui('root = Stack([a])')}`);
    expect(r.blocks.filter((b) => b.kind === 'html')).toHaveLength(5);
    expect(r.blocks.filter((b) => b.kind === 'ui')).toHaveLength(1);
    expect(r.notices).toHaveLength(0);
  });

  it('drops an empty body without a notice — nothing was asked for', () => {
    const r = parseChatActions('Text.\n\n```dream-ui\n   \n```');
    expect(r.blocks).toHaveLength(0);
    expect(r.notices).toHaveLength(0);
    expect(r.body).toBe('Text.');
  });
});

describe('parseChatActions — empty input', () => {
  it('returns empties for an empty message rather than throwing', () => {
    expect(parseChatActions('')).toEqual({
      segments: [], body: '', actions: [], boards: [], blocks: [], views: [], notices: [], pendingView: false,
    });
  });
});

describe('toAction — url kind', () => {
  it('accepts an https: URL', () => {
    expect(toAction({ label: 'Listing', action: 'url', url: 'https://example.com/car/1' }))
      .toEqual({ label: 'Listing', action: 'url', url: 'https://example.com/car/1' });
  });

  it('rejects http:, javascript:, data: and file: URLs', () => {
    for (const url of [
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
    ]) {
      expect(toAction({ label: 'x', action: 'url', url }), url).toBeNull();
    }
  });

  // Criterion 27. The pinned shelf gains a DELIBERATE loopback carve-out for its pin FACTS
  // (`sanitizeLoopbackUrl`, chatViewSpec.ts) — the `url` ACTION is deliberately NOT widened
  // with it, so the two gates cannot be conflated later. A narrower carve-out is a smaller
  // thing to get wrong, and nothing in the goal asked an action button to reach loopback.
  // These are correctness assertions of the narrowed design, not an oversight.
  it('still rejects loopback http URLs — the carve-out is pin-facts-only', () => {
    for (const url of [
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://[::1]:8080',
    ]) {
      expect(toAction({ label: 'Open the dev server', action: 'url', url }), url).toBeNull();
    }
  });

  it('accepts https on loopback — the scheme is the rule, not the host', () => {
    expect(toAction({ label: 'x', action: 'url', url: 'https://localhost:5173/app' }))
      .toEqual({ label: 'x', action: 'url', url: 'https://localhost:5173/app' });
  });

  it('rejects a url action with no url, or an unparseable one', () => {
    expect(toAction({ label: 'x', action: 'url' })).toBeNull();
    expect(toAction({ label: 'x', action: 'url', url: 'not a url' })).toBeNull();
  });

  it('a dream-actions fence honours a valid url button and drops an unsafe one', () => {
    const r = parseChatActions(fence(JSON.stringify([
      { label: 'Open listing', action: 'url', url: 'https://example.com' },
      { label: 'Steal cookies', action: 'url', url: 'javascript:alert(document.cookie)' },
    ])));
    expect(r.actions).toEqual([{ label: 'Open listing', action: 'url', url: 'https://example.com' }]);
  });
});

/**
 * The Plan → Develop hand-off button. Its `id` is the whole payload of a session hand-off:
 * a malformed slug would seed a fresh Develop agent with a brief pointing at nothing, and
 * the user would only find out a turn later. So the grammar is stricter than the other
 * id-carrying kinds and is pinned here rather than trusted.
 */
describe('toAction — develop kind (Plan → Develop hand-off)', () => {
  it('accepts a safe task slug', () => {
    expect(toAction({ label: 'Go to development', action: 'develop', id: 'chat-density-shrink-chrome' }))
      .toEqual({ label: 'Go to development', action: 'develop', id: 'chat-density-shrink-chrome' });
  });

  it('accepts the full punctuation set a dreamcontext slug can carry', () => {
    expect(toAction({ label: 'x', action: 'develop', id: 'Task_v0.25.0-final' }))
      .toEqual({ label: 'x', action: 'develop', id: 'Task_v0.25.0-final' });
  });

  it('accepts a 64-char slug and drops a 65-char one', () => {
    const at64 = 'a'.repeat(64);
    expect(toAction({ label: 'x', action: 'develop', id: at64 }))
      .toEqual({ label: 'x', action: 'develop', id: at64 });
    expect(toAction({ label: 'x', action: 'develop', id: 'a'.repeat(65) })).toBeNull();
  });

  it('drops a slug carrying a separator, a traversal, whitespace or nothing at all', () => {
    for (const id of ['../x', 'a/b', 'a\\b', '', '   ', 'a b', 'a;rm -rf /', 'a\u0000b']) {
      expect(toAction({ label: 'x', action: 'develop', id }), JSON.stringify(id)).toBeNull();
    }
  });

  it('drops a develop action with no id at all', () => {
    expect(toAction({ label: 'Go to development', action: 'develop' })).toBeNull();
  });

  it("honours the plan briefing's own button, verbatim", () => {
    // The exact shape `modeBriefing('plan')` teaches the agent to emit (src/server/chat-modes.ts).
    // If these two ever drift, the hand-off silently stops rendering — so the fence is parsed
    // here rather than the object being hand-built.
    const r = parseChatActions(fence('[{"label": "Go to development", "action": "develop", "id": "my-task-slug"}]'));
    expect(r.actions).toEqual([{ label: 'Go to development', action: 'develop', id: 'my-task-slug' }]);
    expect(r.body).not.toContain('dream-actions');
  });

  it('drops a malformed develop button without taking its neighbours down', () => {
    const r = parseChatActions(fence(JSON.stringify([
      { label: 'Bad', action: 'develop', id: '../../etc/passwd' },
      { label: 'Good', action: 'develop', id: 'real-slug' },
    ])));
    expect(r.actions).toEqual([{ label: 'Good', action: 'develop', id: 'real-slug' }]);
  });
});

describe('BoardCanvas — fully removed (Capability 3, criterion 10)', () => {
  /** Every text file under `dashboard/src/`, recursing manually rather than relying on
   *  `readdirSync`'s `recursive` option — that option needs Node 20.1+/18.17+, and this
   *  repo's `engines.node` floor is `>=18`. */
  function collectFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        out.push(...collectFiles(full));
      } else {
        out.push(full);
      }
    }
    return out;
  }

  it('dashboard/src contains no reference to BoardCanvas', () => {
    const root = new URL('../../dashboard/src', import.meta.url).pathname;
    const offenders = collectFiles(root).filter((f) => readFileSync(f, 'utf-8').includes('BoardCanvas'));
    expect(offenders).toEqual([]);
  });
});
