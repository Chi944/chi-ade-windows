import { describe, expect, it } from "bun:test";
import {
	countProjectTerminalThreads,
	getProjectOwnerLabel,
	getProjectPathLabel,
} from "./project-hover-metadata";

describe("project hover metadata", () => {
	it("counts every terminal pane in the project's workspaces", () => {
		expect(
			countProjectTerminalThreads({
				workspaces: [{ id: "workspace-a" }, { id: "workspace-b" }],
				tabs: [
					{ id: "terminal-a", workspaceId: "workspace-a" },
					{ id: "browser-a", workspaceId: "workspace-a" },
					{ id: "terminal-other", workspaceId: "workspace-other" },
				],
				panes: {
					terminal: { tabId: "terminal-a", type: "terminal" },
					terminalSplit: { tabId: "terminal-a", type: "terminal" },
					browser: { tabId: "browser-a", type: "webview" },
					other: { tabId: "terminal-other", type: "terminal" },
				},
			}),
		).toBe(2);
	});

	it("uses the repository owner before the local profile", () => {
		expect(
			getProjectOwnerLabel({
				githubOwner: "octocat",
				profileName: "Local User",
			}),
		).toBe("octocat");
		expect(
			getProjectOwnerLabel({
				githubOwner: null,
				profileName: "Local User",
			}),
		).toBe("Local User");
	});

	it("does not invent a shared root for a category", () => {
		expect(getProjectPathLabel("C:\\code\\project")).toBe("C:\\code\\project");
		expect(getProjectPathLabel("")).toBe(
			"Agent-owned folders (no shared root)",
		);
	});
});
