/**
 * ImageViewer (dashboard/src/components/layout/ImageViewer.tsx), owner 2026-11-03: the bottom
 * controls covered the bottom of a tall picture (a paywall's main button). Round 2 (ref e45byo):
 * one solid toolbar row UNDER the picture, nothing over it, not even translucent, no fading.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const src = read('dashboard/src/components/layout/ImageViewer.tsx');
const css = read('dashboard/src/components/layout/ImageViewer.css');
const block = (sel: string) => css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('ImageViewer toolbar under the picture', () => {
  it('the stage, fitted or zoomed, ends where the toolbar starts and clips there', () => {
    expect(src).toMatch(/style=\{\{ bottom: footH \}\}/);
    expect(src).toMatch(/ref=\{footRef\} className="image-viewer-toolbar"/);
    // The stage keeps its overflow: hidden, so a zoomed picture never runs under the toolbar.
    expect(css).not.toMatch(/image-viewer-stage\s*\{\s*overflow: visible/);
    expect(block('.image-viewer-stage')).toMatch(/overflow: hidden/);
  });

  it('the toolbar is solid and never fades', () => {
    const bar = block('.image-viewer-toolbar');
    expect(bar).toMatch(/background: var\(--color-bg-elevated\)/);
    expect(bar).not.toMatch(/backdrop-filter|rgba|opacity/);
    expect(src).not.toMatch(/setIdle|CONTROLS_IDLE_MS|data-hidden/);
    expect(css).not.toMatch(/foot--dock/);
  });

  it('the hint is the % tooltip, not a line on screen', () => {
    expect(src).not.toMatch(/className="image-viewer-hint"/);
    expect(src).toMatch(/title=\{`\$\{zoomed \? t\('imageViewer\.fit'\) : t\('imageViewer\.actual'\)\} · \$\{t\('imageViewer\.hint'\)\}`\}/);
  });

  it('every control is one size and the file actions are icons from the app set', () => {
    expect(block('.viewer-tool')).toMatch(/height: 28px/);
    expect(block('.viewer-tool')).toMatch(/border-radius: var\(--radius-md\)/);
    const fa = read('dashboard/src/components/sleepy/chat/FileActions.tsx');
    expect(fa).toMatch(/import \{ ComputerIcon, CopyIcon, FolderIcon \} from '\.\.\/\.\.\/whiteboard\/PanelIcons'/);
    expect(read('dashboard/src/components/sleepy/chat/Lightbox.tsx')).toMatch(/<FileActions path=\{path\} iconOnly \/>/);
  });

  it('the page viewer keeps its own floating foot', () => {
    expect(read('dashboard/src/components/layout/FrameViewer.tsx')).not.toMatch(/image-viewer-toolbar/);
  });
});

describe('ImageViewer toolbar stays one row at 390 px', () => {
  it('a failure note shrinks instead of pushing the zoom group off-screen', () => {
    expect(css).toMatch(/\.image-viewer-toolbar-tools \{ flex: 0 1 auto; min-width: 0; \}/);
    expect(read('dashboard/src/components/sleepy/chat/overlays.css')).toMatch(/\.chat-fileactions\.icon-only \{[^}]*flex: 0 1 auto; min-width: 0;/);
  });

  it('task attachments step through the viewer, with icon-only file actions', () => {
    const mv = read('dashboard/src/components/tasks/detail/MediaViewer.tsx');
    expect(mv).toMatch(/step=\{n > 1 \?/);
    expect(mv).toMatch(/<FileActions path=\{projectPath\} iconOnly/);
    expect(mv).toMatch(/<CopyPath path=\{projectPath\} icon \/>/);
    // The viewer owns the arrows for an image; the panel must not step a second time.
    expect(mv).toMatch(/if \(file\?\.kind === 'image'\) return;/);
  });
});
