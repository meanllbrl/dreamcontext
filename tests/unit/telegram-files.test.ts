/**
 * Every refused outbound file class (plan AC9): `.env*`, keys/pem/p12/credentials, `.git/**`,
 * hardlinks, symlinks, outside-root paths, gitignored files outside `_dream_context/tmp/`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFUSAL_WHY, classifyOutbound, gitIgnoredOrUnproven, ignoredButSendable, readOutbound, refusalLine } from '../../src/lib/telegram/files.js';

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

  it('refuses .git in any case (APFS ignores case: .GIT/config is .git/config)', () => {
    expect(classifyOutbound(put(project, '.GIT/config'), opts())).toEqual({ ok: false, reason: 'git_dir' });
    expect(classifyOutbound(put(linked, 'sub/.Git/HEAD'), opts())).toEqual({ ok: false, reason: 'git_dir' });
  });

  it('the default gitignore probe refuses unless git proves the file is not ignored', () => {
    // Not a repo (git exits 128): unproven, so refused.
    put(outside, 'a.txt');
    expect(gitIgnoredOrUnproven(outside, 'a.txt')).toBe(true);
    // A repo: an ignored file is refused, a plain one passes (git exits 1).
    execFileSync('git', ['init', '-q'], { cwd: linked, stdio: 'ignore' });
    put(linked, '.gitignore', 'serviceAccount.json\n');
    put(linked, 'serviceAccount.json');
    put(linked, 'notes.md');
    expect(gitIgnoredOrUnproven(linked, 'serviceAccount.json')).toBe(true);
    expect(gitIgnoredOrUnproven(linked, 'notes.md')).toBe(false);
    // And it is the classifier's default when no probe is injected.
    const noProbe = { roots: [linked], projectRoot: project };
    expect(classifyOutbound(join(linked, 'serviceAccount.json'), noProbe)).toEqual({ ok: false, reason: 'gitignored' });
    expect(classifyOutbound(join(linked, 'notes.md'), noProbe).ok).toBe(true);
    expect(classifyOutbound(put(outside, 'b.txt'), { roots: [outside] })).toEqual({ ok: false, reason: 'gitignored' });
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

  // Owner 2026-11-11 (kitup): five screenshots from an app's data folder went as "(Mac'te)".
  it('a picture in a git-ignored working folder goes (app data, task assets, a child worktree); nothing else there does', () => {
    for (const rel of ['_dream_context/apps/atlas/shots/liven.png', '_dream_context/state/assets/t/ekran.jpg', '.claude/worktrees/w1/out/clip.mp4', '_dream_context/apps/atlas/rapor.pdf']) {
      ignoredRels.add(rel);
      expect(classifyOutbound(put(project, rel), opts()).ok, rel).toBe(true);
    }
    for (const rel of ['_dream_context/apps/atlas/data.json', '_dream_context/apps/atlas/notes.md', '_dream_context/inbox/client.png', 'build/shot.png', '_dream_context/state/.super-agent.json']) {
      ignoredRels.add(rel);
      expect(classifyOutbound(put(project, rel), opts()), rel).toEqual({ ok: false, reason: 'gitignored' });
    }
    // Every other rule still comes first there: a secret, a symlink, a folder link out.
    expect(classifyOutbound(put(project, '_dream_context/apps/atlas/.env.png'), opts()).ok).toBe(false);
    put(outside, 'leak.png');
    symlinkSync(join(outside, 'leak.png'), join(project, '_dream_context/apps/atlas/link.png'));
    expect(classifyOutbound(join(project, '_dream_context/apps/atlas/link.png'), opts())).toEqual({ ok: false, reason: 'symlink' });
    mkdirSync(join(project, '_dream_context/state/assets'), { recursive: true });
    symlinkSync(outside, join(project, '_dream_context/state/assets/out'));
    expect(classifyOutbound(join(project, '_dream_context/state/assets/out/leak.png'), opts())).toEqual({ ok: false, reason: 'outside_root' });
  });

  it('the media rule reads the real path: a lookalike name never opens a folder', () => {
    expect(ignoredButSendable('_dream_context/apps/a/x.png')).toBe(true);
    expect(ignoredButSendable('_dream_context/tmp/anything.txt')).toBe(true);
    expect(ignoredButSendable('x/_dream_context/apps/a/x.png')).toBe(false);
    expect(ignoredButSendable('_dream_context/appsx/a.png')).toBe(false);
    expect(ignoredButSendable('_dream_context/apps/a/x.png.txt')).toBe(false);
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
    expect(refusalLine('.env', 'secret_class')).toBe("Mac'te: .env (gizli dosya sayılıyor, gönderilmez)");
    // Every reason says why in his words, and a fixable one what to do.
    // The reason alone: what to ask is the caller's (a Super's card names it, a routine never does).
    expect(refusalLine('a.png', 'gitignored')).toBe("Mac'te: a.png (yalnız bu Mac'te tutulan bir klasörde)");
    for (const w of Object.values(REFUSAL_WHY)) expect(w.length).toBeGreaterThan(8);
  });
});
