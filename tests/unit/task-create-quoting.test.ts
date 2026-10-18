/**
 * A task name may carry any text (W5 final gate, item 1). The create paths used to splice the
 * name, description, tags and version between bare double quotes, so a `"` or `\` ended the
 * YAML scalar early: the card was written but could not be parsed, and a proposal accept with
 * such a name answered 500 and then `exists` on retry. Every quoted scalar is now written as
 * a JSON string (a valid YAML double-quoted scalar); plain and Turkish names keep their bytes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { LocalTaskBackend, resetTaskReadMemo } from '../../src/lib/task-backend/local.js';
import { addProposal, acceptProposal, readProposals } from '../../src/lib/task-proposals.js';
import { DEFAULT_STATUSES } from '../../src/lib/task-status.js';
import { fillQuotedToken } from '../../src/lib/template-fill.js';
import { slugify } from '../../src/lib/id.js';

const NASTY = 'Export "CSV" as C:\\exports\\ödeme — İğdır şubesi';
const DESCRIPTION = 'Say "hi" \\ and \\n stay literal; Gölge İşleri';
let projectRoot: string;
let ctx: string;
let stateDir: string;

beforeEach(() => {
  const raw = join(tmpdir(), `dc-quote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  stateDir = join(ctx, 'state');
  mkdirSync(stateDir, { recursive: true });
  resetTaskReadMemo();
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

const card = (slug: string) => readFileSync(join(stateDir, `${slug}.md`), 'utf-8');
const parse = (slug: string) => matter(card(slug)).data as Record<string, unknown>;

describe('the create paths write any name as a valid scalar', () => {
  for (const variant of ['dashboard', 'cli'] as const) {
    it(`${variant}: a name with ", \\ and Turkish letters parses and round-trips exactly`, async () => {
      const backend = new LocalTaskBackend(stateDir);
      const created = await backend.create({
        name: NASTY, description: DESCRIPTION, tags: ['say "x"', 'back\\slash'], version: 'v"1"', why: 'Because.', variant,
      });
      const fm = parse(created.slug);
      expect(fm.name).toBe(NASTY);
      expect(fm.description).toBe(DESCRIPTION);
      if (variant === 'dashboard') {
        expect(fm.tags).toEqual(['say "x"', 'back\\slash']);
        expect(fm.version).toBe('v"1"');
      }
      resetTaskReadMemo();
      const read = await backend.get(created.slug);
      expect(read?.name).toBe(NASTY);
    });
  }

  it('a plain or Turkish name keeps its old bytes (the golden stays untouched)', async () => {
    const backend = new LocalTaskBackend(stateDir);
    const created = await backend.create({ name: 'Gölge İşleri: ığdır şubesi ödemesi', description: 'Plain words', tags: ['ui'], why: 'Because.', variant: 'dashboard' });
    const text = card(created.slug);
    expect(text).toContain('name: "Gölge İşleri: ığdır şubesi ödemesi"\n');
    expect(text).toContain('description: "Plain words"\n');
    expect(text).toContain('tags: ["ui"]\n');
  });

  it('fillQuotedToken escapes only inside the template\'s own quotes', () => {
    expect(fillQuotedToken('name: "{{NAME}}"\n# {{NAME}}', '{{NAME}}', 'a "b" \\c')).toBe('name: "a \\"b\\" \\\\c"\n# a "b" \\c');
    expect(fillQuotedToken('name: "{{NAME}}"', '{{NAME}}', 'Gölge')).toBe('name: "Gölge"');
  });
});

describe('a proposal accept with such a name', () => {
  it('files a parseable card and leaves the proposal accepted, not waiting', async () => {
    const name = `Export as CSV "now" <img src=x onerror="window.__xss=1"> \\ ödeme`;
    const p = addProposal(ctx, { name, why: 'The owner asked for it.', quote: 'can we export this as csv', basis: 'ask' });
    const backend = new LocalTaskBackend(stateDir);
    await acceptProposal(ctx, backend, DEFAULT_STATUSES, p.id, {}, 'dashboard');
    const slug = slugify(name);
    expect(parse(slug).name).toBe(name);
    expect(parse(slug).description).toBe(name);
    expect(readProposals(ctx).proposals.find((x) => x.id === p.id)?.status).not.toBe('pending');
  });
});
