import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listVaults } from '../vaults.js';
import { runPeerHeadless, type LiveRunResult, type PeerTarget } from '../peer-delivery.js';

/**
 * Broadcast — "a rule stated once reaches every project and comes back as 'written in all N'".
 *
 * EACH VAULT'S OWN AGENT DOES THE WRITING. The assistant does not edit other projects' brains
 * itself: it hands the owner's words to a headless `claude -p` in each project root
 * (`runPeerHeadless`, the same run peer delivery uses), and that project's agent — with its
 * own context loaded — decides where the rule belongs there and writes it. The reply is its
 * one-line account of what it did.
 *
 * Three at a time: N parallel `claude` processes on a laptop is a fan-out the owner feels.
 */

export const BROADCAST_CONCURRENCY = 3;
export const DEFAULT_BROADCAST_TIMEOUT_MS = 5 * 60_000;

export type BroadcastStatus = 'replied' | 'failed' | 'timeout' | 'missing';
export interface BroadcastRow {
  vault: string;
  status: BroadcastStatus;
  text: string;
}

export type HeadlessRunner = (peer: PeerTarget, prompt: string, opts: { timeoutMs?: number }) => Promise<LiveRunResult>;

export function buildBroadcastPrompt(message: string): string {
  return [
    'The owner of this machine sent the message below to ALL of their dreamcontext projects at once, through their dreamcontext Assistant.',
    'It comes from the owner, relayed verbatim. Apply it to THIS project with this project\'s own context:',
    'if it is a rule, preference or decision, write it where it belongs in this project\'s dreamcontext brain (use the dreamcontext CLI);',
    'if it is a question, answer it from this project.',
    '',
    '<<<OWNER-MESSAGE',
    message,
    'OWNER-MESSAGE',
    '',
    'YOUR ENTIRE FINAL MESSAGE IS ONE OR TWO SENTENCES saying what you did here (e.g. which file you wrote it to), or why you did not.',
  ].join('\n');
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order in the result. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function broadcast(
  message: string,
  opts: { to?: string[]; timeoutMs?: number; home?: string; runner?: HeadlessRunner } = {},
): Promise<BroadcastRow[]> {
  const runner = opts.runner ?? runPeerHeadless;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BROADCAST_TIMEOUT_MS;
  const registered = listVaults(opts.home);
  const wanted = opts.to && opts.to.length ? opts.to : registered.map((v) => v.name);
  const prompt = buildBroadcastPrompt(message);

  return mapLimit(wanted, BROADCAST_CONCURRENCY, async (name): Promise<BroadcastRow> => {
    const v = registered.find((x) => x.name === name);
    if (!v || !existsSync(join(v.path, '_dream_context'))) {
      return { vault: name, status: 'missing', text: v ? `folder is gone: ${v.path}` : 'not a registered project' };
    }
    try {
      const r = await runner({ name, contextRoot: join(v.path, '_dream_context'), projectRoot: v.path }, prompt, { timeoutMs });
      if (r.ok) return { vault: name, status: 'replied', text: r.reply };
      const timedOut = /^timed out/.test(r.error ?? '');
      return { vault: name, status: timedOut ? 'timeout' : 'failed', text: r.error ?? r.reply ?? '' };
    } catch (err) {
      return { vault: name, status: 'failed', text: (err as Error).message };
    }
  });
}
