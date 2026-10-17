import { describe, it, expect } from 'vitest';
import { builderLaunchRefusal } from '../../src/cli/commands/builder-sessions.js';

describe('builderLaunchRefusal', () => {
  it('refuses on win32 with a reason', () => {
    expect(builderLaunchRefusal('win32')).toMatch(/not supported on Windows/);
  });

  it('allows darwin and linux', () => {
    expect(builderLaunchRefusal('darwin')).toBeNull();
    expect(builderLaunchRefusal('linux')).toBeNull();
  });
});
