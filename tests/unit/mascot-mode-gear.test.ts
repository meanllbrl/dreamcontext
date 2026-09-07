/**
 * Sleepy wears the chat MODE — and Basic still wears nothing.
 *
 * The owner's ask (2026-08-28, with a screenshot of the dock) was "let this character look
 * different in Plan mode and Develop mode; the current look stays as the Basic look". Both
 * halves are load-bearing, and the second one is the half a careless change breaks: a default
 * that quietly started drawing gear would restyle the notch perch, the sleep-debt tracker and
 * the zero-session FAB — every surface that mounts the face WITHOUT a chat behind it.
 *
 * So: `gearForMode` must be total over `ChatMode`, and everything without gear — `basic` and
 * `undefined` (a chat that never left Basic, and every non-chat caller) — must map to `null`,
 * the bare face.
 *
 * J.A.R.V.I.S USED TO BE IN THAT LIST, and the case below is rewritten rather than extended.
 * It mapped to `null` while the mode was announced-but-unpickable; the owner's call is that a
 * mode you TALK to gets its own gear, like Plan and Develop. Worth naming why this test had to
 * change deliberately: it passed either way. A face that quietly kept wearing nothing would
 * have shipped an undecided design, with nothing failing to say so.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gearForMode } from '../../dashboard/src/components/sleepy/SleepyMascot.js';
import { CHAT_MODES } from '../../src/server/chat-modes.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const sleepy = (...p: string[]) => readFileSync(join(ROOT, 'dashboard', 'src', 'components', 'sleepy', ...p), 'utf-8');

describe('gearForMode', () => {
  it('draws the bare face for Basic and an absent mode — the half a careless change breaks', () => {
    expect(gearForMode('basic')).toBe(null);
    expect(gearForMode(undefined)).toBe(null);
  });

  it('gives Plan, Develop AND J.A.R.V.I.S their own gear', () => {
    expect(gearForMode('plan')).toBe('plan');
    expect(gearForMode('develop')).toBe('develop');
    expect(gearForMode('jarvis')).toBe('jarvis');
  });

  it('is total over every mode the server accepts', () => {
    for (const mode of CHAT_MODES) {
      const gear = gearForMode(mode);
      expect(gear === null || gear === 'plan' || gear === 'develop' || gear === 'jarvis').toBe(true);
    }
  });
});

describe('the gear reaches the surfaces that draw a chat', () => {
  it('the mascot only mounts gear when a mode asked for it', () => {
    const src = sleepy('SleepyMascot.tsx');
    // The bare face is the DEFAULT branch, not a mode that happens to draw nothing.
    expect(src).toMatch(/\{gear && <Gear kind=\{gear\} \/>\}/);
  });

  it('the dock chip hands each row its own mode', () => {
    const src = sleepy('AgentDock.tsx');
    expect(src).toMatch(/<SleepyMascot mood=\{row\.info\.mood\}[^/]*mode=\{row\.mode\}/);
  });

  it('each mode is an ACTION on a loop, not a costume', () => {
    const src = sleepy('SleepyMascot.tsx');
    const css = sleepy('SleepyMascot.css');
    const jarvis = src.slice(src.indexOf("kind === 'jarvis' ?"), src.indexOf("kind === 'plan' ?"));
    const plan = src.slice(src.indexOf("kind === 'plan' ?"), src.indexOf(') : ('));
    const develop = src.slice(src.indexOf(') : ('));
    // Plan writes: a pencil and the ink it lays down. Develop forges: a hammer and the joint
    // it beats. J.A.R.V.I.S converses: a microphone and a level meter. Motion is what carries
    // the difference at the 24px dock size, where the detail is gone — so the animated parts
    // are the thing worth pinning.
    expect(plan).toMatch(/smascot-pencil/);
    expect(plan).toMatch(/smascot-ink/);
    expect(develop).toMatch(/smascot-hammer/);
    expect(develop).toMatch(/smascot-weld/);
    expect(jarvis).toMatch(/smascot-mic/);
    expect(jarvis).toMatch(/smascot-vu-bar/);
    // Every loop runs off ONE clock per mode, so the hand and what it produces cannot drift.
    expect(css.match(/animation: smascot-write 3\.8s[^;]*;/)).toBeTruthy();
    expect(css.match(/animation: smascot-ink 3\.8s[^;]*;/)).toBeTruthy();
    expect((css.match(/smascot-(weld|hammer|weldspark\d?|hitspark\d?|flame) 3\.4s/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect((css.match(/smascot-(vu|mic|say\d) 3\.2s/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('J.A.R.V.I.S\'s loop is a CONVERSATION — it listens, then it answers', () => {
    // The two beats are the whole idea, and they live in the amplitude of one keyframe: low
    // while listening, tall while answering. That is what survives at 26px once the mic is
    // three pixels wide, so it is what gets pinned rather than the drawing.
    const css = sleepy('SleepyMascot.css');
    const vu = css.slice(css.indexOf('@keyframes smascot-vu'));
    const peaks = [...vu.slice(0, vu.indexOf('}\n\n')).matchAll(/scaleY\(([\d.]+)\)/g)].map((m) => Number(m[1]));
    expect(Math.max(...peaks)).toBeGreaterThan(1);   // it swells to answer
    expect(Math.min(...peaks)).toBeLessThan(0.5);    // and drops back to listen
  });

  it('every moving part stands down under prefers-reduced-motion', () => {
    const css = sleepy('SleepyMascot.css');
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const part of ['.smascot-pencil', '.smascot-ink', '.smascot-weld', '.smascot-flame', '.smascot-hammer', '.smascot-spark', '.smascot-vu-bar', '.smascot-mic', '.smascot-say']) {
      expect(block).toContain(part);
    }
  });

  it('the mode menu shows each mode doing its own work', () => {
    const src = readFileSync(join(ROOT, 'dashboard', 'src', 'components', 'sleepy', 'chat', 'ComposerMenus.tsx'), 'utf-8');
    // The picker is where the mapping is TAUGHT: Basic draws the bare face, so what you are
    // turning off is as visible as what you are turning on.
    expect(src).toMatch(/<SleepyMascot size=\{\d+\} mood="idle" compact mode=\{row\.id\} \/>/);
  });

  it('mode is a shape channel — the gear never hardcodes a colour', () => {
    const css = sleepy('SleepyMascot.css');
    const gearBlock = css.slice(css.indexOf('.smascot-gear {'), css.indexOf('/* ── Keyframes'));
    // Mood owns every hue in this file; gear is drawn in the theme's ink so the two channels
    // stay independent (and so it reads on a light chip as well as a dark one).
    expect(gearBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(gearBlock).toMatch(/var\(--color-text\)/);
  });
});
