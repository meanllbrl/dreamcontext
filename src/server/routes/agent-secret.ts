import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { getApp } from '../../lib/apps/registry.js';
import { APP_SLUG_RE } from '../../lib/apps/bundle.js';
import { existingRuntime } from '../../lib/apps/supervisor.js';
import {
  SecretWriteError, normalizeSecretEntries, normalizeSecretFile, secretReceipt, writeEnvSecrets,
} from '../../lib/env-secrets.js';

/**
 * POST /api/agent/secret — the Chat surface's SECRET card lands here, and this is the only
 * hop a pasted credential makes. Body: `{ file?: ".env", entries: [{ key, value }] }`.
 * The response is a RECEIPT (key, file, char count, sha256 fingerprint, added/updated) and
 * never echoes a value back; the client turns that receipt into the message the agent sees.
 *
 * ── Why this is not desktop-gated, unlike the agent terminal ──────────────────────────
 * The embedded terminal is desktop+loopback-only because it hands out an interactive shell.
 * This route hands out a bounded write into one `.env`-family file inside the project the
 * request already named — less than `POST /api/knowledge` already does, and it is protected
 * by the same two gates every write on this server has: `isCrossSiteWrite` (so a drive-by
 * page cannot post here) and, with remote access on, the tailnet token that got the request
 * to the port at all. Gating it to the desktop would break the case the feature was asked
 * for twice over: pasting a token from the phone, where opening an editor is worst.
 *
 * Every real guard — path grammar, realpath containment, symlink refusal, git-tracked
 * refusal, gitignore-before-write — lives in `lib/env-secrets.ts` and is re-run here on the
 * raw body. The client validates too, for the error message; this is the check that counts.
 */
export async function handleAgentSecret(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'bad_body', 'Expected a JSON body.');
    return;
  }

  // `contextRoot` is <projectRoot>/_dream_context; a .env belongs to the PROJECT, one level
  // up. That is the only place in this file that knows the difference, and the writer is
  // given the project root so its containment check is anchored where the user means.
  let projectRoot = dirname(contextRoot);
  // A dreamcontext App's secret (dreamcontext-apps plan r19): `app` names an app OF THIS
  // PROJECT (registry lookup by this project's root, never a path from the body), and its
  // `.env` lives at the app's own root. Every env-secrets guard below runs unchanged there.
  let appName: string | null = null;
  if (body.app !== undefined) {
    const rec = typeof body.app === 'string' && APP_SLUG_RE.test(body.app) ? getApp(homedir(), projectRoot, body.app) : null;
    if (!rec) {
      sendError(res, 404, 'app_not_found', 'That app does not belong to this project.');
      return;
    }
    projectRoot = rec.root;
    appName = rec.name;
  }

  try {
    const file = normalizeSecretFile(body.file);
    const entries = normalizeSecretEntries(body.entries);
    const result = writeEnvSecrets(projectRoot, file, entries);
    // The message the agent will receive is built HERE, next to the write it describes, and
    // posted verbatim by the client. Composing it in the browser would put the client one
    // typo away from interpolating a value into the sentence that exists to keep values
    // out — so the surface that HAS the value never gets to write the sentence about it.
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    if (appName !== null && typeof body.app === 'string') {
      // A new key reaches the running backend through a rolling restart, and the sink learns it.
      const rec = getApp(homedir(), dirname(contextRoot), body.app);
      const rt = rec ? existingRuntime(rec.hash) : null;
      if (rt) { rt.refreshSecrets(); if (rt.state === 'running') void rt.update(); }
    }
    sendJson(res, 200, { ...result, ...(appName !== null ? { app: appName } : {}), receipt: secretReceipt(result, title || undefined) });
  } catch (err) {
    if (err instanceof SecretWriteError) {
      // 409 for "the repository says no" (tracked / symlinked / outside the project), 400
      // for a malformed ask, 500 for a filesystem that would not cooperate. The client
      // renders `message` verbatim, so every one of them is written as a sentence a user
      // can act on — and none of them can contain the value.
      const status = err.code === 'write_failed' || err.code === 'gitignore_failed'
        ? 500
        : err.code === 'tracked' || err.code === 'symlink' || err.code === 'escapes_root' || err.code === 'not_a_file'
          ? 409
          : 400;
      sendError(res, status, err.code, err.message);
      return;
    }
    // Deliberately opaque, and deliberately not logged: an unexpected throw out of the
    // write path could be carrying the value in a stack frame, and this route's whole
    // premise is that the value goes to the file and nowhere else.
    sendError(res, 500, 'secret_write_failed', 'The secret could not be written.');
  }
}
