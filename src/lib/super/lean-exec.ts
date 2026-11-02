import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { escapeCmdShimArg, resolvedSpawnSpec } from '../win-cmd.js';

interface LeanServer { command?: unknown; args?: unknown; env?: unknown }

/** One server's command from a lean subset file. Null: not a regular file, or no such stdio server. */
export function leanServerCommand(file: string, name: string): { command: string; args: string[]; env: Record<string, string> } | null {
  try {
    if (!lstatSync(file).isFile()) return null;
    const servers = (JSON.parse(readFileSync(file, 'utf-8')) as { mcpServers?: Record<string, LeanServer> }).mcpServers ?? {};
    if (!Object.prototype.hasOwnProperty.call(servers, name)) return null;
    const c = servers[name]!;
    if (typeof c.command !== 'string') return null;
    return {
      command: c.command,
      args: Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : [],
      env: Object.fromEntries(Object.entries((c.env ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')),
    };
  } catch {
    return null;
  }
}

/** One argument for a `.cmd`/`.bat` line: {@link escapeCmdShimArg} (kept under this name for its callers). */
export const cmdArg = escapeCmdShimArg;

/**
 * How to start a server's command here. Off Windows it is spawned as written. On Windows Node
 * cannot start a `.cmd`/`.bat` (what `npx`, `npm` and every npm-installed server are) without a
 * shell: the command is looked up and launched through the one helper in `win-cmd.ts`.
 */
export function leanSpawnPlan(
  c: { command: string; args: string[] },
  o: { platform?: NodeJS.Platform; path?: string; comspec?: string; isFile?: (p: string) => boolean } = {},
): { command: string; args: string[]; verbatim: boolean } {
  const env = o.comspec ? { ...process.env, ComSpec: o.comspec } : process.env;
  const spec = resolvedSpawnSpec(c.command, c.args, { platform: o.platform, path: o.path, env, isFile: o.isFile });
  return { command: spec.file, args: spec.args, verbatim: spec.windowsVerbatimArguments === true };
}

/** Runs the server with this process's stdio and answers with its exit code. */
export function startLeanServer(file: string, name: string): Promise<number> {
  const c = leanServerCommand(file, name);
  if (!c) { process.stderr.write(`mcp lean-exec: no server ${name} in that file\n`); return Promise.resolve(2); }
  return new Promise((resolve) => {
    const env = { ...process.env, ...c.env };
    const plan = leanSpawnPlan(c, { path: env.PATH ?? env.Path });
    const child = spawn(plan.command, plan.args, { stdio: 'inherit', env, windowsVerbatimArguments: plan.verbatim });
    const stop = (): void => { child.kill('SIGTERM'); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
