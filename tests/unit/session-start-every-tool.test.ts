/**
 * The guard: every tool's new session gets the WHOLE budgeted snapshot, never one cut mid-way and
 * never an empty one.
 *
 * Measured 2026-11-02 on 0.40.0, a project whose snapshot was 49,372 chars against an 18,000-char
 * budget: 14 KB of it was pending peer mail, which was never-evict and unbounded. Claude's three
 * session-start hooks carried ~28,000 chars and dropped the rest (Objectives onward); Codex and
 * Antigravity got all of it, under a banner telling them it was INCOMPLETE, and said so.
 *
 * Each tool is checked through the code that hands it the text: Claude's part hooks
 * (`splitHookOutput`), Codex's app-context entries (`fitCodexContext`), Antigravity's tagged
 * blocks in the user message (`contextInWords`). On the built CLI, the real hooks run too: Claude's
 * three session-start processes, and the bridge's own `BrainContext` with its real hook runner.
 */
const CLI = join(__dirname, '../..', 'dist', 'index.js');
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureSnapshot } from '../../src/cli/commands/snapshot.js';
import { splitHookOutput } from '../../src/lib/hook-delivery.js';
import {
  applyBudget, type BudgetSection,
  HOOK_EXTRAS_RESERVE_CHARS, HOOK_OUTPUT_MAX_CHARS, SESSION_START_PARTS, SNAPSHOT_DELIVERY_CHAR_LIMIT,
} from '../../src/lib/snapshot-budget.js';
import { BrainContext, CODEX_ENTRY_MAX_BYTES, cliHookRunner, contextInWords, fitCodexContext } from '../../src/lib/t3-bridge/context.js';
import { setHookTool } from '../../src/lib/hook-tool.js';
import { composeMessage, writeMessage } from '../../src/lib/peer-mail.js';

let dir: string;
let root: string;
let originalHome: string | undefined;
let originalCwd: string;

/** A brain whose pending mail alone is past what three hooks carry: 40 long notes from a peer. */
function bigBrain(): void {
  root = join(dir, 'proj', '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(join(root, 'core', '0.soul.md'), [
    '---', 'name: Northwind Fixture', 'type: soul', '---', '',
    '## Project Identity', '', 'A synthetic brain for the session-start delivery guard.', '',
    '## Rules', '', ...Array.from({ length: 20 }, (_, i) => `- Rule ${i}: a binding rule about subsystem ${i}.`), '',
  ].join('\n'));
  writeFileSync(join(root, 'core', '2.memory.md'), [
    '---', 'name: active-decisions', 'type: memory', '---', '',
    '## Technical Decisions', '', ...Array.from({ length: 15 }, (_, i) => `- Decision ${i}: the store is keyed by id.`), '',
  ].join('\n'));
  for (let i = 0; i < 40; i++) {
    const msg = composeMessage(
      { from: 'acme-peer', to: 'northwind', kind: 'note', body: `Note ${i}: ${'a status update from the peer project. '.repeat(16)}` },
      new Date(Date.UTC(2026, 9, 1, 0, i)),
    );
    expect(writeMessage(root, msg).written).toBe(true);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-every-tool-'));
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  mkdirSync(join(dir, 'home'), { recursive: true });
  process.env.HOME = join(dir, 'home');
  bigBrain();
  process.chdir(join(dir, 'proj'));
});

afterEach(() => {
  setHookTool(null);
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
});

const headings = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('## '));

/** What the session-start hook prints beside the snapshot: a sleep line, a handoff banner. */
const extras = `${'⏰ a sleep directive line that rides the same hook output. '.repeat(Math.floor((HOOK_EXTRAS_RESERVE_CHARS - 200) / 60))}\n`;

describe('every tool gets the whole snapshot at session start', () => {
  it('the snapshot fits what Claude\'s part hooks carry, with room for what rides beside it', () => {
    const { text } = measureSnapshot(root);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length + HOOK_EXTRAS_RESERVE_CHARS).toBeLessThanOrEqual(SNAPSHOT_DELIVERY_CHAR_LIMIT);
    // A full mailbox is bounded, and what it does not show is counted with the command that shows it.
    expect(text).toMatch(/\(\+\d+ older message\(s\) not shown here: `dreamcontext peer inbox`/);
    expect(text).not.toContain('CONTEXT IS INCOMPLETE');
  });

  it('Claude: the part hooks carry every section, and nothing is named as dropped', () => {
    const { text } = measureSnapshot(root);
    const pieces = splitHookOutput(`${extras}${text}\n`);
    expect(pieces.length).toBeLessThanOrEqual(SESSION_START_PARTS);
    for (const p of pieces) {
      expect(p.trim().length).toBeGreaterThan(0);
      expect(p.length).toBeLessThanOrEqual(HOOK_OUTPUT_MAX_CHARS);
    }
    const delivered = pieces.join('\n');
    expect(delivered).not.toMatch(/more chars did not fit/);
    const missing = headings(text).filter((h) => !delivered.includes(h));
    expect(missing).toEqual([]);
    expect(delivered).toContain(text.split('\n').filter((l) => l.trim()).at(-1)!);
  });

  it('Codex and Antigravity get the same text as Claude, every entry under Codex\'s limit', () => {
    const claude = measureSnapshot(root).text;
    setHookTool('codex');
    const bridge = measureSnapshot(root).text;
    expect(bridge).toBe(claude);

    const entries = fitCodexContext([{ key: 'dreamcontext-brain', text: bridge }]);
    for (const e of entries) expect(Buffer.byteLength(e.text)).toBeLessThanOrEqual(CODEX_ENTRY_MAX_BYTES);
    expect(entries.map((e) => e.text).join('')).toBe(bridge);

    const words = contextInWords([{ key: 'dreamcontext-brain', text: bridge }]);
    for (const h of headings(bridge)) expect(words).toContain(h);
    expect(words).not.toContain('CONTEXT IS INCOMPLETE');
  });
});

describe('past the ladder, a section falls to its pointer before the tail is cut', () => {
  const section = (id: string, chars: number, extra: Partial<BudgetSection> = {}): BudgetSection =>
    ({ id, text: `## ${id}\n${'x'.repeat(chars)}`, ...extra });

  it('the last last-resort section goes first, only as far as needed, and the note names it', () => {
    const sections = [
      section('soul', 4_000, { neverEvict: true }),
      section('product', 3_000, { neverEvict: true, lastResort: '## product\nby path' }),
      section('objectives', 2_000),
      section('peer-mail', 20_000, { neverEvict: true, lastResort: '## peer-mail\n`dreamcontext peer inbox`' }),
    ];
    const r = applyBudget(sections, 4_500, {}, { deliveryChars: 20_000 });
    expect(r.lastResortIds).toEqual(['peer-mail']);
    expect(r.text).toContain('`dreamcontext peer inbox`');
    expect(r.text).toContain('## product\nxxx');
    expect(r.text).toContain('## objectives');
    expect(r.text.length).toBeLessThanOrEqual(20_000);
    expect(r.text).toContain('Shown as pointers so the rest arrives whole: peer-mail');
  });

  it('without a delivery limit, or under it, nothing falls to a pointer', () => {
    const sections = [section('peer-mail', 20_000, { neverEvict: true, lastResort: 'pointer' })];
    expect(applyBudget(sections, 4_500).lastResortIds).toEqual([]);
    expect(applyBudget(sections, 4_500, {}, { deliveryChars: 60_000 }).lastResortIds).toEqual([]);
  });
});

/**
 * A brain the ladder cannot fit: an active product's 190-line knowledge file (rendered whole while
 * its task is active) beside a full mailbox, and a stale setup version so a directive renders after
 * the product block. Both pointers are needed to fit.
 */
function heavyBrain(): void {
  writeFileSync(join(root, 'state', '.config.json'), JSON.stringify({ multiProduct: ['acme'], setupVersion: '0.1.0' }));
  writeFileSync(join(root, 'state', 'acme-launch.md'), [
    '---', 'id: acme-launch', 'name: Acme launch', 'status: in_progress', 'product: acme', 'priority: high', '---', '', '## Why', '', 'Ship it.', '',
  ].join('\n'));
  writeFileSync(join(root, 'state', '.active-task'), 'acme-launch');
  mkdirSync(join(root, 'knowledge', 'products'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'products', 'acme.md'), [
    '---', 'name: acme', 'type: knowledge', '---', '',
    ...Array.from({ length: 190 }, (_, i) => `- Acme fact ${i}: ${'a detail about the product that the agent reads before it works. '.repeat(2)}`),
  ].join('\n'));
}

/** Run one built hook the way the harness does: JSON on stdin, stdout back. */
function runHook(args: string[], input: object, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', ...args], { cwd: join(dir, 'proj'), env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('a brain past the fit', () => {
  beforeEach(() => heavyBrain());

  it('peer mail and the product file fall to pointers; what renders after them is kept', () => {
    const { text, budget } = measureSnapshot(root);
    expect(budget.lastResortIds).toEqual(['product-and-nudge', 'peer-mail']);
    expect(text.length + HOOK_EXTRAS_RESERVE_CHARS).toBeLessThanOrEqual(SNAPSHOT_DELIVERY_CHAR_LIMIT);
    expect(text).not.toContain('Acme fact 189');
    const pointer = text.indexOf('`_dream_context/knowledge/products/acme.md`');
    expect(pointer).toBeGreaterThan(-1);
    expect(text.indexOf('last refreshed at v0.1.0')).toBeGreaterThan(pointer);
    expect(text).toContain('`dreamcontext peer inbox` prints every message in full');
    expect(text).toContain('Shown as pointers so the rest arrives whole: product-and-nudge, peer-mail');
    expect(text).not.toContain('CONTEXT IS INCOMPLETE');
  });

  it.skipIf(!existsSync(CLI))('the real hooks: Claude\'s three parts and the Codex bridge carry the same whole text', async () => {
    const home = join(dir, 'home');
    mkdirSync(join(dir, 'proj', '.claude'), { recursive: true });
    const cmd = (name: string): { type: string; command: string; timeout: number } => ({ type: 'command', command: `dreamcontext hook ${name}`, timeout: 10 });
    writeFileSync(join(dir, 'proj', '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [cmd('session-start')] }, { hooks: [cmd('session-start-part 2')] }, { hooks: [cmd('session-start-part 3')] }] },
    }));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: join(dir, 'proj') };
    for (const k of ['DREAMCONTEXT_CONTEXT_BY', 'DREAMCONTEXT_TAB_SESSION', 'DREAMCONTEXT_CHAT_TAB', 'DREAMCONTEXT_SNAPSHOT_BUDGET']) delete env[k];

    const input = { session_id: 'every-tool-guard-0001', source: 'startup', hook_event_name: 'SessionStart' };
    const [p2, p3, p1] = await Promise.all([
      runHook(['session-start-part', '2'], input, env),
      runHook(['session-start-part', '3'], input, env),
      runHook(['session-start'], input, env),
    ]);
    const claude = [p1, p2, p3];
    expect(p1.trim().length).toBeGreaterThan(0);
    for (const p of claude) expect(p.length).toBeLessThanOrEqual(HOOK_OUTPUT_MAX_CHARS);
    const delivered = claude.join('\n');
    expect(delivered).not.toMatch(/more chars did not fit/);
    expect(delivered).not.toContain('CONTEXT IS INCOMPLETE');

    const brain = new BrainContext({ cwd: join(dir, 'proj'), env, run: cliHookRunner(process.execPath, CLI) });
    await brain.session('startup', 'every-tool-guard-thread');
    const codex = brain.snapshot;
    expect(codex.length).toBeGreaterThan(0);
    expect(codex).not.toContain('CONTEXT IS INCOMPLETE');
    const hs = headings(codex);
    expect(hs.length).toBeGreaterThan(5);
    expect(hs.filter((h) => !delivered.includes(h))).toEqual([]);
    expect(headings(delivered).filter((h) => !codex.includes(h))).toEqual([]);
    const entries = fitCodexContext(await brain.prompt('hello', 'every-tool-guard-thread'));
    for (const e of entries) expect(Buffer.byteLength(e.text)).toBeLessThanOrEqual(CODEX_ENTRY_MAX_BYTES);
    expect(entries.filter((e) => e.key.startsWith('dreamcontext-brain')).map((e) => e.text).join('')).toBe(codex);
  }, 60_000);
});

describe('a bridge is never told it was cut', () => {
  it('a soul past every limit: Claude gets the banner, Codex the same text without it', () => {
    writeFileSync(join(root, 'core', '0.soul.md'), [
      '---', 'name: Oversized Fixture', 'type: soul', '---', '',
      ...Array.from({ length: 420 }, (_, i) => `- Rule ${i}: ${'a binding rule that renders verbatim at every budget. '.repeat(1)}`),
    ].join('\n'));
    const claude = measureSnapshot(root).text;
    expect(claude).toContain('CONTEXT IS INCOMPLETE');
    setHookTool('codex');
    const codex = measureSnapshot(root).text;
    expect(codex).not.toContain('CONTEXT IS INCOMPLETE');
    expect(codex).not.toContain('OVERSIZED SNAPSHOT');
    for (const h of headings(claude)) expect(codex).toContain(h);
  });
});

describe('the part split never wastes the room it has', () => {
  it('a text that fits three parts arrives whole even when section cuts would leave parts short', () => {
    // A section start at ~70% of every window: section cuts alone would carry ~20,000 chars.
    const block = (i: number): string => `## Section ${i}\n${'- a line of section text that fills the part.\n'.repeat(150)}`;
    const text = Array.from({ length: 6 }, (_, i) => block(i)).join('\n').slice(0, SNAPSHOT_DELIVERY_CHAR_LIMIT - 300);
    const pieces = splitHookOutput(text);
    expect(pieces.join('\n')).not.toMatch(/did not fit/);
    for (const h of headings(text)) expect(pieces.join('\n')).toContain(h);
  });
});
