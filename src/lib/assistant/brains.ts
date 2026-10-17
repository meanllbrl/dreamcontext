import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { listVaults } from '../vaults.js';
import { crossVaultRecall, type CrossVaultTarget } from '../federation-recall.js';
import { buildKnowledgeIndex } from '../knowledge-index.js';
import type { CorpusType } from '../recall.js';
import { isSafeSessionId } from '../transcript-locate.js';
import { parseTranscriptHistory } from '../transcript-history.js';
import { ASSISTANT_VAULT, assistantProjectRoot } from './home.js';

/**
 * The Assistant READS every project's brain itself (owner, 2026-10-17): "it should not have to
 * go and ask about everything — some information it should just give". Before this, a question
 * like "the treadmill we picked" ran recall in the hidden vault only, found nothing, and opened
 * a chat in Second-brain to wait for an answer recall would have returned in two seconds.
 *
 * Three reads, served by the server so every project string comes back FENCED and TAINTS the
 * session (autonomy.ts) exactly like `assistant sessions` does:
 *   • {@link recallBrains} — recall across the Assistant's own memory and every registered vault.
 *   • {@link indexBrains}  — every vault's knowledge index, ON DEMAND (owner: never in the
 *                            briefing or the per-turn context; ~18.7k tokens for 6 vaults).
 *   • {@link readBrainFile} — one file inside a vault's `_dream_context/`.
 *   • {@link readBrainSession} — one past session of a vault: the owner's and the agent's words.
 * Actions stay delegated: none of these writes anything.
 */

/** The label the Assistant's own hidden vault carries in results: the reserved name, so no
 *  registered vault can collide with it (`vaults add` refuses it). */
export const OWN_LABEL = ASSISTANT_VAULT;
export const RECALL_PER_VAULT = 3;
export const RECALL_PER_VAULT_MAX = 10;
export const READ_LIMIT = 40_000;
export const READ_LIMIT_MAX = 120_000;

/**
 * What `readBrainFile` will open: Markdown, plus the two JSON files recall itself indexes.
 * An ALLOWLIST, because brains hold `state/.secrets.json` and `lab/credentials.json`.
 */
const READABLE_JSON = new Set(['core/CHANGELOG.json', 'core/RELEASES.json']);

export class BrainReadError extends Error {
  constructor(readonly code: 'unknown_vault' | 'outside_brain' | 'not_readable' | 'not_found', message: string) {
    super(message);
  }
}

interface Brain { label: string; target: CrossVaultTarget; contextRoot: string; own: boolean }

/** The Assistant's own memory first, then every registered vault whose folder exists. */
function brains(home: string): Brain[] {
  const out: Brain[] = [];
  const ownRoot = assistantProjectRoot(home);
  if (existsSync(join(ownRoot, '_dream_context'))) {
    out.push({ label: OWN_LABEL, target: { name: ownRoot, label: OWN_LABEL, current: true }, contextRoot: join(ownRoot, '_dream_context'), own: true });
  }
  for (const v of listVaults(home)) {
    const contextRoot = join(v.path, '_dream_context');
    if (!existsSync(contextRoot)) continue;
    out.push({ label: v.name, target: { name: v.name }, contextRoot, own: false });
  }
  return out;
}

/** Split `wanted` names into the brains they name and the names nothing matched. */
function pick(all: Brain[], wanted: string[] | undefined): { picked: Brain[]; unknown: string[] } {
  if (!wanted || wanted.length === 0) return { picked: all, unknown: [] };
  const picked: Brain[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    const b = all.find((x) => x.label.toLowerCase() === w.toLowerCase());
    if (!b) unknown.push(w);
    else if (!picked.includes(b)) picked.push(b);
  }
  return { picked, unknown };
}

/** True when the query names this vault as a word ("Tilki'nin…" names Tilki, not tilki-marketing-brain). */
export function queryNamesVault(query: string, vault: string): boolean {
  const q = query.toLocaleLowerCase('tr');
  const v = vault.toLocaleLowerCase('tr');
  let at = q.indexOf(v);
  while (at !== -1) {
    const before = at === 0 ? '' : q[at - 1];
    const after = q[at + v.length] ?? '';
    const edge = (c: string) => c === '' || !/[\p{L}\p{N}_-]/u.test(c);
    if (edge(before) && edge(after)) return true;
    at = q.indexOf(v, at + 1);
  }
  return false;
}

export interface BrainHit {
  type: string;
  /** Relative to the vault's `_dream_context/` — what `assistant read <vault> <path>` takes. */
  path: string;
  /** Absolute, for a file the owner wants attached or opened. */
  file: string;
  title: string;
  description: string;
  snippet: string;
  score: number;
}

export interface BrainGroup { vault: string; own: boolean; hits: BrainHit[] }

export interface RecallBrainsResult { groups: BrainGroup[]; noMatch: string[]; unknown: string[] }

/**
 * Recall across every brain, GROUPED BY VAULT: each vault's best few hits, never one merged
 * list. Merged, one large vault's weak hits bury another's only real answer — "koşu bandı"
 * across all vaults ranked Second-brain's session digest (its #1, rank-penalised as a capture)
 * outside the top 10. A vault the query names leads with twice the room; the rest follow by
 * their best hit.
 */
export function recallBrains(
  query: string,
  opts: { vaults?: string[]; perVault?: number; types?: CorpusType[]; home?: string; now?: Date } = {},
): RecallBrainsResult {
  const home = opts.home ?? homedir();
  const perVault = Math.min(Math.max(Math.floor(opts.perVault ?? RECALL_PER_VAULT), 1), RECALL_PER_VAULT_MAX);
  const { picked, unknown } = pick(brains(home), opts.vaults);
  const groups: BrainGroup[] = [];
  const noMatch: string[] = [];
  for (const b of picked) {
    let hits: BrainHit[] = [];
    try {
      const r = crossVaultRecall(query, {
        vaults: [b.target],
        // The vault the owner named is where the answer is: it gets twice the room.
        topK: queryNamesVault(query, b.label) ? Math.min(perVault * 2, RECALL_PER_VAULT_MAX) : perVault,
        home,
        ...(opts.types ? { types: opts.types } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      // No score floor: raw BM25 shrinks with a vault's size, and a floor tuned on the big
      // brains hid every hit of a small one (the hidden vault holds a handful of files).
      hits = r.hits
        .filter((h) => h.score > 0)
        .map((h) => ({
          type: h.doc.type,
          path: h.doc.relPath,
          file: h.doc.path,
          title: h.doc.title,
          description: h.doc.description,
          snippet: h.snippet,
          score: Math.round(h.score * 100) / 100,
        }));
    } catch { /* one broken brain never sinks the others */ }
    if (hits.length === 0) noMatch.push(b.label);
    else groups.push({ vault: b.label, own: b.own, hits });
  }
  const best = (g: BrainGroup) => g.hits[0]?.score ?? 0;
  groups.sort((a, b) => {
    const an = queryNamesVault(query, a.vault);
    const bn = queryNamesVault(query, b.vault);
    if (an !== bn) return an ? -1 : 1;
    return best(b) - best(a);
  });
  return { groups, noMatch, unknown };
}

export interface BrainIndexEntry { path: string; name: string; description: string; tags: string[] }
export interface BrainIndex { vault: string; own: boolean; entries: BrainIndexEntry[] }

/** Every picked vault's knowledge index, features included (they are knowledge files too). */
export function indexBrains(opts: { vaults?: string[]; home?: string } = {}): { indexes: BrainIndex[]; unknown: string[] } {
  const home = opts.home ?? homedir();
  const { picked, unknown } = pick(brains(home), opts.vaults);
  const indexes: BrainIndex[] = [];
  for (const b of picked) {
    let entries: BrainIndexEntry[] = [];
    try {
      entries = buildKnowledgeIndex(b.contextRoot, { includeFeatures: true }).map((e) => ({
        path: `knowledge/${e.slug}.md`,
        name: e.name,
        description: e.description,
        tags: e.tags,
      }));
    } catch { /* a broken brain still gets its (empty) row */ }
    indexes.push({ vault: b.label, own: b.own, entries });
  }
  return { indexes, unknown };
}

export interface BrainFile {
  vault: string;
  own: boolean;
  path: string;
  file: string;
  /** Characters in the whole file. */
  total: number;
  offset: number;
  text: string;
  /** More of the file follows: read again with `offset + text.length`. */
  more: boolean;
}

/**
 * One file inside a vault's `_dream_context/`, by its recall/index path (relative) or by its
 * absolute path. Refused: an unregistered vault, anything that resolves outside the brain
 * (`..`, an absolute path elsewhere, a symlink pointing out), and anything not Markdown or the
 * two indexed JSON files.
 */
export function readBrainFile(
  vault: string,
  path: string,
  opts: { offset?: number; limit?: number; home?: string } = {},
): BrainFile {
  const home = opts.home ?? homedir();
  const b = brains(home).find((x) => x.label.toLowerCase() === vault.toLowerCase());
  if (!b) throw new BrainReadError('unknown_vault', `"${vault}" is not a registered project (see \`dreamcontext assistant projects\`).`);
  const root = realpathSync(b.contextRoot);
  const raw = path.trim().replace(/^_dream_context[\\/]/, '');
  const target = isAbsolute(raw) ? resolve(raw) : resolve(b.contextRoot, raw);
  if (!existsSync(target)) throw new BrainReadError('not_found', `No file "${path}" in ${b.label}'s brain.`);
  const real = realpathSync(target);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new BrainReadError('outside_brain', `"${path}" is outside ${b.label}'s brain; only files under its _dream_context/ can be read.`);
  }
  const rel = relative(root, real).split(sep).join('/');
  if (!statSync(real).isFile() || !(rel.toLowerCase().endsWith('.md') || READABLE_JSON.has(rel))) {
    throw new BrainReadError('not_readable', `"${rel}" is not a brain document (Markdown, or core/CHANGELOG.json and core/RELEASES.json).`);
  }
  return { vault: b.label, own: b.own, path: rel, file: real, ...windowOf(readFileSync(real, 'utf-8'), opts.offset ?? 0, opts.limit) };
}

function windowOf(content: string, offsetIn: number, limitIn: number | undefined): { total: number; offset: number; text: string; more: boolean } {
  const offset = Math.min(Math.max(Math.floor(offsetIn), 0), content.length);
  const limit = Math.min(Math.max(Math.floor(limitIn ?? READ_LIMIT), 1), READ_LIMIT_MAX);
  const text = content.slice(offset, offset + limit);
  return { total: content.length, offset, text, more: offset + text.length < content.length };
}

/** Claude Code's transcript folder for a cwd: every non-alphanumeric character becomes `-`. */
export function transcriptDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * One past session of a vault, as the conversation it was: the owner's messages and the
 * agent's replies, never tool calls or their results (file contents, command output, whatever
 * a tool printed). A session digest is a lossy summary — "the treadmill we picked" digest kept
 * the first recommendation and not the one the owner chose at the end — so when it does not
 * settle a question, the session itself does. Without an offset it returns the END, where the
 * conclusion is. Only a session run in that vault's own folder: the id is looked up in that
 * folder's transcript directory, never across every project.
 */
export function readBrainSession(
  vault: string,
  sessionId: string,
  opts: { offset?: number; limit?: number; home?: string } = {},
): BrainFile {
  const home = opts.home ?? homedir();
  const b = brains(home).find((x) => x.label.toLowerCase() === vault.toLowerCase());
  if (!b) throw new BrainReadError('unknown_vault', `"${vault}" is not a registered project (see \`dreamcontext assistant projects\`).`);
  if (!isSafeSessionId(sessionId)) throw new BrainReadError('not_found', `"${sessionId}" is not a session id.`);
  const file = join(home, '.claude', 'projects', transcriptDirName(join(b.contextRoot, '..')), `${sessionId}.jsonl`);
  if (!existsSync(file)) throw new BrainReadError('not_found', `No session ${sessionId} in ${b.label}.`);
  const conversation = parseTranscriptHistory(readFileSync(file, 'utf-8'))
    .filter((i) => (i.kind === 'user' || i.kind === 'text') && i.text?.trim())
    .map((i) => `${i.kind === 'user' ? 'OWNER' : 'AGENT'}: ${i.text!.trim()}`)
    .join('\n\n');
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? READ_LIMIT), 1), READ_LIMIT_MAX);
  const offset = opts.offset ?? Math.max(conversation.length - limit, 0);
  return { vault: b.label, own: b.own, path: `session:${sessionId}`, file, ...windowOf(conversation, offset, limit) };
}
