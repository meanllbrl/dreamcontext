/**
 * A task name may carry any text (W5 final gate, item 1). The create paths used to splice the
 * name, description, tags and version between bare double quotes, so a `"` or `\` ended the
 * YAML scalar early: the card was written but could not be parsed, and a proposal accept with
 * such a name answered 500 and then `exists` on retry. Every quoted scalar is now written as
 * a JSON string (a valid YAML double-quoted scalar); plain and Turkish names keep their bytes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { LocalTaskBackend, resetTaskReadMemo } from '../../src/lib/task-backend/local.js';
import { addProposal, acceptProposal, readProposals } from '../../src/lib/task-proposals.js';
import { DEFAULT_STATUSES } from '../../src/lib/task-status.js';
import { fillQuotedToken } from '../../src/lib/template-fill.js';
import { slugify } from '../../src/lib/id.js';
import { Command } from 'commander';
import { registerFeaturesCommand } from '../../src/cli/commands/features.js';

const NASTY = 'Export "CSV" as C:\\exports\\ödeme — İğdır şubesi';
const DESCRIPTION = 'Say "hi" \\ and \\n stay literal; Gölge İşleri';
let projectRoot: string;
let ctx: string;
let stateDir: string;
let prevCwd: string;
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  const raw = join(tmpdir(), `dc-quote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  stateDir = join(ctx, 'state');
  mkdirSync(stateDir, { recursive: true });
  resetTaskReadMemo();
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  console.log = () => {};
  console.error = () => {};
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

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

/**
 * End review, finding 2: a replacement STRING expands `$&`, `$'`, `` $` `` and `$$`. "Fix $'
 * rounding" pasted the rest of the template into the card; "Save $$" was stored as "Save $".
 * Every create path now inserts values literally, in one pass.
 */
const DOLLAR_NAME = "Fix $' rounding, $` too, $& and $$ cash";
const DOLLAR_WHY = "Because $' and $` and $& and $$ must stay as typed; {{NAME}} too.";

describe('a $ in a name or a Why reaches the card as typed', () => {
  for (const variant of ['cli', 'dashboard'] as const) {
    it(`${variant === 'cli' ? 'tasks create' : 'the dashboard create'}: name, description and Why are byte-exact`, async () => {
      const backend = new LocalTaskBackend(stateDir);
      const created = await backend.create({ name: DOLLAR_NAME, description: DOLLAR_NAME, why: DOLLAR_WHY, variant });
      const text = card(created.slug);
      expect(text.match(/^---$/gm)).toHaveLength(2);
      const parsed = matter(text);
      expect(parsed.data.name).toBe(DOLLAR_NAME);
      expect(parsed.data.description).toBe(DOLLAR_NAME);
      expect(parsed.content).toContain(DOLLAR_WHY);
    });
  }

  it('features create: name, description and Why are byte-exact', async () => {
    mkdirSync(join(ctx, 'knowledge', 'features'), { recursive: true });
    const program = new Command();
    program.exitOverride();
    registerFeaturesCommand(program);
    await program.parseAsync(['node', 'dreamcontext', 'features', 'create', DOLLAR_NAME, '-w', DOLLAR_WHY, '-d', DOLLAR_NAME]);
    const dir = join(ctx, 'knowledge', 'features');
    const file = readdirSync(dir).find((f) => f.endsWith('.md'));
    expect(file, 'the feature file was written').toBeTruthy();
    const text = readFileSync(join(dir, file!), 'utf-8');
    expect(text.match(/^---$/gm)).toHaveLength(2);
    const parsed = matter(text);
    expect(parsed.data.name).toBe(DOLLAR_NAME);
    expect(parsed.data.description).toBe(DOLLAR_NAME);
    expect(parsed.content).toContain(DOLLAR_WHY);
  });

  it('a proposal accept: the card carries the name and the Why as proposed', async () => {
    const p = addProposal(ctx, { name: DOLLAR_NAME, why: DOLLAR_WHY, quote: 'can we fix the rounding', basis: 'ask' });
    await acceptProposal(ctx, new LocalTaskBackend(stateDir), DEFAULT_STATUSES, p.id, {}, 'dashboard');
    const slug = slugify(DOLLAR_NAME);
    expect(existsSync(join(stateDir, `${slug}.md`))).toBe(true);
    const parsed = matter(card(slug));
    expect(parsed.data.name).toBe(DOLLAR_NAME);
    expect(parsed.content).toContain(DOLLAR_WHY);
  });

  it('fillTemplate fills in one pass: a token inside a value is not expanded', async () => {
    const { fillTemplate } = await import('../../src/lib/template-fill.js');
    expect(fillTemplate('name: "{{NAME}}"\nwhy: {{WHY}}', { NAME: '{{WHY}} $&', WHY: '$$' }, ['NAME'])).toBe('name: "{{WHY}} $&"\nwhy: $$');
    // Adjacent quoted tokens each keep their own quotes.
    expect(fillTemplate('"{{NAME}}""{{DESCRIPTION}}"', { NAME: 'a"', DESCRIPTION: 'b' }, ['NAME', 'DESCRIPTION'])).toBe('"a\\"""b"');
  });
});
