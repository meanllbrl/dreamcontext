/**
 * The stage pictures a hands-free phone sees (task hands-free-phone-shows-every-picture…, D2):
 * the phone has no stage, so an image card the Super Agent opens reaches a phone mirror as one
 * `_meta`/`stage_media` frame, and the phone's protocol turns it into a `stage-media` event.
 *
 * Contract both halves pin: project-relative refs only (never absolute, never `..`), at most six,
 * the newest kept; a join `snapshot` says what the stage holds, not a new open.
 */
import { describe, it, expect } from 'vitest';
import { STAGE_MEDIA_MAX, stageImageItems, stageMediaFrame } from '../../src/lib/super/phone-mirror.js';
import { parseChatLine } from '../../dashboard/src/lib/chatProtocol.js';

describe('stageMediaFrame', () => {
  it('serialises project-relative image refs with their titles', () => {
    const frame = stageMediaFrame([{ ref: 'tmp/a.png', title: 'Before' }, { ref: 'docs/b.jpg' }]);
    expect(JSON.parse(frame!)).toEqual({
      type: '_meta', subtype: 'stage_media',
      items: [{ ref: 'tmp/a.png', title: 'Before' }, { ref: 'docs/b.jpg' }],
    });
  });

  it('drops absolute and parent-escaping refs, and sends nothing when none is left', () => {
    expect(stageMediaFrame([{ ref: '/etc/passwd.png' }, { ref: '../x.png' }, { ref: 'a/../../y.png' }])).toBeNull();
    expect(stageMediaFrame([])).toBeNull();
  });

  it('keeps the newest six', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ ref: `tmp/${i}.png` }));
    const sent = JSON.parse(stageMediaFrame(items)!).items as Array<{ ref: string }>;
    expect(sent).toHaveLength(STAGE_MEDIA_MAX);
    expect(sent[0].ref).toBe('tmp/3.png');
    expect(sent[5].ref).toBe('tmp/8.png');
  });

  it('marks a join snapshot', () => {
    expect(JSON.parse(stageMediaFrame([{ ref: 'a.png' }], true)!).snapshot).toBe(true);
  });
});

describe('stageImageItems', () => {
  it('lists the floating image cards only, oldest first', () => {
    const items = stageImageItems({
      containers: [
        { kind: 'image', ref: 'tmp/1.png', place: 'float', title: 'One' },
        { kind: 'web', ref: 'https://example.test', place: 'float' },
        { kind: 'image', ref: 'tmp/2.png', place: 'others' },
        { kind: 'image', ref: 'tmp/3.png', place: 'float' },
      ],
    });
    expect(items).toEqual([{ ref: 'tmp/1.png', title: 'One' }, { ref: 'tmp/3.png' }]);
  });
});

describe('the phone protocol arm', () => {
  it('turns a stage_media frame into a stage-media event', () => {
    const ev = parseChatLine(stageMediaFrame([{ ref: 'tmp/a.png', title: 'A' }])!);
    expect(ev).toEqual({ kind: 'stage-media', items: [{ ref: 'tmp/a.png', title: 'A' }], snapshot: false });
  });

  it('re-checks the refs it is handed (a frame is data, not trust)', () => {
    const line = JSON.stringify({
      type: '_meta', subtype: 'stage_media',
      items: [{ ref: '/abs.png' }, { ref: '../up.png' }, { ref: 'ok.png' }, 'junk', { ref: 7 }],
      snapshot: true,
    });
    expect(parseChatLine(line)).toEqual({ kind: 'stage-media', items: [{ ref: 'ok.png' }], snapshot: true });
  });

  it('ignores a frame with nothing drawable', () => {
    expect(parseChatLine(JSON.stringify({ type: '_meta', subtype: 'stage_media', items: [] }))?.kind).toBe('ignored');
  });
});
