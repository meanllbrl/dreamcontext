/**
 * What a Codex chat needs to know dreamcontext: our skills, the project's and the owner's own Claude
 * skills, and the sub-agent roles Claude has. All of it lands under `~/.dreamcontext/codex/`, never
 * in `~/.codex` (the owner's own, read only) and never in the project:
 *
 *   - `skills/`: our skills, the one shared copy ({@link copyToolSkills}), rewritten for Codex;
 *   - `links/<project>/`: one link per skill in the project's `.claude/skills` and the owner's
 *     `~/.claude/skills` (the project wins), minus the names we ship, so nothing is listed twice;
 *   - `roles/<project>/<name>.toml`: a Codex agent role per Claude agent (ours, the owner's
 *     `~/.claude/agents`, the project's `.claude/agents`; the later wins).
 *
 * The session points Codex at the two skill folders with the app-server's `skills/extraRoots/set`
 * (session.ts) and at the roles with `-c agents.<name>.config_file=…` ({@link codexRoleArgs}).
 * Both live only as long as that app-server: no config file anywhere is changed. Measured on
 * 0.164.0: an extra root is listed with `scope: "user"`, a linked skill folder is followed, and
 * Claude's frontmatter keys (`allowed-tools`, `model`, `user-invocable`…) do not stop a skill.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { findPackageDir } from './catalog.js';
import { codexConfigArg, tomlString } from './t3-bridge/launch.js';
import { SAFE_SKILL_NAME, copyToolSkills, skillName, type SkillsResult } from './tool-skills.js';
import { toolText } from './tool-text.js';

export const codexToolDir = (home: string = homedir()): string => join(home, '.dreamcontext', 'codex');

/** Codex's own role names: ours never shadow them. */
const BUILT_IN_ROLES = new Set(['default', 'explorer', 'worker']);
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
/** Claude tools that change files; a role with none of them is told it only reads. */
const WRITE_TOOLS = /\b(Write|Edit|MultiEdit|NotebookEdit)\b/;

export interface CodexKit {
  readonly skills: SkillsResult;
  /** Folders for `skills/extraRoots/set`, absolute and real. */
  readonly skillRoots: string[];
  readonly roles: CodexRole[];
}

export interface CodexRole {
  readonly name: string;
  readonly description: string;
  readonly file: string;
}

export interface CodexKitOptions {
  readonly home?: string;
  /** The chat's project. */
  readonly cwd: string;
  /** Tests: the package's folders. */
  readonly packageDir?: (sub: string) => string | null;
}

const isRealDir = (p: string): boolean => {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
};
const isRealFile = (p: string): boolean => {
  try { return lstatSync(p).isFile(); } catch { return false; }
};

/** One folder per project, named by its real path. */
function projectKey(cwd: string): string {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* the path as given */ }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

/** `content` at `file`, by rename, and only when it changed. */
function writeIfChanged(file: string, content: string): void {
  try {
    if (isRealFile(file) && readFileSync(file, 'utf-8') === content) return;
  } catch { /* rewritten below */ }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

/** A real folder of ours under `~/.dreamcontext/codex`; a link planted at its place is removed, never followed. */
function ownDir(p: string): string {
  try { if (lstatSync(p).isSymbolicLink()) unlinkSync(p); } catch { /* not there yet */ }
  mkdirSync(p, { recursive: true, mode: 0o700 });
  if (!isRealDir(p)) throw new Error(`${p} is not a plain folder`);
  return p;
}

/**
 * The project's and the owner's own skill folders, linked into one root without our names and
 * without what Codex already reads in `~/.agents/skills`. A link we made earlier and no longer
 * want is removed; nothing else in the folder is touched.
 */
function linkOtherSkills(dir: string, sources: readonly string[], skip: ReadonlySet<string>): number {
  const want = new Map<string, string>();
  for (const src of sources) {
    if (!isRealDir(src)) continue;
    for (const name of readdirSync(src)) {
      const target = join(src, name);
      // A link inside the project could point anywhere: only its own real folders are offered.
      if (name.startsWith('.') || !SAFE_SKILL_NAME.test(name) || skip.has(name) || !isRealDir(target)) continue;
      want.set(name, target);
    }
  }
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isSymbolicLink() && want.get(name) !== readlinkSync(p)) unlinkSync(p);
  }
  for (const [name, target] of want) {
    const p = join(dir, name);
    try {
      lstatSync(p);
    } catch {
      // A second pane linking the same name at the same moment got there first.
      try { symlinkSync(target, p, 'dir'); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
    }
  }
  return want.size;
}

/** The text before Claude's `<example>` blocks, on one line, short enough for a role list. */
function shortDescription(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  return text.split('<example>')[0].replace(/\s+/g, ' ').trim().slice(0, 400);
}

/** A Claude agent file → a Codex role file's TOML, or null when it is not one. */
export function roleToml(md: string, o: { agentCore?: string | null } = {}): { name: string; description: string; toml: string } | null {
  let parsed: matter.GrayMatterFile<string>;
  try { parsed = matter(md); } catch { return null; }
  const fm = parsed.data as Record<string, unknown>;
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!SAFE_SKILL_NAME.test(name) || BUILT_IN_ROLES.has(name) || !parsed.content.trim()) return null;
  const description = shortDescription(fm.description) || name;
  const skills = Array.isArray(fm.skills) ? fm.skills.filter((s): s is string => typeof s === 'string' && SAFE_SKILL_NAME.test(s)) : [];
  const opens = skills.map((s) => (s === 'dreamcontext-agent-core' && o.agentCore ? `dreamcontext-agent-core (${o.agentCore})` : s));
  const tools = Array.isArray(fm.tools) ? fm.tools.join(', ') : typeof fm.tools === 'string' ? fm.tools : '';
  const head = [
    `You are the ${name} role, a Codex sub-agent inside a dreamcontext chat.`,
    opens.length ? `Before anything else, open these skills: ${opens.join(', ')}.` : '',
    tools && !WRITE_TOOLS.test(tools) ? 'This role reads and runs commands; it never edits a file.' : '',
  ].filter(Boolean).join(' ');
  const lines = [
    `description = ${tomlString(description)}`,
    `developer_instructions = ${tomlString(`${head}\n\n${toolText(parsed.content.trim(), 'codex')}`)}`,
  ];
  const effort = typeof fm.effort === 'string' ? fm.effort.trim() : '';
  if (EFFORTS.has(effort)) lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
  return { name, description, toml: `${lines.join('\n')}\n` };
}

/** Every role a Claude chat in `cwd` would have, as Codex role files under `dir`. */
function writeRoles(dir: string, sources: readonly string[], agentCore: string | null): CodexRole[] {
  const byName = new Map<string, { description: string; toml: string }>();
  for (const src of sources) {
    if (!isRealDir(src)) continue;
    for (const file of readdirSync(src).sort()) {
      const p = join(src, file);
      if (!file.endsWith('.md') || !isRealFile(p)) continue;
      const role = roleToml(readFileSync(p, 'utf-8'), { agentCore });
      if (role) byName.set(role.name, role);
    }
  }
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.toml') && !byName.has(file.slice(0, -5))) rmSync(join(dir, file), { force: true });
  }
  const roles: CodexRole[] = [];
  for (const [name, r] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    const file = join(dir, `${name}.toml`);
    writeIfChanged(file, r.toml);
    roles.push({ name, description: r.description, file });
  }
  return roles;
}

/**
 * Lays out what this chat's Codex reads and says where. Never throws: a part that fails is left
 * out and named in `skills.reason`, so the chat still opens.
 */
export function prepareCodexKit(o: CodexKitOptions): CodexKit {
  const home = o.home ?? homedir();
  const packageDir = o.packageDir ?? ((sub: string) => findPackageDir(sub));
  const base = join(home, '.dreamcontext', 'codex');
  const key = projectKey(o.cwd);
  let skills: SkillsResult;
  const skillRoots: string[] = [];
  try {
    // The app's own home may be a link the owner chose (another disk, dotfiles): made, never replaced.
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    ownDir(base);
    const dir = ownDir(join(base, 'skills'));
    skills = { ok: true, names: copyToolSkills(dir, { tool: 'codex', stagingParent: base, packageDir }).names };
    skillRoots.push(dir);
  } catch (err) {
    skills = { ok: false, reason: String((err as Error)?.message ?? err).slice(0, 200) };
  }
  try {
    const links = ownDir(join(ownDir(join(base, 'links')), key));
    const shipped = new Set(skills.ok ? skills.names : []);
    const agentsSkills = join(home, '.agents', 'skills');
    if (isRealDir(agentsSkills)) for (const n of readdirSync(agentsSkills)) shipped.add(n);
    if (linkOtherSkills(links, [join(home, '.claude', 'skills'), join(o.cwd, '.claude', 'skills')], shipped) > 0) skillRoots.push(links);
  } catch { /* the project's skills are extra; ours are in */ }
  let roles: CodexRole[] = [];
  try {
    const dir = ownDir(join(ownDir(join(base, 'roles')), key));
    const core = packageDir('skill-agent-core');
    const agentCore = core && existsSync(join(core, 'SKILL.md')) && skillName(join(core, 'SKILL.md')) === 'dreamcontext-agent-core' ? join(core, 'SKILL.md') : null;
    roles = writeRoles(dir, [packageDir('agents'), join(home, '.claude', 'agents'), join(o.cwd, '.claude', 'agents')].filter((p): p is string => !!p), agentCore);
  } catch { /* no roles: the briefing names none */ }
  return { skills, skillRoots, roles };
}

/** `-c agents.<name>.*` for every role: Codex reads the file when `spawn_agent` names the role. */
export function codexRoleArgs(roles: readonly CodexRole[]): string {
  return roles.flatMap((r) => [
    codexConfigArg(`agents.${r.name}.config_file`, tomlString(r.file)),
    codexConfigArg(`agents.${r.name}.description`, tomlString(r.description)),
  ]).join(' ');
}
