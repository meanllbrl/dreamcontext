/**
 * The dashboard's copy of the machine-readiness model must equal the lib's.
 *
 * The dashboard bundle cannot import `src/`, so three things are MIRRORED and pinned here:
 *  - the id lists (`CHECK_IDS`, `FIX_IDS`, the reason codes) in `dashboard/src/lib/onboardingTypes.ts`;
 *  - the English copy of every check, reason and fix, as `onboarding.*` keys in `I18nContext.tsx`
 *    (read by TEXT SCAN: root vitest cannot import a dashboard `.tsx`);
 *  - the hand-off's first message, `initializerKickoffPrompt()`, which must also still fit
 *    inline in the terminal upgrade URL so the hand-off never needs a prompt token.
 * Plus the pure data-layer helpers the checklist and the hand-off build on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lib from '../../src/lib/onboarding/types.js';
import { CHECK_COPY, REASON_COPY, FIX_COPY, INITIALIZER_KICKOFF_PROMPT } from '../../src/lib/onboarding/copy.js';
import * as dash from '../../dashboard/src/lib/onboardingTypes.js';
import {
  initializerKickoffPrompt,
  promptFitsInline,
  encodedPromptLen,
  MAX_PROMPT_ENCODED,
} from '../../dashboard/src/lib/agentPrompt.js';
import { emitStartIntent, openVaultWindow } from '../../dashboard/src/lib/desktop.js';
import { needsLivePoll, nextPlannedFix, checkForFix, readinessPollPlan, runPlanSequence, type FixRunState } from '../../dashboard/src/hooks/useOnboarding.js';

const ROOT = join(import.meta.dirname, '..', '..');
const I18N = join(ROOT, 'dashboard', 'src', 'context', 'I18nContext.tsx');
const TOKENS = join(ROOT, 'dashboard', 'src', 'styles', 'tokens.css');

/** Every `'onboarding.…': '…'` (or "…") pair in the file. Keys may hold hyphens (`claude-auth`). */
function onboardingKeys(): Map<string, string> {
  const src = readFileSync(I18N, 'utf-8');
  const out = new Map<string, string>();
  const re = /'(onboarding\.[a-zA-Z0-9_.-]+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (out.has(m[1])) throw new Error(`duplicate i18n key ${m[1]}`);
    out.set(m[1], m[2] ?? m[3] ?? '');
  }
  return out;
}

describe('ids', () => {
  it('CHECK_IDS and FIX_IDS equal the lib, in order', () => {
    expect([...dash.CHECK_IDS]).toEqual([...lib.CHECK_IDS]);
    expect([...dash.FIX_IDS]).toEqual([...lib.FIX_IDS]);
  });

  it('REASON_CODES are exactly the reasons the lib has copy for', () => {
    expect([...dash.REASON_CODES].sort()).toEqual(Object.keys(REASON_COPY).sort());
  });
});

describe('i18n copy', () => {
  const keys = onboardingKeys();

  it('carries every check title and why-line exactly as the lib', () => {
    for (const id of lib.CHECK_IDS) {
      expect(keys.get(`onboarding.check.${id}.title`)).toBe(CHECK_COPY[id].title);
      expect(keys.get(`onboarding.check.${id}.why`)).toBe(CHECK_COPY[id].why);
    }
  });

  it('carries every reason exactly as the lib', () => {
    for (const [code, text] of Object.entries(REASON_COPY)) {
      expect(keys.get(`onboarding.reason.${code}`)).toBe(text);
    }
  });

  it('carries every field of every fix exactly as the lib, including both scope notes', () => {
    for (const id of lib.FIX_IDS) {
      for (const [field, text] of Object.entries(FIX_COPY[id])) {
        expect({ key: `onboarding.fix.${id}.${field}`, text: keys.get(`onboarding.fix.${id}.${field}`) })
          .toEqual({ key: `onboarding.fix.${id}.${field}`, text });
      }
    }
    expect(keys.get('onboarding.fix.github-signin.scopesNote')).toMatch(/repositories.*organizations.*gists/);
    expect(keys.get('onboarding.fix.gh-signin.scopesNote')).toMatch(/repositories.*organizations.*gists/);
  });

  it('has the screen strings the checklist, the project step, the hand-off and the start notice use', () => {
    for (const key of [
      'onboarding.stage.machine', 'onboarding.stage.project', 'onboarding.stage.start', 'onboarding.skip',
      'onboarding.machine.title', 'onboarding.machine.ready',
      'onboarding.checklist.setEverythingUp', 'onboarding.checklist.recommended', 'onboarding.checklist.browserMode',
      'onboarding.checklist.offlineBanner', 'onboarding.checklist.showDetails',
      'onboarding.wait.browser.title', 'onboarding.wait.browser.openAgain', 'onboarding.wait.code.openGitHub',
      'onboarding.wait.dialog.title', 'onboarding.wait.cancel',
      'onboarding.project.git.pending', 'onboarding.project.git.needInstall', 'onboarding.project.docsFound',
      'onboarding.handoff.start', 'onboarding.handoff.open', 'onboarding.handoff.tabTitle',
      'onboarding.startIntent.refused', 'onboarding.startIntent.openSetup', 'onboarding.launcher.finishBar',
    ]) {
      expect({ key, present: (keys.get(key) ?? '').length > 0 }).toEqual({ key, present: true });
    }
    expect(keys.get('onboarding.project.git.pending')).toBe('Git will be set up when the macOS install finishes');
  });

  it('no onboarding string has an em dash, and the agent is called Claude', () => {
    expect([...keys].filter(([, v]) => v.includes('—')).map(([k]) => k)).toEqual([]);
    expect([...keys].filter(([, v]) => /\bClaude Code\b/.test(v)).map(([k]) => k)).toEqual([]);
  });
});

describe('the hand-off prompt', () => {
  it('equals the lib kickoff prompt', () => {
    expect(initializerKickoffPrompt()).toBe(INITIALIZER_KICKOFF_PROMPT);
  });

  it('fits inline in the upgrade URL (no prompt token needed)', () => {
    expect(promptFitsInline(INITIALIZER_KICKOFF_PROMPT)).toBe(true);
    expect(encodedPromptLen(INITIALIZER_KICKOFF_PROMPT)).toBeLessThanOrEqual(MAX_PROMPT_ENCODED);
  });
});

describe('tokens', () => {
  it('tokens.css declares --motion-converge: 520ms exactly once', () => {
    const css = readFileSync(TOKENS, 'utf-8');
    expect(css.match(/--motion-converge:\s*520ms;/g) ?? []).toHaveLength(1);
  });
});

describe('desktop.ts start intent', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('openVaultWindow carries start=initializer in the URL it opens (browser path, Turkish name)', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const name = 'Öğretmen Notları'.normalize('NFC');
    await expect(openVaultWindow(name, undefined, { start: 'initializer' })).resolves.toBe('browser');
    expect(open).toHaveBeenCalledWith(`/?vault=${encodeURIComponent(name)}&start=initializer`, '_blank');
  });

  it('openVaultWindow without start adds nothing', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    await openVaultWindow('demo');
    expect(open).toHaveBeenCalledWith('/?vault=demo', '_blank');
  });

  it('emitStartIntent is a no-op off the desktop', async () => {
    vi.stubGlobal('window', {});
    await expect(emitStartIntent('demo', 'initializer')).resolves.toBe(false);
  });
});

describe('data-layer helpers', () => {
  function report(over: Partial<dash.ReadinessReport> = {}): dash.ReadinessReport {
    return {
      version: 1, platform: 'darwin', arch: 'arm64', surface: 'desktop', generatedAt: 0,
      ready: false, online: true, plan: [], next: null, activeFixes: [], checks: [], ...over,
    };
  }

  it('needsLivePoll is true only while a fix runs or the machine is offline', () => {
    expect(needsLivePoll(undefined)).toBe(false);
    expect(needsLivePoll(report())).toBe(false);
    expect(needsLivePoll(report({ activeFixes: ['git-install'] }))).toBe(true);
    expect(needsLivePoll(report({ online: false }))).toBe(true);
  });

  it('readinessPollPlan polls fresh every 2 s while offline or a fix is live, and not at all otherwise', () => {
    // Offline recovery must land within 6 s: a cached (5 s memo) read every 3 s could take ~8 s.
    expect(readinessPollPlan(undefined)).toEqual({ fresh: false, intervalMs: false });
    expect(readinessPollPlan(report())).toEqual({ fresh: false, intervalMs: false });
    expect(readinessPollPlan(report({ online: false }))).toEqual({ fresh: true, intervalMs: 2000 });
    expect(readinessPollPlan(report({ activeFixes: ['git-install'] }))).toEqual({ fresh: true, intervalMs: 2000 });
  });

  it('nextPlannedFix skips tried, skipped and already-running fixes, in plan order', () => {
    const r = report({ plan: ['git-install', 'cli-install', 'claude-install', 'github-signin'], activeFixes: ['git-install'] });
    expect(nextPlannedFix(r, new Set(), new Set())).toBe('cli-install');
    expect(nextPlannedFix(r, new Set(['cli-install']), new Set())).toBe('claude-install');
    expect(nextPlannedFix(r, new Set(['cli-install', 'claude-install']), new Set(['github-signin']))).toBeNull();
  });

  describe('runPlanSequence (the "Set everything up" pass)', () => {
    const PLAN: dash.FixId[] = ['cli-install', 'claude-install', 'claude-signin'];
    function deps(over: { stopAfter?: number; abandonOn?: dash.FixId; stopOnRefresh?: number } = {}) {
      const started: dash.FixId[] = [];
      let refreshes = 0;
      let stop = false;
      return {
        started,
        d: {
          refresh: async () => {
            refreshes += 1;
            if (over.stopOnRefresh === refreshes) stop = true;
            return report({ plan: PLAN.filter((f) => !started.includes(f)) });
          },
          start: async (fix: dash.FixId): Promise<FixRunState> => {
            started.push(fix);
            if (over.stopAfter === started.length) stop = true;
            return { fix, runId: 'r', phase: fix === over.abandonOn ? 'abandoned' : 'done', status: null };
          },
          shouldStop: () => stop,
          skipped: () => new Set<dash.FixId>(),
        },
      };
    }

    it('runs the whole plan in order when nothing stops it', async () => {
      const { started, d } = deps();
      await expect(runPlanSequence(d)).resolves.toBe('done');
      expect(started).toEqual(PLAN);
    });

    it('starts nothing more once the screen goes away mid-run (stop set during a fix)', async () => {
      const { started, d } = deps({ stopAfter: 1 });
      await expect(runPlanSequence(d)).resolves.toBe('stopped');
      expect(started).toEqual(['cli-install']);
    });

    it('stops when a run comes back abandoned, even if nobody set stop', async () => {
      const { started, d } = deps({ abandonOn: 'cli-install' });
      await expect(runPlanSequence(d)).resolves.toBe('stopped');
      expect(started).toEqual(['cli-install']);
    });

    it('re-checks stop after the report read, before choosing a fix', async () => {
      const { started, d } = deps({ stopOnRefresh: 1 });
      await expect(runPlanSequence(d)).resolves.toBe('stopped');
      expect(started).toEqual([]);
    });
  });

  it('checkForFix finds the check that owns a fix', () => {
    const check: dash.ReadinessCheck = {
      id: 'claude', tier: 'required', scopes: ['machine', 'agent'], status: 'missing', dependsOn: ['network'],
      fix: { id: 'claude-install', kind: 'auto', runnable: true, editsShellProfile: false },
    };
    expect(checkForFix(report({ checks: [check] }), 'claude-install')?.id).toBe('claude');
    expect(checkForFix(report({ checks: [check] }), 'gh-install')).toBeUndefined();
  });
});
