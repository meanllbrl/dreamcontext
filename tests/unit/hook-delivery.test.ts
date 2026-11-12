/**
 * The numbers measured on the real harness, and the guarantees built on them. If a new Claude Code
 * moves the limit, `scripts/verify/hook-limit.mjs` says so and these constants change together.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HARNESS_PERSIST_CHAR_LIMIT, HOOK_OUTPUT_MAX_CHARS, SESSION_START_PARTS, SNAPSHOT_DELIVERY_CHAR_LIMIT,
  CODEX_SUBAGENT_BRIEFING_MAX_CHARS, resolveSubagentBriefingBudget,
  SINGLE_HOOK_BUDGET_TOKENS, SUBAGENT_BRIEFING_BUDGET_TOKENS, SUBAGENT_BRIEFING_MAX_CHARS, DEFAULT_SNAPSHOT_BUDGET_TOKENS,
} from '../../src/lib/snapshot-budget.js';
import {
  fitPromptContext, hookSettingsRoot, promptOverflowNote, sessionStartPartsInstalled, splitHookOutput, takeSessionStartPart,
  writePromptOverflow, writeSessionStartParts, type PromptBlock,
} from '../../src/lib/hook-delivery.js';
import { HOOK_SPECS, hookCommand } from '../../src/cli/commands/install-skill.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-hook-delivery-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const SID = '8a7b6c5d-4e3f-4210-9a8b-7c6d5e4f3a2b';
const lines = (n: number, width = 90): string => Array.from({ length: n }, (_, i) => `- line ${i} ${'x'.repeat(width)}`).join('\n');

describe('the measured limit (Claude Code 2.1.316, 2026-11-01)', () => {
  it('is locked: 10,000 chars per hook', () => {
    expect(HARNESS_PERSIST_CHAR_LIMIT).toBe(10_000);
  });

  it('every hook stays under it, and every budget fits what carries it', () => {
    expect(HOOK_OUTPUT_MAX_CHARS).toBeLessThan(HARNESS_PERSIST_CHAR_LIMIT);
    expect(SUBAGENT_BRIEFING_MAX_CHARS).toBeLessThan(HOOK_OUTPUT_MAX_CHARS);
    expect(SUBAGENT_BRIEFING_BUDGET_TOKENS * 4).toBeLessThan(SUBAGENT_BRIEFING_MAX_CHARS);
    expect(SINGLE_HOOK_BUDGET_TOKENS * 4).toBeLessThan(HOOK_OUTPUT_MAX_CHARS);
    expect(DEFAULT_SNAPSHOT_BUDGET_TOKENS * 4).toBeLessThan(SNAPSHOT_DELIVERY_CHAR_LIMIT);
  });

  it('one part hook is installed per later piece, under the same matcher as session-start', () => {
    const start = HOOK_SPECS.find((s) => s.name === 'session-start')!;
    const parts = HOOK_SPECS.filter((s) => s.name.startsWith('session-start-part'));
    expect(parts.map((s) => s.name)).toEqual(['session-start-part 2', 'session-start-part 3']);
    expect(parts.length).toBe(SESSION_START_PARTS - 1);
    for (const p of parts) expect(p.matcher).toBe(start.matcher);
  });
});

describe('Codex keeps its own numbers', () => {
  it('its briefing budget and hard cap do not follow the Claude hook limit', () => {
    expect(resolveSubagentBriefingBudget(undefined, 'codex')).toBe(2_900);
    expect(resolveSubagentBriefingBudget(undefined)).toBe(SUBAGENT_BRIEFING_BUDGET_TOKENS);
    expect(CODEX_SUBAGENT_BRIEFING_MAX_CHARS).toBe(12_000);
  });
});

describe('splitHookOutput', () => {
  it('leaves output that fits one hook byte for byte alone', () => {
    const text = lines(50);
    expect(splitHookOutput(text)).toEqual([text]);
  });

  it('never prints a piece over the ceiling, up to the limit of what parts can carry', () => {
    for (const size of [HOOK_OUTPUT_MAX_CHARS + 1, 19_400, 28_000, 90_000]) {
      for (const piece of splitHookOutput(`# H\n\n${lines(Math.ceil(size / 100))}`)) {
        expect(piece.length).toBeLessThanOrEqual(HOOK_OUTPUT_MAX_CHARS);
      }
    }
  });

  it('loses nothing while the text fits, and keeps reading order', () => {
    const source = lines(180);
    const pieces = splitHookOutput(source);
    expect(pieces.length).toBeGreaterThan(1);
    for (const line of source.split('\n')) expect(pieces.join('\n')).toContain(line);
    expect(pieces[0]).toContain('- line 0 ');
    expect(pieces[pieces.length - 1]).toContain('- line 179 ');
  });

  it('the first piece promises the next, and later pieces say which they are', () => {
    const pieces = splitHookOutput(lines(180));
    expect(pieces[0]).toContain(`continues in part 2 of ${pieces.length}`);
    expect(pieces[1]).toContain(`part 2 of ${pieces.length}, continued`);
    expect(pieces[pieces.length - 1]).not.toContain('continues in part');
  });

  it('prefers a section start late in the window, and ignores one that would waste the part', () => {
    const late = `${'a\n'.repeat(4_000)}\n## Late\n${'b\n'.repeat(4_000)}`;
    expect(splitHookOutput(late)[1]).toContain('## Late');
    const early = `## Early\n${'c\n'.repeat(1_000)}\n## Next\n${'d\n'.repeat(9_000)}`;
    expect(splitHookOutput(early)[0].length).toBeGreaterThan(HOOK_OUTPUT_MAX_CHARS * 0.7);
  });

  it('past three pieces it says what was dropped, and names the way to get it', () => {
    const pieces = splitHookOutput(lines(900));
    expect(pieces.length).toBe(SESSION_START_PARTS);
    expect(pieces[2]).toMatch(/more chars did not fit\. `dreamcontext snapshot` prints all of it/);
  });

  it('one hook only: still under the ceiling, top kept, the cut named', () => {
    const pieces = splitHookOutput(`⛔ rule\n${lines(400)}`, 1);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].length).toBeLessThanOrEqual(HOOK_OUTPUT_MAX_CHARS);
    expect(pieces[0].startsWith('⛔ rule')).toBe(true);
    expect(pieces[0]).toContain('did not fit');
    expect(pieces[0]).not.toContain('continues in part');
  });

  it('a Turkish or emoji text with no line ends is never cut inside a character', () => {
    const pieces = splitHookOutput('ğüş😀'.repeat(6_000));
    for (const p of pieces) expect(p).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('the part hooks', () => {
  it('hands each piece over once, and every slot gets a file', async () => {
    writeSessionStartParts(SID, ['second'], home);
    expect(await takeSessionStartPart(SID, 2, { home, waitMs: 0 })).toBe('second');
    expect(await takeSessionStartPart(SID, 2, { home, waitMs: 0 })).toBe('');
    // No third piece: its hook still finds a file at once, so the session never waits on it.
    const start = Date.now();
    expect(await takeSessionStartPart(SID, 3, { home, waitMs: 2_000 })).toBe('');
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('waits for a main hook that finishes after it', async () => {
    const waiting = takeSessionStartPart(SID, 2, { home, waitMs: 3_000, pollMs: 5 });
    setTimeout(() => writeSessionStartParts(SID, ['late'], home), 50);
    expect(await waiting).toBe('late');
  });

  it('gives up when the main hook never came', async () => {
    expect(await takeSessionStartPart(SID, 2, { home, waitMs: 30, pollMs: 5 })).toBe('');
  });

  it('never delivers a file left by an earlier start of the same session', async () => {
    writeSessionStartParts(SID, ['old'], home);
    const file = join(home, '.dreamcontext', 'hook-parts', `${SID}.2.txt`);
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);
    expect(await takeSessionStartPart(SID, 2, { home, waitMs: 20, pollMs: 5 })).toBe('');
  });

  it('a hostile session id cannot leave the parts folder', () => {
    writeSessionStartParts('../../evil', ['x'], home);
    expect(existsSync(join(home, 'evil.2.txt'))).toBe(false);
    expect(readdirSync(join(home, '.dreamcontext', 'hook-parts')).every((f) => f.startsWith('evil.'))).toBe(true);
  });

  it('drops part files nobody collected', () => {
    const dir = join(home, '.dreamcontext', 'hook-parts');
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'gone.2.txt');
    writeFileSync(stale, 'x');
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, past, past);
    writeSessionStartParts(SID, [], home);
    expect(existsSync(stale)).toBe(false);
  });
});

describe('sessionStartPartsInstalled', () => {
  const settings = (hooks: unknown): void => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks }));
  };
  const group = (...names: string[]) => ({ hooks: names.map((n) => ({ type: 'command', command: hookCommand(n) })) });

  it('true only with every part hook', () => {
    settings({ SessionStart: [group('session-start'), group('session-start-part 2'), group('session-start-part 3')] });
    expect(sessionStartPartsInstalled(home)).toBe(true);
    settings({ SessionStart: [group('session-start'), group('session-start-part 2')] });
    expect(sessionStartPartsInstalled(home)).toBe(false);
  });

  it('reads settings.local.json too', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.local.json'), JSON.stringify({
      hooks: { SessionStart: [group('session-start-part 2'), group('session-start-part 3')] },
    }));
    expect(sessionStartPartsInstalled(home)).toBe(true);
  });

  it('in a hook, asks the project that started it, not the brain it stands in', () => {
    expect(hookSettingsRoot('/brain', { CLAUDE_PROJECT_DIR: '/started-here' })).toBe('/started-here');
    expect(hookSettingsRoot('/brain', {})).toBe('/brain');
  });

  it('false on no file or a broken one', () => {
    expect(sessionStartPartsInstalled(home)).toBe(false);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{ nope');
    expect(sessionStartPartsInstalled(home)).toBe(false);
  });
});

describe('fitPromptContext', () => {
  const must = (text: string): PromptBlock => ({ kind: 'must', text });
  const gate: PromptBlock = { kind: 'gate', text: '⛔ Before you act' };
  const recall = (n = 6): PromptBlock => ({
    kind: 'recall',
    text: Array.from({ length: n }, (_, i) => `  [task] state/t${i}.md\n    Why: ${'ş'.repeat(4_000)}`).join('\n'),
  });

  it('leaves a turn that fits byte for byte alone, in order', () => {
    const blocks: PromptBlock[] = [must('rule'), { kind: 'recall', text: 'hit' }, gate];
    expect(fitPromptContext(blocks)).toEqual({ text: 'rule\nhit\n⛔ Before you act', overflow: null });
  });

  it('a recall past the limit keeps every path, the rule on top and the gate', () => {
    const { text, overflow } = fitPromptContext([must('⛔ rule'), recall(), gate]);
    expect(text.length).toBeLessThanOrEqual(HOOK_OUTPUT_MAX_CHARS);
    expect(overflow).toBeNull();
    expect(text.startsWith('⛔ rule')).toBe(true);
    expect(text.endsWith('⛔ Before you act')).toBe(true);
    for (let i = 0; i < 6; i++) expect(text).toContain(`state/t${i}.md`);
    expect(text).toContain('open the files named above');
  });

  it('a pattern becomes its pointer before recall is clipped, and before it goes (MM-4)', () => {
    const patterns: PromptBlock = { kind: 'patterns', text: `body\n${'p\n'.repeat(4_400)}`, compact: 'READ knowledge/patterns/a.md' };
    const first = fitPromptContext([must('rule'), recall(1), patterns, gate]);
    expect(first.text).not.toContain('body');
    expect(first.text).toContain('READ knowledge/patterns/a.md');
    expect(first.text).toContain('ş'.repeat(4_000));
    expect(first.text).not.toContain('open the files named above');
    const second = fitPromptContext([must('rule'), recall(), { ...patterns, text: `body\n${'p\n'.repeat(4_900)}` }, gate]);
    expect(second.text).not.toContain('body');
    expect(second.text).toContain('READ knowledge/patterns/a.md');
    expect(second.text.length).toBeLessThanOrEqual(HOOK_OUTPUT_MAX_CHARS);
  });

  it('never clips a hit path line, however long (MM-4)', () => {
    const path = `  [task] state/${'a-very-long-task-slug-'.repeat(9)}.md  (24k chars)`;
    const block: PromptBlock = { kind: 'recall', text: Array.from({ length: 6 }, () => `${path}\n    Why: ${'ş'.repeat(4_000)}`).join('\n') };
    const { text } = fitPromptContext([must('rule'), block, gate]);
    expect(path.length).toBeGreaterThan(180);
    expect(text.length).toBeLessThanOrEqual(HOOK_OUTPUT_MAX_CHARS);
    expect(text.split('\n').filter((l) => l === path)).toHaveLength(6);
  });

  it('gives up peers before recall', () => {
    const peers: PromptBlock = { kind: 'peers', text: Array.from({ length: 80 }, (_, i) => `peer ${i}`).join('\n') };
    const big: PromptBlock = { kind: 'patterns', text: 'p\n'.repeat(4_700) };
    const { text } = fitPromptContext([must('rule'), { kind: 'recall', text: 'kept recall' }, peers, big, gate]);
    expect(text).not.toContain('peer 70');
    expect(text).toContain('kept recall');
  });

  it('a block that goes entirely never goes silently: the full text stays, by path', () => {
    const blocks: PromptBlock[] = [
      must(`parked\n${lines(89)}`),
      { kind: 'patterns', text: 'body '.repeat(2_000), compact: `READ knowledge/patterns/a.md\n${'x'.repeat(500)}` },
      { ...gate, text: `⛔ gate ${'y'.repeat(400)}` },
    ];
    const { text, overflow } = fitPromptContext(blocks);
    expect(text).not.toContain('READ knowledge/patterns/a.md');
    expect(overflow).toContain('body body');
    expect(text.length + promptOverflowNote('/a/path/of/some/length.txt').length).toBeLessThanOrEqual(HOOK_OUTPUT_MAX_CHARS);
    expect(text).toContain('⛔ gate');
  });

  it('even a must block past the limit is cut under it, full text kept by path', () => {
    const huge = must(`parked message\n${lines(300)}`);
    const { text, overflow } = fitPromptContext([huge, gate]);
    const path = writePromptOverflow(SID, overflow!, home);
    const out = text + promptOverflowNote(path);
    expect(out.length).toBeLessThanOrEqual(HOOK_OUTPUT_MAX_CHARS);
    expect(out.startsWith('parked message')).toBe(true);
    expect(out).toContain(path);
    expect(readFileSync(path, 'utf-8')).toContain('- line 299 ');
  });
});
