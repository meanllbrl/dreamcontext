import { useContext, useState } from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { agentPhotoUrl, automationPhotoUrl } from '../../api/client';
import { useVault } from '../../context/VaultContext';
import type { AgentFace } from '../../../../src/lib/agents/figure.js';
import { AgentFigure } from './AgentFigure';
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
 * An agent's face: its photo when one resolves, its FIGURE otherwise (AgentFigure: the stamped
 * `face`, else the bare hash of its slug). The initials above stay for surfaces with no slug.
 *
 * `hasPhoto` comes from the server, which has already checked the file is
 * inside the photos directory and exists — but the `<img>` is STILL allowed to
 * fail into initials (`onError`), because a photo can be deleted between the
 * list response and the image request, and a broken-image glyph on a person's
 * face is the worst possible way to find that out.
 *
 * `version` busts the browser cache. A photo is replaced in place at a stable
 * URL, so without it an owner uploads a new picture and keeps seeing the old.
 *
 * `of` says which route the slug names: `'automation'` (the default, every existing caller) reads
 * `/api/automations/:slug/photo`, `'agent'` reads `/api/agents/:slug/photo`. An agent you only
 * call has no automation file of its own slug, so the Agents page, the pickers and a task's
 * agent face pass `of="agent"`.
 */
export function AgentAvatar({
  slug,
  title: _title,
  hasPhoto,
  size = 40,
  version,
  of = 'automation',
  face,
}: {
  slug: string;
  title: string;
  hasPhoto: boolean;
  /** Rendered edge length in px. The card uses 40, the dialog 56, the
   *  popover 44 — the radius scales with it so a big one never reads as a
   *  different shape from a small one. */
  size?: number;
  version?: string | number;
  of?: 'agent' | 'automation';
  /** Its stamped figure; absent draws the bare hash of `slug`. */
  face?: AgentFace | null;
}) {
  const { vault } = useVault();
  const [failed, setFailed] = useState(false);
  // The stamped face, when the caller did not pass one: read from the agents/automations lists
  // already in the query cache (no fetch of its own; outside a query client, the bare hash).
  const qc = useContext(QueryClientContext);
  const stamped = face ?? cachedFace(qc, slug, of);
  const style = {
    width: size,
    height: size,
    borderRadius: Math.round(size / 3.5),
    fontSize: Math.max(10, Math.round(size * 0.38)),
  };

  if (!hasPhoto || failed) {
    // Decoration: the agent's name is always written beside its face.
    return (
      <span className="agent-av agent-av--figure" style={style} aria-hidden="true">
        <AgentFigure slug={slug} face={stamped} size={size} />
      </span>
    );
  }
  return (
    <span className="agent-av" style={style}>
      <img
        src={of === 'agent' ? agentPhotoUrl(vault, slug, version) : automationPhotoUrl(vault, slug, version)}
        alt=""
        onError={() => setFailed(true)}
      />
    </span>
  );
}

type FaceRow = { slug: string; face?: AgentFace };

/** A face from the lists the page already holds: an agent's for `of="agent"`, else the
 *  automation's (whose call-target rows are the agents themselves), else the agent of that slug. */
function cachedFace(qc: QueryClient | undefined, slug: string, of: 'agent' | 'automation'): AgentFace | null {
  if (!qc || !slug) return null;
  const find = (key: string): AgentFace | null =>
    (qc.getQueryData<FaceRow[]>([key]) ?? []).find((r) => r.slug === slug)?.face ?? null;
  return of === 'agent' ? find('agents') : find('automations') ?? find('agents');
}
