#!/usr/bin/env node
/**
 * FIELD EVIDENCE for the owed ledger (task super-hicbir-konuyu-kacirmaz): replays a real Super
 * transcript, and the transcripts of the children it delegated to (with their sub-agents), and
 * rebuilds what the ledger WOULD have kept, with the ledger's own pure rules (owed.ts):
 *
 *   - a debt per owner message (`<owner-msg ref="…"/>`, typed or absorbed mid-turn, card answers too);
 *   - a debt per awaited=owner result an event turn or a held block handed the Super;
 *   - a debt per outward action a child completed (`outwardAction`, non-error tool_result);
 *   - closed by a line-start `<!-- re:<ref> -->` section of a Super text, one each, oldest first.
 *
 * Prints the debts open at each turn end, then the ones never closed. Not a test of the record's
 * write path (the unit and live checks are): a reading of what happened. Transcripts are read in
 * place, never copied; the report goes to tmp/. The rules are the source's own (`dist` is one
 * bundle), read through tsx:
 *
 *   npx tsx scripts/verify/super-owed-replay.mjs <super transcript.jsonl> [--children <dir|file>…] [--no-find] [--out <file>]
 *
 * Children are found by themselves from the Super's `super delegate`/`resume`/`send` results
 * (`"child": "<session id>"`) under ~/.claude/projects, unless --no-find.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const owed = await import(join(ROOT, 'src', 'lib', 'super', 'owed.ts'));
const { replyMarkRefs, outwardAction, owedRef, cutGist } = owed;

const args = process.argv.slice(2);
const superFile = args.find((a) => !a.startsWith('--') && a.endsWith('.jsonl'));
if (!superFile || !existsSync(superFile)) {
  console.error('usage: npx tsx scripts/verify/super-owed-replay.mjs <super transcript.jsonl> [--children <dir|file>…] [--no-find] [--out <file>]');
  process.exit(2);
}
const childArgs = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--children') while (args[i + 1] && !args[i + 1].startsWith('--')) childArgs.push(args[++i]);
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const find = !args.includes('--no-find');

const readLines = (file) => readFileSync(file, 'utf-8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');
const ts = (l) => Date.parse(l.timestamp ?? '') || 0;
const hhmm = (t) => (t ? new Date(t).toISOString().slice(11, 16) : '--:--');

// ─── The Super's timeline ───────────────────────────────────────────────────────
const events = [];
const superLines = readLines(superFile);
const childIds = new Set();
let lastT = 0;
for (const l of superLines) {
  const t = ts(l) || lastT;
  lastT = t;
  if (l.isSidechain) continue;
  // A message he wrote while the Super worked: absorbed into the running turn.
  if (l.type === 'attachment' && l.attachment?.type === 'queued_command') {
    const text = textOf(l.attachment.prompt);
    const m = /<owner-msg ref="([0-9a-z]{6})"(?: parts="([^"]*)")?\/>/.exec(text);
    if (m) events.push({ t, kind: 'msg', ref: m[1], parts: m[2] ? m[2].split(' ') : [], gist: text.split('\n<owner-msg')[0], mid: true });
    continue;
  }
  if (l.type !== 'user' && l.type !== 'assistant') continue;
  const content = l.message?.content;
  if (l.type === 'assistant') {
    const text = textOf(content);
    if (text) events.push({ t, kind: 'say', refs: replyMarkRefs(text), text });
    continue;
  }
  // A tool result: the children a verb named.
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) {
    for (const b of content) {
      const raw = typeof b?.content === 'string' ? b.content : textOf(b?.content);
      for (const m of raw.matchAll(/"child":\s*"([0-9a-f-]{36})"/g)) childIds.add(m[1]);
    }
    continue;
  }
  const text = textOf(content);
  if (!text) continue;
  events.push({ t, kind: 'turn' });
  const m = /<owner-msg ref="([0-9a-z]{6})"(?: parts="([^"]*)")?\/>/.exec(text);
  if (m) events.push({ t, kind: 'msg', ref: m[1], parts: m[2] ? m[2].split(' ') : [], gist: text.split('\n<owner-msg')[0] });
  // Results he waited on, in an event turn or a held block.
  if (text.startsWith('[super events]') || text.includes('<super-while-you-asked')) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const it = /^- item=(\S+) (?:child=\S+ |team=\S+ ).*?event=(done|stuck|gone)\b.*?awaited=owner(?: origin=([0-9a-z]{6}))?(?:.*? ref=([0-9a-z]{6}))?/.exec(line);
      const sent = /sent="([^"]*)"/.exec(line);
      if (!it && !sent) return;
      const item = /^- item=(\S+)/.exec(line)?.[1] ?? '?';
      const near = lines.slice(i + 1, i + 6).join(' ');
      const brief = (/Brief: ([^<]*)/.exec(near)?.[1] ?? /(?:Answer|Last reply): ([^<]*)/.exec(near)?.[1] ?? '').trim();
      events.push({ t, kind: 'result', ref: it?.[4] ?? it?.[3] ?? owedRef(item), item, gist: brief, ...(sent ? { sent: sent[1] } : {}) });
    });
  }
}
events.push({ t: lastT, kind: 'turn' });

// ─── The children's outward actions ─────────────────────────────────────────────
const childFiles = new Set();
const addPath = (p) => {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) { for (const f of readdirSync(p)) if (f.endsWith('.jsonl')) childFiles.add(join(p, f)); }
  else childFiles.add(p);
};
childArgs.forEach(addPath);
// The Super's own session sends too when it was given a tool that does (Tilki 2026-11-05).
childFiles.add(superFile);
if (find && childIds.size) {
  const base = join(homedir(), '.claude', 'projects');
  for (const proj of existsSync(base) ? readdirSync(base) : []) {
    for (const id of childIds) addPath(join(base, proj, `${id}.jsonl`));
  }
}
for (const f of [...childFiles]) {
  const sub = join(dirname(f), basename(f, '.jsonl'), 'subagents');
  if (existsSync(sub)) for (const s of readdirSync(sub)) if (/^agent-.*\.jsonl$/.test(s)) childFiles.add(join(sub, s));
}
let sends = 0;
for (const f of childFiles) {
  const open = new Map();
  const childId = basename(f, '.jsonl').startsWith('agent-') ? basename(dirname(dirname(f))) : basename(f, '.jsonl');
  const who = f === superFile ? 'the Super itself' : `child ${childId.slice(0, 8)}`;
  for (const l of readLines(f)) {
    if (l.type !== 'user' && l.type !== 'assistant') continue;
    const content = l.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (l.type === 'assistant' && b?.type === 'tool_use') {
        const what = outwardAction(b.name, b.input);
        if (what) open.set(b.id, what);
      } else if (l.type === 'user' && b?.type === 'tool_result' && open.has(b.tool_use_id)) {
        const what = open.get(b.tool_use_id);
        open.delete(b.tool_use_id);
        if (b.is_error === true) continue;
        sends += 1;
        events.push({ t: ts(l), kind: 'result', ref: owedRef(`send:${b.tool_use_id}`), item: who, gist: `${what}`, sent: what });
      }
    }
  }
}

// ─── The ledger, replayed ───────────────────────────────────────────────────────
events.sort((a, b) => a.t - b.t);
const debts = [];
let seq = 0;
const out = [];
const say = (s) => { out.push(s); console.log(s); };
say(`Super ${basename(superFile)}: ${superLines.length} lines, ${childFiles.size} child transcript(s), ${sends} outward action(s).`);
let turns = 0;
for (const e of events) {
  if (e.kind === 'msg') debts.push({ id: `o${++seq}`, kind: 'msg', ref: e.ref, parts: e.parts, at: e.t, gist: cutGist(e.gist, 90), mid: !!e.mid });
  else if (e.kind === 'result') debts.push({ id: `o${++seq}`, kind: 'result', ref: e.ref, at: e.t, gist: cutGist(`${e.item}: ${e.gist}`, 90), ...(e.sent ? { sent: e.sent } : {}) });
  else if (e.kind === 'say') {
    for (const ref of e.refs) {
      const d = debts.find((x) => !x.closed && (x.ref === ref || x.parts?.includes(ref)));
      if (d) d.closed = e.t;
    }
  } else if (e.kind === 'turn') {
    turns += 1;
    const open = debts.filter((d) => !d.closed);
    if (open.length) say(`turn end ${hhmm(e.t)}: ${open.length} open: ${open.map((d) => `${d.kind}:${d.ref}${d.sent ? `(sent ${d.sent})` : ''}`).join(', ')}`);
  }
}
const never = debts.filter((d) => !d.closed);
say(`\n${turns} turns, ${debts.length} debts, ${never.length} never closed by a section:`);
for (const d of never) say(`  ${d.id} ${d.kind} ref=${d.ref} at=${hhmm(d.at)}${d.mid ? ' (written mid-turn)' : ''}${d.sent ? ` sent=${d.sent}` : ''}: ${d.gist}`);
const file = outArg ?? join(ROOT, 'tmp', 'super-owed-replay', `${basename(superFile, '.jsonl')}.txt`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${out.join('\n')}\n`);
console.log(`\nreport: ${file}`);
