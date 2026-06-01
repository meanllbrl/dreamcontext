import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson, sendError } from '../middleware.js';
import { safeChildPath } from '../safe-path.js';
import { loadCatalog } from '../../lib/catalog.js';
import {
  installPack,
  uninstallPack,
  UnknownPackError,
} from '../../lib/install-packs.js';
import {
  readManifest,
  writeManifest,
  emptyManifest,
} from '../../lib/manifest.js';
import { readSetupConfig } from '../../lib/setup-config.js';
import { normalizePlatforms, DEFAULT_PLATFORMS, type PlatformId } from '../../lib/platforms.js';

/**
 * Write endpoints for installing/uninstalling skill packs from the dashboard.
 *
 * Imports ONLY pure libs + server middleware — never @inquirer/prompts or chalk
 * (those live in the CLI layer and must stay out of the server bundle). CSRF is
 * enforced globally in index.ts before routing, so there is no per-route check.
 */

interface ValidatedTarget {
  ok: true;
  projectRoot: string;
  platforms: PlatformId[];
}

interface RejectedTarget {
  ok: false;
  status: 400 | 404 | 500;
  code: string;
  message: string;
}

/**
 * Validate a pack name from the URL and resolve install context. Fail-closed
 * ordering: reject malformed names BEFORE touching the catalog or filesystem,
 * then require a loadable catalog, then enforce the catalog allow-list.
 */
function validatePackName(name: string, contextRoot: string): ValidatedTarget | RejectedTarget {
  // 1. Reject traversal / slash / null byte. The fixed '/x' base here is only a
  //    slash/traversal probe (safeChildPath returns null if `name` escapes it),
  //    not a real path used for any read or write.
  if (name.includes('/') || name.includes('\0') || safeChildPath('/x', name) === null) {
    return { ok: false, status: 400, code: 'invalid_name', message: 'Invalid pack name.' };
  }

  // 2. Catalog must be loadable to validate the name and run the op.
  const loaded = loadCatalog();
  if (!loaded) {
    return { ok: false, status: 500, code: 'catalog_unavailable', message: 'Skill catalog is unavailable.' };
  }

  // 3. Allow-list: the name must be a known pack or standalone skill.
  const known =
    loaded.catalog.packs.some((p) => p.name === name) ||
    loaded.catalog.standalone.some((s) => s.name === name);
  if (!known) {
    return { ok: false, status: 404, code: 'unknown_pack', message: `Pack "${name}" not found.` };
  }

  // 4. Resolve project root + platforms (config fallback ['claude']).
  const projectRoot = dirname(contextRoot);
  const config = readSetupConfig(projectRoot);
  const platforms = normalizePlatforms(config?.platforms ?? []);
  const resolved = platforms.length > 0 ? platforms : [...DEFAULT_PLATFORMS];

  return { ok: true, projectRoot, platforms: resolved };
}

/**
 * POST /api/packs/:name/install — install a pack/standalone skill for the
 * configured platforms and record it in the manifest.
 * 200 { name, installed, warnings, platforms }
 */
export async function handlePackInstall(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const name = params.name ?? '';
  const v = validatePackName(name, contextRoot);
  if (!v.ok) {
    sendError(res, v.status, v.code, v.message);
    return;
  }

  try {
    const manifest = readManifest(v.projectRoot) ?? emptyManifest();
    const result = installPack(name, v.projectRoot, v.platforms, manifest);
    writeManifest(v.projectRoot, manifest);
    sendJson(res, 200, {
      name,
      installed: result.installed,
      warnings: result.warnings,
      platforms: v.platforms,
    });
  } catch (err: unknown) {
    if (err instanceof UnknownPackError) {
      sendError(res, 404, 'unknown_pack', `Pack "${name}" not found.`);
      return;
    }
    // Generic 500: log details to stderr, never leak internals to the client.
    console.error(`[packs-install] install failed for "${name}":`, err);
    sendError(res, 500, 'install_failed', 'Failed to install pack.');
  }
}

/**
 * DELETE /api/packs/:name — uninstall a pack/standalone skill for the
 * configured platforms, removing its manifest entry. Idempotent: uninstalling
 * an absent-but-catalog-valid pack returns 200 { removed: [] }.
 * 200 { name, removed, skipped, warnings, platforms }
 */
export async function handlePackUninstall(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const name = params.name ?? '';
  const v = validatePackName(name, contextRoot);
  if (!v.ok) {
    sendError(res, v.status, v.code, v.message);
    return;
  }

  try {
    const manifest = readManifest(v.projectRoot) ?? emptyManifest();
    const result = uninstallPack(name, v.projectRoot, v.platforms, manifest);
    writeManifest(v.projectRoot, manifest);
    sendJson(res, 200, {
      name,
      removed: result.removed,
      skipped: result.skipped,
      warnings: result.warnings,
      platforms: v.platforms,
    });
  } catch (err: unknown) {
    if (err instanceof UnknownPackError) {
      sendError(res, 404, 'unknown_pack', `Pack "${name}" not found.`);
      return;
    }
    console.error(`[packs-install] uninstall failed for "${name}":`, err);
    sendError(res, 500, 'uninstall_failed', 'Failed to uninstall pack.');
  }
}
