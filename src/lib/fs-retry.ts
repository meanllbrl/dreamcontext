import { promises as fsp } from 'node:fs';

/**
 * `rename(from, to)` that survives Windows' sharing rules.
 *
 * On Windows a rename over a file another handle has open (an async read of the same state file,
 * an antivirus scan, the indexer) fails with EPERM/EACCES/EBUSY for a moment; POSIX replaces the
 * file atomically whoever has it open. graceful-fs retries for the same reason. Here a write that
 * lost that race used to throw, and the caller (the Super Agent's inbox pump) ended quietly with
 * the question undelivered. win32 only: those codes are retried with a short backoff (about 1 s
 * in all); elsewhere this is exactly `fsp.rename`.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  opts: {
    platform?: NodeJS.Platform;
    rename?: (a: string, b: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
  } = {},
): Promise<void> {
  const rename = opts.rename ?? ((a: string, b: string) => fsp.rename(a, b));
  if ((opts.platform ?? process.platform) !== 'win32') return rename(from, to);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 12;
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i + 1 >= attempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw err;
      await sleep(Math.min(20 * (i + 1), 150));
    }
  }
}
