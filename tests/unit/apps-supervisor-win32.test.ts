import { describe, it, expect } from 'vitest';
import { parseNetstatListeners, shellInvocation, win32TreePids, exposedListener } from '../../src/lib/apps/supervisor.js';

/**
 * The supervisor on Windows (no /bin/sh, no process groups, no lsof): pure pieces, run on every
 * platform with recorded Windows output.
 */

describe('shellInvocation', () => {
  it('runs a manifest line through /bin/sh off Windows', () => {
    expect(shellInvocation('node server.mjs', 'darwin')).toEqual({ file: '/bin/sh', args: ['-c', 'node server.mjs'], verbatim: false });
    expect(shellInvocation('node server.mjs', 'linux').file).toBe('/bin/sh');
  });
  it('runs it through System32 cmd.exe on Windows, never a PATH lookup, the line quoted once for /s', () => {
    const s = shellInvocation('npm run build && node "my server.mjs"', 'win32', { SystemRoot: 'C:\\Windows' });
    expect(s.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(s.args).toEqual(['/d', '/s', '/c', '"npm run build && node "my server.mjs""']);
    expect(s.verbatim).toBe(true);
  });
});

// `netstat -ano` from an English and a German Windows (the state column is translated).
const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012
  TCP    0.0.0.0:51234          0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:51235        0.0.0.0:0              ABHÖREN         4243
  TCP    127.0.0.1:51235        127.0.0.1:60001        ESTABLISHED     4243
  TCP    [::]:51236             [::]:0                 LISTENING       4243
  TCP    [::1]:51237            [::]:0                 LISTENING       4242
  UDP    0.0.0.0:5353           *:*                                    4242
`.replace(/\n/g, '\r\n');

describe('parseNetstatListeners', () => {
  it('keeps the TCP listeners of the given pids, by the foreign address, in any language', () => {
    expect(parseNetstatListeners(NETSTAT, [4242, 4243])).toEqual(['0.0.0.0:51234', '127.0.0.1:51235', '[::]:51236', '[::1]:51237']);
  });
  it('ignores other processes, connections and UDP', () => {
    expect(parseNetstatListeners(NETSTAT, [9999])).toEqual([]);
    expect(parseNetstatListeners(NETSTAT, [1012])).toEqual(['0.0.0.0:135']);
  });
  it('the exposed check reads netstat addresses the way it reads lsof ones', () => {
    const exposed = parseNetstatListeners(NETSTAT, [4242, 4243]).filter(exposedListener);
    expect(exposed).toEqual(['0.0.0.0:51234', '[::]:51236']);
  });
});

describe('win32TreePids', () => {
  // pid ppid created(FILETIME)
  const TABLE = [
    '4 0 100',
    '700 600 1000', // cmd.exe the supervisor started
    '701 700 1001', // node server.mjs
    '702 701 1002', // a worker it forked
    '650 700 500', // older than 700: its parent was an earlier process that had pid 700
    '900 800 1003',
    'garbage line',
  ].join('\r\n');
  it('is the root and every younger descendant', () => {
    expect(win32TreePids(TABLE, 700).sort()).toEqual([700, 701, 702]);
  });
  it('a root missing from the table is still itself', () => {
    expect(win32TreePids('', 123)).toEqual([123]);
  });
});
