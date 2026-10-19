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

  it('gives Plan, Develop AND the Assistant their own gear (the mic moved from J.A.R.V.I.S)', () => {
    expect(gearForMode('plan')).toBe('plan');
    expect(gearForMode('develop')).toBe('develop');
    expect(gearForMode('assistant')).toBe('assistant');
  });

  it('the Super Agent wears the cape (owner decision 11)', () => {
    expect(gearForMode('super')).toBe('super');
  });

  it('is total over every mode the server accepts', () => {
    for (const mode of CHAT_MODES) {
      const gear = gearForMode(mode);
      expect(gear === null || gear === 'plan' || gear === 'develop' || gear === 'assistant' || gear === 'super').toBe(true);
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
    const jarvis = src.slice(src.indexOf("kind === 'assistant' ?"), src.indexOf("kind === 'plan' ?"));
    const plan = src.slice(src.indexOf("kind === 'plan' ?"), src.indexOf("kind === 'develop' ?"));
    const develop = src.slice(src.indexOf("kind === 'develop' ?"));
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
    // The keyframes name rides the motion contract's variable (styles/global.css), so the
    // duration follows `var(--dc-motion-ambient-name, <name>)` rather than the bare name.
    const loop = (names: string, secs: string) =>
      new RegExp(`animation: var\\(--dc-motion-ambient-name, smascot-(${names})\\) ${secs.replace('.', '\\.')}s[^;]*;`, 'g');
    expect(css.match(loop('write', '3.8'))).toBeTruthy();
    expect(css.match(loop('ink', '3.8'))).toBeTruthy();
    expect((css.match(loop('weld|hammer|weldspark\\d?|hitspark\\d?|flame', '3.4')) ?? []).length).toBeGreaterThanOrEqual(8);
    expect((css.match(loop('vu|mic|say\\d', '3.2')) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('the Super Agent wears ONE costume, asked for by name: a cape fastened by the dream gem (decision 11)', () => {
    const src = sleepy('SleepyMascot.tsx');
    const css = sleepy('SleepyMascot.css');
    const cape = src.slice(src.indexOf("kind === 'super' ?"), src.indexOf("kind === 'assistant' ?"));
    // The cape (two flaps) and the clasp — the brand's folded diamond, crown over pavilion.
    expect(cape).toMatch(/smascot-cape-cloth--l/);
    expect(cape).toMatch(/smascot-cape-cloth--r/);
    expect(cape).toMatch(/smascot-gem-crown/);
    expect(cape).toMatch(/smascot-gem-pavilion/);
    // The rule's comment records the exception rather than contradicting it.
    expect(src).toMatch(/ONE COSTUME, asked for by name/);
    // Put on ONCE (a one-shot entrance, not on the contract's variables)…
    expect(css).toMatch(/\.smascot-cape-entering \.smascot-cape \{[^}]*animation: smascot-cape-on 400ms [^;]*;/);
    expect(css).not.toMatch(/animation: smascot-cape-on[^;]*infinite/);
    // …then the flutter is the loop: AMBIENT, so it stops unfocused and in Light mode.
    const loop = /animation: var\(--dc-motion-ambient-name, smascot-cape-flutter-[lr]\) 3\.2s[^;]*infinite;/g;
    expect((css.match(loop) ?? []).length).toBe(2);
  });

  it('the cape at rest is the cape hanging still: every flutter frame starts and ends at identity', () => {
    const css = sleepy('SleepyMascot.css');
    for (const name of ['smascot-cape-flutter-l', 'smascot-cape-flutter-r', 'smascot-cape-on']) {
      const kf = css.slice(css.indexOf(`@keyframes ${name}`));
      const body = kf.slice(0, kf.indexOf('}\n}') + 3);
      expect(body, name).toMatch(/100%[^{]*\{[^}]*(rotate\(0deg\) scale\(1, 1\)|translateY\(0\) scale\(1, 1\))/);
      expect(body, name).not.toMatch(/\b(width|height|top|left|fill|stroke)\s*:/);
    }
  });

  it('the cape goes on only when the hand-over asks (capeOn); everywhere else it is simply on', () => {
    const src = sleepy('SleepyMascot.tsx');
    const css = sleepy('SleepyMascot.css');
    // Opt-in, default off: the dock chip, the mode menu and a reload never play the entrance.
    expect(src).toMatch(/capeOn = false/);
    expect(src).toMatch(/gear === 'super' && capeOn \? ' smascot-cape-entering' : ''/);
    // The bare cape rule carries no animation: the entrance lives only on the opted-in face.
    const bare = css.slice(css.indexOf('.smascot-cape {'));
    expect(bare.slice(0, bare.indexOf('}'))).not.toMatch(/animation/);
  });

  it('Light mode and reduced motion: no cape entrance, no transform — the cape is simply on (D18)', () => {
    const css = sleepy('SleepyMascot.css');
    expect(css).toMatch(/:root\[data-light='true'\] \.smascot-cape-entering \.smascot-cape \{ animation: none; \}/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced.slice(0, reduced.indexOf('}'))).toMatch(/\.smascot-cape,[\s\S]*animation: none !important;/);
    // The SuperSurface gate decides it once at mount, and never in the crossfade's two cases.
    const surface = sleepy('super', 'SuperSurface.tsx');
    expect(surface).toMatch(/useState\(\(\) => motion === 'running' && !prefersReducedMotion\(\) && !isLightMode\(\)\)/);
  });

  it('the Super Agent keeps its smile: nothing is worked on under the chin, only fastened', () => {
    expect(sleepy('SleepyMascot.css')).toMatch(/\.smascot-wears-super \.smascot-smile \{ visibility: visible; \}/);
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
    for (const part of ['.smascot-pencil', '.smascot-ink', '.smascot-weld', '.smascot-flame', '.smascot-hammer', '.smascot-spark', '.smascot-vu-bar', '.smascot-mic', '.smascot-say', '.smascot-cape', '.smascot-cape-cloth']) {
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
