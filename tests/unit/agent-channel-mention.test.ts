/**
 * Unit tests for `#agents`' own `@` rule (dashboard/src/lib/agentChannelMention.ts).
 *
 * Why it exists as its own module with its own test: the channel now mounts the CHAT's
 * composer, so the picker, the keyboard handling and the token rewrite are the chat's. What
 * stayed behind is the only part that is a fact about this channel — WHO a draft addresses,
 * and what the agent is actually sent — and it is the part that decides whether a headless run
 * starts at all. It is also the part the extraction could most easily have changed silently,
 * since the component it came out of has been deleted.
 *
 * The gate must be narrow in two specific directions:
 *   • a prefix must not resolve to a longer slug WHILE IT IS BEING TYPED, or `@daily` would
 *     start `daily-insight-digest` a keystroke before the user finished choosing;
 *   • the address must not survive into the prompt, or the agent reads its own slug as the
 *     first word of the instruction.
 */
import { describe, it, expect } from 'vitest';
import {
  mentionOf, mentionedIn, withoutMention, type ComposerAgent,
} from '../../dashboard/src/lib/agentChannelMention.js';

const AGENTS: ComposerAgent[] = [
  { slug: 'digest', title: 'Daily insight digest', hasPhoto: true },
  { slug: 'daily-insight-digest', title: 'The long one', hasPhoto: false },
  { slug: 'watcher', title: 'Paywall watcher', hasPhoto: false },
];

describe('mentionOf', () => {
  it('is the slug, never the title — a title has spaces and no end', () => {
    expect(mentionOf({ slug: 'digest' })).toBe('@digest');
  });
});

describe('mentionedIn', () => {
  it('resolves a leading address', () => {
    expect(mentionedIn('@digest only the paywall numbers', AGENTS)?.slug).toBe('digest');
  });

  it('resolves a MID-SENTENCE address too — unlike the chat, which would not', () => {
    // `addressedPeer` (the chat's rule) is leading-only, because there the local agent is the
    // default listener. Here there is no default listener at all: every message in this
    // channel is a message to one of these agents.
    expect(mentionedIn('please @watcher have a look at this', AGENTS)?.slug).toBe('watcher');
  });

  it('resolves an address at the very end, with no trailing space', () => {
    expect(mentionedIn('have a look @watcher', AGENTS)?.slug).toBe('watcher');
  });

  it('a draft that names nobody resolves to nobody', () => {
    expect(mentionedIn('somebody look at the paywall numbers', AGENTS)).toBeNull();
  });

  it('an unknown handle is not an address', () => {
    expect(mentionedIn('@nobody look at this', AGENTS)).toBeNull();
  });

  it('a PREFIX of a longer slug does not resolve to it mid-type', () => {
    // The whole reason the match is anchored at word boundaries: `@daily` is a user three
    // keystrokes into `@daily-insight-digest`, not a request to run it.
    expect(mentionedIn('@daily', AGENTS)).toBeNull();
    expect(mentionedIn('@daily numbers please', AGENTS)).toBeNull();
  });

  it('…and the longer slug still resolves to itself', () => {
    expect(mentionedIn('@daily-insight-digest go', AGENTS)?.slug).toBe('daily-insight-digest');
  });

  it('an email address is not an address', () => {
    expect(mentionedIn('mail kerem@digest.com about it', AGENTS)).toBeNull();
  });

  it('two mentions pick ONE — the first in the roster, never two runs', () => {
    const hit = mentionedIn('@digest and @watcher both', AGENTS);
    expect(hit?.slug).toBe('digest');
  });

  it('an empty roster addresses nobody', () => {
    expect(mentionedIn('@digest hello', [])).toBeNull();
  });
});

describe('withoutMention', () => {
  it('strips the address so the agent does not read its own slug as the instruction', () => {
    expect(withoutMention('@digest only the paywall numbers', AGENTS[0]))
      .toBe('only the paywall numbers');
  });

  it('strips a mid-sentence address and closes the gap it left', () => {
    expect(withoutMention('please @watcher have a look', AGENTS[2]))
      .toBe('please have a look');
  });

  it('collapses the whitespace a strip leaves behind, including newlines', () => {
    expect(withoutMention('@digest\n\n  the numbers   please', AGENTS[0]))
      .toBe('the numbers please');
  });

  it('an address with nothing after it leaves an EMPTY body — the caller must refuse it', () => {
    // A bare `@agent` is someone mid-sentence. The host reads this empty string as "not a
    // question yet" and puts the draft back rather than starting a run with an empty prompt.
    expect(withoutMention('@digest', AGENTS[0])).toBe('');
    expect(withoutMention('@digest   ', AGENTS[0])).toBe('');
  });

  it('leaves the rest of the sentence byte-identical apart from the address', () => {
    expect(withoutMention('@watcher check "the paywall" — twice', AGENTS[2]))
      .toBe('check "the paywall" — twice');
  });
});
