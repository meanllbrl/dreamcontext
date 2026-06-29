import { ModelBadge } from 'dreamcontext-dashboard';

// ModelBadge renders the model backing a council persona as a small mono pill.
// The hue is derived from the model name, so each model reads as a distinct
// accent: opus = indigo, sonnet = cyan, haiku = mint; others fall back to violet.

export const Opus = () => <ModelBadge model="opus" />;

export const Sonnet = () => <ModelBadge model="sonnet" />;

export const Haiku = () => <ModelBadge model="haiku" />;

export const Gpt = () => <ModelBadge model="gpt" />;

export const Lineup = () => (
  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
    <ModelBadge model="opus" />
    <ModelBadge model="sonnet" />
    <ModelBadge model="haiku" />
    <ModelBadge model="gpt" />
    <ModelBadge model="gemini" />
  </div>
);
