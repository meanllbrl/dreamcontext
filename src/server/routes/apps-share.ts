/**
 * Shared-app routes (paylasilan-app-ler plan r3). Reads (previews, the shared list, an update
 * check) answer the desktop app on this Mac. Every decision in the owner's name (publish, accept
 * an invitation, install, settings and keys, update, undo, auto-update, my own copy, uninstall,
 * restore) needs the owner's own page: the shell's key, never a header a process can write
 * (plan r2 K5.4, `fromOwnerPage`). An agent's `curl` gets 403 `owner_page_only`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { requireLocalDesktop } from './agent-spawn-shared.js';
import { fromOwnerPage } from './assistant.js';
import { holdOpen } from '../hold-open.js';
import { appsHomeDir, findAppFor, projectRootOf, retireAppRuntime, refreshAppRuntime } from './apps.js';
import { readManifest } from '../../lib/apps/manifest.js';
import { getApp, updateAppShare, type AppRecord } from '../../lib/apps/registry.js';
import { ConfigError, missingRequired, newConfigId, presentSecretKeys, readAppConfig, setAppConfig } from '../../lib/apps/app-config.js';
import { writeEnvSecrets, SecretWriteError } from '../../lib/env-secrets.js';
import { listVaults } from '../../lib/vaults.js';
import { HostError, resolveAppHost } from '../../lib/apps/share/host.js';
import { buildPublishTree, publishApp, PublishError } from '../../lib/apps/share/publish.js';
import { clearSharedCache, listShared } from '../../lib/apps/share/shared.js';
import { installApp, InstallError, listTrash, previewInstall, restoreFromTrash, uninstallApp } from '../../lib/apps/share/install.js';
import { applyUpdate, checkUpdate, detachApp, setAutoUpdate, undoUpdate, type ApplyHow } from '../../lib/apps/share/update.js';

type Params = Record<string, string>;

function ownerOnly(req: IncomingMessage, res: ServerResponse): boolean {
  if (!requireLocalDesktop(req, res)) return false;
  if (fromOwnerPage(req)) return true;
  sendError(res, 403, 'owner_page_only', 'Only the owner\'s own Apps page can do this (a click in the dreamcontext app).');
  return false;
}

function realRoot(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function sendFailure(res: ServerResponse, e: unknown): void {
  if (e instanceof PublishError) { sendJson(res, e.code === 'gate_blocked' ? 422 : 409, { error: e.code, message: e.message, ...(e.report ? { report: e.report } : {}) }); return; }
  if (e instanceof InstallError) { sendJson(res, 409, { error: e.code, message: e.message, ...(e.report ? { report: e.report } : {}) }); return; }
  if (e instanceof HostError) { sendError(res, e.code === 'not_signed_in' ? 401 : e.code === 'rate_limited' ? 429 : 409, e.code, e.message); return; }
  if (e instanceof ConfigError || e instanceof SecretWriteError) { sendError(res, 400, (e as { code: string }).code, e.message); return; }
  sendError(res, 500, 'share_failed', (e as Error)?.message ?? String(e));
}

/** The share fields of an app for its card. */
export function shareStatus(rec: AppRecord): Record<string, unknown> {
  const m = readManifest(rec.root);
  const fields = m.ok ? m.manifest.config : [];
  const values = readAppConfig(appsHomeDir(), rec.configId);
  return {
    origin: rec.origin ?? 'own',
    source: rec.source ? { fullName: rec.source.fullName, owner: rec.source.owner, public: rec.source.public, autoUpdate: rec.source.autoUpdate, available: rec.source.available?.sha ?? null, problem: rec.source.problem ?? null, lastCheck: rec.source.lastCheck ?? null } : null,
    provenance: rec.origin === 'installed' && !rec.source && rec.provenance ? { fullName: rec.provenance.fullName } : null,
    publish: rec.publish ? { fullName: rec.publish.fullName, public: rec.publish.public, at: rec.publish.at } : null,
    configCount: fields.length,
    configMissing: fields.length ? missingRequired(fields, values, rec.root) : [],
  };
}

// ─── Publish ────────────────────────────────────────────────────────────────────────

export async function handlePublishPreview(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const url = new URL(req.url ?? '/', 'http://x');
  const visibility = url.searchParams.get('visibility') === 'public' ? 'public' : 'private';
  const host = resolveAppHost(appsHomeDir());
  let login: string | null = null;
  try { login = host.signedIn ? (await host.me()).login : null; } catch { login = null; }
  try {
    const pv = buildPublishTree(appsHomeDir(), rec, { visibility, login: login ?? 'you', repoName: url.searchParams.get('repo') || undefined });
    sendJson(res, 200, { host: host.kind, signedIn: !!login, login, repoName: pv.repoName, fullName: pv.fullName ?? (login ? `${login}/${pv.repoName}` : null), license: pv.license, visibility, report: pv.report, name: pv.manifest.name, published: rec.publish ?? null });
  } catch (e) { sendFailure(res, e); }
}

export async function handlePublish(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  holdOpen(req);
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const b = (await parseJsonBody(req)) ?? {};
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : []);
  try {
    const out = await publishApp(rec, {
      home: appsHomeDir(), host: resolveAppHost(appsHomeDir()),
      visibility: b.visibility === 'public' ? 'public' : 'private',
      repoName: typeof b.repoName === 'string' && b.repoName.trim() ? b.repoName.trim() : undefined,
      invite: strings(b.invite), approvals: strings(b.approvals),
      note: typeof b.note === 'string' ? b.note : undefined,
      confirmName: typeof b.confirmName === 'string' ? b.confirmName : undefined,
      fresh: b.fresh === true,
    });
    clearSharedCache();
    sendJson(res, 200, { ok: true, ...out });
  } catch (e) { sendFailure(res, e); }
}

// ─── Shared with you, install ───────────────────────────────────────────────────────

export async function handleSharedList(req: IncomingMessage, res: ServerResponse, _p: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const force = new URL(req.url ?? '/', 'http://x').searchParams.get('refresh') === '1';
  try {
    sendJson(res, 200, await listShared(resolveAppHost(appsHomeDir()), { force, projectRoot: realRoot(projectRootOf(contextRoot)), home: appsHomeDir() }));
  } catch (e) { sendFailure(res, e); }
}

export async function handleSharedAccept(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  try {
    await resolveAppHost(appsHomeDir()).acceptInvitation(String(b.id ?? ''));
    clearSharedCache();
    sendJson(res, 200, { ok: true });
  } catch (e) { sendFailure(res, e); }
}

export async function handleInstallPreview(req: IncomingMessage, res: ServerResponse, _p: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const b = (await parseJsonBody(req)) ?? {};
  try {
    sendJson(res, 200, await previewInstall({ home: appsHomeDir(), projectRoot: realRoot(projectRootOf(contextRoot)), ref: String(b.ref ?? '') }));
  } catch (e) { sendFailure(res, e); }
}

function writeSecrets(rec: AppRecord, secrets: unknown): void {
  if (!secrets || typeof secrets !== 'object') return;
  const m = readManifest(rec.root);
  const allowed = new Set(m.ok ? m.manifest.config.filter((f) => f.type === 'secret').map((f) => f.key) : []);
  const entries = Object.entries(secrets as Record<string, unknown>).filter(([k, v]) => allowed.has(k) && typeof v === 'string' && v.length > 0).map(([key, value]) => ({ key, value: value as string }));
  if (entries.length) writeEnvSecrets(rec.root, '.env', entries);
}

export async function handleInstall(req: IncomingMessage, res: ServerResponse, _p: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  holdOpen(req);
  const b = (await parseJsonBody(req)) ?? {};
  const projectRoot = realRoot(projectRootOf(contextRoot));
  const vault = listVaults(appsHomeDir()).find((v) => realRoot(v.path) === projectRoot)?.name;
  if (!vault) { sendError(res, 409, 'no_vault', 'This project is not registered.'); return; }
  try {
    const { rec, renamed } = await installApp({
      home: appsHomeDir(), projectRoot, vault,
      previewId: String(b.previewId ?? ''), sha: String(b.sha ?? ''),
      config: b.config && typeof b.config === 'object' ? (b.config as Record<string, unknown>) : undefined,
    });
    writeSecrets(rec, b.secrets);
    clearSharedCache();
    sendJson(res, 200, { ok: true, slug: rec.slug, renamed });
  } catch (e) { sendFailure(res, e); }
}

// ─── Settings and keys ──────────────────────────────────────────────────────────────

export async function handleAppConfigGet(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const m = readManifest(rec.root);
  const fields = m.ok ? m.manifest.config : [];
  const values = readAppConfig(appsHomeDir(), rec.configId);
  const secrets = presentSecretKeys(rec.root);
  sendJson(res, 200, {
    fields: fields.map((f) => ({ ...f, ...(f.type === 'secret' ? { set: secrets.has(f.key) } : { value: values[f.key] ?? null }) })),
    missing: missingRequired(fields, values, rec.root),
  });
}

export async function handleAppConfigSet(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  let rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const b = (await parseJsonBody(req)) ?? {};
  const m = readManifest(rec.root);
  if (!m.ok) { sendError(res, 409, 'manifest_invalid', 'The manifest has problems.'); return; }
  try {
    if (!rec.configId) rec = updateAppShare(appsHomeDir(), rec.projectRoot, rec.slug, { configId: newConfigId() }) ?? rec;
    if (b.values && typeof b.values === 'object') setAppConfig(appsHomeDir(), rec.configId!, m.manifest.config, b.values as Record<string, unknown>);
    writeSecrets(rec, b.secrets);
    refreshAppRuntime(rec);
    sendJson(res, 200, { ok: true, missing: missingRequired(m.manifest.config, readAppConfig(appsHomeDir(), rec.configId), rec.root) });
  } catch (e) { sendFailure(res, e); }
}

// ─── Update, undo, auto-update, my own copy, uninstall, trash ──────────────────────

export async function handleUpdateCheck(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  try { sendJson(res, 200, await checkUpdate(appsHomeDir(), rec)); } catch (e) { sendFailure(res, e); }
}

export async function handleUpdateApply(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const b = (await parseJsonBody(req)) ?? {};
  const how = b.how === 'merge' || b.how === 'set-aside' ? (b.how as ApplyHow) : undefined;
  try {
    const out = applyUpdate(appsHomeDir(), rec, { sha: String(b.sha ?? ''), approveManifest: b.approveManifest === true, how });
    refreshAppRuntime(getApp(appsHomeDir(), rec.projectRoot, rec.slug) ?? rec);
    sendJson(res, 200, { ok: true, ...out });
  } catch (e) { sendFailure(res, e); }
}

export async function handleUpdateUndo(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  try {
    const out = undoUpdate(appsHomeDir(), rec);
    refreshAppRuntime(getApp(appsHomeDir(), rec.projectRoot, rec.slug) ?? rec);
    sendJson(res, 200, { ok: true, ...out });
  } catch (e) { sendFailure(res, e); }
}

export async function handleAutoUpdate(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const b = (await parseJsonBody(req)) ?? {};
  try { setAutoUpdate(appsHomeDir(), rec, b.enabled === true); sendJson(res, 200, { ok: true }); } catch (e) { sendFailure(res, e); }
}

export async function handleDetach(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  try { const next = detachApp(appsHomeDir(), rec); refreshAppRuntime(next); sendJson(res, 200, { ok: true }); } catch (e) { sendFailure(res, e); }
}

export async function handleUninstall(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const b = (await parseJsonBody(req)) ?? {};
  try {
    await retireAppRuntime(rec);
    const entry = uninstallApp(appsHomeDir(), rec, { deleteData: b.deleteData === true });
    clearSharedCache();
    sendJson(res, 200, { ok: true, trash: entry });
  } catch (e) { sendFailure(res, e); }
}

export async function handleTrashList(req: IncomingMessage, res: ServerResponse, _p: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  sendJson(res, 200, { trash: listTrash(appsHomeDir(), realRoot(projectRootOf(contextRoot))) });
}

export async function handleTrashRestore(req: IncomingMessage, res: ServerResponse, _p: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  const id = String(b.id ?? '');
  const mine = listTrash(appsHomeDir(), realRoot(projectRootOf(contextRoot))).some((t) => t.id === id);
  if (!mine) { sendError(res, 404, 'not_in_trash', 'No such app in this project\'s trash.'); return; }
  try { const rec = restoreFromTrash(appsHomeDir(), id); clearSharedCache(); sendJson(res, 200, { ok: true, slug: rec.slug }); } catch (e) { sendFailure(res, e); }
}
