#!/usr/bin/env node
/**
 * A stand-in `codex app-server` for /verify (scripts/verify/tool-codex-chat.mjs), built from
 * T3 Code's own RECORDED Codex app-server transcripts (src/vendor/t3/.../testkit/fixtures/*), so
 * every frame the bridge decodes is one a real Codex 0.156 sent. No network, no account, no cost.
 *
 * Lenient where T3's in-process replay is strict: request ids are rewritten to the ones the client
 * really used, every thread id becomes this process's thread, and the scenario is chosen per turn
 * by a keyword in the prompt:
 *   APPROVE → a shell command that asks for approval     QUESTION → a structured question
 *   DIFF    → a file change behind an approval           INTERRUPT → a turn that waits to be stopped
 *   PLAN    → a plan (todo list)                          RUN: <cmd> → runs <cmd> in a shell, the reply is its output
 *   ASYNCASK → an async question (`request_user_input_async`: Codex 0.164 ends the turn on an
 *              agentMessage with `delivery: "async"` and its `questions`); the next turn that
 *              carries "My answer: X" replies "PICKED X"
 *   anything else → a short text reply. The tab name only
 *                                                          comes from the bridge's hidden follow-up turn.
 *
 *   FAKE_CODEX_FIXTURES=<fixtures dir> codex app-server [-c …]   (the -c overrides are ignored)
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.FAKE_CODEX_FIXTURES;
const LOG = process.env.FAKE_CODEX_LOG;
const log = (s) => { if (LOG) try { appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`); } catch { /* best effort */ } };
if (!DIR) { process.stderr.write('fake-codex: FAKE_CODEX_FIXTURES is not set\n'); process.exit(2); }
if (process.argv[2] !== 'app-server') { process.stdout.write('codex-cli 0.164.0\n'); process.exit(0); }
// Which home this app-server runs with (a non-#0 account runs with its own; Track T W2).
log(`app-server CODEX_HOME=${process.env.CODEX_HOME ?? ''}`);
// The `-c` overrides the bridge launched us with (W3): which keys, and whether the developer
// instructions ever carry brain content (they must not). Values are not logged.
{
  const cfg = [];
  for (let i = 3; i < process.argv.length; i++) if (process.argv[i - 1] === '-c') cfg.push(process.argv[i]);
  const dev = cfg.find((c) => c.startsWith('developer_instructions=')) ?? '';
  log(`config keys=${cfg.map((c) => c.split('=')[0]).join(',')} devHasBrain=${/Agent Context|BRAIN-MARKER/.test(dev)} context_by=${process.env.DREAMCONTEXT_CONTEXT_BY ?? ''}`);
  // Which chat mode's briefing the developer instructions carry (scenario tour: Plan, Develop).
  log(`devMode=${(dev.match(/# Mode: ([A-Za-z]+)/) ?? [])[1] ?? 'none'}`);
  const mcp = cfg.find((c) => c.startsWith('mcp_servers.dreamcontext.args=')) ?? '';
  if (mcp) log(`mcp args=${mcp.slice('mcp_servers.dreamcontext.args='.length)}`);
  const mcpEnv = cfg.find((c) => c.startsWith('mcp_servers.dreamcontext.env=')) ?? '';
  if (mcpEnv) log(`mcp env=${mcpEnv.slice('mcp_servers.dreamcontext.env='.length)}`);
}

const load = (scenario) => readFileSync(join(DIR, scenario, 'codex_transcript.ndjson'), 'utf-8')
  .trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type !== 'transcript_start');
const SIMPLE = load('simple');
const firstResponse = (entries, label) => entries.find((e) => e.type === 'emit_inbound' && e.label === label && e.frame.id !== undefined && !e.frame.method);
const recordedThread = (entries) => firstResponse(entries, 'thread/start')?.frame.result.thread.id;

const SCENARIOS = [
  [/APPROVE/, 'tool_call_read_only_on_request'],
  [/QUESTION/, 'plan_questions'],
  [/DIFF/, 'tool_call_restricted_granular'],
  [/INTERRUPT/, 'turn_interrupt'],
  [/PLAN/, 'todo_list'],
];
const TITLE = '\n\n```dream-view\n{"type":"title","text":"Codex verify chat"}\n```';

let thread = '';
let cwd = '';
/** This turn is the bridge's hidden tab-title follow-up: it answers with the title block. */
let wantTitle = false;
let turnSeq = 0;

/** Like real Codex: one rollout per thread under ~/.codex/sessions/YYYY/MM/DD, `session_meta` first. */
function rolloutPath() {
  const d = new Date();
  const dir = join(homedir(), '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const existing = readdirSync(dir).find((n) => n.endsWith(`-${thread}.jsonl`));
  return join(dir, existing ?? `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${thread}.jsonl`);
}
function record(payload) {
  if (!thread) return;
  const p = rolloutPath();
  if (!existsSync(p)) appendFileSync(p, JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: thread, cwd } }) + '\n');
  if (!payload) return;
  // A usage record is its own rollout line type, as in a real rollout.
  const line = payload.type === 'token_usage_record'
    ? { timestamp: new Date().toISOString(), type: 'token_usage_record', payload: { thread_id: thread, response_id: payload.response_id, usage: payload.usage } }
    : { timestamp: new Date().toISOString(), type: 'response_item', payload };
  appendFileSync(p, JSON.stringify(line) + '\n');
}
let pending = null; // { entries, pos } waiting at an expect_outbound
/** BRAIN turns: the reply quotes what arrived as app context (W3), instead of the fixture text. */
let override = '';
let overrideSent = false;
/** ASYNCASK turns: the reply is an async question instead of the fixture text. */
let asyncAsk = false;
const ASYNC_QUESTION = { title: 'Which color?', options: ['Red', 'Blue'] };
/** Like real Codex: injected context and the owner's text are tagged by kind in the rollout. */
function recordUser(kind, text) {
  record({ type: 'message', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { content_item_kinds: [kind] } });
}
/** Client answers that arrived before the transcript reached the point that waits for them. */
let earlyAnswers = 0;
const out = (frame) => { process.stdout.write(JSON.stringify(frame) + '\n'); log(`→ ${frame.method ?? `response ${frame.id}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Re-home a recorded frame onto this process's thread. */
function rehome(frame, fromThread) {
  if (!fromThread || !thread) return frame;
  // A recording has one id per message; real Codex never reuses one across turns.
  return JSON.parse(JSON.stringify(frame).split(fromThread).join(thread).replace(/msg_[0-9a-f]+/g, `$&${turnSeq}`));
}

function threadReply(id, threadId) {
  const rec = firstResponse(SIMPLE, 'thread/start').frame;
  const reply = rehome(rec, recordedThread(SIMPLE));
  reply.id = id;
  reply.result.thread.id = threadId;
  return reply;
}

/** Emit recorded inbound frames from `pos` until the transcript waits for the client. */
async function pump(entries, pos, from, scenario) {
  for (let i = pos; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'runtime_exit') return;
    if (e.type === 'expect_outbound') {
      // An answer to a server request (no method in the recorded frame) may already be in.
      if (!e.frame.method && earlyAnswers > 0) { earlyAnswers--; continue; }
      pending = { entries, pos: i, from, scenario };
      log(`waits for ${e.label}`);
      return;
    }
    let frame = rehome(e.frame, from);
    // Responses to requests already answered (or never sent by this client) are not replayed.
    if (frame.id !== undefined && !frame.method) continue;
    // An async question arrives whole, on its item/completed, as in a real Codex 0.164 rollout.
    if (asyncAsk && scenario === 'simple') {
      const item = frame.params?.item;
      if (frame.method === 'item/agentMessage/delta' || (frame.method === 'item/started' && item?.type === 'agentMessage')) continue;
      if (frame.method === 'item/completed' && item?.type === 'agentMessage') {
        frame = { ...frame, params: { ...frame.params, item: { ...item, text: `${ASYNC_QUESTION.title}\n- ${ASYNC_QUESTION.options.join('\n- ')}`, delivery: 'async', questions: [ASYNC_QUESTION] } } };
        asyncAsk = false;
      }
    }
    // A BRAIN turn: the first text delta carries the whole override, later ones are dropped.
    if (override && scenario === 'simple' && frame.method === 'item/agentMessage/delta') {
      if (overrideSent) continue;
      overrideSent = true;
      frame = { ...frame, params: { ...frame.params, delta: override } };
    }
    if (override && scenario === 'simple' && frame.method === 'item/completed' && frame.params?.item?.type === 'agentMessage') {
      frame = { ...frame, params: { ...frame.params, item: { ...frame.params.item, text: override } } };
      override = '';
      overrideSent = false;
    }
    if (wantTitle && scenario === 'simple' && frame.method === 'item/completed' && frame.params?.item?.type === 'agentMessage') {
      out({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: frame.params.turnId, itemId: frame.params.item.id, delta: TITLE } });
      frame = { ...frame, params: { ...frame.params, item: { ...frame.params.item, text: frame.params.item.text + TITLE } } };
    }
    if (frame.method === 'item/completed' && frame.params?.item?.type === 'agentMessage') {
      record({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: frame.params.item.text }] });
    }
    out(frame);
    await sleep(frame.method?.endsWith('/delta') ? 60 : 15);
  }
  pending = null;
}

async function onRequest(msg) {
  switch (msg.method) {
    case 'initialize': {
      const r = firstResponse(SIMPLE, 'initialize').frame;
      out({ ...r, id: msg.id });
      return;
    }
    case 'thread/start':
      thread = randomUUID().replace(/^.{8}/, '01a18f00');
      cwd = String(msg.params?.cwd ?? process.cwd());
      record(null);
      out(threadReply(msg.id, thread));
      return;
    case 'thread/resume':
      thread = String(msg.params?.threadId ?? randomUUID());
      cwd = String(msg.params?.cwd ?? process.cwd());
      out(threadReply(msg.id, thread));
      return;
    case 'turn/start': {
      const text = (msg.params?.input ?? []).map((p) => p.text ?? '').join(' ');
      // DIE: Codex crashes mid-turn (the bridge must close the turn and end, not hang).
      if (/\bDIE\b/.test(text)) {
        out({ id: msg.id, result: { turn: { id: 'turn-dies', items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null } } });
        setTimeout(() => process.exit(9), 300);
        return;
      }
      wantTitle = text.includes('dreamcontext_tab_title');
      turnSeq += 1;
      const scenario = SCENARIOS.find(([re]) => re.test(text))?.[1] ?? 'simple';
      log(`turn/start "${text.slice(0, 60)}" → ${scenario}`);
      // App context (W3): which entries, of which kind, and their sizes; never their text.
      const extra = msg.params?.additionalContext ?? {};
      log(`turn/start additionalContext ${Object.entries(extra).map(([k, v]) => `${k}:${v?.kind}:${String(v?.value ?? '').length}`).join(',') || 'none'}`);
      for (const [k, v] of Object.entries(extra)) recordUser(`additional_content.${k}`, `<external_${k}>${v?.value ?? ''}</external_${k}>`);
      if (/\bBRAIN\b/.test(text)) {
        const pick = (key) => String(extra[key]?.value ?? '').split('\n').find((l) => /checkout/i.test(l))?.trim() ?? '(nothing)';
        override = `From the brain: ${pick('dreamcontext-brain')} · Recall: ${pick('dreamcontext-prompt')}`;
      }
      // RUN: the agent runs one shell command in its own environment (scenario tour: a Codex chat
      // asking Claude with `dreamcontext ask`), and answers with what it printed.
      const run = text.match(/\bRUN: (.+)$/m);
      if (run) {
        const r = spawnSync('/bin/sh', ['-c', run[1]], { cwd, encoding: 'utf-8', timeout: 120_000 });
        log(`RUN exit=${r.status} ${run[1].slice(0, 80)}`);
        override = `RAN (exit ${r.status}): ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 600)}`;
      }
      // A carried chat (W4): the reply quotes what the new thread was handed from the old one.
      if (/\bASYNCASK\b/.test(text)) asyncAsk = true;
      const answer = text.match(/My answer: ([^\n]+)/);
      if (answer) override = `PICKED ${answer[1].trim()}`;
      if (/\bHISTORY\b/.test(text)) override = `Handed over: ${String(extra['dreamcontext-prompt']?.value ?? '').split('\n').find((l) => /marigold/.test(l))?.trim() ?? '(nothing)'}`;
      recordUser(wantTitle ? 'user.text' : 'user.text', text);
      record({ type: 'token_usage_record', usage: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 120 }, response_id: `resp_${turnSeq}` });
      const entries = scenario === 'simple' ? SIMPLE : load(scenario);
      const at = entries.findIndex((e) => e.type === 'expect_outbound' && e.label === 'turn/start');
      const reply = entries.slice(at).find((e) => e.type === 'emit_inbound' && e.frame.id !== undefined && !e.frame.method && e.frame.result?.turn);
      out({ ...rehome(reply.frame, recordedThread(entries)), id: msg.id });
      void pump(entries, at + 1, recordedThread(entries), scenario);
      return;
    }
    case 'turn/interrupt': {
      if (pending && pending.entries[pending.pos]?.label === 'turn/interrupt') {
        const { entries, pos, from, scenario } = pending;
        const reply = entries.slice(pos + 1).find((e) => e.type === 'emit_inbound' && e.frame.id !== undefined && !e.frame.method);
        out({ ...(reply ? rehome(reply.frame, from) : { result: {} }), id: msg.id });
        void pump(entries, pos + 1, from, scenario);
        return;
      }
      out({ id: msg.id, result: {} });
      return;
    }
    case 'mcpServerStatus/list': {
      // The app-server's own server status (scenario tour: the MCP card). A server named
      // `broken-…` shows no tools, every other one three.
      const name = String(msg.params?.serverName ?? 'dreamcontext');
      out({ id: msg.id, result: { data: [{ name, tools: /^broken-/.test(name) ? {} : Object.fromEntries(['a', 'b', 'c'].map((t) => [t, { name: t, inputSchema: { type: 'object' } }])), resources: [], resourceTemplates: [], authStatus: 'unsupported' }], nextCursor: null } });
      return;
    }
    case 'turn/steer':
      // Accepted into the running turn, as Codex does; the recorded turn goes on unchanged.
      record({ type: 'message', role: 'user', content: [{ type: 'input_text', text: (msg.params?.input ?? []).map((p) => p.text ?? '').join(' ') }] });
      out({ id: msg.id, result: { turnId: String(msg.params?.expectedTurnId ?? msg.params?.turnId ?? '') } });
      return;
    default:
      log(`unscripted request ${msg.method}: empty result`);
      out({ id: msg.id, result: {} });
  }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    log(`← ${msg.method ?? `response ${msg.id}`}`);
    if (msg.method && msg.id !== undefined) void onRequest(msg);
    else if (!msg.method && !pending) earlyAnswers++;
    else if (!msg.method && pending) {
      // The client answered a server request (an approval, a question): the transcript goes on.
      const { entries, pos, from, scenario } = pending;
      pending = null;
      void pump(entries, pos + 1, from, scenario);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
