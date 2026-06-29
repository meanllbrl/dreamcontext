import { PersonaAvatar } from 'dreamcontext-dashboard';

const noop = () => {};

// PersonaAvatar is a gradient chip with a glyph derived from the persona slug.
// Each council persona gets a stable color + glyph so they stay recognizable
// across rounds of a debate.

export const Lineup = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <PersonaAvatar slug="pragmatist" title="The Pragmatist" />
    <PersonaAvatar slug="visionary" title="The Visionary" />
    <PersonaAvatar slug="skeptic" title="The Skeptic" />
    <PersonaAvatar slug="optimist" title="The Optimist" />
    <PersonaAvatar slug="realist" title="The Realist" />
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <PersonaAvatar slug="pragmatist" size={36} title="default 36px" />
    <PersonaAvatar slug="pragmatist" size={48} title="large 48px" />
  </div>
);

export const Clickable = () => (
  <PersonaAvatar slug="skeptic" size={44} title="The Skeptic" onClick={noop} />
);
