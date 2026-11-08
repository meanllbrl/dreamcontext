/**
 * Sleep sees a Codex chat (Track T W3). A synthetic rollout (fictional project, every record
 * shape a real one carries) is read in the Claude transcript shape: the owner's words, Codex's
 * answers and decisions, a patch as Write/Edit, a command as Bash, novel tokens only — and none of
 * the injected context (developer instructions, environment, our brain app context, the hidden
 * tab-naming turn). The Stop hook records it into `.sleep.json` with a score, and
 * `transcript distill` prints its decision exactly as it would a Claude session's.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { codexRolloutToClaudeJsonl, isCodexRollout, readTranscriptText } from '../../src/lib/codex-rollout.js';
import { analyzeTranscript } from '../../src/cli/commands/hook.js';
import { distillTranscript } from '../../src/cli/commands/transcript.js';

const THREAD = '01a192a3-a693-78f1-b679-ba3eab789b33';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-codex-transcripts-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const HOME = join(base, 'home');
const PROJ = join(base, 'acme-shop');
const rolloutDir = join(HOME, '.codex', 'sessions', '2026', '10', '31');
mkdirSync(rolloutDir, { recursive: true });
const ROLLOUT = join(rolloutDir, `rollout-2026-10-31T18-46-02-${THREAD}.jsonl`);

const t = (s: number) => `2026-10-31T18:46:${String(s).padStart(2, '0')}.000Z`;
const msg = (s: number, role: string, kinds: string[], text: string) => ({ timestamp: t(s), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: 'turn-1', content_item_kinds: kinds } } });
const records = [
  { timestamp: t(0), type: 'session_meta', payload: { id: THREAD, cwd: PROJ, cli_version: '0.164.0', base_instructions: { text: 'You are Codex.' } } },
  msg(1, 'developer', ['generic.developer_instructions'], '# Surface: dreamcontext Chat'),
  msg(2, 'user', ['environments.environment_context'], '<environment_context><cwd>/x</cwd></environment_context>'),
  msg(3, 'user', ['additional_content.dreamcontext-brain'], '<external_dreamcontext-brain># Agent Context — snapshot</external_dreamcontext-brain>'),
  msg(4, 'user', ['user.text'], 'Make the checkout three steps and log it to the task.'),
  msg(5, 'assistant', ['unknown'], 'Decided: the checkout keeps three steps (cart, address, payment) because the payment form needs the address first.'),
  { timestamp: t(6), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const patch = "*** Begin Patch\\n*** Add File: src/checkout.ts\\n+export const STEPS = 3;\\n*** Update File: src/cart.ts\\n@@\\n-a\\n+b\\n*** End Patch"; await tools.apply_patch(patch);' } },
  { timestamp: t(7), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.exec_command({"cmd":"npm test"});' } },
  { timestamp: t(8), type: 'token_usage_record', payload: { thread_id: THREAD, response_id: 'resp_1', usage: { input_tokens: 9000, cached_input_tokens: 6000, output_tokens: 400, reasoning_output_tokens: 100, total_tokens: 9400 } } },
  msg(9, 'user', ['user.text'], '<dreamcontext_tab_title> Before you finish, name this tab.'),
  msg(10, 'assistant', ['unknown'], '```dream-view {"type":"title","text":"Checkout steps"}```'),
];
writeFileSync(ROLLOUT, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

describe('a Codex rollout in the Claude transcript shape', () => {
  it('is recognised by its file name only', () => {
    expect(isCodexRollout(ROLLOUT)).toBe(true);
    expect(isCodexRollout('/home/.claude/projects/x/8a7b6c5d-4e3f-4210-9a8b-7c6d5e4f3a2b.jsonl')).toBe(false);
  });

  it('keeps the owner, the answers, the tools and novel tokens; drops every injected record', () => {
    const lines = codexRolloutToClaudeJsonl(readFileSync(ROLLOUT, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    const users = lines.filter((l) => l.type === 'user').map((l) => l.message.content);
    expect(users).toEqual(['Make the checkout three steps and log it to the task.']);
    const tools = lines.flatMap((l) => (Array.isArray(l.message.content) ? l.message.content : [])).filter((b: { type: string }) => b.type === 'tool_use').map((b: { name: string }) => b.name);
    expect(tools).toEqual(['Write', 'Edit', 'Bash']);
    const usage = lines.find((l) => l.message.usage)!.message.usage;
    expect(usage).toEqual({ input_tokens: 3000, output_tokens: 400 });
    const all = JSON.stringify(lines);
    expect(all).not.toContain('Agent Context');
    expect(all).not.toContain('environment_context');
    expect(all).not.toContain('Surface: dreamcontext');
    expect(all).not.toContain('Before you finish, name this tab');
  });

  it('a Claude transcript is read byte for byte', () => {
    const claude = join(base, '8a7b6c5d-4e3f-4210-9a8b-7c6d5e4f3a2b.jsonl');
    writeFileSync(claude, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    expect(readTranscriptText(claude)).toBe(readFileSync(claude, 'utf-8'));
  });

  it('scores (changes, tools, tokens) and distills with the Claude shape', () => {
    const a = analyzeTranscript(ROLLOUT, null, { subtractStartup: false });
    expect(a.changeCount).toBe(2);
    expect(a.toolCount).toBe(3);
    expect(a.novelTokens).toBeGreaterThan(0);
    const d = distillTranscript(ROLLOUT);
    expect(d.userMessages).toEqual(['Make the checkout three steps and log it to the task.']);
    expect(d.agentDecisions.join('\n')).toContain('Decided: the checkout keeps three steps');
    expect(d.codeChanges.join('\n')).toMatch(/src\/checkout\.ts/);
  });
});

const CLI = join(__dirname, '../..', 'dist', 'index.js');
describe.skipIf(!existsSync(CLI))('the Stop hook records a Codex session for sleep (built CLI, scratch vault)', () => {
  it('the session lands in .sleep.json with its rollout and a score, and distill prints its decision', () => {
    const ctx = join(PROJ, '_dream_context');
    for (const d of [join(ctx, 'core'), join(ctx, 'state'), join(HOME, '.dreamcontext')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: "acme-shop"\ntype: soul\nupdated: "2026-01-02"\n---\n\nA fictional storefront.\n');
    writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1' }));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME, DREAMCONTEXT_BRAIN_SYNC: '0', DREAMCONTEXT_RECALL_CLOUD: '0', DREAMCONTEXT_VERSION_CHECK: '0', DREAMCONTEXT_AUTO_SLEEP: '0' };
    delete env.DREAMCONTEXT_CHAT_TAB;
    delete env.DREAMCONTEXT_CONTEXT_BY;
    const stop = spawnSync(process.execPath, [CLI, 'hook', 'stop', '--format', 'codex'], { cwd: PROJ, env, input: JSON.stringify({ session_id: THREAD, transcript_path: ROLLOUT, last_assistant_message: 'Decided: three steps.' }), encoding: 'utf-8', timeout: 60_000 });
    expect(stop.status, stop.stderr).toBe(0);
    const state = JSON.parse(readFileSync(join(ctx, 'state', '.sleep.json'), 'utf-8')) as { sessions: Array<{ session_id: string; transcript_path: string; score: number | null; change_count: number | null }> };
    const s = state.sessions.find((x) => x.session_id === THREAD)!;
    expect(s.transcript_path).toBe(ROLLOUT);
    expect(s.change_count).toBe(2);
    expect(s.score).toBeGreaterThan(0);
    const distill = spawnSync(process.execPath, [CLI, 'transcript', 'distill', THREAD, '--full'], { cwd: PROJ, env, encoding: 'utf-8', timeout: 60_000 });
    expect(distill.status, distill.stderr).toBe(0);
    expect(distill.stdout).toContain('Decided: the checkout keeps three steps');
    expect(distill.stdout).not.toContain('Agent Context');
  }, 120_000);
});
