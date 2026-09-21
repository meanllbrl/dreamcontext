import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The project's `.mcp.json` — the only MCP scope a TEAM can share.
 *
 * ── Why this is the answer to "my colleague can't reach the MCP servers" ────────────────
 * Measured on CLI 2.1.276: a server defined in the repo's `.mcp.json` is resolved from the
 * working directory, so EVERY account sees it — including a Claude account that had never
 * opened the repo before, which reported it `connected` on its very first run with no
 * approval step (headless `-p`, which is how the Chat surface spawns). Nothing is copied
 * anywhere, no credential is duplicated, and a colleague gets the servers by cloning.
 *
 * The alternatives do not travel. A server in the machine's `~/.claude.json` reaches a
 * sandboxed session only by reference (`--mcp-config`), is invisible to `claude mcp login`,
 * and exists for nobody else. A claude.ai connector belongs to one person's account.
 *
 * ── The rule this file enforces: SECRETS NEVER ENTER THE REPO ───────────────────────────
 * `.mcp.json` is committed. On this product a brain repo is also SYNCED ACROSS A TEAM, so a
 * literal API key written here would be a key published to every teammate and to the remote's
 * history, where deleting it later does not unpublish it. So values under `env` and `headers`
 * are treated as secret by default — they nearly always are — and a literal one is never
 * written: it becomes a `${VAR}` reference, and the caller is told which variables to set.
 * The same applies to a URL carrying a long opaque path segment, which is a bearer token
 * wearing a URL's clothes (this machine has three such servers).
 */

/** One server as the Settings screen lists it. Values are deliberately NOT carried. */
export interface ProjectMcpServer {
  name: string;
  /** `stdio` (a command) or a transport name the file gave (`http`, `sse`). */
  kind: string;
  /** The command or URL, with any secret-looking segment already masked. */
  target: string;
  /** Names only of the `env` keys this server declares. Values are never sent out. */
  envKeys: string[];
  /** Names only of the `headers` keys. Same reason. */
  headerKeys: string[];
  /** Environment variables the definition REFERENCES (`${FOO}`) and that must be set. */
  requires: string[];
}

/** A raw definition as it sits in a config file. Shape is the CLI's, not ours. */
type RawServer = Record<string, unknown>;

const FILE = '.mcp.json';

/** Where the team-shared definitions live for this checkout. */
export function projectMcpPath(projectRoot: string): string {
  return join(projectRoot, FILE);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** `${FOO}` / `${FOO:-default}` — a reference, not a secret. */
const REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}$/;

/** Every `${VAR}` a value mentions, anywhere inside it. */
function referencedVars(value: string): string[] {
  return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
}

/**
 * A URL path segment long enough and random-looking enough to BE the credential.
 *
 * Not a guess about entropy — a deliberate, blunt rule: 24+ characters of unbroken
 * token alphabet in a path is not a route, it is a key. Three servers on the machine this
 * was written for are exactly that shape.
 */
const OPAQUE_SEGMENT = /\/[A-Za-z0-9_-]{24,}(?=\/|$)/g;
/** The same rule without `g`. A global regex's `.test()` carries `lastIndex` between calls,
 *  so the shared constant must never be used for a yes/no question. */
const HAS_OPAQUE_SEGMENT = /\/[A-Za-z0-9_-]{24,}(?=\/|$)/;

/** Mask what must never be displayed or written, while keeping the value recognisable. */
export function maskTarget(target: string): string {
  return target.replace(OPAQUE_SEGMENT, '/••••');
}

/**
 * Is this value safe to write into a committed file?
 *
 * A `${VAR}` reference is. A literal is not — and the answer does not depend on how
 * secret-looking the literal is, because a value the author put under `env` or `headers` is
 * being passed as a credential whether or not it reads like one.
 */
export function isSafeToCommit(value: string): boolean {
  return REFERENCE.test(value.trim());
}

/** Read one raw definition into the shape the Settings screen draws. */
function describe(name: string, raw: RawServer): ProjectMcpServer {
  const env = asRecord(raw.env) ?? {};
  const headers = asRecord(raw.headers) ?? {};
  const url = typeof raw.url === 'string' ? raw.url : '';
  const command = typeof raw.command === 'string' ? raw.command : '';
  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [];
  const target = url || [command, ...args].filter(Boolean).join(' ');
  const requires = new Set<string>();
  for (const value of [...Object.values(env), ...Object.values(headers), url, command, ...args]) {
    if (typeof value === 'string') for (const v of referencedVars(value)) requires.add(v);
  }
  return {
    name,
    kind: typeof raw.type === 'string' ? raw.type : (url ? 'http' : 'stdio'),
    target: maskTarget(target),
    envKeys: Object.keys(env),
    headerKeys: Object.keys(headers),
    requires: [...requires],
  };
}

/** The team-shared servers, as listed. A missing or broken file is an empty list, never a throw. */
export function readProjectMcp(projectRoot: string): ProjectMcpServer[] {
  const path = projectMcpPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    const servers = asRecord(asRecord(JSON.parse(readFileSync(path, 'utf-8')))?.mcpServers);
    if (!servers) return [];
    return Object.entries(servers)
      .map(([name, raw]) => describe(name, asRecord(raw) ?? {}))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Is the file present but unreadable? Distinguished so the UI never silently shows "none". */
export function projectMcpBroken(projectRoot: string): boolean {
  const path = projectMcpPath(projectRoot);
  if (!existsSync(path)) return false;
  try {
    JSON.parse(readFileSync(path, 'utf-8'));
    return false;
  } catch {
    return true;
  }
}

/** The variable name a masked secret becomes: `designer-pack` + `API_KEY` → `DESIGNER_PACK_API_KEY`. */
export function envVarNameFor(server: string, key: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  const prefix = clean(server);
  const suffix = clean(key);
  return suffix.startsWith(prefix) ? suffix : `${prefix}_${suffix}`;
}

/** The result of preparing a machine server for the repo. */
export interface AdoptPlan {
  name: string;
  /** The definition as it will be written — every secret already replaced by a reference. */
  definition: RawServer;
  /** Variables the user must now set for the server to work. Empty when nothing was masked. */
  requires: string[];
  /** True when the URL itself carried the credential and could not be referenced safely. */
  urlCarriedSecret: boolean;
}

/**
 * Rewrite a machine-local definition so it can be committed.
 *
 * Every `env`/`headers` value that is not already a reference becomes one. A URL whose path
 * carries an opaque token is reported — NOT silently rewritten — because splitting a URL into
 * a reference changes what the server is, and the user must decide that.
 */
export function planAdoption(name: string, raw: RawServer): AdoptPlan {
  const definition: RawServer = { ...raw };
  const requires: string[] = [];
  for (const field of ['env', 'headers'] as const) {
    const source = asRecord(raw[field]);
    if (!source) continue;
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      const text = typeof value === 'string' ? value : String(value ?? '');
      if (isSafeToCommit(text)) { next[key] = text.trim(); continue; }
      const variable = envVarNameFor(name, key);
      next[key] = `\${${variable}}`;
      requires.push(variable);
    }
    definition[field] = next;
  }
  const url = typeof raw.url === 'string' ? raw.url : '';
  return { name, definition, requires, urlCarriedSecret: HAS_OPAQUE_SEGMENT.test(url) };
}

/**
 * Write the team-shared file.
 *
 * REFUSES rather than writes when any value would land as a literal secret. The refusal is
 * the feature: this file is committed and, on this product, synced across a team, so a
 * "helpful" write here is a published credential. Atomic (temp + rename) so a crash mid-write
 * cannot leave every teammate with a broken `.mcp.json`.
 */
export function writeProjectMcp(
  projectRoot: string,
  servers: Record<string, RawServer>,
): { ok: true } | { ok: false; unsafe: string[] } {
  const unsafe: string[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    for (const field of ['env', 'headers'] as const) {
      const source = asRecord(raw[field]);
      if (!source) continue;
      for (const [key, value] of Object.entries(source)) {
        const text = typeof value === 'string' ? value : String(value ?? '');
        if (!isSafeToCommit(text)) unsafe.push(`${name}.${field}.${key}`);
      }
    }
  }
  if (unsafe.length) return { ok: false, unsafe };

  const path = projectMcpPath(projectRoot);
  const body = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
  const temp = `${path}.tmp`;
  writeFileSync(temp, body, { encoding: 'utf-8', mode: 0o644 });
  renameSync(temp, path);
  return { ok: true };
}

/** The raw `mcpServers` map currently in the project file, for a read-modify-write. */
export function rawProjectServers(projectRoot: string): Record<string, RawServer> {
  const path = projectMcpPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    const servers = asRecord(asRecord(JSON.parse(readFileSync(path, 'utf-8')))?.mcpServers);
    if (!servers) return {};
    const out: Record<string, RawServer> = {};
    for (const [name, raw] of Object.entries(servers)) out[name] = asRecord(raw) ?? {};
    return out;
  } catch {
    return {};
  }
}

/** The machine's own user-scope definitions — the pool a project can adopt from. */
export function machineMcpServers(home: string = homedir()): Record<string, RawServer> {
  try {
    const parsed = asRecord(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8')));
    const servers = asRecord(parsed?.mcpServers);
    if (!servers) return {};
    const out: Record<string, RawServer> = {};
    for (const [name, raw] of Object.entries(servers)) out[name] = asRecord(raw) ?? {};
    return out;
  } catch {
    return {};
  }
}
