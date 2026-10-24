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
  {
    file: 'tests/unit/agent-background-shells.test.ts',
    reason: 'backgroundOutputPath (src/server/routes/agent-chat.ts) mirrors the layout measured on the macOS CLI, /tmp/claude-<uid>/<realpath slug>/<uuid>/tasks; on Windows it yields D:\\tmp\\claude-0\\C:\\... (CI round 1). Where the Windows Claude CLI writes background-task output is not measured yet: a product follow-up that needs a real Windows machine, not a test fix.',
  },
];
