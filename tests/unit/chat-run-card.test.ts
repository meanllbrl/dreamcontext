/**
 * Unit tests for the RUN card's two halves that are pure and load-bearing:
 *
 *   • `sanitizeExecCommand` / `sanitizeRelativeDir` — the server's trust boundary for
 *     `kind=exec`. The command is deliberately NOT vetted (the user reads it and presses ▶),
 *     so what IS pinned is that the bridge runs the command it was given or nothing at all —
 *     never a welded-together different one.
 *   • `buildRunReport` — the handshake. This string is the whole reason the turn continues
 *     by itself, and it is exactly the kind of prose that rots silently.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_EXEC_COMMAND_CHARS, sanitizeExecCommand, sanitizeRelativeDir,
} from '../../src/server/routes/agent-spawn-shared.js';
import { execShellArgs } from '../../src/server/routes/agent-terminal.js';
import {
  appendTail, buildRunReport, finishTail, stripAnsi,
} from '../../dashboard/src/components/sleepy/chat/runReport.js';

describe('sanitizeExecCommand', () => {
  it('passes an ordinary command through untouched', () => {
    expect(sanitizeExecCommand('firebase login')).toBe('firebase login');
  });

  it('keeps shell metacharacters — the string IS a shell command', () => {
    const cmd = 'npm ci && npm run build 2>&1 | tail -5';
    expect(sanitizeExecCommand(cmd)).toBe(cmd);
  });

  it('DROPS everything after a newline rather than welding two commands into one', () => {
    // Collapsing the break to a space (what `sanitizePrompt` does) would turn two statements
    // into a third, different command — and the card showed the user only the first line.
    expect(sanitizeExecCommand('echo one\necho two')).toBe('echo one');
    expect(sanitizeExecCommand('echo one\r\nrm -rf /')).toBe('echo one');
  });

  it('strips control bytes that a terminal would swallow invisibly', () => {
    expect(sanitizeExecCommand('echo \x00hi\x1b')).toBe('echo hi');
  });

  it('caps length and treats an empty/blank command as nothing', () => {
    expect(sanitizeExecCommand('x'.repeat(MAX_EXEC_COMMAND_CHARS + 50))).toHaveLength(MAX_EXEC_COMMAND_CHARS);
    expect(sanitizeExecCommand('   ')).toBe('');
    expect(sanitizeExecCommand(null)).toBe('');
  });
});

describe('execShellArgs — the spawn that runs what the card showed', () => {
  // REGRESSION LOCK. The first version was `['-ilc', `exec ${command}`]`, and a single
  // command hid the defect completely: `exec` binds to the FIRST simple command, so
  // `echo READY; read line` replaced the shell with `echo` and everything after the `;`
  // was dropped. The runtime verification caught it — the process printed one line and
  // exited instead of waiting for input — and a card that runs something other than what
  // it displayed is the one failure this feature may not have.
  it('passes the command as an OPERAND, never spliced into the shell string', () => {
    const args = execShellArgs('/bin/zsh', 'echo READY; read line; echo GOT:$line');
    expect(args[args.length - 1]).toBe('echo READY; read line; echo GOT:$line');
    expect(args[1]).not.toContain('echo READY');
  });

  it('execs an INNER shell that reads the operand, so a compound command survives whole', () => {
    expect(execShellArgs('/bin/zsh', 'a && b')).toEqual(['-ilc', `exec '/bin/zsh' -c "$0"`, 'a && b']);
  });

  it('uses fish\'s own operand spelling, which has no $0', () => {
    expect(execShellArgs('/usr/local/bin/fish', 'a; b'))
      .toEqual(['-ilc', `exec '/usr/local/bin/fish' -c "$argv[1]"`, 'a; b']);
  });

  it('keeps the OUTER shell interactive+login — that is where the user\'s PATH comes from', () => {
    expect(execShellArgs('/bin/bash', 'ls')[0]).toBe('-ilc');
  });

  it('quotes the shell path, so a shell living under a spaced directory still spawns', () => {
    expect(execShellArgs("/opt/my shells/z'sh", 'ls')[1]).toBe(`exec '/opt/my shells/z'\\''sh' -c "$0"`);
  });
});

describe('sanitizeRelativeDir', () => {
  it('accepts a relative directory inside the project', () => {
    expect(sanitizeRelativeDir('functions')).toBe('functions');
    expect(sanitizeRelativeDir('./apps/web/')).toBe('apps/web');
  });

  it.each([
    ['an absolute path', '/etc'],
    ['a traversal', '../secrets'],
    ['a traversal in the middle', 'a/../../b'],
    ['a home shortcut', '~/.ssh'],
    ['a backslash', 'a\\b'],
  ])('refuses %s', (_label, dir) => {
    expect(sanitizeRelativeDir(dir)).toBe('');
  });

  it('treats "." and empty as "the project root"', () => {
    expect(sanitizeRelativeDir('.')).toBe('');
    expect(sanitizeRelativeDir('')).toBe('');
    expect(sanitizeRelativeDir(null)).toBe('');
  });
});

describe('stripAnsi / tail bookkeeping', () => {
  it('removes colour and cursor sequences but keeps the words', () => {
    expect(stripAnsi('\x1b[32mok\x1b[0m')).toBe('ok');
    expect(stripAnsi('\x1b]0;title\x07done')).toBe('done');
  });

  it('turns a redrawn progress line into lines instead of one long one', () => {
    expect(stripAnsi('10%\r50%\r100%')).toBe('10%\n50%\n100%');
  });

  it('keeps the tail bounded as output accumulates', () => {
    let tail = '';
    for (let i = 0; i < 500; i++) tail = appendTail(tail, `line ${i}\n`);
    expect(tail.split('\n').length).toBeLessThanOrEqual(81);
    expect(finishTail(tail).split('\n')).toHaveLength(40);
    expect(finishTail(tail)).toContain('line 499');
    expect(finishTail(tail)).not.toContain('line 1\n');
  });

  it('trims blank edges so the report does not open on empty lines', () => {
    expect(finishTail('\n\n  hello  \n\n')).toBe('  hello');
  });
});

describe('buildRunReport — the message that resumes the turn', () => {
  const outcome = { code: 0, tail: 'Logged in as you@example.com', seconds: 12 };

  it('names the command, the exit code and the elapsed time', () => {
    const msg = buildRunReport('firebase login', outcome, { includeOutput: true });
    expect(msg).toContain('$ firebase login');
    expect(msg).toContain('exit 0');
    expect(msg).toContain('12s');
    expect(msg).toContain('Logged in as you@example.com');
  });

  it('withholds the output when the user asked it to, and says so', () => {
    const msg = buildRunReport('gh auth token', outcome, { includeOutput: false });
    expect(msg).not.toContain('you@example.com');
    expect(msg).toMatch(/chose not to share/);
    expect(msg).toContain('exit 0');
  });

  it('reports a failure as a failure rather than burying it in the tail', () => {
    const msg = buildRunReport('npm ci', { code: 1, tail: 'ERR!', seconds: 3 }, { includeOutput: true });
    expect(msg).toContain('exit 1');
  });

  it('does not invent a zero when the process ended with no exit code', () => {
    const msg = buildRunReport('sudo true', { code: null, tail: '', seconds: 1 }, { includeOutput: true });
    expect(msg).not.toContain('exit 0');
    expect(msg).toMatch(/without reporting an exit code/);
  });

  it('says a silent command was silent instead of showing an empty block', () => {
    const msg = buildRunReport('true', { code: 0, tail: '   \n', seconds: 1 }, { includeOutput: true });
    expect(msg).toContain('It printed nothing.');
    expect(msg).not.toContain('```');
  });
});
