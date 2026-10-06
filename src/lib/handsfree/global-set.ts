/**
 * The one-way global set (Go step 6; laptop -> cloud, never returned): the agent's own
 * Claude setup and dreamcontext's machine-local registries, staged into a scratch dir laid
 * out relative to HOME and packed like any root. No credential ever enters it: settings.json
 * loses `env`, `~/.claude.json` is rebuilt by `buildSeedConfig` plus the non-credential
 * identity fields of `oauthAccount`, and the generated `~/.gitconfig` carries no helpers.
 */
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildSeedConfig } from '../claude-account-sandbox.js';
import { slugify } from '../id.js';
import { git, type ProcessRunner } from './git-snapshot.js';

const OAUTH_IDENTITY_KEYS = ['accountUuid', 'emailAddress', 'organizationUuid', 'organizationName', 'displayName', 'organizationRole', 'workspaceRole'];
const DREAM_FILES = ['agent-ui.json', 'claude-accounts.json', 'vaults.json', 'linked-repos.json'];
const CLAUDE_DIRS = ['skills', 'agents', 'commands'];

function put(staging: string, rel: string, data: string | Buffer): void {
  const abs = join(staging, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data, { mode: 0o600 });
}

function isRealFile(p: string): boolean {
  try { return lstatSync(p).isFile(); } catch { return false; }
}

export async function stageGlobalSet(o: { home: string; staging: string; run: ProcessRunner }): Promise<void> {
  const { home, staging } = o;
  mkdirSync(staging, { recursive: true });
  const claude = join(home, '.claude');
  if (isRealFile(join(claude, 'CLAUDE.md'))) copyFileSync(join(claude, 'CLAUDE.md'), join(mkdirP(staging, '.claude'), 'CLAUDE.md'));
  if (isRealFile(join(claude, 'settings.json'))) {
    try {
      const s = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')) as Record<string, unknown>;
      delete s.env;
      delete s.apiKeyHelper;
      delete s.awsAuthRefresh;
      delete s.awsCredentialExport;
      put(staging, '.claude/settings.json', JSON.stringify(s, null, 2) + '\n');
    } catch { /* unreadable settings stay home */ }
  }
  for (const d of CLAUDE_DIRS) {
    const src = join(claude, d);
    try {
      if (lstatSync(src).isDirectory()) cpSync(src, join(staging, '.claude', d), { recursive: true, verbatimSymlinks: true });
    } catch { /* absent */ }
  }
  if (isRealFile(join(home, '.claude.json'))) {
    try {
      const real = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as Record<string, unknown>;
      const seed = buildSeedConfig(real);
      const oa = real.oauthAccount;
      if (oa && typeof oa === 'object') {
        const id: Record<string, unknown> = {};
        for (const k of OAUTH_IDENTITY_KEYS) if ((oa as Record<string, unknown>)[k] !== undefined) id[k] = (oa as Record<string, unknown>)[k];
        seed.oauthAccount = id;
      }
      put(staging, '.claude.json', JSON.stringify(seed, null, 2) + '\n');
    } catch { /* unreadable */ }
  }
  for (const f of DREAM_FILES) {
    const src = join(home, '.dreamcontext', f);
    if (isRealFile(src)) copyFileSync(src, join(mkdirP(staging, '.dreamcontext'), f));
  }
  // A generated ~/.gitconfig: identity, pull.rebase and a copy of the global excludes file.
  const get = async (key: string) => {
    const r = await git(o.run, home, ['config', '--global', '--get', key], { allowFail: true });
    return r.code === 0 ? r.stdout.toString().trim() : '';
  };
  const lines: string[] = [];
  const name = await get('user.name');
  const email = await get('user.email');
  if (name || email) lines.push('[user]', ...(name ? [`\tname = ${name.replace(/[\n"\\]/g, '')}`] : []), ...(email ? [`\temail = ${email.replace(/[\n"\\]/g, '')}`] : []));
  const rebase = await get('pull.rebase');
  if (/^(true|false|merges|interactive)$/.test(rebase)) lines.push('[pull]', `\trebase = ${rebase}`);
  const excludes = (await get('core.excludesFile')).replace(/^~(?=\/)/, home);
  if (excludes && isRealFile(excludes)) {
    put(staging, '.config/git/ignore', readFileSync(excludes));
    lines.push('[core]', '\texcludesFile = ~/.config/git/ignore');
  }
  if (lines.length) put(staging, '.gitconfig', lines.join('\n') + '\n');
}

function mkdirP(staging: string, rel: string): string {
  const p = join(staging, rel);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

/**
 * AC3: the registry name a trip's project gets when it was never registered (a CLI go), exactly
 * as `dreamcontext vaults scan` names one: `slugify(basename) || 'vault'`. The SPA sends the
 * name in the `X-Dreamcontext-Vault` header on every call, and a browser refuses a header value
 * above U+00FF, so the name is folded to ASCII (`Tilki Öğretmen` -> `tilki-ogretmen`), which
 * also keeps it clear of every character the strict `?vault=` resolver refuses. Laptop and
 * cloud call this same function, so the same path gets the same name on both. An entry already
 * registered keeps its own name (callers check the path first).
 */
export function vaultNameForPath(absPath: string): string {
  return slugify(absPath.split(/[\\/]/).filter(Boolean).pop() ?? '') || 'vault';
}

/**
 * The trip's project in a vault registry document (`{ vaults: [...] }`): added under a free
 * name (`name`, `name-2`, ...) when no entry already points at `absPath`. Returns the changed
 * document, or null when it is already registered. Pure: the caller reads and writes the file.
 */
export function withTripVault(doc: unknown, absPath: string, same: (a: string, b: string) => boolean): { vaults: Array<Record<string, unknown>> } | null {
  const reg = doc && typeof doc === 'object' && Array.isArray((doc as { vaults?: unknown }).vaults)
    ? doc as { vaults: Array<Record<string, unknown>> }
    : { vaults: [] as Array<Record<string, unknown>> };
  const entries = reg.vaults.filter((v) => v && typeof v === 'object');
  if (entries.some((v) => typeof v.path === 'string' && same(v.path, absPath))) return null;
  const taken = new Set(entries.map((v) => v.name).filter((n): n is string => typeof n === 'string'));
  const base = vaultNameForPath(absPath);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return { ...reg, vaults: [...reg.vaults, { name, path: absPath }] };
}

