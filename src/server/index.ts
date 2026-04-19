import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { Router } from './router.js';
import { handleCors, sendError } from './middleware.js';
import { serveStatic } from './static.js';
import { handleHealthGet } from './routes/health.js';
import { handleTasksList, handleTasksCreate, handleTasksGet, handleTasksUpdate, handleTasksChangelog, handleTasksInsert } from './routes/tasks.js';
import { handleSleepGet, handleSleepUpdate } from './routes/sleep.js';
import { handleCoreList, handleCoreGet, handleCoreUpdate } from './routes/core.js';
import { handleKnowledgeList, handleKnowledgeGet, handleKnowledgeUpdate } from './routes/knowledge.js';
import { handleFeaturesList, handleFeaturesGet } from './routes/features.js';
import { handleChangelogGet, handleReleasesGet, handleUnreleasedGet, handleReleaseGet, handleReleasesCreate, handleReleasesUpdate } from './routes/changelog.js';
import { handleGraphGet, handleGraphContentGet } from './routes/graph.js';
import { handleCouncilList, handleCouncilGet, handleCouncilResearchGet } from './routes/council.js';

export interface ServerOptions {
  port: number;
  contextRoot: string;
  open: boolean;
}

function buildRouter(): Router {
  const router = new Router();

  // Health
  router.get('/api/health', handleHealthGet);

  // Tasks
  router.get('/api/tasks', handleTasksList);
  router.post('/api/tasks', handleTasksCreate);
  router.get('/api/tasks/:slug', handleTasksGet);
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

  // Knowledge
  router.get('/api/knowledge', handleKnowledgeList);
  router.get('/api/knowledge/:slug', handleKnowledgeGet);
  router.patch('/api/knowledge/:slug', handleKnowledgeUpdate);

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

  // Changelog / Releases
  router.get('/api/changelog', handleChangelogGet);
  router.get('/api/releases', handleReleasesGet);
  router.get('/api/releases/unreleased', handleUnreleasedGet);
  router.get('/api/releases/:version', handleReleaseGet);
  router.post('/api/releases', handleReleasesCreate);
  router.patch('/api/releases/:version', handleReleasesUpdate);

  return router;
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
  const { port, contextRoot, open } = options;
  const router = buildRouter();
  const dashboardDir = getDashboardDir();

  return new Promise((resolvePromise, reject) => {
    const server = createServer(async (req, res) => {
      try {
        // Handle CORS preflight
        if (handleCors(req, res)) return;

        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const method = req.method || 'GET';

        // API routes
        if (url.pathname.startsWith('/api/')) {
          const match = router.match(method, url.pathname);
          if (match) {
            await match.handler(req, res, match.params, contextRoot);
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

    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      console.log(`\n  Dashboard: ${url}\n`);
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
