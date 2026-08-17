/**
 * `window.confirm` must never come back to dashboard code.
 *
 * It is not a style preference. In the desktop app `window.confirm` is BROKEN,
 * and broken silently: wry's `WKUIDelegate` implements exactly three methods
 * (the file-upload panel, the media-capture prompt, `window.open`) and none of
 * WebKit's JavaScript panel methods. WebKit's documented behaviour for a
 * delegate without `runJavaScriptConfirmPanelWithMessage:` is to show NO dialog
 * and return `false`, and Tauri injects no shim. So
 *
 *     if (!window.confirm(…)) return;
 *
 * is an unconditional early return inside the app — the button does nothing,
 * with no error anywhere — while the identical code works in a browser tab.
 * That asymmetry is exactly why eight dead buttons (task delete, version
 * delete, objective delete, hard sync, scheduler off, remove-from-launcher ×2)
 * shipped and survived unnoticed.
 *
 * The replacement is `confirmAction()` in `lib/desktop.ts`, which calls the
 * shell's native `confirm_dialog` sheet in the app and falls back to
 * `window.confirm` in a browser — so `lib/desktop.ts` is the ONE file allowed
 * to name it. This is the chartRegistry/debt-threshold drift-guard idiom: a
 * file outside this package's tsconfig can still be parsed as TEXT and asserted.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '../../dashboard/src');
/** The single legitimate caller — it IS the browser fallback. */
const ALLOWED = join(SRC, 'lib/desktop.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

describe('no window.confirm outside the desktop fallback', () => {
  it('names window.confirm in lib/desktop.ts only', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => f !== ALLOWED)
      .filter((f) => /\bwindow\.confirm\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));

    expect(
      offenders,
      'window.confirm is inert in the desktop webview (no WKUIDelegate JS panel). '
        + 'Use confirmAction() from lib/desktop.ts instead.',
    ).toEqual([]);
  });

  it('still keeps the browser fallback in lib/desktop.ts', () => {
    // The guard above would also "pass" if someone deleted the fallback
    // entirely, leaving browser users with no confirmation at all.
    expect(readFileSync(ALLOWED, 'utf8')).toMatch(/\bwindow\.confirm\b/);
  });

  it('routes confirmAction through the native command in the desktop app', () => {
    const src = readFileSync(ALLOWED, 'utf8');
    expect(src).toMatch(/invoke<boolean>\(\s*['"]confirm_dialog['"]/);
    // Fails CLOSED: a confirmation that cannot be shown must not read as
    // consent, so the desktop branch must be gated on isDesktop().
    expect(src).toMatch(/export async function confirmAction/);
    expect(src).toMatch(/if \(isDesktop\(\)\)/);
  });
});
