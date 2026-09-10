import { useCallback, useState } from 'react';
import { SettingChoice, SettingRow } from './SettingRow';
import type { SwitchStrategy, SwitchWeights } from '../../hooks/useAgentCapabilities';

/**
 * WHICH rule auto-switch uses to pick the next account, and — for the scoring rule — its
 * three coefficients.
 *
 * Extracted from `ClaudeAccounts` rather than left inline: the panel had crossed the
 * component size bar, and the coefficient logic below is the one genuinely stateful part of
 * that page. Everything it needs arrives as props, so it is a unit that can be reasoned about
 * (and broken) on its own.
 *
 * ── The saved value is tracked HERE, not read back off the query ──────────────────────
 * The obvious version of this component derives each commit's baseline from the fetched
 * `switchWeights`. That version silently loses data, and the sequence is ordinary use:
 *
 *   1. type in "5-hour window", blur → POST fires, `busy` set
 *   2. the POST resolves → `busy` clears and the fields re-enable, but the accounts query
 *      was only INVALIDATED, not awaited: its refetch is still in the air
 *   3. the user is already typing in "Weekly" → the draft is rebuilt from a `savedWeights`
 *      that still holds the OLD 5-hour number
 *   4. that commit POSTs all three, writing the just-saved 5-hour coefficient back to its
 *      previous value — no error, no warning, nothing on screen to notice
 *
 * So `committed` is advanced OPTIMISTICALLY the moment a commit is sent, and the fetched
 * value only adopts it when the server's answer changes to something we did not send.
 *
 * ── An optimistic value that is never rolled back is the SAME bug wearing a hat ───────
 * The first version of this fix advanced `committed` and then forgot about the request. When
 * the POST was REFUSED — an out-of-range coefficient, a dropped connection — the field went
 * on showing the rejected number as though it were saved, while the chooser kept using the
 * real one off disk. That is a state lie of exactly the kind the rest of this feature exists
 * to avoid, and nothing in the session healed it: the server value never changed, so the
 * re-seed below had no discrepancy to notice.
 *
 * `commit` therefore AWAITS the outcome and puts the previous value back when the write did
 * not land. `run` in the parent re-reads the register on failure too, so the query and this
 * component converge on the same truth rather than drifting apart.
 *
 * ── Only the CHANGED coefficients are sent ────────────────────────────────────────────
 * The route takes a partial patch, so a commit names only the fields the user actually
 * moved. That is not a size optimisation: sending all three means a value refreshed in this
 * window while a draft was open (another window, another machine) is overwritten by the
 * stale string sitting in that draft. A field nobody touched is a field nobody transmits.
 */
export function AccountSwitchPolicy({ strategy, savedWeights, busy, onSaveStrategy, onSaveWeights }: {
  strategy: SwitchStrategy;
  savedWeights: SwitchWeights;
  /**
   * The page's in-flight tag.
   *
   * Read NARROWLY for the number fields — see `fieldsBusy` below. Any non-empty value still
   * disables the radios, where there is nothing half-finished to lose.
   */
  busy: string;
  onSaveStrategy: (next: SwitchStrategy) => void;
  /** Resolves TRUE when the write landed. False means put the previous value back. */
  onSaveWeights: (patch: Partial<SwitchWeights>) => Promise<boolean>;
}) {
  /**
   * The last coefficients we SENT, which leads the query by one refetch. Seeded from the
   * server and re-seeded whenever the server's answer changes to something we did not just
   * send — so an edit made in another window still lands here.
   */
  const [committed, setCommitted] = useState<SwitchWeights>(savedWeights);
  const [lastServer, setLastServer] = useState<SwitchWeights>(savedWeights);
  // Adjusting state while rendering, on props change — React's documented pattern for this,
  // and idempotent under StrictMode's double invoke because it is a value comparison rather
  // than a counter. State rather than a ref: a rollback has to REPAINT the field.
  //
  // PER KEY, exactly like the optimistic write and the rollback below. A whole-object reseed
  // has the mirror of the bug those two were fixed for: our own write is in flight and about
  // to SUCCEED, a refetch lands carrying the server's not-yet-updated value for that field,
  // and the reseed snaps the field back to a number the server is a moment away from
  // replacing. Copying only the keys the server actually MOVED leaves an unconfirmed local
  // write alone while still adopting a genuine change from another window.
  if (!sameWeights(lastServer, savedWeights)) {
    const moved: Partial<SwitchWeights> = {};
    for (const k of WEIGHT_KEYS) if (lastServer[k] !== savedWeights[k]) moved[k] = savedWeights[k];
    setLastServer(savedWeights);
    setCommitted((c) => ({ ...c, ...moved }));
  }

  /**
   * Whether the NUMBER fields are disabled — only while their own write is in flight, never
   * for an unrelated one.
   *
   * Disabling a focused element blurs it, and blur is what commits. So a page-wide flag meant
   * a reorder, a usage refresh or a mode change fired mid-typing would force-commit whatever
   * half-typed digits were in the field: type "3" of an intended "35", click ↻, and 3 is
   * saved as the coefficient with no error and nothing on screen to notice. The radios keep
   * the page-wide flag because a radio has no half-finished state to lose.
   */
  const fieldsBusy = busy === 'weights';

  /**
   * What the user is typing, and the values it was BUILT FROM.
   *
   * ── Why the baseline travels with the draft ───────────────────────────────────────
   * `values` is held as STRINGS: round-tripping every keystroke through the server would
   * fight the user mid-number — deleting the last digit of "10" would save "1" and fetch it
   * straight back. A blur or Enter commits.
   *
   * `base` is what "changed" is measured against, and it is captured when the draft OPENS
   * rather than read live at commit time. That distinction is the whole correctness of the
   * partial patch: the re-seed above can move `committed` while a draft is open — that is
   * exactly its job when another window saves something — and a diff against the moved
   * baseline would mark a field the user never touched as changed, then POST the stale
   * string sitting in `values` over the newer value. The other window's save would vanish
   * with no error, which is the same silent loss this component has now been rebuilt around
   * twice. Against `base`, an untouched field is equal to what it was built from, so it is
   * never in the patch and never transmitted.
   */
  const [draft, setDraft] = useState<{ base: SwitchWeights; values: Record<keyof SwitchWeights, string> } | null>(null);
  const shown = draft?.values ?? {
    session: String(committed.session),
    weekly: String(committed.weekly),
    order: String(committed.order),
  };
  /** Start a draft (or extend the open one) without moving its baseline. */
  const edit = useCallback((key: keyof SwitchWeights, value: string) => {
    setDraft((prev) => ({
      base: prev?.base ?? committed,
      values: { ...(prev?.values ?? {
        session: String(committed.session),
        weekly: String(committed.weekly),
        order: String(committed.order),
      }), [key]: value },
    }));
  }, [committed]);

  /**
   * Commit the typed coefficients.
   *
   * A field left empty, or holding something that is not a number ≥ 0, REVERTS to the last
   * good value rather than being sent: the server would refuse it anyway (422), and showing
   * an error for a half-typed number is worse than putting the previous one back.
   */
  const commit = useCallback(async () => {
    if (!draft) return;
    setDraft(null);
    const parsed: SwitchWeights = {
      session: Number(draft.values.session),
      weekly: Number(draft.values.weekly),
      order: Number(draft.values.order),
    };
    const keys = Object.keys(parsed) as Array<keyof SwitchWeights>;
    if (!keys.every((k) => draft.values[k].trim() !== '' && Number.isFinite(parsed[k]) && parsed[k] >= 0)) return;

    // Against the draft's OWN baseline — see the note on `draft`. A field the user did not
    // touch equals what it was built from and is therefore never sent.
    const patch: Partial<SwitchWeights> = {};
    for (const k of keys) if (parsed[k] !== draft.base[k]) patch[k] = parsed[k];
    if (Object.keys(patch).length === 0) return;

    // What THESE keys were before, so a rollback can put back exactly what this request tried
    // to change and nothing else.
    const previous: Partial<SwitchWeights> = {};
    for (const k of Object.keys(patch) as Array<keyof SwitchWeights>) previous[k] = committed[k];

    // Functional updates throughout, and the PATCH KEYS ONLY — never a whole-object snapshot.
    // Two commits can be in flight at once (a slow one, then a fast one), and the query can
    // resync between them. A whole-object rollback would then restore a snapshot taken before
    // the second commit even ran, wiping a coefficient the server has already confirmed:
    //
    //   A: session 1→10, slow, will FAIL     B: weekly 2→20, fast, SUCCEEDS, refetch resyncs
    //   → A's rollback with a whole object puts weekly back to 2, which is now a lie.
    //
    // Restoring only `A`'s own keys leaves B's confirmed value where it is.
    setCommitted((c) => ({ ...c, ...patch }));   // BEFORE the request — see the note at the top.
    const ok = await onSaveWeights(patch);
    if (!ok) setCommitted((c) => ({ ...c, ...previous }));   // …and back, when it did not land.
  }, [committed, draft, onSaveWeights]);

  return (
    <SettingRow
      title="How the next account is picked"
      hint="Two different answers to what a second account is for."
      more="Spread the load scores every account that can serve — its 5-hour usage, its weekly usage and its place in this list combine into one number, and the lowest number takes the turn. It moves BEFORE a limit lands, so you rarely see a limit error, at the cost of every account being partly spent. Drain in order ignores usage entirely: the account at the top serves every turn until the API itself refuses one, then the next takes over. Each account gives a full window instead of a partial one, at the cost of one visible limit error per account per window — the held message is resent on the next account, never lost."
    >
      <div className="setting-choices" role="radiogroup" aria-label="How the next account is picked">
        <SettingChoice
          name="dc-acct-strategy"
          value="score"
          checked={strategy === 'score'}
          disabled={busy !== ''}
          onSelect={() => onSaveStrategy('score')}
          title="Spread the load (weighted score)"
          hint="One score per account from both windows and its place in the list. Moves before a limit lands."
        />
        <SettingChoice
          name="dc-acct-strategy"
          value="sequential"
          checked={strategy === 'sequential'}
          disabled={busy !== ''}
          onSelect={() => onSaveStrategy('sequential')}
          title="Drain in order"
          hint="The top account serves until the API actually refuses it, then the next one does. Usage percentages are ignored."
        />
      </div>

      {/* The coefficient fields sit OUTSIDE `SettingChoice` on purpose: it renders a <label>
          around its radio, and a nested label would hand every click on a number field back
          to the radio instead of focusing the field. */}
      {strategy === 'score' && (
        <div className="dc-acct-weights">
          {WEIGHT_FIELDS.map(({ key, label, note }) => (
            <div key={key} className="dc-acct-weight">
              <label className="dc-acct-weight-label" htmlFor={`dc-acct-w-${key}`}>{label}</label>
              <input
                id={`dc-acct-w-${key}`}
                aria-describedby={`dc-acct-w-${key}-note`}
                className="settings-text-input dc-acct-weight-input"
                type="number"
                min={0}
                step={0.5}
                value={shown[key]}
                disabled={fieldsBusy}
                onChange={(e) => edit(key, e.target.value)}
                onBlur={() => void commit()}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              <span className="dc-acct-weight-note" id={`dc-acct-w-${key}-note`}>{note}</span>
            </div>
          ))}
          {/* The formula written out with the numbers actually in the fields. A coefficient
              nobody can see the effect of is a coefficient nobody can set. */}
          <p className="dc-acct-weight-formula">
            score = {shown.session}·5-hour% + {shown.weekly}·weekly% + {shown.order}·place in list
            <span> — the lowest score serves the next turn.</span>
          </p>
        </div>
      )}
    </SettingRow>
  );
}

/** The chooser's own defaults, mirrored so a first paint has numbers before the fetch lands. */
export const DEFAULT_WEIGHTS: SwitchWeights = { session: 1, weekly: 2, order: 5 };

/** The three coefficient fields, each said in the terms the user is actually trading off. */
const WEIGHT_FIELDS: Array<{ key: keyof SwitchWeights; label: string; note: string }> = [
  { key: 'session', label: '5-hour window', note: 'Cost of a percent of the 5-hour window. It comes back in hours.' },
  { key: 'weekly', label: 'Weekly window', note: 'Cost of a percent of the week. It comes back in days — worth more.' },
  { key: 'order', label: 'Place in the list', note: 'What one step down this list is worth, in percentage points.' },
];

const WEIGHT_KEYS: Array<keyof SwitchWeights> = ['session', 'weekly', 'order'];

function sameWeights(a: SwitchWeights, b: SwitchWeights): boolean {
  return a.session === b.session && a.weekly === b.weekly && a.order === b.order;
}
