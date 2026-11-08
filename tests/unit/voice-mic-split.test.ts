/**
 * The mic split (owner, 2026-11-08): the mic is drawn on every desktop composer whatever the
 * microphone permission or the dictation install, and anything missing is a step in its menu.
 *
 *  1. The rules (`lib/voice/micMenu.ts`), pure: visibility, steps, menu order, the press, and
 *     what the "Set up dictation" step offers.
 *  2. The composer wiring, by SOURCE SCAN (the composer cannot be mounted under plain Node, see
 *     `voice-composer-guard.test.ts`): the gate is the pure rule, the press asks the rule, the
 *     separate speaker button is gone.
 *  3. The shell: the three permission commands are registered and granted to the windows that
 *     already record.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  micVisible, micSetupSteps, micMenuItems, micPressAction, dictationStepPlan, type DictationStepState,
} from '../../dashboard/src/lib/voice/micMenu';
import type { MicPermission } from '../../dashboard/src/lib/voice/micPermission';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const PERMISSIONS: MicPermission[] = ['granted', 'prompt', 'denied', 'restricted', 'unknown'];

describe('visibility: the mic never waits for the permission or the model', () => {
  it('is drawn on the desktop for every permission and install state', () => {
    // micVisible takes no permission and no install flag at all: that IS the rule.
    expect(micVisible({ inAppFrame: false, desktop: true, phoneVoice: false })).toBe(true);
    for (const permission of PERMISSIONS) {
      for (const dictationReady of [true, false]) {
        const steps = micSetupSteps({ permission, dictationReady, phone: false });
        // Whatever is missing becomes a step; the button stays.
        expect(micVisible({ inAppFrame: false, desktop: true, phoneVoice: false }), `${permission}/${dictationReady}`).toBe(true);
        expect(micPressAction(steps)).toBe(steps.length ? 'open-menu' : 'record');
      }
    }
  });

  it('stays off where no microphone path exists: the web dashboard and an app frame', () => {
    expect(micVisible({ inAppFrame: false, desktop: false, phoneVoice: false })).toBe(false);
    expect(micVisible({ inAppFrame: true, desktop: true, phoneVoice: false })).toBe(false);
    expect(micVisible({ inAppFrame: true, desktop: false, phoneVoice: true })).toBe(false);
  });

  it('the hands-free phone keeps its own rule (the Mac has dictation)', () => {
    expect(micVisible({ inAppFrame: false, desktop: false, phoneVoice: true })).toBe(true);
  });
});

describe('setup steps', () => {
  it('asks for the permission when never asked, refused or locked', () => {
    for (const p of ['prompt', 'denied', 'restricted'] as const) {
      expect(micSetupSteps({ permission: p, dictationReady: true, phone: false })).toEqual(['permission']);
    }
  });

  it('offers no permission step when granted, or on an older shell that cannot tell (the first take asks)', () => {
    expect(micSetupSteps({ permission: 'granted', dictationReady: true, phone: false })).toEqual([]);
    expect(micSetupSteps({ permission: 'unknown', dictationReady: true, phone: false })).toEqual([]);
  });

  it('adds the model step when dictation is not ready, permission first', () => {
    expect(micSetupSteps({ permission: 'granted', dictationReady: false, phone: false })).toEqual(['dictation']);
    expect(micSetupSteps({ permission: 'prompt', dictationReady: false, phone: false })).toEqual(['permission', 'dictation']);
  });

  it('the phone has no steps: its permission is the phone browser\'s and setup happens on the Mac', () => {
    expect(micSetupSteps({ permission: 'prompt', dictationReady: false, phone: true })).toEqual([]);
  });
});

describe('the press where Voice settings is out of reach (the Assistant notch)', () => {
  it('a missing model alone does not lock the mic into a menu it cannot leave', () => {
    expect(micPressAction(['dictation'], { dictationFixable: false })).toBe('record');
    expect(micPressAction(['dictation'], { dictationFixable: true })).toBe('open-menu');
  });

  it('a missing permission still opens the menu: its step works everywhere (the shell asks macOS)', () => {
    expect(micPressAction(['permission', 'dictation'], { dictationFixable: false })).toBe('open-menu');
    expect(micPressAction(['permission'], { dictationFixable: false })).toBe('open-menu');
  });
});

describe('menu items', () => {
  it('lists the missing steps first, then spoken replies, then Voice settings', () => {
    expect(micMenuItems({ steps: ['permission', 'dictation'], readAloudAvailable: true, readAloudOn: false, settingsAvailable: true }))
      .toEqual([
        { kind: 'step', step: 'permission' },
        { kind: 'step', step: 'dictation' },
        { kind: 'read-aloud', on: false },
        { kind: 'settings' },
      ]);
  });

  it('carries the read-aloud state, and only where spoken replies exist', () => {
    expect(micMenuItems({ steps: [], readAloudAvailable: true, readAloudOn: true, settingsAvailable: true }))
      .toEqual([{ kind: 'read-aloud', on: true }, { kind: 'settings' }]);
    expect(micMenuItems({ steps: [], readAloudAvailable: false, readAloudOn: true, settingsAvailable: true }))
      .toEqual([{ kind: 'settings' }]);
  });

  it('is empty on the phone (no switch, no settings): the plain mic, no caret', () => {
    expect(micMenuItems({ steps: [], readAloudAvailable: false, readAloudOn: false, settingsAvailable: false })).toEqual([]);
  });
});

describe('the "Set up dictation" step', () => {
  const base: DictationStepState = {
    installed: false, choice: null, engine: false, brew: true, key: false, recommended: 'small',
    models: [{ id: 'small', downloadMB: 466, onDisk: false, fits: true }, { id: 'large-v3-turbo', downloadMB: 1600, onDisk: false, fits: false }],
    phase: 'idle', received: 0, total: 0, error: null, pending: null,
  };

  it('one press installs the recommended size through the existing install', () => {
    expect(dictationStepPlan(base)).toEqual({ kind: 'install', model: 'small', downloadMB: 466, onDisk: false });
    expect(dictationStepPlan({ ...base, brew: false, engine: true, models: [{ id: 'small', downloadMB: 466, onDisk: true, fits: true }] }))
      .toEqual({ kind: 'install', model: 'small', downloadMB: 466, onDisk: true });
  });

  it('shows progress while installing', () => {
    expect(dictationStepPlan({ ...base, phase: 'engine' })).toEqual({ kind: 'engine' });
    expect(dictationStepPlan({ ...base, phase: 'model', pending: 'small', received: 233e6, total: 466e6 }))
      .toEqual({ kind: 'download', model: 'small', received: 233e6, total: 466e6, pct: 50 });
  });

  it('sends to Voice settings when one press cannot do it', () => {
    expect(dictationStepPlan({ ...base, brew: false, engine: false })).toMatchObject({ kind: 'settings', reason: 'no-brew' });
    expect(dictationStepPlan({ ...base, choice: { engine: 'cloud', model: null }, key: false })).toMatchObject({ kind: 'settings', reason: 'cloud-key' });
    expect(dictationStepPlan({ ...base, phase: 'error', error: 'boom' })).toEqual({ kind: 'settings', reason: 'error', error: 'boom' });
    expect(dictationStepPlan({ ...base, recommended: 'large-v3-turbo' })).toMatchObject({ kind: 'settings', reason: 'too-big' });
  });

  it('says it is checking before the state arrives', () => {
    expect(dictationStepPlan(null)).toEqual({ kind: 'checking' });
  });

  it('offers nothing once the fresh state says installed (a stale gate in another window)', () => {
    expect(dictationStepPlan({ ...base, installed: true, engine: true, phase: 'done' })).toEqual({ kind: 'checking' });
  });
});

describe('the composer wiring', () => {
  const composer = read('dashboard/src/components/sleepy/chat/Composer.tsx');
  const split = read('dashboard/src/components/sleepy/chat/MicSplit.tsx');

  it('gates the mic on the pure visibility rule, never on dictation', () => {
    expect(composer).toMatch(/const voiceEnabled = micVisible\(\{ inAppFrame, desktop: isDesktop\(\), phoneVoice \}\);/);
    expect(composer).not.toMatch(/voiceEnabled = [^\n]*dictationReady/);
  });

  it('a press with a step missing opens the menu instead of recording', () => {
    expect(composer).toMatch(/if \(micPressAction\(micStepsRef\.current, \{ dictationFixable: micSettingsRef\.current \}\) === 'open-menu'\) \{ setMicMenuOpen\(true\); return; \}/);
  });

  it('the separate speaker button is gone; spoken replies live in the split\'s menu', () => {
    expect(composer).not.toContain('chat-cmp-readaloud');
    expect(split).toMatch(/role="menuitemcheckbox" aria-checked=\{item\.on\}/);
    expect(composer).toMatch(/onToggleReadAloud=\{\(\) => toggleReadAloud\(!readAloud\)\}/);
  });

  it('Voice settings opens the Settings window on the Voice page', () => {
    expect(composer).toContain("emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'settings', id: 'voice' })");
  });

  it('in the notch a plan that needs Voice settings is a disabled row, never a dead button', () => {
    expect(split).toContain("disabled={busy || (plan.kind === 'settings' && !canOpenSettings)}");
    expect(split).toContain('canOpenSettings={settingsAvailable}');
  });

  it('dictation readiness crosses windows and is re-asked on focus; a failed ask is not cached', () => {
    const ready = read('dashboard/src/lib/voice/useDictationReady.ts');
    expect(ready).toContain("localStorage.setItem(STORAGE_KEY, String(Date.now()))");
    expect(ready).toContain("window.addEventListener('storage', onStorage)");
    expect(ready).toContain("window.addEventListener('focus', again)");
    expect(ready).toMatch(/if \(v === null\) return false;\s*cached = v;/);
  });

  it('the model step reuses the Settings installer, no second install path', () => {
    expect(split).toContain("import { useDictationState } from '../../settings/DictationInstall';");
    expect(split).not.toContain("fetch('/api/agent/voice/dictation'");
  });
});

describe('the shell commands', () => {
  it('are registered and granted to the windows that already record', () => {
    const lib = read('desktop/src-tauri/src/lib.rs');
    for (const c of ['mic_permission', 'mic_permission_request', 'mic_open_settings']) {
      expect(lib).toContain(`mic_permission::${c},`);
    }
    const toml = read('desktop/src-tauri/permissions/assistant.toml');
    expect(toml).toContain('commands.allow = ["mic_permission", "mic_permission_request", "mic_open_settings"]');
    for (const cap of ['default', 'assistant']) {
      const json = JSON.parse(read(`desktop/src-tauri/capabilities/${cap}.json`)) as { permissions: unknown[] };
      expect(json.permissions, cap).toContain('allow-mic-take');
      expect(json.permissions, cap).toContain('allow-mic-permission');
    }
  });

  it('opens a fixed System Settings URL, never one the page passes in', () => {
    const rs = read('desktop/src-tauri/src/mic_permission.rs');
    expect(rs).toContain('pub fn mic_open_settings() -> Result<(), String>');
    expect(rs).toContain('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  });
});
