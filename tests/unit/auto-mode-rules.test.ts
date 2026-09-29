import { describe, it, expect } from 'vitest';
import { DREAMCONTEXT_AUTO_MODE, autoModeSettings } from '../../src/lib/auto-mode-rules.js';
import { DEVELOP_RECIPE } from '../../src/lib/develop-recipe.js';

describe('dreamcontext auto-mode carve-outs', () => {
  it('extends the shipped rules instead of replacing them', () => {
    expect(DREAMCONTEXT_AUTO_MODE.allow[0]).toBe('$defaults');
    expect(autoModeSettings()).toEqual({ autoMode: DREAMCONTEXT_AUTO_MODE });
  });

  // Drift guard: the carve-out names the builder launch by its marks — if the recipe stops
  // using one, the rule describes a shape nobody launches and the classifier blocks again.
  it.each(['DREAMCONTEXT_SPAWNED=develop', 'acceptEdits', '--allowedTools', 'tmp/develop/', 'claude -p', '--resume'])(
    'the rule and the Develop recipe share the mark %s',
    (mark) => {
      expect(DREAMCONTEXT_AUTO_MODE.allow[1]).toContain(mark);
      expect(DEVELOP_RECIPE).toContain(mark);
    },
  );
});
