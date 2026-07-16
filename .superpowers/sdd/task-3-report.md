# Task 3 report: make peer synchronization deterministic and restart-safe

## Outcome

Implemented a main-process-owned peer tab synchronization protocol that is deterministic across restarts, serialized with every other durable app-state mutation, and safe against stale, duplicate, concurrent, and reconnecting renderer requests. Peer snapshots are validated and cached behind opaque event IDs; the renderer resolves only requested portable workspace identities; main revalidates those mappings and commits the merge before Zustand is updated.

Workspace clocks are now seeded from the durable envelope, updated only for changed workspaces, and ordered by timestamp plus device ID. Portable identities contain only normalized Git repository identity, branch, and workspace type. Deletion tombstones prevent stale resurrection, no-winner peer replacements are still rebased to a local-authored snapshot, and exact suppression tokens prevent the committed peer snapshot from echoing back as a local write.

Startup and reconnect handling are covered end to end. The parent directory watcher survives atomic file replacement and ingests an already-present peer file, cached metadata is replayed after subscription attachment without attach-race duplication, trusted startup localizes peer workspace IDs before reconciliation, and peer Claude sessions are staged once without auto-submitting the resume command.

## Implementation summary

- Replaced path-derived workspace identity with credential-free normalization for HTTPS, SCP-style SSH, and `ssh://` origins. Unsupported `scheme://` remotes are rejected before SCP parsing, so credentials cannot enter portable metadata. Reverse identity resolution is batched and explicit about verified, missing, ambiguous, deleted, and unreadable workspaces; unsafe persisted mappings and clocks are invalidated, while tombstone fallback is limited to proven deletions.
- Added pure tabs synchronization logic for clock comparison, restart seeding, monotonic local stamps, exact workspace change detection, canonical collision rejection, peer/local translation, deletion tombstones, deterministic snapshot hashing, and peer Claude session handoff extraction.
- Extended the durable sync envelope with portable metadata and workspace tombstones while dropping legacy path metadata during normalization.
- Made the app-state watcher observe the containing directory, debounce rename/change events, wait for the named file to stabilize, ingest the file at startup, and store validated defensive snapshots in a bounded expiring cache. Subscriptions expose only opaque metadata and attach before cache enumeration, so startup and reconnect replay cannot lose an event or duplicate an attach race.
- Closed the watcher-to-writer overwrite window with immediate best-effort reads on every target event plus a fail-closed, no-clobber promotion protocol for every coordinator, first-run, and recovery write. A same-directory fsynced temporary is promoted only by hard-linking it into an empty target; each existing target is first atomically displaced, read and validated immediately from that immutable path without waiting behind a stable-target read, and either cached or restored/preserved before any failure is returned. A peer that lands during promotion wins the target and forces a bounded retry, retry exhaustion leaves the final peer target intact, and unavailable hard links fail closed with recovery bytes preserved. Displaced siblings are excluded from synchronization. Validated, sanitized peer snapshots are deduplicated by canonical content identity under the existing cache TTL/capacity, while duplicate filesystem notifications retain the first opaque event metadata. Local-authored captures remain ignored.
- Added a queued `sync.rebasePeerUpdate` service. It re-fetches cached peer state, verifies renderer mappings before and inside the coordinator transaction, plans against the queued current snapshot, persists session handoffs and app state before acknowledging, returns `stale` for revision movement, and maps failed commits to a closed rejection contract.
- Added bounded idempotency for processed events and a true in-flight join keyed by event ID plus mapping fingerprint. Simultaneous identical requests share one promise, token, and durable write; conflicting duplicates are rejected. A later replay returns the coordinator's current snapshot and revision with a fresh exact-snapshot suppression token. Peer metadata now carries only merge-relevant clock/tombstone IDs, with a shared 10,000-ID schema/router bound derived from the two independently bounded records.
- Refactored the renderer consumer into one sequential queue. Stale events replan at the returned revision, rejected acknowledgements remain visibly retryable, and Zustand changes only after main reports a durable commit. A local persistence epoch and pending-write drain detect mutations begun during the peer round trip; the consumer replays the processed event and acknowledges/applies only an epoch-stable current snapshot. Renderer persistence sends workspace deltas, so main overlays a queued local change onto its latest peer commit instead of replacing unrelated peer work.
- Added exact peer-pane provenance to each committed merge. The processed-event cache retains the original imported pane IDs and intersects them with the current main snapshot on replay; the renderer marks those surviving IDs independently of workspace winners, so a peer Claude resume stays staged without Enter even when an unrelated local write forces drain/replay.
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

The final reliability review added four more RED groups before this follow-up was frozen:

- Credential-bearing `http://`, `git://`, and `ftp://` origins were misread as SCP syntax. They now remain unresolved and their secrets never appear in serialized identity results.
- A persisted local-to-canonical mapping could outlive a newly ambiguous or unreadable identity. Active writes now use one fresh batch resolution, invalidate changed unreadable mappings, retain fallback only for a proven deletion, and clear an unchanged checkout's mapping when a new duplicate or verified canonical change makes the old identity stale. An unchanged transient origin-read failure preserves its existing clock until verification can recover.
- A schema-valid event with 1,001 clock/tombstone IDs could be emitted but was rejected by the 1,000-ID router cap, producing a futile retry loop. Watcher, router, renderer, and service regressions now prove the event reaches a committed no-winner result in one pass.
- A local Zustand write queued behind a peer commit could make renderer and main diverge or replace the peer change. Epoch/pending tracking now drains and replays the processed event; the workspace-delta route regression proves both unrelated changes survive, the peer clock remains intact, only the final token/snapshot is applied, and the suppressed apply does not echo.

The final release verdict added two last RED groups before the snapshot was frozen again:

- A peer atomic replacement followed immediately by a local tabs/theme write was overwritten before the watcher's debounce fired. The repeated-swap regression received no peer events on the old code. Immediate event capture plus the writer's exact displaced-file capture now preserve two distinct peer replacements exactly once despite duplicate rename/change notifications. Focused regressions also prove immutable displaced capture bypasses an in-flight stable read of the now-missing target, along with strict null/malformed/uninitialized rejection, peer arrival after displacement, peer arrival while the target was initially absent, bounded retry exhaustion, hook failure, unavailable hard links, temporary cleanup, and preservation or no-clobber restoration of every uncaptured target.
- A processed replay after an unrelated local persistence drain returned the combined current tabs state but lost peer-pane provenance when workspace winners were cleared. The integrated renderer RED preserved both workspace slices and the final token yet produced a Claude resume ending in carriage return. Merge results now carry exact imported pane IDs, processed replay filters the original IDs against current panes, and the final applied result stages the peer resume with no CR or LF.
- Initialization originally had no coordinator revision for a peer captured during first-run or recovery promotion, so strict capture threw instead of caching the snapshot. The first-run no-target race now proves a peer winner is atomically displaced, cached at base revision zero, and replayable after initialization while local defaults promote safely.
- Recovery originally moved whichever file occupied the target directly into quarantine based on an earlier invalid read. A valid peer replacement could therefore be mislabeled as damaged and silently replaced with defaults. Recovery now re-reads the exact atomically moved candidate: an invalid candidate remains the reported quarantine, while a newly valid candidate must pass the normal strict watcher/cache boundary exactly once before no-clobber default promotion and is never reported as damaged quarantine.

## Final verification on the frozen snapshot

```text
bun test --isolate <Task 3 workspace identity, tabs sync, watcher, sync service,
reconciliation, sync router, renderer consumer/storage/registry, UI-state,
app-state initialization/validation/write-queue suites>
151 tests, 481 assertions, 0 failures across 13 files

bun test --isolate <Task 2 validation, write queue, initialization, watcher,
UI-state, and development reset suites>
82 tests, 245 assertions, 0 failures across 7 files

bun test --isolate apps/desktop/src/main/lib/subscription-profile-storage.test.ts
apps/desktop/src/main/lib/subscription-profiles.test.ts
apps/desktop/src/main/lib/sync/sensitive-ignore.test.ts
apps/desktop/src/lib/trpc/routers/ui-state/peer-profile-normalizer.test.ts
apps/desktop/src/lib/trpc/routers/sync/index.test.ts
apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/subscription-profile-rebind.test.ts
88 tests, 331 assertions, 0 failures across 6 files

bun test --isolate apps/desktop/src/main/lib/terminal/service/service-manager.test.ts -t "session-only metadata"
2 tests, 8 assertions, 0 failures (15 unrelated tests filtered out)

bun run --cwd apps/desktop typecheck
route generation and tsc --noEmit completed successfully

bun node_modules/@biomejs/biome/bin/biome check <16 changed TypeScript/TSX files>
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
- `apps/desktop/src/main/lib/sync/sensitive-ignore.ts`
- `apps/desktop/src/main/lib/sync/sensitive-ignore.test.ts`
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
