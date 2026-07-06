import { afterEach, describe, expect, it } from "bun:test";
import { reconcileWithTimeout } from "./reconcile";

/**
 * reconcileWithTimeout runs before the main window is created and awaits a
 * daemon-socket connection. A wedged daemon must never brick boot, so it is
 * bounded by a hard timeout. Inject a fake manager whose reconcileOnStartup
 * never resolves / rejects / resolves and assert the bounded call always
 * returns and logs appropriately. No mock.module here — the logic lives in a
 * dependency-free module precisely so the test needs no global mocks (which
 * would bleed into the other terminal test files in the same process).
 */

const origWarn = console.warn;
let warnings: string[] = [];
function captureWarn() {
	warnings = [];
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	};
}
afterEach(() => {
	console.warn = origWarn;
});

describe("reconcileWithTimeout — bounded so a wedged daemon can't brick boot", () => {
	it("returns after the timeout when reconcileOnStartup never resolves", async () => {
		captureWarn();
		const manager = { reconcileOnStartup: () => new Promise<void>(() => {}) };
		const start = Date.now();
		await reconcileWithTimeout(manager, 30); // must resolve, not hang
		expect(Date.now() - start).toBeLessThan(2000);
		expect(warnings.some((w) => w.includes("timed out"))).toBe(true);
	});

	it("returns promptly and does not warn when reconcile succeeds fast", async () => {
		captureWarn();
		const manager = { reconcileOnStartup: () => Promise.resolve() };
		await reconcileWithTimeout(manager, 5000);
		expect(warnings.some((w) => w.includes("timed out"))).toBe(false);
	});

	it("swallows a reconcile rejection and does not treat it as a timeout", async () => {
		captureWarn();
		const manager = {
			reconcileOnStartup: () => Promise.reject(new Error("daemon boom")),
		};
		await reconcileWithTimeout(manager, 5000); // resolves, does not throw
		expect(warnings.some((w) => w.includes("Failed to reconcile"))).toBe(true);
		expect(warnings.some((w) => w.includes("timed out"))).toBe(false);
	});
});
