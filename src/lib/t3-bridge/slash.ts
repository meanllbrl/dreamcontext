/**
 * The `/` menu of a Codex or Antigravity chat, and what a `/name` means there (TABLO rows 2, 5).
 *
 * Claude Code lists its commands on `system/init` (`slash_commands`) and expands a `/name` itself:
 * a `.claude/commands/<name>.md` becomes its body, a skill is loaded. Neither tool knows those
 * folders, so the bridge does both: it lists what the project and the owner have, and turns a
 * `/name args` the owner sends into the words the tool can act on. The list is read from disk per
 * chat (a project's commands differ from the next one's), never a fixed list.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^[a-z0-9][a-z0-9:_-]{0,63}$/i;
/** A command body is read whole, but not without end. */
const MAX_COMMAND = 40_000;

export interface SlashEntry {
  readonly name: string;
  readonly kind: 'command' | 'skill';
  /** The file it comes from: the command's body, or the skill's SKILL.md. */
  readonly path: string;
}

function isFile(p: string): boolean {
  try { return lstatSync(p).isFile(); } catch { return false; }
}

function list(dir: string): string[] {
  try { return readdirSync(dir).sort(); } catch { return []; }
}

/** Commands and skills, the project's first (they win a name both have), then the owner's. */
export function slashEntries(cwd: string, home: string): SlashEntry[] {
  const out = new Map<string, SlashEntry>();
  for (const base of [join(cwd, '.claude'), join(home, '.claude')]) {
    for (const f of list(join(base, 'commands'))) {
      const name = f.replace(/\.md$/, '');
      if (f.endsWith('.md') && NAME.test(name) && !out.has(name) && isFile(join(base, 'commands', f))) {
        out.set(name, { name, kind: 'command', path: join(base, 'commands', f) });
      }
    }
    for (const d of list(join(base, 'skills'))) {
      const skill = join(base, 'skills', d, 'SKILL.md');
      if (NAME.test(d) && !out.has(d) && existsSync(skill) && isFile(skill)) out.set(d, { name: d, kind: 'skill', path: skill });
    }
  }
  return [...out.values()];
}

/** What `system/init` lists: the tool's own verbs, then the project's and the owner's. */
export function slashCommandNames(tool: string, cwd: string, home: string): string[] {
  const own = tool === 'codex' ? ['clear', 'compact'] : ['clear'];
  return [...own, ...slashEntries(cwd, home).map((e) => e.name).filter((n) => !own.includes(n))];
}

/** A command body without its frontmatter. */
function body(text: string): string {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? text : text.slice(text.indexOf('\n', end + 1) + 1);
}

/**
 * The words a `/name args` stands for, or null when it names nothing here (sent as typed).
 * A command is its body with `$ARGUMENTS` filled, as Claude expands it; a skill is an ask to read
 * and follow it, since the tool reads files and has no skill verb of ours.
 */
export function expandSlash(text: string, cwd: string, home: string): string | null {
  const m = /^\/([a-z0-9][a-z0-9:_-]{0,63})(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const entry = slashEntries(cwd, home).find((e) => e.name === m[1]);
  if (!entry) return null;
  const args = (m[2] ?? '').trim();
  if (entry.kind === 'skill') {
    return `Use the ${entry.name} skill: read ${entry.path} first and follow it.${args ? `\n\n${args}` : ''}`;
  }
  let raw = '';
  try { raw = readFileSync(entry.path, 'utf-8').slice(0, MAX_COMMAND); } catch { return null; }
  const b = body(raw).trim();
  if (b.includes('$ARGUMENTS')) return b.split('$ARGUMENTS').join(args);
  return args ? `${b}\n\nARGUMENTS: ${args}` : b;
}
