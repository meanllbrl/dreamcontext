import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * A member's file is written through the CLI, never by hand. The PreToolUse hook asks this before
 * Edit, Write, MultiEdit and Bash, and turns a hit into a refusal that names the right command.
 *
 * It exists for one accident, and it happened: a session appended a line to `agents/<slug>.md`
 * with a Python heredoc, the hash moved, the next scheduled run stopped and the owner got a card.
 * The hash check stays the wall: this is the seatbelt in front of it. It runs on every Bash call
 * of every session, so a wrong refusal costs more than a miss: it asks who a write verb WRITES TO,
 * never only whether a member's path appears nearby. A write it misses (a glob, a loop) costs a
 * card, never a silent change. `automations/output/` and every other brain file stay free.
 */

const MEMBER_FILE = /(?:^|\/)_dream_context\/(?:agents|automations)\/[^/]+\.md$/;
const MEMBER_DIR = /(?:^|\/)_dream_context\/(?:agents|automations)\/?$/;
/** A token longer than any path: a data blob, never a file name. */
const MAX_TOKEN = 1024;
/** Past this a command is data: reading it costs more than the card a miss costs. */
const MAX_COMMAND = 100_000;

/** Forward slashes, so one set of rules reads a Windows path too. */
const slashes = (p: string): string => p.replace(/\\/g, '/');

function isMemberFile(abs: string, home: string): boolean {
  if (MEMBER_FILE.test(abs)) return true;
  const globalDir = `${slashes(home)}/.dreamcontext/agents`;
  return abs.startsWith(`${globalDir}/`) && abs.endsWith('.md') && !abs.slice(globalDir.length + 1).includes('/');
}

export function expandHome(p: string, home: string): string {
  if (p === '~' || p.startsWith('~/')) return `${home}/${p.slice(2)}`;
  if (p.startsWith('$HOME/')) return `${home}/${p.slice(6)}`;
  if (p.startsWith('${HOME}/')) return `${home}/${p.slice(8)}`;
  return p;
}

/** Where a relative path in this command may be anchored: the shell's folder and each `cd`. */
export function anchors(command: string, cwd: string, home: string): string[] {
  const out = [cwd];
  let at = cwd;
  for (const m of command.matchAll(/(?:^|[;&|\n(])[ \t]*cd[ \t]+(?:--[ \t]+)?("[^"\n]{1,512}"|'[^'\n]{1,512}'|[^\s;&|)]{1,512})/g)) {
    const to = expandHome(slashes(m[1].replace(/^['"]|['"]$/g, '')), home);
    at = slashes(isAbsolute(to) || /^[A-Za-z]:\//.test(to) ? to : resolve(at, to));
    out.push(at);
  }
  return out;
}

/** The member file a shell word names, or null. A path relative to a folder outside a brain (a
 *  code repo's own `agents/`, `.claude/agents/`) resolves outside the two folders: no match. */
function memberFileOf(word: string, dirs: readonly string[], home: string): string | null {
  const raw = expandHome(slashes(word.replace(/^['"]|['"]$/g, '')), home);
  if (!raw.endsWith('.md') || raw.length > MAX_TOKEN) return null;
  if (isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) return isMemberFile(raw, home) ? raw : null;
  for (const dir of dirs) {
    const direct = slashes(resolve(dir, raw));
    if (isMemberFile(direct, home)) return direct;
    const inBrain = slashes(resolve(dir, '_dream_context', raw));
    if (raw.includes('/') && isMemberFile(inBrain, home) && existsSync(inBrain)) return inBrain;
    // Inside the folder itself a bare `doctor.md` names it.
    if (!raw.includes('/') && MEMBER_DIR.test(dir)) return direct;
  }
  return null;
}

/** A heredoc's body is data, not commands: `cat > x <<EOF` keeps its first line. */
export function dropHeredocBodies(command: string): string {
  return command.replace(/(<<-?[ \t]*['"]?([\w-]{1,64})['"]?[^\n]*)\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g, '$1');
}

/** Blank what sits in quotes, same length, so an operator in a sentence is not an operator. A
 *  quote right after `>` is a file name, and stays. */
function maskQuotes(s: string): string {
  let out = '';
  let quote = '';
  let keep = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = ''; out += c; } else out += keep ? c : '\0';
    } else if (c === '"' || c === "'") {
      quote = c;
      keep = /[>]\s*$/.test(out.slice(-8));
      out += c;
    } else out += c;
  }
  return out;
}

/** The shell's own segments of a command, as the original text. */
export function segmentsOf(command: string): string[] {
  const masked = maskQuotes(command);
  const out: string[] = [];
  let from = 0;
  for (const m of masked.matchAll(/&&|\|\||[;|\n]/g)) {
    out.push(command.slice(from, m.index));
    from = m.index + m[0].length;
  }
  out.push(command.slice(from));
  return out;
}

const REMOVERS = new Set(['rm', 'unlink', 'truncate', 'shred', 'mv']);
const COPIERS = new Set(['cp', 'install', 'ln']);

/** Is this shell word a file we guard? The answer is the file. */
type WordMatch = (word: string) => string | null;

/** The guarded file one shell segment writes, or null. */
function segmentTarget(segment: string, match: WordMatch): string | null {
  const masked = maskQuotes(segment);
  for (const m of masked.matchAll(/>{1,2}\s*(['"]?)([^\s\0'"]{1,1024})/g)) {
    const hit = match(m[2]);
    if (hit) return hit;
  }
  const words = segment.trim().split(/\s+/).filter((w) => w.length <= MAX_TOKEN);
  while (words.length > 0 && (/^[A-Za-z_]\w*=/.test(words[0]) || words[0] === 'sudo' || words[0] === 'command')) words.shift();
  const verb = (words[0] ?? '').split('/').pop() ?? '';
  const args = words.slice(1);
  const members = (list: readonly string[]) => list.map(match).find(Boolean) ?? null;
  if (verb === 'sed') return args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place=')) ? members(args) : null;
  if (verb === 'perl') return args.some((a) => /^-(?![Mm])[a-zA-Z]*i/.test(a)) ? members(args) : null;
  if (REMOVERS.has(verb) || verb === 'tee') return members(args);
  if (COPIERS.has(verb)) return members(args.slice(-1));
  if (verb === 'dd') return members(args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
  return null;
}

/** `F=path` in the shell: `sed -i … $F` writes that path. */
function withShellVars(command: string): string {
  let out = command;
  for (const m of command.matchAll(/(?:^|[;&|\n])[ \t]*([A-Za-z_]\w{0,63})=(['"]?)([^\s'";&|]{1,1024}\.md)\2(?=\s|;|&|$)/g)) {
    out = out.replaceAll(`\${${m[1]}}`, m[3]).replace(new RegExp(`\\$${m[1]}\\b`, 'g'), m[3]);
  }
  return out;
}

/** Interpreter names whose text can write a file. */
const INTERPRETER = /^(?:python\d?(?:\.\d+)?|node|ruby|perl|bun|deno)$/;
const ANY_HEREDOC = /^([^\n]*?)<<-?[ \t]*['"]?([\w-]{1,64})['"]?[^\n]*\n([\s\S]*?)\n[ \t]*\2(?=\n|$)/gm;
const INLINE_ARG = /(?:^|\s)-[a-zA-Z]{0,8}[ce]\s+("(?:[^"\\]|\\.)*"|'[^']*')/g;

/** Verbs that run the command after them, and the shell's own words before a command. */
const WRAPPER = /^(?:env|sudo|command|exec|time|timeout|nice|nohup|uv|uvx|poetry|pipenv|conda)$/;
const SHELL_WORD: ReadonlySet<string> = new Set(['(', '{', '!', 'then', 'do', 'else']);

/** Does this shell segment RUN an interpreter? The verb decides, never a word nearby: a wrapper's
 *  own flags and arguments are looked past, so `uv run --with x python` and `timeout 30 python3`
 *  still count, and `cat > python-note.md` does not. */
function runsInterpreter(segment: string): boolean {
  const words = segment.trim().split(/\s+/)
    .filter((w) => !/^[A-Za-z_]\w*=/.test(w) && !SHELL_WORD.has(w))
    .map((w) => w.replace(/^[({]+/, '').split('/').pop() ?? '');
  const first = words[0] ?? '';
  return INTERPRETER.test(first) || (WRAPPER.test(first) && words.slice(1).some((w) => INTERPRETER.test(w)));
}

/** The code a command hands an interpreter: a heredoc it reads, or its `-c`/`-e` argument. Each
 *  heredoc is walked once, so a body is never rescanned as commands, and a sentence in a commit
 *  message or a note that quotes `open(p,'w')` is not code. */
function scriptsIn(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(ANY_HEREDOC)) {
    const opener = segmentsOf(m[1]);
    if (runsInterpreter(opener[opener.length - 1] ?? '')) out.push(m[3]);
  }
  for (const segment of segmentsOf(dropHeredocBodies(command))) {
    if (runsInterpreter(segment)) for (const m of segment.matchAll(INLINE_ARG)) out.push(m[1]);
  }
  return out;
}

/** A script's write of a guarded file: the path often sits in a variable. */
function scriptWriteTarget(script: string, match: WordMatch): string | null {
  const named = new Map<string, string>();
  for (const m of script.matchAll(/\b([A-Za-z_$][\w$]{0,63})\s*=\s*(?:Path\(\s*|new URL\(\s*)?['"`]([^'"`\n]{1,1024})['"`]/g)) {
    const file = match(m[2]);
    if (file) named.set(m[1], file);
  }
  const fileIn = (expr: string): string | null => {
    for (const m of expr.matchAll(/['"`]([^'"`\n]{1,1024})['"`]/g)) {
      const hit = match(m[1]);
      if (hit) return hit;
    }
    // The name itself, or `Path(name)`: never a name that only appears inside another expression.
    const id = /^(?:[\w.]*Path\(\s*)?([A-Za-z_$][\w$]*)\s*\)?$/.exec(expr.trim());
    return id ? named.get(id[1]) ?? null : null;
  };
  const writes = [
    // open(p, 'w'), open(p, mode='a'), open(p, 'r+')
    /\bopen\s*\(\s*([^,)\n]{1,1024}),\s*(?:mode\s*=\s*)?['"][^'"\n]*[wax+][^'"\n]*['"]/g,
    // writeFileSync(p, …), appendFile(p, …), File.write(p, …)
    /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|File\.write)\s*\(\s*([^,)\n]{1,1024}),/g,
  ];
  for (const re of writes) {
    for (const m of script.matchAll(re)) {
      const hit = fileIn(m[1]);
      if (hit) return hit;
    }
  }
  // Path(p).write_text(…), p.write_bytes(…), Path(p).open('a'): the receiver sits just before it.
  for (const m of script.matchAll(/\.(?:write_text|write_bytes|open\(\s*['"][wax+])/g)) {
    const receiver = /[\w$.()'"`/-]*$/.exec(script.slice(Math.max(0, m.index - MAX_TOKEN), m.index));
    const hit = receiver ? fileIn(receiver[0]) : null;
    if (hit) return hit;
  }
  return null;
}

/** The member file this tool call would write, or null. */
export function memberFileWriteTarget(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  home: string = homedir(),
): string | null {
  const here = slashes(cwd);
  const me = slashes(home);
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    const raw = typeof toolInput.file_path === 'string' ? expandHome(slashes(toolInput.file_path), me) : '';
    if (!raw) return null;
    const abs = isAbsolute(raw) || /^[A-Za-z]:\//.test(raw) ? raw : slashes(resolve(here, raw));
    return isMemberFile(abs, me) ? abs : null;
  }
  if (toolName !== 'Bash') return null;
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!command.includes('.md') || command.length > MAX_COMMAND) return null;
  const dirs = anchors(command, here, me);
  return shellTarget(command, (word) => memberFileOf(word, dirs, me));
}

/** What this command's own words and scripts write, by `match`. */
function shellTarget(command: string, match: WordMatch): string | null {
  for (const script of scriptsIn(command)) {
    const hit = scriptWriteTarget(script, match);
    if (hit) return hit;
  }
  for (const segment of segmentsOf(withShellVars(dropHeredocBodies(command)))) {
    const hit = segmentTarget(segment, match);
    if (hit) return hit;
  }
  return null;
}

/**
 * The file a shell command writes for which `guarded(absolutePath)` holds, or null: the same reading
 * as a member file, for any other file a tool with no sandbox must not write. A path relative to
 * the shell's folder or a `cd` in the command counts.
 */
export function shellWriteTarget(command: string, cwd: string, guarded: (abs: string) => boolean, home: string = homedir()): string | null {
  if (command.length > MAX_COMMAND) return null;
  const me = slashes(home);
  const dirs = anchors(command, slashes(cwd), me);
  return shellTarget(command, (word) => {
    const raw = expandHome(slashes(word.replace(/^['"]|['"]$/g, '')), me);
    if (!raw || raw.length > MAX_TOKEN) return null;
    if (isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) return guarded(raw) ? raw : null;
    for (const dir of dirs) {
      const abs = slashes(resolve(dir, raw));
      if (guarded(abs)) return abs;
    }
    return null;
  });
}

/** The refusal the hook gives. It names the door, so the session does not hunt for another way. */
export function memberFileRefusal(file: string): string {
  return [
    `Blocked: ${file} is an AI Team member's file, and a hand edit drops its approval, so its next run stops and the owner gets a card.`,
    'Super Agent: `dreamcontext super team amend <member> --why "<the mistake>" --prompt-file <file>` (also --soul-file, --routine <slug> --job-file): the member stays approved and the owner can undo it.',
    'Any other session: tell the Super Agent what is wrong, or ask the owner to edit it on the AI Team page.',
    'Name, team and place in the tree stay free: `dreamcontext agents edit <slug> --title|--team|--reports-to`. On/off: `dreamcontext automations enable|disable <slug>`.',
  ].join(' ');
}
