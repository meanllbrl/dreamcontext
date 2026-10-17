#!/usr/bin/env node
'use strict';
/**
 * dreamcontext Read-hook guard (PostToolUse, matcher Read).
 *
 * Every Read in a Claude Code session runs this, so it must cost nothing on the
 * common path: no dependencies, no npx. It parses the hook payload and exits 0
 * at once unless the file read is a task card (`…/_dream_context/state/<slug>.md`,
 * not a journal). Only then does it hand the payload to the CLI
 * (`dreamcontext hook read-task`), which adds the parent task's card when the
 * card read is a sub-task. Any failure exits 0: a guard never breaks a Read.
 *
 * Source: hooks/read-task-guard.cjs in the dreamcontext package; installed to
 * <project>/.claude/hooks/ by `dreamcontext install-skill` / `update`.
 */
const { spawnSync } = require('node:child_process');

function isTaskCard(p) {
  if (typeof p !== 'string' || !p) return false;
  const n = p.replace(/\\/g, '/');
  const at = n.lastIndexOf('/_dream_context/state/');
  if (at === -1 && !n.startsWith('_dream_context/state/')) return false;
  const rest = at === -1 ? n.slice('_dream_context/state/'.length) : n.slice(at + '/_dream_context/state/'.length);
  return /^[^/]+\.md$/.test(rest);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; if (input.length > 1_000_000) process.exit(0); });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(input); } catch { process.exit(0); }
  const file = payload && payload.tool_input && payload.tool_input.file_path;
  if (!isTaskCard(file)) process.exit(0);
  const args = ['hook', 'read-task'];
  const opts = { input, stdio: ['pipe', 'inherit', 'ignore'], timeout: 8000 };
  let r = spawnSync('dreamcontext', args, opts);
  if (r.error && r.error.code === 'ENOENT') r = spawnSync('npx', ['dreamcontext', ...args], opts);
  process.exit(0);
});
