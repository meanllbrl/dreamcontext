import { spawn } from 'node:child_process';

/**
 * The Assistant's hands: mouse, keyboard and app launching on the owner's Mac, driven through
 * CoreGraphics events from JXA (`osascript -l JavaScript`). No native addon, no Apple Events:
 * posting a CGEvent needs only the Accessibility permission, which macOS grants to the app the
 * process tree belongs to (dreamcontext), once.
 *
 * WHY NOT CLAUDE'S OWN COMPUTER USE. Claude Code wires its built-in `computer-use` server only
 * into INTERACTIVE sessions and reserves that server name; the Assistant runs `claude -p`
 * (stream-json), where the standalone server answers every call with "not wired to a session"
 * (measured on 2.1.285). So the Assistant gets its own server (`computer-mcp.ts`), and every
 * call it makes is an ordinary MCP tool call — under `ask` autonomy each one is approved in
 * the notch before it runs.
 *
 * COORDINATES. Tools speak in SCREENSHOT pixels: the main display is shot at its point size
 * shrunk to {@link SHOT_MAX_EDGE} on the long edge, and every x/y the model sends is scaled
 * back to points here. The model never has to know the display's real size or Retina factor.
 */

export const SHOT_MAX_EDGE = 1366;

export interface Geometry { width: number; height: number }
export interface Point { x: number; y: number }

/** The screenshot's size for a display of `g` points, and points per screenshot pixel. */
export function shotSize(g: Geometry): { width: number; height: number; scale: number } {
  const long = Math.max(g.width, g.height);
  const scale = long > SHOT_MAX_EDGE ? long / SHOT_MAX_EDGE : 1;
  return { width: Math.round(g.width / scale), height: Math.round(g.height / scale), scale };
}

/** A screenshot pixel → a display point, clamped onto the display. Refuses a non-number. */
export function toScreen(p: Point, g: Geometry): Point {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('x and y must be numbers');
  const { scale } = shotSize(g);
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max - 1);
  return { x: Math.round(clamp(p.x * scale, g.width)), y: Math.round(clamp(p.y * scale, g.height)) };
}

/** macOS virtual key codes (ANSI positions — the same physical keys on a Turkish Q board). */
const KEY_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26,
  '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, return: 36, l: 37,
  j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, tab: 48,
  space: 49, '`': 50, delete: 51, escape: 53,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, home: 115, pageup: 116, forwarddelete: 117, end: 119, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
};
const KEY_ALIASES: Record<string, string> = {
  enter: 'return', backspace: 'delete', esc: 'escape', del: 'forwarddelete',
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down', plus: '=', minus: '-',
};
const MODIFIERS: Record<string, number> = {
  cmd: 0x100000, command: 0x100000, super: 0x100000, meta: 0x100000,
  shift: 0x20000, ctrl: 0x40000, control: 0x40000, alt: 0x80000, option: 0x80000, opt: 0x80000,
  fn: 0x800000,
};

/** `"cmd+shift+t"` → one key code plus the modifier flags. Throws a sentence on anything else. */
export function parseKeys(combo: string): { keyCode: number; flags: number } {
  const parts = String(combo).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('keys is empty — send e.g. "cmd+t" or "return"');
  const raw = parts.pop() as string;
  const name = KEY_ALIASES[raw] ?? raw;
  const keyCode = KEY_CODES[name];
  if (keyCode === undefined) throw new Error(`unknown key "${raw}"`);
  let flags = 0;
  for (const m of parts) {
    const f = MODIFIERS[m];
    if (f === undefined) throw new Error(`unknown modifier "${m}" — use cmd, shift, ctrl, alt or fn`);
    flags |= f;
  }
  return { keyCode, flags };
}

// ── JXA scripts. Every value spliced in is a finite number checked by the caller. ────────────

const PRELUDE = 'ObjC.import("CoreGraphics");'
  + 'function ev(t,x,y,b,n){var e=$.CGEventCreateMouseEvent(null,t,{x:x,y:y},b);'
  + 'if(n)$.CGEventSetIntegerValueField(e,1,n);$.CGEventPost(0,e);}';

export type MouseButton = 'left' | 'right';

export function clickScript(p: Point, button: MouseButton, count: number): string {
  const [down, up, b] = button === 'right' ? [3, 4, 1] : [1, 2, 0];
  let s = `${PRELUDE}ev(5,${p.x},${p.y},0,0);delay(0.05);`;
  for (let i = 1; i <= count; i++) s += `ev(${down},${p.x},${p.y},${b},${i});ev(${up},${p.x},${p.y},${b},${i});`;
  return s;
}

export function moveScript(p: Point): string {
  return `${PRELUDE}ev(5,${p.x},${p.y},0,0);`;
}

/** Press, glide in steps (apps ignore a teleporting drag), release. */
export function dragScript(from: Point, to: Point): string {
  let s = `${PRELUDE}ev(5,${from.x},${from.y},0,0);ev(1,${from.x},${from.y},0,1);delay(0.05);`;
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    s += `ev(6,${x},${y},0,0);delay(0.01);`;
  }
  return `${s}ev(2,${to.x},${to.y},0,1);`;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

export function scrollScript(p: Point, direction: Direction, amount: number): string {
  const dy = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
  const dx = direction === 'left' ? amount : direction === 'right' ? -amount : 0;
  return `${PRELUDE}ev(5,${p.x},${p.y},0,0);delay(0.05);`
    + `$.CGEventPost(0,$.CGEventCreateScrollWheelEvent2(null,1,2,${dy},${dx},0));`;
}

export function keyScript(k: { keyCode: number; flags: number }): string {
  return 'ObjC.import("CoreGraphics");'
    + `var d=$.CGEventCreateKeyboardEvent(null,${k.keyCode},true);$.CGEventSetFlags(d,${k.flags});$.CGEventPost(0,d);`
    + `var u=$.CGEventCreateKeyboardEvent(null,${k.keyCode},false);$.CGEventSetFlags(u,${k.flags});$.CGEventPost(0,u);`;
}

export const CURSOR_SCRIPT = 'ObjC.import("CoreGraphics");'
  + 'var p=$.CGEventGetLocation($.CGEventCreate(null));JSON.stringify({x:p.x,y:p.y})';

export const GEOMETRY_SCRIPT = 'ObjC.import("AppKit");'
  + 'var f=$.NSScreen.mainScreen.frame;JSON.stringify({width:f.size.width,height:f.size.height})';

/** `prompt` also adds dreamcontext to the Accessibility list and raises macOS's own dialog. */
export function trustScript(prompt: boolean): string {
  return 'ObjC.import("ApplicationServices");'
    + (prompt ? 'JSON.stringify($.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt:true})))'
      : 'JSON.stringify($.AXIsProcessTrusted())');
}

export const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

// ── Process runner (injectable for tests) ────────────────────────────────────────────────

export type Exec = (file: string, args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realExec: Exec = (file, args, input) => new Promise((resolve) => {
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: err.message }); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  child.stdin.end(input ?? '');
});

export async function runJxa(exec: Exec, script: string): Promise<string> {
  const r = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]);
  if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 300) || `osascript exited ${r.code}`);
  return r.stdout.trim();
}

/**
 * Type text by pasting it: a CGEvent per character cannot carry Turkish letters or emoji
 * through JXA, a paste carries anything. The owner's clipboard TEXT is put back afterwards
 * (a non-text clipboard — an image — is not restored).
 */
export async function typeText(exec: Exec, text: string): Promise<void> {
  const saved = await exec('/usr/bin/pbpaste', []);
  const put = await exec('/usr/bin/pbcopy', [], text);
  if (put.code !== 0) throw new Error('could not reach the clipboard');
  try {
    await runJxa(exec, keyScript(parseKeys('cmd+v')));
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    if (saved.code === 0) await exec('/usr/bin/pbcopy', [], saved.stdout);
  }
}
