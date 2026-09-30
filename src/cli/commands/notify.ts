import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { success, error, info } from '../../lib/format.js';
import { listVaults, type Vault } from '../../lib/vaults.js';
import {
  AppLinkError,
  buildAppLink,
  brainRelativePath,
  findRegisteredVault,
  isValidAppLink,
  isValidLinkPath,
  type AppLinkTarget,
} from '../../lib/app-link.js';
import {
  buildNotifierApp,
  notifierAppPath,
  notifierScriptCurrent,
  notifyViaBundle,
  NOTIFY_SOUND_OK,
  type BuildNotifierResult,
} from '../../lib/automations/notifier.js';

/**
 * `dreamcontext notify <title> [body]` — post a routable macOS banner from anywhere.
 *
 * The banner goes through the same branded applet the automations use, and its click opens a
 * `dreamcontext://` link, so a Claude Code hook (Stop, Notification) can say WHICH project and
 * WHICH chat instead of only raising the app. No `ensureContextRoot` anywhere on this path: a
 * hook or a CI step may run in a checkout with no brain, and the vault comes from the registry.
 *
 * Unlike the automation completion path, this BUILDS the applet when it is missing (or stale),
 * because a human is plausibly watching, and says the permission line on that first post:
 * macOS files an unauthorised banner invisibly and still exits 0. Exits 1 when nothing was
 * posted, so a workflow can branch on it. A non-macOS host is a no-op that exits 0.
 */

const SOUND_RE = /^[A-Za-z0-9 _-]{1,64}$/;
const BODY_MAX_CHARS = 240;
const STDIN_MAX_BYTES = 1_048_576;

export interface NotifyCliOptions {
  vault?: string;
  session?: string;
  automation?: string;
  file?: string;
  link?: string;
  sessionStdin?: boolean;
  sound?: string;
}

/** The fields of a Claude Code hook payload this command reads. */
export interface HookPayload {
  session_id?: unknown;
  cwd?: unknown;
  message?: unknown;
}

export interface NotifyDeps {
  home?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  /** The parsed stdin hook payload, when `--session-stdin` was passed. */
  hookPayload?: HookPayload | null;
  build?: (home: string) => BuildNotifierResult;
  post?: typeof notifyViaBundle;
  log?: (line: string) => void;
}

export interface NotifyOutcome {
  posted: boolean;
  /** The link the banner carries (null only when nothing was composed). */
  link: string | null;
  /** The fallback file the click opens when no app claims the link. */
  file: string | null;
  /** Why nothing was posted, or a note for a no-op. Null on a plain success. */
  reason: string | null;
  exitCode: 0 | 1;
}

/** A refusal with a reason the user can act on. */
class NotifyUsageError extends Error {}

function resolveVault(opts: NotifyCliOptions, cwd: string, home: string, payloadCwd: string | null): Vault | null {
  if (opts.vault !== undefined) {
    // A registered NAME only, never a path: the value ends up in a link the app routes.
    const named = listVaults(home).find((v) => v.name === opts.vault);
    if (named) return named;
    throw new NotifyUsageError(`"${opts.vault}" is not a registered vault (see \`dreamcontext vaults list\`).`);
  }
  return findRegisteredVault(payloadCwd ?? cwd, home);
}

function requireVault(vault: Vault | null, flag: string): Vault {
  if (vault) return vault;
  throw new NotifyUsageError(`${flag} needs a registered vault: pass --vault, or run inside a registered project.`);
}

/** The project-relative form of `file` when it sits inside the vault, else null. */
function projectRelative(vault: Vault, file: string): string | null {
  const rel = relative(resolve(vault.path), file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const posix = rel.split(sep).join('/');
  return isValidLinkPath(posix) ? posix : null;
}

/** Compose the banner's link from the flags. Throws NotifyUsageError / AppLinkError. */
export function composeNotifyLink(
  opts: NotifyCliOptions,
  env: { cwd: string; home: string; hookPayload: HookPayload | null },
): { link: string; file: string | null } {
  const payloadSession = typeof env.hookPayload?.session_id === 'string' ? env.hookPayload.session_id : null;
  const payloadCwd = typeof env.hookPayload?.cwd === 'string' ? env.hookPayload.cwd : null;
  if (opts.sessionStdin && !payloadSession) {
    throw new NotifyUsageError('--session-stdin read no session_id from the hook payload on stdin.');
  }
  const session = opts.session ?? payloadSession;
  const file = opts.file ? resolve(env.cwd, opts.file) : null;

  if (opts.link !== undefined) {
    if (session || opts.automation) throw new NotifyUsageError('--link cannot be combined with --session or --automation.');
    if (!isValidAppLink(opts.link)) throw new NotifyUsageError(`"${opts.link}" is not a valid dreamcontext:// link.`);
    return { link: opts.link, file };
  }
  if (session && opts.automation) throw new NotifyUsageError('Pass --session or --automation, not both.');

  const vault = resolveVault(opts, env.cwd, env.home, payloadCwd);
  let target: AppLinkTarget;
  if (session) {
    target = { kind: 'session', vault: requireVault(vault, '--session').name, claudeId: session };
  } else if (opts.automation) {
    const v = requireVault(vault, '--automation');
    const rel = file ? brainRelativePath(join(v.path, '_dream_context'), file) : null;
    target = { kind: 'automation', vault: v.name, slug: opts.automation, file: rel };
  } else if (file && vault && projectRelative(vault, file)) {
    target = { kind: 'view', vault: vault.name, path: projectRelative(vault, file) as string };
  } else if (opts.vault !== undefined && vault) {
    target = { kind: 'project', vault: vault.name };
  } else {
    // No in-app place: the Notifications window, which lists this banner.
    target = { kind: 'inbox' };
  }
  return { link: buildAppLink(target), file };
}

function capBody(body: string): string {
  const flat = body.trim();
  return flat.length <= BODY_MAX_CHARS ? flat : `${flat.slice(0, BODY_MAX_CHARS - 1).trimEnd()}…`;
}

/** Make sure a current applet exists. Returns a refusal reason, or null when ready. */
function ensureApplet(home: string, build: (home: string) => BuildNotifierResult, log: (l: string) => void): string | null {
  const present = existsSync(notifierAppPath(home));
  if (present && notifierScriptCurrent(home)) return null;
  const built = build(home);
  if (!built.built) return `the notifier could not be built (${built.reason ?? 'unknown reason'})`;
  if (!present) {
    // First use: macOS files an unauthorised banner silently, so say it while someone looks.
    log(chalk.dim('  The dreamcontext notifier was installed. If macOS asks for permission, choose Allow:'));
    log(chalk.dim('  until you do, banners are filed silently in Notification Centre and never appear.'));
  }
  return null;
}

/** The whole command, minus argv and stdin, so a test can drive it with an injected home. */
export function runNotify(title: string, body: string | undefined, opts: NotifyCliOptions, deps: NotifyDeps = {}): NotifyOutcome {
  const home = deps.home ?? homedir();
  const log = deps.log ?? ((line: string) => console.log(line));
  const hookPayload = deps.hookPayload ?? null;
  if (!title.trim()) return { posted: false, link: null, file: null, reason: 'the title is empty', exitCode: 1 };
  if (opts.sound !== undefined && opts.sound !== 'none' && !SOUND_RE.test(opts.sound)) {
    return { posted: false, link: null, file: null, reason: `"${opts.sound}" is not a system sound name`, exitCode: 1 };
  }

  let composed: { link: string; file: string | null };
  try {
    composed = composeNotifyLink(opts, { cwd: deps.cwd ?? process.cwd(), home, hookPayload });
  } catch (err) {
    if (err instanceof NotifyUsageError || err instanceof AppLinkError) {
      return { posted: false, link: null, file: null, reason: err.message, exitCode: 1 };
    }
    throw err;
  }
  if ((deps.platform ?? process.platform) !== 'darwin') {
    return { posted: false, ...composed, reason: 'banners are macOS-only; nothing to do here', exitCode: 0 };
  }

  const refusal = ensureApplet(home, deps.build ?? ((h) => buildNotifierApp(h)), log);
  if (refusal) return { posted: false, ...composed, reason: refusal, exitCode: 1 };

  const hookMessage = typeof hookPayload?.message === 'string' ? hookPayload.message : '';
  const sound = opts.sound === 'none' ? undefined : (opts.sound ?? NOTIFY_SOUND_OK);
  const posted = (deps.post ?? notifyViaBundle)(title.trim(), capBody(body ?? hookMessage), home, {
    sound, link: composed.link, openTarget: composed.file,
  });
  return posted
    ? { posted: true, ...composed, reason: null, exitCode: 0 }
    : { posted: false, ...composed, reason: 'the notifier did not accept the banner', exitCode: 1 };
}

/** Read and parse a Claude Code hook payload from stdin (bounded). */
export async function readHookPayload(stream: NodeJS.ReadableStream = process.stdin): Promise<HookPayload | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > STDIN_MAX_BYTES) return null;
    chunks.push(buf);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as HookPayload) : null;
  } catch {
    return null;
  }
}

export function registerNotifyCommand(program: Command): void {
  program
    .command('notify <title> [body]')
    .description('Post a macOS banner whose click opens the exact place in the dreamcontext app')
    .option('--vault <name>', 'Registered vault the banner belongs to (default: the vault containing the cwd)')
    .option('--session <claudeId>', 'Open this Claude Code chat when clicked')
    .option('--automation <slug>', "Open this automation's thread when clicked")
    .option('--file <path>', 'The document the banner is about (opened in the viewer, and the fallback)')
    .option('--link <url>', 'An explicit dreamcontext:// link to open when clicked')
    .option('--session-stdin', 'Read a Claude Code hook payload (session_id, cwd) from stdin')
    .option('--sound <name>', `System sound name, or "none" (default: ${NOTIFY_SOUND_OK})`)
    .action(async (title: string, body: string | undefined, opts: NotifyCliOptions) => {
      let hookPayload: HookPayload | null = null;
      if (opts.sessionStdin) {
        if (process.stdin.isTTY) {
          error('--session-stdin expects a Claude Code hook payload piped on stdin.');
          process.exitCode = 1;
          return;
        }
        hookPayload = await readHookPayload();
      }
      const outcome = runNotify(title, body, opts, { hookPayload });
      if (outcome.posted) {
        success(`Posted: ${title.trim()}`);
        if (outcome.link) info(chalk.dim(`Click opens ${outcome.link}`));
      } else if (outcome.exitCode === 0) {
        info(chalk.dim(`Not posted: ${outcome.reason}.`));
      } else {
        error(`Nothing was posted: ${outcome.reason}.`);
      }
      process.exitCode = outcome.exitCode;
    });
}
