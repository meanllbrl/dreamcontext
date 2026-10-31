import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { isLoopback, findFirstTranscriptPath } from './agent-spawn-shared.js';
import { resolveAgentSession } from '../../lib/agent-session-map.js';
import { registeredOwnerCandidates, transcriptOwnerCheck } from '../../lib/transcript-locate.js';
import { parseTranscriptHistory } from '../../lib/transcript-history.js';
import { codexHistoryFor } from '../../lib/t3-bridge/codex-history-route.js';
import { replaceSession } from '../../lib/t3-bridge/replace-session.js';
import { bridgeNode } from '../../lib/t3-bridge/node-floor.js';
import { defaultCodexRunner, type CodexRunner } from '../../lib/codex-accounts.js';
import {
  CLAUDE_SEED_BYTES, handoffMessages, removeRawHandoff, seedOutputPath, writeRawHandoff,
  type RawHandoffMessage,
} from '../../lib/t3-bridge/tool-handoff.js';

type Tool = 'claude' | 'codex';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_SEED_BYTES = 16_000;
const SEED_TIMEOUT_MS = 45_000;
const LABEL: Record<Tool, string> = { claude: 'Claude', codex: 'Codex' };

const asTool = (v: unknown): Tool | null => (v === 'claude' || v === 'codex' ? v : null);

/** Tests hand in their own runner; the server runs the bridge bundle's `t3-account seed`. */
export const handoffDeps: { run: CodexRunner; node: () => string | null } = { run: defaultCodexRunner, node: () => bridgeNode() };

/** This project's messages from `id`, or 'refuse' when the conversation is not this project's. */
async function sourceMessages(tool: Tool, id: string, contextRoot: string): Promise<RawHandoffMessage[] | 'refuse'> {
  const liveId = resolveAgentSession(contextRoot, id);
  if (tool === 'codex') {
    const codex = await codexHistoryFor({ tool, id, liveId, contextRoot });
    if (codex === 'refuse' || !codex) return 'refuse';
    return handoffMessages(codex.items);
  }
  const path = findFirstTranscriptPath([liveId, id]);
  if (!path) return [];
  const root = await realpath(dirname(contextRoot));
  // The project's own folder counts even when it is not (yet) a registered vault.
  const owner = transcriptOwnerCheck(path, [root], [...registeredOwnerCandidates(), { path: root, owner: root }]);
  if (owner !== 'mine') return 'refuse';
  return handoffMessages(parseTranscriptHistory(await readFile(path, 'utf-8')));
}

/**
 * POST /api/agent/tool-handoff — the model picker's cross-tool switch (Track T W4), after the
 * owner confirmed that the text goes to the other vendor. Prepares the NEW pane's one-time seed;
 * the client then opens that pane. `{ seeded:false }` = nothing to carry. Any refusal comes
 * BEFORE the client opens anything, so a refused switch leaves the owner's chat as it was.
 */
export async function handleAgentToolHandoff(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, contextRoot: string | null): Promise<void> {
  if (!isDesktop() || !isLoopback(req)) { sendError(res, 403, 'forbidden', 'Carrying a chat to another tool works in the desktop app only.'); return; }
  if (!contextRoot) { sendError(res, 400, 'no_vault', 'No project for this request.'); return; }
  const body = await parseJsonBody(req);
  const from = asTool(body?.from);
  const to = asTool(body?.to);
  const id = typeof body?.id === 'string' ? body.id : '';
  const pane = typeof body?.pane === 'string' ? body.pane : '';
  if (!from || !to || from === to || !UUID_RE.test(id) || !UUID_RE.test(pane)) {
    sendError(res, 422, 'bad_request', '`from`, `to`, `id` and `pane` are required, and the tools must differ.');
    return;
  }
  const messages = await sourceMessages(from, id, contextRoot).catch(() => 'refuse' as const);
  if (messages === 'refuse') { sendError(res, 403, 'thread_not_in_project', 'That conversation does not belong to this project.'); return; }
  if (messages.length === 0) { sendJson(res, 200, { seeded: false }); return; }

  const node = handoffDeps.node();
  const cli = process.env.DREAMCONTEXT_CLI || process.argv[1] || '';
  if (!node || !cli) { sendError(res, 503, 'handoff_unavailable', 'This Mac has no Node that can prepare the handoff.'); return; }

  let failed = false;
  const result = await replaceSession(
    { tool: from, accountId: '', threadId: id },
    { tool: to, accountId: '' },
    {
      contextRoot,
      pane,
      carriesOwnText: true,
      // The old chat stays open beside the new one: nothing closes.
      close: () => undefined,
      open: async () => {
        const raw = writeRawHandoff(contextRoot, pane, { threadId: id, fromLabel: LABEL[from], cap: to === 'claude' ? CLAUDE_SEED_BYTES : CODEX_SEED_BYTES, messages });
        const out = seedOutputPath(contextRoot, pane);
        if (!raw || !out) { failed = true; return; }
        const r = await handoffDeps.run(node, [cli, 't3-account', 'seed', '--in', raw, '--out', out], { env: process.env, timeoutMs: SEED_TIMEOUT_MS, keepStdout: true });
        if (!r.spawned || r.code !== 0) { failed = true; removeRawHandoff(contextRoot, pane); }
      },
    },
  ).catch(() => null);
  if (!result || failed) { sendError(res, 500, 'handoff_failed', 'The conversation could not be prepared for the other tool.'); return; }
  sendJson(res, 200, { seeded: true, carried: messages.length });
}
