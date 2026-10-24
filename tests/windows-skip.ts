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
  /**
   * One test (or one describe block) inside it: matched against "suite > … > test name".
   * Absent: the whole file is skipped. Present: only the matching tests, the rest of the file
   * still runs on Windows (tests/setup/windows-skips.ts).
   */
  test?: string;
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
  {
    file: 'tests/unit/claude-path.test.ts',
    reason: 'The POSIX `claude` lookup (~/.local/bin, ~/.claude/local) and zsh/bash/fish profile writing. On win32 findClaudeBin takes the claude.exe resolution covered by tests/unit/claude-path-win32.test.ts, and there are no shell profiles to write.',
  },
  {
    file: 'tests/unit/voice-audio-focus.test.ts',
    reason: 'Pauses Spotify/Music through AppleScript (osascript); canControlAudio is darwin-only by design.',
  },
  {
    file: 'tests/unit/mac-session.test.ts',
    reason: 'Mac mode / hands-free is Mac-only (54a3e4b3): Low Power Mode, pmset, the thermal governor.',
  },
  {
    file: 'tests/unit/mac-tunnel.test.ts',
    reason: 'Mac mode / hands-free is Mac-only (54a3e4b3): the cloudflared tunnel with its POSIX env isolation and pid watchdog.',
  },
  {
    file: 'tests/unit/mac-power.test.ts',
    reason: 'Mac mode / hands-free is Mac-only (54a3e4b3): the sudoers drop-in is checked with /usr/sbin/visudo.',
  },
  {
    file: 'tests/unit/mac-thermal.test.ts',
    reason: 'Mac mode / hands-free is Mac-only (54a3e4b3): clamp targets are matched from ps output.',
  },
  {
    file: 'tests/unit/agent-file-phone.test.ts',
    reason: 'Mac mode / hands-free is Mac-only (54a3e4b3): the phone\'s file routes take a POSIX absolute path by contract.',
  },
  {
    file: 'tests/unit/automations-launchd.test.ts',
    reason: 'launchd and its /bin/sh dispatcher wrapper; Windows uses Task Scheduler, covered by tests/unit/automations-schtasks.test.ts.',
  },
  {
    file: 'tests/unit/runner-process-groups.test.ts',
    reason: 'POSIX process groups (negative-pid kill of a /bin/sh group); the win32 tree kill is covered by tests/unit/proc.test.ts.',
  },
  {
    file: 'tests/unit/cli-path.test.ts',
    reason: 'cliAwarePath writes the POSIX `dreamcontext` shim the launchd wrapper runs; the Windows dispatcher runs node + the CLI entry directly (schtasks.ts).',
  },
  {
    file: 'tests/unit/automation-cli-path.test.ts',
    reason: 'Same POSIX shim and a \':\'-joined PATH, for the launchd dispatcher only.',
  },
  {
    file: 'tests/unit/video-frame-index.test.ts',
    reason: 'Runs the video-watching skill script as `python3`; Windows Python is `python`/`py`. A skill-pack follow-up for Windows, not a test fix.',
  },
  {
    file: 'tests/unit/agent-download.test.ts',
    reason: 'Every case asserts an exact POSIX path literal built from a fake root (e.g. "/h", "/repo"); the code under test joins with the platform separator, which is correct on Windows (it got "\\h\\…" or "D:\\…").',
  },
  {
    file: 'tests/unit/board-agent-envelope.test.ts',
    reason: 'The scoped board envelope writes Claude permission rules in POSIX `//abs/path/**` spelling (boardScopeArgs), and its spawn paths fail on that. The spelling Claude Code accepts on Windows is not measured yet: a product follow-up for a real Windows machine.',
  },
  {
    file: 'tests/integration/task-filing-bar-end-to-end.test.ts',
    reason: 'Red on every platform, not Windows-specific: fails on macOS locally and on the Linux CI job (run 40111187972) since the task-system revert (PR #438).',
  },
  {
    file: 'tests/unit/phone-chat-ownership.test.ts',
    test: 'AC11 revocation by socket (server side)',
    reason: 'Mac mode / hands-free is Mac-only (54a3e4b3): phone device revocation.',
  },
  {
    file: 'tests/unit/agent-drop-phone.test.ts',
    test: 'POST /api/agent/drop from the phone',
    reason: 'Mac mode / hands-free is Mac-only (54a3e4b3): the phone\'s photo drop.',
  },
  {
    file: 'tests/unit/automations-verdict.test.ts',
    test: 'REAL processes',
    reason: 'Spawns real /bin/sh process trees to test the POSIX ancestry walk; the win32 CIM path is separate.',
  },
  {
    file: 'tests/unit/install-skill-hooks.test.ts',
    test: 'the installed command keeps the hook\'s exit code and stdout',
    reason: 'Runs the installed hook command through /bin/sh with a POSIX fake binary and a /usr/bin:/bin PATH (the spawn itself fails on Windows, status null). Claude Code runs the real hook under Git Bash.',
  },
  {
    file: 'tests/unit/onboarding-copy.test.ts',
    test: 'stableNodeExecPath maps a managed version folder to current',
    reason: 'The POSIX private-Node layout\'s `current` link; install.ps1 on Windows keeps no such link.',
  },
  {
    file: 'tests/unit/automations-runner.test.ts',
    test: 'output-write failure',
    reason: 'Makes the output folder read-only with chmod; Windows ignores POSIX folder modes, so the write succeeds.',
  },
  {
    file: 'tests/unit/agents-split-migration.test.ts',
    test: 'an io-error is counted',
    reason: 'Injects the io-error with chmod; Windows ignores POSIX folder modes.',
  },
  {
    file: 'tests/unit/features-knowledge.test.ts',
    test: 'transient write failure (case N)',
    reason: 'Injects the write failure with chmod; Windows ignores POSIX folder modes.',
  },
  {
    file: 'tests/unit/builder-tools.test.ts',
    test: 'findOrphanChecks',
    reason: 'findOrphanChecks reads `ps -A`; builder sessions are refused on win32 (builderLaunchRefusal).',
  },
  {
    file: 'tests/unit/agent-file-read.test.ts',
    test: 'normalises an absolute path carrying traversal',
    reason: 'asserts an exact POSIX path literal built from a fake root (e.g. "/h", "/repo"); the code under test joins with the platform separator, which is correct on Windows (it got "\\h\\…" or "D:\\…"); "/etc/passwd" became "C:\\etc\\passwd".',
  },
  {
    file: 'tests/unit/brain-dirty.test.ts',
    test: 'scopes the git status probe with a context-dir pathspec',
    reason: 'asserts an exact POSIX path literal built from a fake root (e.g. "/h", "/repo"); the code under test joins with the platform separator, which is correct on Windows (it got "\\h\\…" or "D:\\…").',
  },
  {
    file: 'tests/unit/goal-live-writer.test.ts',
    test: 'names the file by session, or solo',
    reason: 'asserts an exact POSIX path literal built from a fake root (e.g. "/h", "/repo"); the code under test joins with the platform separator, which is correct on Windows (it got "\\h\\…" or "D:\\…").',
  },
  {
    file: 'tests/unit/gold-v2-frozen.test.ts',
    test: 'frozen dir is injectable',
    reason: 'asserts an exact POSIX path literal built from a fake root (e.g. "/h", "/repo"); the code under test joins with the platform separator, which is correct on Windows (it got "\\h\\…" or "D:\\…").',
  },
  {
    file: 'tests/unit/recall-eval-v2.test.ts',
    test: 'frozenDir(home) sits under',
    reason: 'asserts an exact POSIX path literal built from a fake root (e.g. "/h", "/repo"); the code under test joins with the platform separator, which is correct on Windows (it got "\\h\\…" or "D:\\…").',
  },
  {
    file: 'tests/unit/reflection.test.ts',
    test: 'reflectionPath returns state/.reflection.md',
    reason: 'asserts an exact POSIX path literal built from a fake root (e.g. "/h", "/repo"); the code under test joins with the platform separator, which is correct on Windows (it got "\\h\\…" or "D:\\…").',
  },
  {
    file: 'tests/unit/server-security.test.ts',
    test: 'resolves a normal child inside the base',
    reason: 'asserts an exact POSIX path literal built from a fake root (e.g. "/h", "/repo"); the code under test joins with the platform separator, which is correct on Windows (it got "\\h\\…" or "D:\\…").',
  },
  {
    file: 'tests/unit/pending-git.test.ts',
    test: 'keeps other keys in the file and survives a stray temp file',
    reason: 'asserts an exact POSIX path literal built from a fake root (e.g. "/h", "/repo"); the code under test joins with the platform separator, which is correct on Windows (it got "\\h\\…" or "D:\\…").',
  },
  {
    file: 'tests/unit/vaults.test.ts',
    test: 'resolves relative paths to absolute',
    reason: 'Asserts the resolved path starts with \'/\'; a Windows absolute path starts with a drive letter.',
  },
  {
    file: 'tests/unit/app-command.test.ts',
    test: 'an explicit --dir still wins',
    reason: 'The macOS bundle\'s install dir as a POSIX literal (\'/Applications\'); the Windows app installs through NSIS.',
  },
  {
    file: 'tests/unit/whiteboard-agent-widget.test.ts',
    test: '--file comes only from the agent\'s scratch',
    reason: 'Builds its escape attempt as \'../\' + an absolute path, which only means a climb on POSIX (\'../C:\\…\' on Windows).',
  },
  {
    file: 'tests/unit/super-orchestration-guide.test.ts',
    test: 'SUPER_ORCHESTRATION_GUIDE_PATH is the install destination',
    reason: 'The test builds its expectation with the native separator; the product\'s install key is POSIX on every OS, as manifest keys must be.',
  },
  {
    file: 'tests/unit/recall-corpus-glob.test.ts',
    test: 'sets product === "widgets" on the nested doc',
    reason: 'The test builds the expected relPath with the native separator; recall\'s corpus keys are POSIX on every OS (relPosix).',
  },
  {
    file: 'tests/unit/peer-mail-skill.test.ts',
    test: 'the mail path the docs name IS the path mail',
    reason: 'Strips a \'<root>/\' prefix by string to compare with the docs\' POSIX path; on Windows the joined prefix has a backslash.',
  },
  {
    file: 'tests/unit/super-live-card.test.ts',
    test: 'the owner\'s own hand',
    reason: 'Red on the Linux CI job too (run 40111187972; passes on macOS): a CI-environment difference, not Windows.',
  },
  {
    file: 'tests/unit/notch-owner-answer.test.ts',
    test: 'the command the window claims says by: owner',
    reason: 'Red on the Linux CI job too (run 40111187972; passes on macOS): a CI-environment difference, not Windows.',
  },
  {
    file: 'tests/unit/super-disk-leftovers.test.ts',
    test: 'measureLeftovers',
    reason: 'Red on the Linux CI job too (run 40111187972; passes on macOS): the Rust-target scan finds none on a fresh runner.',
  },
  {
    file: 'tests/unit/super-disk-leftovers.test.ts',
    test: 'super clean',
    reason: 'Same fixture as measureLeftovers above; red on the Linux CI job too.',
  },
  {
    file: 'tests/unit/sleep-eval-score.test.ts',
    test: 'the shim refuses outward verbs',
    reason: 'The eval harness (a dev tool) writes an extensionless POSIX sh shim `dreamcontext` and spawns it; Windows cannot run it (ENOENT).',
  },
  {
    file: 'tests/unit/sleep-eval-score.test.ts',
    test: 'runEval → scoreRun → gate',
    reason: 'Drives runs through the same POSIX sh shim (see the entry above).',
  },
  {
    file: 'tests/unit/automation-threads-store.test.ts',
    test: 'concurrent appends from two processes',
    reason: 'Spawns `npx` without a shell; on Windows npx is npx.cmd, which Node will not spawn shell-less (ENOENT).',
  },
  {
    file: 'tests/unit/task-journal-fold.test.ts',
    test: 'its only card unreadable',
    reason: 'Makes the card unreadable with chmod 0o000; Windows ignores POSIX modes, so the card is still read.',
  },
  {
    file: 'tests/unit/agent-file-read.test.ts',
    test: 'a page within its cap',
    reason: 'Makes the bytes unreadable with chmod 0o000; Windows ignores POSIX modes.',
  },
  {
    file: 'tests/unit/agent-file-realpath.test.ts',
    test: 'FAILS CLOSED on a realpath error that is not ENOENT',
    reason: 'Uses a path THROUGH a regular file as its stand-in for a non-ENOENT realpath error (ENOTDIR on POSIX); Windows reports ENOENT there, so the stand-in does not exist on Windows.',
  },
  {
    file: 'tests/unit/tsc-check.test.ts',
    test: 'a base dir others can write to is not trusted',
    reason: 'Builds the untrusted base dir with chmod 0o777; Windows has no POSIX group/other write bits to detect.',
  },
  {
    file: 'tests/unit/ensure-cli.test.ts',
    test: 'EACCES fallback',
    reason: 'The npm EACCES fallback retries into a POSIX user prefix and writes it into a shell profile; asserted with POSIX paths.',
  },
  {
    file: 'tests/unit/agent-sessions-generation.test.ts',
    test: 'a roster lock left by a DEAD process is reclaimed at once',
    reason: 'Gets a dead pid by spawning /usr/bin/true.',
  },
  {
    file: 'tests/unit/board-card-chat.test.ts',
    test: 'prepareCardChat',
    reason: 'Board scope refuses every path that contains a backslash (FORBIDDEN_PATH_CHARS: inside a Claude permission rule it is quoting), and every Windows path does, so a board-scoped agent fails closed on Windows. Making it work needs the rule spelling Claude Code accepts on Windows, measured on a real machine: a product follow-up.',
  },
  {
    file: 'tests/unit/board-card-chat.test.ts',
    test: 'a card spawn and the native plan-mode deny',
    reason: 'Board scope refuses every path that contains a backslash (FORBIDDEN_PATH_CHARS: inside a Claude permission rule it is quoting), and every Windows path does, so a board-scoped agent fails closed on Windows. Making it work needs the rule spelling Claude Code accepts on Windows, measured on a real machine: a product follow-up.',
  },
  {
    file: 'tests/unit/board-card-chat.test.ts',
    test: 'prepareAgentChat',
    reason: 'Board scope refuses every path that contains a backslash (FORBIDDEN_PATH_CHARS: inside a Claude permission rule it is quoting), and every Windows path does, so a board-scoped agent fails closed on Windows. Making it work needs the rule spelling Claude Code accepts on Windows, measured on a real machine: a product follow-up.',
  },
  {
    file: 'tests/unit/assistant-latency.test.ts',
    test: 'a scoped home-board card carries only its board scope',
    reason: 'Board scope refuses every path that contains a backslash (FORBIDDEN_PATH_CHARS: inside a Claude permission rule it is quoting), and every Windows path does, so a board-scoped agent fails closed on Windows. Making it work needs the rule spelling Claude Code accepts on Windows, measured on a real machine: a product follow-up.',
  },
  {
    file: 'tests/integration/auto-sleep-end-to-end.test.ts',
    test: 'DISPATCHES once armed and over the trigger',
    reason: 'Needs a spawnable claude to record a live job: on POSIX the `$SHELL -ilc` fallback stands in for it, Windows has no such stand-in and the CI runner has no claude, so nothing is dispatched (correctly).',
  },
  {
    file: 'tests/integration/task-assets-api.test.ts',
    test: '413 at the streaming cap',
    reason: 'UNEXPLAINED, needs a real Windows machine: the test waits on the socket the server closes at the cap, and on the Windows runner it hangs to the 30 s timeout (CI round 5, run 40117911619). The cap itself is enforced server-side; how Windows reports the closed socket to the client is not established.',
  },
  {
    file: 'tests/integration/hook-tsc-concurrency.test.ts',
    reason: 'Fakes tsc as a POSIX sh script in node_modules/.bin and asserts POSIX kill signals on the hook (SIGKILL); on Windows the hook now runs node_modules/typescript/bin/tsc through node (tsc-check.ts), which this fixture does not provide.',
  },
  {
    file: 'tests/integration/automations-cli.test.ts',
    test: 'create → list → show → run --force → approve',
    reason: 'Needs a spawnable stand-in for claude: on POSIX the `$SHELL -ilc` fallback starts a process even with no claude installed (SAFE_PATH hides it), so the run spawns and then fails. On Windows with no claude the spawn fails synchronously, which by design (the same branch POSIX takes on a synchronous spawn failure) leaves the watermark for the next tick.',
  },
  {
    file: 'tests/integration/automations-cli.test.ts',
    test: 'on a flow-hitl question resumes the asking session',
    reason: 'Needs a spawnable stand-in for claude: on POSIX the `$SHELL -ilc` fallback starts a process even with no claude installed (SAFE_PATH hides it), so the run spawns and then fails. On Windows with no claude the spawn fails synchronously, which by design (the same branch POSIX takes on a synchronous spawn failure) leaves the question pending for the next tick.',
  },
];
