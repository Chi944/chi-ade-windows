import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("legacy update installation", () => {
	test("awaits a recovery snapshot before restarting into the installer", async () => {
		const source = await readFile(
			new URL("./auto-updater.ts", import.meta.url),
			"utf8",
		);
		const install = source.slice(
			source.indexOf("export async function installUpdate"),
			source.indexOf("export function dismissUpdate"),
		);
		const snapshot = install.indexOf("await runLegacyUpdateInstall(");
		const skipConfirmation = install.indexOf("setSkipQuitConfirmation,");
		const restart = install.indexOf("autoUpdater.quitAndInstall(false, true)");

		expect(snapshot).toBeGreaterThan(-1);
		expect(snapshot).toBeLessThan(skipConfirmation);
		expect(skipConfirmation).toBeLessThan(restart);
	});

	test("redacts legacy snapshot failures and exposes only a fixed user status", async () => {
		const source = await readFile(
			new URL("./auto-updater.ts", import.meta.url),
			"utf8",
		);
		const install = source.slice(
			source.indexOf("export async function installUpdate"),
			source.indexOf("export function dismissUpdate"),
		);
		const failure = install.slice(install.indexOf("} catch (error)"));

		expect(install).toContain('createRecoverySnapshot("update")');
		expect(failure).toMatch(
			/logUpdateFailure\(error,\s*\{\s*phase: "legacy-install-snapshot"\s*\}\)/,
		);
		expect(source).toMatch(
			/const LEGACY_INSTALL_SNAPSHOT_ERROR\s*=\s*"ADE could not prepare the update safely\. Restart ADE and try again\."/,
		);
		expect(failure).toContain("LEGACY_INSTALL_SNAPSHOT_ERROR");
		expect(failure).not.toContain("error.message");
		expect(failure).not.toContain("String(error)");
	});
});
