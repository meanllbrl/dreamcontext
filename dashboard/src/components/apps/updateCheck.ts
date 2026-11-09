/** What the Apps page checks when it opens (no React here, so a node test can read it). */

interface Checkable {
  slug: string;
  origin?: 'own' | 'installed';
  source?: { mode?: 'following' | 'own'; lastCheck?: string | null } | null;
}

/** The installed apps that follow an original and were not checked in the last `freshMs`. */
export function updateCheckDue(apps: readonly Checkable[], now: number, freshMs = 10 * 60_000): string[] {
  return apps
    .filter((a) => a.origin === 'installed' && a.source && a.source.mode !== 'own' && !(a.source.lastCheck && now - Date.parse(a.source.lastCheck) < freshMs))
    .map((a) => a.slug);
}
