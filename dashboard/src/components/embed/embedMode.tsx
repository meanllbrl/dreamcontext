import { createContext, useContext, type ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import { buildAppLink, type AppLinkPage } from '../../lib/appLink';
import type { EmbedGrant } from '../../lib/frameGuard';

/**
 * A dreamcontext screen drawn inside an app's window (dreamcontext-apps plan r19, W4). The screen
 * is the real one. What leaves is everything that decides for the owner: approving an agent,
 * answering a question, running, assigning, enabling, deleting, editing. Each of those becomes a
 * link to the main app, so an app's window can show the work and never act as the owner.
 */
const EmbedContext = createContext<EmbedGrant | null>(null);

export const EmbedProvider = EmbedContext.Provider;

/** The embed grant, or null in every ordinary window. */
export function useEmbed(): EmbedGrant | null {
  return useContext(EmbedContext);
}

export function openInMainHref(vault: string, page: AppLinkPage, id: string | null = null): string {
  return buildAppLink({ kind: 'page', vault, page, id });
}

/** `target="_blank"`: the runner hands a `dreamcontext://` link to macOS, which opens the app. */
export function OpenInMainApp({ grant, page, id = null, children }: {
  grant: EmbedGrant;
  page: AppLinkPage;
  id?: string | null;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <a className="embed-open-main" href={openInMainHref(grant.vault, page, id)} target="_blank" rel="noreferrer" data-embed-open-main>
      {children ?? t('embed.openInMain')}
    </a>
  );
}

/** The embedded chat's send. A person typed it; the app's window delivers it, as the app. */
export async function sayFromApp(grant: EmbedGrant, member: string, text: string): Promise<void> {
  const r = await fetch(`/api/apps/${encodeURIComponent(grant.slug)}/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': grant.vault, 'x-dc-embed': grant.tk },
    body: JSON.stringify({ member, text }),
  });
  if (r.ok) return;
  const body = await r.json().catch(() => null) as { message?: string; error?: string } | null;
  throw new Error(body?.message ?? body?.error ?? 'The message was not delivered.');
}
