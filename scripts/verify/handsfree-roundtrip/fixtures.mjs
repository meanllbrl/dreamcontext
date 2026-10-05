/**
 * Fictional fixture repos and vault for the hands-free round trip (pattern: synthetic
 * fixtures for published artifacts — acme-* / atlas-* / field-notes, kerem@example.com).
 *
 *   ~/projects/acme-storefront   the vault (git): case 1 strict equality, 2, 4, 7, 13, 14
 *   ~/projects/acme-payments     linked repo: case 9 divergence (laptop moves a ref)
 *   ~/projects/atlas-mobile      linked repo: case 9 per-path conflict, case 5 collisions
 *   ~/projects/field-notes       linked repo, UNBORN (no commit yet)
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, CLOUD, GITCONFIG, HFRT_CONFIG, LH, PKG, REPO, SCRATCH, git, put } from './lib.mjs';

export const VAULT = join(LH, 'projects', 'acme-storefront');
export const PAY = join(LH, 'projects', 'acme-payments');
export const ATLAS = join(LH, 'projects', 'atlas-mobile');
export const NOTES = join(LH, 'projects', 'field-notes');
export const CTX = join(VAULT, '_dream_context');
export const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
export const PROJECTS = join(LH, '.claude', 'projects');
export const VAULT_TRANSCRIPTS = join(PROJECTS, enc(VAULT));

export const SPAWN_LOG = join(SCRATCH, 'cloud', 'claude-spawns.jsonl');
export const S1 = '11111111-1111-4111-8111-111111111111';
export const NFD = 'notes/café.md';
export const NFC = 'notes/café.md';

export function freezePackage() {
  mkdirSync(PKG, { recursive: true });
  for (const d of ['dist', 'cloud']) cpSync(join(REPO, d), join(PKG, d), { recursive: true, verbatimSymlinks: true });
  cpSync(join(REPO, 'package.json'), join(PKG, 'package.json'));
  symlinkSync(join(REPO, 'node_modules'), join(PKG, 'node_modules'));
}

export function buildFixtures(port) {
  mkdirSync(join(LH, '.dreamcontext'), { recursive: true });
  for (const d of Object.values(CLOUD)) if (!/\.(log|pid)$/.test(d)) mkdirSync(d, { recursive: true });
  writeFileSync(GITCONFIG, '[user]\n\tname = Kerem Cinar\n\temail = kerem@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[core]\n\tquotePath = false\n');
  writeFileSync(HFRT_CONFIG, JSON.stringify({
    repo: REPO, pkg: PKG, cli: CLI, laptopHome: LH, gitConfig: GITCONFIG, scratch: SCRATCH, cloud: { port, ...CLOUD },
  }, null, 2));
  const stub = join(CLOUD.stubBin, 'claude');
  writeFileSync(stub, readFileSync(join(REPO, 'scripts', 'verify', 'handsfree-roundtrip', 'stub-claude.cjs'), 'utf8')
    .replace('__MIRROR__', CLOUD.mirror).replace('__SPAWN_LOG__', SPAWN_LOG));
  chmodSync(stub, 0o755);

  // ── acme-storefront: the vault ───────────────────────────────────────────────────
  mkdirSync(VAULT, { recursive: true });
  git(VAULT, ['init', '-q']);
  put(VAULT, '.gitignore', [
    '_dream_context/state/', '_dream_context/marketing/', '_dream_context/tmp/', '_dream_context/lab/credentials.json',
    '.env', '.claude/settings.local.json', 'node_modules/',
    // What the laptop's own roster/map writers add on first use (a vault that chatted here).
    '_dream_context/state/.agent-sessions.json', '_dream_context/state/.agent-session-map/', '',
  ].join('\n'));
  put(VAULT, '_dream_context/core/0.soul.md', '# acme-storefront\nThe storefront of a fictional shop.\n');
  put(VAULT, 'src/cart.ts', 'export const cart = [];\n');
  put(VAULT, 'src/checkout.ts', 'export function checkout() { return 1; }\n');
  put(VAULT, 'README.md', '# acme-storefront\n');
  put(VAULT, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }, null, 2) + '\n');
  put(VAULT, '.mcp.json', JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
  put(VAULT, '.husky/pre-commit', '#!/bin/sh\nnpm test\n', 0o755);
  git(VAULT, ['add', '-A']);
  git(VAULT, ['commit', '-qm', 'storefront: first']);
  git(VAULT, ['tag', 'v1.0']);
  git(VAULT, ['notes', 'add', '-m', 'release note for v1.0', 'HEAD']);
  git(VAULT, ['branch', 'feature/coupon']);
  put(VAULT, 'src/cart.ts', 'export const cart = [1];\n');
  git(VAULT, ['commit', '-qam', 'storefront: cart has one item']);
  // Two stash entries with distinct messages (multi-stash, sha + message equality).
  put(VAULT, 'src/checkout.ts', 'export function checkout() { return 2; }\n');
  git(VAULT, ['stash', 'push', '-q', '-m', 'wip: checkout returns two']);
  put(VAULT, 'README.md', '# acme-storefront\n\nStashed readme line.\n');
  git(VAULT, ['stash', 'push', '-q', '-m', 'wip: readme line']);
  // Staged, unstaged, untracked.
  put(VAULT, 'src/cart.ts', 'export const cart = [1, 2];\n');
  git(VAULT, ['add', 'src/cart.ts']);
  put(VAULT, 'src/checkout.ts', 'export function checkout() { return 3; }\n');
  put(VAULT, 'src/untracked-draft.ts', 'export const draft = true;\n');
  // Non-git (Transport 2) state.
  put(VAULT, '_dream_context/state/.config.json', JSON.stringify({
    platforms: ['claude'], packs: [],
    linkedRepos: [
      { name: 'acme-payments', gitRemoteUrl: 'https://github.com/acme-co/acme-payments' },
      { name: 'atlas-mobile', gitRemoteUrl: 'https://github.com/acme-co/atlas-mobile' },
      { name: 'field-notes', gitRemoteUrl: 'https://github.com/acme-co/field-notes' },
    ],
  }, null, 2) + '\n');
  put(VAULT, '_dream_context/state/rework-the-checkout-flow.md', '---\nstatus: in_progress\n---\n# Rework the checkout flow\n\n- step one\n');
  put(VAULT, '_dream_context/state/.secrets.json', JSON.stringify({ github: { token: 'gho_fixture_brain_token_never_travels', login: 'kerem' } }) + '\n');
  put(VAULT, '_dream_context/lab/credentials.json', JSON.stringify({ posthog: 'phx_fixture_lab_key_never_travels' }) + '\n');
  put(VAULT, '_dream_context/marketing/hero.bin', Buffer.alloc(4096, 7));
  put(VAULT, '_dream_context/tmp/scratch.txt', 'scratch\n');
  put(VAULT, '.env', 'STRIPE_KEY=sk_test_laptop_original\n');
  put(VAULT, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: [] } }, null, 2) + '\n');
  put(VAULT, '_dream_context/state/.agent-sessions.json', JSON.stringify({
    sessions: [{ title: 'Fix the cart badge', bypass: false, minimized: false, size: 1, sessionId: S1, kind: 'chat' }],
    chatPermissionMode: 'auto',
  }, null, 2) + '\n');
  // A link that escapes the root (D19): stays on the laptop, never deleted.
  symlinkSync('../../../../../../outside-target.txt', join(VAULT, '_dream_context', 'state', 'escape-link'));
  // A transcript of the vault (its transcripts root).
  put(VAULT_TRANSCRIPTS, `${S1}.jsonl`, JSON.stringify({ type: 'user', cwd: VAULT, sessionId: S1, message: { role: 'user', content: 'Fix the cart badge' } }) + '\n');

  // ── acme-payments: divergence ────────────────────────────────────────────────────
  mkdirSync(PAY, { recursive: true });
  git(PAY, ['init', '-q']);
  git(PAY, ['remote', 'add', 'origin', 'https://github.com/acme-co/acme-payments.git']);
  put(PAY, 'ledger.ts', 'export const ledger = [];\n');
  git(PAY, ['add', '-A']);
  git(PAY, ['commit', '-qm', 'payments: first']);

  // ── atlas-mobile: per-path conflict + collisions ─────────────────────────────────
  mkdirSync(ATLAS, { recursive: true });
  git(ATLAS, ['init', '-q']);
  put(ATLAS, 'src/app.ts', 'export const app = "v1";\n');
  put(ATLAS, 'src/other.ts', 'export const other = "v1";\n');
  put(ATLAS, 'docs/Changelog.md', '# Changelog\n- first\n');
  put(ATLAS, NFD, 'laptop NFD spelling\n');
  git(ATLAS, ['add', '-A']);
  git(ATLAS, ['commit', '-qm', 'atlas: first']);

  // ── field-notes: unborn ──────────────────────────────────────────────────────────
  mkdirSync(NOTES, { recursive: true });
  git(NOTES, ['init', '-q']);
  put(NOTES, 'idea.md', 'an idea, not committed yet\n');

  // Registries: the vault and the linked repos (machine-local).
  const add = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-storefront', VAULT], { env: { ...process.env, HOME: LH }, encoding: 'utf8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
  writeFileSync(join(LH, '.dreamcontext', 'linked-repos.json'), JSON.stringify({ repos: {
    'https://github.com/acme-co/acme-payments.git': PAY,
    'https://github.com/acme-co/atlas-mobile.git': ATLAS,
    'https://github.com/acme-co/field-notes.git': NOTES,
  } }, null, 2) + '\n');
  // Two Claude accounts (case 3: a phone session under the NON-default one).
  writeFileSync(join(LH, '.dreamcontext', 'claude-accounts.json'), JSON.stringify({ accounts: [
    { id: 'kerem-main', accountUuid: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'kerem@example.com', organizationUuid: 'org-1', organizationName: 'Acme', tier: 'max', configDir: null, preferred: true },
    { id: 'kerem-work', accountUuid: 'aaaaaaaa-0000-4000-8000-000000000002', email: 'kerem@example.test', organizationUuid: 'org-2', organizationName: 'Acme Work', tier: 'pro', configDir: join(LH, '.dreamcontext', 'claude-accounts', 'kerem-work'), preferred: false },
  ] }, null, 2) + '\n');
  mkdirSync(join(LH, '.dreamcontext', 'claude-accounts', 'kerem-work'), { recursive: true });
  // Laptop-side Claude setup (one-way global set).
  put(join(LH, '.claude'), 'CLAUDE.md', '# Kerem global instructions (fixture)\n');
  put(join(LH, '.claude'), 'settings.json', JSON.stringify({ env: { SECRET_ENV: 'never-travels' }, model: 'opus' }, null, 2) + '\n');
  writeFileSync(join(SCRATCH, 'outside-target.txt'), 'outside the home\n');
}
