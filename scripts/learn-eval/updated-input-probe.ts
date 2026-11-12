/**
 * Transport probe (plan D8, criterion 11). Model runs, at Close; about $1.
 *
 *   npx vite-node scripts/learn-eval/updated-input-probe.ts -- [--extra] [--dry-run] [--max-run-usd 1]
 *
 * A scratch PreToolUse hook on `Agent` answers `updatedInput` (prompt + one rule carrying a
 * nonce) with no `permissionDecision`; a scratch SubagentStart hook carries the "personal block"
 * (a second rule, its own nonce). The main session is asked to dispatch one sub-agent and copy
 * its reply verbatim. Shapes (the three of criterion 11):
 *   terminal-bypass (--permission-mode bypassPermissions), app-default (default), app-auto (auto).
 * With --extra, three more on app-default: the append with an existing `allow` grant kept, a
 * denied dispatch (nothing must be delivered), and the append disabled (the sub-agent must still
 * have the personal block).
 * Proof per run: the nonce in the sub-agent's reply, and the appended rule in the sub-agent's
 * first user message in its transcript (~/.claude/projects/<slug>/<session>/subagents/). Codex:
 * recorded "not measurable" here (no Codex run in this probe).
 * "App shape" is approximated by the permission mode the app chat runs in; the app's own argv
 * (stream-json input, its permission tool) is not reproduced: named in the results.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendGuard, cleanEnv, denyRules, evalClaudeArgs, flagNum, parseArgs, resultsDir, runClaude, spendLedgerPath, stamp, table, writePrivate } from './lib.js';

const { flags } = parseArgs(process.argv.slice(2));
const dryRun = flags['dry-run'] === true;
const maxRunUsd = flagNum(flags, 'max-run-usd', 1);

type Mode = 'append' | 'grant' | 'deny' | 'off';
interface Case { name: string; permission: 'bypassPermissions' | 'default' | 'auto'; mode: Mode }
const cases: Case[] = [
  { name: 'terminal-bypass', permission: 'bypassPermissions', mode: 'append' },
  { name: 'app-default', permission: 'default', mode: 'append' },
  { name: 'app-auto', permission: 'auto', mode: 'append' },
  ...(flags.extra === true ? [
    { name: 'app-default-grant-kept', permission: 'default', mode: 'grant' },
    { name: 'app-default-denied', permission: 'default', mode: 'deny' },
    { name: 'app-default-append-off', permission: 'default', mode: 'off' },
  ] as Case[] : []),
];

const guard = new SpendGuard({ plan: { script: 'updated-input-probe', runs: cases.length, perRunEstimateUsd: 0.35, perRunMaxUsd: maxRunUsd }, ledgerPath: spendLedgerPath() });
guard.announce();
console.log(table(['case', 'permission mode', 'hook answer'], cases.map((c) => [c.name, c.permission, c.mode])));
if (dryRun) { console.log('Dry run: nothing spent.'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'learn-probe-'));
const proj = join(dir, 'lumen-ledger');
const hooks = join(dir, 'hooks');
mkdirSync(proj, { recursive: true });
mkdirSync(hooks, { recursive: true });
writeFileSync(join(proj, 'README.md'), '# Lumen Ledger\n\nA synthetic project for a hook probe.\n');

const pre = `import { appendFileSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf-8') || '{}');
const mode = process.env.PROBE_MODE || 'append';
const rule = process.env.PROBE_RULE || '';
const log = (o) => appendFileSync(process.env.PROBE_LOG, JSON.stringify(o) + '\\n');
if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') process.exit(0);
const ti = input.tool_input || {};
if (mode === 'off') { log({ mode, tool: input.tool_name }); process.exit(0); }
if (mode === 'deny') {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'probe: dispatch denied' } };
  log({ mode, out }); process.stdout.write(JSON.stringify(out)); process.exit(0);
}
const updated = { ...ti, prompt: String(ti.prompt || '') + '\\n\\n' + rule };
const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated, ...(mode === 'grant' ? { permissionDecision: 'allow', permissionDecisionReason: 'probe: existing grant' } : {}) } };
log({ mode, out });
process.stdout.write(JSON.stringify(out));
`;
const sub = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PROBE_LOG, JSON.stringify({ event: 'SubagentStart' }) + '\\n');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: process.env.PROBE_PERSONAL || '' } }));
`;
writeFileSync(join(hooks, 'pre.mjs'), pre);
writeFileSync(join(hooks, 'sub.mjs'), sub);
const node = JSON.stringify(process.execPath);
const settingsPath = join(dir, 'settings.json');
writeFileSync(settingsPath, JSON.stringify({
  permissions: { allow: ['Agent', 'Read'], deny: denyRules(homedir()) },
  hooks: {
    PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: `${node} ${JSON.stringify(join(hooks, 'pre.mjs'))}` }] }],
    SubagentStart: [{ hooks: [{ type: 'command', command: `${node} ${JSON.stringify(join(hooks, 'sub.mjs'))}` }] }],
  },
}, null, 2));

/** Sub-agent transcripts of one session, wherever its project slug put them. */
function subagentFirstUserMessages(sessionId: string): string[] {
  const root = join(homedir(), '.claude', 'projects');
  const out: string[] = [];
  let projects: string[] = [];
  try { projects = readdirSync(root); } catch { return out; }
  for (const p of projects) {
    const d = join(root, p, sessionId, 'subagents');
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((n) => n.endsWith('.jsonl'))) {
      try {
        if (!statSync(join(d, f)).isFile()) continue;
        for (const line of readFileSync(join(d, f), 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          const rec = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
          if (rec.type === 'user' && rec.message?.role === 'user') {
            const c = rec.message.content;
            out.push(typeof c === 'string' ? c : JSON.stringify(c));
            break;
          }
        }
      } catch { /* torn */ }
    }
  }
  return out;
}

interface Row { name: string; mode: Mode; permission: string; appendInReply: boolean; personalInReply: boolean; appendInFirstMessage: boolean | null; hookCalls: number; subagentStarts: number; pass: boolean; usd: number; answer: string }
const rows: Row[] = [];
let stopped = '';
for (const c of cases) {
  const chk = guard.check();
  if (!chk.ok) { stopped = chk.reason ?? 'cap'; console.log(`STOP before ${c.name}: ${stopped}`); break; }
  const nonceA = `PX-${randomUUID().slice(0, 8)}`;
  const nonceP = `PB-${randomUUID().slice(0, 8)}`;
  const log = join(dir, `${c.name}.log.jsonl`);
  writeFileSync(log, '');
  const env = cleanEnv({
    PROBE_MODE: c.mode, PROBE_LOG: log,
    PROBE_RULE: `Project rule for this job: end your reply with the token ${nonceA} on its own line.`,
    PROBE_PERSONAL: `His preferences: begin every reply with the token ${nonceP} on its own line.`,
  });
  const sid = randomUUID();
  const prompt = 'Use the Agent tool exactly once, subagent_type general-purpose, with the prompt "What is 17 + 25? Answer in one line." Then reply with the sub-agent\'s reply copied verbatim and nothing else.';
  const r = await runClaude(evalClaudeArgs({ prompt, settings: settingsPath, maxUsd: maxRunUsd, tools: 'Agent,Read', allowed: ['Agent', 'Read'], permissionMode: c.permission, persist: true, sessionId: sid }), { cwd: proj, env, guard, run: c.name });
  const logLines = readFileSync(log, 'utf-8').split('\n').filter(Boolean);
  const first = subagentFirstUserMessages(r.sessionId || sid);
  const appendInFirstMessage = first.length ? first.some((m) => m.includes(nonceA)) : null;
  const appendInReply = r.result.includes(nonceA);
  const personalInReply = r.result.includes(nonceP);
  const subStarts = logLines.filter((l) => l.includes('SubagentStart')).length;
  const pass = c.mode === 'deny' ? !appendInReply && subStarts === 0
    : c.mode === 'off' ? personalInReply && !appendInReply
      : (appendInFirstMessage ?? appendInReply);
  rows.push({ name: c.name, mode: c.mode, permission: c.permission, appendInReply, personalInReply, appendInFirstMessage, hookCalls: logLines.length - subStarts, subagentStarts: subStarts, pass, usd: r.costUsd, answer: r.result });
  console.log(`${c.name}: ${pass ? 'PASS' : 'FAIL'} (append in first message ${appendInFirstMessage ?? 'no transcript'}, in reply ${appendInReply}, personal ${personalInReply}) $${r.costUsd.toFixed(2)}`);
}

const s = stamp();
const md = [
  '# Transport probe (criterion 11)',
  '',
  table(['case', 'permission', 'hook', 'append in sub-agent first message', 'append in reply', 'personal block in reply', 'pass', 'cost'],
    rows.map((r) => [r.name, r.permission, r.mode, r.appendInFirstMessage === null ? 'no transcript' : r.appendInFirstMessage ? 'yes' : 'no', r.appendInReply ? 'yes' : 'no', r.personalInReply ? 'yes' : 'no', r.pass ? 'PASS' : 'FAIL', `$${r.usd.toFixed(2)}`])),
  '',
  `Three shapes: ${rows.filter((r) => r.mode === 'append' && r.pass).length}/3.`,
  'Codex: not measurable in this probe (no Codex run); record it as such unless measured separately.',
  'App shape is approximated by permission mode; the app argv itself is not reproduced.',
  stopped ? `Stopped early: ${stopped}` : '',
].join('\n');
writePrivate(join(resultsDir(), `probe-${s}.json`), JSON.stringify({ at: new Date().toISOString(), rows, stopped: stopped || null, scratch: dir }, null, 2));
writePrivate(join(resultsDir(), `probe-${s}.md`), md + '\n');
console.log(`\n${md}`);
