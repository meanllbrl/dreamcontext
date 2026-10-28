import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIT_MAX_SETTLE_FRAMES, loadWhiteboardPictures, missingPictureIds, planFit, whiteboardSlugOf, type FitBox,
} from '../../dashboard/src/lib/boardFit.js';

const box = (width: number, height: number, left = 476, top = 227): FitBox => ({ width, height, left, top });
const record = (width: number, height: number, offsetLeft = 476, offsetTop = 227) => ({ width, height, offsetLeft, offsetTop });
const read = (p: string) => readFileSync(join(__dirname, '../../dashboard/src', p), 'utf-8');

// Owner 2026-10-28: a whiteboard presented on the Super stage drew as a tiny cluster in the
// card's top-left corner, and did again after he went to another page and came back.
describe('planFit — a board fits the box it really sits in', () => {
  it('never fits a hidden box (another page): a fit to 0x0 is the smallest zoom', () => {
    expect(planFit(box(1097, 340), box(0, 0), record(1097, 340), 3)).toEqual({ kind: 'hidden' });
    expect(planFit(null, box(1097, 0), record(1097, 340), 0)).toEqual({ kind: 'hidden' });
  });

  it('looks twice before it trusts a box: the first frame only samples', () => {
    expect(planFit(null, box(1097, 340), record(1097, 340), 0)).toEqual({ kind: 'settling' });
  });

  it('waits while the box still moves under a stage flight (scale transform)', () => {
    // The flight's start scale (0.28), then on its way to 1.
    expect(planFit(box(307, 95), box(700, 217), record(307, 95), 5)).toEqual({ kind: 'settling' });
  });

  it('page switch: Excalidraw kept the 307x95 it measured mid-flight → it gets the settled box, then fits', () => {
    const settled = box(1097, 340);
    expect(planFit(settled, settled, record(307, 95, 860, 330), 9)).toEqual({
      kind: 'fit', resize: { width: 1097, height: 340, offsetLeft: 476, offsetTop: 227 },
    });
  });

  it('resize / layout change (float → presented): a box that changed size refits against the new size', () => {
    expect(planFit(box(1097, 709), box(1097, 709), record(340, 340), 2)).toEqual({
      kind: 'fit', resize: { width: 1097, height: 709, offsetLeft: 476, offsetTop: 227 },
    });
  });

  it('a record that already matches only fits (no state write, so no fit loop)', () => {
    expect(planFit(box(1097, 340), box(1097.2, 340), record(1097, 340), 1)).toEqual({ kind: 'fit', resize: null });
  });

  it('a box that never stops moving still fits after the cap, against what it is now', () => {
    expect(planFit(box(500, 200), box(510, 205), record(500, 200), FIT_MAX_SETTLE_FRAMES).kind).toBe('fit');
  });
});

describe('a whiteboard card loads its own pictures and widgets', () => {
  const scene = (elements: unknown[], files: Record<string, unknown> = {}) =>
    `---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n\n## Drawing\n\`\`\`json\n${JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: {}, files })}\n\`\`\`\n%%\n`;

  it('names a whiteboard by its board path, and nothing else', () => {
    expect(whiteboardSlugOf('_dream_context/whiteboards/pano-demo/pano-demo.excalidraw.md')).toBe('pano-demo');
    expect(whiteboardSlugOf('./_dream_context/whiteboards/a-b/a-b.excalidraw.md')).toBe('a-b');
    // A plain Obsidian board keeps the `## Embedded Files` route.
    expect(whiteboardSlugOf('_dream_context/knowledge/flow.excalidraw.md')).toBeNull();
    expect(whiteboardSlugOf('_dream_context/whiteboards/a/b.excalidraw.md')).toBeNull();
    expect(whiteboardSlugOf('_dream_context/whiteboards/../x/x.excalidraw.md')).toBeNull();
  });

  it('asks for every live picture the scene does not carry, once', () => {
    const els = [
      { type: 'image', fileId: 'f1' }, { type: 'image', fileId: 'f1' }, { type: 'image', fileId: 'f2', isDeleted: true },
      { type: 'image', fileId: 'f3' }, { type: 'rectangle' }, { type: 'embeddable', link: 'dreamcontext://widget/x' },
    ];
    expect(missingPictureIds(els, { f3: { dataURL: 'data:' } })).toEqual(['f1']);
  });

  it('fetches them from the board\'s own files route and keeps the ones that arrive', async () => {
    const asked: string[] = [];
    const files = await loadWhiteboardPictures(
      scene([{ type: 'image', fileId: 'aa' }, { type: 'image', fileId: 'bb' }]),
      async (id) => {
        asked.push(id);
        if (id === 'bb') throw Object.assign(new Error('gone'), { status: 404 });
        return { id, mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==' };
      },
    );
    expect(asked.sort()).toEqual(['aa', 'bb']);
    expect(files).toEqual({ aa: { mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==' } });
  });

  it('the card wires it: a whiteboard path loads pictures by id and draws with the widget renderer', () => {
    const embed = read('components/sleepy/chat/BoardEmbed.tsx');
    expect(embed).toMatch(/loadWhiteboardPictures\(content, \(id\) => downloadBoardPicture\(slug, vault, id\)\)/);
    // Both the card and its full screen pass the whiteboard flag down.
    expect(embed.match(/whiteboard=\{whiteboard\}/g)?.length).toBe(2);
    const preview = read('components/core/ExcalidrawPreview.tsx');
    expect(preview).toMatch(/whiteboard \? WhiteboardReadCanvas : ExcalidrawCanvas/);
    const reader = read('components/whiteboard/WhiteboardReadCanvas.tsx');
    expect(reader).toMatch(/validateEmbeddable: isWidgetLink/);
    // Never active: an active note/todo/wiki/HTML card opens an editor whose save the read-only
    // host drops (reviewer 2026-10-28), so no widget here may become editable.
    expect(reader).toMatch(/<WidgetSlot \{\.\.\.widgetSlotProps\(element, false\)\} \/>/);
    expect(reader).not.toMatch(/activeEmbeddable/);
  });

  it('the stage card gives the board its whole body, not the transcript card\'s 340px strip', () => {
    const css = read('components/sleepy/super/SuperSurface.css');
    // The large card's body is a block: the view takes its height, as a PDF or a clip does.
    expect(css).toMatch(/\.super-card-view--board \{ height: 100%; \}/);
    expect(css).toMatch(/\.super-card-view--board > \.chat-board > \.chat-board-canvas \{[^}]*flex: 1 1 auto;[^}]*height: auto;/);
    expect(css).toMatch(/\.super-card-view--board > \.chat-board \{[^}]*display: flex;[^}]*flex-direction: column;/);
  });

  it('the canvas fits through planFit on every trigger', () => {
    const canvas = read('components/core/ExcalidrawCanvas.tsx');
    expect(canvas).toMatch(/const plan = planFit\(prev, now, record, frames\)/);
    expect(canvas).toMatch(/ro = new ResizeObserver\(\(\) => fit\(\)\)/);
  });
});
