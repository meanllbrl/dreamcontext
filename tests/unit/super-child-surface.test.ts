/**
 * The lean surface a Super Agent's child gets (task her-oturumun-sabit-girdisi-kuculur…):
 * each card's rule and example in the prompt, the full text as a file it reads on demand.
 *
 *   1. Nothing lost: every unit of the full text is kept, reworded (the ledger names the phrase
 *      that carries it) or ledgered to the reference. An unclassified unit, a stale ledger key
 *      or a reworded phrase that is not in the lean text is red.
 *   2. Every card example the lean text shows is one the real parser accepts.
 *   3. The reference file is the full text, written outside the project, and the spawn reads
 *      it without a prompt; no file = the full briefing, never a pointer at nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  CHAT_SURFACE_BRIEFING,
  CHAT_SURFACE_REFERENCE,
  CHAT_SURFACE_REFERENCE_FILE,
  SUPER_CHILD_BRIEFING,
  superChildSurfaceBriefing,
  writeChatSurfaceReference,
  chatSurfaceReferenceReadRule,
} from '../../src/server/chat-surface.js';
import { parseChatActions } from '../../dashboard/src/components/sleepy/chat/chatActions.js';
import { norm, unitsOf } from './super-child-surface.units.js';
import { REWORDED, TO_REFERENCE } from './super-child-surface.ledger.js';

const REF = '/home/someone/.dreamcontext/chat/surface-reference.md';
const LEAN = superChildSurfaceBriefing(REF);
/** Everything a child is told about the surface: the lean text, then its Super section. */
const CHILD = norm(`${LEAN}\n${SUPER_CHILD_BRIEFING}`);

describe('size: the point of the lean text', () => {
  it('is under half of the full text it replaces, and names the reference', () => {
    expect(LEAN.length).toBeLessThan(6000);
    expect(LEAN.length).toBeLessThan(CHAT_SURFACE_BRIEFING.length / 2);
    expect(LEAN).toContain(REF);
  });
});

describe('nothing lost: every unit of the full text is kept, reworded or ledgered', () => {
  const units = unitsOf(CHAT_SURFACE_BRIEFING);
  const keyOf = (u: string): string[] => [...REWORDED.map(([k]) => k), ...TO_REFERENCE].filter((k) => norm(u).startsWith(k));

  it('splits the full text into units at all', () => {
    expect(units.length).toBeGreaterThan(80);
  });

  it('classifies every unit exactly once', () => {
    const unclassified: string[] = [];
    const twice: string[] = [];
    for (const u of units) {
      if (CHILD.includes(norm(u.text))) continue;
      const keys = keyOf(u.text);
      if (keys.length === 0) unclassified.push(`[${u.heading}] ${u.text}`);
      if (keys.length > 1) twice.push(`[${u.heading}] ${u.text}: ${keys.join(' | ')}`);
    }
    expect(unclassified, 'a unit of the full text the lean text neither keeps nor ledgers').toEqual([]);
    expect(twice).toEqual([]);
  });

  it('every reworded unit is carried by a phrase the lean text really has', () => {
    const missing = REWORDED.filter(([, phrase]) => !CHILD.includes(norm(phrase))).map(([k, p]) => `${k} -> ${p}`);
    expect(missing).toEqual([]);
  });

  it('every ledgered unit is in the reference, under the heading the full text gives it', () => {
    const refUnits = unitsOf(CHAT_SURFACE_REFERENCE);
    for (const key of TO_REFERENCE) {
      const u = units.find((x) => norm(x.text).startsWith(key));
      expect(u, `stale ledger key: ${key}`).toBeDefined();
      expect(refUnits.some((r) => r.heading === u!.heading && r.text === u!.text), key).toBe(true);
    }
  });

  it('has no stale reworded key', () => {
    const stale = REWORDED.filter(([k]) => !units.some((u) => norm(u.text).startsWith(k))).map(([k]) => k);
    expect(stale).toEqual([]);
  });
});

describe('the cards a child sends: its rule and an example the parser accepts', () => {
  /** Every inline `{"type":…}` the lean text shows. */
  const examples = [...LEAN.matchAll(/`(\{"type":"[^`]+\})`/g)].map((m) => m[1]);

  it('shows the cards a child sends most, each accepted by the real parser as written', () => {
    const types = new Set<string>();
    for (const json of examples) {
      const result = parseChatActions('```dream-view\n' + json + '\n```');
      expect(result.views.length, `rejected: ${json} ${result.notices.join(' | ')}`).toBe(1);
      types.add(result.views[0].type);
    }
    for (const t of ['secret', 'run', 'mcp', 'pin', 'checkout', 'title', 'insight', 'checklist', 'agent-thread', 'learned']) {
      expect(types.has(t), t).toBe(true);
    }
  });

  it('its buttons example is a real dream-actions row', () => {
    const json = /`(\[\{"label"[^`]+\])`/.exec(LEAN)?.[1];
    expect(json).toBeDefined();
    expect(parseChatActions('```dream-actions\n' + json + '\n```').actions.length).toBe(1);
  });

  it('carries the scripts rule as a bullet, never a stray heading', () => {
    expect(LEAN).not.toContain('## Scripts');
    expect(norm(LEAN)).toContain(norm('A script over a line or two goes into a file (Write tool), then Bash runs it'));
  });

  it('keeps the must-not-miss rule of each card in the prompt itself', () => {
    const lean = norm(LEAN);
    for (const rule of [
      'a credential — never ask for it in prose',
      'you never see the value: use the key by name, never `cat` or echo it',
      'never an interactive command through bash, never "run this in your terminal"',
      'it does not expire, so drop it once it is gone',
      'never a branch, a to-do or a blocker',
      'never its figures retyped into html',
      'replaces your open one: what you need now goes in one message',
      'load the `draw` skill and read its `references/chat-html.md`',
      'a sub-agent\'s report is already on screen',
    ]) expect(lean, rule).toContain(rule);
  });
});

describe('the reference file', () => {
  let home: string;
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'dc-surface-ref-')); });
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  it('IS the full surface text, under one header', () => {
    expect(CHAT_SURFACE_REFERENCE.endsWith(CHAT_SURFACE_BRIEFING)).toBe(true);
  });

  it('is written under ~/.dreamcontext/chat, rewritten when stale, never in the project', () => {
    const path = writeChatSurfaceReference(home);
    expect(path).toBe(join(home, '.dreamcontext', 'chat', CHAT_SURFACE_REFERENCE_FILE));
    expect(readFileSync(path!, 'utf-8')).toBe(CHAT_SURFACE_REFERENCE);
    writeFileSync(path!, 'an older version', 'utf-8');
    expect(writeChatSurfaceReference(home)).toBe(path);
    expect(readFileSync(path!, 'utf-8')).toBe(CHAT_SURFACE_REFERENCE);
  });

  it('returns null when it cannot be written', () => {
    const locked = mkdtempSync(join(tmpdir(), 'dc-surface-ro-'));
    try {
      mkdirSync(join(locked, '.dreamcontext'));
      chmodSync(join(locked, '.dreamcontext'), 0o500);
      expect(writeChatSurfaceReference(locked)).toBeNull();
    } finally {
      chmodSync(join(locked, '.dreamcontext'), 0o700);
      rmSync(locked, { recursive: true, force: true });
    }
  });
});

describe('the spawn: only a Super child gets the lean text', () => {
  const SRC = readFileSync(join(fileURLToPath(new URL('../../', import.meta.url)), 'src/server/routes/agent-chat.ts'), 'utf-8');

  it('a lean child gets the lean text when the reference was written, the full text when not', () => {
    expect(SRC).toMatch(/const childReference = !app && opts\.leanMcp \? writeChatSurfaceReference\(\) : null;/);
    expect(SRC).toMatch(/opts\.leanMcp \? `\$\{childReference \? superChildSurfaceBriefing\(childReference\) : CHAT_SURFACE_BRIEFING\}\\n\$\{SUPER_CHILD_BRIEFING\}`/);
    // An owner's own chat and an app window keep the full text.
    expect(SRC).toMatch(/: CHAT_SURFACE_BRIEFING;/);
  });

  it('every chat but an app\'s may read the reference without a prompt (a lean conversation can resume on a spawn that is not)', () => {
    expect(SRC).toContain('if (!app) spawnSettings.permissions = { allow: [chatSurfaceReferenceReadRule()] };');
  });

  it('the rule is Claude Code\'s absolute form, covering only the reference files', () => {
    expect(chatSurfaceReferenceReadRule('/Users/someone')).toBe('Read(//Users/someone/.dreamcontext/chat/surface-reference-*.md)');
    expect(chatSurfaceReferenceReadRule('C:\\Users\\someone')).toBe('Read(//c/Users/someone/.dreamcontext/chat/surface-reference-*.md)');
    expect(CHAT_SURFACE_REFERENCE_FILE).toMatch(/^surface-reference-[0-9a-f]{12}\.md$/);
  });
});
