import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { isLoopback, projectRootOf } from './agent-spawn-shared.js';
import {
  machineMcpServers, planAdoption, projectMcpBroken, projectMcpPath, rawProjectServers,
  readProjectMcp, maskTarget, writeProjectMcp, type ProjectMcpServer,
} from '../../lib/mcp-project.js';

/**
 * Settings → MCP servers: the team-shared scope.
 *
 * This route exists to answer one complaint — "my colleague uses dreamcontext and can't reach
 * the MCP servers" — with the only scope that travels: the repo's `.mcp.json`. A server there
 * is resolved from the working directory, so every account on every machine that clones the
 * repo gets it, with nothing copied and no credential duplicated.
 *
 * ── What this route will NOT do ──────────────────────────────────────────────────────────
 * Write a secret into the repo. `.mcp.json` is committed and, on this product, a brain repo is
 * also synced across a team, so a literal key here is a key published to everyone and to the
 * remote's history. Adopting a machine server therefore REWRITES its `env`/`headers` into
 * `${VAR}` references and reports which variables the user must now set; a URL that carries
 * its own token is refused outright, because turning that into a reference changes what the
 * server is and only the user can make that call. Values are never sent to the client either
 * — only key NAMES, and targets with any opaque segment masked.
 */

function guard(req: IncomingMessage, res: ServerResponse, contextRoot: string | null): boolean {
  if (!isDesktop() || !isLoopback(req)) {
    sendError(res, 403, 'forbidden', 'MCP servers are managed from the desktop app only.');
    return false;
  }
  if (!contextRoot) {
    sendError(res, 400, 'no_vault', 'This request needs a project.');
    return false;
  }
  return true;
}

/** A machine server the project does not have yet — a candidate to share with the team. */
interface McpCandidate {
  name: string;
  kind: string;
  target: string;
  /** Variables that would have to be set after adopting it. */
  wouldRequire: string[];
  /** True when the URL itself is the credential; adopting is refused and this says why. */
  urlCarriedSecret: boolean;
}

function candidates(projectRoot: string): McpCandidate[] {
  const already = new Set(Object.keys(rawProjectServers(projectRoot)));
  return Object.entries(machineMcpServers())
    .filter(([name]) => !already.has(name))
    .map(([name, raw]) => {
      const plan = planAdoption(name, raw);
      const url = typeof raw.url === 'string' ? raw.url : '';
      const command = typeof raw.command === 'string' ? raw.command : '';
      const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [];
      return {
        name,
        kind: typeof raw.type === 'string' ? raw.type : (url ? 'http' : 'stdio'),
        target: maskTarget(url || [command, ...args].filter(Boolean).join(' ')),
        wouldRequire: plan.requires,
        urlCarriedSecret: plan.urlCarriedSecret,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function payload(projectRoot: string): {
  path: string;
  broken: boolean;
  servers: ProjectMcpServer[];
  candidates: McpCandidate[];
} {
  return {
    path: projectMcpPath(projectRoot),
    broken: projectMcpBroken(projectRoot),
    servers: readProjectMcp(projectRoot),
    candidates: candidates(projectRoot),
  };
}

/** GET /api/agent/mcp/project — the repo's shared servers, plus what could join them. */
export async function handleAgentMcpProjectGet(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  sendJson(res, 200, payload(projectRootOf(contextRoot as string)));
}

/**
 * POST /api/agent/mcp/project/adopt — `{ name }`. Move one machine server into the repo.
 *
 * The definition is rewritten before it is written: every `env`/`headers` value that is not
 * already a `${VAR}` reference becomes one. The response names the variables the user now has
 * to set, because a server adopted without them is a server that will fail on their next run
 * and on every teammate's first one.
 */
export async function handleAgentMcpProjectAdopt(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) {
    sendError(res, 422, 'name_required', 'Which server?');
    return;
  }
  const projectRoot = projectRootOf(contextRoot as string);
  const machine = machineMcpServers()[name];
  if (!machine) {
    sendError(res, 404, 'not_on_this_machine', 'This machine has no MCP server by that name.');
    return;
  }

  const plan = planAdoption(name, machine);
  if (plan.urlCarriedSecret) {
    // Refused, not rewritten: the token is INSIDE the URL, and rewriting the URL changes what
    // the server points at. The user has to decide how to split it.
    sendError(res, 409, 'url_carries_secret',
      'This server\'s URL contains its own access token, so sharing it would publish that token. '
      + 'Move the token into an environment variable and re-add the server with a ${VAR} in the URL.');
    return;
  }

  const servers = rawProjectServers(projectRoot);
  servers[name] = plan.definition;
  const written = writeProjectMcp(projectRoot, servers);
  if (!written.ok) {
    sendError(res, 409, 'unsafe_values',
      `Refused: these would have been written as plain secrets — ${written.unsafe.join(', ')}.`);
    return;
  }
  sendJson(res, 200, { ...payload(projectRoot), adopted: name, requires: plan.requires });
}

/** POST /api/agent/mcp/project/remove — `{ name }`. Drop a server from the shared file. */
export async function handleAgentMcpProjectRemove(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!guard(req, res, contextRoot)) return;
  const body = await parseJsonBody(req);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) {
    sendError(res, 422, 'name_required', 'Which server?');
    return;
  }
  const projectRoot = projectRootOf(contextRoot as string);
  const servers = rawProjectServers(projectRoot);
  if (!(name in servers)) {
    sendError(res, 404, 'not_shared', 'That server is not in this project\'s file.');
    return;
  }
  delete servers[name];
  const written = writeProjectMcp(projectRoot, servers);
  if (!written.ok) {
    // Only reachable when the file ALREADY held an unsafe value someone hand-wrote. Removing
    // one server must not become a way to rewrite that file with the secret still in it.
    sendError(res, 409, 'unsafe_values',
      `This file already contains plain secrets (${written.unsafe.join(', ')}). Fix those first.`);
    return;
  }
  sendJson(res, 200, payload(projectRoot));
}
