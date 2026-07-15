# ADE Reliability Hardening v1

Date: 2026-07-15
Status: Approved for implementation
Target: Windows 10/11 x64, macOS Apple Silicon, and macOS Intel

## Purpose

This build converts ADE's current feature-complete personal distribution into a release that fails safely, preserves sessions, keeps account credentials device-local, validates synchronized state, verifies every update, and proves the packaged graphical application on every supported platform.

The work is deliberately a reliability release. New orchestration frameworks and large feature surfaces stay out of the core until these guarantees are green.

## User outcomes

1. Claude and Codex account credentials never enter ADE's syncable home directory.
2. Every Claude or Codex pane is bound to one device-local account for its lifetime. A pane arriving from another device asks for an explicit local rebind instead of silently choosing another account.
3. Closing tabs, restarting ADE, and deleting workspaces cannot leave permanent account bindings or unbounded private data behind.
4. A damaged or partially synchronized state file cannot prevent ADE from opening. ADE quarantines it, restores safe defaults, and keeps bounded recovery copies.
5. Concurrent renderer writes and peer updates cannot allow an older write to overwrite a newer state.
6. Peer changes appear in a running ADE window with per-workspace last-writer-wins behavior and without echo writes.
7. Personal releases use a versioned manifest. ADE downloads only the asset for its platform and architecture, verifies its size and SHA-256 digest, and asks before opening the installer.
8. ADE keeps diagnostics local, offers a clear health report and redacted export, detects repeated failed boots, and provides a safe recovery path.
9. CI runs the complete isolated desktop suite and a real packaged graphical boot on Windows x64, macOS Apple Silicon, and macOS Intel.
10. GitHub blocks merges that do not pass the required checks, reports dependency regressions, and keeps automated dependency maintenance enabled.

## Global constraints

- ADE remains local-first. No crash report, log, credential, source file, terminal transcript, or diagnostics bundle is uploaded automatically.
- Existing project/session data must be migrated in place or preserved in a bounded quarantine; it must not be silently discarded.
- Provider profile UUIDs and credentials remain device-local. Synced state may carry only the portable `subscriptionProfilePinned` marker.
- All renderer-to-main operations continue through tRPC. New raw Electron IPC channels are not allowed.
- tRPC subscriptions continue to use observables.
- No update downloads or installation occurs without a user action. No verified installer is executed without a second user confirmation.
- Update downloads accept only HTTPS GitHub release URLs for `Chi944/chi-ade-windows` and must match the manifest's declared byte length and SHA-256 digest.
- Persistent writes are atomic where the platform permits it and are serialized in arrival order.
- Recovery data is bounded: at most three app-state snapshots, two database snapshots, three 1 MiB diagnostic logs, and one verified update per version.
- Packaged GUI smoke uses the packaged Electron runtime already present in the application. It must not download a separate browser runtime.
- The canonical Bun version is `1.3.6` in package metadata and every workflow.
- The repository must not introduce the former project name or any previously removed branding.
- Changes follow test-driven development: each behavior is first represented by a failing focused test, then the minimum implementation, then refactoring.

## Architecture

### 1. Device-local private data

ADE keeps its syncable state under `ADE_HOME_DIR` (normally `~/.ade`). Private provider profiles move to an operating-system local application-data root:

- Windows: `%LOCALAPPDATA%\ADE\private\<home-namespace>\provider-accounts`
- macOS: `~/Library/Application Support/ADE/private/<home-namespace>/provider-accounts`
- Linux fallback: `${XDG_DATA_HOME:-~/.local/share}/ADE/private/<home-namespace>/provider-accounts`

The namespace is a stable short hash of the resolved `ADE_HOME_DIR`, keeping development worktrees isolated without exposing a raw path. The root is resolved before subscription profiles initialize and can be overridden only by an internal test seam. Directory and file permissions remain restrictive. Symlinks and path escapes remain rejected.

On first hardened launch, ADE writes the managed sync-ignore block and detects a legacy `~/.ade/provider-accounts` tree before terminal reconciliation. Because the terminal host can survive a normal application quit, migration first stops its live sessions with history preservation, then copies through a sibling temporary directory, rejects nested links, verifies the inventory, atomically promotes the destination, resets the host manager, and permits cold restoration under the new paths. The legacy tree is removed only after verification. If shutdown or migration fails, ADE uses the legacy resolver for that run and reports a retry warning; it must not launch with an empty replacement. If both trees are identical, the legacy duplicate is removed. If they conflict, the destination stays active and the legacy tree moves to one bounded local recovery location outside the syncable root; ADE reports the conflict and never merges credential files by guesswork.

ADE maintains a small managed block in `~/.ade/.stignore` that excludes device identity, legacy private roots, recovery files, crash data, logs, and verified update staging. Existing user rules outside the managed block are preserved.

### 2. Stable account binding lifecycle

Creating a Claude or Codex pane with an explicit account carries `null` for the system account or a UUID for a named account until the main process creates the device-local binding. A default local pane starts without the portable marker so the existing main-process environment resolver can atomically bind the currently selected account before launching the CLI. Persistence then marks every local Claude/Codex terminal as `subscriptionProfilePinned: true` while stripping any UUID. This avoids gating a brand-new local pane before its binding can be created, while ensuring every restored or synchronized copy is gated.

A synced pane with the portable marker queries its local binding. If no matching binding exists, the terminal remains stopped and displays the rebind chooser. The user must select a named or system account. A local default pane never starts before its selected account has been resolved.

At startup, ADE reconciles subscription bindings only after a trusted state load and workspace localization. Peer-local workspace UUIDs are translated through the sync envelope and local workspace identity before comparison. Unresolved identities or an untrusted recovered state defer destructive cleanup and produce a health warning. Bindings for proven-unreachable panes are released and profileless homes are pruned. The renderer's non-durable closed-tab undo stack is intentionally not treated as durable after restart. Workspace deletion and permanent pane deletion keep their existing eager release behavior.

### 3. Validated, serialized application state

One shared runtime schema validates `tabsState`, `themeState`, `hotkeysState`, and the sync envelope at every trust boundary:

- initial `app-state.json` load;
- watcher reads after a peer file change;
- renderer mutations received by the UI-state router.

Validation normalizes supported legacy omissions but rejects wrong container types, invalid pane layouts, dangling pane references, invalid timestamps, and oversized records. On initial-load failure, ADE atomically renames the source to a timestamped quarantine, retains no more than three copies, writes a fresh default state, and records a local diagnostic event. A malformed peer update is ignored and reported; it never replaces the in-memory state.

All app-state mutations use one main-process promise queue. A queued mutation clones the latest in-memory state, applies one validated change, stamps its sync metadata, atomically writes it, then advances. A failed write does not poison later queue entries. Tabs, theme, hotkeys, watcher adoption, and recovery operations use the same queue.

### 4. Restart-safe peer synchronization

The existing `sync.appStateUpdates` subscription remains the transport. Its merge engine becomes a separately tested module. The watcher observes the parent directory and reopens the target after rename swaps so Syncthing's atomic replacement cannot detach it from later changes.

Canonical workspace identity is the SHA-256 of a credential-stripped, normalized Git origin plus branch and workspace type. HTTPS and SSH spellings of the same repository normalize to one identity, so a Windows checkout and a macOS checkout can synchronize despite different absolute paths. Raw local paths and credential-bearing remote URLs never enter the envelope. Repositories with no portable Git origin are skipped with a health warning unless the user later gives them an explicit mapping.

On hydration the sync engine seeds last-seen workspace clocks from the local envelope. For each peer update it resolves canonical workspace identity, compares `(timestamp, deviceId)` deterministically, and replaces only winning workspaces. Different workspaces merge additively. Invalid or unresolved workspaces are skipped with a health warning.

Peer adoption updates both the renderer store and the main-process snapshot. Echo prevention uses an operation/revision token rather than a single global boolean, so overlapping local writes cannot consume the wrong skip marker. Peer updates are processed sequentially. Local writes update the same clock map, preventing an older peer snapshot from winning after a restart.

Claude session identifiers remain carried through the sync envelope, but a peer pane is staged for user confirmation and does not automatically execute a resume command on the receiving device.

### 5. Verified personal update channel

The rolling `personal-latest` release contains `ade-personal-update-v1.json` with this contract:

```json
{
  "schemaVersion": 1,
  "version": "0.6.0",
  "buildNumber": 123456,
  "commitSha": "40 lowercase hexadecimal characters",
  "publishedAt": "ISO-8601 timestamp",
  "releaseNotesUrl": "https://github.com/Chi944/chi-ade-windows/releases/tag/personal-latest",
  "assets": {
    "win32-x64": {
      "name": "ADE-Windows-x64.exe",
      "url": "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-Windows-x64.exe",
      "size": 123,
      "sha256": "64 lowercase hexadecimal characters"
    },
    "darwin-arm64": {
      "name": "ADE-macOS-Apple-Silicon.dmg",
      "url": "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Apple-Silicon.dmg",
      "size": 123,
      "sha256": "64 lowercase hexadecimal characters"
    },
    "darwin-x64": {
      "name": "ADE-macOS-Intel.dmg",
      "url": "https://github.com/Chi944/chi-ade-windows/releases/download/personal-latest/ADE-macOS-Intel.dmg",
      "size": 123,
      "sha256": "64 lowercase hexadecimal characters"
    }
  }
}
```

The publisher creates the manifest from the already-renamed release assets, verifies all digests locally, uploads next-named assets, verifies GitHub's reported digest and size, then atomically swaps the complete inventory. `SHA256SUMS.txt` remains available for manual verification.

The application embeds its build SHA and monotonic build number. It checks the manifest at startup and every four hours, but only surfaces availability. A greater semantic version wins; for an equal version, a greater build number wins. Download starts from the update toast or Check for Updates menu. ADE streams to a `.part` file, enforces a maximum expected size, reports progress, verifies exact bytes and digest, creates a recovery snapshot, renames the verified file, and transitions to Ready. Install opens the verified installer only after confirmation. A mismatch deletes the partial/verified file and reports an error.

### 6. Local diagnostics and recovery

An early bootstrap entry sets private paths, starts Electron crash capture before importing the migration-bearing main module with `uploadToServer: false`, and initializes diagnostics. ADE records structured local events through a redacting logger. Redaction removes authorization headers, common token/key assignments, home-directory prefixes, provider-profile paths, and URL credentials. Logs rotate at 1 MiB and keep three files. Unused remote Sentry code and build configuration are removed so the personal build does not carry a dormant upload client or its package weight.

A Health & Recovery settings page runs checks for:

- writable syncable and private data roots;
- valid app state and local database integrity;
- Claude, Codex, Git, SSH, SFTP, PowerShell (Windows), and shell availability;
- selected provider account binding state without exposing credential content;
- notification support and selected sound readability;
- remote-host configuration consistency;
- update manifest reachability and current platform asset presence;
- storage budgets and pending recovery conflicts.

The page shows Pass, Warning, or Fail with a remediation message. Export Diagnostics asks for a destination and writes one redacted JSON bundle containing versions, platform/architecture, health results, bounded recent log entries, state shape counts, and hashed paths. It excludes credentials, environment values, terminal output, chat content, project file content, and raw paths.

A local boot-state file marks startup as `starting` and becomes `ready` only after the renderer confirms mount through tRPC. Three incomplete starts within ten minutes enable safe recovery mode; stale historical failures do not. Safe recovery skips optional background startup, does not restore terminal processes automatically, opens Health & Recovery, and offers restore-latest-state, reset-state-with-backup, or normal retry. A successful ready signal clears the failure counter.

Before an update installer is opened, ADE creates bounded recovery copies of app state and the SQLite database. Database migration also creates one snapshot per new migration fingerprint before applying changes.

### 7. Real packaged GUI smoke

`smoke:packaged-gui` launches the actual unpacked packaged executable with a temporary `ADE_HOME_DIR`, disables OS protocol registration, and passes a dedicated output path. The main window remains hidden from CI users but is a real `BrowserWindow` with the production preload, sandbox, renderer bundle, local database, and writable application state.

The smoke runner waits for the renderer-ready tRPC signal, verifies there is no boot error, exercises a small in-app test bridge available only when the signed smoke token is present, and checks:

- state hydration and persistence;
- creation of one through six panes and rejection of a seventh;
- distinct Claude/Codex pane account markers without starting external CLIs;
- health query completion;
- update-manifest parser selection for the running platform;
- a clean close and second launch from the same temporary state.

It writes a JSON result and exits non-zero on timeout, renderer failure, or failed assertion. CI uploads the result only on failure. The temporary home is deleted after the job.

### 8. CI and repository policy

The canonical desktop `test` script runs `scripts/test-complete.ts`; `test:fast` retains the monolithic Bun command for focused local work.

CI required jobs are stable and explicit:

- Sherif
- Changed-file lint
- Typecheck
- Build
- Complete desktop tests - Windows x64
- Complete desktop tests - macOS Apple Silicon
- Complete desktop tests - macOS Intel
- Platform smoke - Windows x64
- Platform smoke - macOS Apple Silicon
- Platform smoke - macOS Intel
- Production dependency audit
- Dependency review (pull requests only)

The production audit uses machine-readable Bun output and an in-repo policy. New high or critical findings always fail. A temporary exception must name the advisory, prove it is not shipped or not reachable in the desktop runtime, include an owner, and expire within 30 days. Expired entries fail. The initial hardening change updates compatible vulnerable packages and records narrowly scoped exceptions only where an upstream pin prevents a safe upgrade.

GitHub's dependency graph and vulnerability alerts are enabled. The user's owner-only contribution policy remains strict: automated dependency branches, security-fix pull requests, and auto-merge stay disabled. A monthly read-only security workflow runs the same frozen audit policy and notifies through its check result when Chi944 needs to apply an update. The existing owner-only branch/tag rulesets stay unchanged. A separate quality ruleset targets only `main`, has no bypass actor, requires a pull request with zero approvals, and requires the stable CI checks after they have reported successfully on this branch.

The Direct Download Build can run only from `main`, requires a successful CI run for the exact `GITHUB_SHA`, reruns platform packaging and packaged GUI smoke on that SHA, and publishes only if all matrix jobs succeed.

## Error handling

- Filesystem errors include a user-actionable path category, never a raw credential path.
- Network loss during update checks returns to Idle; corruption or schema errors become visible Fail states.
- A failed queued state write rejects that operation, retains the last committed snapshot, and allows the next queued operation to run.
- A peer sync parse/validation failure never triggers local persistence.
- A migration conflict never deletes either copy.
- Diagnostics export failure leaves the source logs untouched.
- Packaged smoke always has a hard timeout and captures the local diagnostic tail before exit.

## Test strategy

### Focused unit and integration tests

- private-root resolution, permissions, symlink refusal, migration, conflict, and managed `.stignore` preservation;
- explicit/default account selection, portable sanitization, peer rebind, binding reconciliation, and bounded cleanup;
- app-state schema normalization/rejection, quarantine rotation, atomic write recovery, and queue ordering after rejection;
- deterministic LWW comparison, local-clock seeding, additive workspace merge, sequential peer updates, and revision-token echo prevention;
- manifest schema/URL/asset validation, platform selection, semantic-version comparison, streaming size limits, checksum success/failure, and cleanup;
- log redaction/rotation, health result classification, diagnostics exclusion rules, boot-failure transitions, and backup rotation;
- update publisher manifest/inventory verification and dependency-policy expiry.

### Full verification

1. `bun install --frozen`
2. `bun run apps/desktop/scripts/test-complete.ts`
3. `bun test packages/shared/src`
4. `bun run typecheck`
5. `bun run lint`
6. `bunx sherif`
7. `bun audit --production --json` through the policy verifier
8. `bun turbo run build --filter=@ade/desktop`
9. Native runtime and migration smoke
10. Packaged GUI smoke on Windows x64, macOS Apple Silicon, and macOS Intel in CI
11. Package-footprint validation on all three artifacts
12. Exact release inventory and anonymous-download verification

## Definition of done

The build is complete only when:

- every acceptance outcome above has focused automated evidence;
- the full local verification appropriate to Windows passes;
- all required branch CI checks pass on the exact feature commit;
- an independent whole-branch review has no open critical or important finding;
- the pull request is merged to `main` without bypassing checks;
- the post-merge CI run on `main` passes;
- Direct Download Build publishes the exact green `main` SHA;
- the rolling manifest and all four public release assets pass digest, size, inventory, and anonymous-download verification;
- GitHub's active main ruleset requires the stable checks and dependency/security features are enabled;
- the repository is clean and local `main` matches `origin/main`.
