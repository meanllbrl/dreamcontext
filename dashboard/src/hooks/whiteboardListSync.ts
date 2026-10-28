/**
 * Keeping the board list (and every surface reading it: the tabs, All boards, the explorer)
 * true to the disk, as pure rules so they are unit-testable without React or a server.
 *
 * The list is re-pulled on the app's slow refresh; a board deleted or made elsewhere (another
 * window, the CLI, an agent, a plain `rm`) would sit in it, and in its tab, until then. The open
 * board's 2 s rev poll carries every board's slug instead, and a difference re-pulls the list.
 */

/** The poll's board set differs from the cached list's: the list is out of date. No list
 *  yet (still loading) or no set (an older server) is never "out of date". */
export function listIsStale(
  listed: readonly { slug: string }[] | undefined,
  onDisk: readonly string[] | undefined,
): boolean {
  if (!listed || !Array.isArray(onDisk)) return false;
  if (listed.length !== onDisk.length) return true;
  const have = new Set(listed.map((b) => b.slug));
  return onDisk.some((slug) => !have.has(slug));
}

/**
 * The open board is gone and nothing of the owner's would go with its tab: it was missing when
 * opened, or it vanished while open with every change already on disk. With unsaved changes the
 * board stays on screen, banner and Export button, until the owner has kept what they want.
 */
export function boardIsGone(
  load: { kind: string },
  save: { kind: string; unsaved?: boolean },
): boolean {
  if (load.kind === 'missing') return true;
  return load.kind === 'ready' && save.kind === 'deleted' && save.unsaved !== true;
}
