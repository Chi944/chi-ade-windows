# Task 2 report: validate and serialize persistent app state

## Outcome

Implemented one validated, atomic, FIFO-serialized main-process persistence boundary for application state. Startup now distinguishes clean, first-run, damaged, and unreadable state; preserves damaged sources in a three-file quarantine; restores safe defaults without blocking the application; and gates Task 1 account-binding cleanup on a trusted load with localized workspace identities.

Tabs, theme, hotkeys, and the development recovery reset now commit through the shared coordinator. Watcher reads and renderer mutations use the same runtime contracts, provider-profile UUIDs are stripped before durable use, and callers receive cloned snapshots instead of references to committed state.

The independent Task 2 reviews found and fixed five additional persistent-state boundary issues: trusted startup now classifies writer workspace IDs before installing the coordinator snapshot; Syncthing excludes bounded quarantine and atomic-write temporary files without excluding durable `app-state.json`; incomplete snapshots cannot become reconciliation-trusted merely by normalizing missing tabs data to defaults; Syncthing escape directives retain their raw preamble position without disabling managed wildcard semantics; and files already written with the managed block before a valid escape preamble self-repair on the next launch.

## Implementation summary

- Replaced shallow default merging with exhaustive shared Zod contracts for tabs, panes, layouts, browser state, themes, hotkeys, and the sync envelope. The contracts preserve all current durable fields, including `terminalProfileId` and browser `error`, while explicitly stripping `closedTabsStack` and file-viewer navigation hints.
- Added deep normalization for documented legacy omissions plus post-parse invariants for tab and pane identity, same-tab layout leaves, unique layout membership, focused panes, active tabs, workspace history, browser history indexes, and DevTools targets. Wrong containers, unknown fields/runtimes, invalid profile values, non-finite numbers, oversized records, and payloads over 8 MiB are rejected.
- Required persisted trust-boundary snapshots to contain the durable tabs core (`tabsState.tabs` and `tabsState.panes`) before normalization. Missing-core inputs such as `{}` and `{"tabsState":{}}` now use the existing invalid-shape quarantine/default recovery path and defer destructive binding reconciliation, while supported legacy omissions remain trusted when the core is present.
- Replaced the lowdb preset loader with explicit startup classification. Invalid JSON, invalid shape, and read failures preserve the source under `app-state.quarantine.<timestamp>.<uuid>.json`, rotate to at most three files, atomically materialize local-device defaults, and emit only redacted diagnostic metadata.
- A successful clean load is not rewritten. If quarantine or replacement cannot preserve the original source, the application uses untrusted in-memory defaults with writes disabled for that process rather than risking source loss.
- Added `AppStateMutationCoordinator`: every operation clones the latest committed snapshot, applies one mutation, validates a fresh normalized value, atomically writes a restrictive sibling temporary, then swaps committed memory. FIFO ordering survives rejected validation or writes, revisions advance only on success, and snapshots/commit results are cloned.
- Routed tabs plus sync stamping through one queued transaction, preventing theme/hotkey writes from interleaving with asynchronous terminal-history reads. Existing legacy path metadata remains readable, but Task 2 creates no new path-derived canonical metadata.
- Routed theme, hotkeys, and development terminal recovery through the same queue. The recovery write stamps the local device and clock so it cannot be mistaken for a peer-authored update.
- Validated watcher snapshots with the shared parser and ignored malformed peer data with a fixed redacted warning.
- Wired Task 1 binding reconciliation after trusted validation. Peer-local workspace IDs are translated through the existing sync envelope without auto-creation; remote panes are excluded from local provider binding; unresolved identities and recovered/untrusted state defer destructive cleanup; reconciliation failures do not block startup.
- Before a trusted snapshot is installed in the coordinator, classify each writer workspace ID as proven local, proven remote, or unresolved through the existing canonical/local and remote-binding contracts. Persistence sanitization then marks local provider panes, clears remote provider markers, preserves only an existing marker for unresolved panes, and strips every device-local profile UUID. If classification fails, startup installs the conservative all-unresolved sanitized form.
- Added anchored managed Syncthing exclusions for `/app-state.quarantine.*.json` and `/.app-state.json.*.tmp`. They remain ahead of user rules and negations, match only root-level recovery artifacts, and leave `/app-state.json` syncable.
- Parsed Syncthing's actual trimmed `#escape = X` preamble grammar, including indentation, whitespace around `=`, CRLF, and exactly one Unicode rune, while retaining the original directive and surrounding bytes. Escape runes that collide with the managed block (including `*` or `/`) fail closed before any rewrite; non-colliding runes preserve the managed root anchors and wildcards. Existing managed blocks are removed from directive discovery first, allowing a previously displaced valid preamble to be relocated ahead of all managed patterns without changing user bytes.

## TDD evidence

Each production behavior was introduced from a focused RED test. Representative failures included missing validation and queue modules; permissive malformed-state loading; a watcher without the shared peer parser; initialization without trusted reconciliation; direct router writes and aliased mutable reads; and the recovery reset's direct lowdb dependency.

The initial self-review added two adversarial RED cases before their fixes:

- A recovery reset performed after a peer-authored load retained the peer `deviceId`, allowing the watcher to misclassify a local reset. The queued reset now stamps the local identity and timestamp.
- A throwing diagnostic observer escaped the recovery path after quarantine/default creation and could crash initialization. Diagnostic observers are now best-effort and receive only fixed, redacted failure reporting.

The independent review follow-up added two more RED cases:

- A trusted peer-authored startup snapshot was sanitized before writer workspace IDs were localized, so a later theme-only write could re-persist a missing local marker, a stale remote marker, or an inferred unresolved marker. The integration RED covered local-unmarked, remote-pinned, unresolved-pinned, and unresolved-unpinned provider panes plus UUID-bearing panes; after a theme-only queued mutation, the disk assertions now pass.
- The managed Syncthing block did not exclude the bounded quarantine files or atomic writer temporaries. The RED asserted both exact anchored patterns, precedence over user negations, representative root-versus-nested matching, and that `/app-state.json` remains unmatched.

The final review follow-up added two further RED groups:

- `{}` and `{"tabsState":{}}` were normalized into empty defaults and marked trusted, so startup invoked the reconciliation spy and deleted simulated existing bindings and profile homes. The integration RED now proves both sources are quarantined as incomplete, reconciliation is deferred, and the binding/home sentinels survive; a core-present legacy snapshot remains trusted.
- Valid indented/whitespace-flexible CRLF `#escape = |` and Unicode-rune preambles were moved behind managed patterns, while `#escape=*` reported successful installation even though it converted managed wildcards into literals. The conformance RED applies Syncthing's directive preprocessing before matching and proves byte preservation, idempotence, root-only quarantine/temp exclusions, nested non-matches, durable state synchronization, and collision failure without changing the original file.

The final release review added one last ordering RED: a file already shaped as `MANAGED_BLOCK + raw CRLF/Unicode escape preamble + user patterns` treated the managed patterns as preceding the directive and threw before it could repair the legacy ordering. Directive discovery now runs against the managed-block-free bytes, then either retains an already-correct block position or reinserts the block after the preserved preamble. The regression proves byte-exact preamble and user-pattern preservation, effective managed quarantine/temp matching, successful first-call relocation, and a byte-for-byte idempotent second call.

All RED cases were turned GREEN before the frozen verification run.

## Final verification on the frozen snapshot

```text
bun test --isolate apps/desktop/src/main/lib/app-state/validation.test.ts apps/desktop/src/main/lib/app-state/index.test.ts apps/desktop/src/main/lib/sync/sensitive-ignore.test.ts
48 tests, 182 assertions, 0 failures across 3 files

bun test --isolate apps/desktop/src/main/lib/app-state/validation.test.ts apps/desktop/src/main/lib/app-state/write-queue.test.ts apps/desktop/src/main/lib/app-state/index.test.ts apps/desktop/src/main/lib/app-state/watcher.test.ts apps/desktop/src/lib/trpc/routers/ui-state apps/desktop/src/main/lib/terminal/dev-reset.test.ts
58 tests, 174 assertions, 0 failures across 7 files

bun test --isolate apps/desktop/src/main/lib/subscription-profile-storage.test.ts apps/desktop/src/main/lib/subscription-profiles.test.ts apps/desktop/src/main/lib/sync/sensitive-ignore.test.ts apps/desktop/src/lib/trpc/routers/ui-state/peer-profile-normalizer.test.ts apps/desktop/src/lib/trpc/routers/sync/index.test.ts apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/subscription-profile-rebind.test.ts
83 tests, 308 assertions, 0 failures across 6 files

bun run --cwd apps/desktop typecheck
route generation and tsc --noEmit completed successfully

bunx biome check <5 changed source and test files>
clean, no fixes required

git diff --check
clean (only informational CRLF conversion warnings on Windows)
```

All final review P1 findings were reproduced RED and turned GREEN. This report does not claim independent approval; root owns the final narrow re-review of the frozen follow-up.

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
- `.superpowers/sdd/task-2-report.md`

## Remaining concerns

Task 3 still owns deterministic peer adoption through this coordinator, parent-directory watching across atomic rename swaps, startup peer-file ingestion, bounded event caching, revision-aware rebase, and echo suppression. Task 2 deliberately validates and emits peer snapshots but does not pre-implement that reviewed sync protocol.

The focused commands use Bun's `--isolate` option because these suites contain module-global mocks and Task 1 has a documented cross-file private-root override. No unrelated harness change was made.

An additional non-gating run that included the unchanged `service-manager.test.ts` hit the same two five-second asynchronous test timeouts both in the broad command and when that file was rerun alone (13 passed, 2 timed out). The requested Task 1 profile, sensitive-ignore, and sync regression gate above is clean; this follow-up did not modify terminal service code.
