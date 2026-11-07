/**
 * The project's app tools as THIS Mac sees them (app-araclari plan r3 K1, §3d): the tools of
 * every app installed here (`listApps` → `readManifest`), and the apps the brain's catalog says
 * the project has that are not installed here. Nothing from the catalog is ever callable: a slug
 * installed here wins over its catalog entry, and a catalog entry carries titles only.
 */

import { listApps } from './registry.js';
import { readManifest, effectOf, toolTimeoutSec, type ActionParam, type ToolEffect } from './manifest.js';
import { readCatalog, type CatalogTool } from './catalog.js';
import { sharedWithMe } from './share/shared.js';

export interface InstalledTool {
  id: string;
  title: string;
  effect: ToolEffect;
  usesAgent: boolean;
  method: string;
  does?: string;
  output?: string;
  input?: string;
  params?: Record<string, ActionParam>;
  topics?: string[];
  timeoutSec: number;
}

export interface InstalledApp {
  slug: string;
  name: string;
  tools: InstalledTool[];
}

export interface NotInstalledApp {
  slug: string;
  name: string;
  does: string;
  repo: string;
  /** true / false from a fresh offline snapshot of "Shared with you"; null = not known. */
  sharedWithMe: boolean | null;
  publishedBy: string | null;
  tools: CatalogTool[];
}

export interface ToolList {
  installed: InstalledApp[];
  notInstalled: NotInstalledApp[];
}

export function projectAppTools(home: string, projectRoot: string, contextRoot: string): ToolList {
  const installed: InstalledApp[] = [];
  for (const rec of listApps(home, projectRoot)) {
    const m = readManifest(rec.root);
    if (!m.ok) continue;
    installed.push({
      slug: rec.slug,
      name: m.manifest.name,
      tools: m.manifest.actions.map((a) => ({
        id: a.id, title: a.title, effect: effectOf(a), usesAgent: a.usesAgent === true, method: a.method,
        ...(a.does ? { does: a.does } : {}),
        ...(a.output ? { output: a.output } : {}),
        ...(a.input ? { input: a.input } : {}),
        ...(a.params ? { params: a.params } : {}),
        ...(a.topics ? { topics: a.topics } : {}),
        timeoutSec: toolTimeoutSec(a),
      })),
    });
  }
  const here = new Set(listApps(home, projectRoot).map((r) => r.slug));
  const notInstalled: NotInstalledApp[] = readCatalog(contextRoot)
    .filter((e) => !here.has(e.slug))
    .map((e) => ({ slug: e.slug, name: e.name, does: e.does, repo: e.repo, sharedWithMe: sharedWithMe(home, e.repo), publishedBy: e.publishedBy, tools: e.tools }));
  return { installed, notInstalled };
}
