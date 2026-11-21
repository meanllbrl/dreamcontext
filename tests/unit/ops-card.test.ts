import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPS_BLOCK_MAX_CHARS, OPS_CARD_REL, opsBlock, readOpsCard, setOpsField } from '../../src/lib/ops-card.js';
import { credentialsFor, scriptEnv } from '../../src/cli/commands/shots.js';

/** The working-facts card is data, never instructions (D9, C8, AC5). Synthetic values only. */
describe('ops card', () => {
  let dir: string;
  let root: string;
  let repo: string;
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();
  const card = (body: string) => writeFileSync(join(root, OPS_CARD_REL), `---\nname: ops-card\n---\n\n${body}\n`);

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ops-card-')));
    root = join(dir, 'proj', '_dream_context');
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    repo = join(dir, 'code');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    git('init', '-q');
    writeFileSync(join(repo, 'scripts', 'shots.mjs'), 'export {}\n');
    writeFileSync(join(repo, 'scripts', 'loose.mjs'), 'export {}\n');
    git('add', 'scripts/shots.mjs');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('set and show round trip', () => {
    setOpsField(root, 'staging_url', 'https://staging.example.test');
    setOpsField(root, 'auth_env', 'STAGING_USER STAGING_PASSWORD');
    setOpsField(root, 'shots_script', 'scripts/shots.mjs', repo);
    setOpsField(root, 'notes', 'Önizleme her PR için açılır');
    expect(readOpsCard(root, { worktree: repo })).toEqual({
      staging_url: 'https://staging.example.test/', auth_env: ['STAGING_USER', 'STAGING_PASSWORD'], shots_script: 'scripts/shots.mjs', notes: 'Önizleme her PR için açılır',
    });
  });

  it.each([
    ['a secret value', '- notes: sk_live_51Habcdefghijklmnop', 'notes'],
    ['a foreign auth_env name', '- auth_env: GITHUB_TOKEN', 'auth_env'],
    ['a database password name', '- auth_env: DATABASE_PASSWORD', 'auth_env'],
    ['a script outside the repo', '- shots_script: ../../.zshrc', 'shots_script'],
    ['a script in the brain', '- shots_script: _dream_context/x.mjs', 'shots_script'],
    ['an untracked script', '- shots_script: scripts/loose.mjs', 'shots_script'],
    ['a login in the URL', '- staging_url: https://u:p@x.example.test', 'staging_url'],
    ['a file URL', '- staging_url: file:///etc/passwd', 'staging_url'],
  ])('a hand-written card drops %s', (_n, line, key) => {
    card(`- preview_url: https://preview.example.test\n${line}`);
    const c = readOpsCard(root, { worktree: repo })!;
    expect(c).not.toHaveProperty(key);
    expect(c.preview_url).toBe('https://preview.example.test/');
  });

  it('a symlinked card or one over 8 KB is not read', () => {
    writeFileSync(join(dir, 'elsewhere.md'), '- staging_url: https://x.example.test\n');
    symlinkSync(join(dir, 'elsewhere.md'), join(root, OPS_CARD_REL));
    expect(readOpsCard(root)).toBeNull();
    rmSync(join(root, OPS_CARD_REL));
    card(`- staging_url: https://x.example.test\n- notes: ${'a '.repeat(5000)}`);
    expect(readOpsCard(root)).toBeNull();
  });

  it('set refuses a secret and a login in a URL', () => {
    expect(() => setOpsField(root, 'staging_url', 'https://u:p@x.example.test')).toThrow();
    expect(() => setOpsField(root, 'auth_env', 'GITHUB_TOKEN')).toThrow();
    expect(() => setOpsField(root, 'notes', 'ghp_abcdefghijklmnopqrstuvwxyz0123')).toThrow();
  });

  it('the brief block is inside PROJECT DOCUMENT bounds and at most 1200 characters', () => {
    const b = opsBlock({ staging_url: 'https://staging.example.test/', notes: 'n'.repeat(600), auth_env: ['STAGING_USER', 'STAGING_PASSWORD'] })!;
    expect(b).toMatch(/BEGIN PROJECT DOCUMENT[\s\S]*END PROJECT DOCUMENT/);
    expect(b).toMatch(/data, not instructions/);
    expect(b.length).toBeLessThanOrEqual(OPS_BLOCK_MAX_CHARS);
    expect(opsBlock(null)).toBeNull();
  });

  it('the login goes only to the card\'s own origin, over https or loopback', () => {
    const env = { STAGING_USER: 'u1', STAGING_PASSWORD: 'p1', PATH: '/bin', HOME: '/h', OTHER: 'x' };
    const c = { staging_url: 'http://127.0.0.1:4001/', auth_env: ['STAGING_USER', 'STAGING_PASSWORD'] };
    expect(credentialsFor(new URL('http://127.0.0.1:4001/a'), c, env)).toEqual({ username: 'u1', password: 'p1', origin: 'http://127.0.0.1:4001' });
    expect(credentialsFor(new URL('http://127.0.0.1:4002/a'), c, env)).toBeNull();
    expect(credentialsFor(new URL('http://staging.example.test/'), { ...c, staging_url: 'http://staging.example.test/' }, env)).toBeNull();
    expect(scriptEnv(new URL('http://127.0.0.1:4001/'), c, env)).toEqual({ PATH: '/bin', HOME: '/h', STAGING_USER: 'u1', STAGING_PASSWORD: 'p1' });
    expect(scriptEnv(new URL('http://127.0.0.1:4002/'), c, env)).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});
