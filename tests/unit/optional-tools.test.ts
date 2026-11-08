/**
 * Settings → System → "Optional tools" (owner 2026-11-03): Codex and Antigravity are not
 * dependencies. Missing, signed out or outdated is a gray dot with a neutral button; nothing in
 * the card is ever drawn in an error or warning tone, and the Claude rows above stay as they were.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountSummary, optionalToolModel, primaryAccount } from '../../dashboard/src/lib/optionalTools.js';
import type { AgentToolInfo, ToolAccountWire } from '../../dashboard/src/hooks/useAgentCapabilities.js';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const info = (tool: 'codex' | 'antigravity', o: Partial<AgentToolInfo> = {}): AgentToolInfo => ({
  tool, label: tool, ready: true, installed: true, signedIn: true, defaultModel: null, models: [], ...o,
});

describe('optionalToolModel', () => {
  it('Codex missing: gray "not installed" + Install (codex-install), no account row', () => {
    const m = optionalToolModel('codex', info('codex', { installed: false, signedIn: false, ready: false }));
    expect(m.install).toEqual({ tone: 'muted', statusKey: 'settings.optional.notInstalled', action: { fix: 'codex-install', labelKey: 'settings.optional.install' } });
    expect(m.account).toBeNull();
  });

  it('a tool the server did not list reads as not installed, still gray', () => {
    expect(optionalToolModel('antigravity', undefined).install.action?.fix).toBe('antigravity-install');
    expect(optionalToolModel('antigravity', undefined).install.tone).toBe('muted');
  });

  it('signed out: gray "not signed in" + Sign in with the tool\'s own sign-in fix', () => {
    expect(optionalToolModel('antigravity', info('antigravity', { signedIn: false })).account)
      .toEqual({ tone: 'muted', statusKey: 'settings.optional.signedOut', action: { fix: 'antigravity-signin', labelKey: 'settings.optional.signIn' } });
    expect(optionalToolModel('codex', info('codex', { signedIn: false })).account?.action?.fix).toBe('codex-signin');
  });

  it('outdated Codex: gray with Update (codex-update)', () => {
    const m = optionalToolModel('codex', info('codex', { outdated: true }));
    expect(m.install.tone).toBe('muted');
    expect(m.install.action?.fix).toBe('codex-update');
  });

  it('installed and signed in: green, no button', () => {
    const m = optionalToolModel('codex', info('codex'));
    expect(m.install).toMatchObject({ tone: 'ok', action: null });
    expect(m.account).toMatchObject({ tone: 'ok', action: null });
  });

  it('only ever draws the two quiet tones', () => {
    const states: Array<Partial<AgentToolInfo> | undefined> = [
      undefined, { installed: false }, { signedIn: false }, { outdated: true }, { ready: false }, {},
    ];
    for (const tool of ['codex', 'antigravity'] as const) {
      for (const s of states) {
        const m = optionalToolModel(tool, s ? info(tool, s) : undefined);
        for (const row of [m.install, m.account]) if (row) expect(['ok', 'muted']).toContain(row.tone);
      }
    }
  });
});

describe('accountSummary', () => {
  const t = (k: string) => (k === 'settings.optional.quotaUnread' ? 'quota unread' : k);
  const acc = (o: Partial<ToolAccountWire>): ToolAccountWire => ({
    id: 'a', tool: 'codex', email: 'pat@example.test', planType: 'plus', isPrimary: true, preferred: false,
    state: 'ok', limits: [], fetchedAtMs: null, windows: [], ...o,
  });

  it('Codex: who, plan and its windows', () => {
    expect(accountSummary('codex', acc({ windows: [{ id: 'w', kind: 'session', label: '5h', usedPercent: 40.6 }] }), t))
      .toBe('pat@example.test · plus · 5h %41');
  });

  it('Antigravity: says its quota cannot be read here', () => {
    expect(accountSummary('antigravity', acc({ tool: 'antigravity', planType: '' }), t)).toBe('pat@example.test · quota unread');
  });

  it('picks the primary account', () => {
    expect(primaryAccount([acc({ id: 'x', isPrimary: false }), acc({ id: 'y', isPrimary: true })])?.id).toBe('y');
  });
});

describe('the card', () => {
  const card = read('dashboard/src/components/settings/OptionalTools.tsx');
  const css = read('dashboard/src/components/settings/SystemDependencies.css');
  const optionalCss = css.slice(css.indexOf('Optional tools (Codex, Antigravity)'));

  it('never reaches for an error or warning tone or icon', () => {
    expect(card).not.toMatch(/--warn|--error|--warning|sysdep-error|sysdep-status--missing|btn--primary|Warning|Alert/);
    expect(optionalCss).not.toMatch(/error|warning|#f87171|#fbbf24/);
    // The default sysdep dot is red; every optional dot names its own tone.
    expect(card.match(/className=\{`sysdep-dot /g)?.length).toBe(2);
  });

  it('sits under the required card on the System page; the Claude rows are untouched', () => {
    const page = read('dashboard/src/components/settings/window/pages/SimplePages.tsx');
    expect(page.indexOf('<OptionalTools />')).toBeGreaterThan(page.indexOf('<SystemDependencies />'));
    const deps = read('dashboard/src/components/settings/SystemDependencies.tsx');
    expect(deps).not.toMatch(/codex|antigravity/i);
  });

  it('ships the Turkish copy without the word "bağımlılık"', () => {
    const i18n = read('dashboard/src/context/I18nContext.tsx');
    expect(i18n).toContain("'settings.system.optionalTools': 'İsteğe bağlı araçlar'");
    const tr = i18n.split('\n').filter((l) => l.includes("'settings.optional") || l.includes("'settings.system.optionalTools"));
    expect(tr.join('\n')).not.toMatch(/bağımlılık|dependenc/i);
  });
});
