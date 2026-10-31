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
