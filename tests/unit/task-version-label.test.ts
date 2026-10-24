import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AC4: every user-facing label for the `version` field reads "Versions & Sprints". Scans the
 * Tasks components for JSX text and label/title/placeholder/aria-label string literals that
 * are exactly "Version" or "Versions" (identifiers like VersionsPopover are not text).
 */
const DIR = join(import.meta.dirname, '..', '..', 'dashboard', 'src', 'components', 'tasks');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

const BARE = /^(Version|Versions)$/;

describe('the version field is labelled "Versions & Sprints"', () => {
  const files = walk(DIR);
  it.each(files.map((f) => [f.slice(DIR.length + 1), f]))('%s', (_rel, file) => {
    const src = readFileSync(file as string, 'utf-8');
    const offenders: string[] = [];
    // JSX text: >Version<
    for (const m of src.matchAll(/>\s*([^<>{}\n]+?)\s*</g)) if (BARE.test(m[1].trim())) offenders.push(`text "${m[1].trim()}"`);
    // label=/title=/placeholder=/aria-label= string props
    for (const m of src.matchAll(/\b(label|title|placeholder|aria-label|triggerLabel)\s*=\s*["']([^"']+)["']/g)) if (BARE.test(m[2])) offenders.push(`${m[1]}="${m[2]}"`);
    // object literals feeding labels: { label: 'Version' } / ['version', 'Version']
    for (const m of src.matchAll(/(?:label\s*:\s*|\[\s*'version'\s*,\s*)'([^']+)'/g)) if (BARE.test(m[1])) offenders.push(`'${m[1]}'`);
    for (const m of src.matchAll(/\bversion\s*:\s*'([^']+)'/g)) if (BARE.test(m[1])) offenders.push(`version: '${m[1]}'`);
    expect(offenders).toEqual([]);
  });

  it('the task screen strings in the i18n file carry no bare "Version" label', () => {
    const i18n = readFileSync(join(import.meta.dirname, '..', '..', 'dashboard', 'src', 'context', 'I18nContext.tsx'), 'utf-8');
    const bad = [...i18n.matchAll(/'(tasks\.[A-Za-z.]+)'\s*:\s*'([^']*)'/g)].filter(([, , v]) => BARE.test(v)).map(([, k]) => k);
    expect(bad).toEqual([]);
  });

  it('the label actually appears where the field is shown', () => {
    const read = (f: string) => readFileSync(join(DIR, f), 'utf-8');
    expect(read('BoardToolbar.tsx')).toContain('Versions &amp; Sprints');
    expect(read('TaskCreateModal.tsx')).toContain('Versions &amp; Sprints');
    expect(read('VersionsPopover.tsx')).toContain('Versions &amp; Sprints');
    expect(read('detail/PropertiesPanel.tsx')).toContain('label="Versions & Sprints"');
    expect(read('boardModel.ts')).toContain("version: 'Versions & Sprints'");
  });
});
