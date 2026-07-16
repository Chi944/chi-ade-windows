import { describe, expect, test } from "bun:test";
import {
	buildDevelopmentWindowUrl,
	buildProductionWindowOptions,
	redactWindowUrlForLogs,
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

	test("removes the entire document query before logging a window URL", () => {
		expect(
			redactWindowUrlForLogs(
				"file:///renderer/index.html?adePackagedSmoke=1&adePackagedSmokeToken=secret#/settings",
			),
		).toBe("file:///renderer/index.html#/");
		expect(
			redactWindowUrlForLogs(
				"http://localhost:5173/?adePackagedSmokeToken=secret#/",
			),
		).toBe("http://localhost:5173/#/");
		expect(redactWindowUrlForLogs("not a url?token=secret")).toBe(
			"[redacted-window-url]",
		);
	});
});
