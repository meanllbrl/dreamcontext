/**
 * Test files the Windows CI job (`test-windows` in .github/workflows/ci.yml) does not run.
 *
 * The list is EXPLICIT on purpose: a Windows failure is either fixed or written down here with
 * its reason, never hidden by making the job non-blocking. vitest.config.ts excludes these only
 * when the suite runs on win32; everywhere else every file still runs. A file leaves this list
 * the day it passes on Windows. tests/unit/windows-skip-list.test.ts keeps every entry honest
 * (the file exists, the reason is written).
 *
 * Seeded with what is POSIX by design. The rest comes from the first windows-latest run: a
 * failure there is fixed, or listed here with what makes it Windows-incompatible.
 */
export interface WindowsSkip {
  /** Repo-relative path of the test file. */
  file: string;
  /** Why it cannot pass on Windows (the mechanism, not "fails"). */
  reason: string;
}

export const WINDOWS_SKIPS: readonly WindowsSkip[] = [
  {
    file: 'tests/unit/install-script.test.ts',
    reason: 'Runs install.sh through `sh` with a POSIX tar fixture. install.sh is the macOS/Linux installer; Windows uses install.ps1, covered by tests/unit/install-ps1.test.ts.',
  },
];
