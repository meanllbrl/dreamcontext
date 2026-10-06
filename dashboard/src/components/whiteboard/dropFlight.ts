/**
 * The chip a drop makes, flying from where the element was released to the agent panel's
 * composer (owner, 2026-10-06: "the owner sees what happened"). A plain element on the page,
 * animated with the Web Animations API and removed when it lands; nothing waits on it. The panel
 * may be mounting in the same tick, so the landing is read two frames later. Reduced motion
 * skips the flight: the panel opening and the toast say it all.
 */
const FLIGHT_MS = 560;

export function flyChip(from: { x: number; y: number }, label: string, landing: () => DOMRect | null): void {
  if (typeof document === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const chip = document.createElement('div');
  chip.className = 'wb-drop-flight';
  chip.setAttribute('aria-hidden', 'true');
  chip.textContent = label;
  chip.style.left = `${from.x}px`;
  chip.style.top = `${from.y}px`;
  document.body.appendChild(chip);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const to = landing();
    if (!to || typeof chip.animate !== 'function') { chip.remove(); return; }
    const dx = to.left + Math.min(to.width / 2, 120) - from.x;
    const dy = to.top + to.height / 2 - from.y;
    const flight = chip.animate([
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.55 - 40}px)) scale(1.04)`, opacity: 1, offset: 0.55 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.9)`, opacity: 0.2 },
    ], { duration: FLIGHT_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'forwards' });
    flight.finished.then(() => chip.remove(), () => chip.remove());
  }));
}
