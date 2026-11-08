/**
 * The drawing-intent line (owner, 2026-11-07: the `draw` skill is loaded "tam olarak doğru
 * zamanda"). Precision first: a line on every "drawer bug" prompt would teach the agent to skip it.
 */
import { describe, expect, it } from 'vitest';
import { detectDrawIntent, drawDirective, excalidrawHandWriteRefusal, type DrawTarget } from '../../src/lib/draw-intent.js';
import { CLAUDE_ONLY } from '../../src/lib/tool-text.js';

const ROWS: Array<[string, DrawTarget | null]> = [
  // Whiteboard, EN + TR
  ['tahtaya akışı çiz', 'whiteboard'],
  ["whiteboard'a mimariyi anlat", 'whiteboard'],
  ["MRR'ı kontrol paneline çiz", 'whiteboard'],
  ['kontrol paneline sync akışını çiz', 'whiteboard'],
  ['draw the onboarding flow on the whiteboard', 'whiteboard'],
  ['put a diagram of the release on the control panel', 'whiteboard'],
  ['tahtada mimariyi göster', 'whiteboard'],
  ['whiteboard', 'whiteboard'],
  // A file, EN + TR
  ['bir excalidraw diyagramı yap', 'file'],
  ['make an excalidraw diagram of the sync engine', 'file'],
  ['excalidraw çiz', 'file'],
  ['update boards/flow.excalidraw.md with the new step', 'file'],
  ['draw the architecture and save it', 'file'],
  ['mimariyi çiz ve kaydet', 'file'],
  ['akış şemasını dosyaya çiz', 'file'],
  ['add a knowledge diagram of recall', 'file'],
  // Anything (in the Chat view, maybe an inline sketch)
  ['sync akışını çiz', 'any'],
  ['make a wireframe of the login screen', 'any'],
  ['draw the sync flow', 'any'],
  ['sketch the settings page', 'any'],
  ['bir flowchart hazırla', 'any'],
  ['iphone mockup of the paywall', 'any'],
  ['grafik çiz: aylık gelir', 'any'],
  ['draw a bar chart of signups', 'any'],
  ['bu süreci diyagram olarak göster', 'any'],
  ['ödeme akış şeması', 'any'],
  ['çizim yap', 'any'],
  ['ekranı çizer misin', 'any'],
  // Silent
  ['withdraw the PR', null],
  ['drawer bileşeni bozuk', null],
  ['the drawer does not close on mobile', null],
  ['günlük ürün panosu oluştur', null],
  ['fix the chart color bug in Lab', null],
  ["Sema'ya mail at", null],
  ['çizelgeyi güncelle', null],
  ['Lab board needs a new card', null],
  ['grafiği göster', null],
  ['tahta kalemi al', null],
  ['', null],
  ['   ', null],
  ['run npm test and report failures', null],
  ['open the whiteboards feature PRD', 'whiteboard'],
];

describe('detectDrawIntent', () => {
  it(`classifies ${ROWS.length} EN and TR prompts`, () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(40);
    for (const [prompt, target] of ROWS) {
      expect(detectDrawIntent(prompt)?.target ?? null, prompt).toBe(target);
    }
  });

  it("a project's board slug makes it a whiteboard drawing, matched as plain words", () => {
    expect(detectDrawIntent('draw the funnel on gunluk', ['gunluk'])?.target).toBe('whiteboard');
    expect(detectDrawIntent('release-plan için akışı çiz', ['release-plan'])?.target).toBe('whiteboard');
    expect(detectDrawIntent('draw the release flow', ['release-plan'])?.target).toBe('any');
    // A slug never compiles into a pattern: regex characters are plain text and cannot widen a match.
    expect(detectDrawIntent('draw the flow', ['.*'])?.target).toBe('any');
    // A slug alone is not a drawing request.
    expect(detectDrawIntent('open gunluk', ['gunluk'])).toBeNull();
  });
});

describe('drawDirective', () => {
  it('names draw; a whiteboard adds the kit', () => {
    expect(drawDirective('any', { chatView: false, tool: null })).toBe('Drawing request: load the `draw` skill (Skill tool) before you draw.');
    expect(drawDirective('whiteboard', { chatView: false, tool: null })).toContain('Then run `dreamcontext whiteboard kit`.');
  });

  it('in the Chat view a plain drawing may be a dc-graph; a kept one is draw', () => {
    const any = drawDirective('any', { chatView: true, tool: null });
    expect(any).toContain('dream-html dc-graph');
    expect(any).toContain('load the `draw` skill (Skill tool) first');
    expect(drawDirective('whiteboard', { chatView: true, tool: null })).not.toContain('dc-graph');
    expect(drawDirective('file', { chatView: true, tool: null })).not.toContain('dc-graph');
  });

  it('Codex and Antigravity get no Claude tool names', () => {
    for (const tool of ['codex', 'antigravity'] as const) {
      for (const target of ['any', 'whiteboard', 'file'] as const) {
        for (const chatView of [false, true]) {
          const line = drawDirective(target, { chatView, tool });
          expect(line).toContain('`draw`');
          expect(CLAUDE_ONLY.test(line), line).toBe(false);
        }
      }
    }
  });
});

describe('excalidrawHandWriteRefusal (Gate 1e)', () => {
  const scene = '---\nexcalidraw-plugin: parsed\n---\n%%\n## Drawing\n```json\n{"type": "excalidraw", "version": 2, "elements": [{"type": "rectangle", "x": 0}]}\n```\n%%';
  it('refuses scene JSON written by hand into an Excalidraw file, naming draw', () => {
    const r = excalidrawHandWriteRefusal('Write', { file_path: '/p/boards/x.excalidraw.md', content: scene });
    expect(r).toContain('`draw` skill');
    expect(excalidrawHandWriteRefusal('Write', { file_path: '/p/x.excalidraw', content: '{"elements": [{"type": "ellipse"}]}' })).not.toBeNull();
    expect(excalidrawHandWriteRefusal('MultiEdit', {
      file_path: '/p/x.excalidraw.md',
      edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: '"elements": [ {"type": "arrow"} ]' }],
    })).not.toBeNull();
  });

  it('lets frontmatter and text edits, other files and other tools pass', () => {
    expect(excalidrawHandWriteRefusal('Edit', { file_path: '/p/x.excalidraw.md', old_string: 'tags: [a]', new_string: 'tags: [a, b]' })).toBeNull();
    expect(excalidrawHandWriteRefusal('Edit', { file_path: '/p/x.excalidraw.md', old_string: 'Old label ^abc', new_string: 'New label ^abc' })).toBeNull();
    expect(excalidrawHandWriteRefusal('Write', { file_path: '/p/notes.md', content: scene })).toBeNull();
    expect(excalidrawHandWriteRefusal('Bash', { command: `cat > x.excalidraw.md <<'EOF'\n${scene}\nEOF` })).toBeNull();
    expect(excalidrawHandWriteRefusal('Write', { file_path: '/p/x.excalidraw.md' })).toBeNull();
    expect(excalidrawHandWriteRefusal('Write', {})).toBeNull();
  });
});
