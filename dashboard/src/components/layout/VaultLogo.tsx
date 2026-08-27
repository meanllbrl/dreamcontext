import { useCallback, useEffect, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { launcherLogoUrl } from '../../api/client';
import { useSetVaultLogo } from '../../hooks/useLauncher';
import './VaultLogo.css';

/**
 * A registered vault's identity mark — its `_dream_context/assets/logo.*` file — shared by
 * every launcher surface that names a project (the List cards, the Space chips and cards),
 * so the "does it have one, and what if it fails to load" story lives in exactly one place,
 * the way {@link VaultDot} owns the status colours.
 *
 * A vault WITHOUT a logo renders nothing at all: the mark is additive identity, and an
 * empty placeholder circle on every logoless card would turn a nice-to-have into a nag.
 * A logo that 404s or fails to decode also collapses to nothing, for the same reason.
 */
export function VaultLogo({ name, hasLogo, stamp, size = 20, className }: {
  name: string;
  /** The status payload's `logo` flag — no speculative image requests for vaults without one. */
  hasLogo: boolean;
  /** The status payload's `logoStamp` — busts the browser's image cache after a replace. */
  stamp?: number | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!hasLogo || failed) return null;
  const src = stamp ? `${launcherLogoUrl(name)}&ts=${stamp}` : launcherLogoUrl(name);
  return (
    <img
      className={`vault-logo${className ? ` ${className}` : ''}`}
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * The launcher-side SETTER: one hidden file input + the upload mutation, shared by the
 * List cards and the Space card so both surfaces get the identical flow — click "Logo…",
 * the OS picker opens, the chosen image lands as `assets/logo.<ext>` in that vault, and
 * every card refreshes. Render `{picker.input}` ONCE per page; call `picker.pick(name)`
 * from any button.
 */
export function useVaultLogoPicker(onError: (message: string) => void): {
  pick: (name: string) => void;
  busy: boolean;
  input: ReactNode;
} {
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** The vault the open picker is for — set at click time, read at change time. */
  const nameRef = useRef<string | null>(null);
  const setLogo = useSetVaultLogo();

  const pick = (name: string) => {
    nameRef.current = name;
    inputRef.current?.click();
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the SAME file twice still fires a change event next time.
    e.target.value = '';
    const name = nameRef.current;
    if (!file || !name) return;
    setLogo.mutate({ name, file }, {
      onError: (err) => onError(err instanceof Error ? err.message : String(err)),
    });
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      // The server magic-byte-verifies to exactly these; offering more would only
      // produce a post-pick rejection the accept filter could have prevented.
      accept="image/png,image/jpeg,image/webp,image/gif"
      style={{ display: 'none' }}
      aria-hidden="true"
      tabIndex={-1}
      onChange={onChange}
    />
  );

  return { pick, busy: setLogo.isPending, input };
}

/** How wide the context menu renders (clamped so an edge right-click stays on screen). */
const LOGO_MENU_WIDTH = 180;
const LOGO_MENU_MARGIN = 8;

/**
 * The right-click menu that HIDES the logo setter: setting a logo is a once-per-project
 * act, and a labelled button on every card spent permanent surface on it (owner call
 * 08-27). Right-click a card/chip → "Set logo…" → the OS picker → done. Same transient-
 * popover lifecycle as the project-tab chip menu: dismissed by anything that moves the
 * page underneath it, Escape stopped so it never reaches a surface-level handler.
 *
 * Render `{menu.element}` once per page next to the picker's input; wire
 * `onContextMenu={(e) => menu.open(e, name, hasLogo)}` on anything that names a vault.
 */
export function useVaultLogoMenu(pick: (name: string) => void): {
  open: (e: ReactMouseEvent, name: string, hasLogo: boolean) => void;
  element: ReactNode;
} {
  const [menu, setMenu] = useState<{ name: string; hasLogo: boolean; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenu(null);
      }
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  const open = useCallback((e: ReactMouseEvent, name: string, hasLogo: boolean) => {
    e.preventDefault();
    setMenu({
      name,
      hasLogo,
      x: Math.min(e.clientX, window.innerWidth - LOGO_MENU_WIDTH - LOGO_MENU_MARGIN),
      y: e.clientY,
    });
  }, []);

  const element = menu && (
    <div
      className="vault-logo-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        className="vault-logo-menu-item"
        onClick={() => {
          const { name } = menu;
          setMenu(null);
          pick(name);
        }}
      >
        {menu.hasLogo ? 'Change logo…' : 'Set logo…'}
      </button>
    </div>
  );

  return { open, element };
}
