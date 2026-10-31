#!/usr/bin/env node
/**
 * Claude hook output on a fixed fixture, for the golden test (tests/unit/hook-golden.test.ts).
 *
 *   node scripts/hook-golden.mjs <dist/index.js> <out-dir>
 *
 * Builds a scratch HOME and a synthetic vault (fictional project, fixed content), feeds each
 * Claude hook a fixed payload, and writes what it printed to <out-dir>/<hook>.txt, with the few
 * values that change per run (scratch paths, today's date, clock times) normalized. Track T must
 * leave this output byte-identical: the golden files are produced by the base CLI of the wave
 * (W3: the 0.36.6 merge, before any W3 change).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [cli, outDir] = process.argv.slice(2);
if (!cli || !outDir) { console.error('usage: node scripts/hook-golden.mjs <dist/index.js> <out-dir>'); process.exit(2); }

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hook-golden-')));
const HOME = join(root, 'home');
const PROJ = join(root, 'acme-shop');
const TAB = '2f6b1c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SESSION = '8a7b6c5d-4e3f-4210-9a8b-7c6d5e4f3a2b';
const ctx = join(PROJ, '_dream_context');
for (const d of [join(HOME, '.dreamcontext'), join(ctx, 'core'), join(ctx, 'state'), join(ctx, 'knowledge'), join(ctx, 'marketing')]) mkdirSync(d, { recursive: true });

writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: "acme-shop"\ntype: soul\nupdated: "2026-01-02"\n---\n\n## Project Identity\n\nA fictional storefront used as a hook fixture.\n');
writeFileSync(join(ctx, 'core', '1.user.md'), '---\nname: user\ntype: user\nupdated: "2026-01-02"\n---\n\nPrefers short answers.\n');
writeFileSync(join(ctx, 'core', '2.memory.md'), '---\nname: memory\ntype: memory\nupdated: "2026-01-02"\n---\n\n- Checkout uses a three-step flow.\n');
writeFileSync(join(ctx, 'knowledge', 'checkout.md'), '---\nname: Checkout flow\ndescription: How the checkout works\ntags: [checkout]\nupdated: "2026-01-02"\n---\n\nThe checkout has three steps: cart, address, payment.\n');
writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '1', contextHandoff: { enabled: true, nudgeAt: 3000, remindEvery: 2000 } }));
writeFileSync(join(ctx, 'marketing', '.env'), 'ACME_FAKE=not-a-secret\n');

// A Claude transcript whose last main-chain turn carries ~5k context tokens (over the 3k nudge).
const transcript = join(root, 'transcript.jsonl');
writeFileSync(transcript, [
  { type: 'user', message: { role: 'user', content: 'start' }, sessionId: SESSION },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 4000, cache_read_input_tokens: 1000, output_tokens: 50 } }, sessionId: SESSION },
].map((r) => JSON.stringify(r)).join('\n') + '\n');

const env = { ...process.env, HOME, DREAMCONTEXT_TAB_SESSION: TAB, DREAMCONTEXT_BRAIN_SYNC: '0', DREAMCONTEXT_RECALL_CLOUD: '0', CLAUDE_PROJECT_DIR: PROJ };
delete env.DREAMCONTEXT_CHAT_TAB;
delete env.CLAUDE_CODE_SESSION_ID;

// [output file, hook, payload]. Track T W3 added the `.env` deny and the Stop hook.
const runs = [
  ['session-start', 'session-start', { source: 'startup', session_id: SESSION, transcript_path: transcript }],
  ['user-prompt-submit', 'user-prompt-submit', { prompt: 'how does the checkout work', session_id: SESSION, transcript_path: transcript }],
  ['post-tool-use', 'post-tool-use', { tool_name: 'Edit', tool_input: { file_path: join(PROJ, 'src', 'cart.ts') }, session_id: SESSION, transcript_path: transcript }],
  ['pre-tool-use', 'pre-tool-use', { tool_name: 'Read', tool_input: { file_path: join(ctx, 'marketing', '.env') }, session_id: SESSION, transcript_path: transcript }],
  ['pre-tool-use-env-edit', 'pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: join(ctx, 'marketing', '.env') }, session_id: SESSION, transcript_path: transcript }],
  ['pre-compact', 'pre-compact', { trigger: 'auto', session_id: SESSION, transcript_path: transcript }],
  ['stop', 'stop', { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'ok', stop_hook_active: false }],
];

const normalize = (s) => s
  .split(root).join('<ROOT>')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ISO>')
  .replace(/\b20\d{2}-\d{2}-\d{2}\b/g, '<DATE>')
  .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<TIME>');

mkdirSync(outDir, { recursive: true });
for (const [file, hook, payload] of runs) {
  const r = spawnSync(process.execPath, [cli, 'hook', hook], { cwd: PROJ, env, input: JSON.stringify(payload), encoding: 'utf-8', timeout: 60_000 });
  writeFileSync(join(outDir, `${file}.txt`), normalize(`exit=${r.status}\n--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`));
}
rmSync(root, { recursive: true, force: true });
