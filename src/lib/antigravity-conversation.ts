/**
 * An Antigravity conversation read in the Claude transcript shape, so sleep, the digest and
 * `super read` see its turns. The agent keeps each one in `<profile>/antigravity-acp/conversations/
 * <thread>.db`, SQLite with one protobuf row per step, and the thread id is the file name (all
 * measured on agent 1.4.1). This runs in the bridge, the only process sure of `node:sqlite`; what it
 * writes is a plain JSONL under the T3 state root that every reader takes as it is.
 *
 * Kept: what the owner typed, what the agent answered, its tool calls under our canonical names, the
 * tokens of each model call. Dropped: everything injected, as for Codex: our instructions, the
 * brain, recall and the runtime note, and the hidden tab-naming turn.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { antigravityProfileDir } from './antigravity-accounts.js';

const THREAD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STEP_USER = 14;
const STEP_MODEL = 15;

export const antigravityTranscriptsDir = (home: string = homedir()): string => join(home, '.dreamcontext', 't3', 'transcripts');

type Field = { no: number; value: number | Uint8Array };

function varint(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (let i = at; i < b.length && i < at + 10; i += 1) {
    v += (b[i]! & 0x7f) * mul;
    mul *= 128;
    if (b[i]! < 0x80) return [v, i + 1];
  }
  throw new Error('bad varint');
}

/** One message's fields, or [] when the bytes are not one. A format that moves reads as nothing. */
export function protoFields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  try {
    let at = 0;
    while (at < b.length) {
      const [key, next] = varint(b, at);
      const no = Math.floor(key / 8);
      const wire = key % 8;
      at = next;
      if (wire === 0) { const [v, n] = varint(b, at); at = n; out.push({ no, value: v }); }
      else if (wire === 1) at += 8;
      else if (wire === 5) at += 4;
      else if (wire === 2) {
        const [len, n] = varint(b, at);
        if (n + len > b.length) return [];
        out.push({ no, value: b.subarray(n, n + len) });
        at = n + len;
      } else return [];
    }
  } catch {
    return [];
  }
  return out;
}

const dec = new TextDecoder();
const sub = (fs: readonly Field[], no: number): Uint8Array | null => {
  const f = fs.find((x) => x.no === no && typeof x.value !== 'number');
  return f ? f.value as Uint8Array : null;
};
const num = (fs: readonly Field[], no: number): number => {
  const f = fs.find((x) => x.no === no && typeof x.value === 'number');
  return f ? f.value as number : 0;
};
const text = (fs: readonly Field[], no: number): string => {
  const v = sub(fs, no);
  return v ? dec.decode(v) : '';
};

const INSTRUCTIONS = /^\s*<dreamcontext-instructions>[\s\S]*?<\/dreamcontext-instructions>\s*/;
const INJECTED = /\n\n<dreamcontext-[a-z-]+>|\s*<\/user_request>|\s*<dreamcontext-runtime>/;

/** What the owner typed, out of the prompt the bridge built. Null for a turn that is not theirs. */
export function ownerWords(prompt: string): string | null {
  let body = prompt.replace(INSTRUCTIONS, '');
  const open = body.indexOf('<user_request>');
  if (open >= 0 && open < 8) body = body.slice(open + '<user_request>'.length).replace(/^\n/, '');
  // A long message carries its context first (context.ts): the owner's words sit after it.
  while (/^\s*<dreamcontext-[a-z-]+>/.test(body)) {
    const m = /^\s*<(dreamcontext-[a-z-]+)>/.exec(body)!;
    const end = body.indexOf(`</${m[1]}>`);
    if (end < 0) return null;
    body = body.slice(end + m[1]!.length + 3).replace(/^\n+/, '');
  }
  const cut = INJECTED.exec(body);
  const words = (cut ? body.slice(0, cut.index) : body).trim();
  return words && !words.startsWith('<dreamcontext_tab_title>') ? words : null;
}

function canonicalTool(name: string, raw: string): { name: string; input: Record<string, unknown> } {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(raw) as Record<string, unknown>; } catch { /* a name alone is still a tool call */ }
  const path = typeof args.TargetFile === 'string' ? args.TargetFile : typeof args.AbsolutePath === 'string' ? args.AbsolutePath : '';
  if (name === 'run_command') return { name: 'Bash', input: { command: String(args.CommandLine ?? '') } };
  if (name === 'create_file') return { name: 'Write', input: { file_path: path } };
  if (name === 'edit_file') return { name: 'Edit', input: { file_path: path } };
  if (name === 'view_file') return { name: 'Read', input: { file_path: path } };
  return { name, input: {} };
}

export interface ConversationRow { readonly type: number; readonly payload: Uint8Array }

export function conversationToClaudeJsonl(rows: readonly ConversationRow[], sessionId: string): string {
  const out: string[] = [];
  let calls = 0;
  let hidden = false;
  for (const row of rows) {
    const step = protoFields(row.payload);
    const meta = protoFields(sub(step, 5) ?? new Uint8Array());
    const seconds = num(protoFields(sub(meta, 1) ?? new Uint8Array()), 1);
    const timestamp = seconds ? new Date(seconds * 1000).toISOString() : undefined;
    const emit = (r: Record<string, unknown>): void => { out.push(JSON.stringify({ ...r, sessionId, ...(timestamp ? { timestamp } : {}) })); };
    if (row.type === STEP_USER) {
      const prompt = text(protoFields(sub(step, 19) ?? new Uint8Array()), 2);
      const words = ownerWords(prompt);
      hidden = !words;
      if (words) emit({ type: 'user', message: { role: 'user', content: words } });
      continue;
    }
    if (row.type !== STEP_MODEL || hidden) continue;
    const model = protoFields(sub(step, 20) ?? new Uint8Array());
    const content: Record<string, unknown>[] = [];
    const said = text(model, 1);
    if (said.trim()) content.push({ type: 'text', text: said });
    for (const f of model) {
      if (f.no !== 7 || typeof f.value === 'number') continue;
      const call = protoFields(f.value);
      const tool = canonicalTool(text(call, 2), text(call, 3));
      if (tool.name) content.push({ type: 'tool_use', id: text(call, 1) || `agy_${++calls}`, name: tool.name, input: tool.input });
    }
    const usage = protoFields(sub(meta, 9) ?? new Uint8Array());
    const tokens = { input_tokens: num(usage, 2), output_tokens: num(usage, 3) };
    if (content.length || tokens.input_tokens) emit({ type: 'assistant', message: { role: 'assistant', content, ...(tokens.input_tokens ? { usage: tokens } : {}) } });
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

type Sqlite = { DatabaseSync: new (path: string, o: { readOnly: boolean }) => { prepare: (q: string) => { all: () => unknown[] }; close: () => void } };

/**
 * This thread's conversation, written as a transcript; its path, or null when it cannot be read.
 * Read through `getBuiltinModule`: the bundle stays loadable on a Node with no `node:sqlite`.
 */
export function writeAntigravityTranscript(thread: string, accountId: string, o: { home?: string; readRows?: (db: string) => ConversationRow[] } = {}): string | null {
  if (!THREAD_RE.test(thread)) return null;
  const home = o.home ?? homedir();
  const db = join(antigravityProfileDir(accountId, home), 'antigravity-acp', 'conversations', `${thread}.db`);
  if (!existsSync(db)) return null;
  const dir = antigravityTranscriptsDir(home);
  const path = join(dir, `${thread}.jsonl`);
  const staged = `${path}.${process.pid}.tmp`;
  try {
    const rows = (o.readRows ?? readSteps)(db);
    const lines = conversationToClaudeJsonl(rows, thread);
    if (!lines) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(staged, lines, { mode: 0o600 });
    chmodSync(staged, 0o600);
    renameSync(staged, path);
    return path;
  } catch {
    rmSync(staged, { force: true });
    return null;
  }
}

function readSteps(db: string): ConversationRow[] {
  const sqlite = (process as unknown as { getBuiltinModule?: (id: string) => Sqlite | undefined }).getBuiltinModule?.('node:sqlite');
  if (!sqlite) throw new Error('this Node has no node:sqlite');
  const conn = new sqlite.DatabaseSync(db, { readOnly: true });
  try {
    return (conn.prepare('SELECT step_type, step_payload FROM steps ORDER BY idx').all() as Array<{ step_type: number; step_payload: Uint8Array | null }>)
      .filter((r) => r.step_payload).map((r) => ({ type: r.step_type, payload: r.step_payload! }));
  } finally {
    conn.close();
  }
}
