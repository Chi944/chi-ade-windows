# Security maintenance

ADE uses a frozen dependency install, GitHub vulnerability alerts, dependency review, and a production audit gate. Dependency updates remain owner-operated: only `Chi944` creates, reviews, and merges dependency changes.

## Routine check

Use the repository's pinned Bun version and run:

```powershell
bun install --frozen
bun run audit:production
bunx sherif
bun run typecheck
```

`audit:production` runs `bun audit --production --json` and compares every high or critical finding with `.github/dependency-audit-policy.json`. It also parses `bun.lock`, walks production dependencies from every `apps/*` workspace, and derives which shipping targets can reach each physical package instance. A new advisory, a severity change, dependency-path or target drift, malformed policy data, an expired exception, or an exception whose advisory disappeared fails the gate.

Lower-severity findings remain visible in the deterministic summary. They should be fixed during normal maintenance, but they do not bypass the high/critical gate.

## Temporary exceptions

An exception is a short-lived risk decision, not a permanent suppression. Every entry must specify:

- the exact package, advisory ID, and severity;
- owner `Chi944`;
- an expiry date no more than 30 days away;
- an evidence set binding every affected exact version and lock path to its machine-derived `apps/*` shipping targets;
- a concrete rationale and an HTTPS upstream tracking link.

Each evidence-set SHA-256 is calculated over a deterministic list of package name, exact version, Bun lock path, and the targets that reach that individual path. Counts, exact versions, and the union of targets are checked separately for readable review. The hash therefore cannot continue suppressing an advisory if a new vulnerable path appears, an existing path becomes runtime-reachable, or a target is added.

The current evidence records `minimatch` 3.1.2 as mobile-reachable, 5.1.6 as build/test-only, 9.0.5 as reachable from admin, API, docs, marketing, mobile, and web paths (including the `@sentry/node` runtime path), and 10.1.1 as mobile-reachable. These are temporary, explicitly scoped risk acceptances—not a claim that every copy is build-only. The exceptions expire on 2026-08-15 and must be removed as soon as their parent dependencies accept fixed releases. Safe `minimatch` lines are 3.1.4, 5.1.8, 9.0.7, and 10.2.5 or newer within the same major.

Do not extend an exception automatically. Re-run the dependency trace and packaged-runtime checks, review every changed evidence count and shipping target, record fresh evidence, and keep the new expiry within 30 days. The audit deliberately fails stale entries so fixed advisories are removed from policy.

## Applying an update

1. Create an owner branch from the latest green `main`.
2. Update the direct dependency or the parent that pins the vulnerable transitive version. Avoid a cross-major override unless its upstream compatibility is proven.
3. Regenerate `bun.lock` with Bun 1.3.6.
4. Run the routine check, complete desktop tests, native/migration smoke, and packaged GUI smoke.
5. Confirm the packaged-runtime allowlist and package-footprint checks still pass on Windows and macOS CI.
6. Merge only after every required GitHub check passes on the exact commit.

The monthly security workflow is read-only. It reports failures through its check result and never creates a branch, commit, issue, pull request, or automated security-fix contribution.
