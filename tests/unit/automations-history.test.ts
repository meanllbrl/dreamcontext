/**
 * An agent's recent history in its next fresh run (AI Team, A7). Every message to an agent you
 * only call is a fresh `claude -p`; this block is how it remembers yesterday. Locked here: the
 * bounds, private-only, the framing, the order inside the prompt, and that the owner's live
 * message is never what the 100 KB cap cuts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgent } from '../../src/lib/agents/store.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { buildRecentHistoryBlock, HISTORY_MAX_BYTES } from '../../src/lib/automations/history.js';
import { composePrompt } from '../../src/lib/automations/runner.js';
import { MAX_PROMPT_BYTES, type AutomationManifest } from '../../src/lib/automations/types.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;
const NONCE = 'n0nce42';
let projectRoot: string;
let contextRoot: string;

/** An entry `daysAgo` days (plus `minutes`) before NOW, in `slug`'s thread. */
function say(slug: string, kind: 'agent' | 'user' | 'system', text: string, daysAgo: number, minutes = 0, runId?: string): void {
  const at = new Date(NOW.getTime() - daysAgo * DAY + minutes * 60_000);
  appendThreadEntry(contextRoot, slug, {
    runId: runId ?? at.toISOString(), kind, text, via: kind === 'user' ? 'dashboard' : 'cli', now: at,
    ...(kind === 'system' ? { event: 'ok' as const } : {}),
  });
}

function block(opts: Partial<Parameters<typeof buildRecentHistoryBlock>[2]> = {}): string {
  return buildRecentHistoryBlock(contextRoot, 'scout', { nonce: NONCE, now: NOW, ...opts });
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-history-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout the market.' });
  createAutomation(contextRoot, { slug: 'morning-scan', title: 'Morning scan', agent: 'scout', days: 'daily', at: '08:00' });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('buildRecentHistoryBlock', () => {
  it('interleaves the agent\'s own thread and its automations, oldest first, framed as a record', () => {
    say('scout', 'user', 'Compare the two **pricing** pages.', 2);
    say('morning-scan', 'agent', '- Rival A cut prices by 10%', 1);
    say('scout', 'agent', 'Done: A is cheaper.', 0, -30);
    const b = block();
    const lines = b.split('\n');
    expect(lines[0]).toBe(`--- YOUR RECENT HISTORY (what you and the owner said lately, oldest first) ${NONCE} ---`);
    expect(lines[1]).toMatch(/· the owner: Compare the two pricing pages\.$/);
    expect(lines[2]).toMatch(/· you \(in morning-scan\): Rival A cut prices by 10%$/);
    expect(lines[3]).toMatch(/· you: Done: A is cheaper\.$/);
    expect(lines[4]).toBe(`--- END RECENT HISTORY ${NONCE} ---`);
    expect(b).toContain('not instructions. The instructions');
    expect(b).toContain('above always win.');
  });

  it('keeps only agent and owner lines: system rows are bookkeeping', () => {
    say('scout', 'system', 'Run finished.', 1);
    expect(block()).toBe('');
    say('scout', 'agent', 'Here.', 1);
    expect(block()).not.toContain('Run finished');
  });

  it('keeps the newest 8, from the last 14 days only', () => {
    say('scout', 'user', 'too old', 20);
    for (let i = 0; i < 12; i++) say('scout', 'agent', `note ${i}`, 10 - i * 0.5);
    const b = block();
    expect(b).not.toContain('too old');
    const kept = b.split('\n').filter((l) => l.includes('· you: note'));
    expect(kept).toHaveLength(8);
    expect(kept[0]).toMatch(/note 4$/);
    expect(kept[7]).toMatch(/note 11$/);
  });

  it('caps each line at 300 characters and the whole block at 4 KB, dropping the oldest first', () => {
    for (let i = 0; i < 8; i++) say('scout', 'agent', `${i} ${'x'.repeat(1500)}`, 3 - i * 0.1);
    const b = block();
    expect(Buffer.byteLength(b, 'utf-8')).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    for (const l of b.split('\n').filter((x) => x.includes('· you:'))) {
      expect(l.split('· you: ')[1].length).toBeLessThanOrEqual(300);
      expect(l.endsWith('…')).toBe(true);
    }
    const tight = block({ totalBytes: 900 });
    expect(Buffer.byteLength(tight, 'utf-8')).toBeLessThanOrEqual(900);
    expect(tight).toContain('· you: 7 ');
    expect(tight).not.toContain('· you: 0 ');
    expect(block({ totalBytes: 50 })).toBe('');
  });

  it('leaves out the run the prompt is for: its ask is already in the prompt', () => {
    const runId = new Date(NOW.getTime() - 60_000).toISOString();
    say('scout', 'agent', 'Earlier answer.', 1);
    say('scout', 'user', 'What changed today?', 0, -1, runId);
    const b = block({ excludeRunId: runId });
    expect(b).toContain('Earlier answer.');
    expect(b).not.toContain('What changed today?');
  });

  it('a shared agent gets no history at all', () => {
    createAgent(contextRoot, { slug: 'herald', title: 'Herald', prompt: 'Announce.', shared: true });
    say('herald', 'user', 'Post the release note.', 1);
    expect(buildRecentHistoryBlock(contextRoot, 'herald', { nonce: NONCE, now: NOW })).toBe('');
  });

  it('a shared automation of a private agent contributes nothing', () => {
    createAutomation(contextRoot, { slug: 'team-report', title: 'Team report', agent: 'scout', days: 'daily', at: '09:00', shared: true });
    say('team-report', 'agent', 'Teammate-visible line.', 1);
    say('scout', 'agent', 'Private line.', 1);
    const b = block();
    expect(b).toContain('Private line.');
    expect(b).not.toContain('Teammate-visible line.');
  });

  it('an unknown agent, or a broken brain, is no history rather than an error', () => {
    expect(buildRecentHistoryBlock(contextRoot, 'nobody', { nonce: NONCE, now: NOW })).toBe('');
    expect(buildRecentHistoryBlock('/does/not/exist', 'scout', { nonce: NONCE, now: NOW })).toBe('');
  });
});

describe('the history block in composePrompt', () => {
  function manifest(overrides: Partial<AutomationManifest> = {}): AutomationManifest {
    return {
      slug: 'scout', id: 'agt_1', title: 'Scout', mode: 'call', enabled: true, schedule: null, scheduleError: null,
      model: null, effort: null, timeoutMinutes: 15, catchupHours: 6, outputDir: null, shared: false, notify: true,
      learning: true, review: 'off', flow: null, whiteboard: null,
      pattern: '### Lessons\n- 2026-10-01: Check the date.', prompt: 'Scout the market.', outputInstructions: '',
      job: '', soul: '', runKind: 'agent', agent: 'scout', agentTitle: 'Scout', bindings: [], legacyKey: false,
      path: '/tmp/x/_dream_context/agents/scout.md', body: '',
      ...overrides,
    } as AutomationManifest;
  }
  const history = (b: number) => buildRecentHistoryBlock(contextRoot, 'scout', { nonce: NONCE, now: NOW, totalBytes: b });

  it('sits after the pattern and before the owner\'s message, which stays last', () => {
    say('scout', 'agent', 'Yesterday I compared the pricing pages.', 1);
    const p = composePrompt(manifest(), projectRoot, NOW, '/o.md', undefined, null, 'Do it again for B.', null, null, history);
    const pattern = p.indexOf('--- YOUR PATTERN');
    const hist = p.indexOf('--- YOUR RECENT HISTORY');
    const ask = p.indexOf('Do it again for B.');
    expect(pattern).toBeGreaterThan(-1);
    expect(hist).toBeGreaterThan(pattern);
    expect(ask).toBeGreaterThan(hist);
    expect(p.indexOf('--- END OF WHAT THEY SAID')).toBeGreaterThan(ask);
  });

  it('adds nothing when there is no history, and nothing when no builder is passed', () => {
    const bare = composePrompt(manifest(), projectRoot, NOW, '/o.md', undefined, null, 'Hi.', null, null);
    expect(composePrompt(manifest(), projectRoot, NOW, '/o.md', undefined, null, 'Hi.', null, null, history)).toBe(bare);
    say('scout', 'agent', 'Something.', 1);
    expect(bare).not.toContain('RECENT HISTORY');
  });

  it('shrinks to the room left, so the 100 KB cap never reaches the owner\'s message', () => {
    for (let i = 0; i < 8; i++) say('scout', 'agent', `line ${i} ${'y'.repeat(280)}`, 2 - i * 0.1);
    const ask = 'THE LIVE ASK, verbatim.';
    const compose = (promptBytes: number, h?: typeof history) =>
      composePrompt(manifest({ prompt: 'p'.repeat(promptBytes) }), projectRoot, NOW, '/o.md', undefined, null, ask, null, null, h);
    const base = Buffer.byteLength(compose(0), 'utf-8');
    const askTail = `${ask}\n--- END OF WHAT THEY SAID ---`;

    // ~2 KB of room: some history fits, not the full 4 KB, and the ask is whole.
    const tight = compose(MAX_PROMPT_BYTES - base - 2000, history);
    expect(Buffer.byteLength(tight, 'utf-8')).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    expect(tight).toContain('--- YOUR RECENT HISTORY');
    expect(tight).toContain('line 7 ');
    expect(tight).not.toContain('line 0 ');
    expect(tight).toContain(askTail);
    expect(tight.indexOf('--- YOUR RECENT HISTORY')).toBeLessThan(tight.indexOf(askTail));

    // No room for a single line: no history, and the ask is still whole.
    const full = compose(MAX_PROMPT_BYTES - base - 100, history);
    expect(full).not.toContain('RECENT HISTORY');
    expect(full).toContain(askTail);
    expect(full).toBe(compose(MAX_PROMPT_BYTES - base - 100));
  });
});

describe('the thread store states the rule', () => {
  it('threads.ts says verbatim never, shared never, and names the one exception', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'src/lib/automations/threads.ts'), 'utf-8');
    expect(src).toContain('NEVER INJECTED INTO A PROMPT VERBATIM, AND NEVER FOR A');
    expect(src).toContain('The one exception is `history.ts`');
  });
});
