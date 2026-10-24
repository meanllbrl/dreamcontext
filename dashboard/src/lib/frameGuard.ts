/**
 * The SPA's fail-closed frame fallback (T1b in the super-agent-mode threat model). The server
 * refuses a foreign frame by Fetch Metadata (`refuseForeignFrame`); an old WebKit sends none,
 * so the page itself checks where it is drawn: framed by a parent it cannot prove is this
 * origin = draw nothing. Reading a cross-origin parent's `location` throws, and a throw is
 * foreign too.
 */
export function isFramedByForeignParent(win: Pick<Window, 'top' | 'self' | 'parent' | 'location'>): boolean {
  let framed: boolean;
  try {
    framed = win.top !== win.self;
  } catch {
    return true;
  }
  if (!framed) return false;
  try {
    return win.parent.location.origin !== win.location.origin;
  } catch {
    return true;
  }
}
