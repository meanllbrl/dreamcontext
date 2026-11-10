/**
 * Routine results through the member's own bot (plan V, W4-W6, Y2-Y3, Z2-Z3, AA3; W2 lane A).
 *
 * Runs in the RUNNER's process (the launchd CLI or the server's job host), so it never imports
 * `src/server`, never polls (`getUpdates` stays the hub's), and works while the app is quit.
 *
 * What a member bot sends from a routine, and only for a SCHEDULED fire of a routine whose
 * manifest `agent` is that member, bound and hash-verified on this Mac (the shared binding reader):
 *  - `ok` + opted in (forward.json `{projectKey, slug, approvalHash}` equal to the routine's
 *    current manifest hash): the run's stamp-verified `agent` posts (format.ts, fences as one
 *    "Mac'te" line), their summary rows, the `result` line, and up to 4 files through the
 *    outbound rules;
 *  - a proposal or report waiting for his verdict + opted in: "✋ <başlık>: Mac'te kararını bekliyor";
 *  - `failed` / `timeout` (usage limit included): "Rutin çalışamadı: <neden>", opted in or not;
 *  - a run that stopped to ask him (a no-choice question): the question text, opted in or not.
 * Nothing else. A run post counts only if the parent verified its stamp (HMAC with the run's own
 * key, never on disk), so a synced teammate entry, a forged `via:'runner'` entry or an unstamped
 * post is never sent. Nothing about the binding enters the routine's prompt or environment except
 * the per-run stamp key.
 *
 * Sending: built inside `finalize`, run AFTER the run lock is released; 15 s per request, 120 s per
 * send, 3 retries (1 s, 4 s, 10 s). A failure is one dispatcher-log line and never changes the run.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { memberScope } from '../agents/scope.js';
import { projectKey } from '../local-store.js';
import { isContainedBrainRel, resolvesInsideBrain, threadEntryContentHash } from '../automations/threads.js';
import type { ThreadEntry } from '../automations/types.js';
import { bindingDir, readBinding, readForward, scopeOfContextRoot } from './config.js';
import { formatAskQuestionHtml } from './ask-format.js';
import { escapeHtml, redactSecrets, toTelegramMessages, wouldRedact } from './format.js';
import { readOutbound, type OutboundFile } from './files.js';
import { TelegramTransport, type FetchLike } from './transport.js';

/** The env var the runner hands its child (Claude and Codex alike: Codex's default
 *  `shell_environment_policy` drops names containing KEY, Z3). */
export const RUN_POST_STAMP_ENV = 'DREAMCONTEXT_RUN_POST_STAMP';

/** A fresh 256-bit key for one run. Lives in the runner's memory and the child's env only. */
export function mintRunPostKey(): string {
  return randomBytes(32).toString('hex');
}

/** HMAC(key, id + content hash), hex. */
export function runPostStamp(key: string, id: string, contentHash: string): string {
  return createHmac('sha256', key).update(`${id}\n${contentHash}`).digest('hex');
}

/** The run's `agent` posts whose stamp the parent can verify (content re-hashed as read back). */
export function verifiedRunPosts(entries: readonly ThreadEntry[], runId: string, key: string | null): Set<string> {
  const out = new Set<string>();
  if (!key) return out;
  for (const e of entries) {
    if (e.runId !== runId || e.kind !== 'agent' || typeof e.stamp !== 'string') continue;
    if (e.stamp === runPostStamp(key, e.id, threadEntryContentHash(e))) out.add(e.id);
  }
  return out;
}

export interface ForwardInput {
  contextRoot: string;
  slug: string;
  title: string;
  /** The routine's member (manifest `agent`); none = the project's Super bot (super-rutin). */
  agent: string | null | undefined;
  /** A plain automation's approved `reply:` (only `telegram` opts it in). Ignored for a member,
   *  whose opt-in is its bot's `forward.json`. */
  reply?: string | null;
  /** Whether he is away from the Mac (`ownerAwayNow`): a plain automation's question goes to the
   *  Super bot only then (owner 2026-11-09). Absent = at the Mac. */
  away?: () => boolean;
  /** The routine's current manifest hash (its approval entry's `manifestSha256`). */
  approvalHash: string;
  status: string;
  error: string | null;
  /** A proposal / report waiting for his verdict (plan W4, Y2). */
  reviewPending: boolean;
  /** A run that stopped to ask him: the question's text. */
  question?: string | null;
  /** The published document's headline, from the runner's memory (never the thread file). */
  resultText?: string | null;
  /** Only scheduled fires forward (Y2): never an ask, an app, a task, a board, a light job. */
  scheduled: boolean;
  runId: string;
  entries: readonly ThreadEntry[];
  verified: ReadonlySet<string>;
  home?: string;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const REQUEST_MS = 15_000;
const BUDGET_MS = 120_000;
const BACKOFF = [1_000, 4_000, 10_000];

/** Plain one-line text for a title or a reason: control characters out, capped, redacted. */
function line(raw: string, max = 300): string {
  return redactSecrets(String(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max);
}

const MEDIA = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const TEXT_DOC = /\.(md|txt|csv|json|html?)$/i;

/**
 * The send for one finished run, or null when nothing goes. Pure up to reading the binding and
 * forward.json (both through the shared, symlink-refusing reader).
 */
export function buildRoutineForward(input: ForwardInput): (() => Promise<void>) | null {
  if (!input.scheduled) return null;
  const home = input.home ?? homedir();
  // A member with its own bot: that bot, opted in by forward.json (native confirm). Anything else,
  // a plain automation or a member with no bot (super-rutin): the project's Super bot, its results
  // opted in by an approved `reply: telegram` (approval with the owner's consent,
  // `ApprovalEntry.consent`), its failures always. One sender for both.
  let scope = scopeOfContextRoot(input.contextRoot);
  let target = 'super';
  let viaSuper = true;
  if (input.agent) {
    const where = memberScope(input.contextRoot, input.agent, home);
    const memberScopeKey = where === 'global' ? 'global' : scopeOfContextRoot(input.contextRoot);
    const own = where ? readBinding(memberScopeKey, input.agent, home) : null;
    if (own && (own.ok || own.reason !== 'absent')) {
      scope = memberScopeKey;
      target = input.agent;
      viaSuper = false;
    }
  }
  const failed = input.status === 'failed' || input.status === 'timeout';
  const asked = !!input.question && input.status.startsWith('awaiting');
  const optedIn = viaSuper
    ? input.reply === 'telegram'
    : readForward(bindingDir(scope, target, home), home).routines.some((r) => r.projectKey === projectKey(dirname(input.contextRoot)) && r.slug === input.slug && r.approvalHash === input.approvalHash);
  // Through the Super bot a question goes only while he is away (owner 2026-11-09); failures always.
  if (viaSuper && !failed && asked && !(input.away?.() ?? false)) return null;
  const b = readBinding(scope, target, home);
  if (!b.ok) {
    if (b.reason === 'tamper') input.log?.(`telegram forward ${input.slug}: binding not written by the hub; nothing sent`);
    else if (viaSuper && optedIn) input.log?.(`telegram forward ${input.slug}: Telegram'a gitmedi: bu projenin Super botu bağlı değil`);
    return null;
  }
  const binding = b.binding;
  const title = line(input.title || input.slug, 120);

  const messages: string[] = [];
  const files: OutboundFile[] = [];
  if (failed) {
    messages.push(`⚠ <b>${escapeHtml(title)}</b>: Rutin çalışamadı: ${escapeHtml(line(input.error ?? input.status))}`);
  } else if (asked) {
    messages.push(formatAskQuestionHtml({ question: line(input.question!, 1500) }, { title }));
    if (viaSuper) messages.push(escapeHtml("Cevabı Mac'te, Agents sayfasında verirsin."));
  } else if (input.reviewPending) {
    if (!optedIn) return null;
    messages.push(`✋ <b>${escapeHtml(title)}</b>: Mac'te kararını bekliyor`);
  } else if (input.status === 'ok') {
    if (!optedIn) return null;
    const posts = input.entries.filter((e) => e.runId === input.runId && e.kind === 'agent' && input.verified.has(e.id));
    const result = input.resultText?.trim() ? line(input.resultText, 300) : null;
    if (!posts.length && !result) return null;
    const body: string[] = [`**${title}**`];
    for (const p of posts) {
      if (p.text.trim()) body.push(p.text);
      for (const row of p.summary ?? []) body.push(`- ${row.key}: ${row.value}`);
    }
    if (result) body.push(`_${result}_`);
    messages.push(...toTelegramMessages(body.join('\n\n'), { codeFences: 'mac', fold: true }));
    const projectRoot = dirname(input.contextRoot);
    const paths = posts.flatMap((p) => p.files ?? []).slice(0, 4);
    for (const rel of paths) {
      const name = rel.split('/').pop() ?? rel;
      // Re-checked at send time: inside the brain (global member: its own folder), then the outbound rules.
      if (isAbsolute(rel) || !isContainedBrainRel(input.contextRoot, rel)) { messages.push(escapeHtml(`Mac'te: ${name}`)); continue; }
      const abs = resolve(input.contextRoot, rel);
      if (!resolvesInsideBrain(input.contextRoot, abs)) { messages.push(escapeHtml(`Mac'te: ${name}`)); continue; }
      const r = readOutbound(abs, { roots: [projectRoot], projectRoot, maxBytes: 20 * 1024 * 1024 });
      if (!r.ok) { messages.push(escapeHtml(`Mac'te: ${name}`)); continue; }
      if (TEXT_DOC.test(name) && wouldRedact(r.file.data.toString('utf-8'))) { messages.push(escapeHtml(`Mac'te: ${name}`)); continue; }
      files.push(r.file);
    }
  } else {
    return null;
  }

  return async () => {
    const t = new TelegramTransport({ token: binding.token, fetchImpl: input.fetchImpl, timeoutMs: REQUEST_MS });
    const started = Date.now();
    const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => { const h = setTimeout(r, ms); h.unref?.(); }));
    const attempt = async (fn: () => Promise<unknown>): Promise<boolean> => {
      for (let i = 0; i <= BACKOFF.length; i++) {
        if (Date.now() - started > BUDGET_MS) return false;
        try { await fn(); return true; } catch (err) {
          if (i === BACKOFF.length) { input.log?.(`telegram forward ${input.slug}: ${line((err as Error).message, 200)}`); return false; }
          await sleep(BACKOFF[i]);
        }
      }
      return false;
    };
    for (const html of messages) if (!(await attempt(() => t.sendMessage(binding.chatId, html)))) return;
    for (const f of files) {
      const upload = { name: f.name, data: f.data };
      await attempt(() => (MEDIA.test(f.name) ? t.sendPhoto(binding.chatId, upload) : VIDEO.test(f.name) ? t.sendVideo(binding.chatId, upload) : t.sendDocument(binding.chatId, upload)));
    }
  };
}

/** Where a test or the server can find a binding's forward list. */
export function forwardDirOf(contextRoot: string, agent: string, home: string = homedir()): string | null {
  const where = memberScope(contextRoot, agent, home);
  if (!where) return null;
  return bindingDir(where === 'global' ? 'global' : scopeOfContextRoot(contextRoot), agent, home);
}

