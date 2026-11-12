import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgram } from '../../src/cli/program.js';
import { buildCliManifest, type CliEndpoint } from '../../src/lib/cli-manifest.js';

/**
 * Every `dreamcontext <cmd> <sub>` an instruction names must exist.
 *
 * Skills, agent prompts and the briefings the server writes into a session are read by an agent
 * that copies the command it is shown. A command that was renamed or never existed is a failed
 * call at best and a guessed workaround at worst (the 2026-11-12 audit found `features list`,
 * `core list`, `tasks show` and `lab report create --insights` in live instruction text). So the
 * command words in each backticked span and each fenced code line are walked against the real
 * command tree from `createProgram()`, the same tree `cli-manifest.json` is generated from.
 *
 * Only the command PATH is checked (`tasks create`), never its arguments or flags: the walk stops
 * at the first token that is not a plain lowercase word, or at a node that takes positionals.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Instruction text an agent reads: every skill, every agent prompt, the briefing sources. */
const BRIEFING_SOURCES = [
  'src/server/chat-modes.ts',
  'src/server/chat-surface.ts',
  'src/lib/agent-guidance.ts',
  'src/lib/develop-recipe.ts',
  'src/lib/builder-brief.ts',
  'src/lib/planner-brief.ts',
  'src/cli/commands/snapshot.ts',
];

/**
 * Dead mentions that live in files another change owns, as `file: command path`. Each one is a
 * real defect, listed so this test can guard every OTHER line today; delete an entry when its line
 * is fixed.
 */
const KNOWN_DEAD: readonly string[] = [
  // skill/references: no wave-1 job owns them (the generated cli-reference work, IN-10).
  'skill/references/integrations.md: dreamcontext config shareable',
  'skill/references/tasks-and-features.md: dreamcontext lab report',
  // The AI Team member briefing (B7's chat-modes.ts) and the snapshot pointer (B4's snapshot.ts).
  'src/server/chat-modes.ts: dreamcontext tasks show',
  'src/cli/commands/snapshot.ts: dreamcontext core list',
];

function mdFilesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) mdFilesUnder(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

function instructionFiles(): string[] {
  const skills = readdirSync(ROOT)
    .filter((n) => n === 'skill' || n.startsWith('skill-'))
    .filter((n) => statSync(join(ROOT, n)).isDirectory())
    .flatMap((n) => mdFilesUnder(join(ROOT, n)));
  const agents = readdirSync(join(ROOT, 'agents')).filter((n) => n.endsWith('.md')).map((n) => join(ROOT, 'agents', n));
  return [...skills, ...agents, ...BRIEFING_SOURCES.map((f) => join(ROOT, f))];
}

/** The code spans of a text: inline backtick spans (one line) and the lines of fenced blocks. */
export function codeSpans(text: string): { line: number; span: string }[] {
  const out: { line: number; span: string }[] = [];
  // A TS template literal escapes its backticks; read them as the agent finally sees them.
  const lines = text.replace(/\\`/g, '`').split('\n');
  let fenced = false;
  lines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { fenced = !fenced; return; }
    if (fenced) { out.push({ line: i + 1, span: raw }); return; }
    for (const m of raw.matchAll(/`([^`]+)`/g)) out.push({ line: i + 1, span: m[1] });
  });
  return out;
}

const WORD = /^[a-z][a-z0-9-]*$/;

/**
 * Walk one `dreamcontext a b c …` mention down the tree. Returns the path it named when that path
 * does not exist, or null when it resolves (or names nothing checkable).
 */
export function deadPath(tokens: string[], byPath: Map<string, CliEndpoint>, aliasOf: Map<string, string>): string | null {
  let path = '';
  for (const tok of tokens) {
    if (!WORD.test(tok)) return null;
    const node = path ? byPath.get(path) : undefined;
    // A leaf, or a group that also takes positionals: the next word is an argument.
    if (path && (!node?.group || (node.args.length > 0))) return null;
    const key = path ? `${path} ${tok}` : tok;
    const resolved = byPath.has(key) ? key : aliasOf.get(key);
    if (!resolved) return key;
    path = resolved;
  }
  return null;
}

export function mentions(span: string): string[][] {
  const out: string[][] = [];
  // A command, not prose: `dreamcontext` opens the span (after `$ ` or `npx `) or follows a shell
  // separator. "what dreamcontext should have done" inside a code block is a sentence.
  for (const m of span.matchAll(/(?:^\s*(?:\$\s+)?(?:npx\s+)?|(?:&&|\|\||[|;]|\$\()\s*)dreamcontext((?:[ \t]+[^\s`]+)+)/g)) {
    out.push(m[1].trim().split(/[ \t]+/));
  }
  return out;
}

describe('commands named in instruction text exist', () => {
  const manifest = buildCliManifest(createProgram());
  const byPath = new Map(manifest.endpoints.map((e) => [e.path, e]));
  const aliasOf = new Map<string, string>();
  for (const e of manifest.endpoints) {
    const parent = e.path.split(' ').slice(0, -1).join(' ');
    for (const a of e.aliases ?? []) aliasOf.set(parent ? `${parent} ${a}` : a, e.path);
  }

  const found: string[] = [];
  let checked = 0;
  for (const abs of instructionFiles()) {
    const rel = relative(ROOT, abs);
    for (const { line, span } of codeSpans(readFileSync(abs, 'utf-8'))) {
      for (const tokens of mentions(span)) {
        checked++;
        const dead = deadPath(tokens, byPath, aliasOf);
        if (dead) found.push(`${rel}:${line}: dreamcontext ${dead}`);
      }
    }
  }

  it('scans a real corpus', () => {
    expect(checked).toBeGreaterThan(500);
  });

  it('names no command path the CLI does not have', () => {
    const known = (f: string) => KNOWN_DEAD.some((k) => f.replace(/:\d+:/, ':') === k);
    expect(found.filter((f) => !known(f))).toEqual([]);
  });

  it('the walk catches a dead subcommand and passes a live one and its arguments', () => {
    expect(deadPath(['features', 'list'], byPath, aliasOf)).toBe('features list');
    expect(deadPath(['tasks', 'create', 'x'], byPath, aliasOf)).toBeNull();
    expect(deadPath(['memory', 'recall', 'anything', 'here'], byPath, aliasOf)).toBeNull();
    expect(deadPath(['<command>', '--help'], byPath, aliasOf)).toBeNull();
    expect(mentions('run `dreamcontext tasks create "x"` now')).toEqual([]);
    expect(mentions('-e "<what dreamcontext should have done>"')).toEqual([]);
    expect(mentions('cd x && dreamcontext tasks log a')).toEqual([['tasks', 'log', 'a']]);
    expect(mentions('// a board (dreamcontext indexes name + tags)')).toEqual([]);
    expect(mentions('S=$(dreamcontext builder review packet x)')).toEqual([['builder', 'review', 'packet', 'x)']]);
    expect(mentions('dreamcontext tasks create "x"')).toEqual([['tasks', 'create', '"x"']]);
  });
});
