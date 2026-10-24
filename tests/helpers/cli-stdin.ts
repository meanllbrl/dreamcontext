import { spawnSync } from 'node:child_process';

/**
 * Run `node <cli> <args…>` with `stdin` piped in, and NO shell. The hook tests used to run
 * `printf '%s' '<json>' | node <cli> …` through /bin/bash, which does not exist on Windows (and
 * cmd has no printf), so every hook there read an empty stdin. `withStderr` appends stderr the
 * way the old `2>&1` folded it into the output.
 */
export function runCliWithStdin(
  cli: string,
  args: string[],
  stdin: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number; withStderr?: boolean },
): string {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: stdin,
    encoding: 'utf-8',
    timeout: opts.timeout ?? 10_000,
  });
  return (r.stdout ?? '') + (opts.withStderr ? (r.stderr ?? '') : '');
}
