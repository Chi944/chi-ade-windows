import { beforeEach, describe, expect, test } from "bun:test";
import {
	markSyncedPane,
	preparePaneResumeInput,
	resetSyncedPaneRegistryForTests,
	restorePaneResumeMarkerAfterWriteFailure,
} from "./syncedPaneRegistry";

beforeEach(resetSyncedPaneRegistryForTests);

describe("synced pane resume staging", () => {
	test("stages a peer resume command exactly once without Enter", () => {
		markSyncedPane("peer-pane");

		expect(
			preparePaneResumeInput("peer-pane", "claude --resume session-123\r\n"),
		).toBe("claude --resume session-123");
		expect(
			preparePaneResumeInput("peer-pane", "claude --resume session-123"),
		).toBe("claude --resume session-123\r");
	});

	test("executes an ordinary local resume command", () => {
		expect(
			preparePaneResumeInput("local-pane", "claude --resume session-local"),
		).toBe("claude --resume session-local\r");
	});

	test("restores only a consumed peer marker after a terminal write failure", () => {
		markSyncedPane("peer-pane");
		const staged = preparePaneResumeInput(
			"peer-pane",
			"claude --resume session-peer",
		);
		restorePaneResumeMarkerAfterWriteFailure("peer-pane", staged);
		expect(
			preparePaneResumeInput("peer-pane", "claude --resume session-peer"),
		).toBe("claude --resume session-peer");

		const executed = preparePaneResumeInput(
			"local-pane",
			"claude --resume session-local",
		);
		restorePaneResumeMarkerAfterWriteFailure("local-pane", executed);
		expect(
			preparePaneResumeInput("local-pane", "claude --resume session-local"),
		).toBe("claude --resume session-local\r");
	});
});
