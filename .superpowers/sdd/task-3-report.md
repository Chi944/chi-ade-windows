# Task 3 report: make peer synchronization deterministic and restart-safe

## Outcome

Implemented a main-process-owned peer tab synchronization protocol that is deterministic across restarts, serialized with every other durable app-state mutation, and safe against stale, duplicate, concurrent, and reconnecting renderer requests. Peer snapshots are validated and cached behind opaque event IDs; the renderer resolves only requested portable workspace identities; main revalidates those mappings and commits the merge before Zustand is updated.

Workspace clocks are now seeded from the durable envelope, updated only for changed workspaces, and ordered by timestamp plus device ID. Portable identities contain only normalized Git repository identity, branch, and workspace type. Deletion tombstones prevent stale resurrection, no-winner peer replacements are still rebased to a local-authored snapshot, and exact suppression tokens prevent the committed peer snapshot from echoing back as a local write.

Startup and reconnect handling are covered end to end. The parent directory watcher survives atomic file replacement and ingests an already-present peer file, cached metadata is replayed after subscription attachment without attach-race duplication, trusted startup localizes peer workspace IDs before reconciliation, and peer Claude sessions are staged once without auto-submitting the resume command.

## Implementation summary

- Replaced path-derived workspace identity with credential-free normalization for HTTPS, SCP-style SSH, and `ssh://` origins. Local/file remotes remain unresolved, missing projects are never fabricated, requested renderer mappings are filtered to the event's canonical IDs, project origins are read at most once per batch, deleting workspaces are skipped, and ambiguous canonical mappings are omitted.
- Added pure tabs synchronization logic for clock comparison, restart seeding, monotonic local stamps, exact workspace change detection, canonical collision rejection, peer/local translation, deletion tombstones, deterministic snapshot hashing, and peer Claude session handoff extraction.
- Extended the durable sync envelope with portable metadata and workspace tombstones while dropping legacy path metadata during normalization.
- Made the app-state watcher observe the containing directory, debounce rename/change events, wait for the named file to stabilize, ingest the file at startup, and store validated defensive snapshots in a bounded expiring cache. Subscriptions expose only opaque metadata and attach before cache enumeration, so startup and reconnect replay cannot lose an event or duplicate an attach race.
- Added a queued `sync.rebasePeerUpdate` service. It re-fetches cached peer state, verifies renderer mappings before and inside the coordinator transaction, plans against the queued current snapshot, persists session handoffs and app state before acknowledging, returns `stale` for revision movement, and maps failed commits to a closed rejection contract.
- Added bounded idempotency for processed events and a true in-flight join keyed by event ID plus mapping fingerprint. Simultaneous identical requests share one promise, token, and durable write; conflicting duplicates are rejected. A later replay returns the coordinator's current snapshot and revision with a fresh exact-snapshot suppression token.
- Refactored the renderer consumer into one sequential queue. Stale events replan at the returned revision, rejected acknowledgements remain visibly retryable, and Zustand changes only after main reports a durable commit.
- Replaced the tabs boolean skip flag with a bounded expiring token registry keyed by exact deterministic tabs hash and committed revision. Tokens are acknowledged immediately before applying the committed snapshot and consumed exactly once by persistence; an ordinary local write cannot consume a mismatched token.
- Added an explicit Zustand tabs `partialize` boundary so only durable tabs fields persist and the closed-tab undo stack remains local and transient.
- Added trusted startup localization and binding reconciliation before terminal restoration. Closed-stack-only bindings are removed only for trusted state; recovered, untrusted, or unresolved workspace cases preserve bindings conservatively and warn.
- Added one-time startup peer-pane markers outside durable state. Peer session-only history metadata survives terminal service probing, peer resume commands are staged without Enter, and a failed terminal write restores only the consumed peer marker.
- Awaited watcher startup before the rest of main boot so a peer file already present on disk is cached before renderer subscription and terminal restoration.

## TDD evidence

Production behavior was introduced behind focused RED tests and then turned GREEN. Representative initial RED failures covered missing portable identity and pure merge modules, detached file watching after atomic rename, absent event cache replay, concurrent renderer consumption, optimistic Zustand application, boolean echo suppression, incomplete startup localization, and session-only handoff cleanup.

The final audit follow-ups added three explicit RED regressions before their fixes:

- Two simultaneous identical rebase requests originally performed one write but minted different acknowledgement tokens. The in-flight registry now returns the same pending promise/result, and the regression proves exact result equality plus one durable write.
- The first preferred-mapping optimization could hide an unpersisted duplicate checkout with the same canonical identity. Preferences now determine probe order only, portable metadata excludes branch/type-ineligible projects, and every plausible project is checked once. The same unique-match collector now guards the renderer mapping query, trusted startup localization, and main-process reverse verification; the RED proves a preferred cross-project duplicate is omitted instead of arbitrarily selecting the first checkout.
- A processed event replay originally returned the old committed tabs snapshot after a later local mutation. The replay now returns the coordinator's current revision, tabs state, and envelope with a fresh matching token and no additional peer write.

Additional RED cases prove startup cache replay with attach-race deduplication, reconnect replay, opaque subscription payloads, requested-canonical-only renderer queries, fresh tokens after expiry, stale replanning, no-winner rebases without clock bumps, startup handoff persistence ordering, and failed staged-resume marker restoration.

## Final verification on the frozen snapshot

```text
bun test --isolate <Task 3 workspace identity, tabs sync, watcher, sync service,
reconciliation, sync router, renderer consumer/storage/registry, UI-state,
app-state initialization/validation/write-queue suites>
124 tests, 378 assertions, 0 failures across 13 files

bun test --isolate <Task 2 validation, write queue, initialization, watcher,
UI-state, development reset, and sensitive-ignore regression suites>
82 tests, 283 assertions, 0 failures across 8 files

bun test --isolate apps/desktop/src/main/lib/subscription-profile-storage.test.ts
apps/desktop/src/main/lib/subscription-profiles.test.ts
apps/desktop/src/main/lib/sync/sensitive-ignore.test.ts
apps/desktop/src/lib/trpc/routers/ui-state/peer-profile-normalizer.test.ts
apps/desktop/src/lib/trpc/routers/sync/index.test.ts
apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/subscription-profile-rebind.test.ts
87 tests, 318 assertions, 0 failures across 6 files

bun test --isolate apps/desktop/src/main/lib/terminal/service/service-manager.test.ts -t "session-only metadata"
2 tests, 8 assertions, 0 failures (15 unrelated tests filtered out)

bun run --cwd apps/desktop typecheck
route generation and tsc --noEmit completed successfully

node_modules/.bin/biome check <33 changed TypeScript/TSX files>
clean, no fixes required

git diff --check
clean (only informational CRLF conversion warnings on Windows)
```

The post-format Task 3 suite and typecheck were rerun on the exact frozen source snapshot. This report does not claim independent approval; root owns the final narrow review of the committed patch.

## Files changed

- `apps/desktop/src/shared/tabs-sync.ts`
- `apps/desktop/src/shared/tabs-sync.test.ts`
- `apps/desktop/src/main/lib/sync/workspace-identity.ts`
- `apps/desktop/src/main/lib/sync/workspace-identity.test.ts`
- `apps/desktop/src/main/lib/app-state/schemas.ts`
- `apps/desktop/src/main/lib/app-state/validation.ts`
- `apps/desktop/src/main/lib/app-state/validation.test.ts`
- `apps/desktop/src/main/lib/app-state/write-queue.ts`
- `apps/desktop/src/main/lib/app-state/write-queue.test.ts`
- `apps/desktop/src/main/lib/app-state/index.ts`
- `apps/desktop/src/main/lib/app-state/index.test.ts`
- `apps/desktop/src/main/lib/app-state/watcher.ts`
- `apps/desktop/src/main/lib/app-state/watcher.test.ts`
- `apps/desktop/src/main/lib/app-state/sync-service.ts`
- `apps/desktop/src/main/lib/app-state/sync-service.test.ts`
- `apps/desktop/src/main/lib/app-state/reconciliation.ts`
- `apps/desktop/src/main/lib/app-state/reconciliation.test.ts`
- `apps/desktop/src/lib/trpc/routers/sync/index.ts`
- `apps/desktop/src/lib/trpc/routers/sync/index.test.ts`
- `apps/desktop/src/lib/trpc/routers/ui-state/index.ts`
- `apps/desktop/src/lib/trpc/routers/ui-state/index.test.ts`
- `apps/desktop/src/renderer/stores/tabs/useTabsSyncSubscription.ts`
- `apps/desktop/src/renderer/stores/tabs/useTabsSyncSubscription.test.ts`
- `apps/desktop/src/renderer/lib/trpc-storage.ts`
- `apps/desktop/src/renderer/lib/trpc-storage.test.ts`
- `apps/desktop/src/renderer/stores/tabs/store.ts`
- `apps/desktop/src/renderer/stores/tabs/syncedPaneRegistry.ts`
- `apps/desktop/src/renderer/stores/tabs/syncedPaneRegistry.test.ts`
- `apps/desktop/src/main/lib/terminal/service/service-manager.ts`
- `apps/desktop/src/main/lib/terminal/service/service-manager.test.ts`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/hooks/useTerminalColdRestore.ts`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/hooks/useTerminalLifecycle.ts`
- `apps/desktop/src/main/index.ts`
- `.superpowers/sdd/task-3-report.md`

## Remaining concerns

The focused Bun commands use `--isolate` because these suites contain module-global mocks. Expected negative-path tests emit fixed app-state warnings and one intentional rejected-storage error log while still passing.

The unchanged full `service-manager.test.ts` suite retains two previously documented five-second asynchronous timeouts. The two Task 3 session-only metadata regressions in that file pass independently; no claim is made that the unrelated timeout cases were repaired by this task.
