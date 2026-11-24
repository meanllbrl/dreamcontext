/**
 * The sidebar's one-open-project rule (wb-sol-panel, owner 2026-11-22, option A): Chat and
 * Whiteboards keep only the project on screen open; a folded header enters its project, the open
 * one only folds. Pure rules here; source pins guard the wiring a pure test cannot reach.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openProjects } from '../../dashboard/src/components/layout/newshell/drawerModel';

const src = (p: string) => readFileSync(join(__dirname, '../../dashboard/src', p), 'utf8');

describe('openProjects', () => {
  it('opens the project on screen (or the one being prepared) alone', () => {
    expect(openProjects('acme', null)).toEqual(['acme']);
  });
  it('keeps the owner\'s fold of that project', () => {
    expect(openProjects('acme', 'acme')).toEqual([]);
  });
  it('a fold of another project does not fold this one (a move lands open)', () => {
    expect(openProjects('globex', 'acme')).toEqual(['globex']);
  });
  it('nothing on screen yet: nothing open', () => {
    expect(openProjects(null, null)).toEqual([]);
  });
});

describe('wiring (source pins)', () => {
  const chrome = src('components/layout/WindowChrome.tsx');
  const drawer = src('components/layout/newshell/ChatDrawer.tsx');
  it('the desktop sidebar gets the enter press; a device shell does not', () => {
    expect(chrome).toContain('{...(deviceShell ? {} : { onEnterProject: enterProject })}');
  });
  it('the accordion covers Whiteboards only (Chat keeps independent folds, owner 2026-11-24), never a device shell or the projects mode', () => {
    expect(drawer).toContain("const accordion = !!sb && !p.device && !!p.onEnterProject && mode === 'boards';");
  });
  it('Chat keeps the fold arrow on every project row (owner 2026-11-24)', () => {
    expect(drawer).toContain("{(accordion || (!!sb && !p.device && mode === 'chat')) && <Chevron open={row.expanded} />}");
  });
  it('the open project\'s header only folds; a folded one is entered', () => {
    expect(drawer).toContain('else p.onToggleExpanded(row.name);');
    expect(drawer).toContain('p.onEnterProject?.(row.name);');
  });
  it('the desktop open set is derived from the move, never written before it lands', () => {
    expect(chrome).toContain('accordionShell ? openProjects(openTarget, foldedVault) : drawerExpanded');
    expect(chrome).toContain('const openTarget = preparing?.vault ?? activeVault;');
  });
});
