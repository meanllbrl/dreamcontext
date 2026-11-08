/**
 * Claude's sub-agent roles, where Antigravity reads them: a plugin of ours in each account profile,
 * `<profile>/config/plugins/dreamcontext/{plugin.json, agents/<role>.md}` (the agent's own plugin
 * layout, read from its bundled docs, agent 1.4.1). The agent lists a plugin's agents as sub-agents
 * it calls with `invoke_subagent`. Sources: the roles we ship (the skill packs' and the core's) and
 * the owner's `~/.claude/agents` (the later wins). A project's own `.claude/agents` is not here: the profile is shared by every
 * project, so a project role is made in the chat with `define_subagent` from its file (toolNote).
 *
 * The frontmatter keeps `name` and `description` only: `tools` and `model` are Claude's names, and
 * the loader refuses a tool it does not know. A role whose tools never write is told so in prose,
 * as on Codex. An Antigravity sub-agent starts without the project's brain, so the body opens with
 * `dreamcontext snapshot`. Names the agent reserves (self, research, browser) are skipped.
 *
 * Effect-free and never throws, like syncAntigravitySkills; a link planted where a folder of ours
 * goes is removed, never followed.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { antigravityProfileDir } from './antigravity-accounts.js';
import { findPackageDir } from './catalog.js';
import { shortDescription } from './codex-skills.js';
import { SAFE_SKILL_NAME, skillName } from './tool-skills.js';
import { toolText } from './tool-text.js';

/** The plugin's folder name and its manifest `name`. */
export const ANTIGRAVITY_PLUGIN = 'dreamcontext';
/** Names the agent keeps for itself ("agent %q is a reserved or built-in name"). */
const RESERVED = new Set(['self', 'research', 'browser']);
/** Claude tools that change files; a role with none of them is told it only reads. */
const WRITE_TOOLS = /\b(Write|Edit|MultiEdit|NotebookEdit)\b/;

export type RolesResult = { ok: true; names: string[] } | { ok: false; reason: string };

export interface RolesOptions {
  readonly home?: string;
  /** Tests: the package's folders. */
  readonly packageDir?: (sub: string) => string | null;
}

const isRealDir = (p: string): boolean => {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
};
const isRealFile = (p: string): boolean => {
  try { return lstatSync(p).isFile(); } catch { return false; }
};

function ownDir(p: string): string {
  try { if (lstatSync(p).isSymbolicLink()) unlinkSync(p); } catch { /* not there yet */ }
  mkdirSync(p, { recursive: true, mode: 0o700 });
  if (!isRealDir(p)) throw new Error(`${p} is not a plain folder`);
  return p;
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (isRealFile(file) && readFileSync(file, 'utf-8') === content) return;
  } catch { /* rewritten below */ }
  try { if (lstatSync(file).isSymbolicLink()) unlinkSync(file); } catch { /* not there */ }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

/** A Claude agent file → an Antigravity agent file, or null when it is not one. */
export function antigravityRoleMd(md: string, o: { agentCore?: string | null } = {}): { name: string; description: string; md: string } | null {
  let parsed: matter.GrayMatterFile<string>;
  try { parsed = matter(md); } catch { return null; }
  const fm = parsed.data as Record<string, unknown>;
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!SAFE_SKILL_NAME.test(name) || RESERVED.has(name) || !parsed.content.trim()) return null;
  const description = shortDescription(fm.description) || name;
  const skills = Array.isArray(fm.skills) ? fm.skills.filter((s): s is string => typeof s === 'string' && SAFE_SKILL_NAME.test(s)) : [];
  const opens = skills.map((s) => (s === 'dreamcontext-agent-core' && o.agentCore ? `dreamcontext-agent-core (${o.agentCore})` : s));
  const tools = Array.isArray(fm.tools) ? fm.tools.join(', ') : typeof fm.tools === 'string' ? fm.tools : '';
  const head = [
    `You are the ${name} role, an Antigravity sub-agent inside a dreamcontext project.`,
    'You start without the project\'s brain: run `dreamcontext snapshot` in the project folder first and read it.',
    opens.length ? `Then open these skills: ${opens.join(', ')}.` : '',
    tools && !WRITE_TOOLS.test(tools) ? 'This role reads and runs commands; it never edits a file.' : '',
  ].filter(Boolean).join(' ');
  // JSON strings are YAML strings: a description with a colon or a quote stays one value.
  const front = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n`;
  return { name, description, md: `${front}\n${head}\n\n${toolText(parsed.content.trim(), 'antigravity')}\n` };
}

/** Writes our plugin into the account's profile. Never throws. */
export function syncAntigravityRoles(accountId: string, o: RolesOptions = {}): RolesResult {
  const home = o.home ?? homedir();
  const packageDir = o.packageDir ?? ((sub: string) => findPackageDir(sub));
  try {
    const profile = antigravityProfileDir(accountId, home);
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    if (!isRealDir(profile)) return { ok: false, reason: 'the profile folder is not a plain folder' };
    const plugin = ownDir(join(ownDir(join(ownDir(join(profile, 'config')), 'plugins')), ANTIGRAVITY_PLUGIN));
    const agents = ownDir(join(plugin, 'agents'));
    const core = packageDir('skill-agent-core');
    const agentCore = core && existsSync(join(core, 'SKILL.md')) && skillName(join(core, 'SKILL.md')) === 'dreamcontext-agent-core' ? join(core, 'SKILL.md') : null;
    const byName = new Map<string, string>();
    for (const src of [packageDir('skill-packs/agents'), packageDir('agents'), join(home, '.claude', 'agents')]) {
      if (!src || !isRealDir(src)) continue;
      for (const file of readdirSync(src).sort()) {
        const p = join(src, file);
        if (!file.endsWith('.md') || !isRealFile(p)) continue;
        const role = antigravityRoleMd(readFileSync(p, 'utf-8'), { agentCore });
        if (role) byName.set(role.name, role.md);
      }
    }
    for (const file of readdirSync(agents)) {
      if (file.endsWith('.md') && !byName.has(file.slice(0, -3))) rmSync(join(agents, file), { force: true });
    }
    for (const [name, md] of byName) writeIfChanged(join(agents, `${name}.md`), md);
    writeIfChanged(join(plugin, 'plugin.json'), `${JSON.stringify({
      name: ANTIGRAVITY_PLUGIN,
      description: "dreamcontext's sub-agent roles (sleep, review, goal, curator, initializer, council) and the owner's own Claude agents, for invoke_subagent.",
    }, null, 2)}\n`);
    return { ok: true, names: [...byName.keys()].sort() };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}
