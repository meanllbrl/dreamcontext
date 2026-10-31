/**
 * The chat server's side of a bridge pane: the login-shell line that starts the bridge child, and
 * which thread a reopened pane resumes. No Effect here (the server imports it on every spawn).
 */
import { homedir } from 'node:os';
import { codexCachedModels, codexDefaultModel } from './registry.js';
import { CODEX_THREAD_RE, codexThreadOwnership } from './codex-threads.js';
import { isCodexAccountId } from './accounts.js';

/** A path that may sit inside double quotes in a login-shell script: no quote, `$`, backtick or backslash. */
export function isScriptSafePath(p: string): boolean {
  return p.length > 0 && p.length < 1024 && /^\/[A-Za-z0-9._\/ +@,=-]*$/.test(p);
}

const TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PANE_RE = /^[0-9a-f-]{36}$/i;

export interface BridgeScriptInput {
  /** `claude` = T3's Claude driver, behind the Claude engine setting. */
  readonly tool: 'codex' | 'claude';
  readonly model: string;
  readonly effort: string;
  readonly mode: string;
  readonly pane: string;
  readonly resume: string;
  /** The Claude briefing argv pair (`--append-system-prompt-file <path>`), reused as the briefing. */
  readonly briefingArg: readonly string[];
  /** Folders a sandboxed turn may also write (linked code repos). */
  readonly extraRoots?: readonly string[];
  /** A non-#0 Codex account (plan r5 §4b). */
  readonly account?: string;
  readonly node?: string;
  readonly cli?: string;
  readonly home?: string;
}

/** `exec "<node>" "<cli>" t3-chat …` for `chatSpawnCommand`, or null when a path is not safe. */
export function bridgeChatScript(i: BridgeScriptInput): string | null {
  const node = i.node ?? process.execPath;
  const cli = i.cli ?? (process.env.DREAMCONTEXT_CLI || process.argv[1] || '');
  if (!isScriptSafePath(node) || !isScriptSafePath(cli)) return null;
  // No model asked for: the account's own default (config.toml), else the first model Codex
  // cached for this login. Never a guessed id (a ChatGPT login refuses unknown models).
  const model = TOKEN_RE.test(i.model) ? i.model : i.tool === 'claude' ? null : codexDefaultModel(i.home ?? homedir()) ?? codexCachedModels(i.home ?? homedir())[0]?.id ?? null;
  const briefIdx = i.briefingArg.indexOf('--append-system-prompt-file');
  const briefing = briefIdx >= 0 ? i.briefingArg[briefIdx + 1] ?? '' : '';
  const args = ['t3-chat', '--tool', i.tool, '--mode', TOKEN_RE.test(i.mode) ? i.mode : 'default'];
  if (model) args.push('--model', model);
  if (TOKEN_RE.test(i.effort)) args.push('--effort', i.effort);
  if (PANE_RE.test(i.pane)) args.push('--pane', i.pane);
  if (CODEX_THREAD_RE.test(i.resume)) args.push('--resume', i.resume);
  if (briefing && isScriptSafePath(briefing)) args.push('--briefing-file', briefing);
  // A root that is not shell-safe is left out, never quoted around: the sandbox only gets narrower.
  const roots = (i.extraRoots ?? []).filter(isScriptSafePath);
  if (i.tool === 'codex' && i.account && isCodexAccountId(i.account)) args.push('--account', i.account);
  // Last: `--extra-root` takes every value after it.
  if (roots.length) args.push('--extra-root', ...roots);
  return `exec "${node}" "${cli}" ${args.map((a) => `"${a}"`).join(' ')}`;
}

/**
 * The thread a reopened bridge pane resumes: the one the tab map recorded for it, only when it
 * is this project's (a foreign or unresolvable thread is never resumed) and no live pane holds it.
 * '' = start a fresh thread.
 */
export function bridgeResumeTarget(o: {
  tool: 'codex';
  mapped: string;
  resumeId: string;
  projectRoot: string;
  held: ReadonlySet<string>;
  codexHome?: string;
}): string {
  for (const c of [o.mapped, o.resumeId]) {
    if (!c || !CODEX_THREAD_RE.test(c) || o.held.has(c)) continue;
    if (codexThreadOwnership(c, o.projectRoot, o.codexHome) === 'owned') return c;
  }
  return '';
}
