import { useEffect, useRef, useState } from 'react';
import { RequestError } from '../../api/client';
import { useI18n } from '../../context/I18nContext';
import {
  useAgent,
  useCreateAgentIdentity,
  useUpdateAgentIdentity,
  useUploadAgentIdentityPhoto,
  type AgentAutonomy,
  type AgentEffort,
  type AgentIdentityPatch,
  type AgentSummary,
} from '../../hooks/useAgents';
import { useWhiteboardList } from '../../hooks/useWhiteboards';
import { SOUL_MAX_CHARS, SOUL_TEMPLATES, normalizeSoul, soulProblem, soulTemplate, type SoulTemplateId } from '../../generated/soul-templates';
import { AgentAvatar } from './AgentAvatar';
import { tx } from './AgentRosterCard';
import './AgentIdentityDialog.css';

/** The model list, mirrored like every composer in the dashboard (no import path into the CLI's
 *  registry). `''` is "no model of its own": the agent runs on Claude's default. */
const MODELS = ['opus', 'sonnet', 'fable', 'haiku'] as const;
const EFFORTS: readonly AgentEffort[] = ['low', 'medium', 'high'];

/** What the form holds. Strings for the selects, `''` meaning "none / the default". */
export interface IdentityForm {
  title: string;
  prompt: string;
  model: string;
  effort: '' | AgentEffort;
  whiteboard: string;
  learning: boolean;
  /** How it works, free text. `''` is no soul (the default); a template only fills this. */
  soul: string;
  /** How much it decides alone; sets the permission mode of its sessions. Edit only. */
  autonomy: AgentAutonomy;
}

const AUTONOMY_LEVELS: readonly AgentAutonomy[] = ['ask', 'balanced', 'free'];

/** A new agent's form: blank, and learning on (the store's own default for a new agent). */
export const EMPTY_IDENTITY_FORM: IdentityForm = {
  title: '', prompt: '', model: '', effort: '', whiteboard: '', learning: true, soul: '', autonomy: 'balanced',
};

/** A new agent's form, with its home board preset when the create was asked for from a board. */
export function createForm(whiteboard?: string | null): IdentityForm {
  return whiteboard ? { ...EMPTY_IDENTITY_FORM, whiteboard } : EMPTY_IDENTITY_FORM;
}

/** The form an edit starts from: exactly what the agent is now. `soul` is the FULL soul from the
 *  detail read (`AgentDetail.soul`), never the roster's `soulExcerpt`: writing back a preview
 *  would cut the soul short. */
export function formFromAgent(agent: AgentSummary, prompt: string, learning: boolean, soul = ''): IdentityForm {
  return {
    title: agent.title,
    prompt,
    model: agent.model ?? '',
    effort: agent.effort ?? '',
    whiteboard: agent.whiteboard ?? '',
    learning,
    soul,
    autonomy: agent.autonomy ?? 'balanced',
  };
}

/** The first thing stopping a save, as an i18n key, or null when the form can be saved. */
export function identityFormError(form: IdentityForm): string | null {
  if (!form.title.trim()) return 'agents.identity.nameRequired';
  if (!form.prompt.trim()) return 'agents.identity.promptRequired';
  // The one rule the CLI and the API apply too (the mirrored `soulProblem`).
  const soul = soulProblem(form.soul);
  if (soul === 'too-long') return 'agents.identity.soulTooLong';
  if (soul === 'heading-line') return 'agents.identity.soulHeadingLine';
  return null;
}

/**
 * Start the soul from a template: REPLACES the text with the template's, and hands back what was
 * there so the dialog can offer Undo. Nothing records the pick; the template is only text.
 */
export function applySoulTemplate(form: IdentityForm, id: SoulTemplateId): { form: IdentityForm; previous: string } {
  const template = soulTemplate(id);
  if (!template) return { form, previous: form.soul };
  return { form: { ...form, soul: template.text }, previous: form.soul };
}

/**
 * Only what the owner CHANGED. An edit that sends a field it did not touch would re-write it, and
 * re-writing an unchanged prompt is how a stale copy overwrites a newer one; a field left out is
 * never blanked (`AgentIdentityPatch`).
 */
export function identityPatch(before: IdentityForm, after: IdentityForm): AgentIdentityPatch {
  const patch: AgentIdentityPatch = {};
  if (after.title.trim() !== before.title.trim()) patch.title = after.title.trim();
  if (after.prompt.trim() !== before.prompt.trim()) patch.prompt = after.prompt.trim();
  if (after.model !== before.model) patch.model = after.model || null;
  if (after.effort !== before.effort) patch.effort = after.effort || null;
  if (after.whiteboard !== before.whiteboard) patch.whiteboard = after.whiteboard || null;
  if (after.learning !== before.learning) patch.learning = after.learning;
  if (after.soul.trim() !== before.soul.trim()) patch.soul = after.soul.trim();
  if (after.autonomy !== before.autonomy) patch.autonomy = after.autonomy;
  return patch;
}

/** A save failure in the owner's words: the truncation refusal gets its own sentence. */
export function identityErrorKey(err: unknown): 'agents.identity.truncated' | 'agents.identity.failed' {
  return err instanceof RequestError && err.code === 'prompt_truncated'
    ? 'agents.identity.truncated'
    : 'agents.identity.failed';
}

/**
 * Create an agent, or edit one's identity: name, photo, its job (the prompt), its soul (how it
 * works), model, effort, home board, learning. Call settings are never edited here (they are shown read-only on the
 * profile). An edit reads the agent FRESH before it allows a save, so the prompt it writes back
 * is the whole prompt, never a preview.
 */
export function AgentIdentityDialog({
  slug, whiteboard, onClose, onSaved, inline = false, initial, onDraftTitle, note, submitLabel,
}: {
  /** The agent to edit, or null to create one. */
  slug: string | null;
  /** Create only: the home board to start with (a board's "New agent"). Still changeable. */
  whiteboard?: string;
  onClose: () => void;
  /** After a save (and the photo, when one was picked). `message` is the toast to show. */
  onSaved: (slug: string, message: string) => void;
  /** Drawn in the page (AI Team's new teammate) rather than as a modal over it. */
  inline?: boolean;
  /** Create only: a starter's name and job, filled in. */
  initial?: Partial<Pick<IdentityForm, 'title' | 'prompt'>>;
  /** Create only: the name as it is typed, for the draft row in the team list. */
  onDraftTitle?: (title: string) => void;
  /** Replaces the call-settings note (AI Team: where a schedule comes from). */
  note?: string;
  /** Replaces the create button's words (AI Team: "Add to team"). */
  submitLabel?: string;
}) {
  const { t } = useI18n();
  const editing = slug !== null;
  const detail = useAgent(slug, { fresh: true });
  const boards = useWhiteboardList();
  const create = useCreateAgentIdentity();
  const update = useUpdateAgentIdentity();
  const upload = useUploadAgentIdentityPhoto();
  const busy = create.isPending || update.isPending || upload.isPending;

  const [form, setForm] = useState<IdentityForm>(() => (editing ? EMPTY_IDENTITY_FORM : { ...createForm(whiteboard), ...initial }));
  const draftTitle = useRef(onDraftTitle);
  draftTitle.current = onDraftTitle;
  useEffect(() => { if (!editing) draftTitle.current?.(form.title); }, [editing, form.title]);
  const [original, setOriginal] = useState<IdentityForm | null>(editing ? null : EMPTY_IDENTITY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  /** After a template replaced text the owner had: what to put back, and the template's name. */
  const [soulUndo, setSoulUndo] = useState<{ previous: string; name: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // An edit starts from the agent as it is right now, once, when the fresh read lands.
  useEffect(() => {
    if (!editing || original || !detail.data) return;
    const start = formFromAgent(detail.data.agent, detail.data.prompt, detail.data.learning, detail.data.soul ?? '');
    setOriginal(start);
    setForm(start);
  }, [editing, original, detail.data]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  useEffect(() => {
    // Drawn in the page, the form owns no overlay: Esc elsewhere on the page (a menu, a picker)
    // must not throw away what was typed. Cancel is the way out there.
    if (inline) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy, inline]);

  const ready = original !== null;
  const blocker = identityFormError(form);
  const agentTitle = detail.data?.agent.title ?? '';
  const heading = editing
    ? t('agents.identity.editTitle').replace('{name}', agentTitle)
    : t('agents.identity.createTitle');

  const set = <K extends keyof IdentityForm>(key: K, value: IdentityForm[K]) => {
    setForm((cur) => ({ ...cur, [key]: value }));
  };

  const pickTemplate = (id: SoulTemplateId, name: string) => {
    const { form: next, previous } = applySoulTemplate(form, id);
    setForm(next);
    setSoulUndo(previous.trim() && previous !== next.soul ? { previous, name } : null);
  };

  const undoTemplate = () => {
    if (!soulUndo) return;
    set('soul', soulUndo.previous);
    setSoulUndo(null);
  };

  const soulLength = normalizeSoul(form.soul).length;
  /** The soul's own refusal, shown at the field whatever else still blocks the save. */
  const soulError = identityFormError({ ...form, title: 'x', prompt: 'x' });

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError(tx(t, 'agents.identity.photoType', 'Pick a PNG, JPEG, GIF or WebP image.'));
      return;
    }
    setError(null);
    setPhoto(file);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
  };

  /** Save first, then the photo: a new agent has no slug to store a photo under until it exists.
   *  A photo failure is reported, never rolled back: an agent with initials is a working agent. */
  const finish = (saved: AgentSummary) => {
    const message = (editing ? t('agents.identity.saved') : t('agents.identity.created')).replace('{name}', saved.title);
    if (!photo) {
      onSaved(saved.slug, message);
      return;
    }
    upload.mutate({ slug: saved.slug, bytes: photo }, {
      onSuccess: () => onSaved(saved.slug, message),
      onError: (err) => onSaved(saved.slug, t('agents.identity.photoFailed').replace('{reason}', (err as Error).message)),
    });
  };

  const fail = (err: unknown) => {
    const key = identityErrorKey(err);
    setError(key === 'agents.identity.truncated' ? t(key) : t(key).replace('{reason}', (err as Error).message));
  };

  const save = () => {
    if (!ready || busy) return;
    if (blocker) { setError(t(blocker)); return; }
    setError(null);
    if (editing && slug && original) {
      const patch = identityPatch(original, form);
      if (Object.keys(patch).length === 0) {
        if (!photo) { onClose(); return; }
        // Only the photo changed: the summary we already hold is the one to upload against.
        finish(detail.data!.agent);
        return;
      }
      update.mutate({ slug, patch }, { onSuccess: finish, onError: fail });
      return;
    }
    create.mutate({
      title: form.title.trim(),
      prompt: form.prompt.trim(),
      model: form.model || null,
      effort: form.effort || null,
      whiteboard: form.whiteboard || null,
      learning: form.learning,
      ...(form.soul.trim() ? { soul: form.soul.trim() } : {}),
    }, { onSuccess: finish, onError: fail });
  };

  const boardList = boards.data ?? [];
  const boardMissing = form.whiteboard && !boardList.some((b) => b.slug === form.whiteboard);

  return (
    <div
      className={inline ? 'aid-inline' : 'aid-scrim'}
      onClick={inline ? undefined : (e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="aid-modal" role={inline ? 'form' : 'dialog'} aria-modal={inline ? undefined : true} aria-label={heading}>
        {!inline && <h2 className="aid-title">{heading}</h2>}

        {editing && detail.isError && <p className="aid-error" role="alert">{t('agents.page.loadFailed')}</p>}

        <div className="aid-photo">
          {preview
            ? <span className="aid-photo-preview"><img src={preview} alt="" /></span>
            : (
              <AgentAvatar
                of="agent"
                slug={slug ?? ''}
                title={form.title || t('agents.identity.createTitle')}
                hasPhoto={!!detail.data?.agent.hasPhoto}
                size={56}
              />
            )}
          <div className="aid-photo-side">
            <span className="aid-label">{t('agents.identity.photo')}</span>
            <button type="button" className="aid-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
              {t('agents.profile.changePhoto')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
            />
          </div>
        </div>

        <label className="aid-field">
          <span className="aid-label">{t('agents.identity.name')}</span>
          <input
            className="aid-input"
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder={t('agents.identity.namePlaceholder')}
            readOnly={!ready}
            autoFocus={!editing}
          />
        </label>

        <label className="aid-field">
          <span className="aid-label">{t('agents.identity.prompt')}</span>
          <textarea
            className="aid-textarea"
            value={form.prompt}
            onChange={(e) => set('prompt', e.target.value)}
            placeholder={ready ? t('agents.identity.promptPlaceholder') : t('agents.page.loading')}
            readOnly={!ready}
          />
          <span className="aid-note">{t('agents.identity.promptHint')}</span>
        </label>

        {/* The soul: how it works. A template only fills the text (with Undo); no chip stays
            selected and nothing about the pick is sent or stored. Empty is the default. */}
        <div className="aid-field" data-soul-field>
          <label className="aid-label" htmlFor="aid-soul">{t('agents.identity.soul')}</label>
          <div className="aid-soul-start" role="group" aria-label={t('agents.identity.soulStartFrom')}>
            <span className="aid-note">{t('agents.identity.soulStartFrom')}</span>
            {SOUL_TEMPLATES.map((tpl) => {
              const label = tx(t, `agents.soul.template.${tpl.id}`, tpl.label);
              return (
                <button
                  key={tpl.id}
                  type="button"
                  className="aid-chip"
                  onClick={() => pickTemplate(tpl.id, label)}
                  disabled={!ready}
                  data-soul-template={tpl.id}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <textarea
            id="aid-soul"
            className="aid-textarea"
            value={form.soul}
            onChange={(e) => { setSoulUndo(null); set('soul', e.target.value); }}
            placeholder={ready ? t('agents.identity.soulPlaceholder') : t('agents.page.loading')}
            readOnly={!ready}
            data-soul-input
          />
          <div className="aid-soul-foot">
            {soulUndo ? (
              <span className="aid-note aid-soul-undo" role="status">
                {t('agents.identity.soulReplaced').replace('{name}', soulUndo.name)}
                <button type="button" className="aid-textbtn" onClick={undoTemplate} data-soul-undo>
                  {t('agents.identity.soulUndo')}
                </button>
              </span>
            ) : (
              <span className="aid-note">{t('agents.identity.soulHint')}</span>
            )}
            <span
              className={`aid-note aid-count${soulLength > SOUL_MAX_CHARS ? ' aid-count--over' : ''}`}
              data-soul-count
            >
              {soulLength}/{SOUL_MAX_CHARS}
            </span>
          </div>
          {soulError && <p className="aid-error" role="alert" data-soul-error>{t(soulError)}</p>}
        </div>

        <div className="aid-row">
          <label className="aid-field">
            <span className="aid-label">{t('agents.identity.model')}</span>
            <select className="aid-select" value={form.model} onChange={(e) => set('model', e.target.value)} disabled={!ready}>
              <option value="">{t('agents.profile.modelDefault')}</option>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              {form.model && !(MODELS as readonly string[]).includes(form.model) && (
                <option value={form.model}>{form.model}</option>
              )}
            </select>
          </label>
          <label className="aid-field">
            <span className="aid-label">{t('agents.identity.effort')}</span>
            <select
              className="aid-select"
              value={form.effort}
              onChange={(e) => set('effort', e.target.value as IdentityForm['effort'])}
              disabled={!ready}
            >
              <option value="">{t('agents.profile.effortDefault')}</option>
              {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          <label className="aid-field">
            <span className="aid-label">{t('agents.identity.board')}</span>
            <select className="aid-select" value={form.whiteboard} onChange={(e) => set('whiteboard', e.target.value)} disabled={!ready}>
              <option value="">{t('agents.identity.noBoard')}</option>
              {boardList.filter((b) => !b.corrupt).map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
              {boardMissing && <option value={form.whiteboard}>{form.whiteboard}</option>}
            </select>
          </label>
        </div>

        <label className="aid-check">
          <input
            type="checkbox"
            checked={form.learning}
            onChange={(e) => set('learning', e.target.checked)}
            disabled={!ready}
          />
          <span>{t('agents.identity.learning')}</span>
        </label>

        {editing && !detail.data?.agent.implicit && (
          <fieldset className="aid-autonomy" disabled={!ready}>
            <legend className="aid-label">{t('aiteam.autonomy.title')}</legend>
            <div className="aid-segmented" role="radiogroup" aria-label={t('aiteam.autonomy.title')}>
              {AUTONOMY_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={form.autonomy === level}
                  className={`aid-segment${form.autonomy === level ? ' is-on' : ''}`}
                  onClick={() => set('autonomy', level)}
                  data-autonomy={level}
                >
                  {t(`aiteam.autonomy.${level}`)}
                </button>
              ))}
            </div>
            <ul className="aid-autonomy-lines">
              {AUTONOMY_LEVELS.map((level) => (
                <li key={level} className={form.autonomy === level ? 'is-on' : undefined}>
                  <b>{t(`aiteam.autonomy.${level}`)}</b> {t(`aiteam.autonomy.${level}.desc`)}
                </li>
              ))}
            </ul>
          </fieldset>
        )}

        <p className="aid-note">{note ?? t('agents.identity.callSettingsNote')}</p>

        {error && <p className="aid-error" role="alert">{error}</p>}

        <div className="aid-foot">
          <button type="button" className="aid-btn" onClick={onClose} disabled={busy}>{t('agents.identity.cancel')}</button>
          <button type="button" className="aid-btn aid-btn--primary" onClick={save} disabled={!ready || busy || !!blocker}>
            {busy ? t('agents.identity.saving') : editing ? t('agents.identity.save') : submitLabel ?? t('agents.identity.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
