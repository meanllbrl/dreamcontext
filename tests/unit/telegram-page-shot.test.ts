/**
 * An option's drawing → PNG with headless Chromium (page-shot.ts, owner 2026-11-09 "çizim
 * gözükmüyor"): the page never leaves with a secret, the browser gets no network, no Chromium is
 * null (the caller says the drawing is on the Mac), and one Chromium runs at a time.
 */
import { describe, it, expect } from 'vitest';
import { makePreviewShooter, previewPage, shotArgs } from '../../src/server/telegram/page-shot.js';

describe('previewPage', () => {
  it('builds the chat card page; the measuring copy reports its height to its own origin', () => {
    const page = previewPage('<div class="dc-card">Kart</div>', false)!;
    expect(page).toContain('dc-card');
    expect(page).not.toContain('?h=');
    expect(previewPage('<div class="dc-card">Kart</div>', true)).toContain('location.replace(location.pathname+"?h="');
  });

  it('an empty page or one carrying a secret never leaves', () => {
    expect(previewPage('   ', false)).toBeNull();
    expect(previewPage('<p>sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</p>', false)).toBeNull();
  });
});

describe('shotArgs', () => {
  it('no network but its own loopback port, a throwaway profile, the screenshot at the measured size', () => {
    const a = shotArgs('/tmp/x', 'http://127.0.0.1:4567/p.html', 720, 900, '/tmp/x/shot.png');
    expect(a).toContain('--proxy-server=http://127.0.0.1:9');
    expect(a).toContain('--proxy-bypass-list=<-loopback>;127.0.0.1:4567');
    expect(a).toContain('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
    expect(a).toContain('--user-data-dir=/tmp/x/profile');
    expect(a).toContain('--window-size=720,900');
    expect(a).toContain('--screenshot=/tmp/x/shot.png');
    expect(a.at(-1)).toBe('http://127.0.0.1:4567/p.html');
  });
});

describe('makePreviewShooter', () => {
  it('no Chromium on the machine: null', async () => {
    expect(await makePreviewShooter({ chromium: () => null })('<div>x</div>')).toBeNull();
  });

  it('one Chromium at a time', async () => {
    let running = 0; let most = 0;
    const shoot = makePreviewShooter({ chromium: () => '/bin/chromium', shoot: async () => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 20)); running--; return Buffer.from('png'); } });
    await Promise.all([shoot('a'), shoot('b'), shoot('c')]);
    expect(most).toBe(1);
  });
});
