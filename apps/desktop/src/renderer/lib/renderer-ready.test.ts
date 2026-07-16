import { expect, test } from "bun:test";
import { signalRendererCommit, waitForRendererCommit } from "./renderer-ready";

test("resolves only after the one-shot renderer commit signal", async () => {
	await expect(waitForRendererCommit(1)).rejects.toThrow(
		"renderer commit signal timed out",
	);

	const waiting = waitForRendererCommit(100);
	signalRendererCommit();
	await expect(waiting).resolves.toBeUndefined();
	await expect(waitForRendererCommit(1)).resolves.toBeUndefined();
});
