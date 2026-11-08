/**
 * The hands-free phone in the NEW SHELL, for verify scripts (task hands-free-nin-ayri-telefon-
 * arayuzu-kalkar…, W2). The Sohbetler list, its stack, the session drawer and the phone bar are
 * gone: a phone opens with the drawer open, chats are drawer rows, the bottom bar navigates.
 *
 *   drawer        [data-testid="chat-drawer"] (data-home on a phone's first screen)
 *   project       [data-drawer-project="<vault>"], its toggle [data-testid="drawer-project-row"]
 *   chat rows     [data-testid="drawer-chat-row"] (data-chat-id, data-state asking|working|idle)
 *   New chat      [data-testid="drawer-new-chat"] (a project with no rows), the chat head's
 *                 [data-testid="chat-head-new"], the empty state's [data-testid="chat-empty-new"]
 *   History       [data-testid="drawer-history"], rows .chp-row
 *   foot          [data-testid="drawer-foot"] (push opt-in, connection log; tunnel only)
 *   bottom bar    [data-testid="ns-rail-chat|tasks|automations|lab|more"]
 */

export const drawerShown = (p) => p.locator('[data-testid="chat-drawer"]').isVisible().catch(() => false);

export const projRow = (p, vault) => p.locator(`[data-drawer-project="${vault}"]`);

/** A chat row of a project, by its visible title. */
export const chatRow = (p, vault, title) => projRow(p, vault).locator('[data-testid="drawer-chat-row"]', { hasText: title });

export async function openDrawer(p) {
  if (await drawerShown(p)) return true;
  await p.getByTestId('ns-drawer-toggle').click();
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (await drawerShown(p)) return true; await p.waitForTimeout(100); }
  return false;
}

export async function closeDrawer(p) {
  if (!(await drawerShown(p))) return;
  await p.getByTestId('ns-drawer-toggle').click();
  await p.waitForTimeout(400);
}

/** Expand a project in the drawer (opening the drawer first). */
export async function expand(p, vault) {
  await openDrawer(p);
  const t = projRow(p, vault).locator('[data-testid="drawer-project-row"]');
  if ((await t.getAttribute('aria-expanded').catch(() => null)) !== 'true') { await t.click(); await p.waitForTimeout(500); }
}

/** A chat on screen: the mobile surface painted and the drawer closed. */
export async function chatShown(p) {
  if (await drawerShown(p)) return false;
  return p.evaluate(() => [...document.querySelectorAll('.agent-surface[data-mobile]')].some((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; }));
}

/** Open a chat row (expanding its project) and wait for the chat to be on screen. */
export async function openChat(p, vault, title, ms = 15000) {
  await expand(p, vault);
  await chatRow(p, vault, title).first().click();
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await chatShown(p)) return true; await p.waitForTimeout(150); }
  return false;
}

/** Back to the drawer the way a finger does: on a phone the back gesture (the drawer's own history
 *  entry, `body[data-phone]`), on a tablet or a computer the toggle (no such entry: a back there
 *  would leave the app). */
export async function back(p) {
  if (await p.evaluate(() => document.body.dataset.phone === 'true')) {
    await p.goBack().catch(() => {});
    await p.waitForTimeout(500);
  }
  if (!(await drawerShown(p))) await openDrawer(p);
  return drawerShown(p);
}

/** Start a chat from wherever the phone is: the drawer's New chat row, the empty state, or the
 *  chat head's +. In `vault` when given. */
export async function newChat(p, vault) {
  if (vault) await expand(p, vault);
  const row = (vault ? projRow(p, vault) : p).locator('[data-testid="drawer-new-chat"]:visible').first();
  if (await row.count()) { await row.click(); return; }
  // A project with rows offers New chat in its chat: show one of its chats, then the head's +.
  if (vault && (await projRow(p, vault).locator('[data-testid="drawer-chat-row"]').count())) {
    await projRow(p, vault).locator('[data-testid="drawer-chat-row"]').first().click();
    await p.waitForTimeout(800);
  }
  await closeDrawer(p);
  const empty = p.locator('[data-testid="chat-empty-new"]:visible').first();
  if (await empty.count()) { await empty.click(); return; }
  const head = p.locator('[data-testid="chat-head-new"]:visible').first();
  if (await head.count()) { await head.click(); return; }
  // A computer or a tablet on the tunnel has no chat-head +: the drawer's New chat entry.
  await openDrawer(p);
  await p.getByTestId('drawer-new-window').click();
}

/** The handed-over project's one row on a device shell: its Super Agent (a chat row by title). */
export const superRow = (p, vault = 'proj') => chatRow(p, vault, 'Super Agent');

/** How many Super rows the drawer lists for `vault` (opening and expanding it first). */
export async function superRows(p, vault = 'proj') {
  await expand(p, vault);
  return superRow(p, vault).count();
}

/** Tap the Super row (the phone opens the Super Agent's chat as a mirror). */
export async function openSuper(p, vault = 'proj') {
  await expand(p, vault);
  await superRow(p, vault).first().click();
}

/** A project's drawer rows on a device shell: each chat row (kind `super` for the Super Agent's),
 *  and whether the drawer offers New chat there. Opens and expands it first. */
export async function drawerShape(p, vault = 'proj') {
  await expand(p, vault);
  return p.evaluate((v) => {
    const el = document.querySelector(`[data-drawer-project="${v}"]`);
    const rows = [...(el?.querySelectorAll('[data-testid="drawer-chat-row"]') ?? [])].map((r) => {
      const text = (r.textContent || '').replace(/\s+/g, ' ').trim();
      return { kind: /^Super Agent/.test(r.querySelector('.ns-dr-t')?.textContent ?? '') ? 'super' : 'chat', id: r.getAttribute('data-chat-id'), state: r.getAttribute('data-state'), text, h: Math.round(r.getBoundingClientRect().height) };
    });
    return { super: rows.some((r) => r.kind === 'super'), rows, newChat: !!el?.querySelector('[data-testid="drawer-new-chat"]'), overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 };
  }, vault);
}

/** Send the composer's draft the way this device does (lib/enterKey.ts, owner 2026-10-30): on a
 *  phone (coarse pointer, short side < 600) Enter adds a line and only the send button sends; on a
 *  computer or a tablet Enter sends. */
export async function submit(p) {
  const phone = await p.evaluate(() => matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 600);
  if (!phone) { await p.keyboard.press('Enter'); return; }
  // iOS Safari never focuses a tapped button: the composer keeps focus and the keyboard stays up.
  const box = await p.evaluateHandle(() => document.activeElement);
  await p.locator('.chat-cmp-send.is-enabled:visible').first().click();
  await box.evaluate((el) => { if (el && el.classList?.contains('chat-cmp-input')) el.focus(); }).catch(() => {});
}
