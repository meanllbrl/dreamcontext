import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { LabError, type AdapterContext } from '../types.js';

/**
 * Out-of-process runner for `lab/scripts/*.mjs`.
 *
 * WHY A CHILD PROCESS (GitHub #242): loading a user script with
 * `await import(url + '?t=<bust>')` only ever produces a fresh module for the
 * ENTRY file. That module's own `import './lib-shared.mjs'` resolves to an
 * unqueried URL, so Node's ESM registry keeps serving whatever it loaded the
 * first time, for the life of the process. In the CLI that is invisible (a fresh
 * process per command). In the long-running desktop app it means an edit to a
 * shared helper is silently ignored until the app restarts — and the loud case
 * (a stale `ENOENT`) is the lucky one: a corrected formula or unit conversion in
 * a shared lib would keep publishing wrong numbers under a green "synced"
 * checkmark. A short-lived child process starts with an empty module registry by
 * construction, so the whole import graph is always current. The bug class is
 * gone rather than patched.
 *
 * The child also bounds the blast radius: a script that hangs, leaks a handle,
 * or calls `process.exit` can no longer take the host process with it, and the
 * credentials travel over stdin — not argv (which `ps` shows) and not the
 * environment (which every grandchild inherits).
 *
 * This is NOT a sandbox. The child runs as the same user with the same
 * filesystem and network access; the trust model documented in
 * `custom-script.ts` is unchanged.
 */

/** Wall-clock ceiling for one script run — a hung script fails loudly instead of
 *  wedging the sync forever. Override with DREAMCONTEXT_LAB_SCRIPT_TIMEOUT_MS. */
export const SCRIPT_TIMEOUT_MS = 120_000;

/** How long a child that already returned its result may take to exit on its own
 *  before it is signalled. `fetch` keep-alive sockets routinely hold a process
 *  open for seconds after the work is done. */
const EXIT_GRACE_MS = 250;
const SIGKILL_GRACE_MS = 2_000;

/** Bounded tail of child stderr kept for the "died without a result" message. */
const STDERR_TAIL_MAX = 2_000;

/**
 * The child program, evaluated as an ES module (`node --input-type=module
 * --eval`). Kept as a source string rather than a file so it resolves identically
 * from the tsup bundle and from source under vitest.
 *
 * Protocol: the payload arrives as JSON on stdin, the result leaves as JSON on
 * fd 3. fd 3 keeps the result channel clear of the script's own console output,
 * which is forwarded to the host's stdout/stderr as it arrives.
 */
const RUNNER_SOURCE = `
import { closeSync, writeSync } from 'node:fs';

const emit = (payload) => {
  const buf = Buffer.from(JSON.stringify(payload), 'utf-8');
  let off = 0;
  // writeSync does not loop; a >64KB funnel payload exceeds the pipe buffer.
  while (off < buf.length) off += writeSync(3, buf, off, buf.length - off);
};

let raw = '';
process.stdin.setEncoding('utf-8');
for await (const chunk of process.stdin) raw += chunk;

let payload;
try {
  const input = JSON.parse(raw);
  const mod = await import(input.scriptUrl);
  const fn = mod.default;
  if (typeof fn !== 'function') payload = { ok: false, noDefault: true };
  else {
    const result = await fn(input.ctx);
    payload = { ok: true, result: result === undefined ? null : result };
  }
} catch (err) {
  payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
}

try {
  emit(payload);
} catch (err) {
  const why = err instanceof Error ? err.message : String(err);
  try { emit({ ok: false, error: 'script result is not JSON-serializable: ' + why }); } catch {}
}
// Close the result channel NOW so the host settles immediately, even if the
// script left a keep-alive socket or a timer holding this process open.
try { closeSync(3); } catch {}
`;

/** The configured ceiling, re-read per run so the env override is testable. */
function resolveTimeoutMs(): number {
  const raw = process.env.DREAMCONTEXT_LAB_SCRIPT_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SCRIPT_TIMEOUT_MS;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Let a child that already delivered its result wind down, then insist. */
function reap(child: ChildProcess): void {
  if (hasExited(child)) return;
  setTimeout(() => {
    if (hasExited(child)) return;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!hasExited(child)) child.kill('SIGKILL');
    }, SIGKILL_GRACE_MS).unref();
  }, EXIT_GRACE_MS).unref();
}

/**
 * Run one custom script in a fresh Node process and return whatever it resolved.
 *
 * Throws a `LabError` for runner-level failures (no default export, timeout,
 * child died, unreadable result) and a plain `Error` carrying the script's own
 * message when the script itself threw — the adapter formats the two differently.
 */
export async function runScriptInChild(
  scriptPath: string,
  ctx: AdapterContext,
  label: string,
): Promise<unknown> {
  const timeoutMs = resolveTimeoutMs();
  const payload = JSON.stringify({
    scriptUrl: pathToFileURL(scriptPath).href,
    // `fetchImpl` is a function and cannot cross a process boundary; every other
    // AdapterContext field is plain data. Scripts use the global `fetch`.
    ctx: {
      manifest: ctx.manifest,
      resolvedTweaks: ctx.resolvedTweaks,
      credentials: ctx.credentials,
    },
  });

  return await new Promise<unknown>((resolveResult, rejectResult) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ['--input-type=module', '--eval', RUNNER_SOURCE], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      rejectResult(new LabError(`Script ${label} could not be started: ${(err as Error).message}`));
      return;
    }

    const resultChannel = child.stdio[3] as Readable | null | undefined;
    if (!resultChannel) {
      child.kill('SIGKILL');
      rejectResult(new LabError(`Script ${label} could not be started: no result channel.`));
      return;
    }

    const chunks: Buffer[] = [];
    let stderrTail = '';
    let spawnError: Error | null = null;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reap(child);

      if (timedOut) {
        rejectResult(new LabError(
          `Script ${label} timed out after ${timeoutMs}ms and was killed `
          + `(raise DREAMCONTEXT_LAB_SCRIPT_TIMEOUT_MS if the script is legitimately slow).`,
        ));
        return;
      }

      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        const why = spawnError
          ? `: ${spawnError.message}`
          : stderrTail.trim() ? `: ${stderrTail.trim()}` : '.';
        rejectResult(new LabError(
          `Script ${label} exited (code ${child.exitCode ?? 'null'}, signal ${child.signalCode ?? 'null'}) `
          + `without returning a result${why}`,
        ));
        return;
      }

      let parsed: { ok?: boolean; result?: unknown; error?: string; noDefault?: boolean };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        rejectResult(new LabError(`Script ${label} returned an unreadable result.`));
        return;
      }

      if (parsed.noDefault) {
        rejectResult(new LabError(`Script ${label} must export a default async function.`));
        return;
      }
      if (!parsed.ok) {
        // The script's own throw — a plain Error so the adapter renders it as
        // "Custom script <file> threw: <message>", as it always has.
        rejectResult(new Error(parsed.error ?? 'unknown error'));
        return;
      }
      resolveResult(parsed.result ?? null);
    };

    resultChannel.on('data', (b: Buffer) => { chunks.push(b); });
    // A result closes fd 3 immediately; settle then rather than waiting for the
    // process to exit. With no result, wait for 'close' so the exit code is known.
    resultChannel.on('end', () => { if (chunks.length > 0) settle(); });
    resultChannel.on('error', () => { /* closed under us; 'close' settles */ });

    child.stdout?.on('data', (b: Buffer) => { process.stdout.write(b); });
    child.stderr?.on('data', (b: Buffer) => {
      process.stderr.write(b);
      stderrTail = (stderrTail + b.toString('utf-8')).slice(-STDERR_TAIL_MAX);
    });

    child.on('error', (err) => { spawnError = err; });
    child.on('close', () => { settle(); });

    // EPIPE when the child dies before reading its payload — 'close' reports it.
    child.stdin?.on('error', () => { /* swallowed */ });
    child.stdin?.end(payload);
  });
}
