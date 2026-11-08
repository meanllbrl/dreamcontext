/**
 * The drawing line the prompt hook prints, and Gate 1e, through the REAL built CLI (the hooks
 * Claude, Codex, Antigravity and the desktop bridge run). Fictional project, fake HOME.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_ONLY } from '../../src/lib/tool-text.js';

const CLI = join(__dirname, '../..', 'dist', 'index.js');

let root: string;
let home: string;
let proj: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hook-draw-')));
  home = join(root, 'home');
  proj = join(root, 'acme-shop');
  const ctx = join(proj, '_dream_context');
  for (const d of [join(home, '.dreamcontext'), join(ctx, 'core'), join(ctx, 'state'), join(ctx, 'knowledge'), join(ctx, 'whiteboards', 'release-plan')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: "acme-shop"\ntype: soul\nupdated: "2026-01-02"\n---\n\n## Project Identity\n\nA fictional storefront.\n');
  writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '1' }));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, DREAMCONTEXT_BRAIN_SYNC: '0', DREAMCONTEXT_RECALL_CLOUD: '0', CLAUDE_PROJECT_DIR: proj, ...extra };
  for (const k of ['DREAMCONTEXT_CHAT_TAB', 'CLAUDE_CODE_SESSION_ID', 'DREAMCONTEXT_CONTEXT_BY', 'DREAMCONTEXT_AGENT_CHAT', 'DREAMCONTEXT_DRAW_HOOK', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) {
    if (!(k in extra)) delete e[k];
  }
  return e;
}

function prompt(text: string, format: string[] = [], extra: Record<string, string> = {}): string {
  const r = spawnSync(process.execPath, [CLI, 'hook', 'user-prompt-submit', ...format], {
    cwd: proj, env: env(extra), input: JSON.stringify({ prompt: text, session_id: 'acme-draw-1' }), encoding: 'utf-8', timeout: 60_000,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

const drawLines = (out: string): string[] => out.split('\n').filter((l) => l.includes('Drawing request'));

describe.skipIf(!existsSync(CLI))('prompt hook: the drawing line', () => {
  it('a drawing prompt prints one line naming draw, in Claude words and in the Codex/Antigravity bridge shape', () => {
    const claude = drawLines(prompt('tahtaya sync akışını çiz'));
    expect(claude).toHaveLength(1);
    expect(claude[0]).toContain('load the `draw` skill (Skill tool)');
    expect(claude[0]).toContain('dreamcontext whiteboard kit');
    // Codex and Antigravity both get the prompt hook as `--format codex` (t3-bridge/context.ts);
    // `--format antigravity` is the write gate's shape only.
    const codex = drawLines(prompt('make an excalidraw diagram of the checkout', ['--format', 'codex']));
    expect(codex.join('\n')).toContain('open the `draw` skill (its SKILL.md)');
    expect(codex.filter((l) => CLAUDE_ONLY.test(l))).toEqual([]);
  }, 120_000);

  it('the Chat view: a plain drawing may be a dc-graph; a kept one is draw', () => {
    // The pane boundary is this test process, so a Claude session running the suite does not
    // make the hook read as nested (session-origin.ts).
    const pane = { DREAMCONTEXT_CHAT_TAB: '1', DREAMCONTEXT_SERVER_PID: String(process.pid) };
    const chat = drawLines(prompt('sync akışını çiz', [], pane));
    expect(chat.join('\n')).toContain('dc-graph');
    const kept = drawLines(prompt('kontrol paneline sync akışını çiz', [], pane));
    expect(kept.join('\n')).not.toContain('dc-graph');
    expect(kept.join('\n')).toContain('load the `draw` skill');
  }, 120_000);

  it('a board slug of this project makes it a whiteboard drawing', () => {
    expect(drawLines(prompt('release-plan için akışı çiz')).join('\n')).toContain('dreamcontext whiteboard kit');
  }, 60_000);

  it('a plain prompt prints nothing; DREAMCONTEXT_DRAW_HOOK=0 silences it', () => {
    expect(drawLines(prompt('the drawer does not close on mobile'))).toEqual([]);
    expect(drawLines(prompt('draw the sync flow', [], { DREAMCONTEXT_DRAW_HOOK: '0' }))).toEqual([]);
  }, 120_000);

  it('a symlinked whiteboards/ folder is not read', () => {
    const other = join(root, 'other');
    mkdirSync(join(other, 'secret-board'), { recursive: true });
    const proj2 = join(root, 'linked-shop');
    const ctx2 = join(proj2, '_dream_context');
    for (const d of [join(ctx2, 'core'), join(ctx2, 'state')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(ctx2, 'core', '0.soul.md'), '---\nname: "linked-shop"\ntype: soul\nupdated: "2026-01-02"\n---\n\nA fictional shop.\n');
    writeFileSync(join(ctx2, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '1' }));
    symlinkSync(other, join(ctx2, 'whiteboards'));
    const r = spawnSync(process.execPath, [CLI, 'hook', 'user-prompt-submit'], {
      cwd: proj2, env: { ...env(), CLAUDE_PROJECT_DIR: proj2 }, input: JSON.stringify({ prompt: 'draw the flow on secret-board', session_id: 'acme-draw-2' }), encoding: 'utf-8', timeout: 60_000,
    });
    const lines = drawLines(r.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('whiteboard kit');
  }, 60_000);
});

function preTool(input: Record<string, unknown>, format: string[] = [], cwd = proj): string {
  const r = spawnSync(process.execPath, [CLI, 'hook', 'pre-tool-use', ...format], {
    cwd, env: env(), input: JSON.stringify({ session_id: 'acme-draw-3', cwd, ...input }), encoding: 'utf-8', timeout: 60_000,
  });
  return r.stdout;
}

describe.skipIf(!existsSync(CLI))('pre-tool-use Gate 1e: a hand-written Excalidraw scene', () => {
  const scene = '---\nexcalidraw-plugin: parsed\n---\n%%\n## Drawing\n```json\n{"type": "excalidraw", "elements": [{"type": "rectangle", "x": 0}]}\n```\n%%';
  const file = () => join(proj, 'boards', 'x.excalidraw.md');

  it('Claude: a Write of scene JSON is refused naming draw; MultiEdit with scene JSON too', () => {
    const out = preTool({ tool_name: 'Write', tool_input: { file_path: file(), content: scene } });
    expect(out).toContain('"permissionDecision":"deny"');
    expect(out).toContain('`draw` skill');
    const multi = preTool({ tool_name: 'MultiEdit', tool_input: { file_path: file(), edits: [{ old_string: 'a', new_string: '"elements": [{"type": "text"}]' }] } });
    expect(multi).toContain('"permissionDecision":"deny"');
  }, 60_000);

  it('a frontmatter edit and a .md mentioning excalidraw pass', () => {
    expect(preTool({ tool_name: 'Edit', tool_input: { file_path: file(), old_string: 'tags: [a]', new_string: 'tags: [a, b]' } })).not.toContain('deny');
    expect(preTool({ tool_name: 'Write', tool_input: { file_path: join(proj, 'notes.md'), content: 'an excalidraw note' } })).not.toContain('deny');
  }, 60_000);

  it('Codex and Antigravity calls pass (the gate is off there)', () => {
    expect(preTool({ tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Add File: ${file()}\n+${scene}\n*** End Patch` } }, ['--format', 'codex'])).not.toContain('`draw` skill');
  }, 60_000);

  it('outside a dreamcontext project it passes', () => {
    const bare = join(root, 'bare');
    mkdirSync(bare, { recursive: true });
    expect(preTool({ tool_name: 'Write', tool_input: { file_path: join(bare, 'x.excalidraw.md'), content: scene } }, [], bare)).not.toContain('deny');
  }, 60_000);
});
