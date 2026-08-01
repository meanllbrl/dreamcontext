import { nanoid } from 'nanoid';

/**
 * Generate a prefixed unique ID.
 * Example: generateId('feat') -> 'feat_xK9pQ2mL'
 */
export function generateId(prefix: string): string {
  return `${prefix}_${nanoid(8)}`;
}

/**
 * Fold a lowercased string to plain ASCII letters: NFD-decompose and strip the
 * combining marks (ö→o, ü→u, ç→c, ğ→g, ş→s, and any other Latin diacritic),
 * then map the dotless ı — which has no decomposition — to i. (İ needs no rule
 * of its own: toLowerCase turns it into i + a combining dot, which the mark
 * strip removes.)
 *
 * Without this, slugify DROPPED non-ASCII letters wholesale and Turkish names
 * arrived mangled: "Öğretmen fiyatı" → "retmen-fiyat" instead of
 * "ogretmen-fiyati". Existing slugs are files on disk and are never renamed.
 */
export function foldToAscii(lower: string): string {
  return lower
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');
}

/**
 * Slugify a name for use as a filename.
 * "My Feature Name" -> "my-feature-name"; "Öğretmen fiyatı" -> "ogretmen-fiyati"
 */
export function slugify(name: string): string {
  return foldToAscii(name.toLowerCase())
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Get today's date as YYYY-MM-DD.
 */
export function today(): string {
  return new Date().toISOString().split('T')[0];
}
