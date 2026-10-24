import { classifyWebTarget } from '../whiteboards/validate.js';

/**
 * What a CHILD's output frame says the Super Agent's stage should show (jarvis plan r9, §3),
 * read by the server with no agent verb (S1, S2):
 *
 *  - `devserver`: the child pinned a loopback url (a ```dream-view``` fence, `type:"pin"`, a
 *    fact whose `url` is a loopback page). The pin rule every chat is briefed with
 *    (`chat-surface.ts`) is the signal; nothing is guessed from Bash output.
 *  - `devserver-drop`: the child withdrew a pin (`"drop": true`).
 *  - `browser`: the child called a tool of the Playwright server its spawn overrides (the live
 *    mirror's server). No override (`browserServer` null) = never a browser signal.
 *
 * Pure. Any shape it does not recognize is no signal at all; it never throws. Only the
 * assistant's own TEXT blocks are read: a fence quoted inside a tool result is not a pin.
 */

export type SuperSignal =
  | { kind: 'browser' }
  | { kind: 'devserver'; url: string }
  | { kind: 'devserver-drop' };

const FENCE_RE = /```dream-view[^\n]*\n([\s\S]*?)```/g;

function textBlocks(content: unknown[]): string[] {
  const out: string[] = [];
  for (const b of content) {
    const block = b as { type?: unknown; text?: unknown } | null;
    if (block && block.type === 'text' && typeof block.text === 'string') out.push(block.text);
  }
  return out;
}

function pinSignals(text: string): SuperSignal[] {
  // Cheap gate: most frames carry neither word, and those are never parsed.
  if (!text.includes('dream-view') || !text.includes('"pin"')) return [];
  const out: SuperSignal[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    let spec: unknown;
    try { spec = JSON.parse(m[1]); } catch { continue; }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    const s = spec as { type?: unknown; drop?: unknown; facts?: unknown };
    if (s.type !== 'pin') continue;
    if (s.drop === true) { out.push({ kind: 'devserver-drop' }); continue; }
    if (!Array.isArray(s.facts)) continue;
    for (const f of s.facts) {
      const url = (f as { url?: unknown } | null)?.url;
      if (typeof url !== 'string') continue;
      const t = classifyWebTarget(url);
      if (t.ok && t.kind === 'url' && t.href.startsWith('http://') && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(t.href)) {
        out.push({ kind: 'devserver', url: t.href });
      }
    }
  }
  return out;
}

/** The signals one CLI stream-json frame carries, in order (usually none). */
export function signalsOf(frame: unknown, browserServer: string | null): SuperSignal[] {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return [];
  const obj = frame as { type?: unknown; message?: { content?: unknown } };
  if (obj.type !== 'assistant') return [];
  const content = obj.message?.content;
  if (!Array.isArray(content)) return [];
  const out: SuperSignal[] = [];
  for (const text of textBlocks(content)) out.push(...pinSignals(text));
  if (browserServer) {
    const prefix = `mcp__${browserServer}__`;
    const calls = content.some((b) => {
      const block = b as { type?: unknown; name?: unknown } | null;
      return !!block && block.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(prefix);
    });
    if (calls) out.push({ kind: 'browser' });
  }
  return out;
}
