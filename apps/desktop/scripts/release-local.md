# Local release: build, sign, and notarize ADE on your Mac

This is the fallback for producing a **signed + notarized** ADE DMG locally,
when you can't (or don't want to) run the GitHub Actions release workflow
(`.github/workflows/release-desktop.yml`). The output is byte-for-byte the same
kind of artifact CI produces: a Developer ID–signed, Apple-notarized, stapled
`.dmg` (plus the `.zip` and `latest-mac.yml` update manifest).

Run everything from `apps/desktop/`.

---

## 0. Prerequisites (one time)

- **Xcode command line tools** — `xcode-select --install`
- **A "Developer ID Application" certificate** in your login keychain. Verify:
  ```bash
  security find-identity -v -p codesigning | grep "Developer ID Application"
  ```
  You want the full identity string, e.g.
  `Developer ID Application: Your Name (TEAMID1234)`.
- **An app-specific password** for your Apple ID (create at
  <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords).
  This is NOT your normal Apple ID password.

> Note: this is different from the ad-hoc "Damon Local" self-signed identity in
> `~/fix-damon-signing.sh` / `~/sign-damon.sh`. Those give a *stable local*
> signature so macOS TCC permissions survive rebuilds — they are **not** a
> Developer ID and cannot be notarized. For a public download you need a real
> Developer ID Application cert as above.

---

## 1. Set the signing environment

Everything is parameterized via env vars — nothing Apple-specific is hardcoded
in the repo. Fill in your own values:

```bash
# Developer ID signing (electron-builder / @electron/osx-sign reads these)
export CSC_NAME="Developer ID Application: Your Name (TEAMID1234)"
# ...OR point at an exported .p12 instead of CSC_NAME:
# export CSC_LINK="$HOME/certs/developer-id.p12"
# export CSC_KEY_PASSWORD="p12-export-password"

# Notarization (electron-builder runs notarytool with these)
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"   # app-specific pw
export APPLE_TEAM_ID="TEAMID1234"
```

`electron-builder.ts` turns notarization on automatically when `APPLE_TEAM_ID`
is set, and hardened runtime is already enabled with the entitlements in
`src/resources/build/`.

---

## 2. Build

```bash
# Compile the app + prepare native modules (better-sqlite3, node-pty, libsql, …)
bun run prebuild

# Sign + notarize + package. Uses electron-builder.ts (appId studio.persimmons.ade).
# --publish never = build locally, do not upload anywhere.
bun run package -- --publish never --config electron-builder.ts
```

Notarization adds a few minutes (electron-builder uploads to Apple, waits, then
staples the ticket). When it finishes, artifacts are in `apps/desktop/release/`:

- `ADE-<version>-arm64.dmg` — the signed, notarized installer to distribute
- `ADE-<version>-arm64-mac.zip` — zip (needed for Squirrel auto-update)
- `latest-mac.yml` — auto-update manifest

---

## 3. Verify the signature and notarization

```bash
APP="release/mac-arm64/ADE.app"

# Code signature is valid and from your Developer ID
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep Authority

# Gatekeeper accepts it (this is what a downloader's Mac checks)
spctl --assess --type execute --verbose=4 "$APP"

# Notarization ticket is stapled to the DMG
xcrun stapler validate "release/ADE-<version>-arm64.dmg"
```

Expected: `codesign` reports `satisfies its Designated Requirement`, `spctl`
prints `accepted` / `source=Notarized Developer ID`, and `stapler` prints
`The validate action worked!`.

---

## 4. Ship it

Attach the `.dmg`, `.zip`, and `latest-mac.yml` to a GitHub Release on the
public repo (see `RELEASE.md`). A viewer who downloads the `.dmg` can open it
with no Gatekeeper warning.

---

## Unsigned smoke test (no cert needed)

To only confirm the app *packages* (not for distribution — it will be blocked by
Gatekeeper on other Macs):

```bash
bun run prebuild
CSC_IDENTITY_AUTO_DISCOVERY=false bun run build -- --config electron-builder.ts
```

`CSC_IDENTITY_AUTO_DISCOVERY=false` and an unset `APPLE_TEAM_ID` make
electron-builder skip both signing and notarization.
