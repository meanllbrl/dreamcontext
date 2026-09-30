import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentDraft, AutomationMode, AutomationSummary, Weekday } from '../../hooks/useAutomations';
import {
  useAutomation,
  useCreateAgent,
  useDeleteAgent,
  useUpdateAgent,
  useUploadAgentPhoto,
} from '../../hooks/useAutomations';
import { PHOTO_PRESETS, renderPreset } from '../../lib/agentPhotoPresets';
import {
  DELETE_ARM_MS,
  deleteAction,
  initialSlotRows,
  nameFromDescription,
  newSlotRow,
  shouldPrefill,
  slotFromRow,
  slotsFromRows,
  timeFromDescription,
  type SlotCadence,
  type SlotRow,
} from '../../lib/agentDraft';
import { formatSchedule } from '../../../../src/lib/automations/schedule.js';
import { AgentAvatar, initialsFor } from './AgentAvatar';
import './AgentDialog.css';

/** The model list the composer offers, mirrored (the dashboard has no import
 *  path into the CLI's model registry). A closed dropdown, not a chip rail —
 *  K92: this is a VALUE axis, it does not change the shape of the form below
 *  it, so it must not cost a row of height that grows as the dialog narrows. */
const MODELS = ['opus', 'sonnet', 'fable', 'haiku'] as const;
const EFFORTS = ['low', 'medium', 'high'] as const;

/** Day chips, in the order a week is read. Short labels so seven fit one row
 *  at every dialog width. */
const DAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: 'Mo' },
  { key: 'tue', label: 'Tu' },
  { key: 'wed', label: 'We' },
  { key: 'thu', label: 'Th' },
  { key: 'fri', label: 'Fr' },
  { key: 'sat', label: 'Sa' },
  { key: 'sun', label: 'Su' },
];

/** The cadence a row can take — a closed dropdown (K92: it is a value on the
 *  row, and every choice keeps the row one line high). */
const CADENCES: { key: SlotCadence; label: string }[] = [
  { key: 'weekly', label: 'Every week' },
  { key: 'weeks', label: 'Every few weeks' },
  { key: 'monthdays', label: 'Days of the month' },
  { key: 'nth', label: 'A weekday of the month' },
  { key: 'cron', label: 'Cron' },
];

/**
 * One "when" row: cadence, its inputs, a time, and Remove when there is more
 * than one. Stateless — the dialog owns the rows, so the summary sentence and
 * the Save gate read the same list this draws.
 */
function SlotRowEditor({
  row,
  index,
  canRemove,
  onChange,
  onRemove,
  onTimeTouched,
}: {
  row: SlotRow;
  index: number;
  canRemove: boolean;
  onChange: (next: SlotRow) => void;
  onRemove: () => void;
  onTimeTouched: () => void;
}) {
  const set = (patch: Partial<SlotRow>) => onChange({ ...row, ...patch });
  const parsed = slotFromRow(row);
  const weekly = row.cadence === 'weekly' || row.cadence === 'weeks';
  const n = index + 1;
  return (
    <div className="agent-slot">
      <div className="agent-sched-row">
        <select
          className="agent-select agent-cadence"
          value={row.cadence}
          onChange={(e) => set({ cadence: e.target.value as SlotCadence })}
          aria-label={`How time ${n} repeats`}
        >
          {CADENCES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        {row.cadence === 'weeks' && (
          <span className="agent-inline">
            every
            <input
              className="agent-input agent-num"
              type="number"
              min={2}
              max={52}
              value={row.everyWeeks}
              onChange={(e) => set({ everyWeeks: Number(e.target.value) })}
              aria-label={`Weeks between fires, time ${n}`}
            />
            weeks, from
            <input
              className="agent-input agent-date"
              type="date"
              value={row.anchor}
              onChange={(e) => set({ anchor: e.target.value })}
              aria-label={`A day in the first week time ${n} fires`}
            />
          </span>
        )}
        {row.cadence === 'monthdays' && (
          <input
            className="agent-input agent-slot-text"
            value={row.monthText}
            onChange={(e) => set({ monthText: e.target.value })}
            placeholder="1, 15, last"
            aria-label={`Days of the month, time ${n}`}
          />
        )}
        {row.cadence === 'nth' && (
          <input
            className="agent-input agent-slot-text"
            value={row.nthText}
            onChange={(e) => set({ nthText: e.target.value })}
            placeholder="1st mon, last fri"
            aria-label={`Weekday of the month, time ${n}`}
          />
        )}
        {row.cadence === 'cron' && (
          <input
            className="agent-input agent-slot-text agent-slot-cron"
            value={row.cron}
            onChange={(e) => set({ cron: e.target.value })}
            placeholder="30 9 * * 1"
            aria-label={`Cron expression, time ${n} (minute hour day month weekday, local time)`}
          />
        )}
        {row.cadence !== 'cron' && (
          <input
            className="agent-input agent-time"
            type="time"
            value={row.at}
            onChange={(e) => { onTimeTouched(); set({ at: e.target.value }); }}
            aria-label={`Time of day, time ${n}`}
          />
        )}
        {canRemove && (
          <button type="button" className="agent-btn agent-slot-remove" onClick={onRemove} aria-label={`Remove time ${n}`}>
            Remove
          </button>
        )}
      </div>
      {weekly && (
        <div className="agent-chips agent-slot-days">
          {DAYS.map((d) => (
            <button
              key={d.key}
              type="button"
              className={`agent-chip agent-chip--day${row.days.includes(d.key) ? ' agent-chip--on' : ''}`}
              onClick={() => set({ days: row.days.includes(d.key) ? row.days.filter((x) => x !== d.key) : [...row.days, d.key] })}
              aria-pressed={row.days.includes(d.key)}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}
      {'error' in parsed && <p className="agent-slot-error">{parsed.error}</p>}
    </div>
  );
}

/**
 * What a create opens WITH: one of the first run's starter agents (C9). Name, prompt, mode and
 * schedule arrive filled in; the owner reads them, changes what they like, and approves.
 */
export interface AgentDialogInitial {
  title: string;
  description: string;
  mode: AutomationMode;
  days?: Weekday[];
  at?: string;
}

/**
 * New agent / Edit agent.
 *
 * ONE dialog for both, because they are the same form with two verbs — a
 * separate Edit dialog is how the two drift until a field exists in one and
 * not the other. `agent === null` is create; anything else is edit.
 *
 * Tilki rules this implements, and where:
 *  - K2  — every field is one 40px row, and Name · Model · Effort share a
 *          single row rather than stacking three.
 *  - K5  — the notes are 14px body size and one sentence, with the load-
 *          bearing words semibold. No 11px grey footnotes.
 *  - K8  — the accent appears on exactly three things: the primary button, an
 *          on switch, and the focus ring. A selected chip and a selected tab
 *          are a NEUTRAL surface with a strong border, never a tinted fill.
 *  - K15 — labels are sentence case at 14px semibold. No uppercase, no icons
 *          standing in for headings.
 *  - K18 — the schedule/on-call reveal animates height + opacity over 220ms
 *          in, 180ms out, and collapses to a plain fade under
 *          `prefers-reduced-motion`.
 *  - K92 — Model and Effort are closed dropdowns (values); mode and days are
 *          chips (they change what the form shows).
 */
export function AgentDialog({
  agent,
  onClose,
  onToast,
  onCreated,
  initial,
}: {
  /** null ⇒ create. */
  agent: AutomationSummary | null;
  onClose: () => void;
  onToast: (msg: string) => void;
  /** Fired after a CREATE lands (never after an edit), so the surface that
   *  opened this can show the owner the agent they just made rather than
   *  leaving them where they were. */
  onCreated?: (slug: string) => void;
  /** A create's starting values (a starter agent). Ignored on an edit. */
  initial?: AgentDialogInitial;
}) {
  const editing = agent !== null;
  const start = editing ? undefined : initial;

  const [title, setTitle] = useState(agent?.title ?? start?.title ?? '');
  // NEVER seeded from `agent.description` on an edit. That field is the list's 600-character
  // PREVIEW of the prompt, and seeding the field with it made "Save and re-approve" write the
  // preview back as the prompt: a 7,000-character manifest cut mid-word and approved as such
  // (2026-09-30, `tarif-korpus-haftalik`). An edit reads the manifest's full prompt from the
  // detail route and cannot be saved until it has.
  const [prompt, setPrompt] = useState(editing ? '' : start?.description ?? '');
  const detail = useAutomation(editing ? agent.slug : null, { fresh: true });
  // Fetched after THIS dialog mounted, never a cached copy: a manifest edited on disk since the
  // last read would otherwise be overwritten with the older prompt on save.
  const fullPrompt = detail.isFetchedAfterMount ? detail.data?.automation.prompt : undefined;
  const promptSeeded = useRef(!editing);
  useEffect(() => {
    if (promptSeeded.current || fullPrompt === undefined) return;
    promptSeeded.current = true;
    setPrompt(fullPrompt);
  }, [fullPrompt]);
  const promptReady = !editing || promptSeeded.current || fullPrompt !== undefined;
  const [mode, setMode] = useState<AutomationMode>(agent?.mode ?? start?.mode ?? 'sched');
  const [rows, setRows] = useState<SlotRow[]>(() =>
    initialSlotRows(agent?.schedule?.slots, agent ? undefined : start, new Date()));
  const [model, setModel] = useState(agent?.model ?? 'opus');
  const [effort, setEffort] = useState<string>(agent?.effort ?? 'medium');

  /** The photo bytes waiting to be uploaded once the slug exists, and a local
   *  object URL to preview them. `null` on an edit means "leave the existing
   *  photo alone" — not "clear it". */
  const [pendingPhoto, setPendingPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pickedPreset, setPickedPreset] = useState<number | null>(null);

  /**
   * Has the owner touched Name (or the time) themselves?
   *
   * The dialog pre-fills both from the plain-language description ONCE, then
   * stops — the task's "pre-filled from it once, never overwritten after the
   * owner edits". A field that keeps re-deriving itself is a field that eats
   * what you typed the moment you go back to fix a typo in the description.
   */
  // A starter's name and time were chosen for it, so they count as the owner's: editing its
  // description must not rename it to the description's first clause.
  const titleTouched = useRef(editing || !!start);
  const atTouched = useRef(editing || !!start?.at);

  const [armedDelete, setArmedDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createAgent = useCreateAgent();
  const updateAgent = useUpdateAgent();
  const deleteAgent = useDeleteAgent();
  const uploadPhoto = useUploadAgentPhoto();
  const busy = createAgent.isPending || updateAgent.isPending || uploadPhoto.isPending || deleteAgent.isPending;

  const fileRef = useRef<HTMLInputElement>(null);

  // A primed Delete disarms itself — an armed destructive button must never
  // outlive the glance that armed it.
  useEffect(() => {
    if (!armedDelete) return;
    const t = setTimeout(() => setArmedDelete(false), DELETE_ARM_MS);
    return () => clearTimeout(t);
  }, [armedDelete]);

  // Object URLs are revoked on replacement and on unmount — a dialog opened
  // and closed a dozen times must not leak a dozen blobs.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const initials = initialsFor(title || 'New agent');

  const setPhotoBlob = useCallback((blob: Blob, presetId: number | null) => {
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(blob);
    });
    setPendingPhoto(blob);
    setPickedPreset(presetId);
  }, []);

  /**
   * Derive Name and time from the description — but only for fields the owner
   * has not taken over, and only while creating. See `titleTouched`.
   */
  const handleDescription = (value: string) => {
    setPrompt(value);
    if (shouldPrefill({ touched: atTouched.current, editing })) {
      const found = timeFromDescription(value);
      if (found) setRows((cur) => cur.map((r, i) => (i === 0 ? { ...r, at: found } : r)));
    }
    if (shouldPrefill({ touched: titleTouched.current, editing })) {
      setTitle(nameFromDescription(value));
    }
  };

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Pick a PNG, JPEG, GIF or WebP image.');
      return;
    }
    setError(null);
    setPhotoBlob(file, null);
  };

  const pickPreset = (id: number) => {
    const preset = PHOTO_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    void renderPreset(preset, initials)
      .then((blob) => { setError(null); setPhotoBlob(blob, id); })
      .catch((err: Error) => setError(err.message));
  };

  /** Every row as a slot — the one list the summary, the Save gate and the
   *  draft all read, validated by the backend's own `parseSlot`. */
  const parsedSlots = useMemo(() => slotsFromRows(rows), [rows]);

  /** The one 14px sentence under the form — K5. Says what will actually
   *  happen, including that nothing runs until it is approved here. */
  const summary = useMemo(() => {
    const name = title.trim() || 'this agent';
    if (mode === 'call') {
      return (
        <>
          Runs only when you call it, as <b>{model}</b> at <b>{effort}</b> effort, and is approved on this Mac
          the moment you save.
        </>
      );
    }
    const when = 'error' in parsedSlots ? 'at no valid time yet' : formatSchedule({ slots: parsedSlots.slots });
    return (
      <>
        Runs <b>{when}</b> as <b>{model}</b> at <b>{effort}</b> effort, and nothing fires
        until {name} is approved on this Mac.
      </>
    );
  }, [mode, parsedSlots, model, effort, title]);

  const canSave = promptReady
    && title.trim().length > 0
    && prompt.trim().length > 0
    && (mode === 'call' || !('error' in parsedSlots));

  const draft: AgentDraft = {
    title: title.trim(),
    prompt: prompt.trim(),
    mode,
    ...(mode === 'sched' && !('error' in parsedSlots) ? { slots: parsedSlots.slots } : {}),
    model,
    effort: effort as AgentDraft['effort'],
  };

  /**
   * Save, then upload the photo.
   *
   * Strictly in that order and never the reverse: the photo is stored as
   * `<slug>.<ext>`, and on a create the slug does not exist until the manifest
   * does. A photo failure is reported but does NOT undo the save — an agent
   * with initials is a working agent, and rolling back a manifest the owner
   * just wrote because a picture would not encode is the wrong trade.
   */
  const save = () => {
    if (!canSave || busy) return;
    setError(null);
    const done = (saved: AutomationSummary, msg: string) => {
      onToast(msg);
      if (!editing) onCreated?.(saved.slug);
      onClose();
    };
    const savedMsg = (saved: AutomationSummary) =>
      editing ? `${saved.title}: saved and re-approved on this Mac.` : `${saved.title} joined your agents.`;

    const afterSave = (saved: AutomationSummary) => {
      if (!pendingPhoto) {
        done(saved, savedMsg(saved));
        return;
      }
      uploadPhoto.mutate({ slug: saved.slug, bytes: pendingPhoto }, {
        onSuccess: () => done(saved, savedMsg(saved)),
        // The agent IS saved — only its picture is not. Saying so and moving
        // on beats rolling back a manifest the owner just wrote.
        onError: (err) => done(saved, `${saved.title} was saved, but the photo did not upload — ${(err as Error).message}`),
      });
    };

    if (editing && agent) {
      updateAgent.mutate({ slug: agent.slug, draft }, {
        onSuccess: afterSave,
        onError: (err) => setError((err as Error).message),
      });
    } else {
      createAgent.mutate(draft, {
        onSuccess: afterSave,
        onError: (err) => setError((err as Error).message),
      });
    }
  };

  const remove = () => {
    if (!agent || busy) return;
    if (deleteAction(armedDelete) === 'arm') { setArmedDelete(true); return; }
    deleteAgent.mutate(agent.slug, {
      onSuccess: () => { onToast(`${agent.title} was deleted.`); onClose(); },
      onError: (err) => { setArmedDelete(false); setError((err as Error).message); },
    });
  };

  return (
    <div className="agent-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="agent-modal" role="dialog" aria-modal="true" aria-label={editing ? `Edit ${agent?.title}` : 'New agent'}>
        {/* K1: one title. The verb lives on the primary button, not in a
            second heading repeating it. */}
        <h2 className="agent-modal-title">{editing ? `Edit ${agent?.title}` : 'New agent'}</h2>

        <div className="agent-photo-row">
          {preview
            ? <span className="agent-av agent-photo-preview"><img src={preview} alt="" /></span>
            : <AgentAvatar slug={agent?.slug ?? ''} title={title || 'New agent'} hasPhoto={!!agent?.hasPhoto} size={56} />}
          <div className="agent-photo-side">
            <div className="agent-photo-controls">
              <button type="button" className="agent-btn" onClick={() => fileRef.current?.click()}>Upload photo</button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
              />
              <span className="agent-presets">
                {PHOTO_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`agent-preset${pickedPreset === p.id ? ' agent-preset--on' : ''}`}
                    style={{ background: p.bg, color: p.fg }}
                    onClick={() => pickPreset(p.id)}
                    aria-label={`Preset photo ${p.id + 1}`}
                    aria-pressed={pickedPreset === p.id}
                  >
                    {initials}
                  </button>
                ))}
              </span>
            </div>
            <p className="agent-note">The photo is how you recognise this agent in the list.</p>
          </div>
        </div>

        <label className="agent-field">
          <span className="agent-label">Describe it in plain language</span>
          <textarea
            className="agent-textarea"
            value={prompt}
            onChange={(e) => handleDescription(e.target.value)}
            readOnly={!promptReady}
            placeholder={promptReady
              ? "Her sabah 09:00'da dünkü PostHog insight'larını oku, 3 maddelik özet çıkar; düşüş varsa nedenini araştır."
              : detail.isError ? 'The prompt could not be read, so this agent cannot be saved from here.' : 'Reading the prompt…'}
            autoFocus={!editing}
          />
          <span className="agent-note">This becomes the prompt the run actually sends.</span>
        </label>

        {/* K2: three short fields, one 40px row — not three stacked rows.
            K92: Model and Effort are values, so they are closed dropdowns. */}
        <div className="agent-row3">
          <label className="agent-field">
            <span className="agent-label">Name</span>
            <input
              className="agent-input"
              value={title}
              onChange={(e) => { titleTouched.current = true; setTitle(e.target.value); }}
              placeholder="Daily insight digest"
            />
          </label>
          <label className="agent-field">
            <span className="agent-label">Model</span>
            <select className="agent-select" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="agent-field">
            <span className="agent-label">Effort</span>
            <select className="agent-select" value={effort} onChange={(e) => setEffort(e.target.value)}>
              {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
        </div>

        <div className="agent-field">
          <span className="agent-label">When does it run?</span>
          {/* K92: mode IS a mode — picking it changes the shape of the form
              below, so it stays two visible chips rather than a dropdown. */}
          <div className="agent-chips">
            <button
              type="button"
              className={`agent-chip${mode === 'sched' ? ' agent-chip--on' : ''}`}
              onClick={() => setMode('sched')}
              aria-pressed={mode === 'sched'}
            >
              On a schedule
            </button>
            <button
              type="button"
              className={`agent-chip${mode === 'call' ? ' agent-chip--on' : ''}`}
              onClick={() => setMode('call')}
              aria-pressed={mode === 'call'}
            >
              Only when I call it
            </button>
          </div>

          {/* K18: height + opacity, 220ms in / 180ms out, fade only under
              reduced motion. Both panes are always mounted so the transition
              has something to animate between. */}
          {/* `aria-hidden` + `inert` on the collapsed pane, not just the CSS
              clip: a 0fr grid row still leaves its contents in the tab order
              and in the accessibility tree, so a keyboard user would tab
              through seven day chips that are not on screen. */}
          <div
            className={`agent-reveal${mode === 'sched' ? ' agent-reveal--on' : ''}`}
            aria-hidden={mode !== 'sched'}
            inert={mode !== 'sched' ? true : undefined}
          >
            <div>
              {/* Several rows = several times; the agent fires at every one
                  of them (a union), and one agent keeps one prompt, one
                  thread and one lesson ledger across all of them. */}
              {rows.map((row, i) => (
                <SlotRowEditor
                  key={row.id}
                  row={row}
                  index={i}
                  canRemove={rows.length > 1}
                  onChange={(next) => setRows((cur) => cur.map((r) => (r.id === row.id ? next : r)))}
                  onRemove={() => setRows((cur) => cur.filter((r) => r.id !== row.id))}
                  onTimeTouched={() => { atTouched.current = true; }}
                />
              ))}
              <button
                type="button"
                className="agent-btn agent-slot-add"
                onClick={() => setRows((cur) => [...cur, newSlotRow(new Date(), { at: cur[cur.length - 1]?.at ?? '09:00' })])}
              >
                Add another time
              </button>
            </div>
          </div>

          <div
            className={`agent-reveal${mode === 'call' ? ' agent-reveal--on' : ''}`}
            aria-hidden={mode !== 'call'}
            inert={mode !== 'call' ? true : undefined}
          >
            <div>
              <p className="agent-note agent-note--reveal">
                It stays quiet until you run it yourself — <b>no schedule, and the dispatcher never fires it</b>.
              </p>
            </div>
          </div>
        </div>

        <p className="agent-summary">{summary}</p>

        {error && <p className="agent-error">{error}</p>}

        <div className="agent-modal-foot">
          {editing && (
            /* The `inline-two-click-confirm` pattern: first click relabels and
               arms, second commits, 5s disarms. No native confirm(), and the
               row never vanishes before the second click — the destructive
               control stays exactly where the finger already is. */
            <button
              type="button"
              className={`agent-btn agent-btn--danger${armedDelete ? ' agent-btn--armed' : ''}`}
              onClick={remove}
              disabled={busy}
            >
              {armedDelete ? 'Click again to delete' : 'Delete agent'}
            </button>
          )}
          <span className="agent-modal-spacer" />
          <button type="button" className="agent-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="agent-btn agent-btn--primary" onClick={save} disabled={!canSave || busy}>
            {busy
              ? 'Saving…'
              : editing ? 'Save and re-approve on this Mac' : 'Create and approve on this Mac'}
          </button>
        </div>
      </div>
    </div>
  );
}
