import { createServer, type IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { Router } from './router.js';
import { handleCors, isCrossSiteWrite, sendError } from './middleware.js';
import { checkNetworkAuth, generateNetworkToken } from './network-auth.js';
import { serveStatic } from './static.js';
import { handleHealthGet } from './routes/health.js';
import { handleTasksList, handleTasksCreate, handleTasksGet, handleTasksUpdate, handleTasksChangelog, handleTasksInsert, handleTasksSyncStatus, handleTasksSync, handleTasksSyncTest, handleTasksDelete, handleTasksMembers, handleTasksContainers, handleTasksProvision, handleTasksTokenStatus, handleTasksSetToken, handleTaskOverrides, handleTaskOverrideDocGet, handleTaskOverrideDocSave, handleTaskOverrideAddField, handleTaskOverrideRemoveField } from './routes/tasks.js';
import { handleSleepGet, handleSleepUpdate } from './routes/sleep.js';
import { handleEmbeddingModelStatus, handleEmbeddingModelDownload, handleEmbeddingIndexStatus, handleEmbeddingIndexBuild } from './routes/embeddings.js';
import { handleCoreList, handleCoreGet, handleCoreUpdate } from './routes/core.js';
import { handleKnowledgeList, handleKnowledgeGet, handleKnowledgeUpdate, handleKnowledgeAssets } from './routes/knowledge.js';
import { handleChangelogGet, handleReleasesGet, handleUnreleasedGet, handleReleaseGet, handleReleasesCreate, handleReleasesUpdate, handleReleasesDelete, handleActiveVersionGet, handleActiveVersionSet } from './routes/changelog.js';
import { handleGraphGet, handleGraphContentGet } from './routes/graph.js';
import { handleCouncilList, handleCouncilGet, handleCouncilResearchGet } from './routes/council.js';
import { handleConfigGet, handleConfigUpdate } from './routes/config.js';
import { handleVaultsGet } from './routes/vaults.js';
import {
  handleLauncherDiscover,
  handleLauncherRegister,
  handleLauncherDetect,
  handleLauncherScaffold,
  handleLauncherDefaults,
  handleLauncherCatalog,
  handleLauncherCapture,
  handleLauncherCaptureStatus,
  handleLauncherStatus,
  handleLauncherUnregister,
  handleLauncherUpdate,
  handleLauncherUpgrade,
  handleLauncherUpgradeStatus,
  handleLauncherRelaunch,
  handleLauncherFederationGraph,
  handleLauncherConnectionCreate,
  handleLauncherConnectionRemove,
  handleLauncherSyncCreate,
  handleLauncherSyncRemove,
  handleLauncherShareable,
  handleLauncherGithubRepos,
  handleLauncherClone,
  handleLauncherCloneStatus,
  handleLauncherCloneCancel,
  handleSleepyVideo,
  handleSleepyAnim,
  handleSleepyConfigGet,
  handleSleepyConfigSet,
  handleAgentSettingsGet,
  handleAgentSettingsSet,
} from './routes/launcher.js';
import { handleBrainSettingsGet, handleBrainSettingsPut, handleRoadmapPrefsGet, handleRoadmapPrefsPut, handleLabPrefsGet, handleLabPrefsPut } from './routes/ui-settings.js';
import {
  handleObjectivesList,
  handleObjectivesCreate,
  handleObjectivesUpdate,
  handleObjectivesDelete,
  handleObjectivesAddDependency,
  handleObjectivesRemoveDependency,
  handleRoadmapModel,
} from './routes/objectives.js';
import {
  handleLabList,
  handleLabShow,
  handleLabSync,
  handleLabTweaks,
  handleLabBinding,
  handleLabCredentialsGet,
  handleLabCredentialsSet,
} from './routes/lab.js';
import {
  handleThesesList,
  handleThesesCreate,
  handleThesesShow,
  handleThesesUpdate,
  handleThesesDelete,
  handleThesesAddPrediction,
  handleThesesAddEvidence,
  handleThesesSetStatus,
  handleThesesLink,
  handleThesesUnlink,
  handleThesesChangelog,
  handleThesesPromote,
  handleLearningEnable,
  handleLearningDisable,
} from './routes/theses.js';
import { handleBoardGet, handleBoardSharedPut, handleBoardLocalPut } from './routes/board.js';
import {
  handleSleepyChatSend,
  handleSleepyChatStream,
  handleSleepyChatHistory,
  handleSleepyChatReset,
} from './routes/sleepy-chat.js';
import {
  handleAgentCapabilities,
  handleOpenTerminal,
  handleAgentInstall,
  handleAgentInstallStatus,
  handleAgentPromptToken,
  handleAgentTitle,
  handleAgentModelConfig,
  handleAgentSessionModel,
  handleAgentSessionStats,
  handleAgentGoalLive,
  attachAgentTerminal,
} from './routes/agent-terminal.js';
import { handleAgentDrop } from './routes/agent-drop.js';
import { handleAgentSessionsGet, handleAgentSessionsPut } from './routes/agent-sessions.js';
import { handleConnectionsList, handleConnectionsCreate, handleConnectionsDelete } from './routes/connections.js';
import { handleFederationInboxGet, handleFederationSyncPost } from './routes/federation.js';
import { handlePacksGet } from './routes/packs.js';
import { handlePackInstall, handlePackUninstall } from './routes/packs-install.js';
import { handleVersionCheckGet } from './routes/version-check.js';
import { handleTaxonomyGet } from './routes/taxonomy.js';
import { handleRecallGet, handleRecallHaikuGet } from './routes/recall.js';
import {
  handleBrainAuthDeviceStart,
  handleBrainAuthDevicePoll,
  handleBrainAuthStatus,
  handleBrainAuthToken,
  handleBrainAuthLogout,
} from './routes/brain-auth.js';
import {
  handleBrainStatus,
  handleBrainSync,
  handleBrainSettingsGet as handleBrainSyncSettingsGet,
  handleBrainSettingsPost as handleBrainSyncSettingsPost,
  handleBrainOriginCreate,
  handleBrainOriginPreview,
  handleBrainOriginAttach,
  handleBrainOriginUpdate,
  handleBrainOriginDetach,
  handleBrainScrubIgnore,
  handleBrainTeamUpdates,
  handleBrainTeamFetch,
} from './routes/brain.js';
import {
  handleLinkedReposList,
  handleLinkedReposLink,
  handleLinkedReposClone,
  handleLinkedReposUnlink,
} from './routes/linked-repos.js';
import { listVaults } from '../lib/vaults.js';
import { startParentDeathWatch, startVersionDriftWatch, startUpgradeReadyWatch, registerShutdownHandler, killTrackedChildren } from './lifecycle.js';
import { handleAdminShutdown } from './routes/admin.js';
import { dreamcontextVersion, readDreamcontextVersionFromDisk } from '../lib/manifest.js';

export interface ServerOptions {
  port: number;
  /** The pinned vault context root, or null in launcher mode (vault resolved per-request). */
  contextRoot: string | null;
  open: boolean;
  /** Network interface to bind. Defaults to loopback (127.0.0.1). */
  host?: string;
}

function buildRouter(): Router {
  const router = new Router();

  // Health
  router.get('/api/health', handleHealthGet);
  // Version-skew heal: ensure-dashboard shuts a stale server down through this.
  router.post('/api/admin/shutdown', handleAdminShutdown);

  // Tasks
  router.get('/api/tasks', handleTasksList);
  router.post('/api/tasks', handleTasksCreate);
  // Sync routes are registered BEFORE :slug — first match wins.
  router.get('/api/tasks/sync-status', handleTasksSyncStatus);
  router.post('/api/tasks/sync', handleTasksSync);
  router.post('/api/tasks/sync-test', handleTasksSyncTest);
  router.get('/api/tasks/members', handleTasksMembers);
  router.get('/api/tasks/containers', handleTasksContainers);
  router.post('/api/tasks/provision', handleTasksProvision);
  router.get('/api/tasks/token-status', handleTasksTokenStatus);
  router.post('/api/tasks/token', handleTasksSetToken);
  router.get('/api/task-overrides', handleTaskOverrides);
  router.get('/api/task-overrides/doc', handleTaskOverrideDocGet);
  router.put('/api/task-overrides/doc', handleTaskOverrideDocSave);
  router.post('/api/task-overrides/fields', handleTaskOverrideAddField);
  router.delete('/api/task-overrides/fields/:key', handleTaskOverrideRemoveField);
  router.get('/api/tasks/:slug', handleTasksGet);
  router.delete('/api/tasks/:slug', handleTasksDelete);
  router.patch('/api/tasks/:slug', handleTasksUpdate);
  router.post('/api/tasks/:slug/changelog', handleTasksChangelog);
  router.post('/api/tasks/:slug/insert', handleTasksInsert);

  // Sleep
  router.get('/api/sleep', handleSleepGet);
  router.patch('/api/sleep', handleSleepUpdate);
  // Embedding-model status + warm-up (backs the Hybrid recall card). The MODEL
  // is vault-agnostic (shared under ~/.dreamcontext/models); the INDEX is
  // per-vault (guarded inside the handler — needs a resolved contextRoot).
  router.get('/api/embeddings/status', handleEmbeddingModelStatus);
  router.post('/api/embeddings/download', handleEmbeddingModelDownload);
  router.get('/api/embeddings/index/status', handleEmbeddingIndexStatus);
  router.post('/api/embeddings/index', handleEmbeddingIndexBuild);

  // Core
  router.get('/api/core', handleCoreList);
  router.get('/api/core/:filename', handleCoreGet);
  router.put('/api/core/:filename', handleCoreUpdate);

  // Knowledge — `*slug` is a rest param so subdir-qualified slugs work
  // (e.g. data-structures/default, products/lina).
  router.get('/api/knowledge', handleKnowledgeList);
  // Embedded-image resolver for Excalidraw boards — registered before the
  // catch-all `*slug` GET so it isn't shadowed (distinct `knowledge-assets`
  // prefix, but keep it explicit).
  router.get('/api/knowledge-assets/*slug', handleKnowledgeAssets);
  router.get('/api/knowledge/*slug', handleKnowledgeGet);
  router.patch('/api/knowledge/*slug', handleKnowledgeUpdate);

  // Recall — local BM25 search across the brain (powers the Sleepy view).
  // The /haiku variant adds intent-aware, LLM-filtered recall for Ask mode.
  router.get('/api/recall/haiku', handleRecallHaikuGet);
  router.get('/api/recall', handleRecallGet);

  // Brain cloud-sync — GitHub sign-in (app-global) + per-vault brain repo ops.
  // The `/auth` and `/team` prefixes are vault-agnostic (see VAULT_AGNOSTIC_PREFIXES);
  // everything else is header-resolved vault-scoped. Static `device/*` segments are
  // registered explicitly (no param matcher shadows them). Thin over M1 in-process fns.
  router.post('/api/brain/auth/device/start', handleBrainAuthDeviceStart);
  router.post('/api/brain/auth/device/poll', handleBrainAuthDevicePoll);
  router.get('/api/brain/auth/status', handleBrainAuthStatus);
  router.post('/api/brain/auth/token', handleBrainAuthToken);
  router.post('/api/brain/auth/logout', handleBrainAuthLogout);
  router.get('/api/brain/team/updates', handleBrainTeamUpdates);
  router.post('/api/brain/team/fetch', handleBrainTeamFetch);
  router.get('/api/brain/status', handleBrainStatus);
  router.post('/api/brain/sync', handleBrainSync);
  router.get('/api/brain/settings', handleBrainSyncSettingsGet);
  router.post('/api/brain/settings', handleBrainSyncSettingsPost);
  router.post('/api/brain/origin/create', handleBrainOriginCreate);
  router.post('/api/brain/origin/preview', handleBrainOriginPreview);
  router.post('/api/brain/origin/attach', handleBrainOriginAttach);
  router.post('/api/brain/origin/update', handleBrainOriginUpdate);
  router.post('/api/brain/origin/detach', handleBrainOriginDetach);
  router.post('/api/brain/scrub/ignore', handleBrainScrubIgnore);

  // Linked repos — the shared brain governs bare code repos (products) with no
  // `_dream_context/` of their own. Vault-scoped (header-resolved, NOT vault-
  // agnostic), desktop-gated. Thin over the in-process `linked-repos.ts` fns.
  router.get('/api/linked-repos', handleLinkedReposList);
  router.post('/api/linked-repos/link', handleLinkedReposLink);
  router.post('/api/linked-repos/clone', handleLinkedReposClone);
  router.post('/api/linked-repos/unlink', handleLinkedReposUnlink);

  // Graph
  router.get('/api/graph', handleGraphGet);
  router.get('/api/graph/content', handleGraphContentGet);

  // Council
  router.get('/api/council', handleCouncilList);
  router.get('/api/council/:debateId', handleCouncilGet);
  router.get('/api/council/:debateId/:personaSlug/research/:researchSlug', handleCouncilResearchGet);

  // Config
  router.get('/api/config', handleConfigGet);
  router.patch('/api/config', handleConfigUpdate);

  // Launcher (vault-agnostic): discover candidate vaults, register one, detect
  // tech stack for the quiz, and scaffold a new/existing project (onboarding).
  router.get('/api/launcher/discover', handleLauncherDiscover);
  router.get('/api/launcher/detect', handleLauncherDetect);
  router.get('/api/launcher/defaults', handleLauncherDefaults);
  router.get('/api/launcher/catalog', handleLauncherCatalog);
  router.post('/api/launcher/register', handleLauncherRegister);
  router.post('/api/launcher/scaffold', handleLauncherScaffold);
  router.post('/api/launcher/capture', handleLauncherCapture);
  router.get('/api/launcher/capture/status', handleLauncherCaptureStatus);
  router.get('/api/launcher/sleepy-config', handleSleepyConfigGet);
  router.post('/api/launcher/sleepy-config', handleSleepyConfigSet);
  router.get('/api/launcher/agent-settings', handleAgentSettingsGet);
  router.post('/api/launcher/agent-settings', handleAgentSettingsSet);
  // Launcher project status (green/yellow/red) + per-project update + the
  // cross-vault federation "reads" graph (nodes, edges, connect/disconnect).
  router.get('/api/launcher/status', handleLauncherStatus);
  router.post('/api/launcher/unregister', handleLauncherUnregister);
  router.post('/api/launcher/update', handleLauncherUpdate);
  router.post('/api/launcher/upgrade', handleLauncherUpgrade);
  router.get('/api/launcher/upgrade/status', handleLauncherUpgradeStatus);
  router.post('/api/launcher/relaunch', handleLauncherRelaunch);
  router.get('/api/launcher/federation-graph', handleLauncherFederationGraph);
  router.post('/api/launcher/connection', handleLauncherConnectionCreate);
  router.post('/api/launcher/connection/remove', handleLauncherConnectionRemove);
  router.post('/api/launcher/sync', handleLauncherSyncCreate);
  router.post('/api/launcher/sync/remove', handleLauncherSyncRemove);
  router.post('/api/launcher/shareable', handleLauncherShareable);
  router.get('/api/launcher/github/repos', handleLauncherGithubRepos);
  router.post('/api/launcher/clone', handleLauncherClone);
  router.get('/api/launcher/clone/status', handleLauncherCloneStatus);
  router.post('/api/launcher/clone/cancel', handleLauncherCloneCancel);
  router.get('/api/sleepy/video', handleSleepyVideo);
  router.get('/api/sleepy/anim', handleSleepyAnim);

  // Sleepy "Ask" — a real, read-only Claude Code conversation in the active
  // vault, streamed over SSE. /stream is registered before the bare /chat GET
  // (distinct exact paths; explicit order keeps intent clear).
  router.get('/api/sleepy/chat/stream', handleSleepyChatStream);
  router.post('/api/sleepy/chat/reset', handleSleepyChatReset);
  router.get('/api/sleepy/chat', handleSleepyChatHistory);
  router.post('/api/sleepy/chat', handleSleepyChatSend);

  // Agent terminal — real interactive Claude Code in the vault (desktop-only).
  // /capabilities is vault-agnostic; /open-terminal needs the active vault.
  // The embedded terminal itself is a WebSocket upgrade (see attachAgentTerminal),
  // not a router route.
  router.get('/api/agent/capabilities', handleAgentCapabilities);
  // Model/effort options + the user's CLI defaults, and a session's current model (from its
  // transcript). Vault-agnostic — they read the Claude CLI's own state, not the vault.
  router.get('/api/agent/model-config', handleAgentModelConfig);
  router.get('/api/agent/session-model', handleAgentSessionModel);
  router.get('/api/agent/session-stats', handleAgentSessionStats);
  router.get('/api/agent/goal-live', handleAgentGoalLive);
  router.post('/api/agent/open-terminal', handleOpenTerminal);
  // In-app prerequisite installer (Claude CLI / node-pty) — vault-agnostic.
  router.post('/api/agent/install', handleAgentInstall);
  router.get('/api/agent/install/status', handleAgentInstallStatus);
  // Hand off an initial prompt of ANY size to a terminal session about to be opened: POST the
  // text, get a token, put the token (not the text) in the WS upgrade URL. Names its own vault
  // in the body and validates it there, so it is vault-agnostic at the router level.
  router.post('/api/agent/prompt', handleAgentPromptToken);
  // Image drop → write under the active vault's temp dir (desktop-gated, vault-scoped:
  // NOT vault-agnostic, so it resolves contextRoot from the X-Dreamcontext-Vault header).
  router.post('/api/agent/drop', handleAgentDrop);
  // Auto-title a session from its first user message (Haiku) — vault-scoped, desktop-only.
  router.post('/api/agent/title', handleAgentTitle);
  // Per-vault session roster (titles + layout) so renamed tabs survive a reload
  // (desktop-gated, vault-scoped — same posture as /drop above).
  router.get('/api/agent/sessions', handleAgentSessionsGet);
  router.put('/api/agent/sessions', handleAgentSessionsPut);

  // Vaults + federation connections (issue #25 P2)
  router.get('/api/vaults', handleVaultsGet);
  router.get('/api/connections', handleConnectionsList);
  router.post('/api/connections', handleConnectionsCreate);
  router.delete('/api/connections/:vault', handleConnectionsDelete);

  // Federation inbox (read-only) + sync PREVIEW (dry-run by construction, P3.8).
  router.get('/api/federation/inbox', handleFederationInboxGet);
  router.post('/api/federation/sync', handleFederationSyncPost);

  // Packs
  router.get('/api/packs', handlePacksGet);
  router.post('/api/packs/:name/install', handlePackInstall);
  router.delete('/api/packs/:name', handlePackUninstall);

  // Brain (graph) UI settings — persisted per-project so they survive the
  // desktop app's per-launch loopback port change (which wipes localStorage).
  router.get('/api/brain-settings', handleBrainSettingsGet);
  router.put('/api/brain-settings', handleBrainSettingsPut);

  // Roadmap toolbar preferences (filters/sort/view-type/properties/search) —
  // per-machine, persisted so they survive the same loopback-port localStorage wipe.
  router.get('/api/roadmap-prefs', handleRoadmapPrefsGet);
  router.put('/api/roadmap-prefs', handleRoadmapPrefsPut);

  // Lab (Insights) board preferences (per-group card order + collapsed groups) —
  // per-machine, persisted for the same reason.
  router.get('/api/lab-prefs', handleLabPrefsGet);
  router.put('/api/lab-prefs', handleLabPrefsPut);

  // Roadmap computed model (progress, forecast, member tasks, warnings).
  router.get('/api/roadmap', handleRoadmapModel);

  // Objectives — the PO-authored OKR roadmap write path (list + create + edit).
  router.get('/api/objectives', handleObjectivesList);
  router.post('/api/objectives', handleObjectivesCreate);
  router.patch('/api/objectives/:slug', handleObjectivesUpdate);
  router.delete('/api/objectives/:slug', handleObjectivesDelete);
  router.post('/api/objectives/:slug/dependencies', handleObjectivesAddDependency);
  router.delete('/api/objectives/:slug/dependencies/:to', handleObjectivesRemoveDependency);

  // Lab (analytics insights) — same sync engine the CLI uses. Router.match
  // filters by HTTP METHOD first, so POST /api/lab/sync can never be captured by
  // GET /api/lab/:slug — but GET /api/lab/credentials MUST be registered before
  // GET /api/lab/:slug (first match wins within a method). No route ever
  // returns a credential value — /api/lab/credentials carries key names only.
  router.get('/api/lab', handleLabList);
  router.post('/api/lab/sync', handleLabSync);
  router.get('/api/lab/credentials', handleLabCredentialsGet);
  router.post('/api/lab/credentials', handleLabCredentialsSet);
  router.get('/api/lab/:slug', handleLabShow);
  router.patch('/api/lab/:slug/tweaks', handleLabTweaks);
  router.patch('/api/lab/:slug/binding', handleLabBinding);

  // Theses (proactive learning layer, opt-in via learning.enabled). Read
  // routes (list/show) work regardless of the flag — they surface `enabled`
  // so the dashboard renders the off-state. Sub-resource paths under
  // `/:slug/...` are distinct segment-count SHAPES from the bare `/:slug`
  // routes (Router matches full-pattern regex, not prefix), so registration
  // order between the two groups is not load-bearing — still listed
  // most-specific-first for readability, mirroring the lab/objectives discipline.
  router.get('/api/theses', handleThesesList);
  router.post('/api/theses', handleThesesCreate);
  router.post('/api/theses/:slug/predictions', handleThesesAddPrediction);
  router.post('/api/theses/:slug/evidence', handleThesesAddEvidence);
  router.post('/api/theses/:slug/status', handleThesesSetStatus);
  router.post('/api/theses/:slug/links', handleThesesLink);
  router.delete('/api/theses/:slug/links/:kind/:target', handleThesesUnlink);
  router.post('/api/theses/:slug/changelog', handleThesesChangelog);
  router.post('/api/theses/:slug/promote', handleThesesPromote);
  router.get('/api/theses/:slug', handleThesesShow);
  router.patch('/api/theses/:slug', handleThesesUpdate);
  router.delete('/api/theses/:slug', handleThesesDelete);
  router.post('/api/learning/enable', handleLearningEnable);
  router.post('/api/learning/disable', handleLearningDisable);

  // Tasks-board preferences (saved views) — split persistence:
  //   shared → overrides/board.json (version-controlled, "save for all")
  //   local  → state/board.local.json (git-ignored, "save for yourself")
  router.get('/api/board', handleBoardGet);
  router.put('/api/board/shared', handleBoardSharedPut);
  router.put('/api/board/local', handleBoardLocalPut);

  // Version check
  router.get('/api/version-check', handleVersionCheckGet);

  // Taxonomy
  router.get('/api/taxonomy', handleTaxonomyGet);

  // Changelog / Releases
  router.get('/api/changelog', handleChangelogGet);
  router.get('/api/releases', handleReleasesGet);
  router.get('/api/releases/unreleased', handleUnreleasedGet);
  // Active planning version ("current sprint"). Static `/active` segments must be
  // registered before the `:version` matcher so they are not captured by it.
  router.get('/api/releases/active', handleActiveVersionGet);
  router.put('/api/releases/active', handleActiveVersionSet);
  router.get('/api/releases/:version', handleReleaseGet);
  router.post('/api/releases', handleReleasesCreate);
  router.patch('/api/releases/:version', handleReleasesUpdate);
  router.delete('/api/releases/:version', handleReleasesDelete);

  return router;
}

/** API path prefixes that do NOT need a vault — they work in launcher mode. */
const VAULT_AGNOSTIC_PREFIXES = ['/api/health', '/api/admin/shutdown', '/api/vaults', '/api/launcher', '/api/sleepy', '/api/embeddings', '/api/agent/capabilities', '/api/agent/install', '/api/agent/prompt', '/api/agent/model-config', '/api/agent/session-model', '/api/agent/session-stats', '/api/brain/auth', '/api/brain/team'];

function isVaultAgnostic(pathname: string): boolean {
  return VAULT_AGNOSTIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );
}

/**
 * STRICT per-request vault resolver. Reads the `X-Dreamcontext-Vault` header and
 * resolves it to a context root WITHOUT any filesystem-path fallback.
 *
 * Deliberately does NOT call `resolveVaultContextRoot`, which `resolve()`s an
 * unknown arg as a path — a traversal vector when the value comes off a header.
 * Here only an EXACT registered vault NAME is accepted; anything path-shaped or
 * unknown returns 'INVALID' so the caller can answer 400.
 *
 * - no/empty header  → null  (fall back to the server's pinned contextRoot)
 * - path-shaped name → 'INVALID'
 * - unknown name     → 'INVALID'
 * - registered name  → join(vault.path, '_dream_context')
 */
function resolveRequestVault(req: IncomingMessage): string | null | 'INVALID' {
  const h = req.headers['x-dreamcontext-vault'];
  if (!h || typeof h !== 'string') return null;
  // Reject anything path-shaped or containing null bytes / dots.
  if (/[/\\:.\x00]/.test(h)) return 'INVALID';
  const v = listVaults().find((x) => x.name === h);
  if (!v) return 'INVALID';
  return join(v.path, '_dream_context');
}

function getDashboardDir(): string {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  // In dist: dist/dashboard/ is sibling to dist/index.js
  return resolve(__dirname, 'dashboard');
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${cmd} ${url}`);
}

/**
 * Hosts to print in the tokenized-URL banner for a network-exposed bind.
 * A wildcard bind enumerates the machine's external IPv4 addresses so the
 * printed URLs are actually reachable from another device; a specific bind
 * is shown as-is.
 */
function listNetworkHosts(host: string): string[] {
  if (host !== '0.0.0.0' && host !== '::') return [host];
  const hosts: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) hosts.push(addr.address);
    }
  }
  return hosts.length > 0 ? hosts : [host];
}

export function startDashboardServer(options: ServerOptions): Promise<void> {
  const { port, contextRoot, open, host = '127.0.0.1' } = options;
  const router = buildRouter();
  const dashboardDir = getDashboardDir();

  // Network exposure (--host beyond loopback) is opt-in; when it's on, gate
  // every non-loopback request behind a per-process token so LAN neighbors
  // (shared wifi, offices, cafés) can't reach the unauthenticated API.
  const loopbackBind = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const networkToken = loopbackBind ? null : generateNetworkToken();

  return new Promise((resolvePromise, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (networkToken && !checkNetworkAuth(req, res, networkToken)) return;

        // Handle CORS preflight
        if (handleCors(req, res)) return;

        // CSRF defense: reject state-changing requests from a cross-site origin.
        if (isCrossSiteWrite(req)) {
          sendError(res, 403, 'forbidden', 'Cross-site request blocked.');
          return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const method = req.method || 'GET';

        // API routes
        if (url.pathname.startsWith('/api/')) {
          const match = router.match(method, url.pathname);
          if (match) {
            // Resolve the per-request vault from the strict header resolver.
            const hv = resolveRequestVault(req);
            if (hv === 'INVALID') {
              sendError(res, 400, 'invalid_vault', 'Unknown or invalid vault.');
              return;
            }
            const effRoot = hv ?? contextRoot;
            if (!isVaultAgnostic(url.pathname) && effRoot == null) {
              sendError(res, 400, 'no_vault', 'No vault selected.');
              return;
            }
            // Vault-agnostic routes ignore the context root; cast keeps the
            // handler signature satisfied while the null is harmless there.
            await match.handler(req, res, match.params, effRoot as string);
          } else {
            sendError(res, 404, 'not_found', `No route: ${method} ${url.pathname}`);
          }
          return;
        }

        // Static files (dashboard SPA)
        serveStatic(req, res, dashboardDir);
      } catch (err) {
        // Log the real error server-side; return a generic body so internal
        // paths / exception details never leak to the browser (defense in depth).
        console.error(`[server] unhandled error: ${req.method ?? 'GET'} ${req.url ?? '/'}`, err);
        sendError(res, 500, 'internal_error', 'Internal server error');
      }
    });

    // Agent terminal: bridge a WebSocket to a node-pty running real Claude Code.
    // Self-gates (desktop + loopback + node-pty present); a no-op otherwise.
    attachAgentTerminal(server);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Try --port <number>`));
      } else {
        reject(err);
      }
    });

    server.setTimeout(30000);

    server.listen(port, host, () => {
      const shownHost = host === '127.0.0.1' ? 'localhost' : host;
      const url = `http://${shownHost}:${port}`;
      console.log(`\n  Dashboard: ${url}\n`);
      if (networkToken) {
        console.log(`  WARNING: bound to ${host} — the dashboard is reachable from your network.`);
        console.log('  Other devices must use a tokenized URL (sets a cookie on first visit):');
        for (const lanHost of listNetworkHosts(host)) {
          console.log(`    http://${lanHost}:${port}/?token=${networkToken}`);
        }
        console.log('');
      }
      console.log('  Press Ctrl+C to stop.\n');

      if (open) {
        openBrowser(url);
      }

      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return; // SIGTERM + watchdog can both fire; reap once
        shuttingDown = true;
        console.log('\n  Shutting down...');
        // Reap spawned children (agent-terminal PTYs, etc.) so they don't orphan
        // when this server exits — SIGKILL from the parent would skip this, but a
        // graceful SIGTERM or the parent-death watchdog both route through here.
        killTrackedChildren();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      // Desktop only: don't outlive the Tauri shell. Covers the force-quit / crash
      // / dev-rebuild paths where the shell's Rust exit handler never runs.
      startParentDeathWatch(shutdown);
      // POST /api/admin/shutdown routes here (registered now that shutdown exists).
      registerShutdownHandler(shutdown);
      // Exit when an upgrade replaces the package under this process — a
      // long-lived server must never serve a NEW bundle with an OLD route
      // table ("No route: POST /api/tasks/token"). The next session-start's
      // ensure-dashboard spawns the new version.
      startVersionDriftWatch(dreamcontextVersion(), readDreamcontextVersionFromDisk, (diskVersion) => {
        console.log(`\n  dreamcontext was updated to v${diskVersion} — restarting the dashboard server is required. Exiting; the next session (or \`dreamcontext dashboard\`) starts the new version.`);
        shutdown();
      });
      // Desktop counterpart: the app is excluded from the self-exit above (it would
      // blank a live window with nothing to respawn it), so instead FLAG the on-disk
      // upgrade — GET /api/health surfaces it and the dashboard bundle auto-relaunches
      // the app onto the new version. Self-gates to DREAMCONTEXT_DESKTOP=1.
      startUpgradeReadyWatch(dreamcontextVersion(), readDreamcontextVersionFromDisk);
    });
  });
}
