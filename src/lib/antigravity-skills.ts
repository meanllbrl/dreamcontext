/**
 * Our skills, where Antigravity reads them: `<profile>/config/skills`, one copy per account profile,
 * refreshed when a chat opens. No project step, ever: the project-level folders the agent also reads
 * (`.gemini/skills`, `.agents/skills`, which it leaves empty behind it) stay nobody's job here.
 *
 * T3 links that folder to the real `~/.gemini/config/skills`, so writing through the link would
 * write in the owner's own home. It is replaced by a real folder first, the link alone removed,
 * never its target; the owner's own skills there are linked in one by one, so they stay readable.
 * `antigravity-cli/skills`, the agent's second folder, gets the same, so the agent (which writes
 * there in Bypass) cannot reach `~/.gemini` through it. T3 leaves a real folder as it is. A live
 * turn listed all seven (agent 1.4.1). Effect-free, and it never throws.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { antigravityProfileDir } from './antigravity-accounts.js';
import { findPackageDir } from './catalog.js';

/** What every project gets at install. `skill-agent-core` is for sub-agents, which do not run here. */
const SOURCES = ['skill', 'skill-initializer', 'skill-curator', 'skill-sync', 'skill-deep-research', 'skill-patterns', 'skill-apps'];
const MARKER = '.dreamcontext-skills.json';
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type SkillsResult = { ok: true; names: string[] } | { ok: false; reason: string };

export interface SkillsOptions {
  readonly home?: string;
  /** Where the owner's own `.gemini` is. Default `<home>/.gemini`. */
  readonly userGemini?: string;
  /** Tests: the package's folders. */
  readonly packageDir?: (sub: string) => string | null;
}

/** Every regular file under `dir`; a symlink is never followed out of the package. */
function filesOf(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) filesOf(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

const realDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The agent can write in this folder, so the record is checked, and a link is never read or written through. */
function readMarker(dir: string): { digest?: string; names?: string[] } {
  try {
    const p = join(dir, MARKER);
    if (!lstatSync(p).isFile()) return {};
    const m = JSON.parse(readFileSync(p, 'utf-8')) as { digest?: unknown; names?: unknown } | null;
    const names = Array.isArray(m?.names) ? m.names.filter((n): n is string => typeof n === 'string' && SAFE_NAME.test(n)) : [];
    return typeof m?.digest === 'string' ? { digest: m.digest, names } : {};
  } catch {
    return {};
  }
}

/** The owner's own skills, one link each. A link whose target went is taken away. */
function linkOwnSkills(dir: string, own: string, ours: ReadonlySet<string>): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isSymbolicLink() && !existsSync(p)) unlinkSync(p);
  }
  if (!existsSync(own)) return;
  // One at a time: a broken entry of theirs must not hide the ones after it.
  for (const name of readdirSync(own)) {
    try {
      const target = join(own, name);
      if (name.startsWith('.') || ours.has(name) || !statSync(target).isDirectory()) continue;
      const p = join(dir, name);
      let held = false;
      try { lstatSync(p); held = true; } catch { /* free */ }
      if (!held) symlinkSync(target, p, 'dir');
      else if (lstatSync(p).isSymbolicLink() && readlinkSync(p) !== target) { unlinkSync(p); symlinkSync(target, p, 'dir'); }
    } catch { /* that one stays out */ }
  }
}

export function syncAntigravitySkills(accountId: string, o: SkillsOptions = {}): SkillsResult {
  const home = o.home ?? homedir();
  const profile = antigravityProfileDir(accountId, home);
  const config = join(profile, 'config');
  const dir = join(config, 'skills');
  let staging = '';
  try {
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    mkdirSync(join(profile, 'antigravity-acp'), { recursive: true, mode: 0o700 });
    mkdirSync(config, { recursive: true, mode: 0o700 });
    if (!realDir(profile) || !realDir(config) || !realDir(join(profile, 'antigravity-acp'))) return { ok: false, reason: 'the profile folder is not a plain folder' };
    try {
      if (lstatSync(dir).isSymbolicLink()) unlinkSync(dir);
    } catch { /* not there yet */ }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!realDir(dir)) return { ok: false, reason: 'the skills folder is not a plain folder' };

    const packageDir = o.packageDir ?? ((sub: string) => findPackageDir(sub));
    const hash = createHash('sha256');
    const skills: { name: string; src: string }[] = [];
    for (const sub of SOURCES) {
      const src = packageDir(sub);
      if (!src || !existsSync(join(src, 'SKILL.md'))) return { ok: false, reason: `${sub} is missing from this install` };
      const name = /^name:\s*["']?([^"'\s]+)/m.exec(readFileSync(join(src, 'SKILL.md'), 'utf-8'))?.[1] ?? '';
      if (!SAFE_NAME.test(name)) return { ok: false, reason: `${sub} has no usable name` };
      skills.push({ name, src });
      for (const f of filesOf(src)) hash.update(`${name}/${relative(src, f)}\0`).update(readFileSync(f)).update('\0');
    }
    const digest = hash.digest('hex');
    const names = skills.map((s) => s.name);
    const was = readMarker(dir);
    const ours = new Set([...names, ...(was.names ?? []).filter((n) => SAFE_NAME.test(n))]);
    if (was.digest !== digest || names.some((n) => !existsSync(join(dir, n, 'SKILL.md')))) {
      // Staged inside the profile, on the same disk, and outside what the agent scans.
      staging = mkdtempSync(join(profile, 'antigravity-acp', 'skills-staging-'));
      for (const s of skills) {
        const dest = join(staging, s.name);
        for (const f of filesOf(s.src)) cpSync(f, join(dest, relative(s.src, f)), { dereference: false, recursive: false });
      }
      for (const n of ours) if (!names.includes(n)) rmSync(join(dir, n), { recursive: true, force: true });
      for (const s of skills) {
        const dest = join(dir, s.name);
        rmSync(dest, { recursive: true, force: true });
        try {
          renameSync(join(staging, s.name), dest);
        } catch (err) {
          // A second pane on this profile, refreshing at the same moment, got there first.
          if (!existsSync(join(dest, 'SKILL.md'))) throw err;
        }
      }
      // By rename: it replaces a link planted here instead of writing through it.
      writeFileSync(join(staging, MARKER), JSON.stringify({ digest, names }));
      renameSync(join(staging, MARKER), join(dir, MARKER));
    }
    const gemini = o.userGemini ?? join(home, '.gemini');
    try {
      linkOwnSkills(dir, join(gemini, 'config', 'skills'), new Set(names));
    } catch { /* the owner's own skills are extra; ours are in */ }
    try {
      const cli = join(profile, 'antigravity-cli');
      mkdirSync(cli, { recursive: true, mode: 0o700 });
      const second = join(cli, 'skills');
      try {
        if (lstatSync(second).isSymbolicLink()) unlinkSync(second);
      } catch { /* not there yet */ }
      mkdirSync(second, { recursive: true, mode: 0o700 });
      if (realDir(cli) && realDir(second)) linkOwnSkills(second, join(gemini, 'antigravity-cli', 'skills'), new Set());
    } catch { /* that folder is the owner's extras only */ }
    return { ok: true, names };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err).slice(0, 200) };
  } finally {
    try {
      if (staging) rmSync(staging, { recursive: true, force: true });
    } catch { /* the next refresh is unaffected */ }
  }
}
