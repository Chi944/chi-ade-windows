import { describe, expect, it } from "bun:test";
import { summarizeProviderBindingHealth } from "./provider-binding-health";

describe("provider binding health", () => {
	it("counts real device-local bindings and reports missing or deferred work", async () => {
		const result = await summarizeProviderBindingHealth({
			accountCount: 3,
			panes: [
				{
					id: "bound-pane",
					provider: "claude",
					workspaceId: "workspace-1",
					pinned: true,
					needsRebind: false,
					remote: false,
				},
				{
					id: "missing-pane",
					provider: "codex",
					workspaceId: "workspace-2",
					pinned: true,
					needsRebind: false,
					remote: false,
				},
				{
					id: "unpinned-pane",
					provider: "claude",
					workspaceId: "workspace-3",
					pinned: false,
					needsRebind: false,
					remote: false,
				},
				{
					id: "remote-pane",
					provider: "codex",
					workspaceId: "workspace-4",
					pinned: true,
					needsRebind: false,
					remote: true,
				},
			],
			reconciliation: {
				status: "completed",
				result: { preservedUnresolvedBindings: 2 },
			},
			readBinding: async ({ paneId }) => paneId === "bound-pane",
		});

		expect(result).toEqual({
			available: true,
			accountCount: 3,
			bindingCount: 1,
			unboundPaneCount: 1,
			deferredCleanupCount: 2,
		});
	});

	it("treats explicit rebind markers and missing workspace identity as unhealthy", async () => {
		let lookupCount = 0;
		const result = await summarizeProviderBindingHealth({
			accountCount: 1,
			panes: [
				{
					id: "marked-pane",
					provider: "claude",
					workspaceId: "workspace-1",
					pinned: true,
					needsRebind: true,
					remote: false,
				},
				{
					id: "unresolved-pane",
					provider: "codex",
					pinned: true,
					needsRebind: false,
					remote: false,
				},
			],
			reconciliation: {
				status: "completed",
				result: { preservedUnresolvedBindings: 0 },
			},
			readBinding: async () => {
				lookupCount += 1;
				return true;
			},
		});

		expect(result.bindingCount).toBe(1);
		expect(result.unboundPaneCount).toBe(2);
		expect(result.deferredCleanupCount).toBe(1);
		expect(lookupCount).toBe(1);
	});

	it("warns conservatively when startup reconciliation did not complete", async () => {
		for (const reconciliation of [
			undefined,
			{ status: "deferred" as const },
			{ status: "failed" as const },
			{ status: "completed" as const, result: {} },
		]) {
			const result = await summarizeProviderBindingHealth({
				accountCount: 0,
				panes: [],
				reconciliation,
				readBinding: async () => false,
			});
			expect(result.deferredCleanupCount).toBe(1);
		}
	});
});
