import { useVault } from '../context/VaultContext';

/**
 * A per-instance overlay id — `${instanceId}::${local}` — so two project instances open in
 * the same window never collide on `overlayStack`'s literal ids. `pushOverlay` de-dupes by
 * id, so two instances pushing the same bare string (e.g. `'command-palette'`) are the SAME
 * entry: instance A closing its palette pops instance B's, and Esc breaks in B.
 *
 * A hook (not a plain function) because it reads `useVault()` — kept out of the
 * framework-free `overlayStack.ts` so that module stays usable outside React.
 *
 * Outside a `VaultProvider` (launcher, browser build, the checklist window) `instanceId` is
 * `''`, giving e.g. `'::command-palette'` — still unique, because exactly one of each
 * off-instance surface ever exists at a time.
 */
export function useOverlayId(local: string): string {
  const { instanceId } = useVault();
  return `${instanceId}::${local}`;
}
