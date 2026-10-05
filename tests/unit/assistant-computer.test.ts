/**
 * Owner request of 2026-10-04: "personal asistanım bilgisayarımı kullanabilsin, ben izin
 * verdikçe". Claude Code's built-in computer use is not available to the Assistant's `claude -p`
 * session, so the Assistant gets its own MCP server (`src/lib/assistant/computer*.ts`), wired
 * into its spawn alone. These tests pin the coordinate math, the key grammar, the
 * permission refusal, the JSON-RPC surface and the spawn argv.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shotSize, toScreen, parseKeys, clickScript, dragScript, scrollScript, type Exec } from '../../src/lib/assistant/computer.js';
import { callTool, handleMessage, ensureComputerMcpConfig, type ComputerDeps } from '../../src/lib/assistant/computer-mcp.js';
import { mcpConfigArgs } from '../../src/server/routes/agent-chat.js';

const RETINA_MBP = { width: 1800, height: 1169 };

describe('coordinates: screenshot pixels ↔ display points', () => {
  it('a display wider than the cap is shot smaller, and a pixel scales back to points', () => {
    const s = shotSize(RETINA_MBP);
    expect(s.width).toBe(1366);
    expect(s.height).toBe(887);
    expect(toScreen({ x: 683, y: 443 }, RETINA_MBP)).toEqual({ x: 900, y: 584 });
  });
  it('a small display is shot 1:1', () => {
    expect(shotSize({ width: 1280, height: 800 })).toEqual({ width: 1280, height: 800, scale: 1 });
  });
  it('clamps onto the display and refuses a non-number', () => {
    expect(toScreen({ x: -50, y: 99999 }, RETINA_MBP)).toEqual({ x: 0, y: 1168 });
    expect(() => toScreen({ x: Number.NaN, y: 1 }, RETINA_MBP)).toThrow(/numbers/);
  });
});

describe('key grammar', () => {
  it('modifiers fold into flags', () => {
    expect(parseKeys('cmd+t')).toEqual({ keyCode: 17, flags: 0x100000 });
    expect(parseKeys('Cmd+Shift+4')).toEqual({ keyCode: 21, flags: 0x100000 | 0x20000 });
    expect(parseKeys('enter')).toEqual({ keyCode: 36, flags: 0 });
  });
  it('an unknown key or modifier is a sentence, not a silent no-op', () => {
    expect(() => parseKeys('cmd+banana')).toThrow(/unknown key/);
    expect(() => parseKeys('hyper+t')).toThrow(/unknown modifier/);
    expect(() => parseKeys('')).toThrow(/empty/);
  });
});

describe('event scripts', () => {
  it('a double click posts two down/up pairs with rising click state', () => {
    const s = clickScript({ x: 10, y: 20 }, 'left', 2);
    expect(s).toContain('ev(1,10,20,0,1);ev(2,10,20,0,1);ev(1,10,20,0,2);ev(2,10,20,0,2);');
  });
  it('a right click uses the right-button events', () => {
    expect(clickScript({ x: 1, y: 2 }, 'right', 1)).toContain('ev(3,1,2,1,1);ev(4,1,2,1,1);');
  });
  it('a drag glides through intermediate points and releases at the target', () => {
    const s = dragScript({ x: 0, y: 0 }, { x: 120, y: 0 });
    expect(s).toContain('ev(6,10,0,0,0)');
    expect(s.endsWith('ev(2,120,0,0,1);')).toBe(true);
  });
  it('scroll down is a negative wheel delta', () => {
    expect(scrollScript({ x: 5, y: 5 }, 'down', 3)).toContain('CGEventCreateScrollWheelEvent2(null,1,2,-3,0,0)');
  });
});

/** A fake osascript/open/pbcopy world: trusted or not, a fixed display, a call log. */
function fakeDeps(opts: { trusted: boolean; dir: string }): { deps: ComputerDeps; calls: Array<[string, string[], string?]> } {
  const calls: Array<[string, string[], string?]> = [];
  const exec: Exec = async (file, args, input) => {
    calls.push([file, args, input]);
    const script = args[args.length - 1] ?? '';
    if (file.endsWith('osascript')) {
      if (script.includes('AXIsProcessTrusted')) return { code: 0, stdout: JSON.stringify(opts.trusted), stderr: '' };
      if (script.includes('NSScreen')) return { code: 0, stdout: JSON.stringify(RETINA_MBP), stderr: '' };
      if (script.includes('CGEventGetLocation')) return { code: 0, stdout: '{"x":900,"y":584}', stderr: '' };
    }
    if (file.endsWith('pbpaste')) return { code: 0, stdout: 'owner clipboard', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const capture = async (dir: string) => {
    const path = join(dir, 'shot.jpg');
    writeFileSync(path, 'jpegbytes');
    return { ok: true as const, shots: [{ display: 1, path }] };
  };
  return { deps: { exec, capture, shotsDir: opts.dir, platform: 'darwin' }, calls };
}

describe('tools', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-computer-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('without Accessibility, input is refused by name, macOS is asked, and the pane opens', async () => {
    const { deps, calls } = fakeDeps({ trusted: false, dir });
    const r = await callTool('left_click', { x: 10, y: 10 }, deps);
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringMatching(/Accessibility/) });
    expect(calls.some(([, a]) => a.join(' ').includes('AXTrustedCheckOptionPrompt'))).toBe(true);
    expect(calls.some(([f, a]) => f.endsWith('open') && a[0].includes('Privacy_Accessibility'))).toBe(true);
    expect(calls.some(([, a]) => a.join(' ').includes('CGEventCreateMouseEvent'))).toBe(false);
  });

  it('a click lands at the scaled display point', async () => {
    const { deps, calls } = fakeDeps({ trusted: true, dir });
    const r = await callTool('left_click', { x: 683, y: 443 }, deps);
    expect(r.isError).toBeUndefined();
    const click = calls.find(([, a]) => a.join(' ').includes('ev(1,'));
    expect(click?.[1].join(' ')).toContain('ev(1,900,584,0,1)');
  });

  it('typing pastes, then puts the owner\'s clipboard back', async () => {
    const { deps, calls } = fakeDeps({ trusted: true, dir });
    await callTool('type', { text: 'merhaba ğüşİ' }, deps);
    const copies = calls.filter(([f]) => f.endsWith('pbcopy')).map(([, , i]) => i);
    expect(copies).toEqual(['merhaba ğüşİ', 'owner clipboard']);
  });

  it('a screenshot comes back as an image at screenshot size and leaves no file behind', async () => {
    const { deps, calls } = fakeDeps({ trusted: false, dir });
    const r = await callTool('screenshot', {}, deps);
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(calls.find(([f]) => f.endsWith('sips'))?.[1].slice(0, 3)).toEqual(['-z', '887', '1366']);
    expect(existsSync(join(dir, 'shot.jpg'))).toBe(false);
  });

  it('opening an app needs no Accessibility', async () => {
    const { deps, calls } = fakeDeps({ trusted: false, dir });
    const r = await callTool('open_application', { name: 'Music' }, deps);
    expect(r.isError).toBeUndefined();
    expect(calls.find(([f]) => f.endsWith('open'))?.[1]).toEqual(['-a', 'Music']);
  });

  it('off macOS every tool says so', async () => {
    const { deps } = fakeDeps({ trusted: true, dir });
    const r = await callTool('screenshot', {}, { ...deps, platform: 'linux' });
    expect(r.isError).toBe(true);
  });
});

describe('MCP surface', () => {
  const deps = fakeDeps({ trusted: true, dir: tmpdir() }).deps;
  it('initialize echoes the protocol and carries instructions', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, deps) as { result: { protocolVersion: string; instructions: string } };
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.instructions).toMatch(/screenshot/);
  });
  it('tools/list names the toolkit', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps) as { result: { tools: Array<{ name: string }> } };
    expect(r.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['screenshot', 'left_click', 'type', 'key', 'open_application']));
  });
  it('a notification gets no reply; an unknown method with an id gets -32601', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeNull();
    expect(await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' }, deps)).toMatchObject({ error: { code: -32601 } });
  });
});

describe('spawn wiring', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-home-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('the config launches this CLI by absolute path and is private', () => {
    const p = ensureComputerMcpConfig(home, '/usr/local/bin/node', '/opt/dc/dist/index.js');
    expect(p).toBe(join(home, '.dreamcontext', 'assistant', 'computer-mcp.json'));
    const cfg = JSON.parse(readFileSync(p as string, 'utf-8'));
    expect(cfg.mcpServers.computer).toEqual({ type: 'stdio', command: '/usr/local/bin/node', args: ['/opt/dc/dist/index.js', 'assistant', 'computer-mcp'] });
    expect(statSync(p as string).mode & 0o777).toBe(0o600);
  });
  it('no CLI entry, no config', () => {
    expect(ensureComputerMcpConfig(home, '/usr/local/bin/node', '')).toBeNull();
  });
  it('every MCP config rides in one variadic flag; none, no flag', () => {
    expect(mcpConfigArgs([null, '/a.json', '/b.json'])).toEqual(['--mcp-config', '/a.json', '/b.json']);
    expect(mcpConfigArgs([null, null])).toEqual([]);
  });
});
