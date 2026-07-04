import { lazy, type ComponentType } from 'react';

/**
 * Wraps React.lazy so a *stale-chunk* failure self-heals instead of dumping the
 * user into the ErrorBoundary.
 *
 * When the dashboard is rebuilt/republished while a tab is still running the old
 * `index-*.js`, that old code lazy-imports a content-hashed chunk (e.g.
 * `BrainCanvas3D-8hG96aAi.js`) whose hash no longer exists on the server → 404 →
 * "Importing a module script failed". The old bundle can never recover on its own
 * because the file it wants is simply gone.
 *
 * Recovery: on the first such failure, force a full page reload (guarded by a
 * per-chunk sessionStorage flag) so the browser fetches the fresh index.html and
 * the current chunk hashes. If the import still fails after a reload — a genuine
 * error, not a stale hash — we clear the flag and rethrow so the ErrorBoundary
 * surfaces the real problem instead of reload-looping forever.
 */
export function lazyWithReload<T extends ComponentType<any>>(
  key: string,
  factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  const flag = `chunk-reloaded:${key}`;
  return lazy(async () => {
    try {
      const mod = await factory();
      // Success — drop any stale reload flag from a prior recovery.
      window.sessionStorage.removeItem(flag);
      return mod;
    } catch (err) {
      const alreadyReloaded = window.sessionStorage.getItem(flag) === '1';
      if (!alreadyReloaded) {
        window.sessionStorage.setItem(flag, '1');
        window.location.reload();
        // Reload is async; return a never-resolving promise so React shows the
        // Suspense fallback during the ~instant navigation instead of flashing
        // the error boundary.
        return new Promise<{ default: T }>(() => {});
      }
      // Second failure after a fresh reload → this isn't a stale hash. Surface it.
      window.sessionStorage.removeItem(flag);
      throw err;
    }
  });
}
