/**
 * Renders a filled-in checklist as the single chat message Submit sends (plan
 * §1.14) — flat GFM task-list markdown the agent reads as plain text, not a
 * structured payload it has to parse. The exact shape is a frozen contract:
 * downstream agent behaviour is written against it, so changing the format here
 * is changing what every future checklist-writing prompt can rely on.
 *
 * A `wants:'secret'` item's masked value is not part of `ChecklistState` (see
 * checklistState.ts) — it is passed in separately as `secrets`, exactly once,
 * at the moment of building this string. That is the only place a secret and
 * the submit markdown ever touch.
 */
import type { ChecklistViewSpec } from './chatViewSpec';
import type { ChecklistState } from './checklistState';
import { doneCount } from './checklistState';

/** Hard cap on the message handed to `session.send`/`enqueue` — a long
 *  checklist with verbose notes could otherwise post a message so large it
 *  drowns the turn. Truncation is always visible, never silent. */
export const MAX_SUBMIT_BYTES = 32 * 1024;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * The one "- note:" line for an item, or null if there's nothing to show. A
 * `wants:'secret'` item's typed secret takes priority over its ordinary note
 * field when both are present — the secret is the artifact this item exists to
 * collect, and showing both as separate lines for one item has no established
 * shape to follow, so a single deterministic line is what stays unambiguous.
 */
function noteLineFor(
  item: ChecklistViewSpec['items'][number],
  state: ChecklistState,
  secrets: Record<string, string>,
): string | null {
  const secret = item.wants === 'secret' ? secrets[item.id]?.trim() : '';
  const note = state.notes[item.id]?.trim();
  const text = secret || note;
  return text ? `  - note: ${text}` : null;
}

function fileLinesFor(item: ChecklistViewSpec['items'][number], state: ChecklistState): string[] {
  const files = state.files[item.id];
  return files ? files.map((f) => `  - file: ${f}`) : [];
}

function blockFor(
  item: ChecklistViewSpec['items'][number],
  state: ChecklistState,
  secrets: Record<string, string>,
): string {
  const box = state.checked[item.id] ? '[x]' : '[ ]';
  const lines = [`- ${box} ${item.text}`];
  const note = noteLineFor(item, state, secrets);
  if (note) lines.push(note);
  lines.push(...fileLinesFor(item, state));
  return lines.join('\n');
}

/**
 * The exact submitted message. Truncation (only past `MAX_SUBMIT_BYTES`, which
 * a real checklist essentially never reaches) cuts on WHOLE items only — never
 * mid-item, which would hand the agent a malformed task-list line it could
 * misread as done or not-done — and always ends with a visible marker naming
 * how many items were dropped.
 */
export function buildSubmitMarkdown(
  spec: ChecklistViewSpec,
  state: ChecklistState,
  secrets: Record<string, string>,
): string {
  const total = spec.items.length;
  const header = `Checklist: ${spec.title} — ${doneCount(spec, state)} of ${total} done.`;
  const blocks = spec.items.map((item) => blockFor(item, state, secrets));
  const full = [header, '', ...blocks].join('\n');
  if (byteLength(full) <= MAX_SUBMIT_BYTES) return full;

  let included = 0;
  while (included < total) {
    const marker = `\n…(${total - (included + 1)} items truncated — the checklist was too long to send whole.)`;
    const candidate = [header, '', ...blocks.slice(0, included + 1)].join('\n') + marker;
    if (byteLength(candidate) > MAX_SUBMIT_BYTES) break;
    included++;
  }
  const marker = `…(${total - included} items truncated — the checklist was too long to send whole.)`;
  return [header, '', ...blocks.slice(0, included), marker].join('\n');
}
