/**
 * Shared-app routes (paylasilan-app-ler plan r3). Reads (previews, the shared list, an update
 * check) answer the desktop app on this Mac. Every decision in the owner's name (publish, accept
 * an invitation, install, settings and keys, update, undo, auto-update, my own copy, uninstall,
 * restore) needs the owner's own page: the shell's key, never a header a process can write
 * (plan r2 K5.4, `fromOwnerPage`). An agent's `curl` gets 403 `owner_page_only`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { requireLocalDesktop } from './agent-spawn-shared.js';
import { fromOwnerPage, ownerRefusalMessage } from './assistant.js';
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
import { githubErrorPayload } from '../../lib/git-sync/failure.js';
import { publishApp, PublishError, RESHARE_OK } from '../../lib/apps/share/publish.js';
import { mintPublishGrant } from '../../lib/apps/share/publish-grant.js';
import { peekAppGrant, takeAppGrant, type AppAction, type TakeResult } from '../../lib/apps/share/app-grant.js';
import { openAppRequest, requestLogoBytes, requestSessionsOf, type ActionPlan } from '../../lib/apps/share/app-request.js';
import { buildInstallPlan, inviteWarnList, updateStillBound } from '../../lib/apps/share/app-plan.js';
import { parseAppRepoRef } from '../../lib/apps/share/host.js';
import { clearSharedCache, listShared, sharedWaiting } from '../../lib/apps/share/shared.js';
import { clearInvitersCache } from '../../lib/apps/share/inviters.js';
import { catalogEntryFor, removeCatalogEntry, upsertCatalogEntry } from '../../lib/apps/catalog.js';
import { resolveActivePerson } from '../../lib/people-resolve.js';
import { installApp, InstallError, installProgress, listTrash, previewInstall, restoreFromTrash, trackInstall, uninstallApp } from '../../lib/apps/share/install.js';
import { applyUpdate, checkUpdate, detachApp, setAutoUpdate, undoUpdate, type ApplyHow } from '../../lib/apps/share/update.js';
import { realPath } from '../../lib/real-path.js';
import { configSuggestions } from '../../lib/apps/config-suggest.js';

type Params = Record<string, string>;

function ownerOnly(req: IncomingMessage, res: ServerResponse): boolean {
  if (!requireLocalDesktop(req, res)) return false;
  if (fromOwnerPage(req)) return true;
  sendError(res, 403, 'owner_page_only', ownerRefusalMessage(req, 'Only the owner\'s own Apps page can do this (a click in the dreamcontext app).'));
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
  sendError(res, 403, 'owner_page_only', ownerRefusalMessage(req, 'Only the owner\'s own Apps page can do this (a click in the dreamcontext app), or the one-time grant his Onayla on your request card opened (`--ask`).'));
  return false;
}

const ASK_AGAIN = 'Run the same --ask command again: the owner sees a card and one tap gives a new hour.';

function refuseGrant(res: ServerResponse, t: Extract<TakeResult, { ok: false }>, action: AppAction): void {
  if (t.why === 'used') { sendError(res, 409, 'grant_used', `This grant already ran${t.fullName ? ` (${t.fullName})` : ''}. It is done: do not run it again, and never ask for a new grant for it.`); return; }
  if (t.why === 'running') { sendError(res, 409, action === 'publish' ? 'publish_running' : 'grant_running', 'An action on this grant is still running. Wait, then check whether it went through; do not run it again.'); return; }
  // A Share click's grant was never an --ask: the owner presses Share again (A11).
  if (t.why === 'expired') { sendError(res, 403, 'grant_expired', `The grant ran out (one hour). The work you did stays. ${action === 'publish' ? ASK_AGAIN.replace(/\.$/, ', or ask the owner to press Share again.') : ASK_AGAIN}`); return; }
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
  try { return realPath(p); } catch { return p; }
}

function sendFailure(res: ServerResponse, e: unknown): void {
  if (e instanceof PublishError) { sendJson(res, e.code === 'gate_blocked' ? 422 : 409, { error: e.code, message: e.message, ...(e.report ? { report: e.report } : {}) }); return; }
  if (e instanceof InstallError) { sendJson(res, 409, { error: e.code, message: e.message, ...(e.report ? { report: e.report } : {}) }); return; }
  if (e instanceof HostError) {
    // C5: a GitHub sign-in problem carries its kind and whether one Reconnect click fixes it.
    const gh = e.code === 'github_auth' ? githubErrorPayload('auth', 'global')
      : e.code === 'not_signed_in' ? githubErrorPayload('no_token')
      : e.code === 'no_access' ? githubErrorPayload('forbidden', 'global', e.message)
      : e.code === 'rate_limited' ? githubErrorPayload('rate_limited')
      : null;
    sendJson(res, e.code === 'not_signed_in' || e.code === 'github_auth' ? 401 : e.code === 'rate_limited' ? 429 : 409, {
      error: e.code, message: e.message, ...(gh ? { github: gh } : {}),
    });
    return;
  }
  if (e instanceof ConfigError || e instanceof SecretWriteError) { sendError(res, 400, (e as { code: string }).code, e.message); return; }
  if (e instanceof LogoError) { sendError(res, e.code === 'logo_too_large' ? 413 : e.code === 'logo_type' ? 415 : 400, e.code, e.message); return; }
  sendError(res, 500, 'share_failed', (e as Error)?.message ?? String(e));
}

/** The share fields of an app for its card. */
export function shareStatus(rec: AppRecord): Record<string, unknown> {
  const m = readManifest(rec.root);
  const fields = m.ok ? m.manifest.config : [];
  const values = readAppConfig(appsHomeDir(), rec.configId);
  const missing = fields.length ? missingRequired(fields, values, rec.root) : [];
  return {
    origin: rec.origin ?? 'own',
    source: rec.source ? { fullName: rec.source.fullName, owner: rec.source.owner, mode: rec.source.mode, public: rec.source.public, autoUpdate: rec.source.autoUpdate, available: rec.source.available?.sha ?? null, problem: rec.source.problem ?? null, lastCheck: rec.source.lastCheck ?? null, lastUpdate: rec.source.lastUpdate ?? null } : null,
    provenance: rec.origin === 'installed' && !rec.source && rec.provenance ? { fullName: rec.provenance.fullName } : null,
    publish: rec.publish && rec.publish.lastSha ? { fullName: rec.publish.fullName, public: rec.publish.public, at: rec.publish.at } : null,
    configCount: fields.length,
    configMissing: missing,
    configMissingLabels: missing.map((k) => fields.find((f) => f.key === k)?.label ?? k),
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
  // A copy under a licence that forbids sharing it again: said at the click, before a chat opens (A8).
  if (rec.provenance && !RESHARE_OK.has(rec.provenance.license)) { sendError(res, 409, 'license_forbids', `This app is a copy of ${rec.provenance.fullName}, whose licence (${rec.provenance.license}) does not allow sharing it again.`); return; }
  // The visibility is the owner's click: Share is private, "Share publicly" public. An app that
  // is already public stays public (a new version).
  const visibility = b.visibility === 'public' || rec.publish?.public ? 'public' : 'private';
  const g = mintPublishGrant(rec.projectRoot, rec.slug, visibility);
  if (!g) { sendError(res, 409, 'publish_running', 'A publish of this app is still running. Wait for it to finish.'); return; }
  sendJson(res, 200, { grant: g.id, visibility: g.visibility, expiresAt: new Date(g.expiresAt).toISOString() });
}

/** POST /api/apps/:slug/publish/grant/check {grant}: the visibility of a live publish grant, for
 *  `apps job` (K6). Holding the grant is the proof; nothing is taken, extended or minted. */
export async function handlePublishGrantCheck(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const visibility = peekAppGrant(rec.projectRoot, rec.slug, 'publish', b.grant);
  if (!visibility) { sendError(res, 403, 'grant_unknown', 'This grant is not a live publish grant for this app (used, replaced, run out, or the app restarted). Ask the owner to press Paylaş again.'); return; }
  sendJson(res, 200, { visibility });
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
  // A card's Onayla covers exactly the publish it showed, never a new repo: said, not ignored.
  if (bound && b.fresh === true) { held!.done(false); sendError(res, 403, 'fresh_needs_share_click', "A new repo (--fresh) needs the grant of the owner's own Share click on the app's page; the card's Onayla covers only the publish it showed. Nothing was sent."); return; }
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
      invite: strings(b.invite),
      // No count cap (owner rule): each id is still a bounded string.
      approvals: Array.isArray(b.approvals) ? [...new Set(b.approvals.filter((x): x is string => typeof x === 'string' && x.length <= 200))] : [],
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

/** GET /api/apps/shared/waiting: what waits for this account (K1), read fresh each time. The
 *  rail dot is drawn from `known + notInstalled` only (S2: an unknown inviter lights nothing). */
export async function handleSharedWaiting(req: IncomingMessage, res: ServerResponse, _p: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  try {
    const host = resolveAppHost(appsHomeDir());
    if (!host.signedIn) { sendJson(res, 200, { known: 0, unknown: 0, notInstalled: 0, signedIn: false }); return; }
    sendJson(res, 200, { ...(await sharedWaiting(host, { projectRoot: realRoot(projectRootOf(contextRoot)), home: appsHomeDir() })), signedIn: true });
  } catch (e) { sendFailure(res, e); }
}

/** GET /api/apps/install/status: the installs running or just finished (K8), any page reads it. */
export async function handleInstallStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  sendJson(res, 200, { installs: installProgress() });
}

export async function handleSharedAccept(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  try {
    await resolveAppHost(appsHomeDir()).acceptInvitation(String(b.id ?? ''));
    clearSharedCache();
    clearInvitersCache();
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
  const invite = held ? bodyOf(held.plan, 'install-invite') : null;
  const bound = held ? bodyOf(held.plan, 'install') : null;
  if (held && !bound && !invite) { held.done(false); sendError(res, 403, 'owner_page_only', 'This grant is not for an install.'); return; }
  const settingsOf = (rec: AppRecord) => { const m = readManifest(rec.root); return m.ok ? m.manifest.config.length : 0; };
  if (held && invite) { await spendInviteInstall(req, res, held, invite, projectRoot, settingsOf); return; }
  try {
    const vault = listVaults(appsHomeDir()).find((v) => realRoot(v.path) === projectRoot)?.name;
    if (!vault) { held?.done(false); sendError(res, 409, 'no_vault', 'This project is not registered.'); return; }
    const fullName = bound?.fullName ?? (typeof b.ref === 'string' ? parseAppRepoRef(b.ref) : null) ?? String(b.previewId ?? 'app');
    const { rec, renamed } = await trackInstall(fullName, () => installApp(bound ? {
      // The previewed sha and the settings the card showed; never a key (secrets stay the owner's).
      home: appsHomeDir(), projectRoot, vault, previewId: bound.previewId, sha: bound.sha, config: bound.config,
    } : {
      home: appsHomeDir(), projectRoot, vault,
      previewId: String(b.previewId ?? ''), sha: String(b.sha ?? ''),
      config: b.config && typeof b.config === 'object' ? (b.config as Record<string, unknown>) : undefined,
      secrets: b.secrets && typeof b.secrets === 'object' ? (b.secrets as Record<string, unknown>) : undefined,
    }), settingsOf);
    held?.done(true, rec.slug);
    clearSharedCache();
    sendJson(res, 200, { ok: true, slug: rec.slug, renamed, settings: settingsOf(rec) });
  } catch (e) {
    if (held && e instanceof InstallError && (e.code === 'stale_preview' || e.code === 'preview_gone')) { held.done(false); sendError(res, 409, 'stale_request', `The app changed since the owner approved this install: nothing was installed. ${ASK_AGAIN}`); return; }
    held?.done(false, null, failureReason(e));
    sendFailure(res, e);
  }
}

/** The plain reason a spend failed, for the card's "Olmadı: <neden>" (K4). */
function failureReason(e: unknown): string {
  return e instanceof InstallError || e instanceof HostError || e instanceof PublishError ? e.message : 'something went wrong';
}

/**
 * The spend of an invitation install (K2, S1): the grant is the owner's yes to THIS invitation.
 * It is accepted only when its id and repo id still match one addressed to the signed-in account;
 * then the content is read like any preview. The install runs only when nothing on the warn list
 * shows (MCP servers, risky actions, a package problem, a gate block); otherwise nothing is
 * installed, the invitation stays accepted (read only), and a normal sha-bound card opens in the
 * same chat with exactly those facts.
 */
async function spendInviteInstall(req: IncomingMessage, res: ServerResponse, held: Held, invite: Extract<ActionPlan['body'], { action: 'install-invite' }>, projectRoot: string, settingsOf: (rec: AppRecord) => number): Promise<void> {
  const home = appsHomeDir();
  const host = resolveAppHost(home);
  try {
    const vault = listVaults(home).find((v) => realRoot(v.path) === projectRoot)?.name;
    if (!vault) { held.done(false); sendError(res, 409, 'no_vault', 'This project is not registered.'); return; }
    const open = await host.listInvitations();
    const inv = open.find((i) => i.id === invite.invitationId && i.repoId === invite.repoId && i.fullName.toLowerCase() === invite.fullName.toLowerCase());
    if (!inv) {
      // Already accepted (a retry inside the hour) reads the repo; anything else is gone.
      const repo = await host.getRepo(invite.fullName).catch(() => null);
      if (!repo || repo.repoId !== invite.repoId) { held.done(false); sendError(res, 409, 'stale_request', `That invitation is no longer there: nothing was accepted or installed. ${ASK_AGAIN}`); return; }
    } else {
      await host.acceptInvitation(inv.id);
      clearSharedCache();
      clearInvitersCache();
    }
    const pv = await previewInstall({ home, projectRoot, ref: invite.fullName, host });
    if (pv.repoId !== invite.repoId) { held.done(false); sendError(res, 409, 'stale_request', `The repo behind that invitation changed: nothing was installed. ${ASK_AGAIN}`); return; }
    const warn = inviteWarnList(pv);
    if (warn.length) {
      // The yes covered the acceptance; what the content holds needs its own look. The spend
      // carries what it held back, so the card reads "accepted, not installed", never "installed".
      held.done(true, invite.fullName, warn.join('; '));
      if (!pv.gate.ok) { sendJson(res, 409, { error: 'gate_blocked', message: `The invitation is accepted, but this app holds something an app may not, so nothing was installed: ${warn.join('; ')}.` }); return; }
      const built = await buildInstallPlan({ home, vault, contextRoot: '', projectRoot }, invite.fullName, { config: invite.config });
      const out = openAppRequest({ plan: built.plan, stillFresh: built.stillFresh, agentSessions: held.requestId ? requestSessionsOf(held.requestId) : [] });
      sendJson(res, 200, { ok: false, needsLook: true, accepted: true, warn, request: out.id, state: out.state, proposal: out.proposalId });
      return;
    }
    const { rec, renamed } = await trackInstall(invite.fullName, () => installApp({ home, projectRoot, vault, previewId: pv.previewId, sha: pv.sha, config: invite.config }), settingsOf);
    held.done(true, rec.slug);
    clearSharedCache();
    sendJson(res, 200, { ok: true, slug: rec.slug, renamed, accepted: true, settings: settingsOf(rec) });
  } catch (e) {
    held.done(false, null, failureReason(e));
    sendFailure(res, e);
  }
}

// ─── Who it is shared with (K7) ─────────────────────────────────────────────────────

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** An own app, published privately: the only kind "Kişi ekle" invites to (S7). */
function ownPrivatePublished(rec: AppRecord): string | null {
  if (rec.origin === 'installed' && (rec.source || !rec.provenance)) return null;
  if (!rec.publish?.lastSha || rec.publish.public) return null;
  return rec.publish.fullName;
}

/** GET /api/apps/:slug/share/people: who can install my published app, and who still has my
 *  invitation (one host read per page open). Nothing for an app that is not mine or not out. */
export async function handleSharePeople(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const own = !(rec.origin === 'installed' && (rec.source || !rec.provenance));
  if (!own || !rec.publish?.lastSha) { sendJson(res, 200, { published: false }); return; }
  try {
    const host = resolveAppHost(appsHomeDir());
    const me = (await host.me()).login.toLowerCase();
    const p = await host.repoPeople(rec.publish.fullName);
    sendJson(res, 200, {
      published: true, fullName: rec.publish.fullName, public: rec.publish.public,
      people: p.collaborators.filter((l) => l.toLowerCase() !== me), pending: p.pending,
    });
  } catch (e) {
    sendJson(res, 200, { published: true, fullName: rec.publish.fullName, public: rec.publish.public, problem: e instanceof HostError ? e.message : 'GitHub did not answer' });
  }
}

/**
 * POST /api/apps/:slug/share/invite {login} (K7, S7): one more person for the version already out,
 * with no new publish. The owner's page only; my own app, published privately; the login checked
 * before any host call; read-only access (`addCollaborator` is `pull`, S1).
 */
export async function handleShareInvite(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const b = (await parseJsonBody(req)) ?? {};
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const login = typeof b.login === 'string' ? b.login.trim().replace(/^@/, '') : '';
  if (!LOGIN_RE.test(login)) { sendError(res, 400, 'bad_login', 'That is not a GitHub username.'); return; }
  const fullName = ownPrivatePublished(rec);
  if (!fullName) { sendError(res, 409, 'not_invitable', rec.publish?.public ? 'This app is public: anyone with the link installs it, no invitation needed.' : 'Only your own app, already shared privately, takes one more person this way.'); return; }
  try {
    const host = resolveAppHost(appsHomeDir());
    if (login.toLowerCase() === (await host.me()).login.toLowerCase()) { sendError(res, 400, 'bad_login', 'That is your own account.'); return; }
    if (!(await host.user(login))) { sendError(res, 404, 'no_such_user', `GitHub has no user "${login}".`); return; }
    await host.addCollaborator(fullName, login);
    clearInvitersCache();
    sendJson(res, 200, { ok: true, invited: login });
  } catch (e) { sendFailure(res, e); }
}

// ─── Settings and keys ──────────────────────────────────────────────────────────────

/** GET /api/apps/:slug/config/suggest (K9): each setting's candidates from this project, the same
 *  list `apps config --suggest` prints. Names only. */
export async function handleAppConfigSuggest(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!ownerOnly(req, res)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const m = readManifest(rec.root);
  const fields = m.ok ? m.manifest.config : [];
  sendJson(res, 200, { fields: fields.filter((f) => f.type !== 'secret').map((f) => ({ key: f.key, candidates: configSuggestions(rec.projectRoot, f) })) });
}

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
    refreshAppRuntime(rec, { restart: true });
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
  // `npm ci` can outlive the 30 s socket idle (A4).
  holdOpen(req);
  const b = (await parseJsonBody(req)) ?? {};
  if (!preGate(req, res, b.grant)) return;
  const rec = findAppFor(contextRoot, params.slug, res);
  if (!rec) return;
  const gate = ownerOrGrant(req, res, { projectRoot: rec.projectRoot, key: rec.slug, action: 'update' }, b.grant);
  if (!gate) return;
  const held = gate.owner ? null : gate.held;
  const bound = held ? bodyOf(held.plan, 'update') : null;
  if (held && !bound) { held.done(false); sendError(res, 403, 'owner_page_only', 'This grant is not for an update.'); return; }
  const how = bound ? bound.how ?? undefined : b.how === 'merge' || b.how === 'set-aside' ? (b.how as ApplyHow) : undefined;
  try {
    // A card's grant: the facts it showed must still hold (a new edit or a newer update refuses
    // it). Inside the try: a throw here (the app's folder gone) still frees the held grant.
    if (held && bound && !updateStillBound(appsHomeDir(), rec, bound)) { staleRequest(res, held); return; }
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
  holdOpen(req);
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
