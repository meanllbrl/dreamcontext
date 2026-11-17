/**
 * The hackathon's ONE secrets inventory (plan C4b). Every secret claim the hackathon makes comes
 * from here and nowhere else:
 *
 *  - what a team cannot read        → {@link teamReadDenies}
 *  - what a team process inherits   → {@link teamEnv}
 *  - what the `pr` scan looks for   → {@link knownSecretValues}
 *
 * Each deny source maps to a value reader or is marked "not scannable" in {@link DENY_SOURCES};
 * `hackathon-secrets.test.ts` fails when a source has neither (the drift test).
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_ANYWHERE, CREDENTIAL_HOME_DIRS, CREDENTIAL_HOME_FILES, absRule, credentialReadDenies } from '../automations/board-scope.js';
import { APP_CREDENTIAL_FILES } from '../apps/assistant.js';
import { readCredentials } from '../lab/credentials.js';
import { parseEnv } from '../marketing/env-loader.js';
import { RECALL_KEY_ENV, recallCloudConfigPath } from '../recall-cloud-config.js';

/** Values shorter than this would match ordinary text in a diff. */
export const MIN_SECRET_CHARS = 8;

/** Home-relative folders and files the hackathon adds to the board's credential list. */
export const HACKATHON_HOME_DENIES = ['.codex', '.dreamcontext/claude-accounts', '.dreamcontext/codex-accounts', '.dreamcontext/telegram'] as const;
export const HACKATHON_HOME_FILE_DENIES = ['.dreamcontext/.secrets.json', '.dreamcontext/mcp.json', '.dreamcontext/voice.json', '.dreamcontext/recall-cloud.json'] as const;

export type DenySource =
  | { pattern: string; reader: string }
  | { pattern: string; notScannable: string };

/**
 * Every deny pattern, with the reader in {@link knownSecretValues} that scans its values or the
 * reason it cannot be scanned (key files are matched by path in the PR scan instead).
 */
export const DENY_SOURCES: readonly DenySource[] = [
  { pattern: '**/.env*', reader: 'envFiles' },
  { pattern: '**/*.pem', notScannable: 'a key file: matched by path, a changed one refuses the PR' },
  { pattern: '**/*.key', notScannable: 'a key file: matched by path, a changed one refuses the PR' },
  { pattern: '**/id_rsa*', notScannable: 'a key file: matched by path, a changed one refuses the PR' },
  { pattern: '**/id_ed25519*', notScannable: 'a key file: matched by path, a changed one refuses the PR' },
  { pattern: '**/.secrets.json', reader: 'secretsJson' },
  { pattern: '**/lab/credentials.json', reader: 'labCredentials' },
  { pattern: '**/.mcp.json', reader: 'mcpJson' },
  { pattern: '.ssh', notScannable: 'SSH keys: matched by path' },
  { pattern: '.aws', reader: 'iniValues' },
  { pattern: '.config/gh', reader: 'ghToken' },
  { pattern: '.config/gcloud', notScannable: 'gcloud keeps a database, not text' },
  { pattern: '.docker', reader: 'jsonValues' },
  { pattern: '.kube', notScannable: 'kube certificates: matched by path' },
  { pattern: '.gnupg', notScannable: 'GPG keyring is binary' },
  { pattern: '.azure', notScannable: 'Azure keeps an encrypted token cache' },
  { pattern: '.claude', reader: 'claudeCredentials' },
  { pattern: '.dreamcontext', reader: 'secretsJson' },
  { pattern: '.claude.json', reader: 'jsonValues' },
  { pattern: '.npmrc', reader: 'npmToken' },
  { pattern: '.netrc', reader: 'netrc' },
  { pattern: '.git-credentials', reader: 'gitCredentials' },
  { pattern: '.pypirc', reader: 'iniValues' },
  { pattern: '.codex', reader: 'codexAuth' },
  { pattern: '.dreamcontext/claude-accounts', reader: 'claudeAccounts' },
  { pattern: '.dreamcontext/codex-accounts', reader: 'jsonValues' },
  { pattern: '.dreamcontext/telegram', reader: 'jsonValues' },
  { pattern: '.dreamcontext/.secrets.json', reader: 'secretsJson' },
  { pattern: '.dreamcontext/mcp.json', reader: 'mcpJson' },
  { pattern: '.dreamcontext/voice.json', reader: 'jsonValues' },
  { pattern: '.dreamcontext/recall-cloud.json', reader: 'recallKey' },
  { pattern: '.dreamcontext/release-signing', notScannable: 'signing keys on purpose: matched by path' },
  // Not a path: the W1 proof found sandboxed Bash can reach the login Keychain.
  { pattern: 'keychain:Claude Code-credentials', reader: 'keychainToken' },
];

/** The patterns the inventory denies, as written in {@link DENY_SOURCES}'s source lists. */
export function denyPatterns(): string[] {
  return [
    ...CREDENTIAL_ANYWHERE, ...APP_CREDENTIAL_FILES,
    ...CREDENTIAL_HOME_DIRS, ...CREDENTIAL_HOME_FILES,
    ...HACKATHON_HOME_DENIES, ...HACKATHON_HOME_FILE_DENIES, '.dreamcontext/release-signing',
  ];
}

/**
 * A team's Read denies: the board's credential folders, every credential glob root-anchored
 * (`Read(//…)`, so it holds outside the cwd), the hackathon's own additions, and `extra` (the
 * other teams' workspaces, brain team folders and `.conductor/`, given by the caller).
 */
export function teamReadDenies(home: string = homedir(), extra: readonly string[] = []): string[] {
  return [
    ...credentialReadDenies(home),
    ...[...CREDENTIAL_ANYWHERE, ...APP_CREDENTIAL_FILES].map((g) => `Read(//${g})`),
    ...HACKATHON_HOME_DENIES.map((d) => absRule('Read', join(home, d))),
    ...HACKATHON_HOME_FILE_DENIES.map((f) => absRule('Read', join(home, f), '')),
    absRule('Read', join(home, '.dreamcontext', 'release-signing')),
    ...extra.map((p) => absRule('Read', p)),
  ];
}

/** The only variables of the owner's environment a team process inherits. */
export const TEAM_ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER', 'SHELL'] as const;
/** The tool's own auth variable, named literally per tool. */
export const TEAM_AUTH_ENV: Readonly<Record<'claude' | 'codex', readonly string[]>> = {
  claude: ['CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
};

export function teamEnv(base: NodeJS.ProcessEnv, tool: 'claude' | 'codex' = 'claude'): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of [...TEAM_ENV_ALLOW, ...TEAM_AUTH_ENV[tool]]) {
    const v = base[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// ─── Value readers (the PR scan) ────────────────────────────────────────────

function readText(p: string, max = 1_000_000): string | null {
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/** Every string leaf of a JSON document. */
function jsonStrings(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => walk(x, depth + 1));
  };
  walk(parsed, 0);
  return out;
}

function iniValues(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split('\n').map((l) => /^\s*[^#;\s][^=]*=\s*(.+?)\s*$/.exec(l)?.[1] ?? '').filter(Boolean);
}

function envFileValues(dir: string, depth = 2): string[] {
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = join(dir, name);
    if (name.startsWith('.env')) {
      const raw = readText(p);
      if (raw) out.push(...Object.values(parseEnv(raw).values ?? {}).map(String));
      continue;
    }
    if (depth > 0 && !name.startsWith('.') && name !== 'node_modules') {
      try { if (lstatSync(p).isDirectory()) out.push(...envFileValues(p, depth - 1)); } catch { /* gone */ }
    }
  }
  return out;
}

function filesUnder(dir: string, depth = 3): string[] {
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isFile()) out.push(p);
      else if (st.isDirectory() && depth > 0) out.push(...filesUnder(p, depth - 1));
    } catch { /* gone */ }
  }
  return out;
}

function defaultKeychainToken(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export interface SecretSources {
  /** The brain's `_dream_context`. */
  contextRoot: string;
  /** The brain's project root and each linked repo's root. */
  repoRoots: readonly string[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** `gh auth token`, injectable for tests; null skips it. */
  ghToken?: () => string | null;
  /** The Claude Code Keychain item, injectable for tests; null skips it. */
  keychainToken?: () => string | null;
}

/** The named readers {@link DENY_SOURCES} points at. */
export function secretReaders(s: SecretSources): Record<string, () => string[]> {
  const home = s.home ?? homedir();
  const dc = join(home, '.dreamcontext');
  const ctxRoots = [s.contextRoot, ...s.repoRoots.map((r) => join(r, '_dream_context'))];
  return {
    envFiles: () => [...s.repoRoots, s.contextRoot].flatMap((r) => envFileValues(r)),
    secretsJson: () => [
      join(dc, '.secrets.json'),
      ...ctxRoots.flatMap((c) => [join(c, 'state', '.secrets.json'), join(c, '.secrets.json')]),
    ].flatMap((p) => jsonStrings(readText(p))),
    labCredentials: () => ctxRoots.flatMap((c) => Object.values(readCredentials(c))),
    mcpJson: () => [join(dc, 'mcp.json'), ...s.repoRoots.map((r) => join(r, '.mcp.json'))].flatMap((p) => jsonStrings(readText(p))),
    iniValues: () => [join(home, '.aws', 'credentials'), join(home, '.pypirc')].flatMap((p) => iniValues(readText(p))),
    ghToken: () => {
      const t = (s.ghToken ?? defaultGhToken)();
      return t ? [t] : [];
    },
    jsonValues: () => [
      join(home, '.docker', 'config.json'), join(home, '.claude.json'), join(dc, 'voice.json'),
      ...filesUnder(join(dc, 'codex-accounts')), ...filesUnder(join(dc, 'telegram')),
    ].filter((p) => p.endsWith('.json')).flatMap((p) => jsonStrings(readText(p))),
    npmToken: () => (readText(join(home, '.npmrc')) ?? '').split('\n')
      .map((l) => /_authToken\s*=\s*(\S+)/.exec(l)?.[1] ?? '').filter(Boolean),
    netrc: () => (readText(join(home, '.netrc')) ?? '').split(/\s+/).flatMap((w, i, all) => (w === 'password' && all[i + 1] ? [all[i + 1]!] : [])),
    gitCredentials: () => (readText(join(home, '.git-credentials')) ?? '').split('\n')
      .map((l) => /^[a-z]+:\/\/[^:]*:([^@]+)@/.exec(l.trim())?.[1] ?? '').filter(Boolean),
    codexAuth: () => jsonStrings(readText(join(home, '.codex', 'auth.json'))),
    claudeAccounts: () => filesUnder(join(dc, 'claude-accounts'), 2)
      .filter((p) => /\.(json|credentials)$/.test(p) || p.endsWith('.credentials.json'))
      .flatMap((p) => jsonStrings(readText(p))),
    keychainToken: () => {
      const raw = (s.keychainToken ?? defaultKeychainToken)();
      if (!raw) return [];
      return raw.trim().startsWith('{') ? jsonStrings(raw) : [raw];
    },
    claudeCredentials: () => jsonStrings(readText(join(home, '.claude', '.credentials.json'))),
    recallKey: () => {
      const env = (s.env ?? process.env)[RECALL_KEY_ENV];
      return [...jsonStrings(readText(recallCloudConfigPath(home))), ...(env ? [env] : [])];
    },
  };
}

function defaultGhToken(): string | null {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Every literal secret value the inventory can read, ≥ {@link MIN_SECRET_CHARS} long, deduped.
 * Readers that fail return nothing; the PR card says the scan is best-effort.
 */
export function knownSecretValues(s: SecretSources): string[] {
  const readers = secretReaders(s);
  const seen = new Set<string>();
  for (const src of DENY_SOURCES) {
    if (!('reader' in src)) continue;
    const read = readers[src.reader];
    if (!read) continue;
    for (const v of read()) {
      const t = typeof v === 'string' ? v.trim() : '';
      // A plain word or a path is not a secret: only values with no whitespace and a digit or
      // symbol mix count, so a JSON label ("enabled") never refuses a PR.
      if (t.length >= MIN_SECRET_CHARS && !/\s/.test(t) && /[0-9_\-+/=]/.test(t) && !t.startsWith('/')) seen.add(t);
    }
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/** True when `p` names a file the inventory matches by path (key files): the PR refuses it. */
export function isKeyFilePath(p: string): boolean {
  const base = p.split('/').pop() ?? p;
  return /\.(pem|key)$/.test(base) || /^id_(rsa|ed25519)/.test(base) || base.startsWith('.env');
}

