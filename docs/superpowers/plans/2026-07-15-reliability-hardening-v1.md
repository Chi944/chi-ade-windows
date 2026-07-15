# ADE Reliability Hardening v1 Implementation Plan

> Execute this plan in order with test-driven development and task-scoped review. The approved design is `docs/superpowers/specs/2026-07-15-reliability-hardening-v1-design.md`.

**Goal:** Ship a restart-safe, credential-safe, verifiably updated ADE personal distribution for Windows x64 and both macOS architectures, then enforce the proof in GitHub CI and repository rules.

**Architecture:** Keep syncable workspace/session state under `ADE_HOME_DIR`; move secrets and machine recovery data to an operating-system local private root. Validate and serialize all state transitions in the main process. Treat the renderer sync subscriber as a view/merge client backed by deterministic revision clocks. Replace the unusable stable updater feed for this personal build with a strict SHA-256 manifest. Add local-only diagnostics, bounded recovery, and a packaged graphical smoke mode using the packaged Electron runtime.

**Stack:** Bun 1.3.6, TypeScript, Electron 42, React 19, tRPC 11 observables, Zustand 5, Zod 4, lowdb 7, better-sqlite3, GitHub Actions.

## Global constraints

- No telemetry or automatic diagnostics upload.
- No credential, account UUID, raw project path, environment value, terminal output, or chat content may enter synchronized state or an exported diagnostics bundle.
- New renderer/main operations use tRPC; subscriptions use observables.
- Provider profiles stay device-local. Synced panes persist only `subscriptionProfilePinned: true`.
- State writes and peer updates are serialized; one rejected operation cannot poison the queue.
- Updates accept only the exact GitHub repository HTTPS URLs, enforce size and SHA-256, and require separate download and installer-open actions.
- Recovery storage is bounded exactly as defined in the design.
- Packaged GUI smoke uses the packaged Electron/Chromium only.
- Bun is pinned to 1.3.6 everywhere.
- Preserve current user data. Conflicts are reported, never guessed away.
- Do not introduce removed product branding.
- Use `apply_patch` for hand edits, preserve unrelated work, and do not run destructive Git commands.
- Every behavior change follows red-green-refactor and receives task-scoped spec/quality review.

## Task 1: Isolate provider credentials and reconcile account bindings

**Files:**

- Create: `apps/desktop/src/main/lib/subscription-profile-storage.ts`
- Create: `apps/desktop/src/main/lib/subscription-profile-storage.test.ts`
- Create: `apps/desktop/src/main/lib/sync/sensitive-ignore.ts`
- Create: `apps/desktop/src/main/lib/sync/sensitive-ignore.test.ts`
- Modify: `apps/desktop/src/main/lib/subscription-profiles.ts`
- Modify: `apps/desktop/src/main/lib/subscription-profiles.test.ts`
- Modify: `apps/desktop/src/shared/subscription-profile-rebind.ts`
- Modify: `apps/desktop/src/lib/trpc/routers/ui-state/peer-profile-normalizer.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify only if required for safe migration sequencing: `apps/desktop/src/main/lib/terminal/index.ts`, `apps/desktop/src/main/lib/terminal/service/service-manager.ts`, and focused tests beside them

### Step 1: Write failing private-root tests

Cover exact Windows, macOS, and Linux fallback resolution; stable hashed home namespace; test override; restrictive directory creation; symlink refusal; and proof that the result is outside `ADE_HOME_DIR`. Run:

```powershell
bun test apps/desktop/src/main/lib/subscription-profile-storage.test.ts
```

Expected: fail because the module does not exist.

### Step 2: Implement the local private root

Implement pure private-root resolution and runtime initialization helpers. Use `%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on macOS, and `XDG_DATA_HOME`/`~/.local/share` on Linux. Namespace with a short SHA-256 of the resolved ADE home. Create with mode `0o700`, repair permissions best-effort, and reject a symlink root.

Re-run the focused test and expect pass.

### Step 3: Write failing migration tests

In `subscription-profiles.test.ts`, cover:

- clean legacy-to-private migration with profiles, Codex configuration, and bindings preserved;
- verified copy fallback when rename reports a cross-device error;
- legacy removal only after inventory/hash verification;
- identical destination/source removes only the verified duplicate;
- destination conflict moves legacy data into one bounded local recovery location outside the syncable root and reports it;
- failed host shutdown or failed migration leaves the legacy root active;
- idempotent second launch;
- no credential-bearing file remains below the syncable root after success;
- stale bindings are removed only when their pane IDs are absent from durable state;
- named profiles become removable after stale reconciliation;
- profileless pane homes are pruned with their bindings.

Run:

```powershell
bun test apps/desktop/src/main/lib/subscription-profiles.test.ts
```

Expected: new cases fail.

### Step 4: Implement migration and reconciliation

Add an initialization result type with `root`, `migrationStatus`, and optional safe warning. Migration must stop surviving terminal sessions with `killSessions: true` and history preservation before moving credentials, then reset the service manager so cold restore uses the new environment. Use a temporary sibling, recursively inventory regular files without following links, compare relative path/size/SHA-256, atomically promote, and remove the legacy tree last.

Add `reconcileSubscriptionProfilePaneBindings(durablePanes)`. Preserve bindings whose workspace identity is unresolved, skip destructive cleanup for recovered/untrusted state, and return counts/warnings for diagnostics. Keep existing eager workspace/permanent-pane cleanup. Task 2 owns startup wiring after it can provide a trusted validation result; do not call destructive reconciliation from the current shallow loader.

Re-run focused tests.

### Step 5: Write failing portable-marker tests

Add cases proving that persistence marks every local terminal pane whose runtime is Claude or Codex, including a default pane without `subscriptionProfileId`; explicit UUIDs are removed; system `null` is removed; non-provider terminals and remote workspaces are not marked; a live new default pane remains ungated before persistence.

Run:

```powershell
bun test apps/desktop/src/lib/trpc/routers/ui-state/peer-profile-normalizer.test.ts apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/subscription-profile-rebind.test.ts
```

Expected: default-provider persistence case fails.

### Step 6: Implement safe marker normalization

Change only persistence sanitization: infer the marker for local Claude/Codex terminal panes while keeping the in-memory new-pane behavior unchanged. Do not set a marker-only pane in `createPane`; that would block `createOrAttach` before the selected account can be bound.

### Step 7: Add managed sync ignores

Test and implement an idempotent managed `.stignore` block. Preserve every byte outside the block. Include device identity, legacy account storage, local diagnostics/recovery patterns, and temporary update files. Wire it during startup after `ADE_HOME_DIR` exists.

Run all Task 1 tests plus:

```powershell
bun run --cwd apps/desktop typecheck
```

### Step 8: Task review and commit

Review against the design, fix every critical/important issue, then commit:

```powershell
git add apps/desktop/src/main/lib/subscription-profile-storage.ts apps/desktop/src/main/lib/subscription-profile-storage.test.ts apps/desktop/src/main/lib/sync/sensitive-ignore.ts apps/desktop/src/main/lib/sync/sensitive-ignore.test.ts apps/desktop/src/main/lib/subscription-profiles.ts apps/desktop/src/main/lib/subscription-profiles.test.ts apps/desktop/src/shared/subscription-profile-rebind.ts apps/desktop/src/lib/trpc/routers/ui-state/peer-profile-normalizer.test.ts apps/desktop/src/main/index.ts
git commit -m "fix: isolate provider credentials and reconcile bindings"
```

Include any required terminal lifecycle files in the same commit.

## Task 2: Validate, quarantine, back up, and serialize application state

**Files:**

- Create: `apps/desktop/src/main/lib/app-state/validation.ts`
- Create: `apps/desktop/src/main/lib/app-state/validation.test.ts`
- Create: `apps/desktop/src/main/lib/app-state/write-queue.ts`
- Create: `apps/desktop/src/main/lib/app-state/write-queue.test.ts`
- Modify: `apps/desktop/src/main/lib/app-state/schemas.ts`
- Modify: `apps/desktop/src/main/lib/app-state/index.ts`
- Create or modify: `apps/desktop/src/main/lib/app-state/index.test.ts`
- Modify: `apps/desktop/src/lib/trpc/routers/ui-state/index.ts`
- Modify focused UI-state router tests

### Step 1: Write failing runtime-validation tests

Test valid current state, supported legacy omissions, and rejection of `tabs: null`, array/object swaps, non-finite timestamps, malformed layouts, dangling pane IDs, unknown runtime/profile data, oversized maps, and invalid sync envelopes. Ensure every currently persisted pane/browser field is represented, including `terminalProfileId` and browser `error`. Ensure validation returns a deep normalized value and never reuses mutable default objects.

Run:

```powershell
bun test apps/desktop/src/main/lib/app-state/validation.test.ts
```

### Step 2: Implement shared schemas and normalization

Move or share the existing Zod contracts so both initial load and the tRPC router use one source. Enforce structural invariants after parsing: every layout leaf refers to a pane in the same tab, every pane refers to an existing tab, focused IDs are valid, and history/active IDs belong to their workspace. Normalize only documented optional legacy fields.

### Step 3: Write failing quarantine/rotation tests

Use a temporary `ADE_HOME_DIR`. Cover invalid JSON, valid JSON with invalid shape, read failure, first-run creation, quarantine naming, at-most-three rotation, atomic default write, and a later clean restart. A damaged file must remain available in quarantine and must not crash initialization.

### Step 4: Replace preset loading with explicit validated storage

Refactor `initAppState()` to read/parse/validate explicitly before creating the lowdb adapter. On validation failure, rename to a bounded quarantine, log a redacted event hook, and create defaults with the current local device ID. Keep a test reset seam and avoid writing unless first-run/recovery/normal mutation requires it.

Return a trust classification. After a trusted load and workspace localization, invoke Task 1 binding reconciliation; translate legacy peer-local workspace IDs before cleanup. A recovered/untrusted load must defer destructive binding reconciliation. Accept legacy path-based sync metadata for migration, but do not create new path-based metadata; Task 3 replaces it with portable origin identity.

### Step 5: Write failing queue tests

Prove strict FIFO behavior when the first operation is artificially delayed; prove the newest queued tabs state wins; prove theme/hotkeys cannot interleave with a tabs sync stamp; prove a rejected operation leaves committed state unchanged and the next operation still runs; and prove atomic temporary files are removed.

### Step 6: Implement the state coordinator

Expose one `enqueueAppStateMutation(label, mutate)` API that clones the latest committed state, validates the result, atomically writes with restrictive permissions, then swaps in-memory data. Provide read-only snapshots. Use a catch-continuation tail so a rejection does not poison the queue.

Route tabs, theme, hotkeys, recovery, and later peer adoption through the coordinator. Remove direct `appState.data =` plus `appState.write()` mutation pairs from routers.

Run:

```powershell
bun test apps/desktop/src/main/lib/app-state/validation.test.ts apps/desktop/src/main/lib/app-state/write-queue.test.ts apps/desktop/src/main/lib/app-state/index.test.ts apps/desktop/src/lib/trpc/routers/ui-state
bun run --cwd apps/desktop typecheck
```

### Step 7: Task review and commit

Commit after clean review:

```powershell
git add apps/desktop/src/main/lib/app-state apps/desktop/src/lib/trpc/routers/ui-state
git commit -m "fix: validate and serialize persistent app state"
```

## Task 3: Make peer synchronization deterministic and restart-safe

**Files:**

- Create: `apps/desktop/src/shared/tabs-sync.ts`
- Create: `apps/desktop/src/shared/tabs-sync.test.ts`
- Modify: `apps/desktop/src/main/lib/sync/workspace-identity.ts`
- Create: `apps/desktop/src/main/lib/sync/workspace-identity.test.ts`
- Modify: `apps/desktop/src/main/lib/app-state/watcher.ts`
- Add/modify: `apps/desktop/src/main/lib/app-state/watcher.test.ts`
- Modify: `apps/desktop/src/lib/trpc/routers/sync/index.ts`
- Create/modify: `apps/desktop/src/lib/trpc/routers/sync/index.test.ts`
- Create: `apps/desktop/src/main/lib/app-state/sync-service.ts`
- Create: `apps/desktop/src/main/lib/app-state/sync-service.test.ts`
- Create: `apps/desktop/src/main/lib/app-state/reconciliation.ts`
- Create: `apps/desktop/src/main/lib/app-state/reconciliation.test.ts`
- Refactor: `apps/desktop/src/renderer/stores/tabs/useTabsSyncSubscription.ts`
- Create: `apps/desktop/src/renderer/stores/tabs/useTabsSyncSubscription.test.ts`
- Modify: `apps/desktop/src/renderer/lib/trpc-storage.ts`
- Create/modify: `apps/desktop/src/renderer/lib/trpc-storage.test.ts`
- Modify Task 2 state coordinator APIs only as required by the reviewed sync contract

### Step 1: Write failing portable workspace-identity tests

Prove the same GitHub repository expressed as HTTPS, credential-bearing HTTPS, SCP-style SSH, and `ssh://` normalizes identically; `.git`, slash, host-case, and credential differences disappear; different repository/branch/type values differ; Windows and macOS local paths do not affect identity; raw paths and credentials never enter metadata; and local-only/file remotes return an unresolved warning instead of a path-derived cross-device identity.

Refactor workspace identity and envelope metadata to carry only normalized repository identity, branch, and type. Resolve local projects by reading and normalizing their current origin. Preserve the rule that missing projects are not fabricated.

Run:

```powershell
bun test apps/desktop/src/main/lib/sync/workspace-identity.test.ts
```

### Step 2: Write failing deterministic-clock tests

Extract pure comparison/merge logic. Test local envelope seeding after restart; newer local vs older peer; newer peer vs local; equal timestamp tie-break by lexicographic device ID; additive unrelated workspaces; unresolved canonical identity; remote workspace handling; empty/malformed stamps; monotonic timestamps despite clock rollback; changed-workspace detection that does not stamp untouched workspaces; collision rejection; and deletion tombstones that prevent stale resurrection.

Run:

```powershell
bun test apps/desktop/src/shared/tabs-sync.test.ts
```

### Step 3: Implement a pure merge plan

Return a merge result containing the translated `tabsState`, winning canonical IDs, next clocks, peer Claude session handoffs, and warnings. Do not access React, tRPC, or the database in the pure module.

### Step 4: Write failing sequential-consumer and echo-token tests

Prove two peer updates cannot execute concurrently; a slow older update cannot land after a fast newer update; a peer merge commits to main memory and disk before later theme/hotkey writes; a local mutation between peer planning and commit returns `stale`; duplicate event IDs are idempotent; a no-winner peer file replacement is rebased without bumping clocks; local persistence cannot consume a peer token; multiple peer revisions are matched exactly once; and failed acknowledgement leaves a visible retryable error without echoing state.

### Step 5: Implement the coordinated sync flow

Watch the parent directory and re-read the named file after every stable rename/change so an atomic Syncthing swap cannot detach later events. Validate watcher payloads with Task 2 schemas, including a peer-authored file present at startup. Store validated peer snapshots in a bounded main-process event cache keyed by an opaque event ID. The subscription exposes only event metadata and the coordinator base revision.

Implement `sync.rebasePeerUpdate`: accept the event ID, base revision, and renderer-resolved canonical-to-local workspace mapping; re-fetch/revalidate the cached event; verify mappings; and execute the pure merge inside the state coordinator. Return `committed`, `stale`, or `rejected`. A committed result includes revision, validated tabs/envelope, warnings, winning workspaces, and a suppression token. Persist peer Claude session metadata and the merged app state before returning. Update Zustand only after a committed response. On stale, refetch/replan rather than applying an optimistic merge.

Replace the boolean skip flag with a bounded, expiring suppression-token set associated with both committed revision and a deterministic hash of the exact tabs snapshot. Seed clocks from the hydrated local envelope and update them on every local write. Only changed workspaces receive a fresh local timestamp; do not stamp all workspaces on every write. Make Zustand persistence `partialize` explicit and exclude the non-durable closed-tab undo stack.

Add trusted startup extraction/reconciliation tests: a valid durable pane keeps its matching binding; a closed-stack-only binding is removed after restart; corrupt/missing state with existing profile metadata defers cleanup; translated peer IDs retain bindings; unresolved peer identities preserve bindings and warn; reconciliation runs before terminal restoration and a reconciliation error does not brick startup.

### Step 6: Verify and review

Run:

```powershell
bun test apps/desktop/src/main/lib/sync/workspace-identity.test.ts apps/desktop/src/shared/tabs-sync.test.ts apps/desktop/src/main/lib/app-state/watcher.test.ts apps/desktop/src/main/lib/app-state/sync-service.test.ts apps/desktop/src/main/lib/app-state/reconciliation.test.ts apps/desktop/src/lib/trpc/routers/sync apps/desktop/src/renderer/stores/tabs/useTabsSyncSubscription.test.ts apps/desktop/src/renderer/lib/trpc-storage.test.ts
bun run --cwd apps/desktop typecheck
```

Commit after clean review:

```powershell
git add apps/desktop/src/main/lib/sync/workspace-identity.ts apps/desktop/src/main/lib/sync/workspace-identity.test.ts apps/desktop/src/shared/tabs-sync.ts apps/desktop/src/shared/tabs-sync.test.ts apps/desktop/src/main/lib/app-state/watcher.ts apps/desktop/src/main/lib/app-state/watcher.test.ts apps/desktop/src/main/lib/app-state/sync-service.ts apps/desktop/src/main/lib/app-state/sync-service.test.ts apps/desktop/src/main/lib/app-state/reconciliation.ts apps/desktop/src/main/lib/app-state/reconciliation.test.ts apps/desktop/src/lib/trpc/routers/sync apps/desktop/src/renderer/stores/tabs/useTabsSyncSubscription.ts apps/desktop/src/renderer/stores/tabs/useTabsSyncSubscription.test.ts apps/desktop/src/renderer/lib/trpc-storage.ts apps/desktop/src/renderer/lib/trpc-storage.test.ts
git commit -m "fix: make peer state synchronization race safe"
```

## Task 4: Add a verified personal update channel and exact-SHA publication

**Files:**

- Create: `apps/desktop/src/shared/personal-update.ts`
- Create: `apps/desktop/src/shared/personal-update.test.ts`
- Create: `apps/desktop/src/main/lib/personal-update-downloader.ts`
- Create: `apps/desktop/src/main/lib/personal-update-downloader.test.ts`
- Create: `apps/desktop/src/main/lib/recovery/update-snapshot.ts`
- Create: `apps/desktop/src/main/lib/recovery/update-snapshot.test.ts`
- Modify: `apps/desktop/src/main/lib/local-db/index.ts`
- Modify: `apps/desktop/src/main/lib/auto-updater.ts`
- Add/modify focused auto-update tests
- Modify: `apps/desktop/src/shared/auto-update.ts` only if a verified-ready detail is needed
- Create: `.github/scripts/create-personal-update-manifest.cjs`
- Create: `.github/scripts/create-personal-update-manifest.test.cjs`
- Modify: `.github/scripts/publish-direct-downloads.sh`
- Modify: `.github/scripts/verify-update-manifests.cjs`
- Modify: `.github/workflows/personal-distribution-build.yml`
- Modify: `apps/desktop/package.json`
- Modify: `bun.lock` only through Bun's package metadata update
- Modify: `docs/personal-install.md`

### Step 1: Write failing manifest-contract tests

Test every schema field, exact repository HTTPS origin/path, lowercase digests, commit SHA, positive safe integer build number and asset size, required three asset keys, platform selection, semantic version comparison, equal-version build-number comparison, unknown architecture, path-like names, duplicate URLs, and excess payload fields.

### Step 2: Implement the strict manifest parser

Use Zod plus explicit URL constraints. Export pure `parsePersonalUpdateManifest`, `selectPersonalUpdateAsset`, and `isPersonalUpdateAvailable` helpers. Availability compares semantic version first and monotonic build number second.

### Step 3: Write failing downloader tests

Use injected fetch/file/dialog/open dependencies. Cover missing body, HTTP errors, early content-length mismatch, streamed overflow, exact progress, digest mismatch, size mismatch, abort cleanup, successful atomic rename, existing verified file recheck, and rejection of a changed manifest during download.

### Step 4: Implement verified download and installer confirmation

Stream to a versioned `.part` file, cap bytes at manifest size, compute SHA-256, fsync/close, rename only after verification, and keep one verified file per version. Integrate existing update statuses. Background checks only announce. Download is explicit. Installer opening is a second explicit confirmation and calls a tested bounded update snapshot service before `shell.openPath`. The service uses SQLite's backup/VACUUM capability rather than copying a live database and keeps two snapshots; Task 5 adds the broader recovery UI and migration-fingerprint trigger around this shared primitive.

Keep network-loss checks quiet/Idle; surface schema, origin, size, and digest failures.

### Step 5: Write failing publisher tests

Test manifest generation from three stable assets, deterministic key/name mapping, checksums/sizes, exact SHA/version/date, missing/duplicate asset failure, and verifier rejection when any release asset changes.

### Step 6: Update atomic publication

Generate `ade-personal-update-v1.json` after stable renaming and checksum verification, embedding `ADE_BUILD_SHA` and `ADE_BUILD_NUMBER` in both compile and manifest steps. Add it last to the stable inventory and two-phase asset swap so consumers never see a new manifest before all installers are live. Verify GitHub digest/size for the manifest too. Require a successful CI workflow conclusion for the exact `GITHUB_SHA` in the publication validation job, then rerun packaged smoke in each packaging matrix job.

Bump desktop version to `0.6.0` and document the verified update flow.

Run:

```powershell
bun test apps/desktop/src/shared/personal-update.test.ts apps/desktop/src/main/lib/personal-update-downloader.test.ts
node --test .github/scripts/create-personal-update-manifest.test.cjs
node .github/scripts/verify-update-manifests.cjs
bun run --cwd apps/desktop typecheck
```

### Step 7: Review and commit

```powershell
git add apps/desktop/src/shared/personal-update.ts apps/desktop/src/shared/personal-update.test.ts apps/desktop/src/main/lib/personal-update-downloader.ts apps/desktop/src/main/lib/personal-update-downloader.test.ts apps/desktop/src/main/lib/recovery/update-snapshot.ts apps/desktop/src/main/lib/recovery/update-snapshot.test.ts apps/desktop/src/main/lib/local-db/index.ts apps/desktop/src/main/lib/auto-updater.ts apps/desktop/src/shared/auto-update.ts apps/desktop/package.json bun.lock .github/scripts .github/workflows/personal-distribution-build.yml docs/personal-install.md
git commit -m "feat: verify personal updates before installation"
```

## Task 5: Add local diagnostics, health checks, boot recovery, and bounded backups

**Files:**

- Create: `apps/desktop/src/main/lib/diagnostics/redaction.ts`
- Create: `apps/desktop/src/main/lib/diagnostics/redaction.test.ts`
- Create: `apps/desktop/src/main/lib/diagnostics/logger.ts`
- Create: `apps/desktop/src/main/lib/diagnostics/logger.test.ts`
- Create: `apps/desktop/src/main/lib/diagnostics/health.ts`
- Create: `apps/desktop/src/main/lib/diagnostics/health.test.ts`
- Create: `apps/desktop/src/main/lib/diagnostics/boot-state.ts`
- Create: `apps/desktop/src/main/lib/diagnostics/boot-state.test.ts`
- Create: `apps/desktop/src/main/lib/diagnostics/recovery.ts`
- Create: `apps/desktop/src/main/lib/diagnostics/recovery.test.ts`
- Create: `apps/desktop/src/main/bootstrap.ts`
- Create: `apps/desktop/src/lib/trpc/routers/diagnostics/index.ts`
- Create: `apps/desktop/src/lib/trpc/routers/diagnostics/index.test.ts`
- Modify: `apps/desktop/src/lib/trpc/routers/index.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/electron.vite.config.ts`
- Modify: `apps/desktop/src/main/env.main.ts`
- Modify: `apps/desktop/src/renderer/env.renderer.ts`
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/main/lib/local-db/index.ts`
- Modify/add focused local database backup tests
- Create: `apps/desktop/src/renderer/routes/_authenticated/settings/health/page.tsx`
- Create: `apps/desktop/src/renderer/routes/_authenticated/settings/health/components/HealthSettings.tsx`
- Add component-focused tests where the repository's current harness supports them
- Modify: settings layout/sidebar/search files and tests
- Modify: `apps/desktop/src/main/lib/menu.ts`
- Regenerate: `apps/desktop/src/renderer/routeTree.gen.ts`

### Step 1: Write redaction and rotation tests

Cover bearer/basic authorization, GitHub/OpenAI/Anthropic/Hugging Face token shapes, common key/value syntax, URL credentials/query secrets, Windows/macOS/Linux home prefixes, provider profile paths, nested errors, circular values, and safe ordinary messages. Prove logs rotate at 1 MiB and keep three.

### Step 2: Implement local diagnostics foundation

Change Electron Vite's main entry to `bootstrap.ts`. The bootstrap sets local paths, starts Electron `crashReporter` before ready with `uploadToServer: false`, initializes structured JSON-lines logging, then dynamically imports `index.ts` so database migrations cannot run first. Route uncaught exceptions, unhandled rejections, app-state recovery, update failures, and health operations through the logger while preserving console output in development. Remove unused Sentry imports, environment schema, Vite plugin configuration, HTML metadata, and packages.

### Step 3: Write health and export tests

Inject command/path/network dependencies. Assert Pass/Warning/Fail for all checks in the design. Assert exported JSON contains only allowed version/count/hash data and excludes raw paths, state contents, terminal/chat text, environment values, account UUIDs, and credentials. Cover dialog cancellation and write failure.

### Step 4: Implement health router and UI

Add tRPC queries/mutations for `run`, `export`, `markRendererReady`, and explicit recovery operations. Build a compact Health & Recovery page with grouped status rows, Run again, Export diagnostics, Open diagnostics folder, Restore latest app-state snapshot, Reset app state with backup, and Retry normal mode. Destructive recovery controls require confirmation.

Add Help > Health & Recovery and sidebar/search access.

### Step 5: Write boot-state and backup tests

Cover first start, one/two incomplete starts, safe mode on the third, ready reset, corrupted boot file, optional startup suppression, app-state snapshot rotation at three, database rotation at two, one backup per migration fingerprint, and no backup when the database is absent.

### Step 6: Implement recovery lifecycle

Mark `starting` before optional services, call `markRendererReady` after React mount, and clear failures on success. In safe recovery mode skip updater, sync watcher, tray, agent watchers, and automatic terminal restore; navigate to Health & Recovery. Implement app-state restore/reset and bounded SQLite/app-state snapshots. Ensure update installation calls the same snapshot API.

Run:

```powershell
bun test apps/desktop/src/main/lib/diagnostics apps/desktop/src/lib/trpc/routers/diagnostics apps/desktop/src/main/lib/local-db
bun test apps/desktop/src/renderer/routes/_authenticated/settings/utils/settings-search/settings-search.test.ts
bun run --cwd apps/desktop generate:routes
bun run --cwd apps/desktop typecheck
```

### Step 7: Review and commit

```powershell
git add apps/desktop/src/main/bootstrap.ts apps/desktop/src/main/lib/diagnostics apps/desktop/src/lib/trpc/routers/diagnostics apps/desktop/src/lib/trpc/routers/index.ts apps/desktop/src/main/index.ts apps/desktop/src/main/lib/local-db apps/desktop/src/main/lib/menu.ts apps/desktop/src/renderer/routes/_authenticated/settings apps/desktop/src/renderer/routeTree.gen.ts apps/desktop/electron.vite.config.ts apps/desktop/src/main/env.main.ts apps/desktop/src/renderer/env.renderer.ts apps/desktop/src/renderer/index.html apps/desktop/package.json bun.lock
git commit -m "feat: add local health diagnostics and recovery"
```

## Task 6: Prove the real packaged graphical application on all platforms

**Files:**

- Create: `apps/desktop/src/main/lib/packaged-smoke.ts`
- Create: `apps/desktop/src/main/lib/packaged-smoke.test.ts`
- Create: `apps/desktop/src/renderer/lib/packaged-smoke-bridge.ts`
- Create: `apps/desktop/src/renderer/lib/packaged-smoke-bridge.test.ts`
- Create: `apps/desktop/scripts/smoke-packaged-gui.cjs`
- Create: `apps/desktop/scripts/smoke-packaged-gui.test.cjs`
- Modify: `apps/desktop/src/lib/window-loader.ts`
- Modify: `apps/desktop/src/main/windows/main.ts`
- Modify: `apps/desktop/src/renderer/index.tsx`
- Modify: `apps/desktop/package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/personal-distribution-build.yml`

### Step 1: Write failing smoke-protocol tests

Specify an unguessable per-run token, output/result schema, timeout, allowed commands, clean shutdown, retry launch, and rejection when the token/query/environment do not all match. Test query propagation in `window-loader`.

### Step 2: Implement packaged smoke mode

The launcher creates a temporary home, token, and output path, then starts the unpacked packaged executable without `ELECTRON_RUN_AS_NODE`. Main passes the token only through a local startup contract; renderer exposes the bridge only for a matching smoke query and token. The bridge runs the exact assertions from the design and returns structured results through tRPC. Main writes the result, closes cleanly, and relaunches once against the same temporary state.

Do not expose general code evaluation, raw filesystem access, or a production-accessible test API.

### Step 3: Integrate platform jobs

Replace the node-only packaged step with real GUI smoke after `--dir` packaging in CI and Direct Download Build. Retain native module smoke as a separate earlier check. Use platform-specific executable discovery, a 90-second hard timeout, hidden Windows process, and normal headless CI window behavior on macOS. Upload result/log tail only on failure and always delete temporary homes.

Run locally on Windows:

```powershell
bun test apps/desktop/src/main/lib/packaged-smoke.test.ts apps/desktop/src/renderer/lib/packaged-smoke-bridge.test.ts
node --test apps/desktop/scripts/smoke-packaged-gui.test.cjs
bun run --cwd apps/desktop compile:app
bun run --cwd apps/desktop package -- --dir --win --x64 --publish never --config electron-builder.ts
bun run --cwd apps/desktop smoke:packaged-gui -- --platform win32 --app release/win-unpacked/ADE.exe
```

### Step 4: Review and commit

```powershell
git add apps/desktop/src/main/lib/packaged-smoke.ts apps/desktop/src/main/lib/packaged-smoke.test.ts apps/desktop/src/renderer/lib/packaged-smoke-bridge.ts apps/desktop/src/renderer/lib/packaged-smoke-bridge.test.ts apps/desktop/scripts/smoke-packaged-gui.cjs apps/desktop/scripts/smoke-packaged-gui.test.cjs apps/desktop/src/lib/window-loader.ts apps/desktop/src/main/windows/main.ts apps/desktop/src/renderer/index.tsx apps/desktop/package.json .github/workflows/ci.yml .github/workflows/personal-distribution-build.yml
git commit -m "test: boot packaged ADE UI on every platform"
```

## Task 7: Enforce dependency, test, and GitHub CI policy

**Files:**

- Create: `scripts/verify-production-audit.ts`
- Create: `scripts/verify-production-audit.test.ts`
- Create: `.github/dependency-audit-policy.json`
- Modify: `package.json`
- Modify manifests that declare versions overridden at root so Sherif reports no drift
- Modify: `bun.lock`
- Modify: `apps/desktop/package.json`
- Modify: `.github/dependabot.yml`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/dependency-security.yml`
- Modify other active workflows only where Bun is not 1.3.6
- Create/update: `docs/security-maintenance.md`

### Step 1: Write failing audit-policy tests

Feed synthetic Bun audit output. Prove critical/high always fail unless an exact unexpired, scoped exception exists; new advisory IDs fail; expired/malformed entries fail; severity downgrades do not broaden exceptions; fixed advisories make stale exceptions fail; and the summary is deterministic.

### Step 2: Update compatible dependencies and lockfile

Use primary advisories and package release metadata. Align Better Auth and Drizzle declarations with the resolved versions. Upgrade safe direct/transitive packages without crossing incompatible majors. Run the full focused suites for affected auth/AI/build modules. For an upstream exact pin that cannot safely move, document runtime reachability, owner, expiry within 30 days, and upstream tracking in the policy.

The production gate must end with zero unexcepted high/critical findings.

### Step 3: Make isolated tests canonical

Change desktop `test` to `bun run scripts/test-complete.ts` and add `test:fast` as `bun test`. Confirm root `turbo test` invokes the isolated runner. Pin every workflow to Bun 1.3.6.

### Step 4: Expand CI

Run complete isolated desktop tests on Windows x64, macOS Apple Silicon, and macOS Intel. Add Production dependency audit on pushes/PRs. Add official Dependency Review on pull requests. Preserve stable job names from the design. Ensure package smoke depends on compile/typecheck and fails fast on missing OpenSSH/SFTP.

### Step 5: Enforce owner-only dependency maintenance

Keep automated dependency and security-fix branches disabled because the user requires Chi944 to remain the only contributor. Enable GitHub's dependency graph and vulnerability alerts, but not automated security-fix pull requests. Add a monthly read-only workflow that runs the frozen install plus production audit policy and creates no branch, commit, issue, or pull request. Document how Chi944 applies flagged updates on an owner branch and how exceptions expire.

Run:

```powershell
bun test scripts/verify-production-audit.test.ts
bun audit --production --json
bun run scripts/verify-production-audit.ts
bunx sherif
bun run typecheck
```

### Step 6: Review and commit

```powershell
git add scripts/verify-production-audit.ts scripts/verify-production-audit.test.ts .github/dependency-audit-policy.json package.json apps/*/package.json packages/*/package.json bun.lock .github/dependabot.yml .github/workflows docs/security-maintenance.md
git commit -m "ci: enforce cross-platform reliability and dependency policy"
```

## Task 8: Full verification, independent review, GitHub checks, merge, and deployment

**Files:** No planned production edits. Any review fix must return to its owning task tests and receive re-review.

### Step 1: Run the full local gate from a clean dependency state

```powershell
bun install --frozen
bun run apps/desktop/scripts/test-complete.ts
bun test packages/shared/src
bun run typecheck
bun run lint
bunx sherif
bun run scripts/verify-production-audit.ts
bun turbo run build --filter=@ade/desktop
bun run --cwd apps/desktop smoke:native
bun run --cwd apps/desktop smoke:migrations
bun run --cwd apps/desktop package -- --dir --win --x64 --publish never --config electron-builder.ts
bun run --cwd apps/desktop validate:package-footprint
bun run --cwd apps/desktop smoke:packaged-gui -- --platform win32 --app release/win-unpacked/ADE.exe
```

Record exact pass/fail counts and packaged smoke result.

### Step 2: Run whole-branch review

Create a review package from merge base `48962c81787b60db6a2a43bb0d53c3f78b88f242` to HEAD. Dispatch an independent senior review for security, data loss, concurrency, updater trust, cross-platform behavior, test quality, and scope compliance. Fix all critical/important findings in one wave, rerun covering tests, and re-review until clean.

### Step 3: Push and open a pull request

```powershell
git push -u origin codex/reliability-hardening-v1
gh pr create --base main --head codex/reliability-hardening-v1 --title "Reliability Hardening v1" --body-file .superpowers/sdd/pr-body.md
```

### Step 4: Watch exact-SHA CI to completion

Require every stable job in the design. Inspect and fix any failure; push the fix and restart the watch. Do not merge with skipped, pending, cancelled, neutral, or stale required checks.

### Step 5: Configure repository security and required checks

Using `gh api`, enable the dependency graph and vulnerability alerts, confirm automated security fixes remain disabled, and confirm Chi944 is still the only collaborator. Keep the active owner-only branch/tag rulesets unchanged. Create a separate active quality ruleset targeting only `refs/heads/main`, with no bypass actor, a required pull request with zero approvals, and the stable status-check contexts reported by this PR. Read every ruleset back and compare exact targets, actors, and contexts.

### Step 6: Merge and verify main

Merge through the pull request without bypassing checks, update local `main`, and require the post-merge CI run for the merge SHA to pass.

### Step 7: Publish and verify the personal release

Dispatch Direct Download Build on `main` only after exact-SHA CI is green. Watch all jobs. Verify the `personal-latest` release contains exactly:

- `ADE-Windows-x64.exe`
- `ADE-macOS-Apple-Silicon.dmg`
- `ADE-macOS-Intel.dmg`
- `SHA256SUMS.txt`
- `ade-personal-update-v1.json`

Download the small manifest/checksum files, validate manifest SHA/version/commit and all three remote asset sizes/digests through GitHub's release API, and confirm anonymous HEAD/GET access.

### Step 8: Final repository audit

Confirm:

```powershell
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
gh pr view --json state,mergedAt,mergeCommit,statusCheckRollup
gh run list --commit <merge-sha> --limit 10
gh api repos/Chi944/chi-ade-windows/rulesets
gh api repos/Chi944/chi-ade-windows/vulnerability-alerts
gh api repos/Chi944/chi-ade-windows/automated-security-fixes
gh api repos/Chi944/chi-ade-windows/collaborators
```

The task is complete only with a clean synchronized `main`, green post-merge CI, successful direct publication, verified assets/manifest, and active required checks.
