import { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import { listConnections } from '../../lib/connections.js';
import { readPeerSummaryCache } from '../../lib/federation-peer-summary.js';
import { peerAgentSlug } from '../../lib/peer-agent-gen.js';
import { findVaultLogo } from '../../lib/vault-logo.js';
import { VaultError } from '../../lib/vaults.js';
import {
  archiveMessage,
  listMessages,
  listPending,
  readMessage,
  readThread,
  updateMessage,
  type PeerMessageKind,
} from '../../lib/peer-mail.js';
import {
  checkSendConsent,
  resolvePeer,
  selfVaultName,
  sendToPeer,
} from '../../lib/peer-delivery.js';

/**
 * PEER ROUTES — the dashboard's window onto peer mail.
 *
 * On the federation write rule: `src/server/routes/` may not import a federation
 * DIGEST write, because a digest silently materialises documents in another
 * vault's corpus and that mutation belongs in the CLI where consent and the
 * watermark advance together. Mail is a different animal — it writes a message
 * into a mailbox, changes no one's corpus, and the receiving agent decides
 * whether to act. The send here is the same call the CLI makes, through the same
 * consent gate, and the live path runs under the same `auto` permissions.
 *
 * The LIVE path is deliberately NOT here. A browser-driven live message opens
 * the existing chat WebSocket against the peer's vault
 * (`/api/agent/chat?vault=<peer>`), which is what lets the user answer the peer
 * session's permission prompts and keep talking to it. This route handles the
 * mailbox: who can be addressed, what is waiting, and deferred sends.
 */

const KINDS: PeerMessageKind[] = ['note', 'question', 'command'];

/**
 * GET /api/peer/peers — the addressable peers, with the identity glance the
 * composer's `@` menu shows. Purely local: connections file + summary cache, no
 * peer resolution, so opening the menu costs nothing.
 */
export async function handlePeerList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const cache = readPeerSummaryCache(contextRoot);
  const peers = listConnections(contextRoot)
    .filter((c) => c.status !== 'stale')
    .map((c) => {
      const summary = cache?.peers.find((p) => p.vault === c.vault) ?? null;
      return {
        vault: c.vault,
        agent: `peer-${peerAgentSlug(c.vault)}`,
        whatItIs: summary?.whatItIs ?? '',
        activeTask: summary?.activeTask ?? '',
        topTags: summary?.topTags ?? [],
        direction: c.direction,
        // Whether the PEER vault ships a logo (`_dream_context/assets/logo.*` over
        // there). A boolean, not bytes or a path: the client builds the image URL
        // itself (`/api/peer/logo`) and a peer whose path went away simply has none.
        logo: hasPeerLogo(c.vault),
      };
    });
  sendJson(res, 200, { peers });
}

/** True iff the peer resolves AND carries a logo file. Never throws — a stale or
 *  unregistered peer just answers `false`, same posture as the summary cache. */
function hasPeerLogo(vault: string): boolean {
  try {
    return findVaultLogo(resolvePeer(vault).contextRoot) !== null;
  } catch {
    return false;
  }
}

/**
 * GET /api/peer/logo?peer=<vault> — the PEER vault's logo bytes, for `<img src>`.
 *
 * Fetched by the browser itself (no headers), so the requesting project rides in
 * the standard `?vault=` param the router already resolves, and the peer's name in
 * `?peer=`. Same consent line as mail: only a vault this one is actively connected
 * to may be asked for its face — the connections file is the gate, exactly as it
 * is for `sendToPeer`.
 */
export async function handlePeerLogo(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const name = (url.searchParams.get('peer') ?? '').trim();
  if (!name) {
    sendError(res, 400, 'invalid_peer', 'peer must name a connected vault.');
    return;
  }
  const link = listConnections(contextRoot).find(
    (c) => c.status !== 'stale' && c.vault.toLowerCase() === name.toLowerCase(),
  );
  if (!link) {
    sendError(res, 404, 'not_connected', `No active connection to "${name}".`);
    return;
  }
  try {
    const logo = findVaultLogo(resolvePeer(link.vault).contextRoot);
    if (!logo) {
      sendError(res, 404, 'no_logo', `${link.vault} has no logo (assets/logo.png in its vault).`);
      return;
    }
    const bytes = readFileSync(logo.path);
    res.writeHead(200, {
      'Content-Type': logo.mime,
      'Content-Length': bytes.length,
      // Short-lived: a swapped logo should show up on the next pane without a
      // hard reload, while repeat renders within a session stay free.
      'Cache-Control': 'private, max-age=300',
    });
    res.end(bytes);
  } catch (err) {
    if (err instanceof VaultError) {
      sendError(res, 404, 'invalid_vault', err.message);
      return;
    }
    console.error('[peer] logo read failed:', err);
    sendError(res, 500, 'logo_failed', 'Failed to read the logo.');
  }
}

/**
 * GET /api/peer/mail?all=1&thread=<id> — the mailbox. Defaults to what is
 * waiting; `all` includes read/answered/closed and the archive.
 */
export async function handlePeerMailList(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const thread = url.searchParams.get('thread');
  const all = url.searchParams.get('all') === '1';

  const messages = thread
    ? readThread(contextRoot, thread)
    : all
      ? listMessages(contextRoot, { includeArchived: true })
      : listPending(contextRoot);

  sendJson(res, 200, { messages, self: selfVaultName(contextRoot) });
}

/**
 * POST /api/peer/send — deliver a message into a peer's mailbox.
 *
 * Strict-pick on the body (never spread): `vault`, `kind`, `body`, `thread`,
 * `replyTo`. `live` is accepted but only ever WEAKENED — the route will not
 * start a headless peer run on a browser request, because a run that asks for a
 * permission it cannot get would hang an HTTP handler for its whole timeout. The
 * client opens the chat socket for that.
 */
export async function handlePeerSend(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }

  const vault = body.vault;
  if (typeof vault !== 'string' || !vault.trim()) {
    sendError(res, 400, 'invalid_vault', 'vault must be a non-empty string.');
    return;
  }
  const text = body.body;
  if (typeof text !== 'string' || !text.trim()) {
    sendError(res, 400, 'invalid_message', 'body must be a non-empty string.');
    return;
  }
  const kind = typeof body.kind === 'string' ? body.kind : 'note';
  if (!(KINDS as string[]).includes(kind)) {
    sendError(res, 400, 'invalid_kind', `kind must be one of: ${KINDS.join(', ')}.`);
    return;
  }
  const thread = typeof body.thread === 'string' && body.thread ? body.thread : null;
  const replyTo = typeof body.replyTo === 'string' && body.replyTo ? body.replyTo : null;

  try {
    const peer = resolvePeer(vault.trim());
    const self = selfVaultName(contextRoot);
    const consent = checkSendConsent(contextRoot, peer, self);
    if (!consent.ok) {
      sendError(res, 400, 'not_connected', `${consent.reason} ${consent.hint}`);
      return;
    }
    const result = await sendToPeer(
      contextRoot,
      peer,
      { kind: kind as PeerMessageKind, body: text, thread, replyTo },
      // Never live from the browser — see the route doc.
      { live: false },
    );
    sendJson(res, 200, { message: result.message });
  } catch (err) {
    if (err instanceof VaultError) {
      sendError(res, 400, 'invalid_vault', err.message);
      return;
    }
    console.error('[peer] send failed:', err);
    sendError(res, 500, 'send_failed', 'Failed to deliver the message.');
  }
}

/**
 * POST /api/peer/mail/:id/status — mark a message read/answered/done. `done`
 * also archives it, matching `peer done`, so the dashboard and the CLI leave the
 * mailbox in the same state.
 */
export async function handlePeerMailStatus(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  const status = body && typeof body.status === 'string' ? body.status : '';
  if (!['read', 'answered', 'done'].includes(status)) {
    sendError(res, 400, 'invalid_status', 'status must be read, answered, or done.');
    return;
  }
  const id = params.id ?? '';
  if (!readMessage(contextRoot, id)) {
    sendError(res, 404, 'not_found', `No message "${id}".`);
    return;
  }
  const updated = updateMessage(contextRoot, id, { status: status as 'read' | 'answered' | 'done' });
  if (status === 'done') archiveMessage(contextRoot, id);
  sendJson(res, 200, { message: updated });
}
