import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Which dreamcontext CLI this process is (plan npmsiz-beta C3′). The TS half of
 * `desktop/src-tauri/src/cli_choice.rs`; both answer the vectors in
 * `assets/cli-precedence-vectors.json`, so the shell and the CLI never disagree.
 *
 * Identity comes from realpaths only, never from an inherited variable. The caller resolves the
 * realpaths; these functions only compare strings (backslashes become `/`, win32 compares
 * case-insensitively). Rule: a linked checkout runs as itself; otherwise the app's CLI runs; no
 * version is compared across kinds. Only an npm global re-execs, only with a valid record, and
 * never twice (`DREAMCONTEXT_REEXEC=1`, consumed at start).
 */

export type CliKind = 'app-copy' | 'app-bundle' | 'npm-global' | 'linked-checkout' | 'not-install';

/** `~/.dreamcontext/app-cli.json` (C2′). `appPath` is informational; nothing runs from it. */
export interface AppCliRecord {
  version: string;
  node: string;
  entry: string;
  appPath?: string;
}

export interface CliFacts {
  windows: boolean;
  home: string;
  entry: string;
  exec: string;
  /** `name` in the package.json two levels above the entry, when one exists. */
  pkgName: string | null;
  record: AppCliRecord | null;
  /** Windows: our uninstall key's `InstallLocation` (no default-folder fallback). */
  installLocation: string | null;
}

function norm(p: string, windows: boolean): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return windows ? s.toLowerCase() : s;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

const MAC_BUNDLE_NODE = '/Contents/Resources/runtime/bin/node';
const MAC_BUNDLE_ENTRY = '/Contents/Resources/dist/index.js';

/**
 * A record is valid when its version is plain X.Y.Z and both paths sit in `bin/rt/<version>/`,
 * or (Mac) both name ONE lasting `.app` bundle: `<A>.app/Contents/Resources/runtime/bin/node` and
 * `<A>.app/Contents/Resources/dist/index.js`, absolute, never on a DMG or a translocated copy.
 */
export function recordValid(rec: AppCliRecord, home: string, windows: boolean): boolean {
  if (!SEMVER.test(rec.version)) return false;
  // A `.` or `..` segment could climb out of bin/rt while still starting with it.
  const dotted = (p: string) => p.replace(/\\/g, '/').split('/').some((seg) => seg === '..' || seg === '.');
  if (dotted(rec.node) || dotted(rec.entry)) return false;
  if (!windows && rec.node.endsWith(MAC_BUNDLE_NODE)) {
    const app = rec.node.slice(0, -MAC_BUNDLE_NODE.length);
    return app.startsWith('/') && app.endsWith('.app') && !app.includes('\\')
      && rec.entry === `${app}${MAC_BUNDLE_ENTRY}`
      && !app.startsWith('/Volumes/') && !app.includes('/AppTranslocation/');
  }
  const version = windows ? rec.version.toLowerCase() : rec.version;
  const dir = `${norm(home, windows)}/.dreamcontext/bin/rt/${version}/`;
  return norm(rec.node, windows).startsWith(dir) && norm(rec.entry, windows).startsWith(dir);
}

export function classifyCli(f: CliFacts): CliKind {
  const w = f.windows;
  const entry = norm(f.entry, w);
  const exec = norm(f.exec, w);
  const bin = `${norm(f.home, w)}/.dreamcontext/bin/`;
  if (entry.startsWith(bin)) {
    const r = f.record;
    return r && recordValid(r, f.home, w) && norm(r.entry, w) === entry && norm(r.node, w) === exec
      ? 'app-copy'
      : 'not-install';
  }
  // Mac: <X>.app/Contents/Resources/dist/index.js run by that same bundle's runtime node.
  const suffix = w ? '/contents/resources/dist/index.js' : '/Contents/Resources/dist/index.js';
  if (entry.endsWith(suffix)) {
    const app = entry.slice(0, -suffix.length);
    if (app.endsWith('.app')) {
      const node = w ? `${app}/contents/resources/runtime/bin/node` : `${app}/Contents/Resources/runtime/bin/node`;
      return exec === node ? 'app-bundle' : 'not-install';
    }
  }
  if (entry.includes('.app/')) return 'not-install';
  // Windows: <InstallLocation>/dist/index.js run by <InstallLocation>/runtime/node.exe.
  if (f.installLocation) {
    const il = norm(f.installLocation, w);
    if (entry.startsWith(`${il}/`)) {
      return entry === `${il}/dist/index.js` && exec === `${il}/runtime/node.exe` ? 'app-bundle' : 'not-install';
    }
  }
  if (entry.endsWith('/lib/node_modules/dreamcontext/dist/index.js')
    || (w && entry.endsWith('/npm/node_modules/dreamcontext/dist/index.js'))) {
    return 'npm-global';
  }
  if (entry.endsWith('/dist/index.js') && !entry.includes('/node_modules/') && f.pkgName === 'dreamcontext') {
    return 'linked-checkout';
  }
  return 'not-install';
}

/** Does this process hand over to the app copy? Only an npm global, with a valid record, once. */
export function shouldReexec(kind: CliKind, recordIsValid: boolean, reexecFlag: boolean): boolean {
  return kind === 'npm-global' && recordIsValid && !reexecFlag;
}

export function appCliRecordPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'app-cli.json');
}

/**
 * Read the C2′ record, schema-checked: a plain file in a plain `~/.dreamcontext`, exactly the keys
 * `version`, `node`, `entry` (and an optional `appPath`), all strings, and valid by
 * {@link recordValid}. Anything else is absent (null), never an error.
 */
export function readAppCliRecord(home: string = homedir(), windows: boolean = process.platform === 'win32'): AppCliRecord | null {
  try {
    const dir = lstatSync(join(home, '.dreamcontext'));
    if (dir.isSymbolicLink() || !dir.isDirectory()) return null;
    const file = appCliRecordPath(home);
    if (!lstatSync(file).isFile()) return null;
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const allowed = new Set(['version', 'node', 'entry', 'appPath']);
    if (Object.keys(o).some((k) => !allowed.has(k))) return null;
    if (typeof o.version !== 'string' || typeof o.node !== 'string' || typeof o.entry !== 'string') return null;
    if (o.appPath !== undefined && typeof o.appPath !== 'string') return null;
    const rec: AppCliRecord = { version: o.version, node: o.node, entry: o.entry, ...(o.appPath !== undefined ? { appPath: o.appPath as string } : {}) };
    return recordValid(rec, home, windows) ? rec : null;
  } catch {
    return null;
  }
}
