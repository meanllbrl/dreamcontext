import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli/program.js';
import { createWhiteboard, readWhiteboard } from '../../src/lib/whiteboards/store.js';
import { elementTag } from '../../src/lib/whiteboards/widgets.js';
import {
  auditWarning, buildSpecDrawing, kitDir, loadBuilder, noteWarning, parseSpec, readKitReference,
} from '../../src/lib/whiteboards/spec-draw.js';
import { AGENT_BOARD_ENV, AGENT_SCRATCH_ENV, AGENT_SELF_ENV } from '../../src/lib/automations/types.js';

/**
 * A whiteboard drawing from a JSON spec, built by the excalidraw pack's own builder
 * (`whiteboard draw --spec`), the kit reference (`whiteboard kit`) and the note-length warning.
 * Owner, 2026-10-21: an agent asked to put something on a whiteboard stacked markdown notes
 * instead of drawing with the excalidraw kit; a board agent (no skills, no `node`) could not
 * reach the kit at all. Driven through the REAL command tree in a scratch project, HOME stubbed.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SAMPLE_PNG = join(ROOT, 'skill-packs', 'excalidraw', 'examples', 'sample.png');
const TYPES = loadBuilder().SPEC_TYPES;

let project: string;
let root: string;
let home: string;
let cwd: string;
let slug: string;

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  // eslint-disable-next-line no-control-regex
  const strip = (s: string[]) => s.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
  return { code, out: strip(out), err: strip(err) };
}

async function json(argv: string[]): Promise<any> {
  const r = await run([...argv, '--json']);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out);
}

const FLOW_SPEC = {
  elements: [{
    type: 'stack', gap: 24, items: [
      { type: 'sectionTitle', text: 'Sync', fontSize: 28 },
      { type: 'flow', steps: ['Write', { text: 'Batch', label: '2 s', note: 'retried offline' }, 'Server'] },
      { type: 'panel', title: 'Rules', color: 'yellow', items: [{ type: 'bullets', width: 300, items: ['Body: merged', 'Field: last wins'] }] },
    ],
  }],
};

beforeEach(() => {
  cwd = process.cwd();
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-spec-cli-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-spec-home-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv(AGENT_BOARD_ENV, '');
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  slug = createWhiteboard(root, 'Spec Board').slug;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('parseSpec', () => {
  it('takes { elements } or the bare array, and keeps only what a drawing uses', () => {
    // `audit: false` would print a clean audit for a drawing nobody checked: it is dropped too.
    const a = parseSpec(JSON.stringify({ out: '/etc/x.md', vaultRoot: '/', name: 'n', audit: false, elements: [{ type: 'card', text: 'A' }] }), 's.json', TYPES);
    expect(a.spec).toEqual({ elements: [{ type: 'card', text: 'A' }] });
    expect(parseSpec(JSON.stringify([{ type: 'card', text: 'A' }]), 's.json', TYPES).spec.elements).toHaveLength(1);
  });

  it('refuses bad JSON, no elements and a type the kit lacks, naming the spot', () => {
    expect(() => parseSpec('{', 's.json', TYPES)).toThrow(/s\.json is not valid JSON/);
    expect(() => parseSpec('{"elements":[]}', 's.json', TYPES)).toThrow(/holds no elements/);
    expect(() => parseSpec(JSON.stringify({ elements: [{ type: 'stack', items: [{ type: 'card' }, { type: 'mindmap' }] }] }), 's.json', TYPES))
      .toThrow(/elements\[0\]\.items\[1\] has type "mindmap", which the kit does not draw; `dreamcontext whiteboard kit`/);
    expect(() => parseSpec(JSON.stringify({ elements: [[{ type: 'card' }]] }), 's.json', TYPES)).toThrow(/elements\[0\] is not an element object/);
    // One item of a layout may be a list of elements, drawn as one block.
    expect(() => parseSpec(JSON.stringify({ elements: [{ type: 'row', items: [[{ type: 'card' }, { type: 'chip', text: 'x' }]] }] }), 's.json', TYPES)).not.toThrow();
  });

  it('collects every picture path, resolved, and refuses a picture with none', () => {
    const { pictures } = parseSpec(JSON.stringify({ elements: [{ type: 'panel', items: [{ type: 'image', path: 'docs/a.png' }, { type: 'image', path: 'docs/a.png' }] }] }), 's.json', TYPES);
    expect(pictures).toEqual([join(project, 'docs', 'a.png')]);
    expect(() => parseSpec(JSON.stringify({ elements: [{ type: 'image' }] }), 's.json', TYPES)).toThrow(/elements\[0\] is a picture with no "path"/);
  });
});

describe('buildSpecDrawing', () => {
  it('draws a flow, a panel and a title with the kit and reports a clean audit', () => {
    const r = buildSpecDrawing(JSON.stringify(FLOW_SPEC), 'flow.json');
    expect(r.audit).toEqual({ overlaps: 0, buriedText: 0, longLines: 0, wallOfText: 0 });
    const types = r.elements.map((e) => e.type);
    expect(types.filter((t) => t === 'arrow')).toHaveLength(2);
    expect(types).toContain('rectangle');
    expect(r.elements.filter((e) => e.type === 'text').map((e) => e.text)).toEqual(expect.arrayContaining(['Write', 'Batch', 'Server', 'Rules', '2 s']));
  });

  it('a panel holding one large child, or a panel inside a panel, is nesting, not an overlap', () => {
    // review-edge-cases 2026-10-21: both reported overlaps=1, sending an agent to "fix" a clean drawing.
    const one = buildSpecDrawing(JSON.stringify({ elements: [{ type: 'panel', items: [{ type: 'card', text: 'Clock' }] }] }), 's.json');
    expect(one.audit.overlaps).toBe(0);
    const shot = buildSpecDrawing(JSON.stringify({ elements: [{ type: 'panel', title: 'Shot', items: [{ type: 'image', path: SAMPLE_PNG, width: 300 }] }] }), 's.json');
    expect(shot.audit.overlaps).toBe(0);
    const nested = buildSpecDrawing(JSON.stringify({
      elements: [{ type: 'panel', title: 'Outer', items: [{ type: 'panel', title: 'Inner', items: [{ type: 'card', text: 'A', w: 120, h: 50 }, { type: 'card', text: 'B', w: 120, h: 50 }] }] }],
    }), 's.json');
    expect(nested.audit.overlaps).toBe(0);
    // Two panels side by side that DO collide are still caught: the exemption is containment only.
    const clash = buildSpecDrawing(JSON.stringify({ elements: [
      { type: 'panel', x: 0, y: 0, items: [{ type: 'card', text: 'A' }] },
      { type: 'panel', x: 150, y: 20, items: [{ type: 'card', text: 'B' }] },
    ] }), 's.json');
    expect(clash.audit.overlaps).toBeGreaterThan(0);
    // A box painted BEFORE a panel and wholly inside it is hidden under it: still a collision.
    const hidden = buildSpecDrawing(JSON.stringify({ elements: [
      { type: 'image', path: SAMPLE_PNG, x: 170, y: 45, width: 400, height: 180 },
      { type: 'panel', x: 0, y: 0, title: 'T', minW: 600, items: [{ type: 'card', text: 'X', w: 120, h: 160 }] },
    ] }), 's.json');
    expect(hidden.audit.overlaps).toBeGreaterThan(0);
  });

  it('a flow opens its gaps to its widest arrow label, so no label reaches a card', () => {
    // review-edge-cases 2026-10-21: a ~40-character label covered 66px of each neighbouring card.
    const r = buildSpecDrawing(JSON.stringify({ elements: [{ type: 'flow', steps: ['Write', { text: 'Send', label: 'every five minutes, three tries at most' }, 'Server'] }] }), 's.json');
    const cards = r.elements.filter((e) => e.type === 'rectangle');
    const label = r.elements.find((e) => e.type === 'text' && e.text === 'every five minutes, three tries at most')!;
    expect(cards).toHaveLength(3);
    const [lx0, lx1] = [label.x as number, (label.x as number) + (label.width as number)];
    for (const c of cards) {
      const [cx0, cx1] = [c.x as number, (c.x as number) + (c.width as number)];
      expect(lx1 <= cx0 || lx0 >= cx1, `label ${lx0}-${lx1} reaches card ${cx0}-${cx1}`).toBe(true);
    }
  });

  it('shows the picture check every path BEFORE the builder reads it', () => {
    const seen: string[] = [];
    expect(() => buildSpecDrawing(JSON.stringify({ elements: [{ type: 'image', path: 'nowhere.png' }] }), 's.json', {
      checkPicture: (p) => { seen.push(p); throw new Error('refused by the caller'); },
    })).toThrow(/refused by the caller/);
    expect(seen).toEqual([join(project, 'nowhere.png')]);
  });

  it('a picture given only a width is measured before the layout, so its caption sits under it', () => {
    const r = buildSpecDrawing(JSON.stringify({
      elements: [{ type: 'stack', gap: 10, items: [{ type: 'image', path: SAMPLE_PNG, width: 200 }, { type: 'chip', text: 'Caption' }] }],
    }), 's.json');
    const img = r.elements.find((e) => e.type === 'image')!;
    const chip = r.elements.find((e) => e.type === 'rectangle')!;
    expect(img.height as number).toBeGreaterThan(0);
    expect(chip.y as number).toBeGreaterThanOrEqual((img.y as number) + (img.height as number));
    expect(img.fileId).toBe(createHash('sha1').update(readFileSync(SAMPLE_PNG)).digest('hex'));
  });

  it('turns a builder failure into a refusal that names the kit, and leaves no temp folder', () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('dc-wb-spec-') && !n.startsWith('dc-wb-spec-cli') && !n.startsWith('dc-wb-spec-home')).length;
    expect(() => buildSpecDrawing(JSON.stringify({ elements: [{ type: 'connector', label: 'x' }] }), 'bad.json')).toThrow(/bad\.json did not build: .*`dreamcontext whiteboard kit`/);
    buildSpecDrawing(JSON.stringify(FLOW_SPEC), 'flow.json');
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('dc-wb-spec-') && !n.startsWith('dc-wb-spec-cli') && !n.startsWith('dc-wb-spec-home')).length;
    expect(after).toBe(before);
  });
});

describe('noteWarning and auditWarning', () => {
  it('lets a caption through and names a wall of text', () => {
    expect(noteWarning('**Push batch**: every 2 s, or at 50 ops.')).toBeNull();
    expect(noteWarning(['# Head', '- a', '- b', '- c', '- d'].join('\n'))).toBeNull();
    expect(noteWarning(['a', 'b', 'c', 'd', 'e', 'f'].join('\n'))).toMatch(/wall of text \(6 lines, 6 words\).*whiteboard kit/);
    expect(noteWarning(Array.from({ length: 46 }, (_, i) => `w${i}`).join(' '))).toMatch(/1 lines, 46 words/);
    // Markdown punctuation is not a word.
    expect(noteWarning(`${'- '.repeat(40)}one two`)).toBeNull();
  });

  it('is silent on a clean audit and names what to fix otherwise', () => {
    expect(auditWarning({ overlaps: 0, buriedText: 0, longLines: 0, wallOfText: 0 })).toBeNull();
    expect(auditWarning({ overlaps: 1, buriedText: 0, longLines: 2, wallOfText: 1 }))
      .toMatch(/1 overlapping box, 2 over-long lines, 1 wall of text\..*redraw it in place/);
  });
});

describe('the kit reference', () => {
  const REF = readKitReference();

  it('ships with the pack and its worked example draws clean', () => {
    expect(kitDir()).toBe(join(ROOT, 'skill-packs', 'excalidraw'));
    // Nearest first: a built CLI's own dist/skill-packs wins over a same-named folder further up.
    const pkg = mkdtempSync(join(tmpdir(), 'dc-wb-kitdir-'));
    try {
      for (const d of [join(pkg, 'dist', 'skill-packs', 'excalidraw', 'scripts'), join(pkg, 'skill-packs', 'excalidraw', 'scripts')]) {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'build_excalidraw.js'), '');
      }
      expect(kitDir(join(pkg, 'dist'))).toBe(join(pkg, 'dist', 'skill-packs', 'excalidraw'));
      expect(kitDir(join(pkg, 'nowhere', 'a', 'b', 'c'))).toBeNull();
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
    const example = /```json\n([\s\S]*?)\n```/.exec(REF)![1];
    expect(buildSpecDrawing(example, 'example.json').audit).toEqual({ overlaps: 0, buriedText: 0, longLines: 0, wallOfText: 0 });
  });

  it('names only types the builder draws, and the new flow and panel are among them', () => {
    expect(TYPES).toEqual(expect.arrayContaining(['flow', 'panel', 'stack', 'row', 'image', 'timeline', 'callout']));
    const table = REF.slice(REF.indexOf('## Pick the shape of the idea'), REF.indexOf('## Writing for a board'));
    const named = [...table.matchAll(/^\|[^|]*\|\s*([^|]*)\|/gm)].flatMap((m) => [...m[1].matchAll(/`([a-zA-Z]+)`/g)].map((x) => x[1]));
    expect(named.length).toBeGreaterThan(15);
    for (const t of named) expect(TYPES, `the kit reference names "${t}"`).toContain(t);
  });

  it('keeps the rules a board is read by', () => {
    expect(REF).toContain('**Explain or show something: draw it. A number: a live widget. A note: a caption.**');
    expect(REF).toContain('Never a stack of markdown notes.');
    expect(REF).toContain('Never a drawn `kpi`, chart or table of today\'s values');
  });
});

describe('whiteboard draw --spec / kit (CLI)', () => {
  it('draws a spec onto the board, tagged, with the audit in --json', async () => {
    writeFileSync(join(project, 'flow.json'), JSON.stringify(FLOW_SPEC));
    const r = await json(['whiteboard', 'draw', slug, '--spec', 'flow.json', '--tag', 'sync', '--at', '0,0']);
    expect(r.audit).toEqual({ overlaps: 0, buriedText: 0, longLines: 0, wallOfText: 0 });
    expect(r.bbox).toMatchObject({ x: 0, y: 0 });
    const live = readWhiteboard(root, slug).board.elements.filter((e) => r.ids.includes(e.id));
    expect(live).toHaveLength(r.ids.length);
    expect(live.every((e) => elementTag(e) === 'sync')).toBe(true);
    expect(live.some((e) => e.type === 'arrow')).toBe(true);
  });

  it('needs exactly one of --spec and --file', async () => {
    writeFileSync(join(project, 'flow.json'), JSON.stringify(FLOW_SPEC));
    for (const args of [[], ['--spec', 'flow.json', '--file', 'flow.json']]) {
      const r = await run(['whiteboard', 'draw', slug, ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/draw needs exactly one of --spec <spec\.json>/);
    }
  });

  it('a picture in the spec is stored beside the board under its own id', async () => {
    mkdirSync(join(project, 'docs'));
    copyFileSync(SAMPLE_PNG, join(project, 'docs', 'shot.png'));
    writeFileSync(join(project, 'shots.json'), JSON.stringify({ elements: [{ type: 'stack', items: [{ type: 'image', path: 'docs/shot.png', width: 240 }, { type: 'chip', text: 'Home' }] }] }));
    const r = await json(['whiteboard', 'draw', slug, '--spec', 'shots.json']);
    const id = createHash('sha1').update(readFileSync(SAMPLE_PNG)).digest('hex');
    expect(existsSync(join(root, 'whiteboards', slug, 'files', `${id}.png`))).toBe(true);
    const img = readWhiteboard(root, slug).board.elements.find((e) => r.ids.includes(e.id) && e.type === 'image')!;
    expect(img.fileId).toBe(id);
  });

  it('refuses a picture that is not one, and stores nothing', async () => {
    writeFileSync(join(project, 'fake.png'), 'not a picture');
    writeFileSync(join(project, 'fake.json'), JSON.stringify({ elements: [{ type: 'image', path: 'fake.png', width: 100 }] }));
    const r = await run(['whiteboard', 'draw', slug, '--spec', 'fake.json']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/'.*fake\.png' is not a PNG, JPEG, GIF or WebP picture/);
    expect(existsSync(join(root, 'whiteboards', slug, 'files'))).toBe(false);
  });

  it('prints the kit; --json lists every type', async () => {
    const plain = await run(['whiteboard', 'kit']);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain('# Drawing on a dreamcontext whiteboard');
    const j = await json(['whiteboard', 'kit']);
    expect(j.types).toEqual(TYPES);
    expect(j.reference).toBe(readKitReference());
  });

  it('a long note warns that a note is a caption; a short one does not', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const a = await run(['whiteboard', 'add', slug, 'note', '--text', long, '--json']);
    expect(a.code).toBe(0);
    expect(a.err).toMatch(/this note is a wall of text \(1 lines, 60 words\).*whiteboard draw <slug> --spec/);
    const b = await run(['whiteboard', 'add', slug, 'note', '--text', 'Push every 2 s.', '--json']);
    expect(b.err).toBe('');
    const u = await run(['whiteboard', 'update', slug, JSON.parse(b.out).id, '--text', long]);
    expect(u.code).toBe(0);
    expect(u.out).toMatch(/this note is a wall of text/);
  });
});

describe('a board agent reaches the kit through the CLI, inside its folders', () => {
  let scratch: string;
  let outputSelf: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'dc-board-'));
    outputSelf = join(root, 'automations', 'output', 'pano');
    mkdirSync(outputSelf, { recursive: true });
    vi.stubEnv(AGENT_BOARD_ENV, slug);
    vi.stubEnv(AGENT_SELF_ENV, 'pano');
    vi.stubEnv(AGENT_SCRATCH_ENV, scratch);
  });
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

  it('draws a spec from its output folder', async () => {
    writeFileSync(join(outputSelf, 'sync.json'), JSON.stringify(FLOW_SPEC));
    const r = await json(['whiteboard', 'draw', slug, '--spec', join('_dream_context', 'automations', 'output', 'pano', 'sync.json'), '--tag', 'sync']);
    expect(r.ids.length).toBeGreaterThan(10);
  });

  it('refuses a spec, or a picture a spec names, outside its folders', async () => {
    writeFileSync(join(project, 'loose.json'), JSON.stringify(FLOW_SPEC));
    const a = await run(['whiteboard', 'draw', slug, '--spec', 'loose.json']);
    expect(a.code).toBe(1);
    expect(a.err).toMatch(/--spec 'loose\.json' is outside the folders this agent may read from/);
    copyFileSync(SAMPLE_PNG, join(project, 'secret.png'));
    writeFileSync(join(scratch, 'pic.json'), JSON.stringify({ elements: [{ type: 'image', path: join(project, 'secret.png'), width: 100 }] }));
    const b = await run(['whiteboard', 'draw', slug, '--spec', join(scratch, 'pic.json')]);
    expect(b.code).toBe(1);
    expect(b.err).toMatch(/the picture '.*secret\.png' is outside the folders/);
    expect(readWhiteboard(root, slug).board.elements.filter((e) => e.isDeleted !== true)).toHaveLength(0);
    expect(existsSync(join(root, 'whiteboards', slug, 'files'))).toBe(false);
  });

  it('reads the kit', async () => {
    expect((await run(['whiteboard', 'kit'])).code).toBe(0);
  });
});
