/**
 * The owner moves an agenda line by hand (the card's Done / Put back, and Telegram's /gundem
 * **Bitti**, plan N6/P4): `by: 'owner'`, so the server never moves it again (pad.ts; pattern:
 * the agent must not undo what the owner did). Moved to the end of its section.
 */
import { writeSuper } from './inbox.js';
import { PAD_ID_RE, type SuperId, type SuperState } from './types.js';

export async function padMove(contextRoot: string, id: string, section: 'now' | 'done', superId: SuperId = 'main'): Promise<{ found: boolean; state: SuperState | null }> {
  if (!PAD_ID_RE.test(id)) return { found: false, state: null };
  let found = false;
  const state = await writeSuper(contextRoot, superId, (s) => {
    s.pad = (s.pad ?? []).map((p) => {
      if (p.id !== id) return p;
      found = true;
      const { why: _w, toldAt: _t, ...rest } = p;
      return { ...rest, section, by: 'owner' as const, at: p.section === section ? p.at : Date.now() };
    });
    const moved = s.pad.find((p) => p.id === id);
    if (moved) s.pad = [...s.pad.filter((p) => p.id !== id), moved];
  });
  return { found, state: (state as SuperState | undefined) ?? null };
}
