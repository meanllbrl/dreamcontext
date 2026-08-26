/**
 * Unit tests for the two shelf `dream-view` types and the loopback carve-out that makes one
 * of them clickable.
 *
 * `sanitizeLoopbackUrl` is the highest-risk function in this change: it is the ONE place
 * `http:` is permitted on a surface that is otherwise https-only, and the hosts it permits
 * include the dashboard's own loopback port. Its accept and reject tables are therefore
 * written out in full rather than sampled, and each table row carries the reason it is on
 * the side it is on — several of the ACCEPTED entries look like attacks and are not, and one
 * of the REJECTED entries looks safe and is deliberately refused.
 *
 * The empirical claim underneath the accept table (that WHATWG `URL` normalizes every
 * alternative spelling of loopback to the canonical host) is asserted, not assumed: each
 * accepted form is checked to come back on `127.0.0.1` / `localhost` / `[::1]`. If a runtime
 * ever normalizes differently, this fails loudly — and it fails CLOSED, because a form that
 * stops normalizing simply stops matching the host set.
 */
import { describe, it, expect } from 'vitest';
import {
  parseViewBlock, sanitizeLoopbackUrl,
  MAX_PIN_FACTS, MAX_PIN_DETAIL_CHARS, MAX_PIN_LEDE_CHARS, MAX_TAG_LABEL_CHARS,
  type PinViewSpec, type ProgressViewSpec,
} from '../../dashboard/src/lib/chatViewSpec.js';

/** `parseViewBlock` takes `toAction` by injection; no test here uses a card action. */
const stubToAction = () => null;

const parse = (payload: unknown) => parseViewBlock(JSON.stringify(payload), stubToAction);
const pin = (extra: Record<string, unknown>) => parse({ type: 'pin', id: 'p', ...extra });

describe('sanitizeLoopbackUrl — the accept table', () => {
  // Each of these is a spelling the browser and the OS opener resolve to loopback. Accepting
  // them is safe BY CONSTRUCTION: we compare the same normalized host they will resolve.
  const accepted: Array<[label: string, input: string, host: string]> = [
    ['the plain form', 'http://localhost:5173', 'localhost'],
    ['the dotted-quad form', 'http://127.0.0.1:3000', '127.0.0.1'],
    ['the IPv6 literal', 'http://[::1]:8080', '[::1]'],
    ['https on loopback', 'https://localhost:5173', 'localhost'],
    ['an uppercase host', 'http://LOCALHOST:5173', 'localhost'],
    ['the short-octet form', 'http://127.1', '127.0.0.1'],
    ['the octal form', 'http://0177.0.0.1', '127.0.0.1'],
    ['the hex form', 'http://0x7f000001', '127.0.0.1'],
    ['the decimal form', 'http://2130706433', '127.0.0.1'],
    ['an IDNA circled digit', 'http://①27.0.0.1', '127.0.0.1'],
    ['IDNA ideographic full stops', 'http://127。0。0。1', '127.0.0.1'],
    ['the expanded IPv6 literal', 'http://[0:0:0:0:0:0:0:1]:1', '[::1]'],
  ];

  for (const [label, input, host] of accepted) {
    it(`accepts ${label} and normalizes it to ${host}`, () => {
      const { url } = sanitizeLoopbackUrl(input);
      expect(url, `${input} was rejected`).not.toBeNull();
      expect(new URL(url as string).hostname).toBe(host);
    });
  }
});

describe('sanitizeLoopbackUrl — the reject table', () => {
  const rejected: Array<[reason: string, input: string]> = [
    ['a public name that merely starts with "localhost"', 'http://localhost.evil.com'],
    ['a public name that merely starts with the loopback quad', 'http://127.0.0.1.evil.com/x'],
    ['embedded credentials', 'http://user:pass@localhost/'],
    ['a fragment that only looks like a host', 'http://evil.com#@localhost'],
    // 0.0.0.0 is NOT loopback, but a connection to it lands there on Linux and Windows —
    // the one non-loopback host that behaves like one, refused by its own explicit check.
    ['0.0.0.0, which routes to loopback on several OSes', 'http://0.0.0.0:5173'],
    // FAIL-CLOSED ON PURPOSE. `[::ffff:127.0.0.1]` normalizes to `[::ffff:7f00:1]`, which is
    // not in the host set. An IPv4-mapped IPv6 literal is a form no user types; do not move
    // this to the accept table without re-deriving the safety argument in the doc comment.
    ['an IPv4-mapped IPv6 literal (normalizes to [::ffff:7f00:1])', 'http://[::ffff:127.0.0.1]:5173'],
    ['a protocol-relative reference', '//localhost:5173'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a file: URL on a loopback-looking path', 'file://localhost/etc/passwd'],
    ['a scheme-less token', 'localhost:5173'],
    ['a plain public https host is not this gate’s business', 'https://example.com'],
    ['the empty string', ''],
  ];

  for (const [reason, input] of rejected) {
    it(`rejects ${reason}`, () => {
      expect(sanitizeLoopbackUrl(input).url, `${input} was accepted`).toBeNull();
    });
  }

  it('sees what the browser sees — control bytes are stripped before the host compare', () => {
    // `java\tscript:` is the classic obfuscation; the browser drops the tab before acting,
    // so a gate that does not is checking a string nobody will ever request.
    expect(sanitizeLoopbackUrl('java\tscript:alert(1)').url).toBeNull();
    expect(sanitizeLoopbackUrl(' http://localhost:5173 ').url).toBe('http://localhost:5173/');
  });
});

describe('sanitizeLoopbackUrl — query and fragment', () => {
  it('strips both and reports it', () => {
    const r = sanitizeLoopbackUrl('http://localhost:5173/app?token=abc#frag');
    expect(r.url).toBe('http://localhost:5173/app');
    expect(r.strippedQuery).toBe(true);
  });

  it('leaves a clean URL alone and says nothing was stripped', () => {
    const r = sanitizeLoopbackUrl('http://127.0.0.1:3000/health');
    expect(r.url).toBe('http://127.0.0.1:3000/health');
    expect(r.strippedQuery).toBe(false);
  });
});

describe('parseViewBlock — type: pin', () => {
  it('accepts a tag pin and keeps its facts', () => {
    const r = pin({ weight: 'tag', facts: [{ label: ':5173', url: 'http://localhost:5173' }] });
    const view = r.view as PinViewSpec;
    expect(view.type).toBe('pin');
    expect(view.id).toBe('p');
    expect(view.weight).toBe('tag');
    expect(view.facts).toEqual([{ label: ':5173', url: 'http://localhost:5173/' }]);
    expect(r.notices).toEqual([]);
  });

  it('skips a pin whose id is missing or has key-breaking characters', () => {
    for (const id of ['', '   ', 'a/b', 'a b', 'x'.repeat(65)]) {
      const r = parse({ type: 'pin', id, facts: [{ label: 'x' }] });
      expect(r.view, `id ${JSON.stringify(id)} was accepted`).toBeNull();
      expect(r.notices[0]).toContain('id');
    }
  });

  it('defaults an ABSENT weight to tag, silently', () => {
    const r = pin({ facts: [{ label: 'x' }] });
    expect((r.view as PinViewSpec).weight).toBe('tag');
    expect(r.notices).toEqual([]);
  });

  it('defaults an UNKNOWN weight to tag, loudly', () => {
    const r = pin({ weight: 'huge', facts: [{ label: 'x' }] });
    expect((r.view as PinViewSpec).weight).toBe('tag');
    expect(r.notices.join(' ')).toContain('weight');
  });

  it(`drops facts past ${MAX_PIN_FACTS} with a notice naming how many`, () => {
    const facts = Array.from({ length: MAX_PIN_FACTS + 3 }, (_, i) => ({ label: `f${i}` }));
    const r = pin({ facts });
    expect((r.view as PinViewSpec).facts).toHaveLength(MAX_PIN_FACTS);
    expect(r.notices.join(' ')).toContain('3 were dropped');
  });

  it('clamps an over-long fact label and says so', () => {
    const label = 'x'.repeat(MAX_TAG_LABEL_CHARS + 20);
    const r = pin({ facts: [{ label }] });
    expect((r.view as PinViewSpec).facts[0].label).toHaveLength(MAX_TAG_LABEL_CHARS);
    expect(r.notices.join(' ')).toMatch(/shortened/);
  });

  it('drops a fact with no label at all', () => {
    const r = pin({ facts: [{ label: '   ' }, { label: 'kept' }] });
    expect((r.view as PinViewSpec).facts).toEqual([{ label: 'kept' }]);
  });

  it('drops a non-loopback URL but KEEPS the fact — a link you cannot click beats a fact you cannot read', () => {
    const r = pin({ facts: [{ label: 'staging', url: 'http://staging.internal:8080' }] });
    const view = r.view as PinViewSpec;
    expect(view.facts).toEqual([{ label: 'staging' }]);
    expect(view.facts[0].url).toBeUndefined();
    expect(r.notices.join(' ')).toContain('localhost');
  });

  it("reports a stripped query on a fact's URL", () => {
    const r = pin({ facts: [{ label: 'app', url: 'http://localhost:5173/?vault=other' }] });
    expect((r.view as PinViewSpec).facts[0].url).toBe('http://localhost:5173/');
    expect(r.notices.join(' ')).toContain('query string');
  });

  it('keeps a marker fact as a marker', () => {
    const r = pin({ facts: [{ label: 'worktree', marker: true }] });
    expect((r.view as PinViewSpec).facts[0].marker).toBe(true);
  });

  it('clamps an over-long lede and detail, each with its own notice', () => {
    const r = pin({
      weight: 'row',
      facts: [],
      lede: 'l'.repeat(MAX_PIN_LEDE_CHARS + 5),
      detail: 'd'.repeat(MAX_PIN_DETAIL_CHARS + 5),
    });
    const view = r.view as PinViewSpec;
    expect(view.lede).toHaveLength(MAX_PIN_LEDE_CHARS);
    expect(view.detail).toHaveLength(MAX_PIN_DETAIL_CHARS);
    expect(r.notices.filter((n) => /shortened/.test(n))).toHaveLength(2);
  });

  it('STRIPS ledeClamped from author input — only the shelf may say it clamped a line', () => {
    const r = pin({ weight: 'row', facts: [], lede: 'short', detail: 'prose', ledeClamped: true });
    expect((r.view as PinViewSpec).ledeClamped).toBeUndefined();
  });

  it('skips a pin with nothing to show at all', () => {
    const r = pin({ weight: 'row', facts: [] });
    expect(r.view).toBeNull();
    expect(r.notices.join(' ')).toMatch(/no facts, lede or detail/);
  });

  it('never throws on a hostile payload', () => {
    for (const payload of [
      { type: 'pin', id: 'p', facts: 'not-an-array' },
      { type: 'pin', id: 'p', facts: [null, 7, [], { label: 1 }] },
      { type: 'pin', id: 'p', facts: [{ label: 'x', url: 12 }] },
      { type: 'pin', id: {}, facts: [] },
    ]) {
      expect(() => parse(payload)).not.toThrow();
    }
  });
});

/**
 * The RETIREMENT half of the pin contract. Update-in-place alone left the agent able to
 * correct a pin forever but never to take one down, so a fact that had stopped being true
 * (a port that moved, a blocker that cleared) stood on the shelf until the user pressed `×`
 * — the defect the owner reported on 2026-08-25 with a tag line full of resolved conditions.
 *
 * The asymmetry worth reading twice: a drop that ALSO carries facts is honoured as a drop.
 * A payload saying both "remove this" and "show that" is an agent contradicting itself, and
 * the half worth keeping is the removal — the failure mode this field exists to end is a pin
 * that cannot die, and it must not be resurrected by a leftover key.
 */
describe('parseViewBlock — type: pin, the drop', () => {
  it('accepts a drop carrying only an id', () => {
    const r = pin({ drop: true });
    const view = r.view as PinViewSpec;
    expect(view).toEqual({ type: 'pin', id: 'p', weight: 'tag', facts: [], drop: true });
    expect(r.notices).toEqual([]);
  });

  it('says nothing about a weight that rode along — a weight is not content', () => {
    const r = pin({ drop: true, weight: 'row' });
    expect((r.view as PinViewSpec).drop).toBe(true);
    expect(r.notices).toEqual([]);
  });

  it('is still a drop when content rode along, and names what it ignored', () => {
    for (const [key, value] of [
      ['facts', [{ label: ':5173' }]],
      ['lede', 'the server is up'],
      ['detail', 'a paragraph nobody asked for'],
    ] as const) {
      const r = pin({ drop: true, [key]: value });
      const view = r.view as PinViewSpec;
      expect(view.drop, `${key} defeated the drop`).toBe(true);
      expect(view.facts).toEqual([]);
      expect(view.lede).toBeUndefined();
      expect(view.detail).toBeUndefined();
      expect(r.notices.join(' ')).toContain(key);
      expect(r.notices.join(' ')).toMatch(/dropped/);
    }
  });

  it('never lets a dropping pin claim the shelf clamped it', () => {
    const r = pin({ drop: true, detail: 'x'.repeat(MAX_PIN_DETAIL_CHARS + 10), ledeClamped: true });
    expect(r.view).not.toHaveProperty('ledeClamped');
  });

  it('reads drop:false as an ordinary pin, silently', () => {
    const r = pin({ drop: false, weight: 'tag', facts: [{ label: ':5173' }] });
    const view = r.view as PinViewSpec;
    expect(view.drop).toBeUndefined();
    expect(view.facts).toEqual([{ label: ':5173' }]);
    expect(r.notices).toEqual([]);
  });

  it('ignores a drop that is neither true nor false, loudly', () => {
    for (const value of ['true', 1, {}, [], null]) {
      const r = pin({ drop: value, weight: 'tag', facts: [{ label: ':5173' }] });
      const view = r.view as PinViewSpec;
      expect(view, `drop ${JSON.stringify(value)} removed a pin`).not.toBeNull();
      expect(view.drop).toBeUndefined();
      expect(view.facts).toEqual([{ label: ':5173' }]);
      expect(r.notices.join(' '), `drop ${JSON.stringify(value)} passed silently`).toMatch(/neither true nor false/);
    }
  });

  it('a truthy-looking drop with nothing else is still skipped as an empty pin', () => {
    // The two rules compose: the bad `drop` is ignored, and what is left has nothing to show.
    const r = pin({ drop: 'yes' });
    expect(r.view).toBeNull();
    expect(r.notices.join(' ')).toMatch(/neither true nor false/);
    expect(r.notices.join(' ')).toMatch(/no facts, lede or detail/);
  });

  it('needs a valid id like any other pin — a drop is not a way past the id gate', () => {
    for (const id of ['', '   ', 'a b', 'a/b', '#x', 'x'.repeat(65)]) {
      const r = parse({ type: 'pin', id, drop: true });
      expect(r.view, `id ${JSON.stringify(id)} was accepted`).toBeNull();
      expect(r.notices[0]).toContain('id');
    }
  });

  it('never throws on a hostile drop payload', () => {
    for (const payload of [
      { type: 'pin', id: 'p', drop: true, facts: 'not-an-array' },
      { type: 'pin', id: 'p', drop: { true: true } },
      { type: 'pin', id: 'p', drop: true, lede: 7, detail: [] },
    ]) {
      expect(() => parse(payload)).not.toThrow();
    }
  });
});

describe('parseViewBlock — type: progress', () => {
  it('accepts a bare slug', () => {
    const r = parse({ type: 'progress', task: 'my-task-slug' });
    expect(r.view as ProgressViewSpec).toEqual({ type: 'progress', task: 'my-task-slug' });
    expect(r.notices).toEqual([]);
  });

  it('skips a missing or non-slug task', () => {
    for (const task of ['', '   ', '../../etc/passwd', 'a/b', 'x'.repeat(121), 42]) {
      const r = parse({ type: 'progress', task });
      expect(r.view, `task ${JSON.stringify(task)} was accepted`).toBeNull();
      expect(r.notices[0]).toContain('task');
    }
  });

  it('IGNORES an agent-supplied percent and draws a notice — derived, never asserted', () => {
    for (const key of ['percent', 'pct', 'done', 'total']) {
      const r = parse({ type: 'progress', task: 'slug', [key]: 64 });
      // The block still renders — the number is simply not the agent's to give.
      expect((r.view as ProgressViewSpec).task).toBe('slug');
      expect(r.view).not.toHaveProperty(key);
      expect(r.notices.join(' '), `"${key}" was accepted silently`).toContain('ignored');
    }
  });

  it('says nothing when the agent sent only the slug', () => {
    expect(parse({ type: 'progress', task: 'slug' }).notices).toEqual([]);
  });
});
