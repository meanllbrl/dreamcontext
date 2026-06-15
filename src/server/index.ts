import { createServer, type IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { Router } from './router.js';
import { handleCors, isCrossSiteWrite, sendError } from './middleware.js';
import { serveStatic } from './static.js';
import { handleHealthGet } from './routes/health.js';
import { handleTasksList, handleTasksCreate, handleTasksGet, handleTasksUpdate, handleTasksChangelog, handleTasksInsert, handleTasksSyncStatus, handleTasksSync, handleTasksSyncTest, handleTasksDelete, handleTasksMembers, handleTasksContainers, handleTasksProvision } from './routes/tasks.js';
import { handleSleepGet, handleSleepUpdate } from './routes/sleep.js';
import { handleCoreList, handleCoreGet, handleCoreUpdate } from './routes/core.js';
import { handleKnowledgeList, handleKnowledgeGet, handleKnowledgeUpdate } from './routes/knowledge.js';
import { handleFeaturesList, handleFeaturesGet } from './routes/features.js';
import { handleChangelogGet, handleReleasesGet, handleUnreleasedGet, handleReleaseGet, handleReleasesCreate, handleReleasesUpdate } from './routes/changelog.js';
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
  handleLauncherFederationGraph,
  handleLauncherConnectionCreate,
  handleLauncherConnectionRemove,
  handleLauncherSyncCreate,
  handleLauncherSyncRemove,
  handleLauncherShareable,
  handleSleepyVideo,
  handleSleepyAnim,
  handleSleepyConfigGet,
  handleSleepyConfigSet,
} from './routes/launcher.js';
import { handleBrainSettingsGet, handleBrainSettingsPut } from './routes/ui-settings.js';
import { handleConnectionsList, handleConnectionsCreate, handleConnectionsDelete } from './routes/connections.js';
import { handleFederationInboxGet, handleFederationSyncPost } from './routes/federation.js';
import { handlePacksGet } from './routes/packs.js';
import { handlePackInstall, handlePackUninstall } from './routes/packs-install.js';
import { handleVersionCheckGet } from './routes/version-check.js';
import { handleTaxonomyGet } from './routes/taxonomy.js';
import { listVaults } from '../lib/vaults.js';

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
  router.get('/api/tasks/:slug', handleTasksGet);
  router.delete('/api/tasks/:slug', handleTasksDelete);
  router.patch('/api/tasks/:slug', handleTasksUpdate);
  router.post('/api/tasks/:slug/changelog', handleTasksChangelog);
  router.post('/api/tasks/:slug/insert', handleTasksInsert);

  // Sleep
  router.get('/api/sleep', handleSleepGet);
  router.patch('/api/sleep', handleSleepUpdate);

  // Core
  router.get('/api/core', handleCoreList);
  router.get('/api/core/:filename', handleCoreGet);
  router.put('/api/core/:filename', handleCoreUpdate);

  // Knowledge — `*slug` is a rest param so subdir-qualified slugs work
  // (e.g. data-structures/default, products/lina).
  router.get('/api/knowledge', handleKnowledgeList);
  router.get('/api/knowledge/*slug', handleKnowledgeGet);
  router.patch('/api/knowledge/*slug', handleKnowledgeUpdate);

  // Features
  router.get('/api/features', handleFeaturesList);
  router.get('/api/features/:slug', handleFeaturesGet);

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
  // Launcher project status (green/yellow/red) + per-project update + the
  // cross-vault federation "reads" graph (nodes, edges, connect/disconnect).
  router.get('/api/launcher/status', handleLauncherStatus);
  router.post('/api/launcher/unregister', handleLauncherUnregister);
  router.post('/api/launcher/update', handleLauncherUpdate);
  router.get('/api/launcher/federation-graph', handleLauncherFederationGraph);
  router.post('/api/launcher/connection', handleLauncherConnectionCreate);
  router.post('/api/launcher/connection/remove', handleLauncherConnectionRemove);
  router.post('/api/launcher/sync', handleLauncherSyncCreate);
  router.post('/api/launcher/sync/remove', handleLauncherSyncRemove);
  router.post('/api/launcher/shareable', handleLauncherShareable);
  router.get('/api/sleepy/video', handleSleepyVideo);
  router.get('/api/sleepy/anim', handleSleepyAnim);

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

  // Version check
  router.get('/api/version-check', handleVersionCheckGet);

  // Taxonomy
  router.get('/api/taxonomy', handleTaxonomyGet);

  // Changelog / Releases
  router.get('/api/changelog', handleChangelogGet);
  router.get('/api/releases', handleReleasesGet);
  router.get('/api/releases/unreleased', handleUnreleasedGet);
  router.get('/api/releases/:version', handleReleaseGet);
  router.post('/api/releases', handleReleasesCreate);
  router.patch('/api/releases/:version', handleReleasesUpdate);

  return router;
}

/** API path prefixes that do NOT need a vault — they work in launcher mode. */
const VAULT_AGNOSTIC_PREFIXES = ['/api/health', '/api/vaults', '/api/launcher', '/api/sleepy'];

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

export function startDashboardServer(options: ServerOptions): Promise<void> {
  const { port, contextRoot, open, host = '127.0.0.1' } = options;
  const router = buildRouter();
  const dashboardDir = getDashboardDir();

  return new Promise((resolvePromise, reject) => {
    const server = createServer(async (req, res) => {
      try {
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
        const message = err instanceof Error ? err.message : 'Internal server error';
        sendError(res, 500, 'internal_error', message);
      }
    });

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
      if (host !== '127.0.0.1') {
        console.log(`  WARNING: bound to ${host} — the dashboard API is reachable from your network.\n`);
      }
      console.log('  Press Ctrl+C to stop.\n');

      if (open) {
        openBrowser(url);
      }

      const shutdown = () => {
        console.log('\n  Shutting down...');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  });
}
