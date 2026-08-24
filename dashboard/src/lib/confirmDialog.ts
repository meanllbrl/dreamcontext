/**
 * A confirmation that renders INSIDE the webview — no native shell, no browser
 * JS panel, no version coupling.
 *
 * WHY THIS EXISTS: `confirmAction()` used to be "native NSAlert sheet in the
 * app, `window.confirm` in a browser". Both halves depend on something outside
 * the dashboard bundle, and in the app BOTH can be missing at once:
 *
 *  - `window.confirm` is inert in wry's WKWebView (its `WKUIDelegate`
 *    implements none of WebKit's JavaScript panel methods, so WebKit shows no
 *    dialog and answers `false`);
 *  - the native `confirm_dialog` command only exists in an app shell built
 *    after it was added — and the shell is INSTALLED separately from the
 *    dashboard, which the CLI serves over http and updates on its own cadence.
 *    A user on an older `.app` therefore runs today's JS against a shell whose
 *    `invoke('confirm_dialog')` rejects with "command not found".
 *
 * When both fall through, every `if (!(await confirmAction(…))) return;` is an
 * unconditional early return: sixteen dead buttons (task delete, version
 * delete, objective delete, hard sync, scheduler off, remove-from-launcher …)
 * with no error anywhere the user can see. That is the bug this file closes —
 * the fallback is now DOM the dashboard ships itself, so it works in every
 * webview and every browser regardless of what the shell supports.
 *
 * Imperative DOM rather than a React component on purpose: `confirmAction()` is
 * a plain async function called from event handlers all over the app (and from
 * off-instance surfaces like the launcher and the checklist window that live
 * outside any provider). Keeping it callable as a function means none of those
 * sixteen call sites change.
 */

export interface WebviewConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/** Above every other overlay in the app (the highest today is 1200). */
const Z_INDEX = 2_000_000;

/** Stable hooks for `scripts/verify/task-delete-confirm.mjs` — do not rename. */
const ROOT_ATTR = 'data-confirm-dialog';
const ACCEPT_ATTR = 'data-confirm-accept';
const CANCEL_ATTR = 'data-confirm-cancel';

function styleButton(btn: HTMLButtonElement, kind: 'confirm' | 'cancel', destructive: boolean): void {
  const accent = destructive ? 'var(--color-error)' : 'var(--color-accent)';
  Object.assign(btn.style, {
    font: 'inherit',
    fontSize: 'var(--font-size-sm, 14px)',
    fontWeight: 'var(--font-weight-medium, 500)',
    padding: '8px 16px',
    borderRadius: 'var(--radius-md, 9px)',
    cursor: 'pointer',
    minWidth: '92px',
    transition: 'filter 120ms ease, background 120ms ease',
    ...(kind === 'confirm'
      ? { background: accent, color: 'var(--color-accent-text, #fff)', border: `1px solid ${accent}` }
      : {
          background: 'transparent',
          color: 'var(--color-text-secondary, #646464)',
          border: '1px solid var(--color-border, #e8e8e8)',
        }),
  } satisfies Partial<CSSStyleDeclaration>);
  btn.onmouseenter = () => { btn.style.filter = 'brightness(0.94)'; };
  btn.onmouseleave = () => { btn.style.filter = ''; };
}

/**
 * Show the dialog and resolve to the user's answer.
 *
 * Fails CLOSED like the native sheet it stands in for: Escape, the Cancel
 * button and a click on the backdrop all resolve `false`, so a dismissal is
 * never mistaken for consent. The confirm button holds focus, which makes
 * Enter confirm and Tab cycle between the two buttons without any focus-trap
 * machinery.
 */
export function showWebviewConfirm(opts: WebviewConfirmOptions): Promise<boolean> {
  const { title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', destructive = false } = opts;

  return new Promise<boolean>((resolve) => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const overlay = document.createElement('div');
    overlay.setAttribute(ROOT_ATTR, '');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: String(Z_INDEX),
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: 'rgba(0, 0, 0, 0.38)',
      // The app's own font stack, so the sheet reads as part of the product
      // rather than as whatever the webview defaults to.
      fontFamily: 'var(--font-family, system-ui, sans-serif)',
    } satisfies Partial<CSSStyleDeclaration>);

    const card = document.createElement('div');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    Object.assign(card.style, {
      width: 'min(420px, 100%)',
      background: 'var(--color-bg-elevated, #fff)',
      color: 'var(--color-text, #292d34)',
      border: '1px solid var(--color-border, #e8e8e8)',
      borderRadius: 'var(--radius-lg, 12px)',
      boxShadow: 'var(--shadow-xl, rgba(0,0,0,0.25) 0 12px 32px -8px)',
      padding: '20px',
    } satisfies Partial<CSSStyleDeclaration>);

    const heading = document.createElement('div');
    heading.id = `confirm-title-${Math.random().toString(36).slice(2)}`;
    heading.textContent = title;
    Object.assign(heading.style, {
      fontSize: 'var(--font-size-base, 16px)',
      fontWeight: 'var(--font-weight-semibold, 600)',
      lineHeight: '1.35',
    } satisfies Partial<CSSStyleDeclaration>);
    card.appendChild(heading);
    card.setAttribute('aria-labelledby', heading.id);

    if (body) {
      const text = document.createElement('div');
      text.id = `confirm-body-${Math.random().toString(36).slice(2)}`;
      text.textContent = body;
      Object.assign(text.style, {
        marginTop: '8px',
        fontSize: 'var(--font-size-sm, 14px)',
        lineHeight: '1.5',
        color: 'var(--color-text-secondary, #646464)',
      } satisfies Partial<CSSStyleDeclaration>);
      card.appendChild(text);
      card.setAttribute('aria-describedby', text.id);
    }

    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '8px',
      marginTop: '20px',
    } satisfies Partial<CSSStyleDeclaration>);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.setAttribute(CANCEL_ATTR, '');
    cancel.textContent = cancelLabel;
    styleButton(cancel, 'cancel', destructive);

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.setAttribute(ACCEPT_ATTR, '');
    confirm.textContent = confirmLabel;
    styleButton(confirm, 'confirm', destructive);

    row.append(cancel, confirm);
    card.appendChild(row);
    overlay.appendChild(card);

    let settled = false;
    const close = (answer: boolean) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      // Returning focus is what makes a keyboard user land back on the button
      // they pressed instead of at the top of the document.
      try { previouslyFocused?.focus?.(); } catch { /* detached node */ }
      resolve(answer);
    };

    confirm.addEventListener('click', () => close(true));
    cancel.addEventListener('click', () => close(false));
    // Only the backdrop itself — a click that started inside the card and drifted
    // out (text selection) must not read as a dismissal.
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
    });

    document.body.appendChild(overlay);
    confirm.focus();
  });
}
