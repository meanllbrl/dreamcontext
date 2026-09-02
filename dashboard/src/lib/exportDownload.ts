/**
 * Handing a file the page just built to the user — and being able to SAY where it went.
 *
 * WHY THIS IS NOT JUST `<a download>` (owner report, 2026-09-02). In the desktop webview a
 * download is a black hole: the page gets no path, no completion event and no error, so the
 * export bar could only ever fall silent after a click. Everything else about the feature
 * said "a silent export is the defect" — and success was the one case that stayed silent.
 *
 * So in the desktop app the bytes go through `POST /api/agent/download`, which writes them
 * into ~/Downloads and returns the absolute path. That path is the whole point: it is what
 * lets the surface print the real filename (numbered, if it collided) and offer to reveal
 * it in the file manager.
 *
 * In a plain browser the ordinary download is CORRECT — the browser owns that UI, shows its
 * own shelf, and has a downloads list. There the route 403s and we fall back, reporting the
 * filename without a path (there is no path to report).
 */
import { isDesktop } from './desktop';

export interface Delivered {
  /** The name the file actually landed under — the server's, when it wrote it. */
  filename: string;
  /** Absolute path, when we know it. Null in the browser, or if the write fell back. */
  path: string | null;
}

/** Hand a blob to the OS as a download, the browser way. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked on the next turn, not synchronously: Safari/WKWebView has not necessarily
  // started reading the object URL by the time `click()` returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Put `blob` on disk under `filename` and report where.
 *
 * Never throws and never leaves the user with nothing: if the server write is unavailable
 * or fails, this still performs the browser download and reports the name it asked for.
 */
export async function deliverDownload(blob: Blob, filename: string): Promise<Delivered> {
  if (isDesktop()) {
    try {
      const res = await fetch('/api/agent/download', {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          'X-Dreamcontext-Filename': encodeURIComponent(filename),
        },
        body: await blob.arrayBuffer(),
      });
      if (res.ok) {
        const saved = await res.json() as { path?: string; filename?: string };
        if (saved.path) return { filename: saved.filename || filename, path: saved.path };
      }
    } catch { /* fall through to the browser download */ }
  }
  downloadBlob(blob, filename);
  return { filename, path: null };
}

/**
 * What an export bar SAYS after a click.
 *
 * One shape for both outcomes on purpose: a failure and a success are the same size of
 * event to the person who clicked, and the surface should not have to branch to report
 * them. `path` is what makes the difference — it is the only thing a "Show" button can act
 * on, so its presence, not a flag, is what decides whether the note gets one.
 */
export interface ExportNote {
  text: string;
  path?: string | null;
}

/** The note for a delivered file: the name it landed under, and where, when we know. */
export function deliveredNote(d: Delivered): ExportNote {
  return {
    text: d.path ? `✓ saved to Downloads — ${d.filename}` : `✓ downloaded ${d.filename}`,
    path: d.path,
  };
}
