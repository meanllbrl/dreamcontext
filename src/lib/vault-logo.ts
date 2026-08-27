import { statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A vault's visual identity mark — one image file, by convention, at
 * `_dream_context/assets/logo.<ext>`.
 *
 * A FILE convention rather than a config key, deliberately: the logo is an asset,
 * and an asset that lives next to a config pointer can drift from it (renamed file,
 * stale path) in a way a fixed well-known location cannot. Dropping `logo.png` into
 * `assets/` IS the whole setup — no command, no key, nothing to validate.
 *
 * Read on demand and never cached here: the peers list is fetched once per pane and
 * the logo route is hit by the browser's own image cache, so the disk stat per
 * request is already the cheap path.
 */

const LOGO_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

/** Candidate order is preference order: raster first (renders identically everywhere),
 *  `png` first among rasters because that is what "drop a logo in" almost always is. */
const LOGO_NAMES = ['logo.png', 'logo.jpg', 'logo.jpeg', 'logo.webp', 'logo.svg'];

export interface VaultLogo {
  /** Absolute path to the image file. */
  path: string;
  mime: string;
  /** Last-modified stamp, for cache-busting the image URL after a replace. */
  mtimeMs: number;
}

/** Every candidate filename, for callers that REPLACE the logo and must clear the
 *  losers first (a stale `logo.png` would shadow a freshly written `logo.webp`). */
export function vaultLogoCandidates(contextRoot: string): string[] {
  return LOGO_NAMES.map((name) => join(contextRoot, 'assets', name));
}

/** The vault's logo file, or `null` when it has none. Never throws. */
export function findVaultLogo(contextRoot: string): VaultLogo | null {
  for (const name of LOGO_NAMES) {
    const path = join(contextRoot, 'assets', name);
    try {
      const st = statSync(path, { throwIfNoEntry: false });
      if (st?.isFile()) {
        const ext = name.split('.').pop() ?? '';
        return { path, mime: LOGO_MIMES[ext] ?? 'application/octet-stream', mtimeMs: st.mtimeMs };
      }
    } catch {
      // A permission error on one candidate must not hide the others.
    }
  }
  return null;
}
