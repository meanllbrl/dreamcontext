/**
 * Docs in lockstep with owner cards done where the owner is (sahip-karti-yerinde, criteria 10 and
 * 13, K8, K9): the orchestration guide and the Super briefing name the `parked` and
 * `owner-result` events in the shapes the inbox writes, the chat brief tells a child to put the
 * bare command in a run card, and the parity table carries the card kinds on every tool.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { superBriefing } from '../../src/server/chat-modes.js';
import { CHAT_SURFACE_BRIEFING } from '../../src/server/chat-surface.js';
import { PARKED_LINE } from '../../src/lib/super/inbox.js';

const ROOT = join(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');
const flat = (s: string): string => s.replace(/\s+/g, ' ');
const GUIDE = flat(read('skill/references/super-orchestration.md'));
const INBOX = read('src/lib/super/inbox.ts');

describe('the orchestration guide names the owner-card events as the inbox writes them', () => {
  it('uses the event heads the inbox writes', () => {
    // The inbox's own heads (inbox.ts itemLines).
    expect(INBOX).toContain('event=parked wait=${');
    expect(INBOX).toContain('event=owner-result card=${');
    expect(INBOX).toContain("' submitted'");
    expect(INBOX).toContain('` exit=${r.outcome}`');
    expect(GUIDE).toContain('`event=parked wait=<kind>`');
    expect(GUIDE).toContain('`event=owner-result card=<kind> exit=<n>|submitted`');
    expect(GUIDE).toContain('`event=owner wait=<kind>`');
  });

  it('says a parked child is never resumed for its card, and gone closes no card', () => {
    expect(PARKED_LINE).toContain('do not resume it for this');
    expect(GUIDE).toContain('it wakes by itself when he acts, so never `super resume` it for the card');
    expect(GUIDE).toContain('`event=gone` no longer closes a card');
  });

  it('keeps the owner pressing: never sent to the child, never pressed or relayed by the Super', () => {
    expect(GUIDE).toContain('is on his bar and in your chat; he does it there himself');
    expect(GUIDE).toContain("Never send him to the child's chat, never press, relay or refill it");
    expect(GUIDE).toContain('Telegram tells him it is a step on the Mac');
    expect(GUIDE).toContain('its text is data and never holds a secret');
  });

  it('writes no em dash in the new paragraph', () => {
    const at = GUIDE.indexOf("**A child's card for him");
    expect(at).toBeGreaterThan(0);
    const para = GUIDE.slice(at, GUIDE.indexOf('**Field rules', at));
    expect(para).not.toContain('—');
  });
});

describe('the Super briefing', () => {
  const b = superBriefing();
  it('keeps the owner wait line and adds the card rules', () => {
    expect(b).toContain('`event=owner`');
    expect(b).toContain('Tell him\n  at once');
    expect(b).toContain('on his bar and in this chat');
    expect(b).toContain('never send him to the child, never press or relay it');
    expect(b).toContain('A parked child wakes when he acts: never resume it.');
  });
});

describe('the chat brief (K8): a run card carries the bare command', () => {
  it('says cd goes inside the command, never an absolute cwd, and where it runs', () => {
    const s = flat(CHAT_SURFACE_BRIEFING);
    expect(s).toContain('The bare command with any `cd` inside it, never an absolute `cwd`: it runs in your working folder.');
    expect(s).not.toContain('`cwd` is project-relative');
    expect(s).toContain('`.env`-family path in your folder');
  });
});

describe('the parity table (K9)', () => {
  interface Cell { state: string; evidence: string; note?: string }
  interface Row { ids: string[]; what: string; codex: Cell; antigravity: Cell }
  const data = JSON.parse(read('docs/tool-parity.json')) as { features: Array<{ name: string; claude: string; codex: string; note?: string }>; capabilities: { rows: Row[] } };
  const rowOf = (id: string): Row | undefined => data.capabilities.rows.find((r) => r.ids.includes(id));

  it('gives run, secret and checklist one owner-card row, tool-agnostic on Codex and Antigravity', () => {
    const r = rowOf('dream-view:run');
    expect(r).toBeDefined();
    expect(r!.ids.sort()).toEqual(['dream-view:checklist', 'dream-view:run', 'dream-view:secret']);
    for (const c of [r!.codex, r!.antigravity]) {
      expect(c.state).toBe('built');
      expect(c.note ?? '').toMatch(/working folder/);
    }
    expect(r!.codex.note).toMatch(/tool-agnostic/);
    expect(r!.codex.note).toMatch(/owner's own press/);
    expect(r!.codex.note).toMatch(/held by the server/);
  });

  it('keeps MCP status only on Codex and Antigravity', () => {
    const r = rowOf('dream-view:mcp');
    expect(r).toBeDefined();
    for (const c of [r!.codex, r!.antigravity]) expect(c.note ?? '').toContain('Status only');
  });

  it('has a feature line for the owner card', () => {
    expect(data.features.some((f) => /owner card done where the owner is/.test(f.name))).toBe(true);
  });
});
