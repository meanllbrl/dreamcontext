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

/** At most this much briefing goes to Codex; a longer file is cut, never refused. */
export const MAX_DEVELOPER_INSTRUCTIONS = 60_000;

export function codexLaunchArgs(o: { briefingFile?: string }): string {
  const args: string[] = [];
  if (o.briefingFile) {
    let text = '';
    try { text = readFileSync(o.briefingFile, 'utf-8'); } catch { /* an unreadable briefing degrades to none */ }
    if (text.trim()) args.push(codexConfigArg('developer_instructions', tomlString(text.slice(0, MAX_DEVELOPER_INSTRUCTIONS))));
  }
  return args.join(' ');
}

/**
 * The brain MCP server for this session (`dreamcontext mcp serve`, brain-mcp/server.ts), as Codex
 * `mcp_servers.dreamcontext` overrides on the same `-c` route. Its env carries only the pane's tab
 * id (Codex starts MCP servers with a filtered environment), so `tasks handoff` keys the Eco record
 * by this pane. Nothing when the project has no brain or a path cannot be told.
 */
export function codexBrainMcpArgs(o: { node: string; cli: string; root: string; tabSession?: string }): string {
  if (!o.node || !o.cli || !o.root || !existsSync(join(o.root, '_dream_context'))) return '';
  const arr = (xs: string[]): string => `[${xs.map(tomlString).join(', ')}]`;
  const args = [
    codexConfigArg('mcp_servers.dreamcontext.command', tomlString(o.node)),
    codexConfigArg('mcp_servers.dreamcontext.args', arr([o.cli, 'mcp', 'serve', '--root', o.root])),
  ];
  if (o.tabSession && /^[A-Za-z0-9._:-]{1,128}$/.test(o.tabSession)) {
    args.push(codexConfigArg('mcp_servers.dreamcontext.env', `{ DREAMCONTEXT_TAB_SESSION = ${tomlString(o.tabSession)} }`));
  }
  return args.join(' ');
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
