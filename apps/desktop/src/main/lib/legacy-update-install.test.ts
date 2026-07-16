import { describe, expect, mock, test } from "bun:test";
import { runLegacyUpdateInstall } from "./legacy-update-install";

describe("runLegacyUpdateInstall", () => {
	test("snapshots before suppressing confirmation and restarting", async () => {
		const order: string[] = [];

		await runLegacyUpdateInstall({
			createSnapshot: async () => {
				order.push("snapshot");
			},
			setSkipQuitConfirmation: () => order.push("skip-confirmation"),
			quitAndInstall: () => order.push("restart"),
		});

		expect(order).toEqual(["snapshot", "skip-confirmation", "restart"]);
	});

	test("does not change quit behavior or restart when snapshotting fails", async () => {
		const setSkipQuitConfirmation = mock(() => {});
		const quitAndInstall = mock(() => {});

		await expect(
			runLegacyUpdateInstall({
				createSnapshot: async () => {
					throw new Error("snapshot unavailable");
				},
				setSkipQuitConfirmation,
				quitAndInstall,
			}),
		).rejects.toThrow("snapshot unavailable");
		expect(setSkipQuitConfirmation).not.toHaveBeenCalled();
		expect(quitAndInstall).not.toHaveBeenCalled();
	});
});
