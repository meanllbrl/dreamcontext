/**
 * A member's own bot (plan "Members", A6, V1; W2 lane A): inbound and conversation replies only.
 * Routine results, failures and questions are sent by the runner process
 * (`src/lib/telegram/member-forward.ts`), never from here.
 *
 *  - An authorized text (and its files, dropped into the project like the Super path; a voice note
 *    transcribed and echoed) → `sayToAgent(contextRoot, {slug, text, via: 'telegram'})`: a job in
 *    the member's own thread, exactly as a message from the app.
 *  - Its answer: the member's `agent` posts in that run, sent back as they land, until the run
 *    ends (or 2 h).
 *  - At the machine's live-job limit (429): "<üye> şu an meşgul, bitince yazacağım" and ONE retry
 *    when a slot frees (checked every 30 s, at most 30 min). Other refusals are told as they are.
 *  - A command (`/…`) is not a member's: one line naming that there is none.
 */
import { join } from 'node:path';
import { listVaults } from '../../lib/vaults.js';
import { memberScope } from '../../lib/agents/scope.js';
import { readThreadRun } from '../../lib/automations/threads.js';
import { inboundTurnText, pickInboundMedia, saveInbound } from '../../lib/telegram/inbound.js';
import { takeMemberReactionText } from '../../lib/telegram/reactions.js';
import { sayToAgent } from '../routes/automations.js';
import type { UpdateDisposition } from '../../lib/telegram/poller.js';
import type { ActiveBinding, BindingKey, HubMember, TelegramHub } from './hub.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

const WATCH_EVERY_MS = 3_000;
const WATCH_MAX_MS = 2 * 60 * 60 * 1000;
const RETRY_EVERY_MS = 30_000;
const RETRY_MAX_MS = 30 * 60 * 1000;
const END_EVENTS = new Set(['ok', 'failed', 'timeout', 'skipped', 'asked']);

export interface MemberDeps {
  say?: typeof sayToAgent;
  readRun?: typeof readThreadRun;
  watchEveryMs?: number;
  retryEveryMs?: number;
  transcribeVoice?: (oggPath: string) => Promise<string>;
}

/** The project a member binding talks in: its own project, or for a global member the first
 *  registered project that sees it (named residual: one project per global member in v1). */
export function memberContextRoot(hub: TelegramHub, ab: ActiveBinding): string | null {
  if (ab.contextRoot) return ab.contextRoot;
  if (ab.scope !== 'global') return null;
  for (const v of listVaults(hub.home)) {
    const root = join(v.path, '_dream_context');
    if (memberScope(root, ab.target, hub.home) === 'global') return root;
  }
  return null;
}

export function memberAdapter(deps: MemberDeps = {}): HubMember {
  const say = deps.say ?? sayToAgent;
  const readRun = deps.readRun ?? readThreadRun;
  return {
    async onMessage(hub: TelegramHub, key: BindingKey, update: Obj): Promise<UpdateDisposition> {
      const ab = hub.active.get(key);
      const msg = obj(update.message);
      if (!ab || !msg) return 'accepted';
      const text0 = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (text0.startsWith('/')) {
        if (!/^\/start(?:@\w+)?(?:\s|$)/.test(text0)) await hub.reply(ab, 'Bu botta komut yok; yazman yeterli.');
        else await hub.reply(ab, 'Buradayım. Yaz, Mac\'te okusun.');
        return 'accepted';
      }
      const root = memberContextRoot(hub, ab);
      if (!root) { await hub.reply(ab, 'Bu üyeyi Mac\'te bulamadım.'); return 'accepted'; }
      void (async () => {
        const paths: string[] = [];
        let spoken: string | null = null;
        const media = pickInboundMedia(msg);
        if (media) {
          const saved = await saveInbound({ transport: ab.transport, contextRoot: root, media });
          if (!saved.ok) { await hub.reply(ab, saved.line); if (!msg.text && !msg.caption) return; }
          else if ((media.kind === 'voice' || media.kind === 'audio') && deps.transcribeVoice) {
            try { spoken = await deps.transcribeVoice(saved.path); await hub.reply(ab, `Duyduğum: ${spoken}`); } catch { paths.push(saved.path); }
          } else paths.push(saved.path);
        }
        let text = inboundTurnText(msg, paths);
        if (spoken) text = `🎙 ${spoken}${text ? `\n\n${text}` : ''}`;
        if (!text.trim()) return;
        // His reactions on this bot's messages since (reactions.ts): notes in front, never his words.
        const reacted = takeMemberReactionText(ab.key, hub.now());
        if (reacted) text = `${reacted}\n\n${text}`;
        await sendToMember(hub, ab, root, text, { say, readRun, watchEveryMs: deps.watchEveryMs ?? WATCH_EVERY_MS, retryEveryMs: deps.retryEveryMs ?? RETRY_EVERY_MS });
      })().catch(() => { void hub.reply(ab, 'Mesajın üyeye ulaşmadı, tekrar gönder.'); });
      return 'accepted';
    },
  };
}

async function sendToMember(
  hub: TelegramHub, ab: ActiveBinding, root: string, text: string,
  o: { say: typeof sayToAgent; readRun: typeof readThreadRun; watchEveryMs: number; retryEveryMs: number },
): Promise<void> {
  let r = o.say(root, { slug: ab.target, text, via: 'telegram' });
  if (!r.ok && r.status === 429) {
    await hub.reply(ab, `${ab.target} şu an meşgul, bitince yazacağım.`);
    // Delivered once, when a slot frees (checked every 30 s, at most 30 min).
    const until = hub.now() + RETRY_MAX_MS;
    while (hub.now() < until) {
      await new Promise((res) => { const t = setTimeout(res, o.retryEveryMs); t.unref?.(); });
      r = o.say(root, { slug: ab.target, text, via: 'telegram' });
      if (r.ok || r.status !== 429) break;
    }
  }
  if (!r.ok) { await hub.reply(ab, r.status === 429 ? `${ab.target} hâlâ meşgul; sonra tekrar yaz.` : r.message); return; }
  const runId = String(r.body.runId ?? '');
  const askId = String(r.body.entryId ?? '');
  if (!runId) return;
  await watchRun(hub, ab, root, runId, askId, o);
}

/** Sends the member's `agent` posts in `runId` after the ask, until the run ends. */
async function watchRun(
  hub: TelegramHub, ab: ActiveBinding, root: string, runId: string, askId: string,
  o: { readRun: typeof readThreadRun; watchEveryMs: number },
): Promise<void> {
  const sent = new Set<string>([askId]);
  const until = hub.now() + WATCH_MAX_MS;
  for (;;) {
    if (!hub.active.has(ab.key)) return;
    let entries: ReturnType<typeof readThreadRun> = [];
    try { entries = o.readRun(root, ab.target, runId); } catch { entries = []; }
    let ended = false;
    for (const e of entries) {
      if (sent.has(e.id)) continue;
      sent.add(e.id);
      if (e.kind === 'agent' && e.text.trim()) await hub.sendMarkdown(ab, e.text).catch(() => {});
      // Its question (a free-text ask) and a failure reach the owner here too.
      if (e.kind === 'system' && e.event === 'asked' && e.text.trim()) await hub.sendMarkdown(ab, `❓ ${e.text}`).catch(() => {});
      if (e.kind === 'system' && (e.event === 'failed' || e.event === 'timeout')) await hub.reply(ab, `Çalışamadı: ${e.text.slice(0, 300) || e.event}`);
      if (e.kind === 'system' && e.event && END_EVENTS.has(e.event)) ended = true;
    }
    if (ended || hub.now() > until) return;
    await new Promise((res) => { const t = setTimeout(res, o.watchEveryMs); t.unref?.(); });
  }
}
