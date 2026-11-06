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
import { readAppFile, storePage } from '../../lib/apps/store-facts.js';
import { getApp, updateAppShare, type AppRecord } from '../../lib/apps/registry.js';
import { ConfigError, missingRequired, newConfigId, presentSecretKeys, readAppConfig, setAppConfig } from '../../lib/apps/app-config.js';
import { writeEnvSecrets, SecretWriteError } from '../../lib/env-secrets.js';
import { listVaults } from '../../lib/vaults.js';
import { HostError, resolveAppHost } from '../../lib/apps/share/host.js';
import { publishApp, PublishError } from '../../lib/apps/share/publish.js';
import { mintPublishGrant, takePublishGrant } from '../../lib/apps/share/publish-grant.js';
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
    source: rec.source ? { fullName: rec.source.fullName, owner: rec.source.owner, public: rec.source.public, autoUpdate: rec.source.autoUpdate, available: rec.source.available?.sha ?? null, problem: rec.source.problem ?? null, lastCheck: rec.source.lastCheck ?? null, lastUpdate: rec.source.lastUpdate ?? null } : null,
    provenance: rec.origin === 'installed' && !rec.source && rec.provenance ? { fullName: rec.provenance.fullName } : null,
    publish: rec.publish && rec.publish.lastSha ? { fullName: rec.publish.fullName, public: rec.publish.public, at: rec.publish.at } : null,
    configCount: fields.length,
    configMissing: fields.length ? missingRequired(fields, values, rec.root) : [],
  };
}

// ─── Publish ────────────────────────────────────────────────────────────────────────

/** GET /api/apps/:slug/store: an app's own store page (README words, screenshots, what it can do). */
export async function handleAppStore(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const m = readManifest(rec.root);
  if (!m.ok) { sendError(res, 409, 'manifest_invalid', m.errors.map((e) => `${e.field}: ${e.problem}`).join('; ')); return; }
  const readme = readAppFile(rec.root, 'README.md', 256 * 1024)?.toString('utf-8') ?? '';
  const page = storePage(readme, m.manifest, (p) => readAppFile(rec.root, p, 2 * 1024 * 1024));
  sendJson(res, 200, { tagline: page.readme.tagline, category: page.readme.category, about: page.readme.about, whatsNew: page.readme.whatsNew.slice(0, 1), shots: page.shots, can: page.can, readiness: page.readiness });
}

/**
 * POST /api/apps/:slug/publish/grant: the owner pressed Publish on the app's own page (owner
 * 2026-11-06). That click is his decision to publish, and Claude does the work: one grant for this
 * app, one hour, spent by the push (`dreamcontext apps publish <slug> --go --grant <id>`).
 */
export async function handlePublishGrant(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  if (rec.origin === 'installed' && (rec.source || !rec.provenance)) { sendError(res, 409, 'not_yours', 'This app was installed from someone else. Make it your own copy first.'); return; }
  const g = mintPublishGrant(rec.projectRoot, rec.slug);
  sendJson(res, 200, { grant: g.id, expiresAt: new Date(g.expiresAt).toISOString() });
}

/**
 * POST /api/apps/:slug/publish: the push. The owner's page, or Claude holding the grant his
 * Publish click opened for THIS app (`grant` in the body). Anything else: 403 owner_page_only.
 * The gate runs inside `publishApp` either way; a grant passes nothing it stops.
 */
export async function handlePublish(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const owner = fromOwnerPage(req);
  const b = (await parseJsonBody(req)) ?? {};
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const done = owner ? null : takePublishGrant(rec.projectRoot, rec.slug, b.grant);
  if (!owner && !done) { sendError(res, 403, 'owner_page_only', 'Publishing needs the owner: his Publish click on the app\'s page opens a one-hour grant for that app (`--grant`). This one is missing, used, expired or for another app.'); return; }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : []);
  try {
    const out = await publishApp(rec, {
      home: appsHomeDir(), host: resolveAppHost(appsHomeDir()),
      visibility: b.visibility === 'public' ? 'public' : 'private',
      repoName: typeof b.repoName === 'string' && b.repoName.trim() ? b.repoName.trim() : undefined,
      invite: strings(b.invite), approvals: strings(b.approvals),
      note: typeof b.note === 'string' ? b.note : undefined,
      tagline: typeof b.tagline === 'string' ? b.tagline : undefined,
      confirmName: typeof b.confirmName === 'string' ? b.confirmName : undefined,
      fresh: b.fresh === true,
    });
    done?.(true);
    clearSharedCache();
    sendJson(res, 200, { ok: true, ...out });
  } catch (e) { done?.(false); sendFailure(res, e); }
}

// ─── Shared Apps, install ───────────────────────────────────────────────────────

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
      secrets: b.secrets && typeof b.secrets === 'object' ? (b.secrets as Record<string, unknown>) : undefined,
    });
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
    const out = await applyUpdate(appsHomeDir(), rec, { sha: String(b.sha ?? ''), approveManifest: b.approveManifest === true, how });
    refreshAppRuntime(getApp(appsHomeDir(), rec.projectRoot, rec.slug) ?? rec);
    sendJson(res, 200, { ok: true, ...out });
  } catch (e) { sendFailure(res, e); }
}

export async function handleUpdateUndo(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  try {
    const out = await undoUpdate(appsHomeDir(), rec);
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
