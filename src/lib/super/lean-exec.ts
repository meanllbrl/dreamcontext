import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';

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

/** Runs the server with this process's stdio and answers with its exit code. */
export function startLeanServer(file: string, name: string): Promise<number> {
  const c = leanServerCommand(file, name);
  if (!c) { process.stderr.write(`mcp lean-exec: no server ${name} in that file\n`); return Promise.resolve(2); }
  return new Promise((resolve) => {
    const child = spawn(c.command, c.args, { stdio: 'inherit', env: { ...process.env, ...c.env } });
    const stop = (): void => { child.kill('SIGTERM'); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
