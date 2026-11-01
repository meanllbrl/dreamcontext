/**
 * Our skills, where Antigravity reads them: `<profile>/config/skills`, one copy per account profile,
 * refreshed when a chat opens. No project step, ever: the project-level folders the agent also reads
 * (`.gemini/skills`, `.agents/skills`, which it leaves empty behind it) stay nobody's job here.
 *
 * T3 links that folder to the real `~/.gemini/config/skills`, so writing through the link would
 * write in the owner's own home. It is replaced by a real folder first, the link alone removed,
 * never its target; the owner's own skills there are linked in one by one, so they stay readable.
 * T3 leaves a real folder as it is. Static text in the agent says `config/skills` follows
 * `GEMINI_HOME`; whether it lists them is for a live turn. Effect-free, and it never throws.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { antigravityProfileDir } from './antigravity-accounts.js';
import { copyToolSkills, type SkillsResult } from './tool-skills.js';

export type { SkillsResult };

export interface SkillsOptions {
  readonly home?: string;
  /** Where the owner's own `.gemini` is. Default `<home>/.gemini`. */
  readonly userGemini?: string;
  /** Tests: the package's folders. */
  readonly packageDir?: (sub: string) => string | null;
}

const realDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

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
    // Staged inside the profile, on the same disk, and outside what the agent scans.
    const { names } = copyToolSkills(dir, { tool: 'antigravity', stagingParent: join(profile, 'antigravity-acp'), ...(o.packageDir ? { packageDir: o.packageDir } : {}) });
    try {
      linkOwnSkills(dir, o.userGemini ? join(o.userGemini, 'config', 'skills') : join(home, '.gemini', 'config', 'skills'), new Set(names));
    } catch { /* the owner's own skills are extra; ours are in */ }
    return { ok: true, names };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}
