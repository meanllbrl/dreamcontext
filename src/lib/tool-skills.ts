/**
 * dreamcontext's skills, copied where a non-Claude tool reads them. ONE list and ONE copier for
 * every tool: Antigravity puts them in its account profile (antigravity-skills.ts), Codex in a
 * folder of ours it is pointed at per session (codex-skills.ts). Claude reads them where install
 * put them and never comes here.
 *
 * The copy is refreshed only when the package (or the tool's text rules) changed, staged on the
 * same disk and renamed in, so a second pane refreshing at the same moment never sees half a skill.
 * Markdown is rewritten for the tool ({@link toolText}); everything else is copied as it is.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { findPackageDir } from './catalog.js';
import { toolText, type TextTool } from './tool-text.js';

/** What every project gets at install. `skill-agent-core` is for Claude's sub-agents only. */
export const TOOL_SKILL_SOURCES = ['skill', 'skill-initializer', 'skill-curator', 'skill-sync', 'skill-deep-research', 'skill-patterns', 'skill-apps', 'skill-design'] as const;
export const SKILLS_MARKER = '.dreamcontext-skills.json';
export const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Bump when a {@link toolText} rule changes, so every copy is rewritten. */
const TEXT_REV = '1';

export type SkillsResult = { ok: true; names: string[] } | { ok: false; reason: string };

export interface CopyOptions {
  /** Tests: the package's folders. */
  readonly packageDir?: (sub: string) => string | null;
  /** Whose words the markdown is rewritten in. */
  readonly tool: TextTool;
  /** A folder on the same disk as `dir`, outside what the tool scans, for the staged copy. */
  readonly stagingParent: string;
}

/** Every regular file under `dir`; a symlink is never followed out of the package. */
export function filesOf(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) filesOf(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

/** The tool can write in this folder, so the record is checked, and a link is never read through. */
function readMarker(dir: string): { digest?: string; names?: string[] } {
  try {
    const p = join(dir, SKILLS_MARKER);
    if (!lstatSync(p).isFile()) return {};
    const m = JSON.parse(readFileSync(p, 'utf-8')) as { digest?: unknown; names?: unknown } | null;
    const names = Array.isArray(m?.names) ? m.names.filter((n): n is string => typeof n === 'string' && SAFE_SKILL_NAME.test(n)) : [];
    return typeof m?.digest === 'string' ? { digest: m.digest, names } : {};
  } catch {
    return {};
  }
}

/** A skill's own name, from its frontmatter. */
export function skillName(skillMd: string): string {
  return /^name:\s*["']?([^"'\s]+)/m.exec(readFileSync(skillMd, 'utf-8'))?.[1] ?? '';
}

/**
 * Our skills into `dir` (a real folder the caller made). Drops only what an earlier copy wrote;
 * anything else in `dir` is left alone. Throws on a file error: the callers turn it into a reason.
 */
export function copyToolSkills(dir: string, o: CopyOptions): { names: string[] } {
  const packageDir = o.packageDir ?? ((sub: string) => findPackageDir(sub));
  const hash = createHash('sha256').update(`${o.tool}:${TEXT_REV}\0`);
  const skills: { name: string; src: string }[] = [];
  for (const sub of TOOL_SKILL_SOURCES) {
    const src = packageDir(sub);
    if (!src || !existsSync(join(src, 'SKILL.md'))) throw new Error(`${sub} is missing from this install`);
    const name = skillName(join(src, 'SKILL.md'));
    if (!SAFE_SKILL_NAME.test(name)) throw new Error(`${sub} has no usable name`);
    skills.push({ name, src });
    for (const f of filesOf(src)) hash.update(`${name}/${relative(src, f)}\0`).update(readFileSync(f)).update('\0');
  }
  const digest = hash.digest('hex');
  const names = skills.map((s) => s.name);
  const was = readMarker(dir);
  if (was.digest === digest && names.every((n) => existsSync(join(dir, n, 'SKILL.md')))) return { names };
  const ours = new Set([...names, ...(was.names ?? [])]);
  const staging = mkdtempSync(join(o.stagingParent, 'skills-staging-'));
  try {
    for (const s of skills) {
      const dest = join(staging, s.name);
      for (const f of filesOf(s.src)) {
        const to = join(dest, relative(s.src, f));
        if (f.endsWith('.md')) {
          mkdirSync(dirname(to), { recursive: true });
          writeFileSync(to, toolText(readFileSync(f, 'utf-8'), o.tool));
        } else {
          cpSync(f, to, { dereference: false, recursive: false });
        }
      }
    }
    for (const n of ours) if (!names.includes(n)) rmSync(join(dir, n), { recursive: true, force: true });
    for (const s of skills) {
      const dest = join(dir, s.name);
      rmSync(dest, { recursive: true, force: true });
      try {
        renameSync(join(staging, s.name), dest);
      } catch (err) {
        // A second pane, refreshing at the same moment, got there first.
        if (!existsSync(join(dest, 'SKILL.md'))) throw err;
      }
    }
    // By rename: it replaces a link planted here instead of writing through it.
    writeFileSync(join(staging, SKILLS_MARKER), JSON.stringify({ digest, names }));
    renameSync(join(staging, SKILLS_MARKER), join(dir, SKILLS_MARKER));
  } finally {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* the next refresh is unaffected */ }
  }
  return { names };
}
