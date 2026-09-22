import { useState } from 'react';
import { automationPhotoUrl } from '../../api/client';
import { useVault } from '../../context/VaultContext';
import './AgentAvatar.css';

/**
 * Up to two initials from an agent's name — the fallback EVERY missing,
 * refused or broken photo lands on.
 *
 * Deliberately never empty: a name of only punctuation or emoji yields `?`
 * rather than a blank square, because an agent you cannot point at is worse
 * than one with a boring monogram.
 */
export function initialsFor(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const letters = words
    .map((w) => Array.from(w).find((ch) => /\p{L}|\p{N}/u.test(ch)) ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('');
  return (letters || '?').toUpperCase();
}

/**
 * An agent's face: its photo when one resolves, its initials otherwise.
 *
 * `hasPhoto` comes from the server, which has already checked the file is
 * inside the photos directory and exists — but the `<img>` is STILL allowed to
 * fail into initials (`onError`), because a photo can be deleted between the
 * list response and the image request, and a broken-image glyph on a person's
 * face is the worst possible way to find that out.
 *
 * `version` busts the browser cache. A photo is replaced in place at a stable
 * URL, so without it an owner uploads a new picture and keeps seeing the old.
 */
export function AgentAvatar({
  slug,
  title,
  hasPhoto,
  size = 40,
  version,
}: {
  slug: string;
  title: string;
  hasPhoto: boolean;
  /** Rendered edge length in px. The card uses 40, the dialog 56, the
   *  popover 44 — the radius scales with it so a big one never reads as a
   *  different shape from a small one. */
  size?: number;
  version?: string | number;
}) {
  const { vault } = useVault();
  const [failed, setFailed] = useState(false);
  const style = {
    width: size,
    height: size,
    borderRadius: Math.round(size / 3.5),
    fontSize: Math.max(10, Math.round(size * 0.38)),
  };

  if (!hasPhoto || failed) {
    return (
      <span className="agent-av" style={style} aria-hidden="true">
        {initialsFor(title)}
      </span>
    );
  }
  return (
    <span className="agent-av" style={style}>
      <img
        src={automationPhotoUrl(vault, slug, version)}
        alt=""
        onError={() => setFailed(true)}
      />
    </span>
  );
}
