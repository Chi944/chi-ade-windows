import { describe, expect, test } from "bun:test";
import {
	buildDevelopmentWindowUrl,
	buildProductionWindowOptions,
} from "./window-loader";

describe("window route query propagation", () => {
	test("places startup flags in the development document query before the hash", () => {
		expect(
			buildDevelopmentWindowUrl(5173, {
				adeSafeRecovery: "1",
				space: "a b",
			}),
		).toBe("http://localhost:5173/?adeSafeRecovery=1&space=a+b#/");
	});

	test("passes startup flags to production loadFile without changing the route hash", () => {
		expect(buildProductionWindowOptions({ adeSafeRecovery: "1" })).toEqual({
			hash: "/",
			query: { adeSafeRecovery: "1" },
		});
	});
});
