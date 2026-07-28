/**
 * Structural guard for issue #234: the checklist window is never closed in the same tick as
 * the action that asked for it.
 *
 * Submitting a checklist whose item list had grown scrollable segfaulted the whole app —
 * `EXC_BAD_ACCESS` in `WebCore::ScrollingTree::takePendingScrollUpdates()` off a display-link
 * refresh, i.e. WebKit servicing a scrolling update against a webview already being torn
 * down. The sequencing fix has two halves that only work together: the phase change unmounts
 * the scrollable list, and the close waits for frames after that render.
 *
 * The timing itself can't be asserted without a DOM harness (this repo runs none), but the
 * SHAPE can, and the shape is what regresses: a future edit that puts `closeCurrentWindow()`
 * back on a click handler restores the crash exactly. So: exactly one call site, inside the
 * deferred hook, and the sent/closing render must not contain the scroller.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(
  join(import.meta.dirname, '../../dashboard/src/components/checklist/ChecklistWindow.tsx'),
  'utf-8',
);

/** Code only. The file explains this fix at length — including the line "NOT
 *  `closeCurrentWindow()` here" — and a test that counts call sites must not count prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const SOURCE = stripComments(RAW);

describe('ChecklistWindow deferred close (#234)', () => {
  it('calls closeCurrentWindow from exactly one place', () => {
    const calls = SOURCE.match(/closeCurrentWindow\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('that one call lives inside the deferred-close hook', () => {
    const hook = SOURCE.slice(SOURCE.indexOf('function useDeferredClose'));
    const body = hook.slice(0, hook.indexOf('\n}\n') + 3);
    expect(body).toContain('closeCurrentWindow()');
    expect(body).toContain('requestAnimationFrame');
    // An occluded window throttles rAF; without the fallback the window would never close.
    expect(body).toContain('setTimeout');
  });

  it('never closes straight from a click handler or the submit success path', () => {
    expect(SOURCE).not.toMatch(/onClick=\{\(\)\s*=>\s*void closeCurrentWindow\(\)\}/);
    const submit = SOURCE.slice(SOURCE.indexOf('const handleSubmit'), SOURCE.indexOf('const copyMarkdown'));
    expect(submit).not.toContain('closeCurrentWindow');
    expect(submit).toContain("setPhase('sent')");
  });

  it('renders no scrollable content in the state the window dies in', () => {
    // The `sent`/`closing` arm comes FIRST in the ternary chain, so the branch holding
    // `.checklist-content` (the scroller) is unreachable once the window is on its way out.
    const sentArm = SOURCE.indexOf("phase === 'sent' || phase === 'closing' ?");
    const scroller = SOURCE.indexOf('className="checklist-content"');
    expect(sentArm).toBeGreaterThan(-1);
    expect(scroller).toBeGreaterThan(sentArm);
  });
});
