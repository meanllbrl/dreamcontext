/**
 * What size of grant a call may take (plan uye-bildirim K3, "What an always-rule can be").
 *
 * An always-rule (`job`, `member`) allows only what the owner saw, and what it names to run cannot
 * be swapped under it. So eligibility is an ALLOWLIST of forms, never a list of dangerous
 * programs: a shell command is eligible only when it IS one interpreter from a closed list, then
 * one pinned script, then plain arguments. A wrapper, a module runner, a test runner or `git`
 * is not that form, so it cannot slip through a list nobody kept current. Everything else is
 * Allow once, and the reason says so in words a card can show.
 *
 * Pure: every look at the disk goes through the `Resolver` the caller passes in, so the table is
 * a table and the enforcers re-run the same function at match time with the real one.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import nodePath, { delimiter, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { outwardAction } from '../super/owed.js';
import { bypassNeedsOwner } from '../t3-bridge/policy.js';
import { memberFileWriteTarget } from '../agents/member-file-guard.js';
import { redactSecrets } from '../telegram/format.js';
import { SHELL_TOOLS, canonicalInput, inputRecord } from './canonical.js';
import type { GrantForm, GrantScope, ScriptPin } from './types.js';

export const INTERPRETERS = ['node', 'python3', 'bash', 'sh', 'tsx'] as const;

/** Programs that run another program: in front of an interpreter they change what runs. */
const WRAPPERS = new Set(['env', 'timeout', 'gtimeout', 'nice', 'nohup', 'sudo', 'doas', 'xargs', 'command', 'exec', 'time', 'caffeinate', 'arch', 'stdbuf']);

/** Classifier categories never offered an always-rule, each with its card line. */
const NEVER_CATEGORIES: Readonly<Record<string, string>> = {
  production_deploy: 'It deploys to production, so it can be allowed once only.',
  credential_materialization: 'It reads or creates credentials, so it can be allowed once only.',
  secret_store_writes: 'It writes to a secret store, so it can be allowed once only.',
};
/**
 * Classifier categories known to be safe for an always-rule. Empty until the categories are
 * measured on a real classifier block (premise step 1 could not provoke one): an unknown
 * category is never read as safe.
 */
export const SAFE_CATEGORIES: ReadonlySet<string> = new Set<string>();

export interface Resolver {
  /** Where a bare program name resolves on PATH, or null. */
  which(name: string): string | null;
  realpath(p: string): string | null;
  /** True only for a regular file (never a directory, a device or a dangling link). */
  isRegularFile(p: string): boolean;
  sha256(p: string): string | null;
}

export interface EligibleCtx {
  /** Real path of the project root. */
  project: string;
  /** Agent-writable roots: the project, linked repos, temp folders. */
  roots: string[];
  /** The classifier's category of the refusal, when there was one. */
  category?: string;
  /** The session's working folder (default: the project), for a relative script path. */
  cwd?: string;
  /** The home the guards read (tests); default the real one. */
  home?: string;
  resolve: Resolver;
}

export type Eligibility =
  | { ok: true; form: GrantForm; script?: ScriptPin }
  | { ok: false; reason: string };

const REASON = {
  notShell: 'This tool can be allowed once or for this job, not always.',
  argvShell: 'This command can be allowed once only.',
  shellSyntax: 'The command uses shell syntax (a pipe, a redirect, quotes, a variable or a substitution), so it can be allowed once only.',
  newline: 'The command spans more than one line, so it can be allowed once only.',
  control: 'The command holds hidden or control characters, so it can be allowed once only.',
  secret: 'The command holds a secret, so it can be allowed once only.',
  wrapper: 'Another program runs in front of the interpreter, so it can be allowed once only.',
  assignment: 'An environment setting comes before the interpreter, so it can be allowed once only.',
  interpreterPath: 'The interpreter is given as a path, so it can be allowed once only.',
  notInterpreter: 'Only a script run by node, python3, bash, sh or tsx can be allowed always; this command can be allowed once.',
  noScript: 'No script follows the interpreter, so it can be allowed once only.',
  option: 'An option comes before the script, so it can be allowed once only.',
  noInterpreter: 'The interpreter was not found on this Mac, so it can be allowed once only.',
  plantedInterpreter: 'The interpreter resolves inside a folder agents can write to, so it can be allowed once only.',
  scriptMissing: 'The script is not a regular file, so it can be allowed once only.',
  scriptOutside: 'The script is outside the project and its linked folders, so it can be allowed once only.',
  outward: 'It sends something off this Mac, so it can be allowed once only.',
  guarded: 'It writes a protected file, so it can be allowed once only.',
  store: 'It touches the owner\'s permission store, so it can be allowed once only.',
  unknownCategory: 'The safety check flagged it for a reason this card does not know, so it can be allowed once only.',
} as const;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const BIDI_RE = /[؜​-‏‪-‮⁠-⁩﻿]/;
/** Anything a shell would read as more than a plain word. */
const SHELL_SYNTAX_RE = /[|&;<>()$`\\"'*?[\]{}~!#]/;
/** A plain argument: no character a shell expands or splits on. */
const PLAIN_WORD_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function inside(p: string, root: string): boolean {
  if (!root) return false;
  const r = root.endsWith(nodePath.sep) && root.length > 1 ? root.slice(0, -1) : root;
  return p === r || p.startsWith(r + nodePath.sep);
}

/** What the call touches that no rule may cover: the grant and approval stores themselves (G3). */
function touchesStore(text: string): boolean {
  return /\.dreamcontext[\\/]+(grants\b|automations\.json)/.test(text);
}

/**
 * Parse a shell command as the `script` form. Returns the pin, or the reason it is not that form.
 * Exported so the card can say why before anyone taps.
 */
export function scriptForm(command: string, ctx: EligibleCtx): { pin: ScriptPin } | { reason: string } {
  if (/[\r\n]/.test(command)) return { reason: REASON.newline };
  if (CONTROL_RE.test(command) || BIDI_RE.test(command)) return { reason: REASON.control };
  if (redactSecrets(command) !== command) return { reason: REASON.secret };
  const words = command.trim().split(/[ \t]+/).filter(Boolean);
  const head = words[0] ?? '';
  if (WRAPPERS.has(head)) return { reason: REASON.wrapper };
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return { reason: REASON.assignment };
  if (SHELL_SYNTAX_RE.test(command)) return { reason: REASON.shellSyntax };
  if (head.includes('/')) return { reason: REASON.interpreterPath };
  if (!(INTERPRETERS as readonly string[]).includes(head)) return { reason: REASON.notInterpreter };
  const script = words[1];
  if (!script) return { reason: REASON.noScript };
  if (script.startsWith('-')) return { reason: REASON.option };
  if (!words.every((w) => PLAIN_WORD_RE.test(w))) return { reason: REASON.shellSyntax };

  const roots = ctx.roots.map((r) => ctx.resolve.realpath(r) ?? r).filter(Boolean);
  const found = ctx.resolve.which(head);
  const interpreterPath = found ? ctx.resolve.realpath(found) : null;
  if (!found || !interpreterPath) return { reason: REASON.noInterpreter };
  // A listed name is only as good as where it lands: a `node` planted in the project is the
  // agent's own program.
  if ([found, interpreterPath].some((p) => roots.some((r) => inside(p, r)))) return { reason: REASON.plantedInterpreter };

  const base = ctx.cwd ?? ctx.project;
  const given = isAbsolute(script) ? script : resolvePath(base, script);
  const scriptPath = ctx.resolve.realpath(given);
  if (!scriptPath || !ctx.resolve.isRegularFile(scriptPath)) return { reason: REASON.scriptMissing };
  if (!roots.some((r) => inside(scriptPath, r))) return { reason: REASON.scriptOutside };
  const sha256 = ctx.resolve.sha256(scriptPath);
  if (!sha256) return { reason: REASON.scriptMissing };
  return { pin: { interpreter: head, interpreterPath, scriptPath, sha256 } };
}

/** The reason no always-rule may cover this call, whatever its form, or null. */
function neverAlways(tool: string, record: Record<string, unknown>, canonical: string, ctx: EligibleCtx): string | null {
  if (ctx.category !== undefined && ctx.category !== '') {
    const named = NEVER_CATEGORIES[ctx.category];
    if (named) return named;
    if (!SAFE_CATEGORIES.has(ctx.category)) return REASON.unknownCategory;
  }
  if (touchesStore(canonical)) return REASON.store;
  if (outwardAction(tool, record)) return REASON.outward;
  const cwd = ctx.cwd ?? ctx.project;
  if (bypassNeedsOwner(tool, record, cwd)) return REASON.guarded;
  const memberFile = ctx.home ? memberFileWriteTarget(tool, record, cwd, ctx.home) : memberFileWriteTarget(tool, record, cwd);
  if (memberFile) return REASON.guarded;
  if (redactSecrets(canonical) !== canonical) return REASON.secret;
  return null;
}

/**
 * May this call take a grant of this scope? `once` always may (the owner sees the exact call);
 * a once on a script form still pins the script, so a script rewritten after he tapped asks again.
 */
export function eligible(tool: string, input: unknown, scope: GrantScope, ctx: EligibleCtx): Eligibility {
  if (typeof tool !== 'string' || !tool) return { ok: false, reason: REASON.notShell };
  const record = inputRecord(tool, input);
  const canonical = canonicalInput(tool, input);

  if (scope === 'once') {
    if (tool === 'Bash') {
      const s = scriptForm(canonical, ctx);
      if ('pin' in s) return { ok: true, form: 'script', script: s.pin };
    }
    return { ok: true, form: 'exact' };
  }

  const never = neverAlways(tool, record, canonical, ctx);
  if (never) return { ok: false, reason: never };

  if (SHELL_TOOLS.has(tool)) {
    if (tool !== 'Bash') return { ok: false, reason: REASON.argvShell };
    const s = scriptForm(canonical, ctx);
    if ('reason' in s) return { ok: false, reason: s.reason };
    return { ok: true, form: 'script', script: s.pin };
  }

  // Any other tool: the exact input, and never as a member rule (a file tool or an MCP tool
  // named once for one job; an MCP rule by name is out of scope in v1).
  if (scope === 'member') return { ok: false, reason: REASON.notShell };
  return { ok: true, form: 'exact' };
}

// ─── The real resolver (the enforcers pass it in) ─────────────────────────────────────────────

/** Reads the disk the way `eligible` needs it; never throws (an unreadable thing is absent). */
export function realResolver(env: NodeJS.ProcessEnv = process.env): Resolver {
  return {
    which(name) {
      if (!name || name.includes('/')) return null;
      for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (!dir || !isAbsolute(dir)) continue;
        const p = join(dir, name);
        try {
          if (!statSync(p).isFile()) continue;
          accessSync(p, constants.X_OK);
          return p;
        } catch { /* not here */ }
      }
      return null;
    },
    realpath(p) {
      try { return realpathSync.native(p); } catch { return null; }
    },
    isRegularFile(p) {
      try { return statSync(p).isFile(); } catch { return false; }
    },
    sha256(p) {
      try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; }
    },
  };
}
