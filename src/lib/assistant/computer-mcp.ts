import { readFileSync, unlinkSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { assistantConfigPath, assistantContextRoot } from './home.js';
import { captureScreens, type CaptureResult } from './screen.js';
import {
  ACCESSIBILITY_PANE, CURSOR_SCRIPT, GEOMETRY_SCRIPT, SHOT_MAX_EDGE, clickScript, dragScript, keyScript,
  moveScript, parseKeys, realExec, runJxa, scrollScript, shotSize, toScreen, trustScript, typeText,
  type Direction, type Exec, type Geometry,
} from './computer.js';

/**
 * `dreamcontext assistant computer-mcp` — a stdio MCP server that gives ONLY the Assistant's
 * own session mouse, keyboard and screen (`computer.ts` holds the mechanics and the reason it
 * is not Claude's built-in computer use). The server is handed to the Assistant's spawn alone
 * through {@link ensureComputerMcpConfig}; no other chat, terminal or automation gets it.
 *
 * Hand-rolled JSON-RPC over newline-delimited stdin/stdout: four methods, no SDK dependency.
 * Calls run ONE AT A TIME — two clicks racing would land in an undefined order.
 */

export const COMPUTER_SERVER_NAME = 'computer';

const INSTRUCTIONS = [
  'Controls the owner\'s Mac (main display): screenshot, mouse, keyboard, launching apps.',
  'Use it only for what the owner asked in this conversation. Never type a password, key or other secret.',
  'Start with `screenshot`; every x/y is in pixels of the latest screenshot. After acting, take a new screenshot to confirm it worked before saying it is done.',
  'Prefer `open_application` and keyboard shortcuts (`key`) over hunting with the mouse.',
].join('\n');

const POINT = { x: { type: 'number' }, y: { type: 'number' } };

const TOOLS = [
  { name: 'screenshot', description: `Capture the main display (at most ${SHOT_MAX_EDGE}px on the long edge). Coordinates for every other tool are in this image's pixels.`, inputSchema: { type: 'object', properties: {} } },
  { name: 'left_click', description: 'Left-click at (x, y).', inputSchema: { type: 'object', properties: POINT, required: ['x', 'y'] } },
  { name: 'double_click', description: 'Double-click at (x, y).', inputSchema: { type: 'object', properties: POINT, required: ['x', 'y'] } },
  { name: 'right_click', description: 'Right-click at (x, y).', inputSchema: { type: 'object', properties: POINT, required: ['x', 'y'] } },
  { name: 'mouse_move', description: 'Move the pointer to (x, y) without clicking.', inputSchema: { type: 'object', properties: POINT, required: ['x', 'y'] } },
  {
    name: 'left_click_drag', description: 'Press at (start_x, start_y), drag to (end_x, end_y), release.',
    inputSchema: { type: 'object', properties: { start_x: { type: 'number' }, start_y: { type: 'number' }, end_x: { type: 'number' }, end_y: { type: 'number' } }, required: ['start_x', 'start_y', 'end_x', 'end_y'] },
  },
  {
    name: 'scroll', description: 'Scroll at (x, y). amount is in lines (default 3).',
    inputSchema: { type: 'object', properties: { ...POINT, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number' } }, required: ['x', 'y', 'direction'] },
  },
  { name: 'type', description: 'Type text into the focused field (pasted, so any language works).', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'key', description: 'Press one key or shortcut, e.g. "return", "escape", "cmd+t", "cmd+shift+4".', inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'open_application', description: 'Launch an app (or bring it forward) by name, e.g. "Safari", "Music".', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'cursor_position', description: 'Where the pointer is, in screenshot pixels.', inputSchema: { type: 'object', properties: {} } },
];

type Content = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
export interface ToolResult { content: Content; isError?: boolean }

export interface ComputerDeps {
  exec: Exec;
  capture: (dir: string) => Promise<CaptureResult>;
  shotsDir: string;
  platform: NodeJS.Platform;
}

export function defaultDeps(): ComputerDeps {
  return {
    exec: realExec,
    capture: (dir) => captureScreens({ dir, display: 1 }),
    shotsDir: join(assistantContextRoot(), 'tmp', 'screens'),
    platform: process.platform,
  };
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

async function geometry(d: ComputerDeps): Promise<Geometry> {
  const g = JSON.parse(await runJxa(d.exec, GEOMETRY_SCRIPT)) as Geometry;
  if (!(g.width > 0 && g.height > 0)) throw new Error('could not read the display size');
  return g;
}

/** Input is refused by macOS without a word unless dreamcontext is trusted for Accessibility —
 *  so ask first, and turn a silent no-op into a named instruction. */
async function ensureTrusted(d: ComputerDeps): Promise<ToolResult | null> {
  if (JSON.parse(await runJxa(d.exec, trustScript(false))) === true) return null;
  await runJxa(d.exec, trustScript(true)).catch(() => '');
  await d.exec('/usr/bin/open', [ACCESSIBILITY_PANE]);
  return text('macOS has not allowed dreamcontext to control the mouse and keyboard. Tell the owner: System Settings → Privacy & Security → Accessibility (opened for them) → turn on dreamcontext, then ask again.', true);
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
}

async function screenshot(d: ComputerDeps): Promise<ToolResult> {
  const g = await geometry(d);
  const shot = await d.capture(d.shotsDir);
  if (!shot.ok) return text(shot.message, true);
  const path = shot.shots[0].path;
  try {
    const size = shotSize(g);
    await d.exec('/usr/bin/sips', ['-z', String(size.height), String(size.width), path]);
    const data = readFileSync(path).toString('base64');
    return {
      content: [
        { type: 'image', data, mimeType: 'image/jpeg' },
        { type: 'text', text: `Main display, ${size.width}×${size.height} screenshot pixels.` },
      ],
    };
  } finally {
    // The most sensitive file this feature makes: it does not outlive the call.
    try { unlinkSync(path); } catch { /* already pruned */ }
  }
}

export async function callTool(name: string, args: Record<string, unknown>, d: ComputerDeps): Promise<ToolResult> {
  if (d.platform !== 'darwin') return text('Controlling the computer works on macOS only.', true);
  try {
    if (name === 'screenshot') return await screenshot(d);
    if (name === 'open_application') {
      const app = String(args.name ?? '').trim();
      if (!app) return text('name is required', true);
      const r = await d.exec('/usr/bin/open', ['-a', app]);
      return r.code === 0 ? text(`Opened ${app}.`) : text(`Could not open "${app}": ${r.stderr.trim().slice(0, 200)}`, true);
    }
    if (name === 'cursor_position') {
      const g = await geometry(d);
      const p = JSON.parse(await runJxa(d.exec, CURSOR_SCRIPT)) as { x: number; y: number };
      const { scale } = shotSize(g);
      return text(JSON.stringify({ x: Math.round(p.x / scale), y: Math.round(p.y / scale) }));
    }
    if (!TOOLS.some((t) => t.name === name)) return text(`Unknown tool "${name}".`, true);

    const refused = await ensureTrusted(d);
    if (refused) return refused;
    if (name === 'type') {
      if (typeof args.text !== 'string' || !args.text) return text('text is required', true);
      await typeText(d.exec, args.text);
      return text('Typed.');
    }
    if (name === 'key') {
      await runJxa(d.exec, keyScript(parseKeys(String(args.keys ?? ''))));
      return text(`Pressed ${String(args.keys)}.`);
    }

    const g = await geometry(d);
    if (name === 'left_click_drag') {
      const from = toScreen({ x: num(args.start_x, 'start_x'), y: num(args.start_y, 'start_y') }, g);
      const to = toScreen({ x: num(args.end_x, 'end_x'), y: num(args.end_y, 'end_y') }, g);
      await runJxa(d.exec, dragScript(from, to));
      return text('Dragged.');
    }
    const p = toScreen({ x: num(args.x, 'x'), y: num(args.y, 'y') }, g);
    if (name === 'mouse_move') await runJxa(d.exec, moveScript(p));
    else if (name === 'left_click') await runJxa(d.exec, clickScript(p, 'left', 1));
    else if (name === 'double_click') await runJxa(d.exec, clickScript(p, 'left', 2));
    else if (name === 'right_click') await runJxa(d.exec, clickScript(p, 'right', 1));
    else if (name === 'scroll') {
      const dir = args.direction as Direction;
      if (!['up', 'down', 'left', 'right'].includes(dir)) return text('direction must be up, down, left or right', true);
      const amount = args.amount === undefined ? 3 : Math.min(Math.max(Math.round(num(args.amount, 'amount')), 1), 50);
      await runJxa(d.exec, scrollScript(p, dir, amount));
    }
    return text('Done.');
  } catch (err) {
    return text((err as Error).message, true);
  }
}

interface RpcMessage { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

/** One JSON-RPC message → its response, or null for a notification. */
export async function handleMessage(msg: RpcMessage, d: ComputerDeps): Promise<object | null> {
  const hasId = msg.id !== undefined && msg.id !== null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'dreamcontext-computer', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      return reply(await callTool(name, args, d));
    }
    default:
      return hasId ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } } : null;
  }
}

export function runComputerMcpServer(d: ComputerDeps = defaultDeps()): void {
  const rl = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try { msg = JSON.parse(line) as RpcMessage; } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    chain = chain.then(async () => {
      const out = await handleMessage(msg, d);
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    });
  });
  rl.on('close', () => { void chain.then(() => process.exit(0)); });
}

/**
 * The `--mcp-config` file the Assistant's spawn carries: this CLI, by absolute path, so the
 * child needs no PATH. Written 0600 beside the Assistant's config; null when the CLI entry
 * cannot be told (the Assistant then runs without hands, visibly).
 */
export function ensureComputerMcpConfig(
  home: string = homedir(),
  node: string = process.execPath,
  cliEntry: string | undefined = process.env.DREAMCONTEXT_CLI || process.argv[1],
): string | null {
  if (!cliEntry) return null;
  const target = join(dirname(assistantConfigPath(home)), 'computer-mcp.json');
  const body = JSON.stringify({
    mcpServers: { [COMPUTER_SERVER_NAME]: { type: 'stdio', command: node, args: [cliEntry, 'assistant', 'computer-mcp'] } },
  }, null, 2) + '\n';
  try {
    if (existsSync(target) && readFileSync(target, 'utf-8') === body) return target;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { encoding: 'utf-8', mode: 0o600 });
    return target;
  } catch {
    return null;
  }
}
