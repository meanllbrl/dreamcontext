import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { RequestError } from '../../api/client';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import type { AgentAutonomy } from '../../hooks/useAgents';
import type { PermissionRuleView } from '../../lib/superTypes';
import { visibleText } from '../sleepy/super/ownerAnswer';

/**
 * A member's Permissions on its profile (uye-bildirim, drawing C1/C2): its Autonomy level, when a
 * change to it takes effect, and the "Always allowed" rules the owner gave it from a permission
 * card or Telegram, each removable. The rules are machine-local and owner-only: the list is read
 * from the server (the rule text already redacted there) and a removal carries the owner key, so a
 * plain browser is told it can only be changed in the app. Nothing here writes a rule: a rule is
 * born only from his tap on a card that showed the command.
 */

/** What `GET /api/agents/:slug/permissions` answers (contracts-w5). */
export interface MemberPermissions {
  level: string;
  rules: PermissionRuleView[];
  applies: { narrowing: 'now' | 'next_session'; widening: 'next_session' };
}

const ORDER: readonly AgentAutonomy[] = ['ask', 'balanced', 'free'];

/**
 * The line for a level the owner picked but has not saved: a stricter one reaches a running member
 * at once where the live mode switch allows it, a freer one only from its next session. Null when
 * nothing changes (or either level is unknown).
 */
export function levelChangeKey(stored: string, chosen: string, applies: MemberPermissions['applies'] | null): string | null {
  const from = ORDER.indexOf(stored as AgentAutonomy);
  const to = ORDER.indexOf(chosen as AgentAutonomy);
  if (from < 0 || to < 0 || from === to) return null;
  if (to < from) return applies?.narrowing === 'now' ? 'agents.permissions.narrowNow' : 'agents.permissions.narrowNext';
  return 'agents.permissions.widen';
}

/** A well-formed answer, or null (an older server, a refused read): never half a list. */
export function readMemberPermissions(v: unknown): MemberPermissions | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.level !== 'string' || !Array.isArray(o.rules)) return null;
  const rules = o.rules.filter((r): r is PermissionRuleView => !!r && typeof r === 'object'
    && typeof (r as PermissionRuleView).id === 'string' && typeof (r as PermissionRuleView).rule === 'string'
    && typeof (r as PermissionRuleView).createdAt === 'number');
  const a = o.applies as Record<string, unknown> | undefined;
  return {
    level: o.level,
    rules,
    applies: { narrowing: a?.narrowing === 'now' ? 'now' : 'next_session', widening: 'next_session' },
  };
}

type PermissionsApi = { get<T>(path: string): Promise<T>; ownerPost<T>(path: string, body: unknown): Promise<T> };

/** Read a member's permissions; null when the server answered nothing usable or failed. */
export async function loadMemberPermissions(api: PermissionsApi, slug: string): Promise<MemberPermissions | null> {
  try { return readMemberPermissions(await api.get<unknown>(`/agents/${encodeURIComponent(slug)}/permissions`)); } catch { return null; }
}

/** Remove one rule with the owner key. `app_only`: this window holds no owner key (a plain
 *  browser, an older shell), so only the app can change it. */
export async function removeMemberRule(api: PermissionsApi, slug: string, id: string): Promise<'ok' | 'app_only' | 'failed'> {
  try {
    await api.ownerPost(`/agents/${encodeURIComponent(slug)}/permissions/remove`, { id });
    return 'ok';
  } catch (e) {
    return e instanceof RequestError && (e.status === 403 || e.code === 'owner_page_only') ? 'app_only' : 'failed';
  }
}

export function AgentPermissionsSection({ slug, name, chosenLevel, levelControl }: {
  slug: string;
  /** The dialog's own level switch (Ask / Balanced / Free, drawing C1), drawn at the top of the
   *  section; the section never keeps a level of its own. */
  levelControl?: ReactNode;
  /** The member's title, for the sentences ("When Fisher asks…"). */
  name: string;
  /** The level picked in the dialog right now (unsaved), to say when it would take effect. */
  chosenLevel?: string;
}) {
  const api = useApi();
  const [data, setData] = useState<MemberPermissions | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await loadMemberPermissions(api, slug);
    setData(r);
    setFailed(!r);
  }, [api, slug]);

  useEffect(() => { void load(); }, [load]);

  const remove = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setNote(null);
    const r = await removeMemberRule(api, slug, id);
    // Read again, never trimmed by hand: the server's list is the truth.
    if (r === 'ok') await load();
    else setNote(r === 'app_only' ? 'agents.permissions.appOnly' : 'agents.permissions.removeFailed');
    setBusy(null);
  };

  return <PermissionsBody data={data} failed={failed} busy={busy} note={note} name={name} chosenLevel={chosenLevel} levelControl={levelControl} onRemove={(id) => { void remove(id); }} />;
}

/** What the section draws from what it read (drawing C1 with rules, C2 without). */
export function PermissionsBody({ data, failed, busy, note, name, chosenLevel, levelControl, onRemove }: {
  data: MemberPermissions | null;
  failed: boolean;
  busy: string | null;
  note: string | null;
  name: string;
  chosenLevel?: string;
  /** The level switch to draw in place of the plain "Autonomy: …" line. */
  levelControl?: ReactNode;
  onRemove: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const when = (at: number) => {
    try { return new Date(at).toLocaleDateString(locale === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short' }); } catch { return ''; }
  };
  const change = data && chosenLevel ? levelChangeKey(data.level, chosenLevel, data.applies) : null;

  return (
    <section className="aid-autonomy" data-testid="agent-permissions" aria-labelledby="aid-permissions-title">
      <span className="aid-label" id="aid-permissions-title">{t('agents.permissions.title')}</span>
      {levelControl ?? (data && (
        <p className="aid-note" data-testid="agent-permissions-level">
          {t('aiteam.autonomy.label').replace('{level}', t(`aiteam.autonomy.${data.level}`))}
        </p>
      ))}
      {change && <p className="aid-note" data-testid="agent-permissions-applies" data-change={change}>{t(change)}</p>}

      <span className="aid-label">{t('agents.permissions.always')}</span>
      {failed && <p className="aid-note" data-testid="agent-permissions-failed">{t('agents.permissions.loadFailed')}</p>}
      {data && data.rules.length === 0 && (
        <p className="aid-note" data-testid="agent-permissions-empty">{t('agents.permissions.empty').replace('{name}', name)}</p>
      )}
      {data && data.rules.length > 0 && (
        <ul className="aid-global-list" data-testid="agent-permissions-rules">
          {data.rules.map((r) => (
            <li key={r.id} className="aid-global-row" data-testid="agent-permissions-rule" data-rule={r.id}>
              <div className="aid-global-text">
                {/* Redacted by the server; control and bidi characters drawn as escapes here too. */}
                <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)', wordBreak: 'break-all' }}>{visibleText(r.rule)}</code>
                <span className="aid-note">
                  {t('agents.permissions.script')} {when(r.createdAt) && t('agents.permissions.added').replace('{date}', when(r.createdAt))}
                </span>
              </div>
              <button
                type="button"
                className="aid-btn"
                data-testid="agent-permissions-remove"
                disabled={busy !== null}
                onClick={() => onRemove(r.id)}
              >{busy === r.id ? t('agents.permissions.removing') : t('agents.permissions.remove')}</button>
            </li>
          ))}
        </ul>
      )}
      {data && data.rules.length > 0 && <p className="aid-note">{t('agents.permissions.removeNote').replace('{name}', name)}</p>}
      {note && <p className="aid-error" role="alert" data-testid="agent-permissions-note">{t(note)}</p>}
    </section>
  );
}
