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
import { appLogoPath, clearAppLogo, LogoError, MAX_LOGO_BYTES, setAppLogo } from '../../lib/apps/app-logo.js';
import { readCappedBody } from './automations.js';
import { listVaults } from '../../lib/vaults.js';
import { HostError, resolveAppHost } from '../../lib/apps/share/host.js';
import { publishApp, PublishError } from '../../lib/apps/share/publish.js';
import { mintPublishGrant } from '../../lib/apps/share/publish-grant.js';
import { takeAppGrant, type AppAction, type TakeResult } from '../../lib/apps/share/app-grant.js';
import { requestLogoBytes, type ActionPlan } from '../../lib/apps/share/app-request.js';
import { updateStillBound } from '../../lib/apps/share/app-plan.js';
import { parseAppRepoRef } from '../../lib/apps/share/host.js';
import { clearSharedCache, listShared } from '../../lib/apps/share/shared.js';
import { catalogEntryFor, removeCatalogEntry, upsertCatalogEntry } from '../../lib/apps/catalog.js';
import { resolveActivePerson } from '../../lib/people-resolve.js';
import { installApp, InstallError, listTrash, previewInstall, restoreFromTrash, uninstallApp } from '../../lib/apps/share/install.js';
import { applyUpdate, checkUpdate, detachApp, setAutoUpdate, undoUpdate, type ApplyHow } from '../../lib/apps/share/update.js';

type Params = Record<string, string>;

function ownerOnly(req: IncomingMessage, res: ServerResponse): boolean {
  if (!requireLocalDesktop(req, res)) return false;
  if (fromOwnerPage(req)) return true;
  sendError(res, 403, 'owner_page_only', 'Only the owner\'s own Apps page can do this (a click in the dreamcontext app).');
  return false;
}

/** The header a logo spend carries its grant in (its body is the image on the owner's path). */
export const GRANT_HEADER = 'x-dc-grant';

type Held = Extract<TakeResult, { ok: true }>;

/**
 * The action gate (app-onay-karti C2): the owner's own page, or a live grant for exactly this
 * app and action. `{ owner: true }`, `{ owner: false, held }`, or null (the refusal is sent).
 * A bound grant (from a request card) carries its plan; the route runs that and ignores the body.
 * Only a publish accepts an unbound grant (the owner's Share click).
 */
function ownerOrGrant(req: IncomingMessage, res: ServerResponse, slot: { projectRoot: string; key: string; action: AppAction }, grant: unknown): { owner: true } | { owner: false; held: Held } | null {
  if (!preGate(req, res, grant)) return null;
  if (fromOwnerPage(req)) return { owner: true };
  const t = takeAppGrant({ ...slot, id: grant });
  if (!t.ok) { refuseGrant(res, t, slot.action); return null; }
  if (!t.plan && slot.action !== 'publish') { t.done(false); sendError(res, 403, 'owner_page_only', 'This grant is not for this action.'); return null; }
  return { owner: false, held: t };
}

/** Before any lookup: neither the owner's page nor a grant to check is refused as before. */
function preGate(req: IncomingMessage, res: ServerResponse, grant: unknown): boolean {
  if (!requireLocalDesktop(req, res)) return false;
  if (fromOwnerPage(req) || (typeof grant === 'string' && grant)) return true;
  sendError(res, 403, 'owner_page_only', 'Only the owner\'s own Apps page can do this (a click in the dreamcontext app), or the one-time grant his Onayla on your request card opened (`--ask`).');
  return false;
}

const ASK_AGAIN = 'Run the same --ask command again: the owner sees a card and one tap gives a new hour.';

function refuseGrant(res: ServerResponse, t: Extract<TakeResult, { ok: false }>, action: AppAction): void {
  if (t.why === 'used') { sendError(res, 409, 'grant_used', `This grant already ran${t.fullName ? ` (${t.fullName})` : ''}. It is done: do not run it again, and never ask for a new grant for it.`); return; }
  if (t.why === 'running') { sendError(res, 409, action === 'publish' ? 'publish_running' : 'grant_running', 'An action on this grant is still running. Wait, then check whether it went through; do not run it again.'); return; }
  if (t.why === 'expired') { sendError(res, 403, 'grant_expired', `The grant ran out (one hour). The work you did stays. ${ASK_AGAIN}`); return; }
  if (t.why === 'replaced') { sendError(res, 403, 'grant_replaced', 'The owner opened a newer grant for this: use the newest one.'); return; }
  sendError(res, 403, 'owner_page_only', 'This grant is not for this app and action (made up, used, replaced, for another app or action, or the app restarted). Ask the owner with --ask.');
}

/** A bound plan of the right kind for this route, or null. */
function bodyOf<A extends ActionPlan['body']['action']>(plan: ActionPlan | null, action: A): Extract<ActionPlan['body'], { action: A }> | null {
  return plan && plan.body.action === action ? (plan.body as Extract<ActionPlan['body'], { action: A }>) : null;
}

function staleRequest(res: ServerResponse, held: Held): void {
  held.done(false);
  sendError(res, 409, 'stale_request', `The app changed since the owner approved this: nothing ran. ${ASK_AGAIN}`);
}

function realRoot(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function sendFailure(res: ServerResponse, e: unknown): void {
  if (e instanceof PublishError) { sendJson(res, e.code === 'gate_blocked' ? 422 : 409, { error: e.code, message: e.message, ...(e.report ? { report: e.report } : {}) }); return; }
  if (e instanceof InstallError) { sendJson(res, 409, { error: e.code, message: e.message, ...(e.report ? { report: e.report } : {}) }); return; }
  if (e instanceof HostError) { sendError(res, e.code === 'not_signed_in' ? 401 : e.code === 'rate_limited' ? 429 : 409, e.code, e.message); return; }
  if (e instanceof ConfigError || e instanceof SecretWriteError) { sendError(res, 400, (e as { code: string }).code, e.message); return; }
  if (e instanceof LogoError) { sendError(res, e.code === 'logo_too_large' ? 413 : e.code === 'logo_type' ? 415 : 400, e.code, e.message); return; }
  sendError(res, 500, 'share_failed', (e as Error)?.message ?? String(e));
}

/** The share fields of an app for its card. */
export function shareStatus(rec: AppRecord): Record<string, unknown> {
  const m = readManifest(rec.root);
  const fields = m.ok ? m.manifest.config : [];
  const values = readAppConfig(appsHomeDir(), rec.configId);
  return {
    origin: rec.origin ?? 'own',
    source: rec.source ? { fullName: rec.source.fullName, owner: rec.source.owner, mode: rec.source.mode, public: rec.source.public, autoUpdate: rec.source.autoUpdate, available: rec.source.available?.sha ?? null, problem: rec.source.problem ?? null, lastCheck: rec.source.lastCheck ?? null, lastUpdate: rec.source.lastUpdate ?? null } : null,
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
  const b = (await parseJsonBody(req)) ?? {};
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  if (rec.origin === 'installed' && (rec.source || !rec.provenance)) { sendError(res, 409, 'not_yours', 'This app was installed from someone else. Make it your own copy first.'); return; }
  // The visibility is the owner's click: Share is private, "Share publicly" public. An app that
  // is already public stays public (a new version).
  const visibility = b.visibility === 'public' || rec.publish?.public ? 'public' : 'private';
  const g = mintPublishGrant(rec.projectRoot, rec.slug, visibility);
  if (!g) { sendError(res, 409, 'publish_running', 'A publish of this app is still running. Wait for it to finish.'); return; }
  sendJson(res, 200, { grant: g.id, visibility: g.visibility, expiresAt: new Date(g.expiresAt).toISOString() });
}

/**
 * POST /api/apps/:slug/publish: the push. The owner's page, or Claude holding the grant his
 * Publish click opened for THIS app (`grant` in the body). Anything else: 403 owner_page_only.
 * The gate runs inside `publishApp` either way; a grant passes nothing it stops.
 */
export async function handlePublish(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const b = (await parseJsonBody(req)) ?? {};
  if (!preGate(req, res, b.grant)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const gate = ownerOrGrant(req, res, { projectRoot: rec.projectRoot, key: rec.slug, action: 'publish' }, b.grant);
  if (!gate) return;
  const held = gate.owner ? null : gate.held;
  const done = held ? held.done : null;
  const bound = held ? bodyOf(held.plan, 'publish') : null;
  if (held && held.plan && !bound) { held.done(false); sendError(res, 403, 'owner_page_only', 'This grant is not for a publish.'); return; }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : []);
  // A card's grant runs ITS plan: nothing in the body counts (D4). The Share click's grant keeps
  // today's shape: the agent's flags, under the visibility the owner clicked.
  const visibility = bound ? bound.visibility : b.visibility === 'public' ? 'public' : 'private';
  // Going public is for good: only the owner's own "Share publicly" click, or his Onayla on a card
  // that said so, opens it.
  if (held && !bound && held.visibility !== visibility) {
    held.done(false);
    sendError(res, 403, 'grant_scope', held.visibility === 'private' ? 'The owner opened a private publish (Share). Going public needs his own "Share publicly" click on the app\'s page.' : 'The owner opened a public publish: publish with --public.');
    return;
  }
  const catalogOn = bound ? bound.catalog : b.catalog !== false;
  let pushedTo: string | null = null;
  try {
    const out = await publishApp(rec, bound ? {
      home: appsHomeDir(), host: resolveAppHost(appsHomeDir()),
      visibility: bound.visibility, repoName: bound.repoName ?? undefined, invite: bound.invite, approvals: bound.approvals,
      note: bound.note ?? undefined, date: bound.date, expectDigest: bound.digest,
      confirmed: bound.visibility === 'public', fresh: false,
      onPushed: (fullName) => { pushedTo = fullName; done?.(true, fullName); },
    } : {
      home: appsHomeDir(), host: resolveAppHost(appsHomeDir()),
      visibility,
      repoName: typeof b.repoName === 'string' && b.repoName.trim() ? b.repoName.trim() : undefined,
      invite: strings(b.invite), approvals: strings(b.approvals),
      note: typeof b.note === 'string' ? b.note : undefined,
      tagline: typeof b.tagline === 'string' ? b.tagline : undefined,
      // A public grant IS the owner's confirmation (his "Share publicly" click).
      confirmName: held && held.visibility === 'public' ? undefined : typeof b.confirmName === 'string' ? b.confirmName : undefined,
      confirmed: !!held && held.visibility === 'public',
      fresh: b.fresh === true,
      // Spent the moment the push went out: a failure after it never frees it for a second push.
      onPushed: (fullName) => { pushedTo = fullName; done?.(true, fullName); },
    });
    done?.(true);
    clearSharedCache();
    // The brain's list of this project's apps (app-araclari §2): after the push, never before.
    // `catalog: false` keeps a private app off it. A failure here never undoes the publish.
    let catalogged = false;
    if (catalogOn) {
      try {
        const m = readManifest(rec.root);
        if (m.ok) {
          const brief = m.manifest.agent?.brief ?? '';
          upsertCatalogEntry(contextRoot, catalogEntryFor(m.manifest, { repo: out.fullName, visibility, publishedBy: resolveActivePerson(contextRoot).slug, does: brief.split(/(?<=[.!?])\s/)[0] ?? '' }));
          catalogged = true;
        }
      } catch { /* the publish stands; the list is written on the next one */ }
    }
    // Unticked now: an entry from an earlier publish leaves the list too.
    else { try { removeCatalogEntry(contextRoot, rec.slug); } catch { /* the publish stands */ } }
    sendJson(res, 200, { ok: true, ...out, catalogged });
  } catch (e) {
    done?.(false);
    // The push went out and a later step (topics, visibility, an invite) failed: it IS published.
    if (pushedTo) { clearSharedCache(); sendJson(res, 200, { ok: true, pushed: true, fullName: pushedTo, warning: (e as Error).message }); return; }
    if (e instanceof PublishError && e.code === 'stale_request') { sendError(res, 409, 'stale_request', `${e.message}`); return; }
    sendFailure(res, e);
  }
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
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const b = (await parseJsonBody(req)) ?? {};
  const projectRoot = realRoot(projectRootOf(contextRoot));
  // A card's grant is for one repo: its key is the lowercase owner/repo the request previewed.
  const key = typeof b.ref === 'string' ? (parseAppRepoRef(b.ref) ?? '').toLowerCase() : '';
  const gate = ownerOrGrant(req, res, { projectRoot, key, action: 'install' }, b.grant);
  if (!gate) return;
  const held = gate.owner ? null : gate.held;
  const bound = held ? bodyOf(held.plan, 'install') : null;
  if (held && !bound) { held.done(false); sendError(res, 403, 'owner_page_only', 'This grant is not for an install.'); return; }
  const vault = listVaults(appsHomeDir()).find((v) => realRoot(v.path) === projectRoot)?.name;
  if (!vault) { held?.done(false); sendError(res, 409, 'no_vault', 'This project is not registered.'); return; }
  try {
    const { rec, renamed } = await installApp(bound ? {
      // The previewed sha and the settings the card showed; never a key (secrets stay the owner's).
      home: appsHomeDir(), projectRoot, vault, previewId: bound.previewId, sha: bound.sha, config: bound.config,
    } : {
      home: appsHomeDir(), projectRoot, vault,
      previewId: String(b.previewId ?? ''), sha: String(b.sha ?? ''),
      config: b.config && typeof b.config === 'object' ? (b.config as Record<string, unknown>) : undefined,
      secrets: b.secrets && typeof b.secrets === 'object' ? (b.secrets as Record<string, unknown>) : undefined,
    });
    held?.done(true, rec.slug);
    clearSharedCache();
    sendJson(res, 200, { ok: true, slug: rec.slug, renamed });
  } catch (e) {
    held?.done(false);
    if (held && e instanceof InstallError && (e.code === 'stale_preview' || e.code === 'preview_gone')) { sendError(res, 409, 'stale_request', `The app changed since the owner approved this install: nothing was installed. ${ASK_AGAIN}`); return; }
    sendFailure(res, e);
  }
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
    logo: appLogoPath(appsHomeDir(), rec.configId) !== null,
  });
}

/**
 * POST /api/apps/:slug/logo (the image's raw bytes): the owner's own logo for this app on this
 * Mac, typed by its bytes (PNG or JPEG; the page draws a picked SVG into a PNG). Beside its settings, never in
 * its repo, so an update never touches it. The Dock picks it up the next time the app is closed.
 */
export async function handleAppLogoSet(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  const header = req.headers[GRANT_HEADER];
  const grant = Array.isArray(header) ? header[0] : header;
  if (!preGate(req, res, grant)) return;
  let rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const gate = ownerOrGrant(req, res, { projectRoot: rec.projectRoot, key: rec.slug, action: 'logo' }, grant);
  if (!gate) return;
  const held = gate.owner ? null : gate.held;
  let buf: Buffer | null;
  if (held) {
    // The bytes the card showed, snapshotted at the request; the body is never read.
    const bound = bodyOf(held.plan, 'logo');
    buf = bound && held.requestId ? requestLogoBytes(held.requestId, bound.sha256) : null;
    if (!buf) { staleRequest(res, held); return; }
  } else {
    buf = await readCappedBody(req, res, MAX_LOGO_BYTES);
    if (!buf) return;
  }
  try {
    if (!rec.configId) rec = updateAppShare(appsHomeDir(), rec.projectRoot, rec.slug, { configId: newConfigId() }) ?? rec;
    setAppLogo(appsHomeDir(), rec.configId!, buf);
    held?.done(true);
    sendJson(res, 200, { ok: true, logo: true });
  } catch (e) { held?.done(false); sendFailure(res, e); }
}

/** POST /api/apps/:slug/logo/reset: back to the app's own icon. */
export async function handleAppLogoReset(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  try {
    clearAppLogo(appsHomeDir(), rec.configId);
    sendJson(res, 200, { ok: true, logo: false });
  } catch (e) { sendFailure(res, e); }
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
  if (!requireLocalDesktop(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  if (!preGate(req, res, b.grant)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const gate = ownerOrGrant(req, res, { projectRoot: rec.projectRoot, key: rec.slug, action: 'update' }, b.grant);
  if (!gate) return;
  const held = gate.owner ? null : gate.held;
  const bound = held ? bodyOf(held.plan, 'update') : null;
  if (held && !bound) { held.done(false); sendError(res, 403, 'owner_page_only', 'This grant is not for an update.'); return; }
  // A card's grant: the facts it showed must still hold (a new edit or a newer update refuses it).
  if (held && bound && !updateStillBound(appsHomeDir(), rec, bound)) { staleRequest(res, held); return; }
  const how = bound ? bound.how ?? undefined : b.how === 'merge' || b.how === 'set-aside' ? (b.how as ApplyHow) : undefined;
  try {
    const out = await applyUpdate(appsHomeDir(), rec, bound
      ? { sha: bound.sha, approveManifest: bound.approveManifest, how }
      : { sha: String(b.sha ?? ''), approveManifest: b.approveManifest === true, how });
    held?.done(true);
    refreshAppRuntime(getApp(appsHomeDir(), rec.projectRoot, rec.slug) ?? rec);
    sendJson(res, 200, { ok: true, ...out });
  } catch (e) {
    held?.done(false);
    if (held && e instanceof InstallError && e.code === 'stale_card') { sendError(res, 409, 'stale_request', `The update changed since the owner approved it: nothing ran. ${ASK_AGAIN}`); return; }
    sendFailure(res, e);
  }
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
