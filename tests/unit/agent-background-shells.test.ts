/**
 * Unit tests for the Chat view's background-shell surface (task
 * `chat-view-shows-background-shells-read-live-output-and-stop-them`).
 *
 * Three layers, all pinned against the empirically-captured CLI 2.1.220 protocol (see that
 * task's Technical Details for the raw frames):
 *   • `sanitizeBackgroundTaskId` / `backgroundOutputPath` — the server-DERIVED output path,
 *     including the two details a reasonable guess gets wrong (hardcoded `/tmp/claude-<uid>`
 *     base, not `$TMPDIR`; realpath'd cwd slug).
 *   • `handleAgentBackgroundOutput` — the zero-model-token reader: desktop gate, id gates,
 *     tail cap, and the deliberate "no output yet is 200, not 404" choice.
 *   • `toChatEvent` on `system:background_tasks_changed` + `runStatusFrom` — the roster push
 *     and the killed/stopped status mapping whose absence made a stopped run show "running".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleAgentBackgroundOutput, sanitizeBackgroundTaskId, backgroundOutputPath,
} from '../../src/server/routes/agent-chat.js';
import { toChatEvent } from '../../dashboard/src/lib/chatProtocol.js';
import { runStatusFrom, isBackgroundShell, subAgentToolUseIds, summarizeBackgroundShells } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';
import type { SubAgentRun } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

function makeRes() {
  let statusCode = 0;
  const headers: Record<string, string | number> = {};
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (c: Buffer) => { chunks.push(Buffer.from(c)); });
  const res = Object.assign(sink, {
    setHeader(name: string, value: string) { headers[name] = value; },
    writeHead(code: number, hdrs?: Record<string, string | number>) {
      statusCode = code;
      Object.assign(headers, hdrs ?? {});
      return res;
    },
  }) as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    header: (n: string) => headers[n],
    body: () => {
      const buf = chunks.length ? Buffer.concat(chunks) : undefined;
      if (buf === undefined) return undefined;
      try { return JSON.parse(buf.toString('utf-8')); } catch { return buf.toString('utf-8'); }
    },
  };
}

const makeReq = (url: string): IncomingMessage => ({ url, headers: {} } as unknown as IncomingMessage);

const UUID = '98094b59-33dc-4ff6-b646-a0910161eeb5';
const TASK = 'b4inao45h';

let projectRoot: string;
let contextRoot: string;
let taskDir: string;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectRoot = join(realpathSync(tmpdir()), `dc-bgshell-${stamp}`);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  // Mirror the CLI's own layout so the handler's derived path resolves for real.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  taskDir = join('/tmp', `claude-${uid}`, realpathSync(projectRoot).replace(/\//g, '-'), UUID, 'tasks');
  mkdirSync(taskDir, { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
});

afterEach(() => {
  delete process.env.DREAMCONTEXT_DESKTOP;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(taskDir, { recursive: true, force: true });
});

// ─── Task-id gate ────────────────────────────────────────────────────────────────────

describe('sanitizeBackgroundTaskId', () => {
  it('accepts the CLI\'s own short alphanumeric ids', () => {
    expect(sanitizeBackgroundTaskId('b4inao45h')).toBe('b4inao45h');
    expect(sanitizeBackgroundTaskId('bhcmyy2nd')).toBe('bhcmyy2nd');
  });

  it('rejects anything that could reshape a path', () => {
    // No dot, slash or dash in the charset — so traversal, absolute paths and nested
    // segments are structurally unrepresentable rather than merely filtered.
    for (const bad of ['..', '../../etc/passwd', 'a/b', 'a.b', 'a-b', '/abs', '', 'x'.repeat(33)]) {
      expect(sanitizeBackgroundTaskId(bad)).toBe('');
    }
  });

  it('rejects non-strings', () => {
    for (const bad of [null, undefined, 42, {}, ['b4inao45h']]) {
      expect(sanitizeBackgroundTaskId(bad)).toBe('');
    }
  });
});

// ─── Path derivation ─────────────────────────────────────────────────────────────────

describe('backgroundOutputPath', () => {
  it('derives /tmp/claude-<uid>/<cwd-slug>/<uuid>/tasks/<id>.output', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const p = backgroundOutputPath(projectRoot, UUID, TASK);
    expect(p).toBe(join('/tmp', `claude-${uid}`, projectRoot.replace(/\//g, '-'), UUID, 'tasks', `${TASK}.output`));
  });

  it('does NOT honour $TMPDIR — the base is a hardcoded /tmp/claude-<uid>', () => {
    // Empirically verified against CLI 2.1.220: with TMPDIR pointed elsewhere, other temp
    // files honoured it but the task output still landed under /tmp/claude-<uid>. A path
    // derived from os.tmpdir() would silently miss every output file on a machine with a
    // custom TMPDIR (which macOS has by default).
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = '/tmp/dc-some-other-tmp';
    try {
      expect(backgroundOutputPath(projectRoot, UUID, TASK)).toContain('/tmp/claude-');
      expect(backgroundOutputPath(projectRoot, UUID, TASK)).not.toContain('dc-some-other-tmp');
    } finally {
      if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    }
  });

  it('slugs the REALPATH of cwd, not the path as given', () => {
    // On macOS /tmp is a symlink to /private/tmp, and the CLI slugs the resolved path — so a
    // caller passing the symlinked form must still land on the real directory.
    const real = realpathSync(projectRoot);
    expect(backgroundOutputPath(projectRoot, UUID, TASK)).toContain(real.replace(/\//g, '-'));
  });

  it('returns null for a rejected task id or a non-uuid conversation id', () => {
    expect(backgroundOutputPath(projectRoot, UUID, '../escape')).toBeNull();
    expect(backgroundOutputPath(projectRoot, 'not-a-uuid', TASK)).toBeNull();
  });
});

// ─── The reader route ────────────────────────────────────────────────────────────────

describe('handleAgentBackgroundOutput', () => {
  it('403s when not in the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status } = makeRes();
    await handleAgentBackgroundOutput(makeReq(`/api/agent/bg-output?claudeId=${UUID}&taskId=${TASK}`), res, {}, contextRoot);
    expect(status()).toBe(403);
  });

  it('sets nosniff on every response', async () => {
    const { res, header } = makeRes();
    await handleAgentBackgroundOutput(makeReq(`/api/agent/bg-output?claudeId=${UUID}&taskId=${TASK}`), res, {}, contextRoot);
    expect(header('X-Content-Type-Options')).toBe('nosniff');
  });

  it('400s on a missing or malformed taskId', async () => {
    for (const q of [`claudeId=${UUID}`, `claudeId=${UUID}&taskId=../x`]) {
      const { res, status, body } = makeRes();
      await handleAgentBackgroundOutput(makeReq(`/api/agent/bg-output?${q}`), res, {}, contextRoot);
      expect(status()).toBe(400);
      expect(body().error).toBe('invalid_task_id');
    }
  });

  it('400s on a missing or malformed claudeId', async () => {
    const { res, status, body } = makeRes();
    await handleAgentBackgroundOutput(makeReq(`/api/agent/bg-output?taskId=${TASK}&claudeId=nope`), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_claude_id');
  });

  it('reads the live output file', async () => {
    writeFileSync(join(taskDir, `${TASK}.output`), 'tick 1\ntick 2\ntick 3\n', 'utf-8');
    const { res, status, body } = makeRes();
    await handleAgentBackgroundOutput(makeReq(`/api/agent/bg-output?claudeId=${UUID}&taskId=${TASK}`), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toMatchObject({ taskId: TASK, content: 'tick 1\ntick 2\ntick 3\n', exists: true, truncated: false });
  });

  it('answers 200 with exists:false — not 404 — when nothing has been written yet', async () => {
    // A shell that has produced no output is a normal state the tray shows as "no output
    // yet". A 404 would render as an error for something that is working fine.
    const { res, status, body } = makeRes();
    await handleAgentBackgroundOutput(makeReq(`/api/agent/bg-output?claudeId=${UUID}&taskId=${TASK}`), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toMatchObject({ content: '', exists: false });
  });

  it('tails a large output and flags it truncated', async () => {
    const big = `HEAD-MARKER\n${'y'.repeat(400 * 1024)}\nTAIL-MARKER\n`;
    writeFileSync(join(taskDir, `${TASK}.output`), big, 'utf-8');
    const { res, status, body } = makeRes();
    await handleAgentBackgroundOutput(makeReq(`/api/agent/bg-output?claudeId=${UUID}&taskId=${TASK}`), res, {}, contextRoot);
    expect(status()).toBe(200);
    const out = body();
    expect(out.truncated).toBe(true);
    expect(out.content).toContain('TAIL-MARKER');
    expect(out.content).not.toContain('HEAD-MARKER');
    expect(out.size).toBe(Buffer.byteLength(big));
    expect(out.content.length).toBeLessThanOrEqual(256 * 1024);
  });

  it('400s when no vault could be resolved', async () => {
    const { res, status, body } = makeRes();
    await handleAgentBackgroundOutput(makeReq(`/api/agent/bg-output?claudeId=${UUID}&taskId=${TASK}`), res, {}, null);
    expect(status()).toBe(400);
    expect(body().error).toBe('no_vault');
  });
});

// ─── Roster frame parsing ────────────────────────────────────────────────────────────

describe('toChatEvent — system:background_tasks_changed', () => {
  it('parses the roster exactly as CLI 2.1.220 emits it', () => {
    const ev = toChatEvent({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'b4inao45h', task_type: 'local_bash', description: 'Run tick loop in background' }],
      uuid: 'deb09325-f23a-4593-a9fa-591f7e3a4927',
      session_id: UUID,
    });
    expect(ev).toEqual({
      kind: 'background-tasks',
      tasks: [{ taskId: 'b4inao45h', taskType: 'local_bash', description: 'Run tick loop in background' }],
    });
  });

  it('treats an EMPTY roster as a real value, not noise', () => {
    // `tasks: []` is how "the last background shell just ended" is reported — degrading it to
    // `ignored` would strand the tray's rows as permanently running.
    expect(toChatEvent({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }))
      .toEqual({ kind: 'background-tasks', tasks: [] });
  });

  it('drops an entry with no task_id but keeps the rest of the roster', () => {
    const ev = toChatEvent({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_type: 'local_bash' }, { task_id: 'bok', task_type: 'local_bash' }],
    });
    expect(ev).toEqual({ kind: 'background-tasks', tasks: [{ taskId: 'bok', taskType: 'local_bash', description: undefined }] });
  });

  it('tolerates a missing/garbage tasks field', () => {
    for (const tasks of [undefined, null, 'nope', 42]) {
      expect(toChatEvent({ type: 'system', subtype: 'background_tasks_changed', tasks }))
        .toEqual({ kind: 'background-tasks', tasks: [] });
    }
  });
});

// ─── Status mapping (the killed-shows-as-running bug) ────────────────────────────────

describe('runStatusFrom', () => {
  it('maps killed and stopped to the stopped terminal state', () => {
    // `stop_task` produces task_updated{status:'killed'} then
    // task_notification{status:'stopped'} — both verified on 2.1.220. Before `stopped`
    // existed, both fell through and a killed run displayed as "running" forever.
    expect(runStatusFrom('killed', 'running')).toBe('stopped');
    expect(runStatusFrom('stopped', 'running')).toBe('stopped');
  });

  it('maps completed and the error words', () => {
    expect(runStatusFrom('completed', 'running')).toBe('completed');
    expect(runStatusFrom('error', 'running')).toBe('error');
    expect(runStatusFrom('failed', 'running')).toBe('error');
  });

  it('HOLDS the current status for an unrecognized or absent word', () => {
    expect(runStatusFrom('some_future_word', 'running')).toBe('running');
    expect(runStatusFrom(undefined, 'running')).toBe('running');
    expect(runStatusFrom(undefined, 'completed')).toBe('completed');
  });

  it('never resurrects a finished run', () => {
    expect(runStatusFrom('some_future_word', 'stopped')).toBe('stopped');
  });
});

// ─── Shell/agent partition ───────────────────────────────────────────────────────────

const run = (over: Partial<SubAgentRun>): SubAgentRun => ({
  taskId: 't1', name: 'x', status: 'running', startedAt: 0, ...over,
});

describe('shell vs agent partition', () => {
  it('classifies local_bash as a shell and everything else as an agent', () => {
    expect(isBackgroundShell(run({ taskType: 'local_bash' }))).toBe(true);
    expect(isBackgroundShell(run({ taskType: 'local_agent' }))).toBe(false);
    // No taskType at all is treated as an agent (the pre-2.1.220 shape).
    expect(isBackgroundShell(run({}))).toBe(false);
  });

  it('subAgentToolUseIds never suppresses a background shell\'s Bash card', () => {
    // The regression this guards: a shell's task_started carries the tool_use_id of the
    // BASH call, so including it here erased the command's card from the transcript and the
    // user never saw what was now running in the background.
    const ids = subAgentToolUseIds([
      run({ taskId: 'shell', taskType: 'local_bash', toolUseId: 'toolu_bash' }),
      run({ taskId: 'agent', taskType: 'local_agent', toolUseId: 'toolu_agent' }),
    ]);
    expect(ids.has('toolu_bash')).toBe(false);
    expect(ids.has('toolu_agent')).toBe(true);
  });

  it('summarizeBackgroundShells counts only running shells but keeps finished ones listed', () => {
    const s = summarizeBackgroundShells([
      run({ taskId: 'a', taskType: 'local_bash', status: 'running' }),
      run({ taskId: 'b', taskType: 'local_bash', status: 'stopped' }),
      run({ taskId: 'c', taskType: 'local_agent', status: 'running' }),
    ]);
    expect(s.running).toBe(1);
    expect(s.total).toBe(2);
    expect(s.shells.map((r) => r.taskId)).toEqual(['a', 'b']);
  });
});
