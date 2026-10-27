/**
 * The one way raw bytes from the page reach the agent: write the blob into the vault's
 * gitignored temp dir (`POST /api/agent/drop`) and hand back the absolute path, which is
 * what a Claude session can actually read.
 *
 * Two callers, one mechanism — a file DROPPED on the surface (AgentSurface) and an image
 * PASTED into the chat composer. The chat protocol is text-only, so a path is not a
 * convenience here, it is the entire channel: without this an attached picture is a
 * thumbnail the user can see and the agent cannot.
 *
 * Binary can't go through `api.post` (JSON-only), so this uses raw `fetch` and carries the
 * vault as a header the same way the api client does. `vault` is a PARAMETER rather than a
 * module read: one window now holds several live projects, and a module-level "active vault"
 * would write one project's dropped file into whichever project the user last touched. The
 * React caller takes it from `useVault()`; null means launcher/browser, exactly as before.
 *
 * Resolves null on ANY refusal (not desktop, over the 25 MB cap, write failed) rather than
 * throwing — a caller shows the attachment as un-sendable; nothing about a failed upload
 * should take a message down with it.
 */
export async function uploadAgentFile(vault: string | null, file: File | Blob, name: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const body = await file.arrayBuffer();
    const res = await fetch('/api/agent/drop', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Dreamcontext-Filename': encodeURIComponent(name),
        ...(vault ? { 'X-Dreamcontext-Vault': vault } : {}),
      },
      body,
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const { path } = await res.json() as { path?: string };
    return path || null;
  } catch {
    return null;
  }
}

/**
 * A picture picked with "Attach files…" (a PATH, from the native picker), copied into the same
 * drop folder a pasted picture's bytes go to (`POST /api/agent/drop-path`), so from here on it is
 * one: a chip with a thumbnail, a `[Picture N: <path>]` line, a picture in the sent bubble.
 * Resolves the copy's absolute path, or null on any refusal (not a picture, not the desktop app,
 * gone) — the caller then keeps the original path.
 */
export async function copyPickedPicture(vault: string | null, path: string): Promise<string | null> {
  try {
    const res = await fetch('/api/agent/drop-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(vault ? { 'X-Dreamcontext-Vault': vault } : {}) },
      body: JSON.stringify({ path }),
      // A file the Mac cannot read promptly (an offline network drive, an iCloud placeholder) must
      // not hold the send forever: past this the chip keeps the original path.
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const { path: copied } = await res.json() as { path?: string };
    return copied || null;
  } catch {
    return null;
  }
}
