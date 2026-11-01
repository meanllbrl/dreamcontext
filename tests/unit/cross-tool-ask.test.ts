/**
 * `dreamcontext ask --tool <t>`: the envelope is the `ask` / `ask-write` row and never wider, a
 * sandboxed Codex chat cannot hand a write to a tool with no sandbox, and a role's instructions
 * ride in the tool's own words.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askCommand, askRefusal, composeAskPrompt, findAgentFile, readAskOutput, runAsk } from '../../src/lib/cross-tool-ask.js';
import { CLAUDE_ONLY, toolNote } from '../../src/lib/tool-text.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-ask-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the envelope', () => {
  it('read-only by default on every tool, and --write is the ask-write row', () => {
    const c = askCommand({ tool: 'claude', prompt: 'p', cwd: dir }, 'p');
    expect('args' in c && c.args).toEqual(['-p', 'p', '--output-format', 'json', '--permission-mode', 'default', '--allowedTools', 'Read', 'Grep', 'Glob']);
    const cw = askCommand({ tool: 'claude', prompt: 'p', cwd: dir, write: true, model: 'sonnet' }, 'p');
    expect('args' in cw && cw.args).toEqual(['-p', 'p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--model', 'sonnet']);
    const x = askCommand({ tool: 'codex', prompt: 'p', cwd: dir, model: 'opus' }, 'p', { node: '/n', cli: '/cli.js' });
    expect('args' in x && x.args).toEqual(['/cli.js', 't3-run', '--surface', 'ask', '--prompt=p']);
    const a = askCommand({ tool: 'antigravity', prompt: 'p', cwd: dir, write: true }, 'p', { node: '/n', cli: '/cli.js' });
    expect('args' in a && a.args).toEqual(['/cli.js', 't3-run', '--surface', 'ask-write', '--prompt=p', '--tool', 'antigravity']);
    expect(askCommand({ tool: 'codex', prompt: 'p', cwd: dir }, 'p', { node: null, cli: '/cli.js' })).toEqual({ error: 'Codex needs Node 22.16 or newer on this Mac.' });
  });

  it('never less protected than the caller', () => {
    const sandboxed = { DREAMCONTEXT_AGENT_TOOL: 'codex', CODEX_SANDBOX: 'seatbelt' };
    expect(askRefusal({ tool: 'claude', write: true }, sandboxed)).toMatch(/sandboxed/);
    expect(askRefusal({ tool: 'antigravity', write: true }, sandboxed)).toMatch(/sandboxed/);
    expect(askRefusal({ tool: 'codex', write: true }, sandboxed)).toBeNull();
    expect(askRefusal({ tool: 'claude' }, sandboxed)).toBeNull();
    expect(askRefusal({ tool: 'codex' }, { DREAMCONTEXT_ASK_DEPTH: '2' })).toMatch(/inside an ask/);
    expect(askRefusal({ tool: 'claude', model: 'opus; rm -rf /' }, {})).toMatch(/not a model/);
    expect(askRefusal({ tool: 'opencode' as never }, {})).toMatch(/Unknown tool/);
  });

  it('a refused ask spawns nothing', async () => {
    const r = await runAsk({ tool: 'claude', prompt: 'p', cwd: dir, write: true }, { env: { DREAMCONTEXT_AGENT_TOOL: 'codex', CODEX_SANDBOX: 'seatbelt' } });
    expect(r).toMatchObject({ ok: false, mode: 'write' });
    expect(r.error).toMatch(/sandboxed/);
  });
});

describe('a role', () => {
  it('the project role wins, its body is rewritten for the tool, and an unknown role is said plainly', () => {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'cart-auditor.md'), '---\nname: cart-auditor\ndescription: d\n---\n\nAudit the cart. Use the Agent tool with subagent_type reviewer.\n');
    expect(findAgentFile('cart-auditor', dir, dir)).toBe(join(dir, '.claude', 'agents', 'cart-auditor.md'));
    expect(findAgentFile('../etc', dir, dir)).toBeNull();
    const codex = composeAskPrompt({ tool: 'codex', prompt: 'check it', agent: 'cart-auditor', cwd: dir }, dir);
    expect('prompt' in codex && codex.prompt).toContain('spawn_agent with agent_type reviewer');
    expect('prompt' in codex && CLAUDE_ONLY.test(codex.prompt)).toBe(false);
    const claude = composeAskPrompt({ tool: 'claude', prompt: 'check it', agent: 'cart-auditor', cwd: dir }, dir);
    expect('prompt' in claude && claude.prompt).toContain('the Agent tool');
    expect(composeAskPrompt({ tool: 'codex', prompt: 'x', agent: 'nobody', cwd: dir }, dir)).toEqual({ error: expect.stringContaining('No agent named "nobody"') });
    // Ours are found too: the reviewer ships in the skill packs.
    expect(findAgentFile('reviewer', dir, dir)).toMatch(/skill-packs[/\\]agents[/\\]reviewer\.md$/);
  });
});

describe('the answer', () => {
  it('is read from the last document, past a login shell\'s chatter', () => {
    expect(readAskOutput('rc noise\n{"type":"result","result":" hi ","is_error":false,"session_id":"s1"}\n')).toEqual({ text: 'hi', isError: false, sessionId: 's1' });
    expect(readAskOutput('nothing')).toBeNull();
  });

  it('a bridge chat is told to run claude -p roles as its own sub-agents and to use ask on purpose', () => {
    expect(toolNote('codex')).toContain('spawn_agent with agent_type set to that role');
    expect(toolNote('antigravity')).toContain('invoke_subagent with subagent_name set to that role');
    for (const t of ['codex', 'antigravity'] as const) expect(toolNote(t)).toContain('dreamcontext ask --tool');
  });
});
