/**
 * The Settings window of the new layout (task settings-konuya-gore-17-menuye…, wave 2): a
 * window over the app, 17 pages by topic in the owner's order, every deep link lands on its
 * page or tab, search reads names, hints and hidden keywords, and the page behind is never
 * navigated away from. Classic Settings is untouched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryWords, textMatches } from '../../dashboard/src/components/settings/settingsSearch.js';
import { SW_GROUPS, SW_PAGES, swTarget } from '../../dashboard/src/components/settings/window/sections.js';

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', rel), 'utf-8');
const shell = read('components/layout/Shell.tsx');
const win = read('components/settings/window/SettingsWindow.tsx');
const pages = read('components/settings/window/pages/SimplePages.tsx') + read('components/settings/window/pages/TopicPages.tsx') + read('components/settings/window/pages/AssistantPage.tsx') + read('components/settings/window/VoiceRows.tsx');
const i18n = read('context/I18nContext.tsx');

describe('the menu', () => {
  it('has exactly 17 pages, in the prototype order (Telegram after Hands-free, plan X2)', () => {
    expect(SW_PAGES).toEqual([
      'general', 'chat', 'voice',
      'models', 'mcp', 'super', 'assistant',
      'memory', 'sleep',
      'tasks', 'repos',
      'teamsync', 'mirror', 'connected', 'handsfree', 'telegram',
      'system',
    ]);
    expect(SW_GROUPS.map((g) => g.id)).toEqual(['top', 'agents', 'memory', 'project', 'connections', 'end']);
  });

  it('every page and group has an English and a Turkish name, and no em dash', () => {
    const keys = [
      ...SW_PAGES.flatMap((id) => [`shell.sw.page.${id}`, `shell.sw.page.${id}.d`]),
      ...SW_GROUPS.filter((g) => g.labelKey).map((g) => g.labelKey),
    ];
    for (const k of keys) {
      const lines = i18n.split('\n').filter((l) => l.includes(`'${k}':`));
      expect(lines.length, k).toBe(2);
      for (const l of lines) expect(l, k).not.toContain('—');
    }
  });

  it('holds no GitHub or ClickUp menu, Platforms, Default agent, Show Chat, Open sessions as, Terminal drawing or shortcut row', () => {
    expect(SW_PAGES).not.toContain('github');
    expect(SW_PAGES).not.toContain('clickup');
    for (const gone of ['platforms', 'defaultAgent', 'chatView', 'renderer:', 'settings.agents.platforms', 'settings.agents.default_agent', 'settings.agents.show', 'settings.agents.hotkey']) {
      expect(pages, gone).not.toContain(gone);
    }
  });
});

describe('deep links', () => {
  it('every focus id lands on its page or tab; unknown is General', () => {
    expect(swTarget('brain')).toEqual({ page: 'teamsync' });
    expect(swTarget('github')).toEqual({ page: 'teamsync' });
    expect(swTarget('teamsync')).toEqual({ page: 'teamsync' });
    expect(swTarget('system')).toEqual({ page: 'system' });
    expect(swTarget('mcp')).toEqual({ page: 'mcp' });
    expect(swTarget('models')).toEqual({ page: 'models', tab: 'defaults' });
    expect(swTarget('accounts')).toEqual({ page: 'models', tab: 'claude' });
    expect(swTarget('accounts-codex')).toEqual({ page: 'models', tab: 'codex' });
    expect(swTarget('voice')).toEqual({ page: 'voice' });
    expect(swTarget('nope')).toEqual({ page: 'general' });
    expect(swTarget(null)).toEqual({ page: 'general' });
  });

  it('navigate opens the window in the new shell and leaves the page, history, storage and chat alone', () => {
    const at = shell.indexOf('const navigate = useCallback(');
    const body = shell.slice(at, shell.indexOf('}, [bus, vault, newShell]);', at));
    const guard = body.indexOf("if (newShell && page === 'settings') {");
    expect(guard).toBeGreaterThan(0);
    const branch = body.slice(guard, body.indexOf('return;', guard));
    expect(branch).toContain('setSettingsWindow(');
    // Nothing that moves the page runs before the early return.
    expect(body.indexOf('setActivePage(page)')).toBeGreaterThan(guard);
    expect(body.indexOf("emitInstance(bus, 'dreamcontext-navigate'")).toBeGreaterThan(guard);
    expect(body.indexOf('writeScopedRaw(')).toBeGreaterThan(guard);
  });

  it('a remembered settings page opens the window once, then is remembered as the page behind', () => {
    expect(shell).toMatch(/if \(newShell && initial\.settings && readScopedRaw\(vault, ACTIVE_PAGE_STORAGE_KEY\) === 'settings'\) \{\s*writeScopedRaw\(vault, ACTIVE_PAGE_STORAGE_KEY, initial\.page\);/);
  });

  it('a stored or ?page=settings value lands on Tasks with the window open', () => {
    expect(shell).toMatch(/if \(newShell && page === 'settings'\) return \{ page: 'tasks', settings: true \};/);
  });

  it('the window renders only in the active project, portaled to body above the title bar', () => {
    expect(shell).toMatch(/\{isActive && settingsWindow && \(\s*<SettingsWindow open focus=\{settingsWindow\} onClose=\{closeSettingsWindow\} \/>/);
    expect(win).toMatch(/createPortal\(/);
    expect(win).toMatch(/document\.body,\s*\);/);
    const css = read('components/settings/window/SettingsWindow.css');
    expect(css).toMatch(/\.sw \{[^}]*z-index: 70;/);
    // Tokens only: the window follows the theme.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('keys', () => {
  it('Esc: an inner picker first, then the query, then the window', () => {
    const at = win.indexOf("if (e.key === 'Escape') {");
    const esc = win.slice(at, win.indexOf('return;\n      }', at));
    expect(esc.indexOf(".sw-popover, [data-sw-modal], .sw .ss-pop")).toBeGreaterThan(0);
    expect(esc).toMatch(/el\?\.closest\('\.sw \[data-sw-esc\]'\)\) return;/);
    expect(esc.indexOf("if (query) { setQuery(''); return; }")).toBeGreaterThan(esc.indexOf('.sw-popover'));
    expect(esc.indexOf('onClose();')).toBeGreaterThan(esc.indexOf('setQuery('));
  });

  it('fields that own Esc (name edit, wake key, talk key) are marked and stop the key themselves', () => {
    const assistantSrc = read('components/settings/window/pages/AssistantPage.tsx');
    const voiceSrc = read('components/settings/window/VoiceRows.tsx');
    expect(assistantSrc.match(/data-sw-esc/g)?.length).toBe(2);
    expect(voiceSrc.match(/data-sw-esc/g)?.length).toBe(1);
    expect(voiceSrc).toMatch(/if \(e\.key === 'Escape'\) \{ e\.stopPropagation\(\);/);
    expect(assistantSrc.match(/if \(e\.key === 'Escape'\) \{ e\.stopPropagation\(\);/g)?.length).toBe(2);
  });

  it('focus: Tab stays inside, the window is focusable, and closing gives focus back', () => {
    expect(win).toMatch(/if \(e\.key === 'Tab'\) \{ trapTab\(e\); return; \}/);
    expect(win).toMatch(/ref=\{winRef\} tabIndex=\{-1\} role="dialog" aria-modal="true"/);
    expect(win).toMatch(/if \(before\?\.isConnected\) before\.focus\(\{ preventScroll: true \}\);/);
    expect(win).toMatch(/if \(!win \|\| at\?\.closest\('\.sw-popover'\)\) return;/);
  });

  it('the chat surface and the palette step aside while it is open', () => {
    expect(win).toMatch(/document\.body\.dataset\.settingsWindow = 'open';/);
    const surface = read('components/sleepy/AgentSurface.tsx');
    expect(surface.match(/if \(document\.body\.dataset\.settingsWindow\) return;/g)?.length).toBe(2);
    expect(shell.match(/if \(document\.body\.dataset\.settingsWindow\) return;/g)?.length).toBe(2);
  });
});

describe('search', () => {
  it('matches every word of the query, any case, anywhere in the text', () => {
    expect(queryWords('  Super   MODEL ')).toEqual(['super', 'model']);
    expect(textMatches('Super Agent model, Opus at high', queryWords('model super'))).toBe(true);
    expect(textMatches('Super Agent', queryWords('super model'))).toBe(false);
  });

  it('finds a row by its hidden keywords as well as its title and hint', () => {
    // No DOM in this suite: the row text the filter reads is checked at its source.
    const src = read('components/settings/settingsSearch.ts');
    expect(src).toMatch(/\.setting-row-title'\)\?\.textContent \?\? ''\} \$\{row\.querySelector\('\.setting-row-hint'\)\?\.textContent \?\? ''\} \$\{row\.getAttribute\('data-search-k'\) \?\? ''\}/);
    expect(textMatches('Model and effort The same choice as in Models. specialist helper model effort sleep', queryWords('specialist'))).toBe(true);
    expect(textMatches('Switch near a limit limit threshold', queryWords('limit'))).toBe(true);
  });

  it('a hit jumps to its page and its Models tab', () => {
    expect(win).toMatch(/row\.closest<HTMLElement>\('\[data-tab\]'\)\?\.dataset\.tab/);
    expect(win).toMatch(/if \(groupTab\) setTab\(groupTab\);/);
    expect(read('components/settings/SettingRow.tsx')).toMatch(/data-search-k=\{keywords\}/);
  });

  it('a page with no rows (Tasks, Code repos, Connected projects) still counts its matching blocks', () => {
    expect(win).toMatch(/if \(!block\.hasAttribute\(HIDDEN\) && !block\.querySelector\('\.setting-row'\)\) n\+\+;/);
  });

  it('paints once over the whole body, after every page was filtered (one highlight entry)', () => {
    expect(win.match(/applySettingsSearch\(sec, query, \{ paint: false \}\);/g)?.length).toBe(2);
    expect(win.match(/paintSettingsSearch\(root, query\);/g)?.length).toBe(2);
    const src = read('components/settings/settingsSearch.ts');
    expect(src).toMatch(/if \(draw\) paint\(root, words\);/);
    expect(src).toMatch(/export function paintSettingsSearch\(root: HTMLElement, query: string\): void/);
  });

  it('paints matches with the Highlight API, never by rewriting markup', () => {
    const src = read('components/settings/settingsSearch.ts');
    expect(src).toMatch(/new HighlightCtor\(\.\.\.ranges\)/);
    expect(src).not.toMatch(/innerHTML|dangerouslySetInnerHTML/);
  });
});

describe('the window styles', () => {
  const css = read('components/settings/window/SettingsWindow.css');
  it('draw from tokens: no raw colour, radius or font size', () => {
    expect(css).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/border-radius: [1-9]\d*px/);
    expect(css).not.toMatch(/font-size: \d+px/);
  });
  it('narrow: the menu strip never widens the column, and a control pair wraps', () => {
    expect(css).toMatch(/grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.sw-side \{\n    min-width: 0;/);
    expect(css).toMatch(/\.sw \.setting-row-control \{\n    flex-wrap: wrap;/);
  });
  it('a wrapper that already holds a group is no second card', () => {
    expect(css).toMatch(/\.sw \.settings-self-update:has\(> \.setting-group\) \{/);
  });
});
