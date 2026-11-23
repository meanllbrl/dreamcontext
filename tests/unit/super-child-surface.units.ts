/**
 * Splitting a briefing into the units a nothing-lost ledger accounts for
 * (pattern condense-only-behind-a-nothing-lost-ledger). Shared by the Super child surface test.
 */

/** Lower case, no markdown emphasis, one space: wording equal up to layout counts as kept. */
export function norm(s: string): string {
  return s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface Unit { heading: string; text: string }

/**
 * The units of `text`: each fenced block whole, each sentence of the prose. A sentence ends at
 * `.`, `!` or `?` (or a `:` closing a line) before whitespace and an upper-case letter, a
 * backtick, a quote or a bracket. Headings are not units; they label the units below them.
 */
export function unitsOf(text: string): Unit[] {
  const units: Unit[] = [];
  let heading = '';
  let prose: string[] = [];
  const flush = (): void => {
    const para = prose.join(' ').replace(/\s+/g, ' ').trim();
    prose = [];
    if (!para) return;
    for (const s of para.split(/(?<=[.!?:])\s+(?=[A-Z`"*(\-—])/)) {
      const t = s.replace(/^-\s+/, '').trim();
      if (t.length > 3) units.push({ heading, text: t });
    }
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const block: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) block.push(lines[i]);
      units.push({ heading, text: block.join('\n').trim() });
      continue;
    }
    if (/^#{1,3} /.test(line)) { flush(); heading = line.replace(/^#+\s*/, '').trim(); continue; }
    if (/^\s*$/.test(line) || /^- /.test(line)) flush();
    if (!/^\s*$/.test(line)) prose.push(line);
  }
  flush();
  return units;
}
