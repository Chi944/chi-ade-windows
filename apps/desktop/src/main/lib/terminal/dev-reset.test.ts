import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AppState,
	createDefaultAppState,
} from "main/lib/app-state/schemas";

const home = await mkdtemp(join(tmpdir(), "ade-dev-reset-"));
let state: AppState = createDefaultAppState("device");
state.tabsState = {
	tabs: [
		{
			id: "tab-1",
			name: "Terminal",
			workspaceId: "workspace-1",
			createdAt: 1,
			layout: "pane-1",
		},
	],
	panes: {
		"pane-1": {
			id: "pane-1",
			tabId: "tab-1",
			type: "terminal",
			name: "Shell",
		},
	},
	activeTabIds: { "workspace-1": "tab-1" },
	focusedPaneIds: { "tab-1": "pane-1" },
	tabHistoryStacks: { "workspace-1": [] },
};
const enqueueAppStateMutation = mock(
	async (label: string, mutate: (draft: AppState) => unknown) => {
		const draft = structuredClone(state);
		await mutate(draft);
		state = draft;
		return { label, revision: 1, result: undefined, state };
	},
);
const shutdownIfRunning = mock(async () => undefined);

mock.module("main/lib/app-environment", () => ({ SUPERSET_HOME_DIR: home }));
mock.module("main/lib/app-state", () => ({
	enqueueAppStateMutation,
	getDeviceId: () => "device",
}));
mock.module("main/lib/terminal-host/client", () => ({
	disposeTerminalHostClient: mock(() => undefined),
	getTerminalHostClient: () => ({ shutdownIfRunning }),
}));

const { resetTerminalStateDev } = await import("./dev-reset");

afterAll(async () => {
	await rm(home, { recursive: true, force: true });
});

describe("development terminal recovery", () => {
	test("clears durable tabs through the shared mutation coordinator", async () => {
		state.sync.deviceId = "peer-device";
		state.sync.lastWrittenAt = 5;

		await resetTerminalStateDev();

		expect(shutdownIfRunning).toHaveBeenCalledWith({ killSessions: true });
		expect(enqueueAppStateMutation).toHaveBeenCalledTimes(1);
		expect(enqueueAppStateMutation.mock.calls[0]?.[0]).toBe(
			"recovery.dev-reset-terminal-state",
		);
		expect(state.tabsState).toEqual(createDefaultAppState("device").tabsState);
		expect(state.sync.deviceId).toBe("device");
		expect(state.sync.lastWrittenAt).toBeGreaterThan(5);
	});
});
