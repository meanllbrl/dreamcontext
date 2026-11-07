/**
 * How the bridge launches `codex app-server`: its `-c` overrides and its environment.
 *
 * Our chat-surface briefing (the same file Claude gets through `--append-system-prompt-file`)
 * reaches Codex as `developer_instructions`, through T3's own `launchArgs` route (`-c`, parsed by
 * T3's `tokenizeCliArgs`), so no vendored file changes. Brain content and per-turn recall never go
 * here: they ride as untrusted `appContext` (plan §4a, W3).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolText } from '../tool-text.js';
import type { StoreRoute } from '../codex-mcp.js';
import { claimEnv } from '../apps/call-claim.js';

/** Quote one argument for T3's `tokenizeCliArgs` (POSIX single quotes; `'` as `'\''`). */
export function quoteLaunchToken(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** A TOML basic string (JSON string escapes are a subset TOML accepts). */
export function tomlString(text: string): string {
  return JSON.stringify(text);
}

/** The `-c key=value` pair for one Codex config override, quoted for T3's launch-args string. */
export function codexConfigArg(key: string, tomlValue: string): string {
  return `-c ${quoteLaunchToken(`${key}=${tomlValue}`)}`;
}

/**
 * What a chat's agent says about itself. T3 is credited in NOTICE and the docs; it is not what runs
 * this chat as far as the agent or the owner are concerned. "Claude" is the lead agent's name on
 * Claude only, so a Codex or Gemini chat must never take it.
 */
export const toolIdentity = (label: string): string =>
  `You are ${label}, running inside dreamcontext, the app the user is working in. Asked who or what you are, say so in plain words, with your own model name. You are not Claude.`;

/** ACP has no system field: the identity and the mode ride the prompt, as T3's own text did. */
export function acpPromptWithInstructions(label: string, input: {
  readonly prompt: string;
  readonly state: { readonly interactionMode: string };
  readonly previousState?: { readonly interactionMode: string };
}): string {
  // A native slash command must stay at the start of the prompt.
  if (input.prompt.trimStart().startsWith('/')) return input.prompt;
  if (input.previousState?.interactionMode === input.state.interactionMode) return input.prompt;
  const mode = input.state.interactionMode === 'plan'
    ? 'Mode: Plan. Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it.'
    : "Mode: Default. Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result.";
  return `<dreamcontext-instructions>\n${mode} This mode holds until dreamcontext gives a different one.\n</dreamcontext-instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/** Rides every ACP prompt, in place of T3's `<runtime_info>`, so a compaction cannot lose it. */
export function acpRuntimeInstructions(label: string, runtime: { readonly model?: string | undefined }): string {
  const model = (runtime.model ?? '').replace(/\s+/g, ' ').trim();
  const asModel = model && model !== 'auto' && model !== 'default' ? ` Your model is ${model}.` : '';
  return `<dreamcontext-runtime>\n${toolIdentity(label)}${asModel} No need to mention this otherwise. You can embed images, video and audio in your reply with Markdown image syntax and absolute file paths. Link any other file you produce by its absolute path.\n</dreamcontext-runtime>`;
}

/** At most this much briefing goes to Codex; a longer file is cut, never refused. */
export const MAX_DEVELOPER_INSTRUCTIONS = 60_000;

/**
 * The briefing as Codex's developer instructions, in Codex's words ({@link toolText}), after the
 * identity and `note` (how dreamcontext's skills and roles work there, tool-text.ts `toolNote`).
 * The note goes even without a briefing: it is the only trusted place Codex reads it from.
 */
export function codexLaunchArgs(o: { briefingFile?: string; note?: string }): string {
  let text = '';
  if (o.briefingFile) {
    try { text = readFileSync(o.briefingFile, 'utf-8'); } catch { /* an unreadable briefing degrades to none */ }
  }
  const parts = [o.note?.trim() ?? '', text.trim() ? toolText(text.slice(0, MAX_DEVELOPER_INSTRUCTIONS), 'codex') : ''].filter(Boolean);
  if (!parts.length) return '';
  return codexConfigArg('developer_instructions', tomlString(`${toolIdentity('Codex')}\n\n${parts.join('\n\n')}`));
}

/**
 * The brain MCP server's env: the pane's tab id, so `tasks handoff` keys the Eco record by this
 * pane, and the caller marks `callClaim` reads (`marks`, the bridge's own env), so an `app` tool
 * call is classed like a shell call from the same session (app-araclari plan r3 §4.2).
 */
function brainMcpEnv(o: { tabSession?: string; marks?: NodeJS.ProcessEnv }): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (o.tabSession && /^[A-Za-z0-9._:-]{1,128}$/.test(o.tabSession)) out.push(['DREAMCONTEXT_TAB_SESSION', o.tabSession]);
  for (const [k, v] of Object.entries(claimEnv(o.marks ?? {}))) out.push([k, v]);
  return out;
}

/**
 * The brain MCP server for this session (`dreamcontext mcp serve`, brain-mcp/server.ts), as Codex
 * `mcp_servers.dreamcontext` overrides on the same `-c` route. Codex starts MCP servers with a
 * filtered environment, so the env goes explicitly ({@link brainMcpEnv}). Nothing when the
 * project has no brain or a path cannot be told.
 */
export function codexBrainMcpArgs(o: { node: string; cli: string; root: string; tabSession?: string; marks?: NodeJS.ProcessEnv }): string {
  if (!o.node || !o.cli || !o.root || !existsSync(join(o.root, '_dream_context'))) return '';
  const arr = (xs: string[]): string => `[${xs.map(tomlString).join(', ')}]`;
  const args = [
    codexConfigArg('mcp_servers.dreamcontext.command', tomlString(o.node)),
    codexConfigArg('mcp_servers.dreamcontext.args', arr([o.cli, 'mcp', 'serve', '--root', o.root])),
  ];
  const env = brainMcpEnv(o);
  if (env.length) {
    args.push(codexConfigArg('mcp_servers.dreamcontext.env', `{ ${env.map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`));
  }
  return args.join(' ');
}

/** One server for ACP's `session/new`: the brain, or the owner's, by the same absolute paths. */
export type AcpMcpServer =
  | { readonly name: string; readonly command: string; readonly args: string[]; readonly env: Array<{ name: string; value: string }> }
  | { readonly type: 'http'; readonly name: string; readonly url: string; readonly headers: Array<{ name: string; value: string }> };

/**
 * The app's stores as ACP servers (`codexStorePlan`'s routes). They ride `session/new`, never the
 * profile's `mcp_config.json`: a profile serves every project, and a store can be one project's.
 * No secret rides: a server starts through our own child, which reads its 0600 store file, and
 * only an address with nothing secret in it goes as a URL.
 */
export function acpStoreServers(routes: readonly StoreRoute[], o: { node: string; cli: string }): AcpMcpServer[] {
  return routes.map((r) => (r.via === 'url'
    ? { type: 'http' as const, name: r.name, url: r.url, headers: [] }
    : { name: r.name, command: o.node, args: [o.cli, 'mcp', r.via, r.file, r.name], env: [] }));
}

/** A Super child's lean subset, the same way: read from its 0600 file by our own child. */
export function acpLeanMcpServers(path: string, o: { node: string; cli: string }): AcpMcpServer[] {
  let servers: Record<string, { command?: unknown }>;
  try {
    servers = (JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers?: typeof servers }).mcpServers ?? {};
  } catch {
    return [];
  }
  return Object.entries(servers)
    .filter(([name, c]) => /^[A-Za-z0-9_-]{1,64}$/.test(name) && typeof c?.command === 'string' && name !== 'dreamcontext')
    .map(([name]) => ({ name, command: o.node, args: [o.cli, 'mcp', 'lean-exec', path, name], env: [] }));
}

/**
 * The brain MCP server for an ACP session (Antigravity). It rides `session/new`, not a file: a
 * profile is one account across every project, and the server is bound to this chat's project and
 * tab. Static text in the agent: client servers merge over its global `mcp_config.json`.
 */
export function acpBrainMcpServer(o: { node: string; cli: string; root: string; tabSession?: string; marks?: NodeJS.ProcessEnv }): AcpMcpServer | null {
  if (!o.node || !o.cli || !o.root || !existsSync(join(o.root, '_dream_context'))) return null;
  const env = brainMcpEnv(o).map(([name, value]) => ({ name, value }));
  return { name: 'dreamcontext', command: o.node, args: [o.cli, 'mcp', 'serve', '--root', o.root], env };
}

/**
 * A Super child's lean MCP subset as Codex config (Track T W4). Every server starts through
 * `dreamcontext mcp lean-exec <file> <name>`, which reads the real command, arguments and env from
 * the 0600 file: `-c` values are process arguments, and a token must never show in `ps`. Only
 * stdio servers with a plain name; a server left out is the narrow side.
 */
export function codexLeanMcpArgs(path: string, o: { node: string; cli: string }): string {
  let servers: Record<string, { command?: unknown }>;
  try {
    servers = (JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers?: typeof servers }).mcpServers ?? {};
  } catch {
    return '';
  }
  const arr = (xs: string[]): string => `[${xs.map(tomlString).join(', ')}]`;
  const out: string[] = [];
  for (const [name, c] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || typeof c?.command !== 'string' || name === 'dreamcontext') continue;
    out.push(codexConfigArg(`mcp_servers.${name}.command`, tomlString(o.node)));
    out.push(codexConfigArg(`mcp_servers.${name}.args`, arr([o.cli, 'mcp', 'lean-exec', path, name])));
  }
  return out.join(' ');
}

/** The server names in `codex mcp list --json`: every config and form Codex itself merged. Null = unreadable. */
export function parseCodexMcpList(stdout: string): string[] | null {
  try {
    const rows = JSON.parse(stdout) as unknown;
    if (!Array.isArray(rows)) return null;
    const names = rows.map((r) => (r as { name?: unknown })?.name);
    return names.every((n): n is string => typeof n === 'string') ? names : null;
  } catch {
    return null;
  }
}

/** The servers a lean subset file keeps. */
export function leanMcpNames(path: string | undefined): string[] {
  if (!path) return [];
  try {
    return Object.keys((JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers?: object }).mcpServers ?? {});
  } catch {
    return [];
  }
}

/**
 * What a narrow surface (a lean child, a light job, a sleep) must not inherit from the owner's
 * Codex config (Track T W4): Claude runs those with `--strict-mcp-config` or no MCP at all. Codex
 * has no such flag, and `-c mcp_servers={}` MERGES rather than resets (checked on codex-cli
 * 0.164), so each server Codex lists is switched off by name. `keep` is what this surface was
 * given. Web search runs at OpenAI, outside the sandbox's network rule, so it goes too.
 *
 * Null when a server cannot be switched off (`codex` could not list them, or a name `-c` cannot
 * address, like one with a dot): the caller refuses the run, since a server left on is wider.
 */
export function codexStrictArgs(listed: readonly string[] | null, keep: readonly string[]): string | null {
  if (!listed) return null;
  const off = listed.filter((n) => !keep.includes(n));
  if (off.some((n) => !/^[A-Za-z0-9_-]{1,64}$/.test(n))) return null;
  return [...off.map((n) => codexConfigArg(`mcp_servers.${n}.enabled`, 'false')), codexConfigArg('web_search', '"disabled"')].join(' ');
}

/** T3's Claude driver: its `--append-system-prompt-file` launch argument carries our briefing. */
export function claudeLaunchArgs(o: { briefingFile?: string }): string {
  return o.briefingFile ? `--append-system-prompt-file ${quoteLaunchToken(o.briefingFile)}` : '';
}

/**
 * The environment `codex app-server` inherits. `T3CODE_CODEX_LAUNCH_ARGS` is removed: T3 lets it
 * REPLACE the launch args (`codexLaunchArgs.ts`), so an inherited value would drop our overrides.
 */
export function scrubbedCodexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.T3CODE_CODEX_LAUNCH_ARGS;
  return out;
}
