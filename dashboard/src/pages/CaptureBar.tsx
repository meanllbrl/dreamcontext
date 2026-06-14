import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, setActiveVault } from '../api/client';
import { closeSelf, onSleepyFocusChange } from '../lib/sleepy';
import './CaptureBar.css';

marked.setOptions({ gfm: true, breaks: true });

/** Render Claude's reply/answer markdown to sanitized HTML for the panel. */
function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(marked.parse(src) as string);
}

interface Vault {
  name: string;
  path: string;
  exists?: boolean;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';
type Mode = 'idle' | 'sleepy' | 'sleeps';
/** Capture mode: 'learn' saves + enriches; 'ask' is one-shot Q&A; 'sleep' runs
 *  a full memory consolidation. */
type CapMode = 'learn' | 'ask' | 'sleep';
/** Background Claude run, surfaced as a spinner + its response. */
type EnrichState = 'running' | 'done' | 'error' | 'unknown';
interface Enrich {
  state: EnrichState;
  output: string;
  /** Which mode produced this run — drives the spinner/heading copy. */
  mode: CapMode;
}

const LAST_VAULT_KEY = 'sleepy:lastVault';
/** Max textarea height (px) — roughly 5 lines before it scrolls. */
const MAX_INPUT_H = 120;

/** Map a project's sleep debt to a mascot mood. */
function modeForDebt(debt: number): Mode {
  if (debt >= 10) return 'sleeps';
  if (debt >= 4) return 'sleepy';
  return 'idle';
}

/**
 * The notch quick-capture companion. A black panel hangs from the notch with the
 * Sleepy mascot (its mood follows the selected project's sleep debt); below it an
 * input bar captures a thought into that project. Esc closes.
 */
export function CaptureBar() {
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vault, setVault] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errMsg, setErrMsg] = useState('');
  const [capMode, setCapMode] = useState<CapMode>('learn');
  const [enrich, setEnrich] = useState<Enrich | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Active enrichment poll timer, so a new capture cancels the previous poll.
  const pollRef = useRef<number | null>(null);
  // True while the user is interacting with the native project dropdown — its
  // popup must not trip the close-on-blur dismiss below.
  const pickerActiveRef = useRef(false);
  // True while a consolidation is running — keep the window open (don't dismiss
  // on blur) so the user can step away and come back to the result.
  const sleepingRef = useRef(false);

  // Auto-grow the textarea from 1 line up to ~5 lines, then let it scroll.
  function autoGrow(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_H)}px`;
  }

  // Transparent window: drop the page background so only our panels show.
  useEffect(() => {
    const html = document.documentElement;
    const prevHtml = html.style.background;
    const prevBody = document.body.style.background;
    html.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      html.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, []);

  useEffect(() => {
    api
      .get<{ vaults: Vault[] }>('/vaults')
      .then((d) => {
        // Drop vaults whose folder is gone (deleted/moved) — capturing into a
        // missing path only fails. If they're ALL dead, keep the list so the
        // user still sees something rather than an empty picker.
        const live = d.vaults.filter((v) => v.exists !== false);
        const list = live.length > 0 ? live : d.vaults;
        setVaults(list);
        const last = localStorage.getItem(LAST_VAULT_KEY);
        const pick = last && list.some((v) => v.name === last) ? last : list[0]?.name ?? '';
        setVault(pick);
      })
      .catch(() => setStatus('error'));
  }, []);

  // Reflect the selected project's sleep debt in the mascot's mood.
  useEffect(() => {
    if (!vault) return;
    setActiveVault(vault);
    let cancelled = false;
    api
      .get<{ debt?: number }>('/sleep')
      .then((s) => {
        if (!cancelled) setMode(modeForDebt(typeof s.debt === 'number' ? s.debt : 0));
      })
      .catch(() => {
        if (!cancelled) setMode('idle');
      });
    return () => {
      cancelled = true;
    };
  }, [vault]);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void closeSelf();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Dismiss the moment the window loses focus (the user clicked back to their
  // work) — so it behaves like Spotlight: hotkey opens it, clicking away closes
  // it, and focus returns to whatever they clicked rather than the dreamcontext
  // main window. Armed only after the window has first gained focus, and paused
  // while the native project picker is open (its popup briefly steals focus).
  useEffect(() => {
    let armed = false;
    let cancelled = false;
    let unsub = () => {};
    void onSleepyFocusChange((focused) => {
      if (focused) {
        armed = true;
        return;
      }
      if (armed && !pickerActiveRef.current && !sleepingRef.current) void closeSelf();
    }).then((u) => {
      if (cancelled) u();
      else unsub = u;
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Stop any in-flight enrichment poll when the window goes away.
  useEffect(() => () => {
    if (pollRef.current) window.clearTimeout(pollRef.current);
  }, []);

  // Poll the background Claude run until it finishes, mirroring its state +
  // response into `enrich`. A new submit cancels any prior poll. `runMode` is the
  // mode that started the run, so the panel copy stays correct if the user flips
  // the toggle while a run is in flight.
  function pollEnrichment(captureId: string, runMode: CapMode) {
    if (pollRef.current) window.clearTimeout(pollRef.current);
    let attempts = 0;
    // Consolidation runs much longer than a learn/ask reply — give sleep a wide
    // ceiling (~15 min) so it isn't cut off mid-flight.
    const MAX_ATTEMPTS = runMode === 'sleep' ? 750 : 150;
    let unknownStreak = 0;
    const tick = async () => {
      attempts += 1;
      try {
        const s = await api.get<Enrich>(`/launcher/capture/status?id=${encodeURIComponent(captureId)}`);
        // A run we just started should be 'running'; a persistent 'unknown' means
        // it expired or the server restarted — stop after a few tries.
        unknownStreak = s.state === 'unknown' ? unknownStreak + 1 : 0;
        setEnrich({ state: s.state, output: s.output, mode: runMode });
        const keepGoing =
          (s.state === 'running' || s.state === 'unknown') &&
          attempts < MAX_ATTEMPTS &&
          unknownStreak < 3;
        if (keepGoing) pollRef.current = window.setTimeout(() => void tick(), 1200);
      } catch {
        setEnrich({ state: 'error', output: 'Lost contact with the run.', mode: runMode });
      }
    };
    pollRef.current = window.setTimeout(() => void tick(), 600);
  }

  async function submit() {
    const t = text.trim();
    const runMode = capMode;
    // Sleep needs no text; learn/ask require some.
    if ((runMode !== 'sleep' && !t) || !vault || status === 'saving') return;
    setStatus('saving');
    setErrMsg('');
    setEnrich(null);
    try {
      const r = await api.post<{ ok: boolean; captureId?: string }>('/launcher/capture', {
        vault,
        text: t,
        mode: runMode,
      });
      localStorage.setItem(LAST_VAULT_KEY, vault);
      setText('');
      // 'Learn' saves the note (captured ✓); 'Ask' has no side effect, so go
      // straight to the thinking spinner without a "saved" flash.
      setStatus(runMode === 'learn' ? 'saved' : 'idle');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      inputRef.current?.focus();
      // Now follow the background Claude run (spinner + reply/answer).
      if (r.captureId) {
        setEnrich({ state: 'running', output: '', mode: runMode });
        pollEnrichment(r.captureId, runMode);
      }
      window.setTimeout(() => setStatus('idle'), 1400);
    } catch (e) {
      // Surface the server's real reason (e.g. "Vault path no longer exists")
      // instead of a bare "failed" — otherwise a dead/missing vault is opaque.
      setErrMsg(e instanceof Error ? e.message : 'Capture failed');
      setStatus('error');
      window.setTimeout(() => setStatus('idle'), 5000);
    }
  }

  // A consolidation is in flight: lock input and show the mascot asleep.
  const sleeping = enrich?.mode === 'sleep' && (enrich.state === 'running' || enrich.state === 'unknown');
  sleepingRef.current = sleeping;
  const displayMode: Mode = sleeping ? 'sleeps' : mode;

  return (
    <div className="cap-root">
      {/* Black panel hanging from the notch — the mascot's home. An animated WebP
          via <img> autoplays unconditionally in WKWebView (which blocks <video>
          autoplay and offers no Tauri override), so the mascot always feels alive. */}
      <div className="cap-notch" data-tauri-drag-region>
        <img
          key={displayMode}
          className="cap-char"
          src={`/api/sleepy/anim?mode=${displayMode}`}
          alt=""
          draggable={false}
        />
      </div>

      {/* Capture input bar. */}
      <div className={`cap-bar cap-${status}`}>
        <div className="cap-bar-head">
          <div className="cap-vault-wrap">
            <select
              className="cap-vault"
              value={vault}
              onFocus={() => { pickerActiveRef.current = true; }}
              onBlur={() => { pickerActiveRef.current = false; }}
              onChange={(e) => setVault(e.target.value)}
              aria-label="Project"
            >
              {vaults.length === 0 && <option value="">No projects</option>}
              {vaults.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                </option>
              ))}
            </select>
            <span className="cap-chev" aria-hidden>
              ⌄
            </span>
          </div>
          <span className={`cap-status cap-status-${status}`} aria-hidden>
            {status === 'saving'
              ? 'saving…'
              : status === 'saved'
                ? 'captured ✓'
                : status === 'error'
                  ? 'failed'
                  : ''}
          </span>
          {/* Learn (save + enrich) · Ask (one-shot Q&A) · Sleep (consolidate). */}
          <div className="cap-mode-toggle" role="radiogroup" aria-label="Mode">
            {(['learn', 'ask', 'sleep'] as CapMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`cap-mode-opt ${capMode === m ? 'is-active' : ''}`}
                role="radio"
                aria-checked={capMode === m}
                disabled={sleeping}
                onClick={() => setCapMode(m)}
              >
                {m === 'learn' ? 'Learn' : m === 'ask' ? 'Ask' : 'Sleep'}
              </button>
            ))}
          </div>
        </div>
        {capMode === 'sleep' ? (
          // Sleep needs no input — one button kicks off the consolidation. While
          // it runs, the button is locked (no typing during sleep).
          <button
            type="button"
            className="cap-sleep-btn"
            disabled={sleeping || !vault}
            onClick={() => void submit()}
          >
            {sleeping ? 'Sleeping…' : `💤 Sleep — consolidate ${vault || 'project'}`}
          </button>
        ) : (
          <textarea
            ref={inputRef}
            className="cap-input"
            placeholder={capMode === 'ask' ? 'Ask one question about this project…' : 'Capture a thought or command…'}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={(e) => {
              // Enter submits; Shift+Enter inserts a newline (chat-style).
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        )}
        {status === 'error' && errMsg && <div className="cap-error-msg">{errMsg}</div>}

        {/* Background Claude run: live spinner, then its response/answer. */}
        {enrich && (
          <div className={`cap-enrich cap-enrich-${enrich.state}`}>
            <div className="cap-enrich-head">
              {enrich.state === 'running' || enrich.state === 'unknown' ? (
                <>
                  <span className="cap-spinner" aria-hidden />
                  <span>
                    {enrich.mode === 'ask'
                      ? 'Sleepy is thinking…'
                      : enrich.mode === 'sleep'
                        ? 'Sleepy is sleeping — consolidating memory…'
                        : 'Sleepy is learning…'}
                  </span>
                </>
              ) : enrich.state === 'done' ? (
                <span className="cap-enrich-done">
                  {enrich.mode === 'ask' ? '✓ Answer' : enrich.mode === 'sleep' ? '✓ Slept' : '✓ Learned'}
                </span>
              ) : (
                <span className="cap-enrich-err">
                  {enrich.mode === 'ask' ? "Couldn't answer" : enrich.mode === 'sleep' ? 'Sleep failed' : 'Enrichment failed'}
                </span>
              )}
            </div>
            {enrich.output &&
              (enrich.state === 'error' ? (
                // Raw error text (e.g. shell stderr) — not markdown.
                <div className="cap-enrich-body">{enrich.output}</div>
              ) : (
                <div
                  className="cap-enrich-body cap-md"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(enrich.output) }}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
