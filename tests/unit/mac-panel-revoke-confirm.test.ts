/**
 * "Sign all out" in the Mac panel cuts a turn a phone is running: it is asked first, in the
 * dashboard's own dialog (`confirmAction`, never `window.confirm`, a silent no-op in the
 * app's WKWebView: pattern a-button-in-the-desktop-app-does-nothing-when-clicked), with
 * copy in both languages.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', 'dashboard', 'src');
const PANEL = readFileSync(join(ROOT, 'components', 'handsfree', 'MacPanel.tsx'), 'utf-8');
const I18N = readFileSync(join(ROOT, 'context', 'I18nContext.tsx'), 'utf-8');

function revokeAllBody(): string {
  const start = PANEL.indexOf('const revokeAll = async () => {');
  expect(start).toBeGreaterThan(-1);
  const end = PANEL.indexOf('\n  };', start);
  return PANEL.slice(start, end);
}

describe('Mac panel: Sign all out asks first', () => {
  it('awaits the in-app confirmation and posts the revoke only after a yes', () => {
    const body = revokeAllBody();
    const ask = body.indexOf('await confirmAction(');
    const bail = body.indexOf('if (!ok) return;');
    const post = body.indexOf("act('revoke', 'post', 'devices/revoke-all')");
    expect(ask).toBeGreaterThan(-1);
    expect(bail).toBeGreaterThan(ask);
    expect(post).toBeGreaterThan(bail);
    expect(body).toContain('destructive: true');
    expect(PANEL).toContain("import { confirmAction } from '../../lib/desktop';");
    expect(PANEL).not.toMatch(/window\.confirm|\bconfirm\(/);
  });

  it('its title and body exist in English and Turkish', () => {
    for (const key of ['handsfree.mac.revokeAllConfirmTitle', 'handsfree.mac.revokeAllConfirmBody']) {
      expect(I18N.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g'))?.length, key).toBe(2);
      expect(revokeAllBody()).toContain(`t('${key}')`);
    }
    expect(I18N).toContain("'handsfree.mac.revokeAllConfirmTitle': 'Bütün telefonlar çıkarılsın mı?'");
  });
});
