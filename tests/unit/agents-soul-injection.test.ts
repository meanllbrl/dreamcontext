/**
 * The soul reaches every fresh run and conversation through one builder at four
 * sites (plan D4): A composePrompt (scheduled, called and task runs), B the card
 * chat, C an agent in a Chat tab, D a chat sub-agent. Without a soul, every
 * prompt is byte-identical to what it was before the soul existed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSoulBlock, composePrompt } from '../../src/lib/automations/runner.js';
import { agentChatBriefing, cardChatBriefing } from '../../src/lib/whiteboards/card-chat.js';
import { chatSubagents, subagentPrompt } from '../../src/lib/automations/chat-subagents.js';
import { identityOnly } from '../../src/lib/agents/compose.js';
import { createAgent } from '../../src/lib/agents/store.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

const SOUL = 'Lead with the worst problem.\n- No praise.';
const NOW = new Date('2026-10-12T09:00:00.000Z');

function manifest(overrides: Partial<AutomationManifest> = {}): AutomationManifest {
  return {
    slug: 'scout',
    id: 'agt_s1',
    title: 'Scout',
    mode: 'call',
    enabled: true,
    schedule: null,
    scheduleError: null,
    model: null,
    effort: null,
    timeoutMinutes: 15,
    catchupHours: 6,
    outputDir: null,
    shared: false,
    notify: true,
    learning: true,
    review: 'off',
    flow: null,
    whiteboard: null,
    pattern: '### Lessons\n- 2026-10-01: Check the date.',
    prompt: 'Scout the market.',
    outputInstructions: '',
    job: 'Write the morning digest.',
    soul: SOUL,
    runKind: 'agent',
    agent: 'scout',
    agentTitle: 'Scout',
    bindings: [],
    legacyKey: false,
    path: '/tmp/x/_dream_context/agents/scout.md',
    body: '',
    ...overrides,
  } as AutomationManifest;
}

function without(m: AutomationManifest): AutomationManifest {
  const copy = { ...m } as Partial<AutomationManifest>;
  delete copy.soul;
  return copy as AutomationManifest;
}

const START = '--- HOW YOU WORK (your approved soul, from the AI Team) ---';
const END = '--- END HOW YOU WORK ---';

function assertBetween(text: string, before: string, after: string): void {
  const at = text.indexOf(START);
  expect(at).toBeGreaterThan(-1);
  expect(text.indexOf(END)).toBeGreaterThan(at);
  expect(text.indexOf(SOUL)).toBeGreaterThan(at);
  expect(text.indexOf(before)).toBeGreaterThan(-1);
  expect(text.indexOf(before)).toBeLessThan(at);
  expect(text.indexOf(after)).toBeGreaterThan(text.indexOf(END));
}

describe('buildSoulBlock', () => {
  it("is '' for no soul, an empty soul and a whitespace-only one", () => {
    expect(buildSoulBlock({})).toBe('');
    expect(buildSoulBlock({ soul: '' })).toBe('');
    expect(buildSoulBlock({ soul: '  \r\n ' })).toBe('');
  });

  it('frames the soul as HOW, never widening the work', () => {
    const block = buildSoulBlock({ soul: SOUL });
    expect(block.startsWith(START)).toBe(true);
    expect(block.endsWith(END)).toBe(true);
    expect(block).toContain('never widens what you may read, write or run');
    expect(block).toContain(SOUL);
  });
});

describe('site A: composePrompt', () => {
  const run = (m: AutomationManifest, ask?: string | null, task?: { slug: string; name: string } | null) =>
    composePrompt(m, '/p', NOW, '/o.md', undefined, null, ask ?? null, null, task ?? null);

  it('puts the soul after the prompt and before THIS JOB and the pattern', () => {
    const text = run(manifest());
    assertBetween(text, 'Scout the market.', '--- THIS JOB ---');
    expect(text.indexOf('--- YOUR PATTERN')).toBeGreaterThan(text.indexOf(END));
  });

  it('a task-assignment run and an ask run both carry it', () => {
    expect(run(manifest(), null, { slug: 'fix-login', name: 'Fix the login' })).toContain(START);
    expect(run(manifest(), 'What changed today?')).toContain(START);
  });

  it("without a soul ('' or absent) the prompt is byte-identical to one with no soul property", () => {
    const base = run(without(manifest()));
    expect(base).not.toContain(START);
    expect(run(manifest({ soul: '' }))).toBe(base);
    expect(run(manifest({ soul: '  \n' }))).toBe(base);
  });
});

describe('sites B, C, D: conversations', () => {
  const sites: Array<[string, (m: AutomationManifest) => string]> = [
    ['B cardChatBriefing', (m) => cardChatBriefing(m, 'northwind-ops', null)],
    ['C agentChatBriefing', (m) => agentChatBriefing(m, null)],
    ['D subagentPrompt', (m) => subagentPrompt(m)],
  ];
  for (const [name, brief] of sites) {
    it(`${name}: after END WHO YOU ARE, before YOUR PATTERN; unchanged with no soul`, () => {
      assertBetween(brief(manifest()), '--- END WHO YOU ARE ---', '--- YOUR PATTERN');
      const base = brief(without(manifest()));
      expect(base).not.toContain(START);
      expect(brief(manifest({ soul: '' }))).toBe(base);
    });
  }
});

describe('identityOnly and chatSubagents', () => {
  it('identityOnly keeps the soul', () => {
    expect(identityOnly(manifest()).soul).toBe(SOUL);
  });

  describe('with a project', () => {
    let projectRoot: string;
    let contextRoot: string;
    let home: string;
    beforeEach(() => {
      projectRoot = mkdtempSync(join(tmpdir(), 'dc-soul-inject-'));
      contextRoot = join(projectRoot, '_dream_context');
      mkdirSync(contextRoot, { recursive: true });
      home = mkdtempSync(join(tmpdir(), 'dc-soul-inject-home-'));
    });
    afterEach(() => {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    it("an approved agent's sub-agent prompt carries the soul; its description does not", () => {
      createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout the market.', soul: SOUL }, { approve: { now: NOW, home } });
      const out = chatSubagents(contextRoot, { home })!;
      expect(out.agents.scout.prompt).toContain(START);
      expect(out.agents.scout.prompt).toContain(SOUL);
      expect(out.agents.scout.description).not.toContain('Lead with the worst problem');
    });
  });
});
