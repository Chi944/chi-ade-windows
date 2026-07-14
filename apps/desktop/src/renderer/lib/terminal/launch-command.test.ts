import { describe, expect, it, mock } from "bun:test";
import {
	buildTerminalCommand,
	launchCommandInPane,
	writeCommandsInPane,
} from "./launch-command";

describe("launchCommandInPane", () => {
	it("creates a terminal session and submits the command with carriage return", async () => {
		const createOrAttach = mock(async () => ({}));
		const write = mock(async () => ({}));

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "echo hello",
			createOrAttach,
			write,
		});

		expect(createOrAttach).toHaveBeenCalledWith({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo hello\r",
			throwOnError: true,
		});
	});

	it("normalizes a trailing line feed to one carriage return", async () => {
		const createOrAttach = mock(async () => ({}));
		const write = mock(async () => ({}));

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "echo hello\n",
			createOrAttach,
			write,
		});

		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo hello\r",
			throwOnError: true,
		});
	});

	it("does not append a second carriage return", async () => {
		const createOrAttach = mock(async () => ({}));
		const write = mock(async () => ({}));

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "echo hello\r",
			createOrAttach,
			write,
		});

		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo hello\r",
			throwOnError: true,
		});
	});

	it("passes the pane runtime to createOrAttach", async () => {
		const createOrAttach = mock(async () => ({}));
		const write = mock(async () => ({}));

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "codex",
			runtime: "codex",
			createOrAttach,
			write,
		});

		expect(createOrAttach).toHaveBeenCalledWith({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			runtime: "codex",
		});
	});

	it("passes an explicit subscription account to createOrAttach", async () => {
		const createOrAttach = mock(async () => ({}));
		const write = mock(async () => ({}));

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "codex",
			runtime: "codex",
			subscriptionProfileId: "11111111-1111-4111-8111-111111111111",
			createOrAttach,
			write,
		});

		expect(createOrAttach).toHaveBeenCalledWith({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			runtime: "codex",
			subscriptionProfileId: "11111111-1111-4111-8111-111111111111",
		});
	});
});

describe("buildTerminalCommand", () => {
	it("joins commands with shell separators", () => {
		expect(buildTerminalCommand(["echo one", "echo two"])).toBe(
			"echo one && echo two",
		);
	});

	it("returns null for empty commands", () => {
		expect(buildTerminalCommand([])).toBeNull();
		expect(buildTerminalCommand(null)).toBeNull();
		expect(buildTerminalCommand(undefined)).toBeNull();
	});
});

describe("writeCommandsInPane", () => {
	it("writes and submits the joined command", async () => {
		const write = mock(async () => ({}));

		await writeCommandsInPane({
			paneId: "pane-1",
			commands: ["echo one", "echo two"],
			write,
		});

		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo one && echo two\r",
			throwOnError: true,
		});
	});

	it("does not write when commands are empty", async () => {
		const write = mock(async () => ({}));

		await writeCommandsInPane({
			paneId: "pane-1",
			commands: [],
			write,
		});

		expect(write).not.toHaveBeenCalled();
	});
});
