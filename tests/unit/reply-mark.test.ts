/**
 * The Super Agent's reply mark (owner 2026-10-23): the first line of a text block may name the
 * owner messages it answers, `<!-- re:k3f9q0 -->`. The window parses it while the block streams
 * (nothing drawn while the head may still become a mark), every other reader strips it. Pinned:
 * 1-3 refs, 4 is not a mark, the streaming rule, the notch cue never mistaken for one (and vice
 * versa), the server's copy, and the chat registry's last line.
 */
import { describe, it, expect } from 'vitest';
import * as server from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import { splitReplyMark, stripReplyMark } from '../../dashboard/src/lib/replyMark.js';
import { splitNotchCue } from '../../dashboard/src/lib/notchCue.js';

describe('splitReplyMark', () => {
  it('one ref, then the body', () => {
    expect(splitReplyMark('<!-- re:k3f9q0 -->\nThe login page is fixed.')).toEqual({ refs: ['k3f9q0'], body: 'The login page is fixed.', pending: false });
    expect(splitReplyMark('  <!--re:k3f9q0-->Done.')).toEqual({ refs: ['k3f9q0'], body: 'Done.', pending: false });
  });

  it('up to three refs; four is not a mark', () => {
    expect(splitReplyMark('<!-- re:k3f9q0 a1b2c3 -->\nBoth done.').refs).toEqual(['k3f9q0', 'a1b2c3']);
    expect(splitReplyMark('<!-- re: k3f9q0  a1b2c3 zz00zz -->\nAll three.').refs).toEqual(['k3f9q0', 'a1b2c3', 'zz00zz']);
    const four = '<!-- re:k3f9q0 a1b2c3 zz00zz 999999 -->\nFour.';
    expect(splitReplyMark(four)).toEqual({ refs: [], body: four, pending: false });
  });

  it('a malformed ref is not a mark', () => {
    for (const t of ['<!-- re:K3F9Q0 -->\nx', '<!-- re:k3f9 -->\nx', '<!-- re: -->\nx', '<!-- re:k3f9q0x -->\nx']) {
      expect(splitReplyMark(t)).toEqual({ refs: [], body: t, pending: false });
    }
  });

  it('streaming: pending while the head may still become a mark, nothing drawn', () => {
    for (const head of ['', ' ', '<', '<!', '<!-', '<!--', '<!-- ', '<!-- r', '<!-- re', '<!-- re:', '<!-- re:k3', '<!-- re:k3f9q0', '<!-- re:k3f9q0 ', '<!-- re:k3f9q0 -', '<!-- re:k3f9q0 --']) {
      expect(splitReplyMark(head)).toEqual({ refs: [], body: '', pending: true });
    }
  });

  it('three deltas end as the body and its ref', () => {
    let raw = '';
    const seen: string[] = [];
    for (const d of ['<!-- r', 'e:k3f9', 'q0 -->\nHello']) {
      raw += d;
      seen.push(splitReplyMark(raw).body);
    }
    expect(seen).toEqual(['', '', 'Hello']);
    expect(splitReplyMark(raw).refs).toEqual(['k3f9q0']);
  });

  it('plain text as soon as it cannot be a mark, and past the head limit', () => {
    expect(splitReplyMark('Hello')).toEqual({ refs: [], body: 'Hello', pending: false });
    expect(splitReplyMark('<b>bold</b>').pending).toBe(false);
    expect(splitReplyMark('<!-- note to self').pending).toBe(false);
    const long = `<!-- re:${'k3f9q0 '.repeat(9)}`;
    expect(long.length).toBeGreaterThan(client.REPLY_MARK_HEAD_MAX);
    expect(splitReplyMark(long)).toEqual({ refs: [], body: long, pending: false });
  });

  it('a notch cue is never a mark, and a mark never a notch cue', () => {
    const cue = '<!-- notch:present -->\nThe answer.';
    expect(splitReplyMark(cue)).toEqual({ refs: [], body: cue, pending: false });
    expect(splitReplyMark('<!-- no').pending).toBe(false);
    const mark = '<!-- re:k3f9q0 -->\nThe answer.';
    expect(splitNotchCue(mark)).toEqual({ cue: null, body: mark, pending: false });
    expect(splitNotchCue('<!-- re').pending).toBe(false);
  });

  it('strip for draw-only surfaces (the replay): the body, and anything else untouched', () => {
    expect(stripReplyMark('<!-- re:k3f9q0 -->\nHi')).toBe('Hi');
    expect(stripReplyMark('Hi <!-- re:k3f9q0 -->')).toBe('Hi <!-- re:k3f9q0 -->');
    expect(stripReplyMark('<!-- notch:present -->\nHi')).toBe('<!-- notch:present -->\nHi');
  });
});

describe('the server copy', () => {
  it('the same regex and head limit (mirror)', () => {
    expect(String(client.REPLY_MARK_RE)).toBe(String(server.REPLY_MARK_RE));
    expect(client.REPLY_MARK_HEAD_MAX).toBe(server.REPLY_MARK_HEAD_MAX);
    expect(String(client.REPLY_TO_RE)).toBe(String(server.REPLY_TO_RE));
    expect(client.MAX_REPLY_QUOTE).toBe(server.MAX_REPLY_QUOTE);
  });

  it('strips exactly what the window strips', () => {
    for (const t of ['<!-- re:k3f9q0 -->\nHi', '<!-- re:k3f9q0 a1b2c3 -->Hi', 'Hi', '<!-- notch:progress -->\nHi', '<!-- re:k3f9q0 a1b2c3 zz00zz 999999 -->\nHi']) {
      expect(server.stripReplyMark(t)).toBe(stripReplyMark(t));
    }
  });
});
