/**
 * `window.confirm` must never come back to dashboard code — not even as a
 * fallback.
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
 * The replacement is `confirmAction()` in `lib/desktop.ts`. It was FIRST written
 * as "native `confirm_dialog` sheet in the app, `window.confirm` in a browser",
 * and that reintroduced the same class of bug through the other door: the app
 * shell is installed separately from the dashboard (which the CLI serves over
 * http), so a user on an older `.app` runs current JS against a shell whose
 * `invoke('confirm_dialog')` rejects — and the `window.confirm` fallback then
 * answered "no" to every confirmation in the product. Task delete was reported
 * dead for exactly that reason.
 *
 * So the fallback is now `showWebviewConfirm()` in `lib/confirmDialog.ts`: DOM
 * the dashboard ships itself, which no shell version can take away. NOTHING in
 * `dashboard/src` may name `window.confirm` any more. This is the
 * chartRegistry/debt-threshold drift-guard idiom: a file outside this package's
 * tsconfig can still be parsed as TEXT and asserted.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '../../dashboard/src');
const DESKTOP = join(SRC, 'lib/desktop.ts');
const DIALOG = join(SRC, 'lib/confirmDialog.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/** `window.confirm` as a CALL, not the word inside the prose explaining why not. */
const CALLS_WINDOW_CONFIRM = /\bwindow\.confirm\s*\(/;

/**
 * Source with comments removed. The doc comments on `confirmAction` QUOTE the
 * broken call to explain why it is banned; matching those would make the guard
 * impossible to document, so it reads code only.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

describe('no window.confirm anywhere in the dashboard', () => {
  it('is never called, in any dashboard source file', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => CALLS_WINDOW_CONFIRM.test(code(f)))
      .map((f) => relative(SRC, f));

    expect(
      offenders,
      'window.confirm is inert in the desktop webview (no WKUIDelegate JS panel). '
        + 'Use confirmAction() from lib/desktop.ts instead.',
    ).toEqual([]);
  });

  it('routes confirmAction through the native command in the desktop app', () => {
    const src = readFileSync(DESKTOP, 'utf8');
    expect(src).toMatch(/invoke<boolean>\(\s*['"]confirm_dialog['"]/);
    // Fails CLOSED: a confirmation that cannot be shown must not read as
    // consent, so the desktop branch must be gated on isDesktop().
    expect(src).toMatch(/export async function confirmAction/);
    expect(src).toMatch(/if \(isDesktop\(\)\)/);
  });

  it('falls back to the in-webview dialog, which no shell version can remove', () => {
    // The guard above would also "pass" if someone deleted the fallback
    // entirely, leaving users with no confirmation at all — or restored a
    // fallback that depends on the webview, which is how this broke twice.
    const src = readFileSync(DESKTOP, 'utf8');
    expect(src).toMatch(/import \{ showWebviewConfirm \} from '\.\/confirmDialog'/);
    expect(src).toMatch(/return showWebviewConfirm\(/);
    // The native call must be RECOVERABLE — a rejection that escaped would make
    // an older shell reject the click instead of falling through. So the
    // fallback has to sit after the catch, not inside a branch the throw skips.
    const native = src.indexOf("invoke<boolean>('confirm_dialog'");
    const caught = src.indexOf('} catch (err) {', native);
    const fallback = src.indexOf('return showWebviewConfirm(', native);
    expect(native).toBeGreaterThan(-1);
    expect(caught).toBeGreaterThan(native);
    expect(fallback).toBeGreaterThan(caught);
  });

  it('keeps the in-webview dialog free of shell dependencies', () => {
    const src = readFileSync(DIALOG, 'utf8');
    // Nothing Tauri, nothing native: this file is the floor everything else
    // falls back to, so it must work in any webview and any browser.
    expect(src).not.toMatch(/@tauri-apps/);
    expect(src).not.toMatch(CALLS_WINDOW_CONFIRM);
    expect(src).toMatch(/export function showWebviewConfirm/);
    // The verify harness drives it by these attributes.
    expect(src).toMatch(/data-confirm-dialog/);
    expect(src).toMatch(/data-confirm-accept/);
    expect(src).toMatch(/data-confirm-cancel/);
  });
});
