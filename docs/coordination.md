# Coordination and bounded context

ADE coordinates agents through explicit project data rather than provider session internals. Claude, Codex, OpenCode, and other terminal agents keep their own authentication and native session IDs.

## What is shared

- Targeted handoffs and project broadcasts
- Decisions, artifact references, and ordinary messages
- Per-recipient acknowledgement state
- Stable project or workspace memory chosen by an agent or user
- A deterministic Markdown resume packet, capped at 1,200 estimated tokens by default

Raw chat transcripts, provider credentials, provider session IDs, and private keys are not copied into shared memory.

To keep storage bounded, message content is capped at 32 KiB, memory content at 64 KiB, and each project at 1,000 messages and 512 memory entries. Messages older than 90 days are pruned when a new handoff is sent. Stable facts should live in shared memory rather than an unbounded task log.

## Terminal command

ADE creates `ade-coord` in its small generated bin directory and injects a workspace-scoped capability into each ADE terminal. The capability can access only workspace coordination routes; the privileged autonomous-invocation token is never exposed to terminals.

```text
ade-coord peers
ade-coord inbox [--all]
ade-coord send <workspace-id|all> <message> [--kind=handoff|decision|artifact|message]
ade-coord ack <message-id>
ade-coord remember <key> <content> [--workspace]
ade-coord context [objective]
```

For useful handoffs, include the outcome, relevant files, verification commands/results, blockers, and the next action. Use shared memory for stable facts and decisions, not task logs.

## Security boundary

The loopback server rejects browser-origin requests. Lifecycle hooks and coordination requests require an HMAC-derived workspace capability; autonomous agent invocation requires a separate owner-only secret stored under `~/.ade` with restrictive permissions where the filesystem supports them.

Project routing is verified in the main process. A workspace cannot address a recipient or read memory from another project.

## Context-saving policy

The packet builder normalizes and deduplicates structured fields, places next steps and decisions ahead of background memory, estimates tokens without shipping a model tokenizer, safely truncates at a hard limit, and reports an estimated counterfactual against the selected raw messages and memory.

ADE uses one compact policy for minimal code and concise handoffs. The full memory-maintenance manual remains on disk and loads only when needed. Lossy screenshot/image encoding of prompts is intentionally not enabled by default because exact paths, identifiers, patches, approvals, and secrets must remain text.
