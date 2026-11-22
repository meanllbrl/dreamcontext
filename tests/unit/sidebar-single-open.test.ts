/**
 * The sidebar's one-open-project rule (wb-sol-panel, owner 2026-11-22, option A): Chat and
 * Whiteboards keep only the project on screen open; a folded header enters its project, the open
 * one only folds. Pure rules here; source pins guard the wiring a pure test cannot reach.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { landsOnChats, mountedChats, openProjects } from '../../dashboard/src/components/layout/newshell/drawerModel';

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

describe('a Chat header press: last chat, else Super Agent', () => {
  it('a project mounted here answers from its live chats', () => {
    expect(mountedChats({ chats: [] })).toBe(false);
    expect(mountedChats({ chats: [{ windowId: 'main' } as never] })).toBe(true);
  });
  it('a mounted project with windows only: any window with a tab', () => {
    expect(mountedChats({ windows: [{ tabs: 0 } as never] })).toBe(false);
    expect(mountedChats({ windows: [{ tabs: 0 } as never, { tabs: 2 } as never] })).toBe(true);
  });
  it('any other project is read on the press, never from the background reads', () => {
    expect(mountedChats(undefined)).toBeNull();
  });
  it('the press read decides: 0 → Super Agent, more → last chat, a failed read → the plain move', () => {
    expect(landsOnChats(0)).toBe(false);
    expect(landsOnChats(3)).toBe(true);
    expect(landsOnChats(null)).toBe(true);
    expect(landsOnChats(undefined)).toBe(true);
  });
});

describe('wiring (source pins)', () => {
  const chrome = src('components/layout/WindowChrome.tsx');
  const drawer = src('components/layout/newshell/ChatDrawer.tsx');
  it('the desktop sidebar gets the enter press; a device shell does not', () => {
    expect(chrome).toContain('{...(deviceShell ? {} : { onEnterProject: enterProject })}');
  });
  it('the accordion covers Chat and Whiteboards only, never a device shell or the projects mode', () => {
    expect(drawer).toContain("const accordion = !!sb && !p.device && !!p.onEnterProject && (mode === 'chat' || mode === 'boards');");
  });
  it('the open project\'s header only folds; a folded one is entered', () => {
    expect(drawer).toContain('else p.onToggleExpanded(row.name);');
    expect(drawer).toContain('p.onEnterProject?.(row.name);');
  });
  it('the desktop open set is derived from the move, never written before it lands', () => {
    expect(chrome).toContain('accordionShell ? openProjects(openTarget, foldedVault) : drawerExpanded');
    expect(chrome).toContain('const openTarget = preparing?.vault ?? activeVault;');
  });
  it('the press reads the project itself, not the fan-out', () => {
    expect(chrome).toContain('const live = mountedChats(drawerFacts[name]);');
    expect(chrome).toContain('void readChatCount(name).then((tabs) => {');
    expect(chrome).not.toMatch(/mountedChats\([^)]*fanout/);
  });
  it('a header press landing on the Super Agent hands over quietly (no hand-over turn queued)', () => {
    expect(chrome).toContain("else void trackedIntent(name, { kind: 'super', quiet: true });");
    expect(src('components/sleepy/AgentSurface.tsx')).toContain('await handOver(intent.quiet ? { quiet: true } : undefined);');
  });
});
