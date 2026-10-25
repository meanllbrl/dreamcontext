/**
 * The measured case of 2026-10-24, as a SYNTHETIC fixture (fictional project "orbit", fictional
 * words; pattern synthetic-fixtures): the owner wrote the Super three messages, the 2nd and 3rd
 * steered into the running turn with an agenda "About" header, and the Super answered all three
 * in ONE text block, a line-start mark per section. 0.34.5 unioned the marks into one "To 3
 * messages" strip above the tool rows. Now the block is ONE group, no strip, three sections each
 * aimed at its own message (task super-in-tek-cevabi…, AC9).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscriptHistory } from '../../src/lib/transcript-history.js';
import { msgRef } from '../../src/lib/super/types.js';
import { historyChatItem, type ChatItem } from '../../dashboard/src/components/sleepy/chatSession.js';
import { splitReplyMark } from '../../dashboard/src/lib/replyMark.js';
import { replyGroups } from '../../dashboard/src/components/sleepy/chat/replyLinks.js';
import { splitAbout } from '../../dashboard/src/components/sleepy/super/superHandover.js';

const RAW = readFileSync(join(new URL('../fixtures/super-reply-sections/', import.meta.url).pathname, 'transcript.jsonl'), 'utf-8');

/** The replay path of a Super view (chatSession's toChatItem): marks out, refs and sections in. */
function replay(): ChatItem[] {
  return parseTranscriptHistory(RAW).flatMap((h, i) => {
    const it = historyChatItem(h, `hist-${i}`);
    if (!it) return [];
    if (it.kind !== 'text') return [it];
    const split = splitReplyMark(it.text);
    return [{ ...it, text: split.body, ...(split.refs.length ? { replyTo: split.refs } : {}), ...(split.sections.length ? { replySections: split.sections } : {}) }];
  });
}

describe('the measured three-message reply (synthetic fixture)', () => {
  const items = replay();
  const owners = items.filter((it) => it.kind === 'user');
  const answer = items.find((it) => it.kind === 'text')!;

  it('has the measured shape: 1 turn message + 2 steered About messages, tool rows, one answer with 3 marks', () => {
    expect(owners).toHaveLength(3);
    expect(owners.slice(1).map((o) => splitAbout((o as { text: string }).text).about?.kind)).toEqual(['note', 'note']);
    expect(items.filter((it) => it.kind === 'tool')).toHaveLength(5);
    // Each owner message's block names the ref of his words (what the server writes).
    for (const o of ['Is the Orbit checkout form', 'which one did we land on?', 'is staging up yet?']) {
      const own = owners.find((x) => (x as { text: string }).text.includes(o)) as { text: string };
      expect(RAW).toContain(`<owner-msg ref=\\"${msgRef(own.text)}\\"/>`);
    }
    expect(RAW.match(/<!-- re:[0-9a-z]{6} -->/g)).toHaveLength(3);
  });

  it('one group, no strip, three sections aimed at the three messages in order; no mark in the body', () => {
    const m = replyGroups(items);
    const g = m.get(answer.id)!;
    expect(g).toMatchObject({ strip: false, targets: owners.map((o) => o.id) });
    expect(g.sections?.map((s) => s.targets)).toEqual(owners.map((o) => [o.id]));
    expect(new Set([...m.values()].map((x) => x.groupId))).toEqual(new Set([g.groupId]));
    expect([...m.values()].some((x) => x.strip)).toBe(false);
    const body = (answer as { text: string }).text;
    expect(body).not.toContain('<!--');
    expect(g.sections?.map((s) => body.slice(s.at, s.at + 14))).toEqual(['The checkout f', 'We landed on I', 'Staging is dep']);
  });
});
