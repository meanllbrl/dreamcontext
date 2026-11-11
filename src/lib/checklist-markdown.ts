/**
 * A filled-in checklist as the single message its Submit sends (chat-interactive-views plan
 * §1.14), moved here from dashboard/src/lib/checklistMarkdown.ts (which re-exports it) so the
 * SERVER can build the receipt itself (sahip-karti-yerinde K4, K6): the checklist route takes the
 * checklist's STRUCTURED state (ticks, notes, files) plus its secret values, never finished
 * markdown.
 *
 * Flat GFM task-list markdown the agent reads as plain text. The exact shape is a frozen
 * contract: owner-wait.ts `answeredBy` reads its first line, and every checklist-writing prompt
 * relies on it.
 *
 * TWO FORMS (K6, "a secret value reaches only the child it was typed for"):
 *  - the FULL form is the only one that may hold a typed `wants:'secret'` value; it is written
 *    into the asking child's own stream and nowhere else;
 *  - the KEPT form replaces each such value with `[secret, N chars, sha256:<8 hex>]` (the shape
 *    env-secrets.ts `secretReceipt` uses): the receipt file, its MAC, the slot, the Super's
 *    `owner-result` event, Telegram and logs only ever see this one.
 *
 * Browser-safe, no imports beyond a type: the kept form takes its sha256 function as an
 * argument (node:crypto on the server, owner-receipts.ts `checklistReceipt`).
 */
import type { ChecklistViewSpec } from './chat-view-spec.js';

/** Hard cap on the message (a long checklist with verbose notes could drown the turn).
 *  Truncation is always visible, never silent. */
export const MAX_SUBMIT_BYTES = 32 * 1024;

/** The structured state a submit carries (dashboard/src/lib/checklistState.ts `ChecklistState`
 *  is this shape and more). A secret's value is never part of it. */
export interface ChecklistSubmitState {
  checked: Record<string, boolean>;
  notes: Record<string, string>;
  files: Record<string, string[]>;
}

type Item = ChecklistViewSpec['items'][number];

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function doneOf(spec: ChecklistViewSpec, s: ChecklistSubmitState): number {
  let n = 0;
  for (const item of spec.items) if (s.checked[item.id]) n++;
  return n;
}

/**
 * The one "- note:" line for an item, or null. A `wants:'secret'` item's typed secret takes
 * priority over its ordinary note when both are present: one deterministic line per item.
 */
function noteLineFor(item: Item, state: ChecklistSubmitState, secrets: Record<string, string>): string | null {
  const secret = item.wants === 'secret' ? secrets[item.id]?.trim() : '';
  const note = state.notes[item.id]?.trim();
  const text = secret || note;
  return text ? `  - note: ${text}` : null;
}

function blockFor(item: Item, state: ChecklistSubmitState, secrets: Record<string, string>): string {
  const box = state.checked[item.id] ? '[x]' : '[ ]';
  const lines = [`- ${box} ${item.text}`];
  const note = noteLineFor(item, state, secrets);
  if (note) lines.push(note);
  const files = state.files[item.id];
  if (files) lines.push(...files.map((f) => `  - file: ${f}`));
  return lines.join('\n');
}

/**
 * The exact submitted message. Truncation (only past `MAX_SUBMIT_BYTES`) cuts on WHOLE items
 * only and always ends with a visible marker naming how many items were dropped.
 */
export function buildSubmitMarkdown(
  spec: ChecklistViewSpec,
  state: ChecklistSubmitState,
  secrets: Record<string, string>,
): string {
  const total = spec.items.length;
  const header = `Checklist: ${spec.title} — ${doneOf(spec, state)} of ${total} done.`;
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

/** `[secret, N chars, sha256:<8 hex>]`: what a kept form says instead of a typed value. */
export function keptSecretMark(value: string, sha256Hex: (s: string) => string): string {
  return `[secret, ${value.length} chars, sha256:${sha256Hex(value).slice(0, 8)}]`;
}

/**
 * Both forms of one checklist receipt (K6). Only `wants:'secret'` items' values are secrets;
 * a value given for any other item is ignored, as the window ignores it.
 */
export function checklistReceiptForms(
  spec: ChecklistViewSpec,
  state: ChecklistSubmitState,
  secrets: Record<string, string>,
  sha256Hex: (s: string) => string,
): { full: string; kept: string } {
  const typed: Record<string, string> = {};
  const marks: Record<string, string> = {};
  for (const item of spec.items) {
    if (item.wants !== 'secret') continue;
    const v = secrets[item.id]?.trim();
    if (!v) continue;
    typed[item.id] = v;
    marks[item.id] = keptSecretMark(v, sha256Hex);
  }
  return { full: buildSubmitMarkdown(spec, state, typed), kept: buildSubmitMarkdown(spec, state, marks) };
}

/** Caps a submit body is held to (the window's own: checklistState.ts MAX_NOTE_CHARS). */
export const MAX_SUBMIT_NOTE_CHARS = 4000;
export const MAX_SUBMIT_FILES_PER_ITEM = 20;
export const MAX_SUBMIT_FILE_CHARS = 4096;
export const MAX_SUBMIT_SECRET_CHARS = 8192;

/**
 * Read a checklist submit body against the RECORD's spec (K4): `{ checked, notes, files,
 * secrets }`, keyed only by the spec's item ids, secrets only for `wants:'secret'` items, every
 * value capped. Null for anything else, a body carrying finished markdown (`markdown`, `text`)
 * included: the server builds the receipt, the client never writes it.
 */
export function readChecklistSubmit(
  spec: ChecklistViewSpec,
  body: unknown,
): { state: ChecklistSubmitState; secrets: Record<string, string> } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if ('markdown' in b || 'text' in b) return null;
  const ids = new Set(spec.items.map((i) => i.id));
  const secretIds = new Set(spec.items.filter((i) => i.wants === 'secret').map((i) => i.id));
  const rec = (v: unknown): Record<string, unknown> | null => (v === undefined ? {} : v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
  const checkedRaw = rec(b.checked); const notesRaw = rec(b.notes); const filesRaw = rec(b.files); const secretsRaw = rec(b.secrets);
  if (!checkedRaw || !notesRaw || !filesRaw || !secretsRaw) return null;
  const checked: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(checkedRaw)) {
    if (!ids.has(k) || typeof v !== 'boolean') return null;
    checked[k] = v;
  }
  const notes: Record<string, string> = {};
  for (const [k, v] of Object.entries(notesRaw)) {
    if (!ids.has(k) || typeof v !== 'string' || v.length > MAX_SUBMIT_NOTE_CHARS) return null;
    notes[k] = v;
  }
  const files: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(filesRaw)) {
    if (!ids.has(k) || !Array.isArray(v) || v.length > MAX_SUBMIT_FILES_PER_ITEM) return null;
    if (v.some((f) => typeof f !== 'string' || !f || f.length > MAX_SUBMIT_FILE_CHARS || /[\r\n]/.test(f))) return null;
    files[k] = v as string[];
  }
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(secretsRaw)) {
    if (!secretIds.has(k) || typeof v !== 'string' || v.length > MAX_SUBMIT_SECRET_CHARS) return null;
    secrets[k] = v;
  }
  return { state: { checked, notes, files }, secrets };
}
