import { describe, expect, it } from 'vitest';
import { escapeCmdShimArg, resolvedSpawnSpec, spawnSpec } from '../../src/lib/win-cmd.js';

describe('starting an npm .cmd launcher on Windows (pure)', () => {
  it('passes everything through off Windows, and a real program through on it', () => {
    expect(spawnSpec('/usr/local/bin/codex', ['login'], 'darwin')).toEqual({ file: '/usr/local/bin/codex', args: ['login'] });
    expect(spawnSpec('C:\\npm\\codex.exe', ['login'], 'win32')).toEqual({ file: 'C:\\npm\\codex.exe', args: ['login'] });
  });

  it('REGRESSION: codex.cmd runs through cmd.exe, quoted, never as a bare spawn (EINVAL)', () => {
    const s = spawnSpec('C:\\Users\\Robin\\AppData\\Roaming\\npm\\codex.cmd', ['login', 'status'], 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
    expect(s.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(s.windowsVerbatimArguments).toBe(true);
    expect(s.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(s.args[3]).toBe('"C:\\Users\\Robin\\AppData\\Roaming\\npm\\codex.cmd ^^^"login^^^" ^^^"status^^^""');
    expect(spawnSpec('C:\\x\\run.BAT', [], 'win32', {}).file).toBe('C:\\Windows\\System32\\cmd.exe'); // never a bare cmd.exe the working folder could plant
  });

  it('a space, a quote or a cmd character in an argument stays one inert argument', () => {
    expect(escapeCmdShimArg('a b')).toBe('^^^"a^^^ b^^^"');
    expect(escapeCmdShimArg('x & calc')).toBe('^^^"x^^^ ^^^&^^^ calc^^^"');
    expect(escapeCmdShimArg('%PATH%')).toBe('^^^"^^^%PATH^^^%^^^"');
    expect(escapeCmdShimArg('mcp_servers.k.command="C:\\n\\node.exe"')).toBe('^^^"mcp_servers.k.command=\\^^^"C:\\n\\node.exe\\^^^"^^^"');
  });

  it('a .cmd named without a full path, or found through a relative PATH entry, never goes through cmd.exe', () => {
    // cmd looks in the working folder first: a codex.cmd planted in a project must not run.
    expect(spawnSpec('codex.cmd', ['app-server'], 'win32', {})).toEqual({ file: 'codex.cmd', args: ['app-server'] });
    const isFile = (p: string) => p === 'bin\\npx.cmd' || p === '.\\npx.cmd';
    expect(resolvedSpawnSpec('npx', ['x'], { platform: 'win32', path: '.;bin', env: {}, isFile })).toEqual({ file: 'npx', args: ['x'] });
    const npx = 'C:\\node\\npx.cmd';
    expect(resolvedSpawnSpec('npx', ['x'], { platform: 'win32', path: `.;C:\\node`, env: {}, isFile: (p) => p === npx || isFile(p) }).windowsVerbatimArguments).toBe(true);
  });
});
