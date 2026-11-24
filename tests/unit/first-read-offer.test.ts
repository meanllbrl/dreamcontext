/**
 * The first-read offer on the main Super stage (plan ilk-acilis C17, S6): the window asks
 * whether the offer is up with a GET, and starts the read with a POST ONLY from the Start
 * reading click: never on mount, reconnect or a timer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const surface = readFileSync(join(root, 'dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf-8');

describe('first-read offer (C17)', () => {
  it('POSTs first-read from exactly one place, the Start reading handler', () => {
    const posts = surface.match(/ownerPost<[^>]*>\('\/super\/first-read'/g) ?? [];
    expect(posts).toHaveLength(1);
    const handler = surface.split('const startFirstRead = useCallback(async () => {')[1]?.split('}, [firstReadOut, scopedApi]);')[0] ?? '';
    expect(handler).toContain("scopedApi.ownerPost<{ ok?: boolean; error?: string }>('/super/first-read', {})");
  });

  it('the handler is called only from the button click', () => {
    const calls = [...surface.matchAll(/startFirstRead\(/g)].length;
    // One definition-free call site: the button's onClick.
    expect(calls).toBe(1);
    expect(surface).toContain('data-testid="first-read-start" disabled={firstReadOut} onClick={() => { void startFirstRead(); }}');
  });

  it('the mount effect only GETs the offer', () => {
    const effect = surface.split("scopedApi.ownerGet<{ pending?: boolean }>('/super/first-read')")[0].split('useEffect(() => {').pop() ?? '';
    expect(effect).not.toContain('ownerPost');
    expect(surface).toContain("scopedApi.ownerGet<{ pending?: boolean }>('/super/first-read')");
  });

  it('only the main Super stage carries the hero; a refusal keeps the button and names its reason', () => {
    expect(surface).toContain('emptyHero={isMainSuperStage(cs) ? superHero : undefined}');
    expect(surface).toContain("setFirstReadRefused(FIRST_READ_REASONS.has(code) ? code : 'other')");
    expect(surface).toContain("t(`super.firstRead.refused.${firstReadRefused}`)");
  });

  it('the first-read child tab never claims bypass', () => {
    expect(surface).toContain('const firstRead = args.firstRead === true;');
    expect(surface).toMatch(/spawn\(false, childId, false, 'chat', prepared\.inline, d\.model, true, prepared\.token, false, d\.effort, firstRead, d\.mode\)/);
  });
});
