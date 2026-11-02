/**
 * `dreamcontext ask --tool <t>`: one command any tool's shell can call to run a prompt (or one of
 * our agent roles) on another tool and get the answer back (lane 2, night run). It is how a Claude
 * chat or sub-agent reaches Codex or Antigravity, and how they reach Claude.
 *
 * The envelope is the `ask` / `ask-write` row of headless-envelope.ts, never wider:
 *   - read (default): Claude gets Read, Grep and Glob only; Codex runs read-only and may start a
 *     plain read command; Antigravity edits nothing and runs only a plain read command.
 *   - `--write`: Claude `acceptEdits` with only the file tools (edits in the project, no command);
 *     Codex its `auto` sandbox (the project, no network). Not on Antigravity: its only writing
 *     flavour runs any command, wider than Claude's.
 *   Claude's tools are named with `--tools`, so a settings allow rule cannot add Bash back.
 *
 * Never less protected than the caller: a sandboxed Codex chat cannot hand a write to Claude or
 * Antigravity (neither has an OS sandbox), and an ask inside an ask inside an ask is refused (the
 * depth rides in `DREAMCONTEXT_ASK_DEPTH`). An Antigravity chat in read mode cannot start it at
 * all: it is not a plain read command. The answer is printed, so it shows in the calling chat as
 * that command's output.
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { findPackageDir } from './catalog.js';
import { claudeAwarePath, claudeDirectCommand } from './claude-path.js';
import { SPAWNED_ENV } from './session-origin.js';
import { sessionTool } from './session-id.js';
import { codexModelOf, codexRunArgs, envelopeRefusal, type HeadlessTool } from './t3-bridge/headless-envelope.js';
import { bridgeNode } from './t3-bridge/node-floor.js';
import { SAFE_SKILL_NAME } from './tool-skills.js';
import { toolText } from './tool-text.js';

export type AskTool = 'claude' | HeadlessTool;
export const ASK_TOOLS: readonly AskTool[] = ['claude', 'codex', 'antigravity'];
export const MAX_ASK_DEPTH = 2;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;

export interface AskInput {
  readonly tool: AskTool;
  readonly prompt: string;
  readonly cwd: string;
  readonly write?: boolean;
  readonly model?: string | null;
  readonly agent?: string | null;
  readonly timeoutMs?: number;
}

export interface AskResult {
  readonly ok: boolean;
  readonly text: string;
  readonly tool: AskTool;
  readonly mode: 'read' | 'write';
  readonly sessionId: string | null;
  readonly error?: string;
}

const isFile = (p: string): boolean => {
  try { return lstatSync(p).isFile(); } catch { return false; }
};

/** The role's file: the project's, the owner's, then ours. Null when there is none by that name. */
export function findAgentFile(name: string, cwd: string, home: string = homedir()): string | null {
  if (!SAFE_SKILL_NAME.test(name)) return null;
  const dirs = [join(cwd, '.claude', 'agents'), join(home, '.claude', 'agents'), findPackageDir('agents'), findPackageDir('skill-packs/agents')];
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, `${name}.md`);
    if (isFile(p)) return p;
  }
  return null;
}

/** The prompt the other tool reads: the role's instructions first when one is named. */
export function composeAskPrompt(i: Pick<AskInput, 'tool' | 'prompt' | 'agent' | 'cwd'>, home: string = homedir()): { prompt: string } | { error: string } {
  if (!i.agent) return { prompt: i.prompt };
  const file = findAgentFile(i.agent, i.cwd, home);
  if (!file) return { error: `No agent named "${i.agent}" in this project, ~/.claude/agents or dreamcontext's own.` };
  let body = '';
  try { body = matter(readFileSync(file, 'utf-8')).content.trim(); } catch { /* empty below */ }
  if (!body) return { error: `The agent file for "${i.agent}" has no instructions.` };
  const role = i.tool === 'claude' ? body : toolText(body, i.tool);
  return { prompt: `You are acting as the ${i.agent} role. Its instructions:\n\n${role}\n\n---\n\nYour task:\n${i.prompt}` };
}

/** Why this ask may not run from here, or null. */
export function askRefusal(i: Pick<AskInput, 'tool' | 'write' | 'model'>, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ASK_TOOLS.includes(i.tool)) return `Unknown tool "${String(i.tool)}": claude, codex or antigravity.`;
  if (i.model && !SAFE_MODEL.test(i.model)) return `"${i.model}" is not a model name.`;
  const depth = Number(env.DREAMCONTEXT_ASK_DEPTH ?? '0') || 0;
  if (depth >= MAX_ASK_DEPTH) return `An ask inside an ask inside an ask is refused: answer from here.`;
  // Codex's sandbox holds its own children; Claude and Antigravity have none to hold them in.
  if (i.write && sessionTool(env) === 'codex' && env.CODEX_SANDBOX && i.tool !== 'codex') {
    return `This Codex chat runs sandboxed: it cannot hand a write to ${i.tool === 'claude' ? 'Claude' : 'Antigravity'}, which has no sandbox. Ask read-only, or ask Codex.`;
  }
  if (i.tool !== 'claude') {
    const why = envelopeRefusal(i.write ? 'ask-write' : 'ask', i.tool);
    if (why) return why;
  }
  return null;
}

/** The command line the ask runs, and the program. */
export function askCommand(i: AskInput, prompt: string, o: { node?: string | null; cli?: string } = {}): { file: string; args: string[] } | { error: string } {
  if (i.tool === 'claude') {
    // `--tools` is the set of built-in tools that EXIST for this run, so no settings allow rule
    // (`Bash(node:*)`) can add one back; `--strict-mcp-config` with no config = no MCP tools.
    const args = ['-p', prompt, '--output-format', 'json', '--strict-mcp-config',
      ...(i.write ? ['--permission-mode', 'acceptEdits', '--tools', 'Read,Grep,Glob,Edit,MultiEdit,Write'] : ['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob']),
      ...(i.model ? ['--model', i.model] : [])];
    const direct = claudeDirectCommand(args);
    return { file: direct.file, args: direct.args };
  }
  const node = o.node === undefined ? bridgeNode() : o.node;
  const cli = o.cli ?? (process.env.DREAMCONTEXT_CLI || process.argv[1] || '');
  if (!node || !cli) return { error: `${i.tool === 'codex' ? 'Codex' : 'Antigravity'} needs Node 22.16 or newer on this Mac.` };
  return {
    file: node,
    args: [cli, ...codexRunArgs({ surface: i.write ? 'ask-write' : 'ask', prompt, ...(i.tool === 'antigravity' ? { tool: 'antigravity' as const } : {}), model: codexModelOf(i.model) })],
  };
}

/** The answer from the last JSON document a run printed (a login shell can print before it). */
export function readAskOutput(stdout: string): { text: string; isError: boolean; sessionId: string | null } | null {
  const t = stdout.trim();
  for (let i = t.indexOf('{'); i !== -1; i = t.indexOf('{', i + 1)) {
    try {
      const d = JSON.parse(t.slice(i)) as { result?: unknown; is_error?: unknown; session_id?: unknown };
      if (d && typeof d === 'object') return { text: typeof d.result === 'string' ? d.result.trim() : '', isError: d.is_error === true, sessionId: typeof d.session_id === 'string' ? d.session_id : null };
    } catch { /* not the start of the document */ }
  }
  return null;
}

export function runAsk(i: AskInput, o: { env?: NodeJS.ProcessEnv; home?: string } = {}): Promise<AskResult> {
  const env = o.env ?? process.env;
  const mode = i.write ? 'write' : 'read';
  const fail = (error: string): Promise<AskResult> => Promise.resolve({ ok: false, text: '', tool: i.tool, mode, sessionId: null, error });
  const refusal = askRefusal(i, env);
  if (refusal) return fail(refusal);
  if (!existsSync(i.cwd)) return fail(`${i.cwd} does not exist.`);
  const composed = composeAskPrompt(i, o.home);
  if ('error' in composed) return fail(composed.error);
  const cmd = askCommand(i, composed.prompt);
  if ('error' in cmd) return fail(cmd.error);
  const depth = (Number(env.DREAMCONTEXT_ASK_DEPTH ?? '0') || 0) + 1;
  // The other tool is a session of its own: no Claude id and no bridge tool of the caller rides in.
  const childEnv: NodeJS.ProcessEnv = { ...env, PATH: claudeAwarePath(env.PATH ?? ''), DREAMCONTEXT_ASK_DEPTH: String(depth), [SPAWNED_ENV]: 'other' };
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  delete childEnv.DREAMCONTEXT_AGENT_TOOL;
  delete childEnv.DREAMCONTEXT_TAB_SESSION;
  return new Promise((resolve) => {
    const child = spawn(cmd.file, cmd.args, { cwd: i.cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: AskResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      finish({ ok: false, text: '', tool: i.tool, mode, sessionId: null, error: `no answer after ${Math.round((i.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s` });
    }, i.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => finish({ ok: false, text: '', tool: i.tool, mode, sessionId: null, error: String(e) }));
    child.on('close', (code) => {
      const doc = readAskOutput(out);
      if (!doc) return finish({ ok: false, text: '', tool: i.tool, mode, sessionId: null, error: `the ${i.tool} run printed no answer (exit ${code})${err.trim() ? `: ${err.trim().slice(-300)}` : ''}` });
      finish({ ok: !doc.isError && !!doc.text, text: doc.text, tool: i.tool, mode, sessionId: doc.sessionId, ...(doc.isError || !doc.text ? { error: doc.text || 'the run reported an error' } : {}) });
    });
  });
}
