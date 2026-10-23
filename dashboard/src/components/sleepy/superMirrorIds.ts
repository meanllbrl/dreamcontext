/**
 * Which conversations the hands-free PHONE shows as the Super Agent's (a `superMirror` chat
 * session: reply strips, groups, the ↩ chip). The phone opens the Super's conversation in an
 * ordinary chat mode, so nothing in the session itself says so: this remembers every id the
 * phone was told is a Super's (its list's `live.supers`, a tap on that row) and KEEPS it across
 * a reload, so a restored tab or any other way into the same conversation is still one.
 * Client-only; never sent.
 */
const KEY = 'dreamcontext-super-mirror-ids';
/** Newest last; a phone sees one Super per project, so a few dozen is years of use. */
const MAX_IDS = 40;

let cache: string[] | null = null;

function load(): string[] {
  if (cache) return cache;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    cache = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(-MAX_IDS) : [];
  } catch { cache = []; }
  return cache;
}

export function isSuperMirrorId(id: string): boolean {
  return !!id && load().includes(id);
}

export function rememberSuperMirrorIds(ids: readonly string[]): void {
  const cur = load();
  const fresh = ids.filter((id) => typeof id === 'string' && id && !cur.includes(id));
  if (!fresh.length) return;
  cache = [...cur, ...fresh].slice(-MAX_IDS);
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* private mode: memory only */ }
}
