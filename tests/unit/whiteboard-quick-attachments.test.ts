import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  dropName, QuickAttachmentRefusal, QUICK_IMAGE_BYTES, QUICK_TEXT_FILE_BYTES, quickTurnLine, readQuickAttachments,
} from '../../src/lib/whiteboards/quick-attachments.js';
import { parseQuickEditAnswer, quickEditArgs, readAnswer, resultLine } from '../../src/lib/whiteboards/quick-edit.js';
import { boardAttachConv, dropCarried, quickAttachmentPaths, superMessageWith } from '../../dashboard/src/components/whiteboard/boardAttachments.js';
import { addAttachments, readScratch } from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { composeFieldMessage } from '../../dashboard/src/components/whiteboard/superFieldLogic.js';
import { PAGE_CONTEXT_RE } from '../../dashboard/src/lib/superTypes.js';
import type { Attachment } from '../../dashboard/src/components/sleepy/chat/composerScratch.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000108020000007b40e8dd', 'hex');
let project: string;
let root: string;
let drops: string;
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-qa-')));
  root = join(project, '_dream_context');
  drops = join(root, 'tmp', 'agent-drops');
  mkdirSync(drops, { recursive: true });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const put = (name: string, bytes: Buffer | string, dir = drops) => { const p = join(dir, name); writeFileSync(p, bytes); return p; };
const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { return e as QuickAttachmentRefusal; } throw new Error('not refused'); };

describe('quick edit attachments: what is read', () => {
  it('a picture and a text file in the drop folder are read, named without the time prefix', () => {
    const a = readQuickAttachments(root, [put('1731400000000-ekran.png', PNG), put('1731400000001-notlar.md', '# Plan\nbir')]);
    expect(a.map((x) => [x.kind, x.name])).toEqual([['image', 'ekran.png'], ['text', 'notlar.md']]);
    expect(a[1].text).toBe('# Plan\nbir');
    expect(dropName('/x/1731400000000-a b.png')).toBe('a b.png');
  });

  it('only the drop folder: a file elsewhere in the project, a symlink in the folder, a missing file are refused', () => {
    const inProject = put('secret.txt', 'TOKEN=1', project);
    expect(refusal(() => readQuickAttachments(root, [inProject])).why).toBe('gone');
    symlinkSync(inProject, join(drops, 'link.txt'));
    expect(refusal(() => readQuickAttachments(root, [join(drops, 'link.txt')])).why).toBe('gone');
    expect(refusal(() => readQuickAttachments(root, [join(drops, 'nope.png')])).why).toBe('gone');
    expect(refusal(() => readQuickAttachments(root, ['relative.png'])).why).toBe('gone');
    expect(refusal(() => readQuickAttachments(root, [join(drops, '..', 'x.txt')])).why).toBe('gone');
  });

  it('bounded: a picture past its bytes, a text file past its bytes, a binary file, too many files', () => {
    expect(refusal(() => readQuickAttachments(root, [put('big.png', Buffer.concat([PNG, Buffer.alloc(QUICK_IMAGE_BYTES)]))])).why).toBe('too_big');
    expect(refusal(() => readQuickAttachments(root, [put('big.txt', 'a'.repeat(QUICK_TEXT_FILE_BYTES + 1))])).why).toBe('too_big');
    expect(refusal(() => readQuickAttachments(root, [put('x.bin', Buffer.from([0xff, 0xfe, 0x00, 0x01]))])).why).toBe('type');
    expect(refusal(() => readQuickAttachments(root, Array(7).fill(put('a.txt', 'a')))).why).toBe('too_big');
  });
});

describe('quick edit attachments: the turn', () => {
  it('pictures are image blocks, numbered in the text; a file sits in its owner-file fence', () => {
    const atts = readQuickAttachments(root, [put('1-a.png', PNG), put('2-b.txt', 'satır')]);
    const line = JSON.parse(quickTurnLine('Request from the owner: çiz', atts, 'n0nce'));
    expect(line.type).toBe('user');
    const [text, image] = line.message.content;
    expect(text.text).toContain('picture 1 = 1-a.png');
    expect(text.text).toContain('<owner-file-n0nce name="2-b.txt">\nsatır\n</owner-file-n0nce>');
    expect(image).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
  });

  it('the argv reads the turn from stdin as stream-json; the result is the last stream line', () => {
    const args = quickEditArgs('S', 'U', undefined, { stdin: true });
    expect(args.slice(0, 4)).toEqual(['-p', '--input-format', 'stream-json', '--verbose']);
    expect(args).not.toContain('U');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { reply: 'ok', notBoard: false, pictures: [1] }, total_cost_usd: 0.01 });
    const out = [JSON.stringify({ type: 'system' }), JSON.stringify({ type: 'assistant' }), result].join('\n');
    expect(resultLine(out)).toBe(result);
    const parsed = parseQuickEditAnswer(out);
    expect(parsed.ok && parsed.answer.pictures).toEqual([1]);
    expect(readAnswer({ reply: 'x', notBoard: false, pictures: [0] })).toBeNull();
  });
});

describe('the board composer: what each mode sends', () => {
  // Ids as the Chat store mints them (`att-N`): the token id is read from the trailing number.
  let n = 0;
  const att = (over: Partial<Attachment>): Attachment => ({ id: `att-${++n}`, kind: 'image', name: 'shot.png', path: '/v/_dream_context/tmp/agent-drops/1-shot.png', ...over });

  it('quick edit sends the uploaded paths, never one still uploading or refused', () => {
    expect(quickAttachmentPaths([att({}), att({ path: undefined, uploading: true }), att({ failed: true, path: undefined }), att({ kind: 'file', name: 'a.txt', path: '/v/a.txt' })]))
      .toEqual(['/v/_dream_context/tmp/agent-drops/1-shot.png', '/v/a.txt']);
    expect(boardAttachConv('b1')).toBe('board-field:b1');
  });

  it('review r1: a send takes off exactly the chips that went; one dropped meanwhile, or refused, stays', () => {
    const conv = boardAttachConv('carry');
    const went = att({});
    const later = att({ name: 'later.png', path: '/v/_dream_context/tmp/agent-drops/2-later.png' });
    const refused = att({ failed: true, path: undefined });
    addAttachments(conv, [went, refused]);
    const carried = readScratch(conv).attachments.slice();
    addAttachments(conv, [later]);
    dropCarried(conv, carried);
    expect(readScratch(conv).attachments.map((x) => x.id).sort()).toEqual([later.id, refused.id].sort());
  });

  it('Ask Super: the Chat message lines, between the words and the page line the Super reads last', () => {
    const words = superMessageWith('bunun mockup\'ını yap', [att({}), att({ kind: 'file', name: 'my notes.txt', path: '/v/my notes.txt' })]);
    expect(words).toBe("bunun mockup'ını yap\n\n[Picture 1: /v/_dream_context/tmp/agent-drops/1-shot.png]\n\n'/v/my notes.txt'");
    const msg = composeFieldMessage(words, 'pano', null, [0, 0, 100, 100])!;
    expect(msg).toMatch(PAGE_CONTEXT_RE);
    expect(msg.indexOf('[Picture 1:')).toBeLessThan(msg.indexOf('[On page'));
    expect(superMessageWith('yalnız söz', [])).toBe('yalnız söz');
  });
});
