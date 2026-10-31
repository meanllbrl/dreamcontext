/**
 * How the bridge launches `codex app-server`: its `-c` overrides and its environment.
 *
 * Our chat-surface briefing (the same file Claude gets through `--append-system-prompt-file`)
 * reaches Codex as `developer_instructions`, through T3's own `launchArgs` route (`-c`, parsed by
 * T3's `tokenizeCliArgs`), so no vendored file changes. Brain content and per-turn recall never go
 * here: they ride as untrusted `appContext` (plan §4a, W3).
 */
import { readFileSync } from 'node:fs';

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
