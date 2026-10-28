import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { sendJson, sendError } from '../middleware.js';
import { isPhoneSocket } from '../phone-origin.js';
import { requireOwnerWindow } from './agent-spawn-shared.js';

/**
 * POST /api/agent/pick-paths — the composer's "Attach files…" / "Attach folders…" picker, run in
 * a SEPARATE process (`osascript`'s `choose file` / `choose folder`) and answered with real
 * absolute paths. Body `{ directory: boolean, multiple: boolean }` → `{ paths: string[] }`;
 * cancelling is `{ paths: [] }`.
 *
 * Two callers (owner 2026-10-29, "file picking mostly does not work"):
 *  - the browser dashboard, which had only a typed-path `prompt()` — not a picker at all;
 *  - the desktop app when its own `pick_paths` is refused: `+[NSOpenPanel openPanel]` can come
 *    back nil inside a long-lived app (the panel's helper service is lost), and then every
 *    in-process retry fails the same way. A fresh process gets a fresh panel.
 *
 * The owner's own window only (desktop server, this machine, loopback Host, same origin, never
 * the phone): it opens a dialog on the Mac, so nothing else may make it appear. One dialog at a
 * time; a second ask while one is open is 409. The dialog dies with the request.
 */

/** Seam for tests: run osascript with this script and args, resolve its exit code and output. */
export type OsascriptRunner = (script: string, args: string[], onChild?: (c: ChildProcess) => void) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * Prints one POSIX path per line. `activate` brings osascript's dialog in front of every window
 * (it is a background process otherwise, and its panel would open behind the app).
 */
export const PICK_SCRIPT = `on run argv
  set wantFolders to (item 1 of argv) is "folders"
  set wantMany to (item 2 of argv) is "many"
  activate
  if wantFolders then
    set picked to choose folder with prompt "Attach folders" multiple selections allowed wantMany
  else
    set picked to choose file with prompt "Attach files" multiple selections allowed wantMany
  end if
  if class of picked is not list then set picked to {picked}
  set out to ""
  repeat with p in picked
    set out to out & POSIX path of p & linefeed
  end repeat
  return out
end run`;

/** osascript's "User canceled." error (-128) — a cancel, not a failure. */
const CANCELLED = /\(-128\)/;

const runOsascript: OsascriptRunner = (script, args, onChild) => new Promise((resolve) => {
  let child: ChildProcess;
  try {
    child = spawn('/usr/bin/osascript', ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    resolve({ code: null, stdout: '', stderr: String(err) });
    return;
  }
  onChild?.(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
  child.on('error', (err) => resolve({ code: null, stdout, stderr: stderr || String(err) }));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

/** The picked lines as absolute paths: a folder's trailing slash dropped, blanks skipped. */
export function parsePickedPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.startsWith('/'))
    .map((l) => (l.length > 1 ? l.replace(/\/+$/, '') : l));
}

/** Show the picker and resolve the chosen paths; [] on cancel. Throws when it could not open. */
export async function pickPathsInSeparateProcess(
  directory: boolean,
  multiple: boolean,
  run: OsascriptRunner = runOsascript,
  onChild?: (c: ChildProcess) => void,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  if (platform !== 'darwin') throw new Error('The separate-process picker is macOS-only.');
  const r = await run(PICK_SCRIPT, [directory ? 'folders' : 'files', multiple ? 'many' : 'one'], onChild);
  if (r.code === 0) return parsePickedPaths(r.stdout);
  if (CANCELLED.test(r.stderr)) return [];
  throw new Error(r.stderr.trim() || 'The file picker could not be opened.');
}

let open = false;

/** The JSON body, at most 4 KB; null when larger. */
function readSmallBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 4096) { finish(null); return; }
      chunks.push(c);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => finish(''));
  });
}

/** Tests only: forget an open dialog. */
export function resetPickForTests(): void { open = false; }

export async function handleAgentPickPaths(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string,
  run: OsascriptRunner = runOsascript,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (isPhoneSocket(req)) {
    sendError(res, 403, 'forbidden', 'The file picker opens on the Mac, not from the phone.');
    return;
  }
  if (!requireOwnerWindow(req, res, 'Only this app\'s own window can open the file picker.')) return;
  const raw = await readSmallBody(req);
  if (raw === null) {
    sendError(res, 413, 'too_large', 'Request too large.');
    return;
  }
  let body: { directory?: unknown; multiple?: unknown } = {};
  try {
    if (raw.trim()) body = JSON.parse(raw) as typeof body;
  } catch {
    sendError(res, 400, 'invalid_body', 'Expected { directory, multiple }.');
    return;
  }
  if (open) {
    sendError(res, 409, 'picker_open', 'A file picker is already open.');
    return;
  }
  open = true;
  let child: ChildProcess | null = null;
  // The tab closed or the fetch was aborted: the dialog has nobody to answer.
  const onGone = () => { if (!res.writableEnded) child?.kill(); };
  res.on('close', onGone);
  try {
    const paths = await pickPathsInSeparateProcess(body.directory === true, body.multiple !== false, run, (c) => { child = c; }, platform);
    if (!res.writableEnded) sendJson(res, 200, { paths });
  } catch (err) {
    if (!res.writableEnded) sendError(res, 500, 'picker_failed', err instanceof Error ? err.message : String(err));
  } finally {
    open = false;
    res.off('close', onGone);
  }
}
