/**
 * The picker's (and later the drawer's) project order: the owner's drag, kept in
 * `launcher-ui.json` (`projectOrder`). Known names stay where the owner put them, a project seen
 * for the first time goes to the end in the order `names` lists it, a gone one drops out.
 */
export function mergeProjectOrder(stored: readonly string[] | null, names: readonly string[]): string[] {
  const known = new Set(names);
  const kept = (stored ?? []).filter((n) => known.has(n));
  const seen = new Set(kept);
  return [...kept, ...names.filter((n) => !seen.has(n))];
}

/** `from` dropped onto `to`: it takes `to`'s place, the rest keep their order. */
export function moveProject(order: readonly string[], from: string, to: string): string[] {
  if (from === to || !order.includes(from) || !order.includes(to)) return [...order];
  const rest = order.filter((n) => n !== from);
  const at = rest.indexOf(to) + (order.indexOf(from) < order.indexOf(to) ? 1 : 0);
  return [...rest.slice(0, at), from, ...rest.slice(at)];
}
