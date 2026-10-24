import type { ChatChange, ChatEntry } from '../../assistant/chat-registry.js';
import { buildAppLink } from '../../app-link.js';
import type { PushStore } from './push-store.js';
import type { SendOutcome, PushSubscriptionLike } from './push.js';

/**
 * Hands-free Mac mode — the three pushes. Server-side, because a phone in a pocket runs no
 * script: the chat registry's changes are read here and exactly three edges push.
 *
 *   question    → asking, an AskUserQuestion (a NEW requestId while still asking pushes again)
 *   permission  → asking, a tool permission prompt (the TOOL NAME only, never its command/path)
 *   turn        → working|asking → idle on a top-level result the owner did not interrupt
 *
 * Plus one Mac push: the first very-hot reading of a hands-free run (`pushMacHeat`).
 *
 * Nothing else pushes. Only while Mac mode is on, only the chosen projects' chats, never
 * twice for one requestId or one turn, at most {@link PER_DEVICE_PER_MIN} a minute per device,
 * and never to a device whose phone shows that chat on screen right now (D2: the suppression is
 * HERE, because iOS revokes a subscription whose pushes show no notification).
 */

export type PushKind = 'question' | 'permission' | 'turn' | 'mac';

/** The heat push's session id: no chat has it, so no phone that shows a chat suppresses it. */
export const MAC_HEAT_SESSION = '\u0000mac-heat';

export interface PushPayload {
  kind: PushKind;
  vault: string;
  conversationId: string | null;
  title: string;
  body: string;
  /** Where a tap lands: the project's chat (D10 deep link), else the project. */
  url: string;
}

export interface PushNotifierDeps {
  /** The projects Mac mode exposes (empty = off: nothing pushes). */
  exposed: () => readonly string[];
  store: () => PushStore;
  /** Is this device (id hash) still signed in? A signed-out device is never pushed. */
  deviceValid: (deviceHash: string) => boolean;
  /** The device whose phone has this chat (registry session id) open on screen, if any. */
  showingDevice: (sessionId: string) => string | null;
  send: (sub: PushSubscriptionLike, payload: PushPayload) => Promise<SendOutcome>;
  now?: () => number;
}

export const PER_DEVICE_PER_MIN = 30;
const DEDUP_KEEP = 500;
const BODY_CAP = 140;

const clip = (s: string, n = BODY_CAP) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1).trimEnd()}…` : flat;
};

/** The D10 link: `/?vault=<v>&open=dreamcontext://project/<v>/session/<id>`, or the project. */
export function pushUrl(vault: string, conversationId: string | null): string {
  const base = `/?vault=${encodeURIComponent(vault)}`;
  if (!conversationId) return base;
  try {
    return `${base}&open=${encodeURIComponent(buildAppLink({ kind: 'session', vault, claudeId: conversationId }))}`;
  } catch {
    return base;
  }
}

/** The push for one registry change, or null when this change is not one of the three. */
export function pushFor(change: ChatChange): { key: string; payload: Omit<PushPayload, 'url'> } | null {
  const e: ChatEntry = change.entry;
  const base = { vault: e.vault, conversationId: e.conversationId };
  if (e.status === 'asking' && e.pendingQuestion) {
    const q = e.pendingQuestion;
    if (q.isPermission) {
      return { key: `ask:${e.sessionId}:${q.requestId}`, payload: { ...base, kind: 'permission', title: 'Permission needed', body: clip(`Claude wants to use ${q.toolName}`) } };
    }
    return { key: `ask:${e.sessionId}:${q.requestId}`, payload: { ...base, kind: 'question', title: 'Claude is asking', body: clip(q.text || 'Claude has a question for you.') } };
  }
  if (e.status === 'idle' && (change.from === 'working' || change.from === 'asking') && e.lastTurn && !e.lastTurn.interrupted) {
    return { key: `turn:${e.sessionId}:${e.lastTurn.resultSeq}`, payload: { ...base, kind: 'turn', title: clip(e.title || 'Claude', 80), body: 'Turn finished' } };
  }
  return null;
}

/** One line per push that did not land: the push service's host and the device's hash prefix, never
 *  the endpoint path (it is the subscription's secret capability). */
function logPushMiss(kind: string, out: { status: number | null; gone: boolean; error?: string }, endpoint: string, device: string): void {
  let host = '?';
  try { host = new URL(endpoint).host; } catch { /* stored endpoints are validated; keep '?' */ }
  console.warn(`[handsfree-push] ${kind} not delivered: ${out.status ?? out.error ?? 'error'}${out.gone ? ' (subscription dropped)' : ''} host=${host} device=${device.slice(0, 8)}`);
}

export class PushNotifier {
  private readonly sent = new Set<string>();
  private readonly order: string[] = [];
  private readonly recent = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly d: PushNotifierDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Feed one registry change. Resolves once every push it caused was attempted. */
  async onChange(change: ChatChange): Promise<number> {
    const exposed = this.d.exposed();
    if (!exposed.length) return 0;
    const p = pushFor(change);
    if (!p || !p.payload.vault || !exposed.includes(p.payload.vault)) return 0;
    return this.deliver(p.key, change.entry.sessionId, p.payload).done;
  }

  /**
   * A question the Super Agent put to the owner (`super queue ask`, `super ask`: no registry
   * edge of its own, `lib/super/owner-question.ts`). A `question` push into the super chat, once
   * per key. `targeted` = the devices it goes to, known before any send.
   */
  pushOwnerQuestion(q: { vault: string; sessionId: string; key: string; title: string; body: string }): { targeted: number; done: Promise<number> } {
    if (!q.vault || !this.d.exposed().includes(q.vault)) return { targeted: 0, done: Promise.resolve(0) };
    return this.deliver(q.key, q.sessionId, { kind: 'question', vault: q.vault, conversationId: q.sessionId, title: clip(q.title, 80), body: clip(q.body) });
  }

  /**
   * The Mac got very hot (macOS serious/critical) during this run: one push to the project page,
   * never a path, command or chat text. Same filter as every push (signed-in device, rate limit,
   * pruning); the key is spent only when a device was targeted, so a reading before any phone
   * subscribed is retried at the next one.
   */
  pushMacHeat(h: { key: string; title: string; body: string }): { targeted: number; done: Promise<number> } {
    const vault = this.d.exposed()[0];
    if (!vault || this.sent.has(h.key)) return { targeted: 0, done: Promise.resolve(0) };
    const payload: PushPayload = { kind: 'mac', vault, conversationId: null, title: clip(h.title, 80), body: clip(h.body), url: pushUrl(vault, null) };
    const targets = this.targetsFor(MAC_HEAT_SESSION);
    if (targets.length === 0) return { targeted: 0, done: Promise.resolve(0) };
    this.remember(h.key);
    return { targeted: targets.length, done: this.sendTo(targets, payload) };
  }

  private deliver(key: string, sessionId: string, base: Omit<PushPayload, 'url'>): { targeted: number; done: Promise<number> } {
    if (this.sent.has(key)) return { targeted: 0, done: Promise.resolve(0) };
    this.remember(key);
    const payload: PushPayload = { ...base, url: pushUrl(base.vault, base.conversationId) };
    const targets = this.targetsFor(sessionId);
    return { targeted: targets.length, done: this.sendTo(targets, payload) };
  }

  /** The devices a push for this chat goes to: signed in (others pruned), not showing it, under the rate limit. */
  private targetsFor(sessionId: string): Array<[string, PushSubscriptionLike]> {
    const store = this.d.store();
    const showing = this.d.showingDevice(sessionId);
    return store.entries().filter(([device]) => {
      if (!this.d.deviceValid(device)) { store.remove(device); return false; }
      return showing !== device && this.allow(device);
    });
  }

  private sendTo(targets: Array<[string, PushSubscriptionLike]>, payload: PushPayload): Promise<number> {
    const store = this.d.store();
    let pushed = 0;
    return Promise.all(targets.map(async ([device, sub]) => {
      const out = await this.d.send(sub, payload);
      if (!out.ok) logPushMiss(payload.kind, out, sub.endpoint, device);
      if (out.gone) store.remove(device);
      else if (out.ok) pushed++;
    })).then(() => pushed);
  }

  private remember(key: string): void {
    this.sent.add(key);
    this.order.push(key);
    while (this.order.length > DEDUP_KEEP) this.sent.delete(this.order.shift()!);
  }

  private allow(device: string): boolean {
    const now = this.now();
    const times = (this.recent.get(device) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= PER_DEVICE_PER_MIN) { this.recent.set(device, times); return false; }
    times.push(now);
    this.recent.set(device, times);
    return true;
  }
}
