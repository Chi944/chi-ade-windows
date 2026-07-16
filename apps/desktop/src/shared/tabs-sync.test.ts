import { describe, expect, test } from "bun:test";
import type {
	AppStateSyncEnvelope,
	TabsState,
} from "../main/lib/app-state/schemas";
import {
	compareWorkspaceClocks,
	hashTabsState,
	planTabsMerge,
	seedWorkspaceClocks,
	stampLocalTabsMutation,
} from "./tabs-sync";

const metadata = (repository: string) => ({
	repository,
	branch: "main",
	type: "branch" as const,
});

function tabsState(workspaceId: string, label: string): TabsState {
	return {
		tabs: [
			{
				id: `${label}-tab`,
				name: label,
				workspaceId,
				createdAt: 1,
				layout: `${label}-pane`,
			},
		],
		panes: {
			[`${label}-pane`]: {
				id: `${label}-pane`,
				tabId: `${label}-tab`,
				type: "terminal",
				name: label,
				agentRuntime: "claude",
			},
		},
		activeTabIds: { [workspaceId]: `${label}-tab` },
		focusedPaneIds: { [`${label}-tab`]: `${label}-pane` },
		tabHistoryStacks: { [workspaceId]: [] },
	};
}

function combineTabs(...states: TabsState[]): TabsState {
	return {
		tabs: states.flatMap((state) => state.tabs),
		panes: Object.assign({}, ...states.map((state) => state.panes)),
		activeTabIds: Object.assign(
			{},
			...states.map((state) => state.activeTabIds),
		),
		focusedPaneIds: Object.assign(
			{},
			...states.map((state) => state.focusedPaneIds),
		),
		tabHistoryStacks: Object.assign(
			{},
			...states.map((state) => state.tabHistoryStacks),
		),
	};
}

function emptyTabs(): TabsState {
	return {
		tabs: [],
		panes: {},
		activeTabIds: {},
		focusedPaneIds: {},
		tabHistoryStacks: {},
	};
}

function envelope(
	deviceId: string,
	options: Partial<AppStateSyncEnvelope> = {},
): AppStateSyncEnvelope {
	return {
		deviceId,
		lastWrittenAt: 0,
		perWorkspaceWrittenAt: {},
		workspaceMetadata: {},
		localToCanonical: {},
		paneClaudeSessions: {},
		workspaceTombstones: {},
		...options,
	};
}

function singleWorkspacePlan(options?: {
	localClock?: { deviceId: string; at: number };
	peerClock?: { deviceId: string; at: number };
	canonicalToLocal?: Record<string, string>;
}) {
	return planTabsMerge({
		localTabs: tabsState("local-workspace", "local"),
		localEnvelope: envelope("local-device", {
			perWorkspaceWrittenAt: options?.localClock
				? { canonical: options.localClock }
				: {},
			workspaceMetadata: { canonical: metadata("example.com/acme/repo") },
			localToCanonical: { "local-workspace": "canonical" },
		}),
		peerTabs: tabsState("peer-workspace", "peer"),
		peerEnvelope: envelope("peer-device", {
			perWorkspaceWrittenAt: options?.peerClock
				? { canonical: options.peerClock }
				: {},
			workspaceMetadata: { canonical: metadata("example.com/acme/repo") },
			localToCanonical: { "peer-workspace": "canonical" },
		}),
		canonicalToLocal: options?.canonicalToLocal ?? {
			canonical: "local-workspace",
		},
	});
}

describe("deterministic workspace clocks", () => {
	test("seeds effective clocks from a hydrated local envelope after restart", () => {
		const seeded = seedWorkspaceClocks(
			envelope("local", {
				perWorkspaceWrittenAt: {
					active: { deviceId: "device-a", at: 10 },
				},
				workspaceTombstones: {
					deleted: { deviceId: "device-b", at: 12 },
				},
			}),
		);

		expect(seeded).toEqual({
			clocks: {
				active: { deviceId: "device-a", at: 10 },
				deleted: { deviceId: "device-b", at: 12 },
			},
			warnings: [],
		});
	});

	test("compares equal timestamps by lexicographic device id", () => {
		expect(
			compareWorkspaceClocks(
				{ deviceId: "device-b", at: 10 },
				{ deviceId: "device-a", at: 10 },
			),
		).toBeGreaterThan(0);
		expect(
			compareWorkspaceClocks(
				{ deviceId: "device-a", at: 10 },
				{ deviceId: "device-b", at: 10 },
			),
		).toBeLessThan(0);
	});

	test("keeps newer local state over an older peer", () => {
		const result = singleWorkspacePlan({
			localClock: { deviceId: "local-device", at: 20 },
			peerClock: { deviceId: "peer-device", at: 10 },
		});

		expect(result.winningCanonicalIds).toEqual([]);
		expect(result.tabsState.tabs[0]?.name).toBe("local");
	});

	test("adopts a newer peer and applies the device-id tie break", () => {
		const newer = singleWorkspacePlan({
			localClock: { deviceId: "local-device", at: 10 },
			peerClock: { deviceId: "peer-device", at: 20 },
		});
		const tie = singleWorkspacePlan({
			localClock: { deviceId: "device-a", at: 20 },
			peerClock: { deviceId: "device-z", at: 20 },
		});

		expect(newer.tabsState.tabs[0]?.name).toBe("peer");
		expect(tie.tabsState.tabs[0]?.name).toBe("peer");
	});

	test("merges unrelated workspaces additively", () => {
		const result = planTabsMerge({
			localTabs: tabsState("local-a", "local-a"),
			localEnvelope: envelope("local", {
				perWorkspaceWrittenAt: { a: { deviceId: "local", at: 5 } },
				workspaceMetadata: { a: metadata("example.com/acme/a") },
				localToCanonical: { "local-a": "a" },
			}),
			peerTabs: tabsState("peer-b", "peer-b"),
			peerEnvelope: envelope("peer", {
				perWorkspaceWrittenAt: { b: { deviceId: "peer", at: 6 } },
				workspaceMetadata: { b: metadata("example.com/acme/b") },
				localToCanonical: { "peer-b": "b" },
			}),
			canonicalToLocal: { b: "local-b" },
		});

		expect(result.tabsState.tabs.map((tab) => tab.workspaceId)).toEqual([
			"local-a",
			"local-b",
		]);
	});

	test("skips unresolved canonical identities and accepts remote workspace mappings", () => {
		const unresolved = singleWorkspacePlan({
			peerClock: { deviceId: "peer", at: 5 },
			canonicalToLocal: {},
		});
		const remote = singleWorkspacePlan({
			peerClock: { deviceId: "peer", at: 5 },
			canonicalToLocal: { canonical: "remote-workspace" },
		});

		expect(unresolved.winningCanonicalIds).toEqual([]);
		expect(unresolved.warnings).toContain(
			"A peer workspace could not be resolved on this device.",
		);
		expect(remote.tabsState.tabs.map((tab) => tab.workspaceId)).toContain(
			"remote-workspace",
		);
	});

	test("ignores empty or malformed peer stamps with a bounded warning", () => {
		const noStamp = singleWorkspacePlan();
		const malformedEnvelope = envelope("peer", {
			perWorkspaceWrittenAt: {
				canonical: { deviceId: "", at: Number.NaN },
			},
			workspaceMetadata: { canonical: metadata("example.com/acme/repo") },
			localToCanonical: { "peer-workspace": "canonical" },
		});
		const malformed = planTabsMerge({
			localTabs: tabsState("local-workspace", "local"),
			localEnvelope: envelope("local"),
			peerTabs: tabsState("peer-workspace", "peer"),
			peerEnvelope: malformedEnvelope,
			canonicalToLocal: { canonical: "local-workspace" },
		});

		expect(noStamp.winningCanonicalIds).toEqual([]);
		expect(malformed.winningCanonicalIds).toEqual([]);
		expect(malformed.warnings).toContain(
			"A peer workspace clock was invalid and was ignored.",
		);
	});

	test("uses a monotonic timestamp when the wall clock moves backward", () => {
		const result = stampLocalTabsMutation({
			previousTabs: tabsState("local", "before"),
			nextTabs: tabsState("local", "after"),
			envelope: envelope("local-device", {
				lastWrittenAt: 1_000,
				perWorkspaceWrittenAt: {
					canonical: { deviceId: "local-device", at: 1_000 },
				},
			}),
			identities: {
				local: {
					status: "verified",
					canonical: "canonical",
					metadata: metadata("example.com/acme/repo"),
				},
			},
			deviceId: "local-device",
			now: 5,
			paneClaudeSessions: {},
		});

		expect(result.envelope.lastWrittenAt).toBe(1_001);
		expect(result.envelope.perWorkspaceWrittenAt.canonical.at).toBe(1_001);
	});

	test("stamps only changed workspaces", () => {
		const previous = combineTabs(
			tabsState("workspace-a", "a-before"),
			tabsState("workspace-b", "b"),
		);
		const next = combineTabs(
			tabsState("workspace-a", "a-after"),
			tabsState("workspace-b", "b"),
		);
		const result = stampLocalTabsMutation({
			previousTabs: previous,
			nextTabs: next,
			envelope: envelope("local", {
				perWorkspaceWrittenAt: {
					a: { deviceId: "local", at: 10 },
					b: { deviceId: "local", at: 20 },
				},
			}),
			identities: {
				"workspace-a": {
					status: "verified",
					canonical: "a",
					metadata: metadata("example.com/acme/a"),
				},
				"workspace-b": {
					status: "verified",
					canonical: "b",
					metadata: metadata("example.com/acme/b"),
				},
			},
			deviceId: "local",
			now: 30,
			paneClaudeSessions: {},
		});

		expect(result.changedCanonicalIds).toEqual(["a"]);
		expect(result.envelope.perWorkspaceWrittenAt.a.at).toBe(30);
		expect(result.envelope.perWorkspaceWrittenAt.b.at).toBe(20);
	});

	test("stamps the owning workspace when only its Claude session handoff changes", () => {
		const tabs = tabsState("local-workspace", "local");
		const result = stampLocalTabsMutation({
			previousTabs: tabs,
			nextTabs: structuredClone(tabs),
			envelope: envelope("local", {
				perWorkspaceWrittenAt: {
					canonical: { deviceId: "local", at: 10 },
				},
				localToCanonical: { "local-workspace": "canonical" },
				paneClaudeSessions: { "local-pane": "session-before" },
			}),
			identities: {
				"local-workspace": {
					status: "verified",
					canonical: "canonical",
					metadata: metadata("example.com/acme/repo"),
				},
			},
			deviceId: "local",
			now: 20,
			paneClaudeSessions: { "local-pane": "session-after" },
		});

		expect(result.changedCanonicalIds).toEqual(["canonical"]);
		expect(result.envelope.perWorkspaceWrittenAt.canonical.at).toBe(20);
		expect(result.envelope.paneClaudeSessions).toEqual({
			"local-pane": "session-after",
		});
	});

	test("invalidates a persisted mapping when an active identity becomes ambiguous", () => {
		const result = stampLocalTabsMutation({
			previousTabs: tabsState("local-workspace", "before"),
			nextTabs: tabsState("local-workspace", "after"),
			envelope: envelope("local", {
				perWorkspaceWrittenAt: {
					canonical: { deviceId: "local", at: 10 },
				},
				workspaceMetadata: {
					canonical: metadata("example.com/acme/repo"),
				},
				localToCanonical: { "local-workspace": "canonical" },
			}),
			identities: {
				"local-workspace": { status: "ambiguous" },
			},
			deviceId: "local",
			now: 20,
			paneClaudeSessions: {},
		});

		expect(result.changedCanonicalIds).toEqual([]);
		expect(result.envelope.localToCanonical["local-workspace"]).toBeUndefined();
		expect(result.envelope.perWorkspaceWrittenAt.canonical).toBeUndefined();
		expect(result.warnings).toContain(
			"A local workspace was not synchronized because its identity is ambiguous.",
		);
	});

	test("preserves an unchanged mapping across a transient origin read failure", () => {
		const workspaceA = tabsState("workspace-a", "a");
		const previous = combineTabs(
			workspaceA,
			tabsState("workspace-b", "b-before"),
		);
		const next = combineTabs(
			structuredClone(workspaceA),
			tabsState("workspace-b", "b-after"),
		);
		const result = stampLocalTabsMutation({
			previousTabs: previous,
			nextTabs: next,
			envelope: envelope("local", {
				perWorkspaceWrittenAt: {
					a: { deviceId: "local", at: 10 },
					b: { deviceId: "local", at: 10 },
				},
				workspaceMetadata: {
					a: metadata("example.com/acme/a"),
					b: metadata("example.com/acme/b"),
				},
				localToCanonical: { "workspace-a": "a", "workspace-b": "b" },
			}),
			identities: {
				"workspace-a": { status: "unresolved" },
				"workspace-b": {
					status: "verified",
					canonical: "b",
					metadata: metadata("example.com/acme/b"),
				},
			},
			deviceId: "local",
			now: 20,
			paneClaudeSessions: {},
		});

		expect(result.changedCanonicalIds).toEqual(["b"]);
		expect(result.envelope.localToCanonical["workspace-a"]).toBe("a");
		expect(result.envelope.perWorkspaceWrittenAt.a).toEqual({
			deviceId: "local",
			at: 10,
		});
	});

	test("invalidates an unchanged verified mapping when its canonical changes", () => {
		const workspaceA = tabsState("workspace-a", "a");
		const previous = combineTabs(
			workspaceA,
			tabsState("workspace-b", "b-before"),
		);
		const next = combineTabs(
			structuredClone(workspaceA),
			tabsState("workspace-b", "b-after"),
		);
		const result = stampLocalTabsMutation({
			previousTabs: previous,
			nextTabs: next,
			envelope: envelope("local", {
				perWorkspaceWrittenAt: {
					"a-old": { deviceId: "local", at: 10 },
					b: { deviceId: "local", at: 10 },
				},
				workspaceMetadata: {
					"a-old": metadata("example.com/acme/a-old"),
					b: metadata("example.com/acme/b"),
				},
				localToCanonical: {
					"workspace-a": "a-old",
					"workspace-b": "b",
				},
			}),
			identities: {
				"workspace-a": {
					status: "verified",
					canonical: "a-new",
					metadata: metadata("example.com/acme/a-new"),
				},
				"workspace-b": {
					status: "verified",
					canonical: "b",
					metadata: metadata("example.com/acme/b"),
				},
			},
			deviceId: "local",
			now: 20,
			paneClaudeSessions: {},
		});

		expect(result.changedCanonicalIds).toEqual(["b"]);
		expect(result.envelope.localToCanonical["workspace-a"]).toBeUndefined();
		expect(result.envelope.perWorkspaceWrittenAt["a-old"]).toBeUndefined();
	});

	test("rejects canonical-to-local collisions", () => {
		const peer = combineTabs(
			tabsState("peer-a", "peer-a"),
			tabsState("peer-b", "peer-b"),
		);
		const result = planTabsMerge({
			localTabs: emptyTabs(),
			localEnvelope: envelope("local"),
			peerTabs: peer,
			peerEnvelope: envelope("peer", {
				perWorkspaceWrittenAt: {
					a: { deviceId: "peer", at: 1 },
					b: { deviceId: "peer", at: 1 },
				},
				workspaceMetadata: {
					a: metadata("example.com/acme/a"),
					b: metadata("example.com/acme/b"),
				},
				localToCanonical: { "peer-a": "a", "peer-b": "b" },
			}),
			canonicalToLocal: { a: "same-local", b: "same-local" },
		});

		expect(result.winningCanonicalIds).toEqual([]);
		expect(result.rejectedCanonicalIds).toEqual(["a", "b"]);
		expect(result.warnings).toContain(
			"A peer workspace mapping collision was rejected.",
		);
	});

	test("writes deletion tombstones and prevents stale resurrection", () => {
		const stamped = stampLocalTabsMutation({
			previousTabs: tabsState("local-workspace", "local"),
			nextTabs: emptyTabs(),
			envelope: envelope("local", {
				perWorkspaceWrittenAt: {
					canonical: { deviceId: "local", at: 10 },
				},
				localToCanonical: { "local-workspace": "canonical" },
				workspaceMetadata: {
					canonical: metadata("example.com/acme/repo"),
				},
			}),
			identities: {
				"local-workspace": { status: "deleted" },
			},
			deviceId: "local",
			now: 20,
			paneClaudeSessions: {},
		});
		expect(stamped.envelope.workspaceTombstones.canonical).toEqual({
			deviceId: "local",
			at: 20,
		});

		const stalePeer = planTabsMerge({
			localTabs: emptyTabs(),
			localEnvelope: stamped.envelope,
			peerTabs: tabsState("peer-workspace", "stale"),
			peerEnvelope: envelope("peer", {
				perWorkspaceWrittenAt: {
					canonical: { deviceId: "peer", at: 15 },
				},
				workspaceMetadata: {
					canonical: metadata("example.com/acme/repo"),
				},
				localToCanonical: { "peer-workspace": "canonical" },
			}),
			canonicalToLocal: { canonical: "local-workspace" },
		});

		expect(stalePeer.tabsState.tabs).toEqual([]);
		expect(stalePeer.winningCanonicalIds).toEqual([]);
	});

	test("does not use a tombstone fallback for an unproven deletion", () => {
		const stamped = stampLocalTabsMutation({
			previousTabs: tabsState("local-workspace", "local"),
			nextTabs: emptyTabs(),
			envelope: envelope("local", {
				perWorkspaceWrittenAt: {
					canonical: { deviceId: "local", at: 10 },
				},
				localToCanonical: { "local-workspace": "canonical" },
				workspaceMetadata: {
					canonical: metadata("example.com/acme/repo"),
				},
			}),
			identities: {
				"local-workspace": { status: "missing" },
			},
			deviceId: "local",
			now: 20,
			paneClaudeSessions: {},
		});

		expect(stamped.changedCanonicalIds).toEqual([]);
		expect(stamped.envelope.workspaceTombstones.canonical).toBeUndefined();
		expect(
			stamped.envelope.localToCanonical["local-workspace"],
		).toBeUndefined();
	});

	test("applies a newer peer deletion tombstone", () => {
		const result = planTabsMerge({
			localTabs: tabsState("local-workspace", "local"),
			localEnvelope: envelope("local", {
				perWorkspaceWrittenAt: {
					canonical: { deviceId: "local", at: 10 },
				},
				localToCanonical: { "local-workspace": "canonical" },
			}),
			peerTabs: emptyTabs(),
			peerEnvelope: envelope("peer", {
				workspaceTombstones: {
					canonical: { deviceId: "peer", at: 20 },
				},
				workspaceMetadata: {
					canonical: metadata("example.com/acme/repo"),
				},
			}),
			canonicalToLocal: { canonical: "local-workspace" },
		});

		expect(result.tabsState.tabs).toEqual([]);
		expect(result.envelope.workspaceTombstones.canonical.at).toBe(20);
	});

	test("returns peer Claude session handoffs for winning panes", () => {
		const withSession = planTabsMerge({
			localTabs: emptyTabs(),
			localEnvelope: envelope("local"),
			peerTabs: tabsState("peer-workspace", "peer"),
			peerEnvelope: envelope("peer", {
				perWorkspaceWrittenAt: {
					canonical: { deviceId: "peer", at: 10 },
				},
				workspaceMetadata: {
					canonical: metadata("example.com/acme/repo"),
				},
				localToCanonical: { "peer-workspace": "canonical" },
				paneClaudeSessions: { "peer-pane": "session-123" },
			}),
			canonicalToLocal: { canonical: "local-workspace" },
		});

		expect(withSession.peerClaudeSessionHandoffs).toEqual([
			{
				paneId: "peer-pane",
				workspaceId: "local-workspace",
				claudeSessionId: "session-123",
			},
		]);
		expect(withSession.importedPeerPaneIds).toEqual(["peer-pane"]);
	});

	test("rebases a no-winner peer replacement without bumping local clocks", () => {
		const localEnvelope = envelope("local", {
			lastWrittenAt: 50,
			perWorkspaceWrittenAt: {
				canonical: { deviceId: "local", at: 50 },
			},
			workspaceMetadata: { canonical: metadata("example.com/acme/repo") },
			localToCanonical: { "local-workspace": "canonical" },
		});
		const result = planTabsMerge({
			localTabs: tabsState("local-workspace", "local"),
			localEnvelope,
			peerTabs: tabsState("peer-workspace", "peer"),
			peerEnvelope: envelope("peer", {
				perWorkspaceWrittenAt: {
					canonical: { deviceId: "peer", at: 40 },
				},
				localToCanonical: { "peer-workspace": "canonical" },
			}),
			canonicalToLocal: { canonical: "local-workspace" },
		});

		expect(result.winningCanonicalIds).toEqual([]);
		expect(result.envelope).toEqual(localEnvelope);
	});

	test("hashes the exact tabs snapshot deterministically", () => {
		const first = tabsState("workspace", "one");
		const reorderedRecords: TabsState = {
			...first,
			activeTabIds: { workspace: "one-tab" },
			panes: { "one-pane": first.panes["one-pane"] },
		};
		const changed = structuredClone(first);
		changed.tabs[0].name = "changed";

		expect(hashTabsState(reorderedRecords)).toBe(hashTabsState(first));
		expect(hashTabsState(changed)).not.toBe(hashTabsState(first));
	});
});
