/**
 * The project's agents as sub-agents of a Chat (lib/automations/chat-subagents.ts): every
 * APPROVED agent becomes an `--agents` definition and a roster line; an unapproved one, and the
 * agent a tab itself speaks as, never do.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { automationPath, createAutomation } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { chatSubagents, subagentPrompt, MAX_CHAT_SUBAGENTS } from '../../src/lib/automations/chat-subagents.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = new Date('2026-10-07T09:00:00.000Z');

function agent(slug: string, title: string, prompt: string, opts: { approve?: boolean; learning?: boolean } = {}) {
  const m = createAutomation(contextRoot, { slug, title, mode: 'call', prompt, review: 'agent', learning: opts.learning ?? false });
  if (opts.approve !== false) approveAutomation(projectRoot, m, NOW, home);
  return m;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-chat-subagents-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-chat-subagents-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('chatSubagents', () => {
  it('is null when the project has no approved agent', () => {
    expect(chatSubagents(contextRoot, { home })).toBeNull();
    agent('draft-agent', 'Draft agent', 'Do drafts.', { approve: false });
    expect(chatSubagents(contextRoot, { home })).toBeNull();
  });

  it('defines every approved agent, keyed by slug, and names each in the roster', () => {
    const m = agent('funnel-watch', 'Funnel watch', 'Watch the signup funnel and flag any step that drops.', { learning: true });
    agent('weekly-brief', 'Weekly brief', 'Write the weekly brief.');
    const out = chatSubagents(contextRoot, { home })!;
    expect(Object.keys(out.agents)).toEqual(['funnel-watch', 'weekly-brief']);
    expect(out.agents['funnel-watch'].description).toContain('Funnel watch, a dreamcontext agent of this project: Watch the signup funnel');
    expect(out.agents['funnel-watch'].prompt).toBe(subagentPrompt(m));
    expect(out.agents['funnel-watch'].prompt).toContain('dreamcontext automations learn funnel-watch --lesson');
    expect(out.roster).toContain('`subagent_type`');
    expect(out.roster).toContain('- `funnel-watch` Funnel watch: Watch the signup funnel');
    expect(out.roster).toContain('- `weekly-brief` Weekly brief: Write the weekly brief.');
  });

  it('leaves out an unapproved agent, and one whose manifest changed after approval', () => {
    agent('funnel-watch', 'Funnel watch', 'Watch the funnel.');
    agent('draft-agent', 'Draft agent', 'Do drafts.', { approve: false });
    agent('edited-agent', 'Edited agent', 'Original job.');
    const path = automationPath(contextRoot, 'edited-agent');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('Original job.', 'A job nobody approved.'));
    expect(Object.keys(chatSubagents(contextRoot, { home })!.agents)).toEqual(['funnel-watch']);
  });

  it('leaves out the agent the tab itself speaks as', () => {
    agent('funnel-watch', 'Funnel watch', 'Watch the funnel.');
    agent('weekly-brief', 'Weekly brief', 'Write the weekly brief.');
    const out = chatSubagents(contextRoot, { home, exclude: 'funnel-watch' })!;
    expect(Object.keys(out.agents)).toEqual(['weekly-brief']);
    expect(out.roster).not.toContain('funnel-watch');
  });

  it('caps the roster, and shortens a long prompt to one line', () => {
    for (let i = 0; i < MAX_CHAT_SUBAGENTS + 3; i++) agent(`agent-${String(i).padStart(2, '0')}`, `Agent ${i}`, `Line one.\n\nLine two ${'x'.repeat(300)}`);
    const out = chatSubagents(contextRoot, { home })!;
    expect(Object.keys(out.agents)).toHaveLength(MAX_CHAT_SUBAGENTS);
    const line = out.roster.split('\n').find((l) => l.startsWith('- `agent-00`'))!;
    expect(line).not.toContain('\n');
    expect(line.endsWith('…')).toBe(true);
    expect(line).toContain('Line one. Line two');
  });
});
