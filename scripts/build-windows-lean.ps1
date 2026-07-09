[CmdletBinding()]
param(
	[string]$StagingDirectory = ".tmp/windows-build",
	[string]$OutputDirectory = "artifacts",
	[switch]$KeepStaging
)

$ErrorActionPreference = "Stop"

function Assert-SafeTemporaryPath {
	param(
		[Parameter(Mandatory = $true)][string]$Path,
		[Parameter(Mandatory = $true)][string]$Root
	)

	$comparison = [StringComparison]::OrdinalIgnoreCase
	if (
		$Path.Equals($Root, $comparison) -or
		-not $Path.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, $comparison)
	) {
		throw "Temporary path must resolve below $Root (received $Path)"
	}

	# Refuse junctions/symlinks anywhere below the trusted .tmp root so a
	# recursive cleanup cannot escape the workspace through a reparse point.
	$candidates = @($Root)
	$relative = $Path.Substring($Root.Length) -replace "^[\\/]+", ""
	$current = $Root
	foreach ($component in ($relative -split "[\\/]")) {
		if (-not $component) { continue }
		$current = Join-Path $current $component
		$candidates += $current
	}

	foreach ($candidate in $candidates) {
		if (-not (Test-Path -LiteralPath $candidate)) { continue }
		$item = Get-Item -LiteralPath $candidate -Force
		if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
			throw "Refusing recursive cleanup through reparse point: $candidate"
		}
	}
}

function Remove-TreeWithRetry {
	param(
		[Parameter(Mandatory = $true)][string]$Path,
		[Parameter(Mandatory = $true)][string]$Root
	)

	Assert-SafeTemporaryPath -Path $Path -Root $Root
	if (-not (Test-Path -LiteralPath $Path)) { return }

	for ($attempt = 1; $attempt -le 6; $attempt++) {
		try {
			Remove-Item -LiteralPath $Path -Recurse -Force
			if (Test-Path -LiteralPath $Path) {
				throw "Path still exists after cleanup: $Path"
			}
			return
		} catch {
			if ($attempt -eq 6) { throw }
			Start-Sleep -Milliseconds (200 * $attempt)
		}
	}
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
	throw "This script builds the Windows installer and must run on Windows"
}

$architecture = if ($env:PROCESSOR_ARCHITEW6432) {
	$env:PROCESSOR_ARCHITEW6432
} else {
	$env:PROCESSOR_ARCHITECTURE
}
if ($architecture -ne "AMD64") {
	throw "The current installer target is Windows x64 (detected $architecture)"
}

foreach ($command in @("bun", "bunx", "node")) {
	if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
		throw "Required command '$command' was not found on PATH"
	}
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$allowedStagingRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot ".tmp"))
$stage = [IO.Path]::GetFullPath((Join-Path $repoRoot $StagingDirectory))
$output = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
$bootstrapCache = [IO.Path]::GetFullPath(
	(Join-Path $allowedStagingRoot ".bunx-cache")
)

New-Item -ItemType Directory -Path $allowedStagingRoot -Force | Out-Null
Assert-SafeTemporaryPath -Path $stage -Root $allowedStagingRoot
Assert-SafeTemporaryPath -Path $bootstrapCache -Root $allowedStagingRoot

if (Test-Path -LiteralPath $stage) {
	Remove-TreeWithRetry -Path $stage -Root $allowedStagingRoot
}
if (Test-Path -LiteralPath $bootstrapCache) {
	Remove-TreeWithRetry -Path $bootstrapCache -Root $allowedStagingRoot
}
New-Item -ItemType Directory -Path $output -Force | Out-Null

$driveName = [IO.Path]::GetPathRoot($repoRoot).TrimEnd("\").TrimEnd(":")
$beforeBytes = (Get-PSDrive -Name $driveName).Free
if ($beforeBytes -lt 4GB) {
	throw "At least 4 GiB of temporary free space is required for the lean build"
}

$succeeded = $false
$originalPostinstallGuard = $env:SUPERSET_POSTINSTALL_RUNNING
$originalCacheDir = $env:BUN_INSTALL_CACHE_DIR
$originalNpmCache = $env:npm_config_cache
$originalTelemetry = $env:TURBO_TELEMETRY_DISABLED
$originalElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
$originalSmokeModuleRoot = $env:ADE_SMOKE_MODULE_ROOT

try {
	$env:TURBO_TELEMETRY_DISABLED = "1"
	$env:BUN_INSTALL_CACHE_DIR = $bootstrapCache
	& bunx turbo@2.10.4 prune "@ade/desktop" --out-dir $stage --use-gitignore
	if ($LASTEXITCODE -ne 0) { throw "Turborepo prune failed" }

	foreach ($directory in @("patches", "scripts")) {
		Copy-Item -LiteralPath (Join-Path $repoRoot $directory) -Destination $stage -Recurse -Force
	}
	foreach ($file in @("LICENSE.md", "NOTICE", "THIRD-PARTY-NOTICES.md")) {
		Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $stage -Force
	}

	$env:BUN_INSTALL_CACHE_DIR = Join-Path $stage ".bun-cache"
	$env:SUPERSET_POSTINSTALL_RUNNING = "1"
	Push-Location $stage
	try {
		& bun install --ignore-scripts --frozen-lockfile --os win32 --cpu x64 --no-progress
		if ($LASTEXITCODE -ne 0) { throw "Bun install failed" }

		& node apps/desktop/node_modules/electron/install.js
		if ($LASTEXITCODE -ne 0) { throw "Electron binary installation failed" }

		# better-sqlite3 ships its Electron binary as a downloadable prebuild
		# rather than in the npm package. Fetch only that binary into the isolated
		# staging tree; never fall back to node-gyp or Visual Studio.
		$env:npm_config_cache = Join-Path $stage ".npm-cache"
		$desktopPackage = Get-Content -Raw apps/desktop/package.json | ConvertFrom-Json
		$electronVersion = $desktopPackage.devDependencies.electron -replace "^[^0-9]*", ""
		$prebuildInstaller = Join-Path $stage "apps/desktop/node_modules/prebuild-install/bin.js"
		$betterSqlite = Join-Path $stage "apps/desktop/node_modules/better-sqlite3"
		Push-Location $betterSqlite
		try {
			& node $prebuildInstaller --runtime=electron --target=$electronVersion --platform=win32 --arch=x64
			if ($LASTEXITCODE -ne 0) { throw "better-sqlite3 Electron prebuild download failed" }
		} finally {
			Pop-Location
		}

		# The Windows packages ship prebuilt native binaries. Testing those under
		# Electron avoids a multi-gigabyte Visual Studio/Spectre toolchain.
		& bun run --cwd apps/desktop smoke:native
		if ($LASTEXITCODE -ne 0) { throw "Prebuilt native runtime smoke test failed" }

		& bun run --cwd apps/desktop build
		if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed" }

		# Force every require through the packaged ASAR so filters are validated,
		# including both Windows ConPTY and winpty terminal backends.
		$env:ELECTRON_RUN_AS_NODE = "1"
		$env:ADE_SMOKE_MODULE_ROOT = Join-Path $stage "apps/desktop/release/win-unpacked/resources/app.asar/node_modules"
		& node apps/desktop/node_modules/electron/cli.js apps/desktop/scripts/smoke-native-runtime.cjs
		if ($LASTEXITCODE -ne 0) { throw "Packaged native runtime smoke test failed" }
	} finally {
		Pop-Location
	}

	$release = Join-Path $stage "apps/desktop/release"
	$installer = Get-ChildItem -LiteralPath $release -Filter "*.exe" -File |
		Where-Object { $_.Name -notlike "*uninstaller*" } |
		Sort-Object Length -Descending |
		Select-Object -First 1
	if (-not $installer) { throw "No Windows installer was produced" }

	Copy-Item -LiteralPath $installer.FullName -Destination $output -Force
	$manifest = Join-Path $release "latest.yml"
	if (Test-Path -LiteralPath $manifest) {
		Copy-Item -LiteralPath $manifest -Destination $output -Force
	}

	$afterBuildBytes = (Get-PSDrive -Name $driveName).Free
	$measurement = [ordered]@{
		installer = $installer.Name
		installerBytes = $installer.Length
		installerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName).Hash
		temporaryPhysicalBytes = $beforeBytes - $afterBuildBytes
		bunVersion = (& bun --version | Select-Object -First 1)
		measuredAt = (Get-Date).ToUniversalTime().ToString("o")
	}
	$measurement | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output "footprint.json") -Encoding UTF8
	$succeeded = $true
} finally {
	$env:SUPERSET_POSTINSTALL_RUNNING = $originalPostinstallGuard
	$env:BUN_INSTALL_CACHE_DIR = $originalCacheDir
	$env:npm_config_cache = $originalNpmCache
	$env:TURBO_TELEMETRY_DISABLED = $originalTelemetry
	$env:ELECTRON_RUN_AS_NODE = $originalElectronRunAsNode
	$env:ADE_SMOKE_MODULE_ROOT = $originalSmokeModuleRoot

	$cleanupError = $null
	if (-not $KeepStaging -and (Test-Path -LiteralPath $stage)) {
		try {
			Remove-TreeWithRetry -Path $stage -Root $allowedStagingRoot
		} catch {
			$cleanupError = $_
		}
	}
	if (Test-Path -LiteralPath $bootstrapCache) {
		try {
			Remove-TreeWithRetry -Path $bootstrapCache -Root $allowedStagingRoot
		} catch {
			if (-not $cleanupError) { $cleanupError = $_ }
			else { Write-Warning $_ }
		}
	}

	if ($cleanupError) {
		if ($succeeded) {
			throw "Build succeeded but temporary cleanup failed: $cleanupError"
		}
		Write-Warning "Build failed and temporary cleanup also failed: $cleanupError"
	}
}

Write-Host "Windows installer copied to $output"
if ($KeepStaging) {
	Write-Host "Build staging retained at $stage"
}
