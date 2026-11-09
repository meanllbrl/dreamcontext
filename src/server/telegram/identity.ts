/**
 * A bound bot carries its member's identity in Telegram: the name the app shows (its title), a
 * short line from its role, and its photo (Bot API `setMyName`, `setMyShortDescription`,
 * `setMyDescription`, `setMyProfilePhoto`), each set with THAT bot's own token.
 *
 * Idempotent: what was last set lives in `identity.json` beside the binding, so a hub start only
 * calls Telegram for what differs (the name call is rate-limited hard). A failure never breaks a
 * bind: the field stays unset (retried next time) and the status row says it in one line.
 *
 * What leaves the Mac: the title, the project's folder name, and the photo the owner chose. Never
 * the prompt or the soul (a bot's description is visible to anyone who opens it).
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgent, readGlobalAgent } from '../../lib/agents/store.js';
import { resolveAutomationPhoto } from '../../lib/automations/store.js';
import { bindingDir, readTelegramJson, writeTelegramJson } from '../../lib/telegram/config.js';
import type { TelegramScope, TelegramTarget } from '../../lib/telegram/contract.js';
import type { TelegramTransport } from '../../lib/telegram/transport.js';

/** Telegram's limits (Bot API: name 0-64, short description 0-120, description 0-512). */
export const TG_NAME_MAX = 64;
const TG_SHORT_MAX = 120;
const TG_DESC_MAX = 512;
/** A face, not a film: anything bigger is not sent. */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export type IdentityIssue = 'name' | 'photo';

/** Cut to `max` characters at a word boundary, with an ellipsis; never splits a surrogate pair. */
export function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (chars.length <= max) return chars.join('');
  const head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  const cut = space >= Math.floor(max / 2) ? head.slice(0, space) : head;
  return `${cut.replace(/[\s·,;:.-]+$/u, '')}…`;
}

export interface MemberIdentity {
  name: string;
  shortDescription: string;
  description: string;
  /** Absolute path of the member's photo (through the photo gate), or null. */
  photo: string | null;
}

/**
 * What a target's bot should carry. The Super keeps `Super · <project>`; a member takes its title
 * (the role after a `·` in it becomes the short line). Null when the member cannot be read.
 */
export function identityFor(
  where: { scope: TelegramScope; target: TelegramTarget; contextRoot: string | null; projectName: string },
  home: string,
): MemberIdentity | null {
  const project = where.projectName;
  if (where.target === 'super') {
    return {
      name: clip(`Super · ${project}`, TG_NAME_MAX),
      shortDescription: clip(`${project} projesinin Super ajanı.`, TG_SHORT_MAX),
      description: clip(`${project} projesinin Super ajanı. Yalnız sahibine cevap verir; yazdığın Mac'teki Super sohbetine gider.`, TG_DESC_MAX),
      photo: null,
    };
  }
  if (where.scope !== 'global' && !where.contextRoot) return null;
  let agent;
  try {
    agent = where.scope === 'global'
      ? readGlobalAgent(where.target, home)
      : getAgent(where.contextRoot!, where.target, home);
  } catch { agent = null; }
  if (!agent) return null;
  const title = agent.title.trim() || where.target;
  const role = title.includes('·') ? title.slice(title.indexOf('·') + 1).trim() : '';
  const team = project ? `${project} projesinin AI Team üyesi` : 'AI Team üyesi';
  let photo: string | null = null;
  if (where.contextRoot && agent.scope !== 'global') {
    try { photo = resolveAutomationPhoto(where.contextRoot, agent.photo); } catch { photo = null; }
  }
  return {
    name: clip(title, TG_NAME_MAX),
    shortDescription: clip(role ? `${role} · ${team}.` : `${team}.`, TG_SHORT_MAX),
    description: clip(`${title}: ${team}. Yalnız sahibine cevap verir.`, TG_DESC_MAX),
    photo,
  };
}

/** The display name a creation link or a first message uses: the title, else the slug. */
export function displayNameFor(
  where: { scope: TelegramScope; target: TelegramTarget; contextRoot: string | null; projectName: string },
  home: string,
): string {
  return identityFor(where, home)?.name ?? clip(where.target, TG_NAME_MAX);
}

// ─── What was last set ──────────────────────────────────────────────────────

interface IdentityState {
  v: 1;
  botId: number;
  name?: string;
  shortDescription?: string;
  description?: string;
  /** sha256 of the photo's SOURCE bytes; '' = no photo was set by us. */
  photoHash?: string;
  issue?: IdentityIssue;
}

function readState(file: string, home: string, botId: number): IdentityState {
  const r = readTelegramJson(file, home);
  const v = r.ok ? r.value as Partial<IdentityState> : null;
  if (!v || v.v !== 1 || v.botId !== botId) return { v: 1, botId };
  return {
    v: 1, botId,
    ...(typeof v.name === 'string' ? { name: v.name } : {}),
    ...(typeof v.shortDescription === 'string' ? { shortDescription: v.shortDescription } : {}),
    ...(typeof v.description === 'string' ? { description: v.description } : {}),
    ...(typeof v.photoHash === 'string' ? { photoHash: v.photoHash } : {}),
    ...(v.issue === 'name' || v.issue === 'photo' ? { issue: v.issue } : {}),
  };
}

/** The one-line issue for the status row, or undefined. */
export function identityIssue(scope: TelegramScope, target: TelegramTarget, botId: number, home: string): IdentityIssue | undefined {
  try { return readState(join(bindingDir(scope, target, home), 'identity.json'), home, botId).issue; } catch { return undefined; }
}

// ─── The photo ──────────────────────────────────────────────────────────────

/** The photo's bytes, read without following a link, capped. Null when unreadable. */
function readPhoto(path: string): Buffer | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0 || st.size > PHOTO_MAX_BYTES) return null;
    return readFileSync(fd);
  } catch { return null; } finally { closeSync(fd); }
}

const isJpeg = (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Telegram takes a static profile photo as JPG only: a PNG/WebP/GIF goes through macOS `sips`. */
export type JpegConverter = (src: Buffer) => Promise<Buffer | null>;

export const sipsToJpeg: JpegConverter = async (bytes) => {
  if (process.platform !== 'darwin') return null;
  const dir = mkdtempSync(join(tmpdir(), 'dc-tg-photo-'));
  const src = join(dir, 'source');
  const out = join(dir, 'photo.jpg');
  try {
    writeFileSync(src, bytes, { mode: 0o600, flag: 'wx' });
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '1024', src, '--out', out], { timeout: 20_000 }, (err) => (err ? reject(err) : resolve()));
    });
    const buf = readPhoto(out);
    return buf && isJpeg(buf) ? buf : null;
  } catch { return null; } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ─── Sync ───────────────────────────────────────────────────────────────────

/**
 * Sets on Telegram whatever differs from what was last set. Never throws.
 * Returns the issue left (or undefined when everything is in place).
 */
export async function syncBotIdentity(
  bot: { scope: TelegramScope; target: TelegramTarget; botId: number; transport: TelegramTransport; contextRoot: string | null; projectName: string },
  home: string,
  toJpeg: JpegConverter = sipsToJpeg,
  /** False once the binding is removed or replaced: nothing more is sent or written. */
  live: () => boolean = () => true,
): Promise<IdentityIssue | undefined> {
  let file: string;
  try { file = join(bindingDir(bot.scope, bot.target, home), 'identity.json'); } catch { return undefined; }
  const want = identityFor(bot, home);
  if (!want) return undefined;
  const state = readState(file, home, bot.botId);
  const before = JSON.stringify(state);
  let nameFailed = false;
  let photoFailed = false;
  const t = bot.transport;

  if (state.name !== want.name) {
    try { await t.call('setMyName', { name: want.name }); state.name = want.name; } catch { nameFailed = true; }
  }
  if (state.shortDescription !== want.shortDescription) {
    try { await t.call('setMyShortDescription', { short_description: want.shortDescription }); state.shortDescription = want.shortDescription; } catch { nameFailed = true; }
  }
  if (state.description !== want.description) {
    try { await t.call('setMyDescription', { description: want.description }); state.description = want.description; } catch { nameFailed = true; }
  }

  // The photo: only one we set ourselves is ever removed (a photo set in BotFather by hand stays).
  const src = want.photo ? readPhoto(want.photo) : null;
  const hash = src ? createHash('sha256').update(src).digest('hex') : '';
  if (src && state.photoHash !== hash) {
    const jpg = isJpeg(src) ? src : await toJpeg(src);
    if (!jpg) photoFailed = true;
    else if (live()) {
      try {
        await t.upload('setMyProfilePhoto', { photo: { type: 'static', photo: 'attach://avatar' } }, { avatar: { data: jpg, name: 'avatar.jpg', contentType: 'image/jpeg' } });
        state.photoHash = hash;
      } catch { photoFailed = true; }
    }
  } else if (!src && state.photoHash) {
    try { await t.call('removeMyProfilePhoto'); state.photoHash = ''; } catch { photoFailed = true; }
  }

  const issue: IdentityIssue | undefined = nameFailed ? 'name' : photoFailed ? 'photo' : undefined;
  if (issue) state.issue = issue; else delete state.issue;
  if (JSON.stringify(state) !== before && live()) {
    try { writeTelegramJson(file, state, home); } catch { /* next start tries again */ }
  }
  if (issue) console.warn(`[telegram] could not set the ${issue} of the ${bot.target} bot`);
  return issue;
}
