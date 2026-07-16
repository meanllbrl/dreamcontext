/**
 * Ascii-fold for case/diacritic-insensitive comparisons.
 *
 * Real workspaces hold values that must compare equal despite differing bytes:
 * a status typed on a Turkish keyboard ("in revıew", dotless ı) has to match the
 * "in review" candidate, and a version label that a cloud backend lowercased on
 * the round trip ("s5 (jul 13 - jul 17)") has to match its own sprint (#184).
 *
 * Lives here, provider-neutral, rather than in a backend module: it is a plain
 * string utility with no wire knowledge, and its consumers span the ClickUp
 * mapper, the GitHub mapper, member matching, and the tasks CLI. (It previously
 * sat in `clickup-map.ts`, which forced `github-map.ts` to import — and re-export —
 * from the ClickUp module just to fold a string.)
 */
export function foldAscii(s: string): string {
  return s
    .replace(/ı/g, 'i').replace(/İ/g, 'I')
    .replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}
