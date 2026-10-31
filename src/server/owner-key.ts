import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { createHash, timingSafeEqual } from 'node:crypto';
import { url as openInspectorUrl } from 'node:inspector';

/**
 * The secret that proves a request came from the owner's own window, for the one door where a
 * decision is made in his name (`POST /api/assistant/answer`).
 *
 * Every header is a claim: a process on this machine (an agent's `curl`, the Super Agent's too)
 * can write any Origin, Host or Sec-Fetch-Site it likes. So the shell mints a key per launch and
 * hands it down the server's stdin, a pipe nothing else holds: never the environment (every agent
 * inherits that, and `ps -E` shows it), never a file, never an HTTP answer. The page gets it from
 * the shell over IPC, whose invoke key a loopback client never sees (desktop/src-tauri/src/owner_key.rs).
 *
 * No key (a server the shell did not start, or a shell too old to send one) means no owner
 * answer at all: the route refuses and the chat's own card still answers.
 *
 * A key is only as good as this process's memory, so a server taking one shuts the door a signal
 * opens: `kill -USR1` would start an unauthenticated inspector here, and any same-user process
 * could then read the key or run code past the check. The shell passes `--disable-sigusr1` where
 * Node has it; on an older Node the CLI's first module takes the signal, and an inspector that
 * still got in first costs this server its key.
 */

export const OWNER_KEY_HEADER = 'x-dreamcontext-owner-key';
/** Set by the shell: a key is on its way down stdin. */
export const OWNER_KEY_STDIN_ENV = 'DREAMCONTEXT_OWNER_KEY_STDIN';

const OWNER_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_LINE = 256;

const digest = (key: string): Buffer => createHash('sha256').update(key).digest();

let ownerKeyDigest: Buffer | null = null;

/** Node starts its inspector on SIGUSR1 unless a listener takes the signal. Windows has none. */
export function refuseInspectorSignal(proc: Pick<NodeJS.Process, 'on' | 'platform'> = process): void {
  if (proc.platform !== 'win32') proc.on('SIGUSR1', () => { /* taking it is the point */ });
}

/** Keep the key for this process; null forgets it. Anything but a well-formed key is no key. */
export function setOwnerKey(key: string | null): void {
  ownerKeyDigest = key !== null && OWNER_KEY_RE.test(key) ? digest(key) : null;
}

/** Does this request carry the key the shell gave this process? */
export function hasOwnerKey(req: Pick<IncomingMessage, 'headers'>): boolean {
  const sent = req.headers[OWNER_KEY_HEADER];
  if (!ownerKeyDigest || typeof sent !== 'string') return false;
  return timingSafeEqual(digest(sent), ownerKeyDigest);
}

/**
 * Read the shell's one line off stdin, then let go of the pipe. Only when the shell said it is
 * coming: a terminal's stdin is the owner's, and a CLI server has no shell to answer to.
 */
export function receiveOwnerKey(input: Readable = process.stdin, env: NodeJS.ProcessEnv = process.env, inspectorUrl: () => string | undefined = openInspectorUrl): void {
  if (env[OWNER_KEY_STDIN_ENV] !== '1') return;
  delete env[OWNER_KEY_STDIN_ENV];
  let line = '';
  const done = (): void => {
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    input.removeListener('error', onEnd);
    input.destroy();
  };
  const onData = (chunk: Buffer | string): void => {
    line += String(chunk);
    const end = line.indexOf('\n');
    if (end < 0 && line.length <= MAX_LINE) return;
    if (end >= 0) setOwnerKey(inspectorUrl() ? null : line.slice(0, end).trim());
    done();
  };
  const onEnd = (): void => done();
  input.on('data', onData);
  input.once('end', onEnd);
  input.once('error', onEnd);
}
