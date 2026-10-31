/**
 * The light job's envelope (`super team ask --light`): closed by the tools, never by the prompt.
 * The argv is what these pin; `scripts/verify-light-run.ts` proves on a real claude binary (a fake
 * API, no model call) that this argv closes what it says.
 */
import { describe, it, expect } from 'vitest';
import { LIGHT_DISALLOWED_TOOLS, LIGHT_JOB_BLOCK, lightRunArgs, runLeavesNoSession } from '../../src/lib/automations/light-run.js';
import { isReadToolName, readToolsOf } from '../../src/lib/agents/read-tools.js';
import { buildClaudeArgs, buildContinueArgs, composePrompt, QUESTION_DISALLOWED_TOOLS } from '../../src/lib/automations/runner.js';
import { buildResumeArgs } from '../../src/lib/automations/verdict.js';
import { canonicalApprovalPayload } from '../../src/lib/automations/registry.js';
import type { AutomationManifest, SpawnModelOverride } from '../../src/lib/automations/types.js';

const LIGHT: SpawnModelOverride = { model: 'haiku', effort: 'low', light: true };
const manifest = (over: Partial<AutomationManifest> = {}): AutomationManifest => ({
  slug: 'desk', title: 'Desk', id: 'agt_x', mode: 'call', enabled: true, schedule: null, scheduleError: null,
  prompt: 'Read first: the send skill and every knowledge file.', soul: 'Never send without his word.', model: 'opus', effort: 'medium', learning: true, pattern: '',
  timeoutMinutes: 30, catchupHours: 24, outputDir: null, shared: false, notify: { success: false, failure: true, sound: null },
  review: 'off', outputInstructions: '', flow: null, job: '', runKind: 'agent', bindings: [], legacyKey: false, path: '/x', body: '',
  ...over,
} as unknown as AutomationManifest);

const allowedIn = (args: string[]): string[] => args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));

describe('read_tools: only literal, non-mutating MCP tools open', () => {
  it('takes the read tools a member really uses', () => {
    for (const t of ['mcp__whatsapp__list_messages', 'mcp__whatsapp__get_chat', 'mcp__whatsapp__search_contacts', 'mcp__crm__getTeacher']) expect(isReadToolName(t)).toBe(true);
  });
  it('refuses a send, a wildcard, a whole server, a built-in and a Bash rule, whoever wrote it', () => {
    for (const t of [
      'mcp__whatsapp__send_message', 'mcp__whatsapp__edit_message', 'mcp__whatsapp__send_file', 'mcp__whatsapp__download_media',
      'mcp__crm__sendEmail', 'mcp__crm__delete-record', 'mcp__whatsapp__*', 'mcp__whatsapp', 'Bash', 'Bash(sqlite3:*)', 'Write', 'mcp__x__list(*)',
    ]) expect(isReadToolName(t), t).toBe(false);
    expect(readToolsOf(['mcp__a__list_x', 'mcp__a__send_x', 7, 'mcp__a__list_x'])).toEqual(['mcp__a__list_x']);
    expect(readToolsOf('mcp__a__list_x')).toEqual([]);
  });
});

describe('the envelope', () => {
  it('denies by default: dontAsk, no settings, only the file readers and the named read tools', () => {
    const args = lightRunArgs({ readTools: ['mcp__whatsapp__list_messages', 'mcp__whatsapp__send_message'] }, '/home/h');
    expect(args.slice(0, 4)).toEqual(['--permission-mode', 'dontAsk', '--setting-sources', '']);
    expect(allowedIn(args)).toEqual(['Read', 'Grep', 'Glob', 'mcp__whatsapp__list_messages']);
    expect(args).not.toContain('bypassPermissions');
  });
  it('closes everything the approval question closes, and what leaves the machine', () => {
    const denied = new Set<string>(LIGHT_DISALLOWED_TOOLS);
    for (const t of QUESTION_DISALLOWED_TOOLS.split(' ')) expect(denied.has(t), t).toBe(true);
    for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Skill']) expect(denied.has(t), t).toBe(true);
    const args = lightRunArgs({}, '/home/h');
    expect(args).toContain('Read(//home/h/.ssh/**)');
    expect(args).toContain('Read(//**/.env*)');
    expect(denied.has('ReadMcpResourceTool') && denied.has('ListMcpResourcesTool')).toBe(true);
  });
  it('holds on every spawn a job can take: a run, a continue, a resume, and at every level', () => {
    for (const autonomy of ['ask', 'balanced', 'free'] as const) {
      const m = manifest({ autonomy });
      for (const args of [buildClaudeArgs(m, 'p', null, LIGHT), buildContinueArgs(m, 's', null, LIGHT), buildResumeArgs(m, 's', 'p', null, LIGHT)]) {
        expect(args).not.toContain('bypassPermissions');
        expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
        expect(args[args.indexOf('--model') + 1]).toBe('haiku');
      }
    }
  });
  it('narrows a home board too: its scope never survives under a light job', () => {
    const scope = ['--permission-mode', 'dontAsk', '--allowedTools', 'Write(//x/**)', 'Bash(dreamcontext whiteboard:*)'];
    const args = buildClaudeArgs(manifest(), 'p', scope, LIGHT);
    expect(args).not.toContain('Write(//x/**)');
    expect(args).not.toContain('Bash(dreamcontext whiteboard:*)');
  });
  it('only a run that would outlive its job leaves no session', () => {
    const model = { model: 'haiku', effort: null, oneJob: true as const };
    expect(runLeavesNoSession({ model: 'opus' }, LIGHT)).toBe(true);
    expect(runLeavesNoSession({ model: null }, model)).toBe(true);
    expect(runLeavesNoSession({ model: 'opus' }, model)).toBe(false);
    expect(runLeavesNoSession({ model: null }, { model: null, effort: 'low', oneJob: true })).toBe(false);
    expect(runLeavesNoSession({ model: null }, { model: 'haiku', effort: null })).toBe(false);
    expect(runLeavesNoSession({ model: null }, null)).toBe(false);
  });
  it('a resume with no model of its own stays bare: the owner\'s settings decide, as on a fresh run', () => {
    expect(buildResumeArgs(manifest({ model: null }), 's', 'p')).not.toContain('--model');
  });
  it('without light, the argv is byte for byte what it was', () => {
    const m = manifest();
    const plain = buildClaudeArgs(m, 'p');
    expect(plain.slice(0, 4)).toEqual(['-p', 'p', '--permission-mode', 'bypassPermissions']);
    expect(buildClaudeArgs(m, 'p', null, { model: 'sonnet', effort: 'low' })).toContain('bypassPermissions');
  });
});

describe('what the light turn is told', () => {
  it('never opens with a dash: a resume\'s prompt starts with it, and argv would read a flag', () => {
    expect(LIGHT_JOB_BLOCK.startsWith('-')).toBe(false);
  });
  const at = new Date('2026-10-31T10:00:00.000Z');
  it('keeps the approved prompt byte for byte and adds its block, without the learning directive', () => {
    const m = manifest();
    const light = composePrompt(m, '/p', at, '/p/o.md', undefined, null, 'one read', null, null, null, true);
    const full = composePrompt(m, '/p', at, '/p/o.md', undefined, null, 'one read');
    expect(light).toContain(m.prompt);
    expect(light).toContain(m.soul);
    expect(light).toContain(LIGHT_JOB_BLOCK);
    expect(light).not.toContain('automations learn');
    expect(full).not.toContain(LIGHT_JOB_BLOCK);
    expect(light.indexOf(LIGHT_JOB_BLOCK)).toBeLessThan(light.lastIndexOf('one read'));
  });
});

describe('read_tools and consent', () => {
  it('an agent with none hashes as before; naming one is a change to approve', () => {
    const m = manifest();
    expect(canonicalApprovalPayload({ ...m, readTools: [] })).toBe(canonicalApprovalPayload(m));
    expect(canonicalApprovalPayload({ ...m, readTools: ['mcp__a__list_x'] })).not.toBe(canonicalApprovalPayload(m));
  });
});
