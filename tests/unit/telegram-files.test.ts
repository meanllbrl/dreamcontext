/**
 * Every refused outbound file class (plan AC9): `.env*`, keys/pem/p12/credentials, `.git/**`,
 * hardlinks, symlinks, outside-root paths, gitignored files outside `_dream_context/tmp/`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyOutbound, readOutbound, refusalLine } from '../../src/lib/telegram/files.js';

let base: string;
let project: string;
let linked: string;
let outside: string;
const ignoredRels = new Set<string>();
const isGitIgnored = (_root: string, rel: string): boolean => ignoredRels.has(rel);
const opts = () => ({ roots: [project, linked], projectRoot: project, isGitIgnored });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tg-files-'));
  project = join(base, 'project');
  linked = join(base, 'linked');
  outside = join(base, 'outside');
  for (const d of [project, linked, outside, join(project, '_dream_context', 'tmp'), join(project, '.git'), join(project, 'docs')]) mkdirSync(d, { recursive: true });
  ignoredRels.clear();
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const put = (dir: string, rel: string, body = 'x'): string => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  return p;
};

describe('outbound classifier', () => {
  it('allows an ordinary project file and a linked-repo file', () => {
    const r = classifyOutbound(put(project, 'docs/rapor.pdf'), opts());
    expect(r.ok).toBe(true);
    expect(classifyOutbound(put(linked, 'src/a.ts'), opts()).ok).toBe(true);
  });

  const secretNames = [
    '.env', '.env.local', 'config/.env.production', 'app.local.json', 'secrets.json', 'my-secret.yaml',
    'credentials.json', 'credential.toml', 'server.pem', 'tls.key', 'cert.p12', 'store.pfx', 'release.keystore',
    'android.jks', 'id_rsa', 'id_rsa.pub', 'id_ed25519', '.npmrc', '.netrc', '.git-credentials', '.ssh/config', '.aws/credentials',
  ];
  for (const name of secretNames) {
    it(`refuses the secret class: ${name}`, () => {
      expect(classifyOutbound(put(project, name), opts())).toEqual({ ok: false, reason: 'secret_class' });
    });
  }

  it('refuses anything under .git', () => {
    expect(classifyOutbound(put(project, '.git/config'), opts())).toEqual({ ok: false, reason: 'git_dir' });
    expect(classifyOutbound(put(linked, 'sub/.git/HEAD'), opts())).toEqual({ ok: false, reason: 'git_dir' });
  });

  it('refuses a symlink (even to an allowed file) and a symlink pointing outside', () => {
    const real = put(project, 'docs/a.txt');
    symlinkSync(real, join(project, 'docs/link.txt'));
    expect(classifyOutbound(join(project, 'docs/link.txt'), opts())).toEqual({ ok: false, reason: 'symlink' });
    symlinkSync(put(outside, 'x.txt'), join(project, 'docs/out.txt'));
    expect(classifyOutbound(join(project, 'docs/out.txt'), opts())).toEqual({ ok: false, reason: 'symlink' });
  });

  it('refuses a hardlink', () => {
    const real = put(outside, 'h.txt');
    linkSync(real, join(project, 'docs/h.txt'));
    expect(classifyOutbound(join(project, 'docs/h.txt'), opts())).toEqual({ ok: false, reason: 'hardlink' });
  });

  it('refuses a path outside every root, a climb, a relative path, a folder, a missing file', () => {
    expect(classifyOutbound(put(outside, 'o.txt'), opts())).toEqual({ ok: false, reason: 'outside_root' });
    expect(classifyOutbound(join(project, '..', 'outside', 'o.txt'), opts())).toEqual({ ok: false, reason: 'outside_root' });
    expect(classifyOutbound('docs/a.txt', opts())).toEqual({ ok: false, reason: 'not_absolute' });
    expect(classifyOutbound(join(project, 'docs'), opts())).toEqual({ ok: false, reason: 'not_file' });
    expect(classifyOutbound(join(project, 'nope.txt'), opts())).toEqual({ ok: false, reason: 'missing' });
  });

  it('a symlinked folder inside the project that leads outside is outside', () => {
    put(outside, 'leak.txt');
    symlinkSync(outside, join(project, 'docs/ext'));
    expect(classifyOutbound(join(project, 'docs/ext/leak.txt'), opts())).toEqual({ ok: false, reason: 'outside_root' });
  });

  it('refuses a gitignored file outside _dream_context/tmp, allows one inside it', () => {
    ignoredRels.add('build/out.zip');
    ignoredRels.add('_dream_context/tmp/super/r.html');
    expect(classifyOutbound(put(project, 'build/out.zip'), opts())).toEqual({ ok: false, reason: 'gitignored' });
    expect(classifyOutbound(put(project, '_dream_context/tmp/super/r.html'), opts()).ok).toBe(true);
  });

  it('refuses a file over the upload cap', () => {
    expect(classifyOutbound(put(project, 'docs/big.bin', 'x'.repeat(100)), { ...opts(), maxBytes: 10 })).toEqual({ ok: false, reason: 'too_large' });
  });

  it('readOutbound sends the classified bytes from the fd', () => {
    const p = put(project, 'docs/not.md', 'Merhaba Dünya');
    const r = readOutbound(p, opts());
    expect(r.ok && r.file.data.toString('utf-8')).toBe('Merhaba Dünya');
    expect(r.ok && r.file.name).toBe('not.md');
    expect(readOutbound(join(project, '.env'), opts()).ok).toBe(false);
  });

  it('the refusal line names only the base name', () => {
    expect(refusalLine('.env', 'secret_class')).toBe("Mac'te: .env (gizli dosya)");
  });
});
