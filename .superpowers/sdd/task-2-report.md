# Task 2 report: validate and serialize persistent app state

## Outcome

Implemented one validated, atomic, FIFO-serialized main-process persistence boundary for application state. Startup now distinguishes clean, first-run, damaged, and unreadable state; preserves damaged sources in a three-file quarantine; restores safe defaults without blocking the application; and gates Task 1 account-binding cleanup on a trusted load with localized workspace identities.

Tabs, theme, hotkeys, and the development recovery reset now commit through the shared coordinator. Watcher reads and renderer mutations use the same runtime contracts, provider-profile UUIDs are stripped before durable use, and callers receive cloned snapshots instead of references to committed state.

The independent Task 2 review found and fixed two additional persistent-state boundary issues: trusted startup now classifies writer workspace IDs before installing the coordinator snapshot, and Syncthing now excludes the bounded quarantine and atomic-write temporary files without excluding the durable `app-state.json`.

## Implementation summary

- Replaced shallow default merging with exhaustive shared Zod contracts for tabs, panes, layouts, browser state, themes, hotkeys, and the sync envelope. The contracts preserve all current durable fields, including `terminalProfileId` and browser `error`, while explicitly stripping `closedTabsStack` and file-viewer navigation hints.
- Added deep normalization for documented legacy omissions plus post-parse invariants for tab and pane identity, same-tab layout leaves, unique layout membership, focused panes, active tabs, workspace history, browser history indexes, and DevTools targets. Wrong containers, unknown fields/runtimes, invalid profile values, non-finite numbers, oversized records, and payloads over 8 MiB are rejected.
- Replaced the lowdb preset loader with explicit startup classification. Invalid JSON, invalid shape, and read failures preserve the source under `app-state.quarantine.<timestamp>.<uuid>.json`, rotate to at most three files, atomically materialize local-device defaults, and emit only redacted diagnostic metadata.
- A successful clean load is not rewritten. If quarantine or replacement cannot preserve the original source, the application uses untrusted in-memory defaults with writes disabled for that process rather than risking source loss.
- Added `AppStateMutationCoordinator`: every operation clones the latest committed snapshot, applies one mutation, validates a fresh normalized value, atomically writes a restrictive sibling temporary, then swaps committed memory. FIFO ordering survives rejected validation or writes, revisions advance only on success, and snapshots/commit results are cloned.
- Routed tabs plus sync stamping through one queued transaction, preventing theme/hotkey writes from interleaving with asynchronous terminal-history reads. Existing legacy path metadata remains readable, but Task 2 creates no new path-derived canonical metadata.
- Routed theme, hotkeys, and development terminal recovery through the same queue. The recovery write stamps the local device and clock so it cannot be mistaken for a peer-authored update.
- Validated watcher snapshots with the shared parser and ignored malformed peer data with a fixed redacted warning.
- Wired Task 1 binding reconciliation after trusted validation. Peer-local workspace IDs are translated through the existing sync envelope without auto-creation; remote panes are excluded from local provider binding; unresolved identities and recovered/untrusted state defer destructive cleanup; reconciliation failures do not block startup.
- Before a trusted snapshot is installed in the coordinator, classify each writer workspace ID as proven local, proven remote, or unresolved through the existing canonical/local and remote-binding contracts. Persistence sanitization then marks local provider panes, clears remote provider markers, preserves only an existing marker for unresolved panes, and strips every device-local profile UUID. If classification fails, startup installs the conservative all-unresolved sanitized form.
- Added anchored managed Syncthing exclusions for `/app-state.quarantine.*.json` and `/.app-state.json.*.tmp`. They remain ahead of user rules and negations, match only root-level recovery artifacts, and leave `/app-state.json` syncable.

## TDD evidence

Each production behavior was introduced from a focused RED test. Representative failures included missing validation and queue modules; permissive malformed-state loading; a watcher without the shared peer parser; initialization without trusted reconciliation; direct router writes and aliased mutable reads; and the recovery reset's direct lowdb dependency.

The initial self-review added two adversarial RED cases before their fixes:

- A recovery reset performed after a peer-authored load retained the peer `deviceId`, allowing the watcher to misclassify a local reset. The queued reset now stamps the local identity and timestamp.
- A throwing diagnostic observer escaped the recovery path after quarantine/default creation and could crash initialization. Diagnostic observers are now best-effort and receive only fixed, redacted failure reporting.

The independent review follow-up added two more RED cases:

- A trusted peer-authored startup snapshot was sanitized before writer workspace IDs were localized, so a later theme-only write could re-persist a missing local marker, a stale remote marker, or an inferred unresolved marker. The integration RED covered local-unmarked, remote-pinned, unresolved-pinned, and unresolved-unpinned provider panes plus UUID-bearing panes; after a theme-only queued mutation, the disk assertions now pass.
- The managed Syncthing block did not exclude the bounded quarantine files or atomic writer temporaries. The RED asserted both exact anchored patterns, precedence over user negations, representative root-versus-nested matching, and that `/app-state.json` remains unmatched.

All RED cases were turned GREEN before the frozen verification run.

## Final verification on the frozen snapshot

```text
bun test --isolate apps/desktop/src/main/lib/app-state/index.test.ts apps/desktop/src/main/lib/sync/sensitive-ignore.test.ts
24 tests, 103 assertions, 0 failures across 2 files

bun test --isolate apps/desktop/src/main/lib/app-state/validation.test.ts apps/desktop/src/main/lib/app-state/write-queue.test.ts apps/desktop/src/main/lib/app-state/index.test.ts apps/desktop/src/main/lib/app-state/watcher.test.ts apps/desktop/src/lib/trpc/routers/ui-state apps/desktop/src/main/lib/terminal/dev-reset.test.ts
53 tests, 160 assertions, 0 failures across 7 files

bun test --isolate apps/desktop/src/main/lib/subscription-profile-storage.test.ts apps/desktop/src/main/lib/subscription-profiles.test.ts apps/desktop/src/main/lib/sync/sensitive-ignore.test.ts apps/desktop/src/lib/trpc/routers/ui-state/peer-profile-normalizer.test.ts apps/desktop/src/lib/trpc/routers/sync/index.test.ts apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/subscription-profile-rebind.test.ts
80 tests, 280 assertions, 0 failures across 6 files

bun run --cwd apps/desktop typecheck
route generation and tsc --noEmit completed successfully

bunx biome check <4 changed source and test files>
clean, no fixes required

git diff --check
clean (only informational CRLF conversion warnings on Windows)
```

Both independent P1 findings were reproduced RED and turned GREEN. This report does not claim independent approval; root owns the final narrow re-review of the frozen follow-up.

## Files changed

- `apps/desktop/src/main/lib/app-state/schemas.ts`
- `apps/desktop/src/main/lib/app-state/validation.ts`
- `apps/desktop/src/main/lib/app-state/validation.test.ts`
- `apps/desktop/src/main/lib/app-state/write-queue.ts`
- `apps/desktop/src/main/lib/app-state/write-queue.test.ts`
- `apps/desktop/src/main/lib/app-state/index.ts`
- `apps/desktop/src/main/lib/app-state/index.test.ts`
- `apps/desktop/src/main/lib/app-state/watcher.ts`
- `apps/desktop/src/main/lib/app-state/watcher.test.ts`
- `apps/desktop/src/lib/trpc/routers/ui-state/index.ts`
- `apps/desktop/src/lib/trpc/routers/ui-state/index.test.ts`
- `apps/desktop/src/lib/trpc/routers/ui-state/peer-profile-normalizer.test.ts`
- `apps/desktop/src/main/lib/terminal/dev-reset.ts`
- `apps/desktop/src/main/lib/terminal/dev-reset.test.ts`
- `apps/desktop/src/shared/subscription-profile-rebind.ts`
- `apps/desktop/src/main/lib/sync/sensitive-ignore.ts`
- `apps/desktop/src/main/lib/sync/sensitive-ignore.test.ts`

## Remaining concerns

Task 3 still owns deterministic peer adoption through this coordinator, parent-directory watching across atomic rename swaps, startup peer-file ingestion, bounded event caching, revision-aware rebase, and echo suppression. Task 2 deliberately validates and emits peer snapshots but does not pre-implement that reviewed sync protocol.

The focused commands use Bun's `--isolate` option because these suites contain module-global mocks and Task 1 has a documented cross-file private-root override. No unrelated harness change was made.

An additional non-gating run that included the unchanged `service-manager.test.ts` hit the same two five-second asynchronous test timeouts both in the broad command and when that file was rerun alone (13 passed, 2 timed out). The requested Task 1 profile, sensitive-ignore, and sync regression gate above is clean; this follow-up did not modify terminal service code.
