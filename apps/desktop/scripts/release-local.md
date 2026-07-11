# Local stable build on macOS

The normal personal and friends path needs no Apple account. Use the manual
workflow and install guide in [`docs/friends-install.md`](../../../docs/friends-install.md).
This page is the fallback for a Developer ID signed and Apple-notarized build.

Run commands from `apps/desktop/` on the target Mac architecture.

## Prerequisites

- Xcode command line tools: `xcode-select --install`
- A **Developer ID Application** certificate in the login keychain
- An Apple ID app-specific password

Verify the identity:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

An ad-hoc signature cannot be notarized and does not replace a Developer ID
Application certificate.

## Signing environment

Use either a keychain identity:

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID1234)"
```

or an exported certificate:

```bash
export CSC_LINK="$HOME/certs/developer-id.p12"
export CSC_KEY_PASSWORD="p12-export-password"
```

Then configure notarization:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="TEAMID1234"
```

Do not commit or paste these values into logs. `electron-builder.ts` enables
notarization when `APPLE_TEAM_ID` is present and already enables hardened
runtime with the required entitlements.

## Build

```bash
bun run prebuild
bun run package -- --mac --arm64 --publish never --config electron-builder.ts
```

Use `--x64` instead of `--arm64` on an Intel Mac. Notarization adds several
minutes while electron-builder submits the app, waits for Apple, and staples
the returned ticket.

## Verify

Adjust the app and DMG paths for the selected architecture and version:

```bash
APP="release/mac-arm64/ADE.app"
DMG="release/ADE-<version>-arm64.dmg"

codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep "Authority=Developer ID Application:"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "flags=.*runtime"
spctl --assess --type execute --verbose=4 "$APP"
xcrun stapler validate "$APP"
test -f "$DMG"
```

Gatekeeper should report `accepted` with `source=Notarized Developer ID`, and
stapler should validate the app ticket. The stable GitHub workflow enforces the
same checks.

## Create a stable release

Stable tags use the exact `vMAJOR.MINOR.PATCH` form. Follow
[`apps/desktop/RELEASE.md`](../RELEASE.md); the workflow creates a draft and
requires a separate manual promotion after review.

## Unsigned smoke build

For an unsigned local smoke only:

```bash
bun run prebuild
CSC_IDENTITY_AUTO_DISCOVERY=false bun run package -- --mac --arm64 --publish never --config electron-builder.ts
```

An unsigned build is expected to be blocked on first launch on another Mac.
Use Apple's supported **Open Anyway** flow from the friend install guide; do not
disable Gatekeeper.
