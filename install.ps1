# dreamcontext install script for Windows
# Review this script before piping it to iex: https://www.npmjs.com/package/dreamcontext
#
#   irm https://cdn.jsdelivr.net/npm/dreamcontext/install.ps1 | iex
#
# No admin rights needed. The same switches as install.sh, as environment variables:
#   DREAMCONTEXT_INSTALL_NO_NODE   never download Node.js; stop when no usable Node is found
#   DREAMCONTEXT_INSTALL_NO_APP    skip the desktop app
#   DREAMCONTEXT_INSTALL_NO_SETUP  skip `dreamcontext setup`
#
# Everything runs inside one function. `iex` runs a script in the caller's own session, so a
# top-level `exit` would close the user's window and a top-level preference variable
# ($ErrorActionPreference, $ProgressPreference) would stay changed in it afterwards.

function Install-Dreamcontext {
  [CmdletBinding()]
  param()

  $ErrorActionPreference = 'Stop'
  # Windows PowerShell 5.1 redraws a progress bar per received block, which makes a 37 MB
  # download take minutes.
  $ProgressPreference = 'SilentlyContinue'
  Set-StrictMode -Version 2.0

  $NodeMinMajor = 18

  # The private Node.js installed when this computer has no usable Node. These values MIRROR
  # assets/runtime-pins.json (node.version, node.base, nodeWindows.files);
  # tests/unit/runtime-pins-mirror.test.ts fails the moment the two disagree.
  $NodeVersion = '24.21.0'
  $NodeBaseUrl = 'https://nodejs.org/dist/v24.21.0/'
  $NodePins = @{
    'win-x64' = @{ File = 'node-v24.21.0-win-x64.zip'; Sha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'; Size = 37618919 }
    'win-arm64' = @{ File = 'node-v24.21.0-win-arm64.zip'; Sha256 = '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921'; Size = 33679608 }
  }

  # Write-Host on purpose: these helpers RETURN values, and Write-Output would mix every
  # message into what they return.
  function Say {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'User-facing installer messages; Write-Output would pollute function return values.')]
    param([string]$Message)
    Write-Host $Message
  }

  function Fail([string]$Message) {
    throw "dreamcontext install: $Message"
  }

  function Test-Switch([string]$Name) {
    return -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($Name, 'Process'))
  }

  # The executable a bare name resolves to, as an application only. PowerShell never runs a
  # program from the current folder by bare name, and asking for `.cmd` explicitly sidesteps
  # the `.ps1` shims npm writes, which the default execution policy refuses to run.
  function Find-Exe([string]$Name) {
    $found = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
    return $null
  }

  function Get-NodeMajor([string]$Node) {
    if (-not $Node) { return 0 }
    try {
      $out = & $Node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2> $null
      if ($LASTEXITCODE -ne 0) { return 0 }
      return [int]$out
    } catch {
      return 0
    }
  }

  function Test-NodeReady {
    $node = Find-Exe 'node.exe'
    $npm = Find-Exe 'npm.cmd'
    return [bool]($node -and $npm -and (Get-NodeMajor $node) -ge $NodeMinMajor)
  }

  # `win-x64` or `win-arm64`: the key of this computer's build in the pin table. A 32-bit
  # PowerShell on a 64-bit Windows reports the real machine in PROCESSOR_ARCHITEW6432.
  function Get-NodePlatformKey {
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
      'AMD64' { return 'win-x64' }
      'ARM64' { return 'win-arm64' }
      default { return $null }
    }
  }

  # Refuse to write through a junction or symbolic link: one here could point the install anywhere.
  function Assert-NotLink([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Fail "$Path is a link, so dreamcontext will not install Node.js through it. Install Node.js >= $NodeMinMajor from https://nodejs.org instead, then re-run this script."
    }
  }

  # Prepend folders to the USER Path (HKCU\Environment), once each. Read and written raw, so
  # entries like %USERPROFILE%\bin keep their variables (the .NET getter would expand them and
  # the setter would store the expanded copy). Older dreamcontext Node folders are dropped, so a
  # pin bump does not leave a stale Node on the Path.
  function Add-UserPath([string[]]$Folders) {
    $key = Get-Item -LiteralPath 'HKCU:\Environment'
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = @($raw -split ';' | Where-Object { $_ -ne '' })
    $kept = @($parts | Where-Object {
        $expanded = [Environment]::ExpandEnvironmentVariables($_)
        -not ($expanded -match '\\\.dreamcontext\\node\\' -and ($Folders -notcontains $expanded))
      })
    $added = @()
    foreach ($folder in $Folders) {
      $present = $kept | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $folder.TrimEnd('\') }
      if (-not $present) { $added += $folder }
    }
    if ($added.Count -gt 0 -or $kept.Count -ne $parts.Count) {
      Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'Path' -Value ((@($added) + $kept) -join ';') -Type ExpandString
      # Writing the registry directly broadcasts nothing; setting (then removing) a user
      # variable through .NET sends WM_SETTINGCHANGE, so terminals opened from now on see it.
      [Environment]::SetEnvironmentVariable('DREAMCONTEXT_INSTALL_PATH_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('DREAMCONTEXT_INSTALL_PATH_REFRESH', $null, 'User')
      if ($added.Count -gt 0) { Say "Added $($added -join ' and ') to your user PATH." }
    }
    # And this session, so the rest of the script finds them.
    $env:Path = (($Folders + @($env:Path -split ';' | Where-Object { $_ -ne '' })) -join ';')
  }

  # The machine Path comes BEFORE the user Path in every new terminal: an older Node.js there
  # would still win over the private one. Said plainly, not silently patched (that needs admin).
  function Write-MachineNodeWarning {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    if (-not $machine) { return }
    foreach ($dir in ($machine -split ';' | Where-Object { $_ -ne '' })) {
      $candidate = Join-Path ([Environment]::ExpandEnvironmentVariables($dir)) 'node.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        Say "Note: another Node.js ($candidate) is on the system PATH and comes first in new terminals. Upgrade or remove it if 'node --version' shows an old version there."
        return
      }
    }
  }

  # --- The private Node.js ------------------------------------------------------
  #
  #   %USERPROFILE%\.dreamcontext\node\<version>\       the official build, unpacked
  #   ...\<version>\node_modules\npm\npmrc               prefix=${APPDATA}\npm, as the official
  #                                                      MSI sets it: global packages (the
  #                                                      dreamcontext CLI) live outside the version
  #                                                      folder, where the desktop app looks
  #
  # No admin, no installer, nothing outside .dreamcontext and %APPDATA%\npm but two user PATH
  # entries.
  function Install-ManagedNode {
    $key = Get-NodePlatformKey
    if (-not $key -or -not $NodePins.ContainsKey($key)) {
      Fail "There is no private Node.js build for this computer. Install Node.js >= $NodeMinMajor from https://nodejs.org, then re-run this script."
    }
    $pin = $NodePins[$key]

    $dcHome = Join-Path $env:USERPROFILE '.dreamcontext'
    $nodeRoot = Join-Path $dcHome 'node'
    $dest = Join-Path $nodeRoot $NodeVersion
    $npmGlobal = Join-Path $env:APPDATA 'npm'
    foreach ($p in @($dcHome, $nodeRoot, $dest, $npmGlobal)) { Assert-NotLink $p }
    New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null

    # A fresh folder in the user's own temp (%LOCALAPPDATA%\Temp, readable by this user only).
    $work = Join-Path ([IO.Path]::GetTempPath()) ('dreamcontext-node-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    $staging = $null
    $aside = $null
    try {
      $archive = Join-Path $work $pin.File
      Say "Downloading Node.js $NodeVersion, a private copy just for dreamcontext. Your other apps are not touched."
      # Windows PowerShell 5.1 may not offer TLS 1.2 by default; nodejs.org requires it.
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      try {
        Invoke-WebRequest -UseBasicParsing -Uri ($NodeBaseUrl + $pin.File) -OutFile $archive
      } catch {
        Fail 'Could not download Node.js. Check your internet connection, then re-run this script.'
      }

      if ((Get-Item -LiteralPath $archive).Length -ne $pin.Size) {
        Fail 'The Node.js download was the wrong size, so it was thrown away. Re-run this script.'
      }
      $sum = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($sum -ne $pin.Sha256) {
        Fail 'The Node.js download did not match its checksum, so it was thrown away. Re-run this script.'
      }

      # Unpacked next to its final place (same volume, so the final move is a rename), into a
      # folder created fresh for this run.
      $staging = Join-Path $nodeRoot ('.partial-' + [Guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $staging | Out-Null
      Expand-Archive -LiteralPath $archive -DestinationPath $staging
      $unpacked = Join-Path $staging ($pin.File -replace '\.zip$', '')
      if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'node.exe') -PathType Leaf)) {
        Fail 'The Node.js archive did not have the expected layout.'
      }

      # Anything already at <version> is moved aside first, so the move never lands inside it.
      if (Test-Path -LiteralPath $dest) {
        $aside = "$dest.old-" + [DateTime]::UtcNow.Ticks
        try {
          Move-Item -LiteralPath $dest -Destination $aside
        } catch {
          Fail "Could not move the old copy of Node.js aside ($dest). Close any program using it, then re-run this script."
        }
      }
      Move-Item -LiteralPath $unpacked -Destination $dest
    } finally {
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
      if ($staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    }

    $npmrc = Join-Path $dest 'node_modules\npm\npmrc'
    Assert-NotLink $npmrc
    # Single quotes: npm itself expands ${APPDATA} when it reads the file.
    Set-Content -LiteralPath $npmrc -Value 'prefix=${APPDATA}\npm' -Encoding Ascii
    New-Item -ItemType Directory -Force -Path $npmGlobal | Out-Null

    $nodeExe = Join-Path $dest 'node.exe'
    # No `2> $null` on native calls outside a try: Windows PowerShell 5.1 turns redirected
    # stderr into a terminating error under ErrorActionPreference Stop.
    $installed = & $nodeExe --version
    if ($LASTEXITCODE -ne 0 -or -not $installed) {
      Fail "The private Node.js did not start. Install Node.js >= $NodeMinMajor from https://nodejs.org instead, then re-run this script."
    }
    if ((Get-NodeMajor $nodeExe) -lt $NodeMinMajor) {
      Fail "The private Node.js reported an unexpected version ($installed)."
    }
    if ($aside) { Remove-Item -LiteralPath $aside -Recurse -Force -ErrorAction SilentlyContinue }

    Add-UserPath @($dest, $npmGlobal)
    Write-MachineNodeWarning
    Say "Node.js $installed installed in $nodeRoot."
  }

  function Initialize-Node {
    if (Test-NodeReady) {
      Say "Node.js $(& (Find-Exe 'node.exe') --version) detected."
      return
    }
    if (Test-Switch 'DREAMCONTEXT_INSTALL_NO_NODE') {
      Fail "Node.js >= $NodeMinMajor is required and DREAMCONTEXT_INSTALL_NO_NODE is set. Install it from https://nodejs.org, then re-run this script."
    }
    $node = Find-Exe 'node.exe'
    if (-not $node) {
      Say 'Node.js is not installed.'
    } elseif (-not (Find-Exe 'npm.cmd')) {
      Say "Node.js $(& $node --version) is installed but npm is missing."
    } else {
      Say "Node.js $(& $node --version) is too old. dreamcontext requires v$NodeMinMajor or later."
    }
    Install-ManagedNode
    if (-not (Test-NodeReady)) {
      Fail "Node.js >= $NodeMinMajor is still not the active version after the install. Open a NEW terminal and run 'node --version'. If it is still missing or too old, another Node.js is earlier on your PATH. Fix that, then re-run this script."
    }
    Say "Node.js $(& (Find-Exe 'node.exe') --version) ready."
  }

  function Install-Cli {
    Say 'Installing dreamcontext...'
    $npm = Find-Exe 'npm.cmd'
    if (-not $npm) { Fail 'npm.cmd was not found on PATH.' }
    # From the home folder, not the folder this was started in: npm reads a project's own
    # .npmrc from the current folder, and a cloned repo does not get to configure this install.
    Push-Location -LiteralPath $env:USERPROFILE
    try {
      # Installs the published dreamcontext CLI from npm. Review this script before piping it to iex.
      & $npm install -g dreamcontext@latest
      if ($LASTEXITCODE -ne 0) { Fail "'npm install -g dreamcontext@latest' failed. Check the npm output above." }
    } finally {
      Pop-Location
    }
  }

  function Get-Dreamcontext {
    $dc = Find-Exe 'dreamcontext.cmd'
    if (-not $dc) {
      Fail "Installation verification failed: 'dreamcontext' is not on PATH. Open a new terminal and run 'dreamcontext --version'."
    }
    $version = & $dc --version
    if ($LASTEXITCODE -ne 0) {
      Fail "Installation verification failed: 'dreamcontext --version' did not succeed. Check the npm install output above for errors."
    }
    Say "dreamcontext $version installed successfully."
    return $dc
  }

  function Install-App([string]$Dc) {
    if (Test-Switch 'DREAMCONTEXT_INSTALL_NO_APP') {
      Say 'DREAMCONTEXT_INSTALL_NO_APP is set. Skipping desktop app install.'
      return
    }
    Say 'Installing the dreamcontext desktop app (Windows)...'
    # Best-effort, as on macOS: a missing release or a failed download never aborts the CLI install.
    & $Dc app install
    if ($LASTEXITCODE -ne 0) { Say "Desktop app not installed yet. Run 'dreamcontext app install' later." }
  }

  function Invoke-Setup([string]$Dc) {
    if (Test-Path -LiteralPath '_dream_context' -PathType Container) {
      Say "Existing _dream_context/ detected. Running 'dreamcontext update'..."
      & $Dc update
      return
    }
    if (Test-Switch 'DREAMCONTEXT_INSTALL_NO_SETUP') {
      Say 'DREAMCONTEXT_INSTALL_NO_SETUP is set. Skipping setup.'
      Say 'Run `dreamcontext setup` to finish.'
      return
    }
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
      Say "Running 'dreamcontext setup' to initialize your project..."
      & $Dc setup
    } else {
      Say 'Run `dreamcontext setup` to finish.'
    }
  }

  if ($PSVersionTable.PSVersion.Major -lt 5) {
    Fail 'Windows PowerShell 5.1 or PowerShell 7 is required.'
  }
  Say '==> dreamcontext installer'
  Initialize-Node
  Install-Cli
  $dc = Get-Dreamcontext
  Install-App $dc
  Invoke-Setup $dc
}

Install-Dreamcontext
