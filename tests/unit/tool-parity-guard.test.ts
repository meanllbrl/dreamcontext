/**
 * Every capability Claude has must carry a Codex and an Antigravity row (owner, 2 Nov: "everything
 * Claude has goes to Codex and Antigravity"; pattern every-capability-lands-on-every-tool). The
 * inventory is read from the code, never from a hand list: the hooks we install, our skills and
 * skill packs, our sub-agent roles, the dream-view types the chat draws, the chat modes, the
 * control requests the server sends a session, and the unattended surfaces. A change that adds
 * one of those without its two rows in docs/tool-parity.json (`capabilities`) is red here.
 *
 * Known limit: this proves a row EXISTS and is well formed, not that it is TRUE. `works` needs a
 * real turn and its date, `impossible` the tool's own limit by name, and fake-agent proof is
 * `built`, never `works`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_SPECS } from '../../src/cli/commands/install-skill.js';
import { CHAT_MODES } from '../../src/server/chat-modes.js';
import { HEADLESS_ENVELOPES } from '../../src/lib/t3-bridge/headless-envelope.js';

const ROOT = join(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

interface Cell { state: string; evidence: string; note?: string; when?: string; limit?: string }
interface Row { ids: string[]; kind: string; what: string; codex: Cell; antigravity: Cell }
const caps = (JSON.parse(read('docs/tool-parity.json')) as { capabilities: { states: string[]; evidence: string[]; rows: Row[] } }).capabilities;

/** What Claude has, read from the code. */
export function claudeCapabilities(): string[] {
  const ids = new Set<string>();
  for (const h of HOOK_SPECS) {
    const name = h.name.replace(/ \d+$/, '');
    ids.add(`hook:${name}${h.matcher && /ToolUse$/.test(h.event) ? `:${h.matcher}` : ''}`);
  }
  for (const d of readdirSync(ROOT)) if (/^skill(?:-|$)/.test(d) && d !== 'skill-packs' && existsSync(join(ROOT, d, 'SKILL.md'))) ids.add(`skill:${d}`);
  const catalog = JSON.parse(read('skill-packs/catalog.json')) as { packs: { name: string }[]; standalone: { name: string }[] };
  for (const p of [...catalog.packs, ...catalog.standalone]) ids.add(`skill-pack:${p.name}`);
  for (const dir of ['agents', 'skill-packs/agents']) for (const f of readdirSync(join(ROOT, dir))) if (f.endsWith('.md')) ids.add(`agent:${f.slice(0, -3)}`);
  const views = read('dashboard/src/lib/chatViewSpec.ts').match(/export const VIEW_TYPES = \[([^\]]+)\]/);
  for (const t of views![1].matchAll(/'([a-z-]+)'/g)) ids.add(`dream-view:${t[1]}`);
  for (const m of CHAT_MODES) ids.add(`mode:${m}`);
  // Control requests the server writes to a session's stdin, and the MCP channel's own.
  const chat = read('src/server/routes/agent-chat.ts');
  for (const m of chat.matchAll(/type: 'control_request',[\s\S]{0,160}?request: \{ subtype: '([a-z_]+)'/g)) ids.add(`control:${m[1]}`);
  for (const m of chat.matchAll(/mcpControl\.request\('([a-z_]+)'/g)) ids.add(`control:${m[1]}`);
  for (const m of read('src/lib/mcp-live.ts').matchAll(/this\.request\('([a-z_]+)'/g)) ids.add(`control:${m[1]}`);
  for (const s of Object.keys(HEADLESS_ENVELOPES)) ids.add(`headless:${s}`);
  return [...ids].sort();
}

describe('every Claude capability has a Codex and an Antigravity row', () => {
  const have = claudeCapabilities();
  const rowOf = new Map<string, Row>();
  const twice: string[] = [];
  for (const r of caps.rows) for (const id of r.ids) { if (rowOf.has(id)) twice.push(id); rowOf.set(id, r); }

  it('reads a real inventory from the code', () => {
    // Floors, so a broken reader cannot pass by finding nothing.
    for (const kind of ['hook', 'skill', 'skill-pack', 'agent', 'dream-view', 'mode', 'control', 'headless']) {
      expect([kind, have.filter((id) => id.startsWith(`${kind}:`)).length > 0]).toEqual([kind, true]);
    }
    expect(have).toContain('control:interrupt');
    expect(have).toContain('control:mcp_status');
    expect(have).toContain('hook:pre-tool-use:Bash');
  });

  it('has a row for each, in one row only', () => {
    expect(have.filter((id) => !rowOf.has(id))).toEqual([]);
    expect(twice).toEqual([]);
  });

  it('keeps no row for a capability the code no longer has', () => {
    expect([...rowOf.keys()].filter((id) => !have.includes(id))).toEqual([]);
  });

  it('fills both tools\' cells by the rules', () => {
    const bad: string[] = [];
    for (const r of caps.rows) {
      for (const tool of ['codex', 'antigravity'] as const) {
        const c = r[tool];
        const at = `${r.ids[0]} ${tool}`;
        if (!c || !caps.states.includes(c.state)) { bad.push(`${at}: state`); continue; }
        if (!caps.evidence.includes(c.evidence)) bad.push(`${at}: evidence`);
        // "Ready" means a real turn showed it (the pattern): never a fake agent or a code read.
        if (c.state === 'works' && (c.evidence !== 'real' || !/^\d{4}-\d{2}-\d{2}$/.test(c.when ?? ''))) bad.push(`${at}: works needs a real turn and its date`);
        if (c.state === 'built' && c.evidence === 'real') bad.push(`${at}: a real turn is works or partly`);
        if (c.state === 'impossible' && !c.limit?.trim()) bad.push(`${at}: impossible needs the tool's own limit`);
        if (['partly', 'missing', 'claude-only'].includes(c.state) && !c.note?.trim()) bad.push(`${at}: ${c.state} needs a note`);
      }
    }
    expect(bad).toEqual([]);
  });
});
