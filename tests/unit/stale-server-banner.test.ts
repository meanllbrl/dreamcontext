// r14: the window chrome's stale-server banner said "the dashboard server is running an OLDER
// build (0.30.1 vs 0.30.0)" when the server (0.30.1) was NEWER than this window's page (0.30.0,
// loaded before a rebuild). The banner now compares the two: server newer -> reload this page.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const src = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'layout', 'WindowChrome.tsx'), 'utf8');
// The helper is self-contained by design; evaluate exactly its source (WindowChrome itself pulls
// in the desktop bridge, which a node test cannot load).
const fnSrc = /export function compareVersions\([\s\S]*?\n\}\n/.exec(src)?.[0];
if (!fnSrc) throw new Error('compareVersions not found in WindowChrome.tsx');
const js = ts.transpileModule(fnSrc.replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const compareVersions = new Function(`${js}\nreturn compareVersions;`)() as (a: unknown, b: unknown) => -1 | 0 | 1 | null;

describe('stale-server banner: which side is older', () => {
  it('compares dotted versions; unparsable is null (today\'s text)', () => {
    expect(compareVersions('0.30.1', '0.30.0')).toBe(1); // server newer: this page is the old one
    expect(compareVersions('0.30.0', '0.30.1')).toBe(-1); // server older: today's text
    expect(compareVersions('0.30.0', '0.30.0')).toBe(0);
    expect(compareVersions('0.31.0', '0.30.9')).toBe(1);
    expect(compareVersions('1.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.30.1-beta.1', '0.30.0')).toBe(1);
    expect(compareVersions(undefined, '0.30.0')).toBeNull();
    expect(compareVersions('unknown', '0.30.0')).toBeNull();
  });

  it('a newer server renders the reload-this-page text, an older one keeps today\'s text', () => {
    const fn = src.slice(src.indexOf('function StaleServerBanner()'), src.indexOf('/* ──', src.indexOf('function StaleServerBanner()')));
    expect(fn).toMatch(/compareVersions\(health\.version, __DC_VERSION__\) === 1\)[\s\S]*staleServer\.olderPage/);
    expect(fn).toContain('The dashboard server is running an older build');
    const i18n = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'context', 'I18nContext.tsx'), 'utf8');
    expect(i18n).toContain("'staleServer.olderPage': 'This window is running an older page ({page}) than the dashboard server ({server}). Reload it with Cmd+R.',");
    expect(i18n).toMatch(/'staleServer\.olderPage': 'Bu pencere/);
    expect(i18n).not.toMatch(/'(handsfree\.banner\.other|handsfree\.button\.elsewhere|staleServer)[^']*': '[^']*—/); // no em dashes
  });
});
