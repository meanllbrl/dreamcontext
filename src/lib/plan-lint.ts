import { planSection } from './plan-ledger.js';

/**
 * Wave-map lint: the one mechanical check a plan review keeps finding by hand. A plan's
 * `## Wave map` names, per wave, the lanes and their files. Two mistakes are visible without
 * reading the code: a file claimed by two lanes of one wave (two builders edit it at once), and
 * a file the Contracts or Criteria name that no lane owns. Advisory: it prints, it never refuses
 * (a wrong guess about prose must not lock a plan; the lenses decide).
 */

const MAX_LINES = 8;
const FILE_RE = /^[\w@.\-/]+\.[a-z][a-z0-9]{0,5}$/i;
const LANE_RE = /\*\*\s*(L\d+)\b[^*]*\*\*/g;

function backticked(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const t = m[1].replace(/^\.\//, '').replace(/[,;:)]+$/, '');
    if (FILE_RE.test(t) && !/^\d+(\.\d+)+$/.test(t)) out.push(t);
  }
  return out;
}

/** Two spellings of one file: equal, or one is a path suffix of the other (`src/lib.rs` vs `desktop/src-tauri/src/lib.rs`). */
function same(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

interface Wave { name: string; lanes: Map<string, string[]> }

function parseWaves(map: string): Wave[] {
  const waves: Wave[] = [];
  for (const raw of map.split('\n')) {
    const row = raw.trim();
    const label = /^\|?\s*[*_]*\s*(W\d+)\b/i.exec(row) ?? /^[-*#\s]*[*_]*\s*(W\d+)\b/i.exec(row);
    if (!label) continue;
    const name = label[1].toUpperCase();
    const lanes = new Map<string, string[]>();
    const marks = [...row.matchAll(LANE_RE)];
    if (marks.length === 0) {
      lanes.set('L1', backticked(row));
    } else {
      marks.forEach((m, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].index! : row.length;
        const files = backticked(row.slice(m.index! + m[0].length, end));
        lanes.set(m[1].toUpperCase(), [...(lanes.get(m[1].toUpperCase()) ?? []), ...files]);
      });
    }
    waves.push({ name, lanes });
  }
  return waves;
}

/** Lint lines for a plan.md; an empty array means nothing to say (including "no wave map to read"). */
export function lintWaveMap(planText: string): string[] {
  const map = planSection(planText, 'Wave map');
  if (!map) return [];
  const waves = parseWaves(map);
  if (waves.length === 0) return [];
  const out: string[] = [];

  for (const w of waves) {
    const entries = [...w.lanes.entries()];
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        for (const a of entries[i][1]) {
          const hit = entries[j][1].find((b) => same(a, b));
          if (hit && !seen.has(a)) {
            seen.add(a);
            out.push(`${w.name}: \`${a}\` is in lane ${entries[i][0]} and lane ${entries[j][0]}: one lane per file (merge the lanes or move the file).`);
          }
        }
      }
    }
  }

  const owned = waves.flatMap((w) => [...w.lanes.values()].flat());
  const named = new Set<string>();
  for (const title of ['Contracts', 'Acceptance criteria', 'Criteria']) {
    const sect = planSection(planText, title);
    if (sect) for (const f of backticked(sect)) if (f.includes('/') && !/^(tmp|assets|docs|dist|build|config)\//.test(f)) named.add(f);
  }
  for (const f of named) {
    if (!owned.some((o) => same(f, o))) out.push(`\`${f}\` is named in Contracts or criteria but no lane of the wave map owns it.`);
  }

  if (out.length > MAX_LINES) return [...out.slice(0, MAX_LINES), `(+${out.length - MAX_LINES} more)`];
  return out;
}
