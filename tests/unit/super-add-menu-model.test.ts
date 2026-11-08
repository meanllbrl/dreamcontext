/**
 * The stage's add menu, its pure half (task sahip-super-sahnesinde-…): what a pick asks the server
 * to open, which sentence a refusal reads as (never the server's English), and where the menu fits.
 */
import { describe, it, expect } from 'vitest';
import { MENU_EDGE, MENU_HEIGHT, MENU_WIDTH, clampMenu, knowledgeOpen, payloadToOpen, refusalKey } from '../../dashboard/src/components/sleepy/super/superAddMenuModel.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('payloadToOpen', () => {
  it('reads each picker\'s payload as an open', () => {
    expect(payloadToOpen({ v: 1, kind: 'web', url: 'https://pocket-ledger.example/', title: 'x' })).toEqual({ kind: 'web', ref: 'https://pocket-ledger.example/' });
    expect(payloadToOpen({ v: 1, kind: 'task', ref: 'ship-it', title: 'x' })).toEqual({ kind: 'task', ref: 'ship-it' });
    expect(payloadToOpen({ v: 1, kind: 'insight', ref: 'signups' })).toEqual({ kind: 'insight', ref: 'signups' });
    expect(payloadToOpen({ v: 1, kind: 'knowledge', ref: 'pricing' })).toEqual({ kind: 'knowledge', ref: 'pricing' });
  });

  it('never sends a title, and opens nothing it cannot name', () => {
    expect(payloadToOpen({ v: 1, kind: 'task', ref: 'a', title: 'T' })).not.toHaveProperty('title');
    expect(payloadToOpen({ v: 1, kind: 'web' })).toBeNull();
    expect(payloadToOpen({ v: 1, kind: 'task' })).toBeNull();
    expect(payloadToOpen({ v: 1, kind: 'note', markdown: 'x' })).toBeNull();
  });
});

describe('knowledgeOpen', () => {
  it('a slug goes as it is', () => {
    expect(knowledgeOpen('architecture/overview')).toEqual({ kind: 'knowledge', ref: 'architecture/overview' });
  });

  it('a page listed by its path opens by the slug the agent would name', () => {
    expect(knowledgeOpen('_dream_context/knowledge/archive/2.memory-2026-08.md')).toEqual({ kind: 'knowledge', ref: 'archive/2.memory-2026-08' });
  });

  it('a board kept in knowledge opens as its file', () => {
    const path = '_dream_context/knowledge/flows/share.excalidraw.md';
    expect(knowledgeOpen(path)).toEqual({ path });
  });
});

describe('refusalKey', () => {
  it.each([
    ['stage_full', 'super.add.full.stage'], ['record_full', 'super.add.full.record'],
    ['outside_project', 'super.add.file.outside_project'], ['unknown_file', 'super.add.file.unknown_file'],
    ['not_a_file', 'super.add.file.not_a_file'], ['unsupported_file', 'super.add.file.unsupported_file'],
    ['file_name_space', 'super.add.file.file_name_space'],
  ])('%s has its own sentence', (code, key) => { expect(refusalKey(code)).toBe(key); });

  it.each([['invalid_ref'], ['not_handed_over'], ['super_state_unreadable'], [undefined], [null], [500]])('%s reads as the one general line', (code) => {
    expect(refusalKey(code)).toBe('super.add.refused');
  });

  it('every sentence exists in English and in Turkish', () => {
    const strings = readFileSync(fileURLToPath(new URL('../../dashboard/src/context/I18nContext.tsx', import.meta.url)), 'utf-8');
    const trAt = strings.indexOf('const TR_PARTIAL');
    for (const code of ['stage_full', 'record_full', 'outside_project', 'unknown_file', 'not_a_file', 'unsupported_file', 'file_name_space', 'other']) {
      const row = `'${refusalKey(code)}':`;
      expect(strings.indexOf(row), row).toBeGreaterThan(-1);
      expect(strings.indexOf(row), row).toBeLessThan(trAt);
      expect(strings.indexOf(row, trAt), row).toBeGreaterThan(trAt);
    }
  });
});

describe('clampMenu', () => {
  const stage = { width: 1440, height: 900 };

  it('opens at the press when it fits', () => {
    expect(clampMenu({ x: 200, y: 100 }, stage)).toEqual({ left: 200, top: 100, width: MENU_WIDTH, maxHeight: MENU_HEIGHT });
  });

  it('stays inside at the right and bottom edges', () => {
    const p = clampMenu({ x: 1439, y: 899 }, stage);
    expect(p.left + p.width).toBe(stage.width - MENU_EDGE);
    expect(p.top + p.maxHeight).toBe(stage.height - MENU_EDGE);
  });

  it('never runs off a stage smaller than the menu', () => {
    const small = { width: 200, height: 240 };
    const p = clampMenu({ x: 150, y: 200 }, small);
    expect(p.left).toBe(MENU_EDGE);
    expect(p.top).toBe(MENU_EDGE);
    expect(p.left + p.width).toBeLessThanOrEqual(small.width - MENU_EDGE);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(small.height - MENU_EDGE);
  });
});
