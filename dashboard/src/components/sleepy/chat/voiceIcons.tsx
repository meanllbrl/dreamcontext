/**
 * The composer's voice line icons (owner 2026-10-30: the prototype's thin line set, 16 px at a
 * 1.75 stroke, `.chat-cmp-ic`). Shared by the composer's toolbar and the mic split's menu.
 *
 * Drawn rather than emoji: an emoji is a different picture on every platform and cannot take
 * the state colour, and `currentColor` is what lets CSS colour the mic by its state.
 */

/** The speaker struck through: "replies are not read aloud". */
export function HushIcon() {
  return (
    <svg className="chat-cmp-ic" viewBox="0 0 24 24" aria-hidden>
      <path d="M11 5.5 7 9H4.5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1H7l4 3.5z" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

/** A plain speaker with its waves: "replies are read aloud". */
export function SpeakerIcon() {
  return (
    <svg className="chat-cmp-ic" viewBox="0 0 24 24" aria-hidden>
      <path d="M11 5.5 7 9H4.5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1H7l4 3.5z" />
      <path d="M15 9.5a3.5 3.5 0 0 1 0 5" />
      <path d="M17.8 7a7 7 0 0 1 0 10" />
    </svg>
  );
}

export function MicIcon() {
  return (
    <svg className="chat-cmp-ic" viewBox="0 0 24 24" aria-hidden>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v2.5" />
    </svg>
  );
}

/** A download arrow: "install this". */
export function DownloadIcon() {
  return (
    <svg className="chat-cmp-ic" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

/** Sliders: "settings". */
export function SlidersIcon() {
  return (
    <svg className="chat-cmp-ic" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}
