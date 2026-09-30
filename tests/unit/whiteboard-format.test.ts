import { describe, it, expect } from 'vitest';
import { emptyWhiteboard, parseWhiteboard, serializeWhiteboard, type Whiteboard } from '../../src/lib/whiteboards/format.js';
import { makeWidgetElement, type WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';
import { WhiteboardCorruptError } from '../../src/lib/whiteboards/errors.js';
import { extractExcalidrawText } from '../../src/lib/excalidraw-text.js';
// The dashboard's own parser: src/ cannot import dashboard/src, but a test can.
import { extractExcalidrawScene } from '../../dashboard/src/lib/excalidraw.js';
import matter from 'gray-matter';

function textEl(id: string, text: string, index: string, extra: Partial<WhiteboardElement> = {}): WhiteboardElement {
  return {
    id, type: 'text', x: 0, y: 0, width: 100, height: 20, version: 1, versionNonce: 7, index,
    isDeleted: false, text, originalText: text, fontSize: 20, ...extra,
  };
}

function board(elements: WhiteboardElement[], name = 'Günlük'): Whiteboard {
  return { ...emptyWhiteboard(name, 'Şu anki iş: ığüşöç'), elements };
}

describe('whiteboard format', () => {
  it('round-trips a board, Turkish text and name kept verbatim', () => {
    const b = board([textEl('t1', 'Öğretmen fiyatı ığüşöç', 'a1'), textEl('t0', 'first', 'a0')]);
    const md = serializeWhiteboard(b);
    const back = parseWhiteboard(md);
    expect(back.frontmatter.name).toBe('Günlük');
    expect(back.frontmatter.description).toBe('Şu anki iş: ığüşöç');
    expect(back.frontmatter['dreamcontext-whiteboard']).toBe(1);
    expect(back.elements.map((e) => e.id)).toEqual(['t0', 't1']);
    expect(back.elements[1].text).toBe('Öğretmen fiyatı ığüşöç');
    // byte-deterministic: re-serializing the parsed board gives the same bytes
    expect(serializeWhiteboard(back)).toBe(md);
    // gray-matter (what the rest of the brain reads frontmatter with) agrees
    expect(matter(md).data.name).toBe('Günlük');
  });

  it('a name with YAML-hostile characters survives', () => {
    const name = 'a: b # c\n--- "quoted" \'single\' [x]';
    const back = parseWhiteboard(serializeWhiteboard(board([], name)));
    expect(back.frontmatter.name).toBe(name);
  });

  it('customData (a widget payload) survives the round-trip', () => {
    const w = makeWidgetElement('todo', { title: 'Bugün', items: [{ id: 'i1', text: 'süt al', done: true }], tag: 'daily' }, { x: 5, y: 6 }, 'a0');
    const back = parseWhiteboard(serializeWhiteboard(board([w])));
    expect(back.elements[0].customData).toEqual(w.customData);
    expect(back.elements[0].link).toBe(`dreamcontext://todo/${w.id}`);
  });

  it('serializes keys and elements deterministically regardless of input order', () => {
    const a = textEl('x', 'hi', 'a0');
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as WhiteboardElement;
    expect(serializeWhiteboard(board([a, textEl('y', 'yo', 'a1')]))).toBe(serializeWhiteboard(board([textEl('y', 'yo', 'a1'), reordered])));
  });

  it('the dashboard extractExcalidrawScene parses the output', () => {
    const md = serializeWhiteboard(board([textEl('t1', 'merhaba', 'a0')]));
    const scene = extractExcalidrawScene(md);
    expect(scene).not.toBeNull();
    expect(scene!.elements).toHaveLength(1);
    expect((scene!.elements[0] as { text: string }).text).toBe('merhaba');
  });

  it('a note whose markdown holds a code fence does not end the drawing block early', () => {
    const w = makeWidgetElement('note', { markdown: '```json\n{"a":1}\n```\n## Drawing\n```json\n' }, { x: 0, y: 0 }, 'a0');
    const md = serializeWhiteboard(board([w]));
    expect(parseWhiteboard(md).elements[0].customData).toEqual(w.customData);
    const scene = extractExcalidrawScene(md);
    expect((scene!.elements[0] as { customData: unknown }).customData).toEqual(w.customData);
  });

  it('extractExcalidrawText sees text labels and widget titles, not deleted ones', () => {
    const w = makeWidgetElement('note', { title: 'Haftalık not', markdown: 'body' }, { x: 0, y: 0 }, 'a2');
    const md = serializeWhiteboard(board([
      textEl('t1', 'Görünen etiket', 'a0'),
      textEl('t2', 'silinmiş', 'a1', { isDeleted: true }),
      w,
    ]));
    const body = matter(md).content;
    const text = extractExcalidrawText(body);
    expect(text).toContain('Görünen etiket');
    expect(text).toContain('Haftalık not');
    expect(text).not.toContain('silinmiş');
    expect(text).not.toContain('"elements"');
  });

  it('passes an Embedded Files section through byte-for-byte', () => {
    const md = serializeWhiteboard(board([textEl('t1', 'x', 'a0')]));
    const withFiles = md.replace('%%\n## Drawing', '## Embedded Files\nabc123: [[pic.png]]\n\n%%\n## Drawing');
    const parsed = parseWhiteboard(withFiles);
    expect(parsed.embeddedFiles).toBe('## Embedded Files\nabc123: [[pic.png]]\n\n');
    expect(serializeWhiteboard(parsed)).toBe(withFiles);
  });

  it('a text label shaped like the Embedded Files header is not mistaken for one', () => {
    const b = board([textEl('t1', '## Embedded Files', 'a0')]);
    const md = serializeWhiteboard(b);
    const parsed = parseWhiteboard(md);
    expect(parsed.embeddedFiles).toBeNull();
    expect(serializeWhiteboard(parsed)).toBe(md);
  });

  it('throws WhiteboardCorruptError on a missing block, bad JSON, non-array elements, compressed-json', () => {
    const good = serializeWhiteboard(board([]));
    expect(() => parseWhiteboard('---\nname: x\n---\nno drawing here')).toThrow(WhiteboardCorruptError);
    expect(() => parseWhiteboard(good.replace('"elements": []', '"elements": [,'))).toThrow(WhiteboardCorruptError);
    expect(() => parseWhiteboard(good.replace('"elements": []', '"elements": {}'))).toThrow(WhiteboardCorruptError);
    expect(() => parseWhiteboard(good.replace('```json', '```compressed-json'))).toThrow(/Decompress/);
  });
});
