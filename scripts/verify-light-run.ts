/**
 * Proves the light job's envelope on the REAL claude binary, with NO model call: a loopback fake of
 * the Messages API plays the model and asks for one tool per turn; claude's own permission layer
 * answers. A scratch HOME and project, whose settings try to widen the envelope.
 *
 *   npx tsx scripts/verify-light-run.ts
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIGHT_JOB_BLOCK, lightRunArgs } from '../src/lib/automations/light-run.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'light-verify-')));
const home = join(base, 'home');
const project = join(base, 'project');
mkdirSync(join(project, '.claude'), { recursive: true });
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(join(home, '.ssh'), { recursive: true });
writeFileSync(join(home, '.ssh', 'id_rsa'), 'SECRET-KEY');
writeFileSync(join(project, 'notes.txt'), 'READABLE-NOTE');
writeFileSync(join(project, '.env'), 'SECRET=ENV-VALUE');
mkdirSync(join(base, 'sibling'));
writeFileSync(join(base, 'sibling', '.env'), 'SECRET=ENV-VALUE');
writeFileSync(join(project, 'CLAUDE.md'), 'CLAUDE-MD-MARKER');
const hookMark = join(base, 'hook-ran');
// A project that tries to widen the envelope: its allow rules and its hook must not reach the job.
writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({
  permissions: { allow: ['Bash(*)', 'Write(*)', 'mcp__fake__send_item', 'mcp__fake__delete_item', 'mcp__fake'] },
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${hookMark}` }] }] },
}));
const log = join(base, 'mcp-calls.log');
const server = join(base, 'mcp.mjs');
writeFileSync(server, `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const tools = ['list_items', 'send_item', 'delete_item'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') say({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (m.method === 'tools/list') say({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call') { appendFileSync(${JSON.stringify(log)}, m.params.name + '\\n'); say({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'called ' + m.params.name }] } }); }
  else if (m.id !== undefined) say({ jsonrpc: '2.0', id: m.id, result: {} });
});
`);
const mcpConfig = join(base, 'mcp.json');
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server] } } }));

/** One tool a turn: what the fake model asks for, and whether the envelope must let it run. */
const wrote = join(project, 'written.txt');
const steps: Array<{ name: string; input: Record<string, unknown>; open: boolean }> = [
  { name: 'Read', input: { file_path: join(project, 'notes.txt') }, open: true },
  { name: 'mcp__fake__list_items', input: {}, open: true },
  { name: 'Bash', input: { command: `touch ${wrote}`, description: 'x' }, open: false },
  { name: 'Write', input: { file_path: wrote, content: 'x' }, open: false },
  { name: 'Edit', input: { file_path: join(project, 'notes.txt'), old_string: 'READABLE', new_string: 'x' }, open: false },
  { name: 'mcp__fake__send_item', input: {}, open: false },
  { name: 'mcp__fake__delete_item', input: {}, open: false },
  { name: 'WebFetch', input: { url: 'https://example.com', prompt: 'x' }, open: false },
  { name: 'Read', input: { file_path: join(project, '.env') }, open: false },
  { name: 'Read', input: { file_path: join(home, '.ssh', 'id_rsa') }, open: false },
  { name: 'Read', input: { file_path: join(base, 'sibling', '.env') }, open: false },
  { name: 'ListMcpResourcesTool', input: {}, open: false },
];
let turn = 0;
const results: Array<{ step: string; isError: boolean; text: string }> = [];
let firstSystem = '';
let firstTools: string[] = [];
let firstUser = '';

const sse = (res: import('node:http').ServerResponse, msg: { content: Array<Record<string, unknown>>; stop: string }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  msg.content.forEach((c, i) => {
    if (c.type === 'text') {
      ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: c.text } });
    } else {
      ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
      ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
    }
    ev('content_block_stop', { index: i });
  });
  ev('message_delta', { delta: { stop_reason: msg.stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  ev('message_stop', {});
  res.end();
};

const api = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":1}'); return; }
    const body = JSON.parse(raw) as { system?: unknown; tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> };
    if (!body.tools?.length) { sse(res, { content: [{ type: 'text', text: 'ok' }], stop: 'end_turn' }); return; }
    if (turn === 0) {
      firstSystem = JSON.stringify(body.system ?? '');
      firstTools = body.tools.map((t) => t.name);
      firstUser = JSON.stringify(body.messages[0]?.content ?? '');
    }
    // The whole history comes each turn: read the tool results fresh, in order.
    results.length = 0;
    for (const m of body.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Array<{ type: string; is_error?: boolean; content?: unknown }>) {
        if (b.type === 'tool_result') results.push({ step: '', isError: b.is_error === true, text: JSON.stringify(b.content).slice(0, 200) });
      }
    }
    const step = steps[turn];
    turn += 1;
    if (!step) { sse(res, { content: [{ type: 'text', text: 'DONE' }], stop: 'end_turn' }); return; }
    sse(res, { content: [{ type: 'tool_use', id: `toolu_${turn}`, name: step.name, input: step.input }], stop: 'tool_use' });
  });
});

await new Promise<void>((d) => api.listen(0, '127.0.0.1', () => d()));
const port = (api.address() as { port: number }).port;
const args = ['-p', 'go', ...lightRunArgs({ readTools: ['mcp__fake__list_items'] }, home), '--model', 'haiku', '--output-format', 'json', '--mcp-config', mcpConfig];
const run = (argv: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
  const child = spawn('claude', argv, {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: 'sk-ant-fake', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const t = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.on('close', (c) => { clearTimeout(t); done({ code: c, out }); });
});
const first = await run(args);
const code = first.code;
if (code !== 0) console.log(first.out.slice(0, 800));
const finalResults = [...results];
// A resume opens its prompt with the light block: it must reach claude as a prompt, not a flag.
const session = (JSON.parse(first.out) as { session_id?: string }).session_id ?? '';
const resumed = await run(['--resume', session, '-p', `${LIGHT_JOB_BLOCK}\n\nagain`, ...args.slice(2)]);
api.close();

let failed = code === 0 ? 0 : 1;
const check = (ok: boolean, line: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`); if (!ok) failed += 1; };
console.log(`claude exit ${code}; tools offered: ${firstTools.join(' ')}`);
steps.forEach((s, i) => {
  const r = finalResults[i];
  const secret = /READABLE|called list_items/.test(r?.text ?? '');
  const opened = !!r && !r.isError;
  check(opened === s.open && (!s.open || secret), `${s.name} ${JSON.stringify(s.input).slice(0, 60)} → ${opened ? 'ran' : 'denied'} ${r ? r.text : '(no result)'}`);
});
check(resumed.code === 0, `a resumed light turn runs (exit ${resumed.code}) ${resumed.code ? resumed.out.slice(0, 160) : ''}`);
const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n') : [];
check(calls.join() === 'list_items', `the MCP server saw only: ${calls.join(', ')}`);
check(!existsSync(wrote), 'no file was written');
check(!existsSync(hookMark), 'the project\'s SessionStart hook did not run');
check(!firstSystem.includes('CLAUDE-MD-MARKER') && !firstUser.includes('CLAUDE-MD-MARKER'), 'CLAUDE.md did not load');
check(!JSON.stringify(finalResults).includes('ENV-VALUE') && !JSON.stringify(finalResults).includes('SECRET-KEY'), 'no credential reached the model');
rmSync(base, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
