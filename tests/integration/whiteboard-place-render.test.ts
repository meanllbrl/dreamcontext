import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * The 19 Oct 2026 incident, end to end through the built CLI: an agent looked at a board,
 * another session drew a 79-element section into the empty space below, and the agent's
 * `draw --at` landed on top of it with no warning. Now the write is checked against the board
 * under its lock and refused, `place` finds free grid-aligned space, `draw --below` places
 * itself, `render` shows the result as a PNG with no browser, and `show` says the board
 * changed under the agent.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

let project: string;
let root: string;

function run(args: string[], session = 'agent-a'): { out: string; err: string; code: number } {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: project,
    encoding: 'utf-8',
    timeout: 20_000,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, DREAMCONTEXT_AGENT_BOARD: '' },
  });
  return { out: r.stdout, err: r.stderr, code: r.status ?? 1 };
}

function json<T = any>(args: string[], session?: string): T {
  const r = run([...args, '--json'], session);
  if (r.code !== 0) throw new Error(`${args.join(' ')} failed: ${r.out}${r.err}`);
  return JSON.parse(r.out) as T;
}

function rect(id: string, x: number, y: number, w: number, h: number): Record<string, unknown> {
  return {
    id, type: 'rectangle', x, y, width: w, height: h, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null,
    roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
  };
}

/** Another session's section: 79 elements spanning 980..2156 × 1500..2301. */
function sectionScene(): string {
  const els = [rect('frame', 980, 1500, 1176, 801)];
  for (let i = 0; i < 78; i++) els.push(rect(`v${i}`, 1004 + (i % 5) * 228, 1576 + Math.floor(i / 5) * 45, 200, 40));
  return JSON.stringify({ elements: els });
}

/** The agent's branch diagram: 1140 × 941, so at y 1360 it reaches the section's last row. */
function branchScene(): string {
  return JSON.stringify({ elements: [rect('a', 0, 0, 300, 90), rect('b', 420, 0, 300, 90), rect('c', 840, 0, 300, 90), rect('d', 420, 851, 300, 90)] });
}

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-place-')));
  root = join(project, '_dream_context');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(project, 'section.json'), sectionScene());
  writeFileSync(join(project, 'branch.json'), branchScene());
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

describe('whiteboard draw/add overlap check, place, render, show summary', { timeout: 60_000 }, () => {
  const slug = 'cb-experiment';
  let sectionIds: string[] = [];

  it('the agent shows the board first; another session then draws a section below', () => {
    json(['whiteboard', 'create', 'CB Experiment']);
    json(['whiteboard', 'add', slug, 'note', '--text', '# Intro', '--tag', 'intro']);
    expect(json(['whiteboard', 'show', slug])).toMatchObject({ firstShow: true, since: null });
    sectionIds = json(['whiteboard', 'draw', slug, '--file', 'section.json', '--at', '980,1500', '--tag', 'exp-4092'], 'agent-b').ids;
    expect(sectionIds).toHaveLength(79);
  });

  it('draw --at onto the section is refused, lists the overlapping ids, and leaves the board as it was', () => {
    const before = readFileSync(join(root, 'whiteboards', slug, `${slug}.excalidraw.md`), 'utf-8');
    const r = run(['whiteboard', 'draw', slug, '--file', 'branch.json', '--at', '980,1360', '--tag', 'exp-winback']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('refusing to draw branch.json');
    expect(r.err).toContain('overlaps 79 live elements on cb-experiment');
    expect(r.err).toContain('#exp-4092: 79 overlapping');
    for (const id of sectionIds) expect(r.err).toContain(id);
    expect(r.err).toContain('--allow-overlap');
    expect(readFileSync(join(root, 'whiteboards', slug, `${slug}.excalidraw.md`), 'utf-8')).toBe(before);

    const j = run(['whiteboard', 'draw', slug, '--file', 'branch.json', '--at', '980,1360', '--json']);
    expect(j.code).not.toBe(0);
    const body = JSON.parse(j.out);
    expect(body.error).toBe('overlap');
    expect(body.overlaps.map((o: { id: string }) => o.id).sort()).toEqual([...sectionIds].sort());
    expect(body.overlaps[0]).toMatchObject({ tag: 'exp-4092', bbox: expect.any(Object) });
  });

  it('add --at onto the section is refused too; --allow-overlap writes it on purpose', () => {
    const r = run(['whiteboard', 'add', slug, 'knowledge', '--ref', 'pricing', '--at', '1176,1568']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('refusing to add this knowledge widget');
    const ok = json(['whiteboard', 'add', slug, 'knowledge', '--ref', 'pricing', '--at', '1176,1568', '--tag', 'forced', '--allow-overlap']);
    expect(ok.id).toBeTruthy();
    json(['whiteboard', 'remove', slug, '--tag', 'forced']);
  });

  it('show summarises each tag and says the board changed since the agent last looked', () => {
    const shown = json(['whiteboard', 'show', slug]);
    expect(shown.summary.groups).toEqual([
      { tag: 'intro', count: 1, bbox: expect.any(Object) },
      { tag: 'exp-4092', count: 79, bbox: { x: 980, y: 1500, w: 1176, h: 801 } },
    ]);
    expect(shown.since).toMatchObject({ added: 79, byTag: [{ tag: 'exp-4092', added: 79, changed: 0, removed: 0 }] });
    const text = run(['whiteboard', 'show', slug]).out;
    expect(text).toMatch(/#exp-4092\s+79 elements\s+@980,1500,1176,801/);
    expect(text).toContain('Unchanged by anyone else since your last show.');
  });

  it('place --below exp-4092 --size 1140,633 returns a grid-aligned spot that overlaps nothing', () => {
    const r = run(['whiteboard', 'place', slug, '--below', 'exp-4092', '--size', '1140,633']);
    expect(r.code).toBe(0);
    const [x, y] = r.out.split('\n')[0].split(',').map(Number);
    expect(x % 196).toBe(0);
    expect(y % 196).toBe(0);
    expect(y).toBeGreaterThanOrEqual(2301);
    const shown = json(['whiteboard', 'show', slug]);
    const box = { x, y, w: 1140, h: 633 };
    for (const el of shown.elements) {
      const b = el.bbox;
      const overlap = box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h;
      expect(overlap, `overlaps ${el.id}`).toBe(false);
    }
    expect(json(['whiteboard', 'place', slug, '--below', 'exp-4092', '--size', '1140,633'])).toMatchObject({ x, y, grid: 196 });
  });

  it('draw --below places itself under the lock, at the same spot, and does not report its own write', () => {
    const at = run(['whiteboard', 'place', slug, '--below', 'exp-4092', '--size', '1140,941']).out.split('\n')[0];
    const drawn = json(['whiteboard', 'draw', slug, '--file', 'branch.json', '--below', 'exp-4092', '--tag', 'exp-winback']);
    expect(`${drawn.bbox.x},${drawn.bbox.y}`).toBe(at);
    expect(json(['whiteboard', 'show', slug]).since).toBeNull();
    const both = run(['whiteboard', 'draw', slug, '--file', 'branch.json', '--at', '0,0', '--below', 'exp-4092']);
    expect(both.code).not.toBe(0);
    expect(both.err).toContain('not both');
  });

  it('render --tag exp-winback writes a PNG with no browser; refuses a non-.png --out', () => {
    const out = join(project, 'winback.png');
    const r = json(['whiteboard', 'render', slug, '--tag', 'exp-winback', '--out', out]);
    expect(r).toMatchObject({ out, tag: 'exp-winback', overlaps: [] });
    expect(r.width).toBeGreaterThan(1140);
    const png = readFileSync(out);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(r.width);

    const forced = json(['whiteboard', 'draw', slug, '--file', 'branch.json', '--at', '980,1360', '--tag', 'on-top', '--allow-overlap']);
    expect(forced.ids).toHaveLength(4);
    const shownOverlap = json(['whiteboard', 'render', slug, '--tag', 'on-top', '--out', join(project, 'on-top.png')]);
    expect(shownOverlap.overlaps.length).toBeGreaterThan(0);
    expect(run(['whiteboard', 'render', slug, '--out', join(project, 'x.txt')]).err).toContain('--out must name a .png file');
  });

  it('render --file draws a scene file that is not on any board', () => {
    const out = join(project, 'file.png');
    const r = json(['whiteboard', 'render', '--file', 'branch.json', '--out', out]);
    expect(r.drawn).toBe(4);
    expect(readFileSync(out).length).toBeGreaterThan(100);
  });
});
