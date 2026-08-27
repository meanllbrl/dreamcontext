/**
 * Unit tests for the peer-identity layer added with vault logos:
 *
 * - `mentionSegments` (dashboard/src/lib/agentComposer.ts) — feeds the composer's mention
 *   highlight mirror. The mirror paints a pill under every token that names a KNOWN peer;
 *   a wrong split here paints the pill over the wrong characters, which reads as a broken
 *   editor, so the boundary rules are pinned: token-boundary `@` only (an email's `@` is
 *   glued to the previous character), known names only, case-insensitive.
 *
 * - `peerForAgent` (same module) — maps a run's `subagent_type` (`peer-<slug>`) back to the
 *   connected peer, which is what lets an envoy run wear the peer vault's logo and name.
 *
 * - `findVaultLogo` (src/lib/vault-logo.ts) — the `assets/logo.*` file convention. The
 *   candidate ORDER is part of the contract (png preferred over svg), and a vault without
 *   a logo must answer null, never throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mentionSegments,
  peerForAgent,
  type PeerMention,
} from '../../dashboard/src/lib/agentComposer.js';
import { findVaultLogo } from '../../src/lib/vault-logo.js';

const PEERS: PeerMention[] = [
  { vault: 'Tilki', agent: 'peer-tilki', whatItIs: 'B2B SaaS for tutors', logo: true },
  { vault: 'marketing-brain', agent: 'peer-marketing-brain', whatItIs: '', logo: false },
];

describe('mentionSegments', () => {
  it('a draft without mentions is one plain segment', () => {
    expect(mentionSegments('just a message', PEERS)).toEqual([
      { text: 'just a message', mention: false },
    ]);
  });

  it('with no peers there is nothing to highlight, whatever the text says', () => {
    expect(mentionSegments('@Tilki hello', [])).toEqual([
      { text: '@Tilki hello', mention: false },
    ]);
  });

  it('a leading mention splits off as its own highlighted segment', () => {
    expect(mentionSegments('@Tilki videoları üret', PEERS)).toEqual([
      { text: '@Tilki', mention: true },
      { text: ' videoları üret', mention: false },
    ]);
  });

  it('a mid-sentence mention highlights in place', () => {
    expect(mentionSegments('bunu @marketing-brain yapabilir', PEERS)).toEqual([
      { text: 'bunu ', mention: false },
      { text: '@marketing-brain', mention: true },
      { text: ' yapabilir', mention: false },
    ]);
  });

  it('matching is case-insensitive and covers the envoy agent name too', () => {
    expect(mentionSegments('@tilki lütfen', PEERS)[0]).toEqual({ text: '@tilki', mention: true });
    expect(mentionSegments('@peer-tilki lütfen', PEERS)[0]).toEqual({ text: '@peer-tilki', mention: true });
  });

  it('an unknown token stays plain — the pill only ever names a real peer', () => {
    expect(mentionSegments('@nobody knows', PEERS)).toEqual([
      { text: '@nobody knows', mention: false },
    ]);
  });

  it("an email address's @ is glued to the previous character and never lights up", () => {
    expect(mentionSegments('mail me at mehmet@Tilki thanks', PEERS)).toEqual([
      { text: 'mail me at mehmet@Tilki thanks', mention: false },
    ]);
  });

  it('several mentions each get their own segment', () => {
    const segs = mentionSegments('@Tilki and @marketing-brain both', PEERS);
    expect(segs.filter((s) => s.mention).map((s) => s.text)).toEqual([
      '@Tilki',
      '@marketing-brain',
    ]);
  });
});

describe('peerForAgent', () => {
  it('maps a `peer-<slug>` subagent type to its peer, case-insensitively', () => {
    expect(peerForAgent('peer-tilki', PEERS)?.vault).toBe('Tilki');
    expect(peerForAgent('Peer-Tilki', PEERS)?.vault).toBe('Tilki');
  });

  it('a non-envoy agent type maps to nothing', () => {
    expect(peerForAgent('general-purpose', PEERS)).toBeNull();
    expect(peerForAgent(null, PEERS)).toBeNull();
    expect(peerForAgent(undefined, PEERS)).toBeNull();
  });
});

describe('findVaultLogo', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vault-logo-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a vault without assets/ (or without a logo in it) answers null, never throws', () => {
    expect(findVaultLogo(root)).toBeNull();
    mkdirSync(join(root, 'assets'));
    expect(findVaultLogo(root)).toBeNull();
  });

  it('finds assets/logo.png with its mime type and a cache-busting mtime', () => {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'logo.png'), 'png-bytes');
    const logo = findVaultLogo(root);
    expect(logo?.path).toBe(join(root, 'assets', 'logo.png'));
    expect(logo?.mime).toBe('image/png');
    expect(logo?.mtimeMs).toBeGreaterThan(0);
  });

  it('prefers raster over svg when both exist (candidate order is the contract)', () => {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'logo.svg'), '<svg/>');
    writeFileSync(join(root, 'assets', 'logo.png'), 'png-bytes');
    expect(findVaultLogo(root)?.mime).toBe('image/png');
  });

  it('serves svg when it is all the vault has', () => {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'logo.svg'), '<svg/>');
    expect(findVaultLogo(root)?.mime).toBe('image/svg+xml');
  });
});
