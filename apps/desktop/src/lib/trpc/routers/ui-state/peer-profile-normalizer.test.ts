import { describe, expect, test } from "bun:test";
import type { TabsState } from "main/lib/app-state/schemas";
import { sanitizeSubscriptionProfilesForPersistence } from "shared/subscription-profile-rebind";

const NAMED_PROFILE_ID = "11111111-1111-4111-8111-111111111111";

function createTabsState(): TabsState {
	return {
		tabs: [
			{
				id: "local-tab",
				name: "Local",
				workspaceId: "local-workspace",
				createdAt: 1,
			},
			{
				id: "remote-tab",
				name: "Remote",
				workspaceId: "remote-workspace",
				createdAt: 2,
			},
		],
		panes: {
			"named-pane": {
				id: "named-pane",
				tabId: "local-tab",
				type: "terminal",
				name: "Claude",
				agentRuntime: "claude",
				subscriptionProfileId: NAMED_PROFILE_ID,
			},
			"system-pane": {
				id: "system-pane",
				tabId: "local-tab",
				type: "terminal",
				name: "Codex",
				agentRuntime: "codex",
				subscriptionProfileId: null,
			},
			"default-claude-pane": {
				id: "default-claude-pane",
				tabId: "local-tab",
				type: "terminal",
				name: "Claude default",
				agentRuntime: "claude",
			},
			"default-codex-pane": {
				id: "default-codex-pane",
				tabId: "local-tab",
				type: "terminal",
				name: "Codex default",
				agentRuntime: "codex",
			},
			"shell-pane": {
				id: "shell-pane",
				tabId: "local-tab",
				type: "terminal",
				name: "Shell",
			},
			"remote-pane": {
				id: "remote-pane",
				tabId: "remote-tab",
				type: "terminal",
				name: "Claude over SSH",
				agentRuntime: "claude",
				subscriptionProfileId: NAMED_PROFILE_ID,
				subscriptionProfilePinned: true,
			},
		},
		activeTabIds: {
			"local-workspace": "local-tab",
			"remote-workspace": "remote-tab",
		},
		focusedPaneIds: {
			"local-tab": "named-pane",
			"remote-tab": "remote-pane",
		},
		tabHistoryStacks: {},
	};
}

describe("sanitizeSubscriptionProfilesForPersistence", () => {
	test("strips named UUIDs and persists only a portable pinned marker", () => {
		const source = createTabsState();
		const result = sanitizeSubscriptionProfilesForPersistence({
			state: source,
			remoteWorkspaceIds: new Set(["remote-workspace"]),
			localWorkspaceIds: new Set(["local-workspace"]),
		});

		expect(result).not.toBe(source);
		expect(result.panes["named-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: true,
		});
		expect(source.panes["named-pane"].subscriptionProfileId).toBe(
			NAMED_PROFILE_ID,
		);
		expect(JSON.stringify(result)).not.toContain(NAMED_PROFILE_ID);
	});

	test("persists explicit System selection with the same portable marker", () => {
		const result = sanitizeSubscriptionProfilesForPersistence({
			state: createTabsState(),
			remoteWorkspaceIds: new Set(["remote-workspace"]),
			localWorkspaceIds: new Set(["local-workspace"]),
		});

		expect(result.panes["system-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: true,
		});
	});

	test("marks every local Claude or Codex terminal at persistence", () => {
		const source = createTabsState();
		delete source.panes["named-pane"];
		delete source.panes["system-pane"];
		delete source.panes["remote-pane"];

		const result = sanitizeSubscriptionProfilesForPersistence({
			state: source,
			remoteWorkspaceIds: new Set(["remote-workspace"]),
			localWorkspaceIds: new Set(["local-workspace"]),
		});

		expect(result).not.toBe(source);
		expect(result.panes["default-claude-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: true,
		});
		expect(result.panes["default-codex-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: true,
		});
		expect(
			result.panes["shell-pane"].subscriptionProfilePinned,
		).toBeUndefined();
		expect(
			source.panes["default-claude-pane"].subscriptionProfilePinned,
		).toBeUndefined();
	});

	test("does not infer a marker without local versus remote classification", () => {
		const source = createTabsState();
		delete source.panes["named-pane"];
		delete source.panes["system-pane"];
		delete source.panes["remote-pane"];

		const result = sanitizeSubscriptionProfilesForPersistence({
			state: source,
		});

		expect(result).toBe(source);
		expect(
			result.panes["default-claude-pane"].subscriptionProfilePinned,
		).toBeUndefined();
	});

	test("retains a portable marker when stripping an unclassified explicit choice", () => {
		const source = createTabsState();
		delete source.panes["system-pane"];
		delete source.panes["default-claude-pane"];
		delete source.panes["default-codex-pane"];
		delete source.panes["shell-pane"];
		delete source.panes["remote-pane"];

		const result = sanitizeSubscriptionProfilesForPersistence({
			state: source,
		});

		expect(result.panes["named-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: true,
		});
	});

	test("clears subscription data from a non-provider terminal", () => {
		const source = createTabsState();
		source.panes["shell-pane"] = {
			...source.panes["shell-pane"],
			subscriptionProfileId: NAMED_PROFILE_ID,
			subscriptionProfilePinned: true,
		};

		const result = sanitizeSubscriptionProfilesForPersistence({
			state: source,
		});

		expect(result.panes["shell-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: undefined,
			subscriptionProfileNeedsRebind: undefined,
		});
	});

	test("migrates the legacy rebind flag to the portable marker", () => {
		const source = createTabsState();
		source.panes["named-pane"] = {
			...source.panes["named-pane"],
			subscriptionProfileId: undefined,
			subscriptionProfileNeedsRebind: true,
		};

		const result = sanitizeSubscriptionProfilesForPersistence({
			state: source,
		});

		expect(result.panes["named-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: true,
			subscriptionProfileNeedsRebind: undefined,
		});
	});

	test("clears all subscription markers and IDs from remote panes", () => {
		const result = sanitizeSubscriptionProfilesForPersistence({
			state: createTabsState(),
			remoteWorkspaceIds: new Set(["remote-workspace"]),
		});

		expect(result.panes["remote-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: undefined,
			subscriptionProfileNeedsRebind: undefined,
		});
	});

	test("clears a marker-only restored pane when its workspace is remote", () => {
		const source = createTabsState();
		source.panes["remote-pane"] = {
			...source.panes["remote-pane"],
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: true,
		};

		const result = sanitizeSubscriptionProfilesForPersistence({
			state: source,
			remoteWorkspaceIds: new Set(["remote-workspace"]),
		});

		expect(
			result.panes["remote-pane"].subscriptionProfilePinned,
		).toBeUndefined();
	});

	test("does not mark a pane whose peer workspace classification is unresolved", () => {
		const source = createTabsState();
		source.panes["default-claude-pane"] = {
			...source.panes["default-claude-pane"],
			subscriptionProfilePinned: true,
		};

		const result = sanitizeSubscriptionProfilesForPersistence({
			state: source,
			remoteWorkspaceIds: new Set(["known-peer-remote-workspace"]),
		});

		expect(result.panes["default-claude-pane"]).toMatchObject({
			subscriptionProfileId: undefined,
			subscriptionProfilePinned: undefined,
			subscriptionProfileNeedsRebind: undefined,
		});
	});
});
