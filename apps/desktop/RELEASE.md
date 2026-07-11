# Desktop builds and releases

There are two deliberately separate distribution paths.

## Personal and friends artifacts

Run **Actions → Personal and Friends Build → Run workflow** on the branch or
commit you want to share. The workflow packages unsigned installers for:

- Windows x64
- macOS Apple Silicon (`arm64`)
- macOS Intel (`x64`)

Each artifact contains a `SHA256SUMS-*.txt` file and expires after 14 days. The
workflow uploads Actions artifacts only; it does not create or publish a GitHub
Release and it never receives signing secrets. See
[`docs/friends-install.md`](../../docs/friends-install.md) before sharing one.

Unsigned personal builds are installed manually. Their in-app updater still
checks the latest **published** GitHub Release, so an Actions artifact is not an
update channel.

## Signed stable release

Stable releases require Windows signing credentials plus an Apple Developer ID
Application certificate and Apple notarization credentials in the protected
`production` environment:

- `MAC_CERTIFICATE` and `MAC_CERTIFICATE_PASSWORD`
- `APPLE_ID`, `APPLE_ID_PASSWORD`, and `APPLE_TEAM_ID`
- `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`

The stable workflow fails closed if any required credential is absent. Its
macOS jobs verify the Developer ID signature, hardened runtime, Gatekeeper
assessment, and stapled notarization ticket. The Windows job verifies both the
installer and installed executable Authenticode signatures, and the release job
recomputes every updater manifest's referenced SHA-512 before creating a draft.

The release helper requires authenticated GitHub CLI (`gh`), `jq`, and a clean
local `main` branch that exactly matches `origin/main`.

From a clean, up-to-date `main` branch, run:

```bash
./apps/desktop/create-release.sh 0.4.1
```

The script updates the desktop version and root lockfile together, pushes
`main`, and creates the exact `vMAJOR.MINOR.PATCH` tag expected by
`release-desktop.yml`. Published versions are immutable; only an unpublished
draft can be rebuilt with the same version. The workflow always creates a
**draft** release. Inspect the release notes, checksums, installers, and workflow
result, then promote it as a separate manual action:

```bash
gh release edit v0.4.1 --draft=false
```

Only published stable releases are visible through `/releases/latest` and the
in-app updater. Packaged builds check that feed, but downloads and installation
remain user initiated.

## Local package smoke

Build on the native operating system:

```bash
bun install --frozen
bun run --cwd apps/desktop typecheck
bun run --cwd apps/desktop compile:app
bun run --cwd apps/desktop smoke:native
```

Then package with one target:

```bash
# Apple Silicon
CSC_IDENTITY_AUTO_DISCOVERY=false bun run --cwd apps/desktop package -- --mac --arm64 --publish never --config electron-builder.ts

# Intel Mac
CSC_IDENTITY_AUTO_DISCOVERY=false bun run --cwd apps/desktop package -- --mac --x64 --publish never --config electron-builder.ts
```

On Windows PowerShell:

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
bun run --cwd apps/desktop package -- --win --x64 --publish never --config electron-builder.ts
```
