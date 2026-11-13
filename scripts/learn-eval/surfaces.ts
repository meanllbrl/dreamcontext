/**
 * E1 surfaces (plan criteria 5, 16's model rows, 17's relay row). Model runs, at Close; about $20.
 *
 *   npx vite-node scripts/learn-eval/surfaces.ts -- [--only a,b] [--reps 3] [--dry-run] [--max-run-usd 1.5]
 *       [--cli dist/index.js] [--member scribe]
 *
 * Every case runs in its own scratch: a fake HOME, two initialised vaults, hooks pinned to a
 * `dreamcontext` shim (this checkout's build under the fake HOME). Claude keeps the real HOME for
 * its sign-in (a `claude` shim restores it); every dreamcontext call it makes lands in the fake one.
 * App surfaces are taught through the server's marked frame (`{type:'user', text, typed:true,
 * own}` on /api/agent/chat, contract D), never a headless prompt. Fresh obey runs on the durable
 * channel: a new `claude -p` session in the vault (its session start carries the stores).
 * Cases (k of reps each, bar 3/3):
 *   app-<plain|super|develop|plan>   right store, receipt line, status active, fresh obey
 *   member, terminal                 right store, status proposed; after `learn keep`, fresh obey
 *   control                          the probes with nothing taught (a generic answer must fail)
 *   subagent-project, subagent-me    a sub-agent obeys a project rule matched to its job, and a
 *                                    personal `always` rule its prompt does not mention
 *   cross-vault                      a `me` rule taught in vault A is obeyed in vault B
 *   contradiction                    a second saying replaces the first: new obeyed, old not, receipt
 *                                    names it ("eskisi saklandı")
 *   publish, unasked-push            D16d: `npm whoami` before a publish; fetch before an unasked push
 *   relay                            C10: the Super's brief to a child holds his sentence under "Owner:"
 * Codex: recorded "not measurable" (usage-capped); Antigravity likewise.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import WebSocket from 'ws';
import {
  REAL_HOME, REPO, SpendGuard, coverage, buildIdf, dc, dcEnv, denyRules, evalClaudeArgs, flagNum, flagStr, makeScratch, parseArgs, pinHooksToShim,
  resultsDir, runClaude, spendLedgerPath, stamp, table, whichClaude, writePrivate, type Scratch,
} from './lib.js';

const { flags } = parseArgs(process.argv.slice(2));
const reps = flagNum(flags, 'reps', 3);
const dryRun = flags['dry-run'] === true;
const maxRunUsd = flagNum(flags, 'max-run-usd', 1.5);
const cli = flagStr(flags, 'cli', join(REPO, 'dist', 'index.js'));
const memberSlug = flagStr(flags, 'member', 'scribe');
const only = typeof flags.only === 'string' ? new Set(flags.only.split(',')) : null;

// ─── The rules taught (synthetic, each probe scored mechanically) ───────────
interface Rule { key: string; scope: 'me' | 'project'; teach: string; marker: RegExp; probe: string; obeys: (answer: string, proj: string, before: Set<string>) => boolean }
const lastLine = (s: string): string => s.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
const newFiles = (dir: string, before: Set<string>): string[] => { try { return readdirSync(dir).filter((n) => !before.has(n)); } catch { return []; } };
const RULES: Rule[] = [
  { key: 'selam', scope: 'me', teach: 'bunu hatırla: bana yazdığın her mesajın son satırı tek başına "Selam" olsun.', marker: /Selam/, probe: 'docs klasöründe ne var, kısaca söyle.', obeys: (a) => /^Selam[.!]?$/.test(lastLine(a)) },
  { key: 'prefix', scope: 'project', teach: 'bunu hatırla: bu projede yeni açılan her dosyanın adı lumen- ile başlar.', marker: /lumen-/, probe: 'notes klasörüne bugünün kısa bir notunu içeren yeni bir dosya ekle.', obeys: (_a, proj, before) => { const f = newFiles(join(proj, 'notes'), before); return f.length > 0 && f.every((n) => n.startsWith('lumen-')); } },
  { key: 'words', scope: 'me', teach: 'bunu hatırla: raporlarında bana sayıları rakamla değil yazıyla yaz.', marker: /yazıyla|rakam/, probe: 'docs klasöründe kaç dosya var? Bana tek cümleyle rapor ver.', obeys: (a) => /\b(üç|three)\b/i.test(a) && !/\b3\b/.test(a) },
];
const RULE_BY = new Map(RULES.map((r) => [r.key, r]));

// ─── Plan ───────────────────────────────────────────────────────────────────
type CaseName = 'app-plain' | 'app-super' | 'app-develop' | 'app-plan' | 'member' | 'terminal' | 'control' | 'subagent-project' | 'subagent-me' | 'cross-vault' | 'contradiction' | 'publish' | 'unasked-push' | 'relay';
const CASES: Array<{ name: CaseName; runs: number }> = [
  ...(['app-plain', 'app-super', 'app-develop', 'app-plan'] as const).map((name) => ({ name, runs: RULES.length * 2 })),
  { name: 'member', runs: RULES.length * 2 },
  { name: 'terminal', runs: RULES.length * 2 },
  { name: 'control', runs: RULES.length },
  { name: 'subagent-project', runs: reps },
  { name: 'subagent-me', runs: reps },
  { name: 'cross-vault', runs: reps * 2 },
  { name: 'contradiction', runs: reps * 3 },
  { name: 'publish', runs: reps },
  { name: 'unasked-push', runs: reps },
  { name: 'relay', runs: reps },
];
const planned = CASES.filter((c) => !only || only.has(c.name));
const totalRuns = planned.reduce((n, c) => n + c.runs, 0);
const guard = new SpendGuard({ plan: { script: 'surfaces', runs: totalRuns, perRunEstimateUsd: 0.3, perRunMaxUsd: maxRunUsd }, ledgerPath: spendLedgerPath(REAL_HOME) });
guard.announce();
console.log(table(['case', 'model runs'], planned.map((c) => [c.name, c.runs])));
if (dryRun) { console.log('Dry run: nothing spent, nothing started.'); process.exit(0); }

// ─── Scratch per case ───────────────────────────────────────────────────────
const realClaude = whichClaude();
function caseScratch(name: string): Scratch {
  const s = makeScratch(mkdtempSync(join(tmpdir(), `learn-e1-${name}-`)), ['D', 'T'], cli);
  writeFileSync(join(s.bin, 'claude'), `#!/bin/sh\nHOME=${JSON.stringify(REAL_HOME)} exec ${JSON.stringify(realClaude)} "$@"\n`);
  chmodSync(join(s.bin, 'claude'), 0o755);
  for (const v of Object.values(s.vaults)) {
    if (!v) continue;
    pinHooksToShim(s, v);
    mkdirSync(join(v, 'docs'), { recursive: true });
    mkdirSync(join(v, 'notes'), { recursive: true });
    for (const f of ['intro', 'setup', 'faq']) writeFileSync(join(v, 'docs', `${f}.md`), `# ${f}\n\nLumen Ledger ${f}.\n`);
    spawnSync('git', ['add', '-A'], { cwd: v, env: dcEnv(s) });
    spawnSync('git', ['commit', '-qm', 'scratch'], { cwd: v, env: dcEnv(s) });
  }
  return s;
}
const settingsFor = (s: Scratch): string => {
  const p = join(s.dir, 'eval-settings.json');
  if (!existsSync(p)) writeFileSync(p, JSON.stringify({ permissions: { deny: denyRules(REAL_HOME) } }, null, 2));
  return p;
};
const claudeEnv = (s: Scratch): Record<string, string> => dcEnv(s, { HOME: REAL_HOME });

/** A fresh terminal session in a vault (session start + its own prompt hook). */
async function terminal(s: Scratch, vault: string, prompt: string, run: string): Promise<{ result: string; ok: boolean }> {
  const r = await runClaude(evalClaudeArgs({ prompt, settings: settingsFor(s), maxUsd: maxRunUsd, permissionMode: 'acceptEdits', allowed: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Agent', 'Bash(dreamcontext *)', 'Bash(git *)', 'Bash(npm *)', 'Bash(ls *)'], skills: true }), { cwd: vault, env: claudeEnv(s), guard, run });
  return { result: r.result, ok: r.ok };
}

// ─── The server and its marked frame ────────────────────────────────────────
function freePort(): Promise<number> {
  return new Promise((res, rej) => { const srv = createServer(); srv.on('error', rej); srv.listen(0, '127.0.0.1', () => { const a = srv.address(); const port = typeof a === 'object' && a ? a.port : 0; srv.close(() => res(port)); }); });
}
interface Server { port: number; proc: ChildProcess; vault: string }
async function startServer(s: Scratch, vault: string): Promise<Server> {
  const port = await freePort();
  const log = join(s.dir, 'server.log');
  const proc = spawn(process.execPath, [cli, 'dashboard', '--no-open', '-p', String(port)], { cwd: vault, env: dcEnv(s, { DREAMCONTEXT_DESKTOP: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', (d: Buffer) => appendFileSync(log, d));
  proc.stderr?.on('data', (d: Buffer) => appendFileSync(log, d));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status < 500) return { port, proc, vault }; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  proc.kill('SIGTERM');
  throw new Error(`server did not start (log ${log})`);
}

/** One owner turn through the app chat, typed by him (contract D's mark). Spend-guarded. */
async function appTurn(srv: Server, mode: string, text: string, run: string, extra: Record<string, string> = {}): Promise<{ result: string; ok: boolean; error?: string }> {
  const chk = guard.check();
  if (!chk.ok) throw new Error(`spend guard: ${chk.reason}`);
  const q = new URLSearchParams({ vault: basename(srv.vault), mode, model: 'opus', sessionId: randomUUID(), ...extra });
  const origin = `http://127.0.0.1:${srv.port}`;
  return await new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/agent/chat?${q}`, { headers: { Origin: origin } });
    let text_ = ''; let cost = 0; let sent = false; let settled = false;
    const finish = (ok: boolean, error?: string): void => {
      if (settled) return; settled = true;
      guard.record(cost, run);
      try { ws.close(); } catch { /* closed */ }
      res({ result: text_, ok, error });
    };
    const send = (): void => { if (sent) return; sent = true; ws.send(JSON.stringify({ type: 'user', text, typed: true, own: text })); };
    const timer = setTimeout(() => finish(false, 'timeout'), 10 * 60_000);
    ws.on('open', () => setTimeout(send, 1500));
    ws.on('message', (raw: WebSocket.RawData) => {
      const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      for (const line of data.toString('utf-8').split('\n')) {
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const inner = (ev.event ?? ev.data ?? ev) as Record<string, unknown>;
        if (inner.type === 'assistant') {
          const content = (inner.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? [];
          for (const b of content) if (b.type === 'text' && b.text) text_ += `${b.text}\n`;
        }
        if (inner.type === 'result') {
          cost = Number(inner.total_cost_usd ?? 0) || 0;
          if (typeof inner.result === 'string' && inner.result) text_ = inner.result;
          clearTimeout(timer);
          finish(inner.is_error !== true);
        }
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); finish(false, String(e)); });
    ws.on('close', () => { clearTimeout(timer); finish(false, 'socket closed before a result'); });
  });
}

// ─── Store reads ────────────────────────────────────────────────────────────
type Rec = { id: string; [k: string]: unknown };
function storeRecords(file: string): Rec[] {
  if (!existsSync(file)) return [];
  try {
    // rules-store.ts RulesStoreFile: {version, rules: RuleRecord[]}.
    const v = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    const arr = Array.isArray(v) ? v : Array.isArray((v as { rules?: unknown }).rules) ? (v as { rules: unknown[] }).rules : [];
    return (arr as Rec[]).filter((x) => x && typeof x === 'object' && typeof x.id === 'string');
  } catch { return []; }
}
const meStore = (s: Scratch): string => join(s.home, '.dreamcontext', 'me', 'rules.json');
const projStore = (v: string): string => join(v, '_dream_context', 'core', 'RULES.json');
function findRule(s: Scratch, vault: string, rule: Rule): { where: 'me' | 'project' | 'both' | 'none'; id: string } {
  const inMe = storeRecords(meStore(s)).filter((r) => rule.marker.test(JSON.stringify(r)));
  const inProj = storeRecords(projStore(vault)).filter((r) => rule.marker.test(JSON.stringify(r)));
  const where = inMe.length && inProj.length ? 'both' : inMe.length ? 'me' : inProj.length ? 'project' : 'none';
  return { where, id: (rule.scope === 'me' ? inMe : inProj)[0]?.id ?? inMe[0]?.id ?? inProj[0]?.id ?? '' };
}
function ruleStatus(s: Scratch, vault: string, id: string): string {
  if (!id) return '';
  const r = dc(s, vault, ['learn', 'show', id, '--json']);
  try { const j = JSON.parse(r.stdout) as Record<string, unknown>; return String((j.record as Record<string, unknown> | undefined)?.status ?? j.status ?? ''); } catch { /* text */ }
  return /\b(active|proposed|superseded|undone|invalid)\b/.exec(r.stdout)?.[1] ?? '';
}
const receiptIn = (a: string, kind: 'active' | 'proposed'): boolean => (kind === 'active' ? /Kaydedildi:|"type"\s*:\s*"learned"/.test(a) : /Önerildi:|"type"\s*:\s*"learned"/.test(a));

// ─── Cases ──────────────────────────────────────────────────────────────────
interface Score { case: string; measure: string; k: number; n: number; note?: string }
const scores: Score[] = [];
const add = (c: string, measure: string, ok: boolean, note?: string): void => {
  const s = scores.find((x) => x.case === c && x.measure === measure);
  if (s) { s.n++; if (ok) s.k++; if (note) s.note = note; } else scores.push({ case: c, measure, k: ok ? 1 : 0, n: 1, note });
};
const notMeasurable: Array<{ case: string; why: string }> = [];
const servers: Server[] = [];
let stopped = '';

async function teachAndObey(name: CaseName, teachVia: (s: Scratch, rule: Rule) => Promise<{ result: string; ok: boolean; error?: string }>, expect: 'active' | 'proposed'): Promise<void> {
  for (const rule of RULES) {
    const s = caseScratch(`${name}-${rule.key}`);
    const v = s.vaults.D!;
    const t = await teachVia(s, rule);
    // A teach that never reached a result (setup, socket, timeout) is named, not scored as a miss.
    if (t.error) { notMeasurable.push({ case: `${name}/${rule.key}`, why: t.error }); continue; }
    const f = findRule(s, v, rule);
    add(name, 'right store', f.where === rule.scope);
    add(name, 'receipt line', receiptIn(t.result, expect));
    const st = ruleStatus(s, v, f.id);
    add(name, `status ${expect}`, st === expect, st || 'no record');
    if (expect === 'proposed' && f.id) dc(s, v, ['learn', 'keep', f.id]);
    const before = new Set(readdirSync(join(v, 'notes')));
    const o = await terminal(s, v, rule.probe, `${name}/${rule.key}/obey`);
    add(name, expect === 'proposed' ? 'fresh obey after keep' : 'fresh obey', rule.obeys(o.result, v, before));
  }
}

async function withServer<T>(s: Scratch, fn: (srv: Server) => Promise<T>): Promise<T> {
  const srv = await startServer(s, s.vaults.D!);
  servers.push(srv);
  try { return await fn(srv); } finally { srv.proc.kill('SIGTERM'); }
}

const appMode: Record<string, string> = { 'app-plain': 'basic', 'app-super': 'super', 'app-develop': 'develop', 'app-plan': 'plan' };
async function runCase(name: CaseName): Promise<void> {
  if (name in appMode) {
    await teachAndObey(name, (s, rule) => withServer(s, (srv) => appTurn(srv, appMode[name]!, rule.teach, `${name}/${rule.key}/teach`)), 'active');
    return;
  }
  if (name === 'member') {
    await teachAndObey(name, async (s, rule) => {
      const made = dc(s, s.vaults.D!, ['agents', 'new', memberSlug, '--yes']);
      if (made.code !== 0) return { result: '', ok: false, error: `member setup failed: ${(made.stderr || made.stdout).split('\n')[0]}` };
      return withServer(s, (srv) => appTurn(srv, 'basic', rule.teach, `${name}/${rule.key}/teach`, { chatAgent: memberSlug }));
    }, 'proposed');
    return;
  }
  if (name === 'terminal') {
    await teachAndObey(name, (s, rule) => terminal(s, s.vaults.D!, rule.teach, `${name}/${rule.key}/teach`), 'proposed');
    return;
  }
  if (name === 'control') {
    for (const rule of RULES) {
      const s = caseScratch(`control-${rule.key}`);
      const v = s.vaults.D!;
      const before = new Set(readdirSync(join(v, 'notes')));
      const o = await terminal(s, v, rule.probe, `control/${rule.key}`);
      add(name, 'untaught probe obeys anyway (should be low)', rule.obeys(o.result, v, before));
    }
    return;
  }
  if (name === 'subagent-project' || name === 'subagent-me') {
    for (let i = 0; i < reps; i++) {
      const s = caseScratch(`${name}-${i}`);
      const v = s.vaults.D!;
      const isMe = name === 'subagent-me';
      const text = isMe ? 'Her oluşturduğun dosyanın ilk satırı tam olarak "Hazırlayan: Ada" olsun.' : 'Bu projede yeni açılan her not dosyasının adı lumen- ile başlar.';
      const seed = dc(s, v, ['learn', text, '--scope', isMe ? 'me' : 'project', '--quote', text, '--headline', isMe ? 'Dosyalar Hazırlayan: Ada ile başlar' : 'Yeni not dosyaları lumen- ile başlar', '--new', ...(isMe ? ['--at', 'always'] : [])]);
      const id = /LEARNED (\S+)/.exec(seed.stdout)?.[1] ?? '';
      if (id) dc(s, v, ['learn', 'keep', id]);
      else notMeasurable.push({ case: name, why: `seed failed: ${(seed.stderr || seed.stdout).split('\n')[0]}` });
      const before = new Set(readdirSync(join(v, 'notes')));
      await terminal(s, v, 'Agent aracıyla bir alt ajana şu işi ver: notes klasörüne bugünkü toplantı için kısa bir not dosyası oluştursun. Dosyayı kendin oluşturma, sadece alt ajana yaptır.', `${name}/${i}`);
      const files = newFiles(join(v, 'notes'), before);
      const ok = isMe
        ? files.length > 0 && files.every((f) => readFileSync(join(v, 'notes', f), 'utf-8').split('\n')[0]?.trim() === 'Hazırlayan: Ada')
        : files.length > 0 && files.every((f) => f.startsWith('lumen-'));
      add(name, isMe ? 'sub-agent obeys a personal always rule its prompt does not mention' : 'sub-agent obeys a project rule matched to its job', ok, `${files.length} file(s)`);
    }
    return;
  }
  if (name === 'cross-vault') {
    const rule = RULE_BY.get('words')!;
    for (let i = 0; i < reps; i++) {
      const s = caseScratch(`cross-${i}`);
      await withServer(s, (srv) => appTurn(srv, 'basic', rule.teach, `cross/${i}/teach`));
      const o = await terminal(s, s.vaults.T!, rule.probe, `cross/${i}/obey-in-B`);
      add(name, 'me rule taught in A obeyed in B', rule.obeys(o.result, s.vaults.T!, new Set()));
    }
    return;
  }
  if (name === 'contradiction') {
    const first = RULE_BY.get('words')!;
    for (let i = 0; i < reps; i++) {
      const s = caseScratch(`contra-${i}`);
      const v = s.vaults.D!;
      const second = await withServer(s, async (srv) => {
        await appTurn(srv, 'basic', first.teach, `contra/${i}/teach-1`);
        return appTurn(srv, 'basic', 'bunu hatırla: artık raporlarda sayıları yazıyla değil rakamla yaz.', `contra/${i}/teach-2`);
      });
      add(name, 'receipt names the old rule', /eskisi saklandı/.test(second.result) || /"type"\s*:\s*"learned"/.test(second.result));
      const o = await terminal(s, v, first.probe, `contra/${i}/obey`);
      add(name, 'new rule obeyed, old one not', /\b3\b/.test(o.result) && !/\b(üç|three)\b/i.test(o.result));
    }
    return;
  }
  if (name === 'publish' || name === 'unasked-push') {
    for (let i = 0; i < reps; i++) {
      const s = caseScratch(`${name}-${i}`);
      const v = s.vaults.D!;
      const log = join(s.dir, 'calls.log');
      writeFileSync(log, '');
      const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).stdout.trim() || '/usr/bin/git';
      writeFileSync(join(s.bin, 'npm'), `#!/bin/sh\necho "npm $*" >> ${JSON.stringify(log)}\ncase "$1" in whoami) echo lumen-bot;; publish) echo "npm error 402 publish refused in the eval" >&2; exit 1;; *) exit 0;; esac\n`);
      writeFileSync(join(s.bin, 'git'), `#!/bin/sh\necho "git $*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
      chmodSync(join(s.bin, 'npm'), 0o755);
      chmodSync(join(s.bin, 'git'), 0o755);
      let prompt: string;
      if (name === 'publish') {
        mkdirSync(join(v, 'pkg'), { recursive: true });
        writeFileSync(join(v, 'pkg', 'package.json'), JSON.stringify({ name: 'lumen-ledger-eval', version: '0.0.1' }, null, 2));
        const text = 'Bir paketi yayınlamayı önermeden ya da yayınlamadan önce npm whoami çalıştır.';
        const seed = dc(s, v, ['learn', text, '--scope', 'me', '--quote', text, '--headline', 'Yayından önce npm whoami', '--new', '--at', 'act']);
        const id = /LEARNED (\S+)/.exec(seed.stdout)?.[1]; if (id) dc(s, v, ['learn', 'keep', id]);
        prompt = 'pkg klasöründeki paketi npm\'e yayınla.';
      } else {
        const bare = join(s.dir, 'origin.git');
        spawnSync(realGit, ['init', '-q', '--bare', bare]);
        spawnSync(realGit, ['remote', 'add', 'origin', bare], { cwd: v });
        spawnSync(realGit, ['push', '-q', 'origin', 'HEAD:main'], { cwd: v, env: dcEnv(s) });
        appendFileSync(join(v, 'CLAUDE.md'), '\n\nIn this project finished work is committed and pushed to origin by the agent that did it.\n');
        const text = 'git push yapmadan önce her zaman git fetch çalıştır.';
        const seed = dc(s, v, ['learn', text, '--scope', 'project', '--quote', text, '--headline', 'Push öncesi git fetch', '--new', '--at', 'act']);
        const id = /LEARNED (\S+)/.exec(seed.stdout)?.[1]; if (id) dc(s, v, ['learn', 'keep', id]);
        prompt = 'notes klasörüne bugünkü işler için kısa bir not ekle ve işi bitir.';
      }
      await terminal(s, v, prompt, `${name}/${i}`);
      const calls = readFileSync(log, 'utf-8').split('\n').filter(Boolean);
      if (name === 'publish') {
        const w = calls.findIndex((c) => c.startsWith('npm whoami'));
        const p = calls.findIndex((c) => c.startsWith('npm publish'));
        add(name, 'npm whoami before the publish', w >= 0 && (p < 0 || w < p), calls.join(' | ').slice(0, 200));
      } else {
        const f = calls.findIndex((c) => /^git (.* )?fetch/.test(c));
        const p = calls.findIndex((c) => /^git (.* )?push/.test(c));
        add(name, 'fetch before the unasked push, and pushed', p >= 0 && f >= 0 && f < p, calls.filter((c) => /fetch|push/.test(c)).join(' | ').slice(0, 200));
      }
    }
    return;
  }
  if (name === 'relay') {
    const decision = 'bu modülü birebir taşı, port bekleme, eski davranış aynen kalsın';
    for (let i = 0; i < reps; i++) {
      const s = caseScratch(`relay-${i}`);
      const v = s.vaults.D!;
      const t0 = Date.now();
      await withServer(s, (srv) => appTurn(srv, 'super', `Kararım şu: ${decision}. Bu işi bir alt oturuma ver, kendin yapma.`, `relay/${i}`));
      const { idf } = buildIdf([decision]);
      const briefs: string[] = [];
      const walk = (d: string, depth: number): void => {
        if (depth > 6) return;
        let names: string[] = []; try { names = readdirSync(d); } catch { return; }
        for (const n of names) {
          if (n === 'node_modules' || n === '.git') continue;
          const p = join(d, n);
          let st; try { st = statSync(p); } catch { continue; }
          if (st.isDirectory()) walk(p, depth + 1);
          else if (st.mtimeMs >= t0 && st.size < 512_000) { try { const txt = readFileSync(p, 'utf-8'); if (/Owner:/.test(txt)) briefs.push(txt); } catch { /* binary */ } }
        }
      };
      walk(v, 0);
      const ok = briefs.some((b) => b.split('\n').some((l, j, all) => /Owner:/.test(l) && coverage(`${l} ${all[j + 1] ?? ''}`, decision, idf).mass >= 0.8));
      add(name, 'brief holds his sentence under "Owner:"', ok, `${briefs.length} brief(s) with an Owner line`);
    }
  }
}

// Pollution check: the real personal store and ledger must not change.
const watch = [join(REAL_HOME, '.dreamcontext', 'me'), join(REAL_HOME, '.dreamcontext', 'owner-words')];
const mt = (): string => watch.map((d) => { try { return readdirSync(d).map((n) => `${n}:${statSync(join(d, n)).mtimeMs}`).join(','); } catch { return '-'; } }).join('|');
const before = mt();
for (const c of planned) {
  if (stopped) break;
  try { await runCase(c.name); } catch (e) {
    const msg = (e as Error).message;
    if (/spend guard/.test(msg)) { stopped = msg; console.log(`STOP at ${c.name}: ${msg}`); break; }
    notMeasurable.push({ case: c.name, why: msg });
  }
  console.log(`${c.name}: done`);
}
for (const s of servers) { try { s.proc.kill('SIGTERM'); } catch { /* gone */ } }
const polluted = mt() !== before;

const s = stamp();
const md = [
  '# E1 surfaces',
  '',
  table(['case', 'measure', 'k/n', 'note'], scores.map((x) => [x.case, x.measure, `${x.k}/${x.n}`, x.note ?? ''])),
  '',
  notMeasurable.length ? `Not measurable:\n${notMeasurable.map((x) => `- ${x.case}: ${x.why}`).join('\n')}` : 'Every planned case ran.',
  'Codex and Antigravity: not measurable in this run (Codex usage-capped until 11-24, Antigravity ACP server not installed).',
  `Real ~/.dreamcontext/me and owner-words changed during the run: ${polluted ? 'YES (investigate)' : 'no'}.`,
  stopped ? `Stopped early: ${stopped}` : '',
].join('\n');
writePrivate(join(resultsDir(REAL_HOME), `e1-${s}.json`), JSON.stringify({ at: new Date().toISOString(), reps, scores, notMeasurable, polluted, stopped: stopped || null }, null, 2));
writePrivate(join(resultsDir(REAL_HOME), `e1-${s}.md`), md + '\n');
console.log(`\n${md}`);
