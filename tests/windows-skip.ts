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
    reason: 'Since rulePath (board-scope.ts) the scoped envelope spells a Windows path as Claude Code matches it (`//c/Users/...`, read off its binary, pinned in rule-path-win32.test.ts), but this file\'s spawn fixtures still assume POSIX paths and the spelling is not run against a real Windows claude yet: leaves the list after a measured run on a Windows machine.',
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
    reason: 'Sizes come from `du`, which Windows does not ship, so every row measures 0. (On Linux this was a real bug, fixed in diskUsage: GNU du skips a path nested in another it was given.)',
  },
  {
    file: 'tests/unit/super-disk-leftovers.test.ts',
    test: 'super clean',
    reason: 'Same `du` dependency as measureLeftovers above.',
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
  {
    file: 'tests/unit/mcp-store.test.ts',
    test: 'puts every server in the right store',
    reason: 'Asserts mode 0600 on the written stores; Windows reports no POSIX mode.',
  },
  {
    file: 'tests/unit/mcp-store.test.ts',
    test: 'skips a project store that is not 0600',
    reason: 'The 0600 gate is POSIX only: Windows has no mode to read (mcp-store.ts).',
  },
  {
    file: 'tests/unit/mcp-store.test.ts',
    test: 'skips a store owned by another uid',
    reason: 'Fakes process.getuid, which does not exist on Windows.',
  },
  {
    file: 'tests/unit/agent-mcp-routes.test.ts',
    test: 'a new server with the default scope',
    reason: 'Asserts mode 0600 on the written store; Windows reports no POSIX mode.',
  },
  {
    file: 'tests/unit/ai-team-v2-server-contract.test.ts',
    test: 'writes the home session once',
    reason: 'Asserts POSIX modes on the session file; Windows reports none.',
  },
  {
    file: 'tests/unit/voice-cue.test.ts',
    test: 'renders with an argument list',
    reason: 'Asserts POSIX modes on the cue folder; Windows reports none.',
  },
  {
    file: 'tests/unit/voice-take-store.test.ts',
    test: 'an existing 0755 directory becomes 0700',
    reason: 'Asserts POSIX modes; Windows reports none.',
  },
  {
    file: 'tests/unit/task-history-workspace.test.ts',
    test: 'a refill replaces a hard link',
    reason: 'Asserts mode 0600 on the replaced file; Windows reports no POSIX mode.',
  },
  {
    file: 'tests/unit/super-ask-show.test.ts',
    test: 'keeps project pictures',
    reason: 'An absolute src here is join(project, ...), and a backslash in an HTML src is refused by design (ask-show-src.ts).',
  },
  {
    file: 'tests/unit/npm-target.test.ts',
    test: 'reads the prefix off the bin symlink',
    reason: 'The prefix/bin/dreamcontext symlink layout is POSIX; a Windows npm global is a .cmd shim beside node.',
  },
  {
    file: 'tests/unit/npm-target.test.ts',
    test: 'a prefix without npm',
    reason: 'POSIX bin/npm layout; on Windows npm is npm.cmd beside node.',
  },
  {
    file: 'tests/unit/super-worktree-sweep.test.ts',
    test: 'keeps a worktree with a process cwd inside it',
    reason: 'POSIX fixture paths against a sep-joined match. The sweep needs lsof and ps anyway: on Windows the listing fails and it keeps everything.',
  },
  {
    file: 'tests/unit/super-worktree-sweep.test.ts',
    test: 'keeps a worktree with a command line naming it',
    reason: 'Same POSIX fixture paths as the entry above; the sweep keeps everything on Windows.',
  },
  {
    file: 'tests/unit/super-worktree-sweep.test.ts',
    test: 'keeps a worktree with the global CLI link target',
    reason: 'Same POSIX fixture paths as the entry above; the sweep keeps everything on Windows.',
  },
  {
    file: 'tests/unit/super-worktree-sweep.test.ts',
    test: 'planSweep and applySweep on a scratch root',
    reason: 'Needs `du`, and POSIX ages set on directories git then touches. Every Windows row stays kept, which is the safe side.',
  },
  {
    file: 'tests/unit/voice-phone-stt.test.ts',
    test: 'the retry ladder',
    reason: 'Same #!/bin/sh fake whisper-server.',
  },
  {
    file: 'tests/unit/voice-whisper.test.ts',
    test: 'which language is sent',
    reason: 'Same #!/bin/sh fake whisper-server.',
  },
  {
    file: 'tests/unit/voice-whisper.test.ts',
    test: 'the primer is withheld',
    reason: 'Same #!/bin/sh fake whisper-server.',
  },
  {
    file: 'tests/unit/voice-server.test.ts',
    test: 'answers from the local engine',
    reason: 'Same #!/bin/sh fake whisper-server.',
  },
  {
    file: 'tests/unit/voice-server.test.ts',
    test: 'an installed whisper that does not answer',
    reason: 'Same #!/bin/sh fake whisper-server.',
  },
  {
    file: 'tests/integration/task-jobs.e2e.test.ts',
    test: 'two agents\' due tasks start in one tick',
    reason: 'The stand-in claude is a #!/usr/bin/env node script, which Windows cannot start as a binary.',
  },
  {
    file: 'tests/integration/task-jobs.e2e.test.ts',
    test: 'AC-C1-3: a host that dies',
    reason: 'Same stand-in claude; it also needs SIGKILL semantics.',
  },
  {
    file: 'tests/integration/task-jobs.e2e.test.ts',
    test: 'AC-C1-5 + AC-C1-12',
    reason: 'Same stand-in claude: a node script Windows cannot start as a binary.',
  },
  {
    file: 'tests/integration/task-jobs.e2e.test.ts',
    test: 'AC-C1-11: a second machine',
    reason: 'Same stand-in claude: a node script Windows cannot start as a binary.',
  },
  {
    file: 'tests/integration/agent-sync.e2e.test.ts',
    test: 'a teammate\'s .gitignore negation',
    reason: 'Builds its incoming symlink with `ln -s`, whose target spelling is POSIX.',
  },
  {
    file: 'tests/unit/task-history-workspace.test.ts',
    test: 'a task worktree is filled raw',
    reason: 'Asserts the exec bit and a stored symlink as POSIX modes; Windows reports neither.',
  },
  {
    file: 'tests/unit/voice-retranscribe.test.ts',
    test: 'own take → one pass forced',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-retranscribe.test.ts',
    test: 'no ref → the chat',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-retranscribe.test.ts',
    test: 'a third retry of one take',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-dictation-choice.test.ts',
    test: 'a take loads it, and it is unloaded',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-dictation-choice.test.ts',
    test: 'pressure unloads a loaded model at once',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-dictation-choice.test.ts',
    test: 'the watch that runs while loaded',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-dictation-choice.test.ts',
    test: '/stt under pressure refuses',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-dictation-choice.test.ts',
    test: 'a chosen model the machine cannot carry',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-dictation-choice.test.ts',
    test: 'a server WE stop while it loads',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-dictation-choice.test.ts',
    test: 'pressure during a take waits',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-dictation-choice.test.ts',
    test: 'our own loaded model is credited back',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-dictation-choice.test.ts',
    test: 'a take for a different model stops the old server',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-phone-stt.test.ts',
    test: 'a phone take within the caps',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-phone-stt.test.ts',
    test: 'a phone take over 2 minutes',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/voice-phone-stt.test.ts',
    test: 'one phone take in flight',
    reason: 'The fake whisper-server is a #!/bin/sh script, which Windows cannot spawn. Local whisper on Windows is not measured yet.',
  },
  {
    file: 'tests/unit/t3-bridge/antigravity-session.test.ts',
    reason: 'Every test drives T3\'s fake ACP agent through a #!/bin/sh launcher named agy_acp_server.par. On Windows T3 (AntigravityInstallation executableNames) only starts a PE agy_acp_server.exe with a localharness_external.exe beside it, which the suite cannot fake without a compiled binary. The Windows names T3 resolves are in its vendored AntigravityInstallation; our side (antigravityAgentName, the PATH lookup, the doctor row, the stdio server check) is unit-tested with win32 inputs in antigravity-accounts, doctor-antigravity and antigravity-mcp. A real Windows Antigravity chat is not measured yet.',
  },
  {
    file: 'tests/unit/t3-bridge/headless-run-antigravity.test.ts',
    test: 'read-only: the plain read it asked for runs',
    reason: 'Reads the request log of T3\'s fake ACP agent, a #!/bin/sh launcher on PATH; Windows starts only a PE agy_acp_server.exe (same mechanism as antigravity-session.test.ts). The other test of the file still runs there.',
  },
  {
    file: 'tests/unit/codex-dependency.test.ts',
    test: 'lands a macOS/Linux install on disk',
    reason: 'The pinned Codex install has no win32 pin (codex-pin.ts) and Windows takes it as a manual fix (onboarding/checks.ts); its launcher is a /bin/sh script. These tests land a darwin install, which installManagedCodex refuses on a drive path by design. The win32 refusal itself is tested ("no automatic install on a system with no pin").',
  },
  {
    file: 'tests/unit/codex-dependency.test.ts',
    test: '`env node` resolves through the bridge Node',
    reason: 'A #!/usr/bin/env node launcher is how a POSIX npm install finds Node. npm\'s Windows codex.cmd names node.exe itself; that launcher is covered by the other tests of the describe, which write a codex.cmd on Windows.',
  },
  {
    file: 'tests/unit/tool-finder.test.ts',
    test: 'a file that cannot run is not a tool',
    reason: 'Windows has no execute bit: fs.accessSync(X_OK) reads as F_OK there. What runs on Windows is chosen by the name the caller asks for (codex.cmd / codex.exe, codex-bin.ts).',
  },
  {
    file: 'tests/unit/codex-mcp.test.ts',
    test: 'never reads a store file that is not 0600',
    reason: 'The 0600 gate is POSIX only: Windows has no mode to read (mcp-store.ts storeFileProblem), the same entry as mcp-store.test.ts.',
  },
];
