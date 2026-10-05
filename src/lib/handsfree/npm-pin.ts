/**
 * D25 version parity (AC18): the cloud's build ALWAYS comes from the npm registry, at the
 * laptop's EXACT dreamcontext version. The laptop looks its own version up on the registry and
 * takes `dist.integrity`; that pair is the pin, written to the private repo
 * (`.devcontainer/bootstrap/version.json`, blob-sha checked like every repo file) for the
 * supervisor's first boot, and sent over the bearer channel (`POST runtime`) when the running
 * cloud reports another version. The root supervisor fetches exactly that version and installs
 * it only when the tarball's sha512 equals the pin's integrity.
 *
 * The shapes are pinned here and MIRRORED in cloud/supervisor.mjs (a plain script with no
 * imports); tests/unit/cloud-supervisor.test.ts holds the drift test.
 */

/** The repo path of the pin. */
export const PIN_PATH = '.devcontainer/bootstrap/version.json';

/** Strict semver (no ranges, no tags, no build metadata): one exact published version. */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
/** npm's `dist.integrity` for a sha512: `sha512-` + the 64-byte digest in base64. */
export const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

export const NPM_REGISTRY = 'https://registry.npmjs.org';

export interface VersionPin { version: string; integrity: string }

export function isVersionPin(v: unknown): v is VersionPin {
  const o = v as { version?: unknown; integrity?: unknown } | null;
  return !!o && typeof o === 'object' && typeof o.version === 'string' && SEMVER_RE.test(o.version)
    && typeof o.integrity === 'string' && INTEGRITY_RE.test(o.integrity);
}

/** The pin file's exact bytes (one canonical form, so an unchanged pin is never rewritten). */
export function pinFile(p: VersionPin): Buffer {
  return Buffer.from(JSON.stringify({ version: p.version, integrity: p.integrity }, null, 2) + '\n');
}

export type NpmPinErrorKind = 'not_published' | 'unreachable' | 'bad_answer' | 'bad_version';

export class NpmPinError extends Error {
  constructor(readonly kind: NpmPinErrorKind, message: string) {
    super(message);
    this.name = 'NpmPinError';
  }
}

type FetchImpl = typeof globalThis.fetch;

/**
 * `GET <registry>/dreamcontext/<version>`: the published manifest of exactly that version.
 * 404 = not published; any other failure = the registry could not answer (never a fallback).
 */
export async function registryPin(version: string, fetchImpl: FetchImpl, registry: string = NPM_REGISTRY): Promise<VersionPin> {
  if (!SEMVER_RE.test(version)) throw new NpmPinError('bad_version', `"${version}" is not an exact published version`);
  let res: Response;
  try {
    res = await fetchImpl(`${registry.replace(/\/+$/, '')}/dreamcontext/${encodeURIComponent(version)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new NpmPinError('unreachable', `the npm registry is unreachable (${(err as Error).message})`);
  }
  if (res.status === 404) throw new NpmPinError('not_published', `dreamcontext ${version} is not on npm`);
  if (res.status !== 200) throw new NpmPinError('unreachable', `the npm registry answered ${res.status} for dreamcontext ${version}`);
  let j: { name?: unknown; version?: unknown; dist?: { integrity?: unknown } } | null = null;
  try { j = JSON.parse(await res.text()); } catch { j = null; }
  const pin = { version, integrity: j?.dist?.integrity };
  if (j?.name !== 'dreamcontext' || j.version !== version || !isVersionPin(pin)) {
    throw new NpmPinError('bad_answer', `the npm registry's answer for dreamcontext ${version} has no sha512 integrity`);
  }
  return pin;
}
