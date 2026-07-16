import { describe, expect, test } from "bun:test";
import {
	buildSafeRecoveryLocation,
	getInitialSafeRecoveryRoute,
} from "./startup-recovery";

describe("safe recovery startup route", () => {
	test("routes an exact main-process safe-mode flag to Health before mount", () => {
		expect(getInitialSafeRecoveryRoute("?adeSafeRecovery=1")).toBe(
			"/settings/health",
		);
		expect(buildSafeRecoveryLocation("/index.html", "?adeSafeRecovery=1")).toBe(
			"/index.html?adeSafeRecovery=1#/settings/health",
		);
	});

	test("does not change normal or malformed startup URLs", () => {
		expect(getInitialSafeRecoveryRoute("")).toBeNull();
		expect(getInitialSafeRecoveryRoute("?adeSafeRecovery=true")).toBeNull();
		expect(getInitialSafeRecoveryRoute("?adeSafeRecovery=0")).toBeNull();
	});
});
